require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const Anthropic = require('@anthropic-ai/sdk');
const { isProcessed, markProcessed, isWithinHours } = require('./db');
const { sendAlert } = require('./email');

const FEEDS = [
  {
    name: 'Nvidia Newsroom',
    url: 'https://nvidianews.nvidia.com/rss/news.rss',
  },
  {
    name: 'Nvidia Investor Relations',
    url: 'https://investor.nvidia.com/news/press-releases/rss',
  },
];

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const EXTRACTION_PROMPT = (text, source) => `You are analyzing an official Nvidia press release or newsroom announcement for stock trading. Accuracy and completeness are critical — only report what is explicitly stated.

Source: ${source}

TEXT TO ANALYZE:
${text}

Extract ALL of the following and return as valid JSON only — no markdown, no explanation, no code blocks:

1. Company mentions: every company mentioned alongside Nvidia (partners, customers, competitors, acquisition targets, suppliers, etc.) — but only if it is publicly traded on a stock exchange where a retail investor could buy stock (e.g. NYSE, NASDAQ, LSE, TSX, ASX). Exclude private companies, government entities, NGOs, or any organisation not publicly listed.
For each company:
{
  "company": "full official company name",
  "quote": "exact verbatim text from the source — DO NOT paraphrase",
  "context": "2-3 sentence summary of why this company was mentioned and the relationship",
  "sentiment": "positive|negative|neutral",
  "signal": "BUY|SELL|WATCH",
  "type": "company"
}
Signal rules: BUY = praised/endorsed/partnered with/acquiring; SELL = dropped/threatened/competing against; WATCH = neutral/informational mention.

2. Market signals — detect ANY occurrence of: stock/stocks/shares, buy/sell (financial context), invest/investment/investors, market/markets, Wall Street, partnership/partnerships/collaboration, acquisition/acquire/merger, chip/chips/GPU/AI/datacenter, supply chain/manufacturing, revenue/earnings/guidance/forecast, "we are working with"/"we partnered with"/"we announced", "next generation"/"new product"/"launching", any company name alongside Nvidia.
For each signal:
{
  "keyword": "the triggering keyword or phrase",
  "quote": "exact verbatim passage containing the keyword",
  "context": "1-2 sentence explanation of market significance",
  "signal": "BULLISH|BEARISH|NEUTRAL",
  "type": "market_signal"
}

3. A one-paragraph summary covering what was announced, key partners or companies mentioned, financial figures, and overall market significance.

Return ONLY this JSON:
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
    console.error('[Pipeline 0] Claude API error:', err.message);
    return { companyMentions: [], marketSignals: [], summary: '' };
  }
}

async function fetchFullText(url) {
  try {
    const { data } = await axios.get(url, {
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JensenMonitor/1.0; +https://github.com/mauriziomakor/JensenHueng-monitor)' },
    });
    const $ = cheerio.load(data);
    $('script, style, nav, footer, header, .cookie-banner, .advertisement, aside').remove();
    const selectors = ['article', '.press-release-body', '.news-body', '.content-body', 'main', '.article-content'];
    for (const sel of selectors) {
      const content = $(sel).text().replace(/\s+/g, ' ').trim();
      if (content.length > 300) return content;
    }
    return $('body').text().replace(/\s+/g, ' ').trim();
  } catch {
    return null;
  }
}

async function checkFeed(feed) {
  let data;
  try {
    ({ data } = await axios.get(feed.url, {
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JensenMonitor/1.0)' },
    }));
  } catch (err) {
    console.error(`[Pipeline 0] Failed to fetch ${feed.name}: ${err.message}`);
    return;
  }

  const $ = cheerio.load(data, { xmlMode: true });
  const items = [];

  $('item').each((_, el) => {
    const $el = $(el);
    const title       = $el.find('title').first().text().trim();
    const link        = $el.find('link').first().text().trim() || $el.find('link').first().attr('href') || '';
    const pubDate     = $el.find('pubDate').first().text().trim();
    const description = $el.find('description').first().text().trim();
    const guid        = $el.find('guid').first().text().trim() || link || title;
    if (title) items.push({ title, link, pubDate, description, guid });
  });

  console.log(`[Pipeline 0] ${feed.name}: ${items.length} items`);

  for (const item of items) {
    if (!isWithinHours(item.pubDate, 6)) {
      console.log(`[Pipeline 0] Old item, skipping: ${item.title}`);
      continue;
    }
    if (isProcessed(item.guid)) {
      console.log(`[Pipeline 0] Already processed: ${item.title}`);
      continue;
    }

    console.log(`[Pipeline 0] NEW → ${item.title}`);

    let fullText = item.link ? await fetchFullText(item.link) : null;
    fullText = fullText || item.description || item.title;

    const analysisInput = `Title: ${item.title}\nDate: ${item.pubDate}\nFeed: ${feed.name}\n\n${fullText}`;
    const { companyMentions, marketSignals, summary } = await extractMentions(analysisInput, item.link || feed.url);

    if (companyMentions.length > 0 || marketSignals.length > 0) {
      try {
        await sendAlert({
          pipeline: `Pipeline 0 — ${feed.name}`,
          timestamp: new Date().toISOString(),
          title: item.title,
          sourceUrl: item.link || feed.url,
          fullText: analysisInput,
          summary: summary || item.description || item.title,
          companyMentions,
          marketSignals,
        });
      } catch (err) {
        console.error(`[P0] sendAlert FAILED: ${err.message}`);
        console.error(err.stack);
      }
    } else {
      console.log(`[Pipeline 0] No actionable signals in: ${item.title}`);
    }

    markProcessed(item.guid);
  }
}

async function run() {
  console.log(`[Pipeline 0] ${new Date().toISOString()} — Checking Nvidia RSS feeds...`);
  for (const feed of FEEDS) {
    await checkFeed(feed);
  }
}

module.exports = { run };
