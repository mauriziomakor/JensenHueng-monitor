require('dotenv').config();
const sgMail = require('@sendgrid/mail');

sgMail.setApiKey(process.env.SENDGRID_API_KEY || process.env.SMTP_PASS || (() => { throw new Error('SENDGRID_API_KEY env var is missing'); })());

const SIGNAL_COLORS = {
  BUY:     '#1a7a1a',
  SELL:    '#cc0000',
  WATCH:   '#cc7700',
  BULLISH: '#1a7a1a',
  BEARISH: '#cc0000',
  NEUTRAL: '#555555',
};

function signalBadge(signal) {
  const bg = SIGNAL_COLORS[signal] || '#555555';
  return `<span style="background:${bg};color:#fff;padding:4px 10px;border-radius:4px;font-weight:bold;font-size:12px;letter-spacing:0.5px;">${signal || 'N/A'}</span>`;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildCompanyTable(mentions) {
  if (!mentions || mentions.length === 0) {
    return '<p style="color:#888;font-style:italic;">No company mentions detected.</p>';
  }

  const rows = mentions.map(m => `
    <tr style="border-bottom:1px solid #e8e8e8;">
      <td style="padding:10px 12px;font-weight:bold;color:#1a1a2e;white-space:nowrap;">${escapeHtml(m.company)}</td>
      <td style="padding:10px 12px;font-style:italic;color:#333;border-left:3px solid #76b900;">"${escapeHtml(m.quote)}"</td>
      <td style="padding:10px 12px;color:#444;font-size:13px;">${escapeHtml(m.context)}</td>
      <td style="padding:10px 12px;text-align:center;color:#555;white-space:nowrap;">${escapeHtml(m.sentiment)}</td>
      <td style="padding:10px 12px;text-align:center;">${signalBadge(m.signal)}</td>
    </tr>`).join('');

  return `
    <h3 style="color:#1a1a2e;border-bottom:2px solid #76b900;padding-bottom:8px;margin-top:28px;">Company Mentions</h3>
    <div style="overflow-x:auto;">
    <table style="border-collapse:collapse;width:100%;background:#fff;border:1px solid #e0e0e0;border-radius:6px;">
      <thead>
        <tr style="background:#1a1a2e;color:#fff;">
          <th style="padding:10px 12px;text-align:left;white-space:nowrap;">Company</th>
          <th style="padding:10px 12px;text-align:left;">Verbatim Quote</th>
          <th style="padding:10px 12px;text-align:left;">Context</th>
          <th style="padding:10px 12px;text-align:center;">Sentiment</th>
          <th style="padding:10px 12px;text-align:center;">Signal</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    </div>`;
}

function buildMarketSignalTable(signals) {
  if (!signals || signals.length === 0) {
    return '<p style="color:#888;font-style:italic;">No market signals detected.</p>';
  }

  const rows = signals.map(s => `
    <tr style="border-bottom:1px solid #e8e8e8;">
      <td style="padding:10px 12px;font-weight:bold;color:#1a1a2e;white-space:nowrap;">${escapeHtml(s.keyword)}</td>
      <td style="padding:10px 12px;font-style:italic;color:#333;border-left:3px solid #0066cc;">"${escapeHtml(s.quote)}"</td>
      <td style="padding:10px 12px;color:#444;font-size:13px;">${escapeHtml(s.context)}</td>
      <td style="padding:10px 12px;text-align:center;">${signalBadge(s.signal)}</td>
    </tr>`).join('');

  return `
    <h3 style="color:#1a1a2e;border-bottom:2px solid #0066cc;padding-bottom:8px;margin-top:28px;">Market Signals</h3>
    <div style="overflow-x:auto;">
    <table style="border-collapse:collapse;width:100%;background:#fff;border:1px solid #e0e0e0;border-radius:6px;">
      <thead>
        <tr style="background:#1a1a2e;color:#fff;">
          <th style="padding:10px 12px;text-align:left;white-space:nowrap;">Keyword / Phrase</th>
          <th style="padding:10px 12px;text-align:left;">Exact Quote</th>
          <th style="padding:10px 12px;text-align:left;">Context</th>
          <th style="padding:10px 12px;text-align:center;">Signal</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    </div>`;
}


async function sendAlert({ pipeline, timestamp, title, sourceUrl, fullText, summary, companyMentions, marketSignals }) {
  const subject = `[Jensen Monitor | ${pipeline}] ${title}`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:Arial,Helvetica,sans-serif;max-width:1200px;margin:0 auto;padding:20px;background:#f0f2f5;">
  <div style="background:#fff;padding:32px;border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,0.12);">

    <!-- Header Banner -->
    <div style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);color:#fff;padding:22px 24px;border-radius:8px;margin-bottom:24px;">
      <div style="margin-bottom:12px;">
        <span style="font-size:24px;margin-right:10px;">⚡</span>
        <span style="color:#76b900;font-size:20px;font-weight:bold;letter-spacing:0.5px;">Jensen Huang / Nvidia Monitor Alert</span>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:14px;line-height:2;">
        <tr><td style="color:#aaa;width:120px;">Pipeline</td><td style="color:#fff;font-weight:bold;">${escapeHtml(pipeline)}</td></tr>
        <tr><td style="color:#aaa;">Timestamp</td><td style="color:#fff;">${escapeHtml(timestamp)}</td></tr>
        <tr><td style="color:#aaa;">Source</td><td><a href="${escapeHtml(sourceUrl)}" style="color:#76b900;word-break:break-all;">${escapeHtml(sourceUrl)}</a></td></tr>
      </table>
    </div>

    <!-- Title -->
    <h2 style="color:#1a1a2e;margin:0 0 18px 0;font-size:18px;">${escapeHtml(title)}</h2>

    <!-- Summary -->
    <div style="background:#f0fff0;padding:16px 20px;border-left:4px solid #76b900;border-radius:0 6px 6px 0;margin-bottom:24px;">
      <h3 style="margin:0 0 8px 0;color:#1a1a2e;font-size:14px;text-transform:uppercase;letter-spacing:0.5px;">Summary</h3>
      <p style="margin:0;color:#333;line-height:1.7;">${escapeHtml(summary)}</p>
    </div>

    <!-- Company Mentions Table -->
    ${buildCompanyTable(companyMentions)}

    <!-- Market Signals Table -->
    ${buildMarketSignalTable(marketSignals)}

    <!-- Full Original Text -->
    <div style="background:#fafafa;padding:20px;border:1px solid #ddd;border-radius:6px;margin-top:28px;">
      <h3 style="margin:0 0 12px 0;color:#1a1a2e;font-size:14px;text-transform:uppercase;letter-spacing:0.5px;">Full Original Text</h3>
      <pre style="white-space:pre-wrap;word-wrap:break-word;font-family:inherit;font-size:13px;color:#333;margin:0;line-height:1.6;">${escapeHtml(fullText)}</pre>
    </div>

    <!-- Disclaimer -->
    <div style="background:#fff8e1;border:1px solid #ffca28;padding:14px 18px;border-radius:6px;margin-top:24px;text-align:center;">
      <strong style="color:#856404;font-size:14px;">⚠️ DISCLAIMER: Always verify before trading. This is automated monitoring only and does not constitute financial advice.</strong>
    </div>

  </div>
</body>
</html>`;

  const fromAddr = process.env.SENDER_EMAIL || process.env.RECIPIENT_EMAIL;
  const [response] = await sgMail.send({
    from:    { name: 'Jensen Monitor', email: fromAddr },
    to:      process.env.RECIPIENT_EMAIL,
    subject,
    html,
  });

  console.log(`[Email] Sent: "${subject}" → msgId: ${response.headers['x-message-id'] || response.statusCode}`);
}

module.exports = { sendAlert };
