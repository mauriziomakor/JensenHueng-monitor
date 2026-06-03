require('dotenv').config();
const cron = require('node-cron');

const pipeline0 = require('./pipeline0_nvidia');
const pipeline1 = require('./pipeline1_youtube');
const pipeline2 = require('./pipeline2_earnings');
const pipeline3 = require('./pipeline3_news');

console.log('═══════════════════════════════════════════════════════════');
console.log('  Jensen Huang / Nvidia Monitor — Starting');
console.log('═══════════════════════════════════════════════════════════');
console.log('  Pipeline 0 — Nvidia RSS feeds          (every 60 seconds)');
console.log('  Pipeline 1 — YouTube channels          (every 15 minutes)');
console.log('  Pipeline 2 — Nvidia IR / Earnings      (daily at 09:00)');
console.log('  Pipeline 3 — Google News               (every 15 minutes)');
console.log('═══════════════════════════════════════════════════════════');

async function safeRun(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`[${label}] Uncaught error:`, err.message);
  }
}

// Pipeline 0: every 60 seconds
cron.schedule('* * * * *', () => safeRun('Pipeline 0', pipeline0.run));

// Pipeline 1: every 15 minutes
cron.schedule('*/15 * * * *', () => safeRun('Pipeline 1', pipeline1.run));

// Pipeline 2: daily at 09:00
cron.schedule('0 9 * * *', () => safeRun('Pipeline 2', pipeline2.run));

// Pipeline 3: every 15 minutes
cron.schedule('*/15 * * * *', () => safeRun('Pipeline 3', pipeline3.run));

// Staggered startup — run all pipelines once immediately
(async () => {
  console.log('\n[Startup] Running initial checks...\n');

  await safeRun('Pipeline 0 startup', pipeline0.run);
  await new Promise(r => setTimeout(r, 5000));

  await safeRun('Pipeline 1 startup', pipeline1.run);
  await new Promise(r => setTimeout(r, 5000));

  await safeRun('Pipeline 3 startup', pipeline3.run);

  console.log('\n[Startup] Initial checks complete. All cron jobs are active.\n');
})();
