require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const Anthropic = require('@anthropic-ai/sdk');
const { isProcessed, markProcessed, isWithinHours } = require('./db');
const { sendAlert } = require('./email');

const IR_PAGE_URL = 'https://investor.nvidia.com/news/press-releases/default.aspx';
const IR_RSS_URL  = 'https://investor.nvidia.com/news/press-releases/rss';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const EXTRACTION_PROMPT = (text, source) => `You are analyzing an Nvidia investor relations press release or earnings call document for stock trading. Completeness and accuracy are critical — extract everything market-relevant.

Source: ${source}

FULL TEXT:
${text.slice(0, 12000)}

Extract ALL of the following and return as valid JSON only — no markdown, no explanation, no code blocks:

1. Company mentions: every company referenced (partners, customers, competitors, suppliers, joint ventures, acquisition targets, etc.) — but only if it is publicly traded on a stock exchange where a retail investor could buy stock (e.g. NYSE, NASDAQ, LSE, TSX, ASX). Exclude private companies, government entities, NGOs, or any organisation not publicly listed.
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

function extractDateFromPage($) {
  // 1. Meta tags (most reliable)
  const metaDate = $('meta[property="article:published_time"]').attr('content')
    || $('meta[name="date"]').attr('content')
    || $('meta[name="pubdate"]').attr('content')
    || $('meta[name="DC.date"]').attr('content');
  if (metaDate && !isNaN(new Date(metaDate))) return new Date(metaDate).toISOString();

  // 2. <time datetime="...">
  const timeAttr = $('time[datetime]').first().attr('datetime');
  if (timeAttr && !isNaN(new Date(timeAttr))) return new Date(timeAttr).toISOString();

  // 3. Common date class/element patterns on IR pages
  const dateSelectors = [
    '.press-release-date', '.release-date', '.pub-date', '.news-date',
    '.article-date', '.date-published', '.post-date', '.entry-date',
    '[class*="ReleaseDate"]', '[class*="releaseDate"]', '[class*="PressDate"]',
  ];
  for (const sel of dateSelectors) {
    const text = $(sel).first().text().trim();
    const parsed = new Date(text);
    if (text && !isNaN(parsed)) return parsed.toISOString();
  }

  // 4. <time> without datetime attr
  const timeText = $('time').first().text().trim();
  if (timeText && !isNaN(new Date(timeText))) return new Date(timeText).toISOString();

  return null;
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

    const pubDate = extractDateFromPage($);

    $('script, style, nav, footer, header, .cookie-banner, .advertisement, aside, .social-share').remove();
    const selectors = [
      '.press-release-body', '.news-body', 'article', '[role="main"]',
      'main', '.content-body', '#content', '.article-content', '.post-content',
    ];
    let text = null;
    for (const sel of selectors) {
      const t = $(sel).text().replace(/\s+/g, ' ').trim();
      if (t.length > 400) { text = t; break; }
    }
    if (!text) text = $('body').text().replace(/\s+/g, ' ').trim();

    return { text, pubDate };
  } catch {
    return { text: null, pubDate: null };
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

      // Try to find a date in the surrounding element or its siblings/parent
      const $parent = $(el).closest('li, tr, div, article');
      let pubDate = null;
      const dateText = $parent.find('time, .date, [class*="date"], [class*="Date"]').first().text().trim()
        || $parent.find('time').attr('datetime');
      if (dateText && !isNaN(new Date(dateText))) {
        pubDate = new Date(dateText).toISOString();
      }

      items.push({ title, link, pubDate, description: '', guid: link });
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
    if (item.pubDate && !isWithinHours(item.pubDate, 6)) {
      console.log(`[Pipeline 2] Old item, skipping: ${item.title}`);
      continue;
    }
    if (isProcessed(item.guid)) {
      console.log(`[Pipeline 2] Already processed: ${item.title}`);
      continue;
    }

    console.log(`[Pipeline 2] Processing: ${item.title}`);

    let fullText = null;
    let articlePubDate = null;
    if (item.link) {
      const result = await fetchFullPressRelease(item.link);
      fullText = result.text;
      articlePubDate = result.pubDate;
    }
    fullText = fullText || item.description || item.title;

    // Prefer date extracted from article HTML, then RSS pubDate
    const pubDate = articlePubDate || item.pubDate || null;
    console.log(`[Pipeline 2] Publication date: ${pubDate || 'unknown'}`);

    const analysisInput = `Title: ${item.title}
Date: ${pubDate || 'unknown'}
Source: Nvidia Investor Relations
URL: ${item.link}

FULL TEXT:
${fullText}`;

    const { companyMentions, marketSignals, summary } = await extractMentions(analysisInput, item.link || IR_PAGE_URL);

    if (companyMentions.length > 0 || marketSignals.length > 0) {
      try {
        await sendAlert({
          pipeline: 'Pipeline 2 — Nvidia Investor Relations',
          timestamp: pubDate || new Date().toISOString(),
          title: item.title,
          sourceUrl: item.link || IR_PAGE_URL,
          fullText: analysisInput,
          summary: summary || item.description || '',
          companyMentions,
          marketSignals,
        });
      } catch (err) {
        console.error(`[P2] sendAlert FAILED: ${err.message}`);
        console.error(err.stack);
      }
    } else {
      console.log(`[Pipeline 2] No actionable signals in: ${item.title}`);
    }

    markProcessed(item.guid);
    await new Promise(r => setTimeout(r, 3000));
  }
}

module.exports = { run };
