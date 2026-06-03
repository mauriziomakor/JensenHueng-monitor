require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const Anthropic = require('@anthropic-ai/sdk');
const { isProcessed, markProcessed, isWithinDays } = require('./db');
const { sendAlert } = require('./email');

const IR_PAGE_URL = 'https://investor.nvidia.com/news/press-releases/default.aspx';
const IR_RSS_URL  = 'https://investor.nvidia.com/news/press-releases/rss';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const EXTRACTION_PROMPT = (text, source) => `You are analyzing an Nvidia investor relations press release or earnings call document for stock trading. Completeness and accuracy are critical — extract everything market-relevant.

Source: ${source}

FULL TEXT:
${text.slice(0, 12000)}

Extract ALL of the following and return as valid JSON only — no markdown, no explanation, no code blocks:

1. Company mentions: every company referenced (partners, customers, competitors, suppliers, joint ventures, acquisition targets, etc.)
{
  "company": "full official company name",
  "quote": "exact verbatim text from source",
  "context": "2-3 sentence summary of the relationship and why they were mentioned",
  "sentiment": "positive|negative|neutral",
  "signal": "BUY|SELL|WATCH",
  "type": "company"
}
Signal: BUY = partnership/endorsement/acquisition/investment; SELL = dropped/competitive threat; WATCH = neutral/informational.

2. Market signals — detect: stock/stocks/shares, buy/sell (financial), invest/investment/investors, market/markets, Wall Street, partnership/collaboration, acquisition/acquire/merger, chip/chips/GPU/AI/datacenter, supply chain/manufacturing, revenue/earnings/guidance/forecast, "we are working with"/"we partnered with"/"we announced", "next generation"/"new product"/"launching", any specific dollar figures or percentages
{
  "keyword": "triggering keyword or phrase",
  "quote": "exact verbatim passage — include surrounding context for clarity",
  "context": "why this is market-significant, including any numbers/figures mentioned",
  "signal": "BULLISH|BEARISH|NEUTRAL",
  "type": "market_signal"
}

3. A comprehensive one-paragraph summary covering: what was announced, all named companies and their roles, key financial figures (revenue, earnings, guidance), new products or partnerships, and the overall market outlook.

Return ONLY:
{
  "companyMentions": [...],
  "marketSignals": [...],
  "summary": "..."
}`;

function parseClaudeJSON(text) {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { companyMentions: [], marketSignals: [], summary: '' };
    return JSON.parse(match[0]);
  } catch {
    return { companyMentions: [], marketSignals: [], summary: '' };
  }
}

async function extractMentions(text, source) {
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: EXTRACTION_PROMPT(text, source) }],
    });
    return parseClaudeJSON(response.content[0].text);
  } catch (err) {
    console.error('[Pipeline 2] Claude API error:', err.message);
    return { companyMentions: [], marketSignals: [], summary: '' };
  }
}

async function fetchFullPressRelease(url) {
  try {
    const { data } = await axios.get(url, {
      timeout: 25000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    const $ = cheerio.load(data);
    $('script, style, nav, footer, header, .cookie-banner, .advertisement, aside, .social-share').remove();
    const selectors = [
      '.press-release-body', '.news-body', 'article', '[role="main"]',
      'main', '.content-body', '#content', '.article-content', '.post-content',
    ];
    for (const sel of selectors) {
      const text = $(sel).text().replace(/\s+/g, ' ').trim();
      if (text.length > 400) return text;
    }
    return $('body').text().replace(/\s+/g, ' ').trim();
  } catch {
    return null;
  }
}

async function fetchViaRSS() {
  try {
    const { data } = await axios.get(IR_RSS_URL, {
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JensenMonitor/1.0)' },
    });
    const $ = cheerio.load(data, { xmlMode: true });
    const items = [];
    $('item').each((_, el) => {
      const $el = $(el);
      const title       = $el.find('title').first().text().trim();
      const link        = $el.find('link').first().text().trim() || $el.find('link').first().attr('href') || '';
      const pubDate     = $el.find('pubDate').first().text().trim();
      const description = $el.find('description').first().text().trim();
      const guid        = $el.find('guid').first().text().trim() || link;
      if (title) items.push({ title, link, pubDate, description, guid });
    });
    return items;
  } catch (err) {
    console.error('[Pipeline 2] RSS fetch error:', err.message);
    return [];
  }
}

async function fetchViaDirectScrape() {
  try {
    const { data } = await axios.get(IR_PAGE_URL, {
      timeout: 25000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    const $ = cheerio.load(data);
    const items = [];
    $('a').each((_, el) => {
      const href  = $(el).attr('href') || '';
      const title = $(el).text().trim();
      if (!title || title.length < 10) return;
      if (!href.match(/press-release|news|announcement/i)) return;
      const link = href.startsWith('http') ? href : `https://investor.nvidia.com${href}`;
      items.push({ title, link, pubDate: new Date().toISOString(), description: '', guid: link });
    });
    return items;
  } catch (err) {
    console.error('[Pipeline 2] Direct scrape error:', err.message);
    return [];
  }
}

async function run() {
  console.log(`[Pipeline 2] ${new Date().toISOString()} — Running daily IR/earnings check...`);

  let items = await fetchViaRSS();
  if (items.length === 0) {
    console.log('[Pipeline 2] RSS empty, trying direct scrape...');
    items = await fetchViaDirectScrape();
  }

  console.log(`[Pipeline 2] Found ${items.length} press releases`);

  for (const item of items) {
    if (!isWithinDays(item.pubDate, 7)) {
      console.log(`[Pipeline 2] Old item, skipping: ${item.title}`);
      continue;
    }
    if (isProcessed(item.guid)) {
      console.log(`[Pipeline 2] Already processed: ${item.title}`);
      continue;
    }

    console.log(`[Pipeline 2] Processing: ${item.title}`);

    let fullText = null;
    if (item.link) fullText = await fetchFullPressRelease(item.link);
    fullText = fullText || item.description || item.title;

    const analysisInput = `Title: ${item.title}
Date: ${item.pubDate}
Source: Nvidia Investor Relations
URL: ${item.link}

FULL TEXT:
${fullText}`;

    const { companyMentions, marketSignals, summary } = await extractMentions(analysisInput, item.link || IR_PAGE_URL);

    if (companyMentions.length > 0 || marketSignals.length > 0) {
      await sendAlert({
        pipeline: 'Pipeline 2 — Nvidia Investor Relations',
        timestamp: new Date().toISOString(),
        title: item.title,
        sourceUrl: item.link || IR_PAGE_URL,
        fullText: analysisInput,
        summary: summary || item.description || '',
        companyMentions,
        marketSignals,
      });
    } else {
      console.log(`[Pipeline 2] No actionable signals in: ${item.title}`);
    }

    markProcessed(item.guid);
    await new Promise(r => setTimeout(r, 3000));
  }
}

module.exports = { run };
