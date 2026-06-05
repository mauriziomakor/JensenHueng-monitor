require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const Anthropic = require('@anthropic-ai/sdk');
const { isProcessed, markProcessed, isWithinHours } = require('./db');
const { sendAlert } = require('./email');

let YoutubeTranscript;
try {
  YoutubeTranscript = require('youtube-transcript').YoutubeTranscript;
} catch {
  try {
    YoutubeTranscript = require('youtube-transcript');
  } catch {
    YoutubeTranscript = null;
  }
}

const CHANNELS = [
  {
    name: 'Nvidia Official',
    feedUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCHuiy8bXnmK5nisYHUd1J5g',
    filterByTitle: false,
  },
  {
    name: 'Bloomberg Technology',
    feedUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCrM7B7SL_g1edFOnmj-SDKg',
    filterByTitle: true,
  },
  {
    name: 'CNBC Television',
    feedUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCvJJ_dzjViJCoLf5uKUTwoA',
    filterByTitle: true,
  },
];

const SHORTS_MARKERS = ['#shorts', '#short', ' short ', '/shorts/'];

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function isShort(title, url) {
  const s = (title + ' ' + (url || '')).toLowerCase();
  return SHORTS_MARKERS.some(m => s.includes(m));
}

function isTitleRelevant(title) {
  const lower = title.toLowerCase();
  return lower.includes('jensen') || lower.includes('nvidia');
}

async function getTranscript(videoId) {
  if (!YoutubeTranscript) return null;
  try {
    let segments;
    if (typeof YoutubeTranscript.fetchTranscript === 'function') {
      segments = await YoutubeTranscript.fetchTranscript(videoId);
    } else if (typeof YoutubeTranscript === 'function') {
      segments = await YoutubeTranscript(videoId);
    } else {
      return null;
    }
    if (!Array.isArray(segments) || segments.length === 0) return null;
    return segments.map(s => s.text || s).join(' ').replace(/\s+/g, ' ').trim();
  } catch {
    return null;
  }
}

const EXTRACTION_PROMPT = (transcript, videoTitle, channelName) => `You are analyzing a YouTube video transcript for stock trading purposes. The video may feature Jensen Huang (CEO of Nvidia). Accuracy is critical.

Channel: ${channelName}
Video Title: ${videoTitle}

TRANSCRIPT:
${transcript.slice(0, 10000)}

Extract ALL of the following and return as valid JSON only — no markdown, no explanation, no code blocks:

1. Company mentions: every company Jensen Huang mentions or discusses — but only if it is publicly traded on a stock exchange where a retail investor could buy stock (e.g. NYSE, NASDAQ, LSE, TSX, ASX). Exclude private companies, government entities, NGOs, or any organisation not publicly listed.
{
  "company": "full official company name",
  "quote": "exact verbatim words Jensen said — DO NOT paraphrase, must be his exact words",
  "context": "2-3 sentence summary of why he mentioned this company and what he said",
  "sentiment": "positive|negative|neutral",
  "signal": "BUY|SELL|WATCH",
  "type": "company"
}
Signal: BUY = praised/endorsed/partnering/working with; SELL = threatened/dropping/criticizing; WATCH = neutral mention.

2. Market signals — detect: stock/stocks/shares, buy/sell (financial), invest/investment/investors, market/markets, Wall Street, partnership/collaboration, acquisition/acquire/merger, chip/chips/GPU/AI/datacenter, supply chain/manufacturing, revenue/earnings/guidance/forecast, "working with"/"partnered with"/"announced", "next generation"/"new product"/"launching"
{
  "keyword": "triggering keyword",
  "quote": "exact verbatim passage from transcript",
  "context": "market significance in 1-2 sentences",
  "signal": "BULLISH|BEARISH|NEUTRAL",
  "type": "market_signal"
}

3. Policy signals — detect any government policy, regulatory action, executive order, law, or government announcement that could impact a sector or industry. Focus on: export controls / chip bans / semiconductor tariffs, AI regulation, energy policy (data center power), trade deals or sanctions affecting tech supply chains, healthcare/biotech policy, or any named government action affecting a specific industry.
{
  "policy_topic": "concise label (e.g. 'Chip Export Controls', 'AI Regulation', 'Semiconductor Tariffs')",
  "sector": "the sector most impacted (e.g. 'Technology / Semiconductors', 'AI / Data Centers', 'Energy')",
  "signal": "BULLISH|BEARISH",
  "quote": "exact verbatim passage from the text",
  "context": "2-3 sentences: what the policy is, which sector it affects, why bullish or bearish",
  "companies": [{"name": "full official company name", "ticker": "EXCHANGE:TICKER"}],
  "type": "policy_signal"
}
Only include companies publicly traded on NYSE, NASDAQ, LSE, TSX, ASX, or similar retail-accessible exchange.
BULLISH = policy favours the sector; BEARISH = policy harms the sector.

4. One-paragraph summary of the video's key topics, statements by Jensen, and overall market significance.

Return ONLY:
{
  "companyMentions": [...],
  "marketSignals": [...],
  "policySignals": [...],
  "summary": "..."
}`;

function parseClaudeJSON(text) {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { companyMentions: [], marketSignals: [], policySignals: [], summary: '' };
    const parsed = JSON.parse(match[0]);
    if (!parsed.policySignals) parsed.policySignals = [];
    return parsed;
  } catch {
    return { companyMentions: [], marketSignals: [], policySignals: [], summary: '' };
  }
}

async function extractMentions(transcript, videoTitle, channelName) {
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: EXTRACTION_PROMPT(transcript, videoTitle, channelName) }],
    });
    return parseClaudeJSON(response.content[0].text);
  } catch (err) {
    console.error('[Pipeline 1] Claude API error:', err.message);
    return { companyMentions: [], marketSignals: [], summary: '' };
  }
}

async function checkChannel(channel) {
  let data;
  try {
    ({ data } = await axios.get(channel.feedUrl, {
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JensenMonitor/1.0)' },
    }));
  } catch (err) {
    console.error(`[Pipeline 1] Failed to fetch ${channel.name}: ${err.message}`);
    return;
  }

  const $ = cheerio.load(data, { xmlMode: true });
  const entries = [];

  $('entry').each((_, el) => {
    const $el = $(el);
    const title     = $el.find('title').first().text().trim();
    const videoId   = $el.find('yt\\:videoId').first().text().trim()
                   || $el.find('videoId').first().text().trim()
                   || '';
    const published = $el.find('published').first().text().trim();
    const link      = $el.find('link').first().attr('href')
                   || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : '');
    const summary   = $el.find('media\\:description').first().text().trim()
                   || $el.find('summary').first().text().trim()
                   || '';
    if (title && videoId) entries.push({ title, videoId, published, link, summary });
  });

  console.log(`[Pipeline 1] ${channel.name}: ${entries.length} entries`);

  for (const entry of entries) {
    if (!isWithinHours(entry.published, 6)) {
      console.log(`[Pipeline 1] Old video, skipping: ${entry.title}`);
      continue;
    }
    if (isProcessed(entry.videoId)) continue;

    if (isShort(entry.title, entry.link)) {
      console.log(`[Pipeline 1] YouTube Short, skipping: ${entry.title}`);
      markProcessed(entry.videoId);
      continue;
    }

    if (channel.filterByTitle && !isTitleRelevant(entry.title)) {
      console.log(`[Pipeline 1] Not Jensen/Nvidia related, skipping: ${entry.title}`);
      markProcessed(entry.videoId);
      continue;
    }

    console.log(`[Pipeline 1] NEW → ${entry.title} [${channel.name}]`);

    let transcript = await getTranscript(entry.videoId);

    if (!transcript || transcript.length < 100) {
      console.log(`[Pipeline 1] No transcript for "${entry.title}", using description`);
      transcript = entry.summary || '';
    }

    if (!transcript || transcript.length < 50) {
      console.log(`[Pipeline 1] Insufficient content, skipping: ${entry.title}`);
      markProcessed(entry.videoId);
      continue;
    }

    const { companyMentions, marketSignals, policySignals, summary } = await extractMentions(transcript, entry.title, channel.name);

    if (companyMentions.length > 0 || marketSignals.length > 0 || policySignals.length > 0) {
      const fullText = `Video: ${entry.title}
Channel: ${channel.name}
Published: ${entry.published}
URL: ${entry.link}

TRANSCRIPT:
${transcript}`;

      try {
        await sendAlert({
          pipeline: `Pipeline 1 — ${channel.name}`,
          timestamp: new Date().toISOString(),
          title: entry.title,
          sourceUrl: entry.link,
          fullText,
          summary: summary || entry.summary || '',
          companyMentions,
          marketSignals,
          policySignals,
        });
      } catch (err) {
        console.error(`[P1] sendAlert FAILED: ${err.message}`);
        console.error(err.stack);
      }
    } else {
      console.log(`[Pipeline 1] No actionable signals in: ${entry.title}`);
    }

    markProcessed(entry.videoId);
    await new Promise(r => setTimeout(r, 2000));
  }
}

async function run() {
  console.log(`[Pipeline 1] ${new Date().toISOString()} — Checking YouTube channels...`);
  for (const channel of CHANNELS) {
    await checkChannel(channel);
    await new Promise(r => setTimeout(r, 3000));
  }
}

module.exports = { run };
