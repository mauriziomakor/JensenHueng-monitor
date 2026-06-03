require('dotenv').config();
const { sendAlert } = require('./email');

async function run() {
  console.log('[Jensen Monitor] Sending test email via SendGrid...');
  await sendAlert({
    pipeline:  'Pipeline 0 — Nvidia Newsroom (TEST)',
    timestamp: new Date().toISOString(),
    title:     'TEST — Jensen Monitor Connectivity Check',
    sourceUrl: 'https://nvidianews.nvidia.com/',
    fullText:  'This is a test email from the Jensen Monitor bot to confirm SendGrid delivery is working correctly.\n\nAll four pipelines are configured:\n  Pipeline 0 — Nvidia RSS feeds (every 60s)\n  Pipeline 1 — YouTube channels (every 15min)\n  Pipeline 2 — Nvidia IR / Earnings (daily 9am)\n  Pipeline 3 — Google News (every 15min)',
    summary:   'SendGrid connectivity test. If you received this email, the Jensen Monitor email pipeline is fully operational and ready to send trade alerts.',
    companyMentions: [
      {
        company:   'Microsoft Corporation',
        quote:     '"We are partnering with Microsoft to bring AI to every enterprise."',
        context:   'Test company mention — Jensen Huang announces a strategic partnership with Microsoft to expand AI infrastructure deployment across enterprise cloud environments.',
        sentiment: 'positive',
        signal:    'BUY',
        type:      'company',
      },
      {
        company:   'Advanced Micro Devices (AMD)',
        quote:     '"Competition is healthy and drives innovation across the industry."',
        context:   'Test company mention — Jensen acknowledges AMD as a competitor in the GPU market while framing competition positively.',
        sentiment: 'neutral',
        signal:    'WATCH',
        type:      'company',
      },
    ],
    marketSignals: [
      {
        keyword: 'revenue guidance',
        quote:   '"We are raising our revenue guidance for Q3 to $28 billion."',
        context: 'Test market signal — Nvidia raises quarterly revenue guidance significantly above analyst expectations.',
        signal:  'BULLISH',
        type:    'market_signal',
      },
      {
        keyword: 'supply chain',
        quote:   '"Supply chain constraints may impact deliveries in certain regions."',
        context: 'Test market signal — potential headwind flagged around supply constraints for Blackwell GPUs.',
        signal:  'BEARISH',
        type:    'market_signal',
      },
    ],
  });
  console.log('[Jensen Monitor] Test email sent successfully → mauriziomakor94@gmail.com');
}

run().catch(err => {
  console.error('[Jensen Monitor] FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
