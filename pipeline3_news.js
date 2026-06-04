require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const Anthropic = require('@anthropic-ai/sdk');
const { isProcessed, markProcessed, isWithinHours } = require('./db');
const { sendAlert } = require('./email');

const FEEDS = [
  {
    name: 'Google News — Jensen Huang',
    url: 'https://news.google.com/rss/search?q=%22Jensen+Huang%22+when:1d&ceid=US:en&hl=en-US&gl=US',
  },
  {
    name: 'Google News — Nvidia (Bloomberg)',
    url: 'https://news.google.com/rss/search?q=Nvidia+when:1d+allinurl:bloomberg.com&ceid=US:en&hl=en-US&gl=US',
  },
  {
    name: 'Google News — Nvidia (Reuters)',
    url: 'https://news.google.com/rss/search?q=Nvidia+when:1d+allinurl:reuters.com&ceid=US:en&hl=en-US&gl=US',
  },
];

// Pre-filter: must have a strong Jensen Huang attribution signal
const JENSEN_QUOTE_PATTERNS = [
  'jensen huang', 'huang said', 'huang told', 'huang called',
  'huang warned', 'huang noted', '"jensen', 'nvidia ceo said',
  'nvidia ceo told', 'according to huang', 'ceo jensen',
  'huang described', 'huang announced', 'huang stated',
];

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function hasJensenSignal(title, description) {
  const combined = `${title} ${description}`.toLowerCase();
  return JENSEN_QUOTE_PATTERNS.some(p => combined.includes(p));
}

async function fetchArticleText(url) {
  try {
    const { data } = await axios.get(url, {
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      maxRedirects: 5,
    });
    const $ = cheerio.load(data);
    $('script, style, nav, footer, header, .advertisement, aside, .sidebar, .related, .cookie').remove();
    const selectors = [
      'article', '[role="main"]', 'main', '.article-body', '.story-body',
      '.post-content', '#article-content', '.entry-content', '.article__body',
    ];
    for (const sel of selectors) {
      const text = $(sel).text().replace(/\s+/g, ' ').trim();
      if (text.length > 400) return text;
    }
    return $('body').text().replace(/\s+/g, ' ').trim().slice(0, 8000);
  } catch {
    return null;
  }
}

const EXTRACTION_PROMPT = (text, title, feedName) => `You are analyzing a news article to find DIRECT, VERBATIM quotes from Jensen Huang (CEO of Nvidia) for stock trading purposes.

Feed: ${feedName}
Title: ${title}

ARTICLE TEXT:
${text.slice(0, 10000)}

CRITICAL INSTRUCTION: Only extract content where Jensen Huang is DIRECTLY quoted verbatim (his exact words inside quotation marks, or clearly attributed to him as a direct quote). DO NOT include paraphrased or indirect reporting of his views.

Extract ONLY from direct verbatim quotes:

1. Company mentions Jensen Huang directly mentions in his own words — but only if that company is publicly traded on a stock exchange where a retail investor could buy stock (e.g. NYSE, NASDAQ, LSE, TSX, ASX). Exclude private companies, government entities, NGOs, or any organisation not publicly listed:
{
  "company": "full official company name",
  "quote": "EXACT VERBATIM words Jensen Huang said, as quoted in the article",
  "context": "2-3 sentence summary: when/where he said it, why this company, what it means",
  "sentiment": "positive|negative|neutral",
  "signal": "BUY|SELL|WATCH",
  "type": "company"
}
Signal: BUY = endorsed/praising/partnering; SELL = threatening/dropping; WATCH = neutral.

2. Market signals in Jensen's direct quotes — detect: stock/stocks/shares, buy/sell (financial), invest/investment/investors, market/markets, Wall Street, partnership/collaboration, acquisition/acquire/merger, chip/chips/GPU/AI/datacenter, supply chain/manufacturing, revenue/earnings/guidance/forecast, "working with"/"partnered with"/"announced", "next generation"/"new product"/"launching"
{
  "keyword": "triggering keyword",
  "quote": "EXACT VERBATIM passage from Jensen's direct quote",
  "context": "market significance in 1-2 sentences",
  "signal": "BULLISH|BEARISH|NEUTRAL",
  "type": "market_signal"
}

3. Summary: One paragraph on what Jensen Huang specifically said and the market implications. If no direct verbatim quotes exist, state "No direct Jensen Huang verbatim quotes found in this article."

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

async function extractJensenQuotes(text, title, feedName) {
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: EXTRACTION_PROMPT(text, title, feedName) }],
    });
    return parseClaudeJSON(response.content[0].text);
  } catch (err) {
    console.error('[Pipeline 3] Claude API error:', err.message);
    return { companyMentions: [], marketSignals: [], summary: '' };
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
    console.error(`[Pipeline 3] Failed to fetch ${feed.name}: ${err.message}`);
    return;
  }

  const $ = cheerio.load(data, { xmlMode: true });
  const items = [];

  $('item').each((_, el) => {
    const $el = $(el);
    const title       = $el.find('title').first().text().trim();
    const link        = $el.find('link').first().text().trim() || $el.find('link').first().attr('href') || '';
    const pubDate     = $el.find('pubDate').first().text().trim();
    const description = $el.find('description').first().text().replace(/<[^>]+>/g, '').trim();
    const guid        = $el.find('guid').first().text().trim() || link || title;
    const source      = $el.find('source').first().text().trim();
    if (title) items.push({ title, link, pubDate, description, guid, source });
  });

  console.log(`[Pipeline 3] ${feed.name}: ${items.length} items`);

  for (const item of items) {
    if (!isWithinHours(item.pubDate, 6)) continue;
    if (isProcessed(item.guid)) continue;

    // Pre-filter using patterns before making any network requests
    if (!hasJensenSignal(item.title, item.description)) {
      console.log(`[Pipeline 3] No Jensen signal, skipping: ${item.title}`);
      markProcessed(item.guid);
      continue;
    }

    console.log(`[Pipeline 3] Jensen signal found → ${item.title}`);

    let articleText = null;
    if (item.link) {
      articleText = await fetchArticleText(item.link);
      await new Promise(r => setTimeout(r, 1500));
    }

    const textToAnalyze = articleText || item.description || item.title;
    const analysisInput = `Title: ${item.title}
Source: ${item.source || feed.name}
Date: ${item.pubDate}
URL: ${item.link}

ARTICLE:
${textToAnalyze}`;

    const { companyMentions, marketSignals, summary } = await extractJensenQuotes(
      analysisInput, item.title, feed.name
    );

    const noQuotesFound = summary && summary.toLowerCase().includes('no direct jensen huang verbatim quotes');
    const hasContent    = companyMentions.length > 0 || marketSignals.length > 0;

    if (hasContent && !noQuotesFound) {
      try {
        await sendAlert({
          pipeline: `Pipeline 3 — ${feed.name}`,
          timestamp: new Date().toISOString(),
          title: item.title,
          sourceUrl: item.link || feed.url,
          fullText: analysisInput,
          summary: summary || '',
          companyMentions,
          marketSignals,
        });
      } catch (err) {
        console.error(`[P3] sendAlert FAILED: ${err.message}`);
        console.error(err.stack);
      }
    } else {
      console.log(`[Pipeline 3] No verbatim Jensen quotes confirmed in: ${item.title}`);
    }

    markProcessed(item.guid);
    await new Promise(r => setTimeout(r, 2000));
  }
}

async function run() {
  console.log(`[Pipeline 3] ${new Date().toISOString()} — Checking Google News feeds...`);
  for (const feed of FEEDS) {
    await checkFeed(feed);
    await new Promise(r => setTimeout(r, 3000));
  }
}

module.exports = { run };
