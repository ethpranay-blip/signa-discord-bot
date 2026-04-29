// ============================================================
// bot.js
// Main entry: schedules cron jobs, posts to Discord webhooks,
// and handles startup validation. Run with `node bot.js`.
// ============================================================

import 'dotenv/config';
import cron from 'node-cron';
import fetch from 'node-fetch';

import {
  getMe,
  getSignalIndex,
  getScoredSignals,
  getDarkPool,
  getCalendar,
  screenTickers,
  getEnhancedSignal,
  getQuote
} from './signa-client.js';

import {
  buildDailyDigest,
  buildTier3Alert,
  buildWatchlistSummary,
  buildTickerAlert,
  buildDarkPoolAlert,
  buildRegimeChange,
  buildPremarketBrief,
  buildStartupNotice
} from './formatter.js';

// --- Environment ---
const SIGNA_API_KEY = process.env.SIGNA_API_KEY;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const DISCORD_ALERTS_WEBHOOK_URL = process.env.DISCORD_ALERTS_WEBHOOK_URL || DISCORD_WEBHOOK_URL;
const WATCHLIST = (process.env.WATCHLIST || '')
  .split(',')
  .map(t => t.trim().toUpperCase())
  .filter(Boolean)
  .slice(0, 50);
const DIGEST_HOUR = parseInt(process.env.DIGEST_HOUR || '21', 10);
const DIGEST_MINUTE = parseInt(process.env.DIGEST_MINUTE || '30', 10);
const DARKPOOL_TICKER = (process.env.DARKPOOL_TICKER || 'SPY').toUpperCase();
const ENABLE_MIDDAY_CHECK = (process.env.ENABLE_MIDDAY_CHECK || 'true').toLowerCase() === 'true';
const ENABLE_PREMARKET = (process.env.ENABLE_PREMARKET || 'true').toLowerCase() === 'true';

const TZ = 'America/New_York';

// ============================================================
// Channel routing — each event type goes to its own webhook.
// If a channel-specific webhook is missing, falls back to
// DISCORD_WEBHOOK_URL (the original default channel) so nothing
// is lost during partial setup.
// ============================================================
const CHANNELS = {
  signals:  process.env.DISCORD_WEBHOOK_SIGNALS  || DISCORD_WEBHOOK_URL,
  micro:    process.env.DISCORD_WEBHOOK_MICRO    || DISCORD_ALERTS_WEBHOOK_URL,
  macro:    process.env.DISCORD_WEBHOOK_MACRO    || DISCORD_WEBHOOK_URL,
  earnings: process.env.DISCORD_WEBHOOK_EARNINGS || DISCORD_WEBHOOK_URL,
  darkpool: process.env.DISCORD_WEBHOOK_DARKPOOL || DISCORD_WEBHOOK_URL,
  fomc:     process.env.DISCORD_WEBHOOK_FOMC     || DISCORD_ALERTS_WEBHOOK_URL,
  lookups:  process.env.DISCORD_WEBHOOK_LOOKUPS  || DISCORD_WEBHOOK_URL,
  backtest: process.env.DISCORD_WEBHOOK_BACKTEST || DISCORD_WEBHOOK_URL
};

const _fallbackWarned = new Set();
function route(channel) {
  const url = CHANNELS[channel];
  if (!url) {
    if (!_fallbackWarned.has(channel)) {
      console.warn(`[${ts()}] ⚠️  No webhook configured for #${channel} — events will be dropped.`);
      _fallbackWarned.add(channel);
    }
    return null;
  }
  const expected = `DISCORD_WEBHOOK_${channel.toUpperCase()}`;
  if (!process.env[expected] && !_fallbackWarned.has(channel)) {
    console.log(`[${ts()}] ℹ️  #${channel} using fallback webhook (set ${expected} for dedicated channel).`);
    _fallbackWarned.add(channel);
  }
  return url;
}

// --- In-memory state ---
const state = {
  lastDarkpoolAggressor: null,
  lastRegime: null,
  lastWebhookPostAt: new Map()
};

// ============================================================
// Logging
// ============================================================

function ts() {
  return new Date().toLocaleTimeString('en-US', { timeZone: TZ, hour12: false }) + ' ET';
}

function log(...args) {
  console.log(`[${ts()}]`, ...args);
}

function logErr(...args) {
  console.error(`[${ts()}]`, ...args);
}

// Plan info from /api/v1/me can be a string OR an object like
// { id, name, tier, ... }. Normalize to a friendly display string.
function formatPlan(plan) {
  if (plan == null) return null;
  if (typeof plan === 'string') return plan;
  if (typeof plan === 'object') {
    const name = plan.name || plan.plan_name || plan.tier || plan.label;
    const id = plan.id != null ? `#${plan.id}` : '';
    if (name) return id ? `${name} (${id})` : String(name);
    return JSON.stringify(plan);
  }
  return String(plan);
}

// ============================================================
// Discord poster — handles 429, enforces 1s/webhook spacing
// ============================================================

async function postToDiscord(webhookUrl, payload, jobLabel = 'job') {
  if (!webhookUrl) {
    logErr(`❌ ${jobLabel}: webhook URL missing`);
    return false;
  }
  if (!payload || (!payload.content && (!payload.embeds || payload.embeds.length === 0))) {
    log(`⏭️  ${jobLabel}: empty payload, skipping`);
    return false;
  }

  // Enforce 1-second minimum spacing per webhook
  const last = state.lastWebhookPostAt.get(webhookUrl) || 0;
  const sinceLast = Date.now() - last;
  if (sinceLast < 1000) {
    await new Promise(r => setTimeout(r, 1000 - sinceLast));
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (err) {
      logErr(`❌ ${jobLabel}: network error posting to Discord: ${err.message}`);
      return false;
    }

    state.lastWebhookPostAt.set(webhookUrl, Date.now());

    if (res.ok || res.status === 204) {
      log(`✅ ${jobLabel}: posted to Discord`);
      return true;
    }

    if (res.status === 429 && attempt === 0) {
      const retryAfter = parseFloat(res.headers.get('retry-after') || '1') * 1000;
      log(`⏳ ${jobLabel}: Discord 429, waiting ${retryAfter}ms`);
      await new Promise(r => setTimeout(r, retryAfter + 100));
      continue;
    }

    const body = await res.text().catch(() => '');
    if (res.status === 400 && body.includes('50035')) {
      logErr(`❌ ${jobLabel}: Discord 50035 — embed too large or malformed. Body: ${body.slice(0, 300)}`);
    } else {
      logErr(`❌ ${jobLabel}: Discord ${res.status}: ${body.slice(0, 300)}`);
    }
    return false;
  }
  return false;
}

// ============================================================
// JOB 1 — Nightly digest
// ============================================================

async function runNightlyDigest() {
  log('───────────────────────────────────');
  log('📊 Running nightly digest…');

  const t0 = Date.now();

  const [signalIndexRes, scoredRes, darkpoolRes, calendarRes, screenerRes] =
    await Promise.allSettled([
      getSignalIndex(),
      getScoredSignals(200),
      getDarkPool(DARKPOOL_TICKER, 100),
      getCalendar(1),
      WATCHLIST.length > 0 ? screenTickers(WATCHLIST) : Promise.resolve(null)
    ]);

  const signalIndex = signalIndexRes.status === 'fulfilled' ? signalIndexRes.value : null;
  let scored = scoredRes.status === 'fulfilled' ? scoredRes.value : [];
  if (!Array.isArray(scored)) scored = scored?.signals || scored?.results || [];
  const darkpool = darkpoolRes.status === 'fulfilled' ? darkpoolRes.value : null;
  const calendar = calendarRes.status === 'fulfilled' ? calendarRes.value : null;
  const screener = screenerRes.status === 'fulfilled' ? screenerRes.value : null;

  // Log any failures
  for (const [name, r] of [
    ['signal-index', signalIndexRes],
    ['scored-signals', scoredRes],
    ['darkpool', darkpoolRes],
    ['calendar', calendarRes],
    ['screener', screenerRes]
  ]) {
    if (r.status === 'rejected') logErr(`  ⚠️  ${name} failed: ${r.reason?.message || r.reason}`);
  }

  // Regime change detection
  if (signalIndex?.regime && state.lastRegime && state.lastRegime !== signalIndex.regime) {
    const change = buildRegimeChange(state.lastRegime, signalIndex.regime);
    await postToDiscord(route('macro'), change, 'regime-change');
  }
  if (signalIndex?.regime) state.lastRegime = signalIndex.regime;

  // 1) Main digest
  const digest = buildDailyDigest(signalIndex, scored, calendar, darkpool, WATCHLIST);
  await postToDiscord(route('signals'), digest, 'nightly-digest');

  // 2) Tier 3 alerts (separate channel if configured)
  const tier3 = scored.filter(s => Number(s.alert_tier ?? s.tier) === 3);
  if (tier3.length > 0) {
    const alert = buildTier3Alert(scored);
    if (alert) await postToDiscord(route('micro'), alert, 'tier3-alert');
  }

  // 3) Watchlist summary
  if (screener) {
    const wl = buildWatchlistSummary(screener, WATCHLIST);
    if (wl) await postToDiscord(route('signals'), wl, 'watchlist-summary');
  }

  const ms = Date.now() - t0;
  log(`✓ Digest complete in ${ms}ms — ${scored.length} scored, ${tier3.length} tier3, regime ${signalIndex?.regime || 'UNKNOWN'}`);
  log('───────────────────────────────────');
}

// ============================================================
// JOB 2 — Midday Tier 3 sweep
// ============================================================

async function runMiddayCheck() {
  log('☀️ Midday Tier 3 sweep…');
  try {
    let scored = await getScoredSignals(200);
    if (!Array.isArray(scored)) scored = scored?.signals || scored?.results || [];
    const tier3 = scored.filter(s => Number(s.alert_tier ?? s.tier) === 3);
    if (tier3.length === 0) {
      log('  No Tier 3 signals at midday.');
      return;
    }
    const alert = buildTier3Alert(scored);
    if (alert) await postToDiscord(route('micro'), alert, 'midday-tier3');
  } catch (err) {
    logErr(`❌ midday-check failed: ${err.message}`);
  }
}

// ============================================================
// JOB 3 — Pre-market brief
// ============================================================

async function runPremarketBrief() {
  log('🌅 Pre-market brief…');
  try {
    const [calRes, scoredRes] = await Promise.allSettled([
      getCalendar(1),
      getScoredSignals(200)
    ]);
    const calendar = calRes.status === 'fulfilled' ? calRes.value : { earnings: [] };
    let scored = scoredRes.status === 'fulfilled' ? scoredRes.value : [];
    if (!Array.isArray(scored)) scored = scored?.signals || scored?.results || [];

    // Cross-reference watchlist with active signals
    const watchSet = new Set(WATCHLIST);
    const watchlistSignals = scored.filter(s => watchSet.has(s.ticker?.toUpperCase()));

    const brief = buildPremarketBrief(calendar, {
      signals: watchlistSignals,
      watchlist: WATCHLIST
    });
    await postToDiscord(route('signals'), brief, 'premarket-brief');
  } catch (err) {
    logErr(`❌ premarket-brief failed: ${err.message}`);
  }
}

// ============================================================
// JOB 4 — Dark pool anomaly check (every 30 min market hours)
// ============================================================

async function runDarkpoolCheck() {
  try {
    const dp = await getDarkPool(DARKPOOL_TICKER, 100);
    const summary = dp?.summary;
    if (!summary) return;

    const agg = summary.net_aggressor;
    const buy = Number(summary.buy_premium || 0);
    const sell = Number(summary.sell_premium || 0);

    const aggressorChanged = state.lastDarkpoolAggressor !== null
      && state.lastDarkpoolAggressor !== agg;
    const sellImbalance = sell > buy * 10 && sell > 0;
    const buyImbalance = buy > sell * 10 && buy > 0;

    const shouldAlert = aggressorChanged || sellImbalance || buyImbalance;

    if (shouldAlert) {
      log(`🌊 Dark pool anomaly: ${state.lastDarkpoolAggressor || '—'} → ${agg}, buy=${buy}, sell=${sell}`);
      const alert = buildDarkPoolAlert(summary, DARKPOOL_TICKER);
      if (alert) await postToDiscord(route('micro'), alert, 'darkpool-anomaly');
    }
    state.lastDarkpoolAggressor = agg;
  } catch (err) {
    logErr(`❌ darkpool-check failed: ${err.message}`);
  }
}

// ============================================================
// On-demand: lookupTicker (exported for slash-command use)
// ============================================================

export async function lookupTicker(ticker) {
  if (!ticker) throw new Error('lookupTicker: ticker required');
  const t = String(ticker).trim().toUpperCase();
  log(`🔍 Looking up ${t}…`);

  const [enhancedRes, quoteRes, dpRes] = await Promise.allSettled([
    getEnhancedSignal(t),
    getQuote(t),
    getDarkPool(t, 20)
  ]);

  const enhanced = enhancedRes.status === 'fulfilled' ? enhancedRes.value : null;
  const quote = quoteRes.status === 'fulfilled' ? quoteRes.value : null;

  if (!enhanced && !quote) {
    logErr(`  No data for ${t}`);
    return false;
  }

  const payload = buildTickerAlert(t, quote, enhanced);
  return postToDiscord(route('lookups'), payload, `lookup-${t}`);
}

// ============================================================
// Startup
// ============================================================

function validateEnv() {
  const missing = [];
  if (!SIGNA_API_KEY) missing.push('SIGNA_API_KEY');
  if (!DISCORD_WEBHOOK_URL) missing.push('DISCORD_WEBHOOK_URL');

  if (missing.length > 0) {
    console.error('\n❌ Missing required environment variables:');
    for (const k of missing) console.error(`   • ${k}`);
    console.error('\nCopy .env.example to .env and fill in the values.\n');
    console.error('• SIGNA_API_KEY: app.getsigna.ai/dashboard/api-keys');
    console.error('• DISCORD_WEBHOOK_URL: Server Settings → Integrations → Webhooks\n');
    process.exit(1);
  }
}

function fmtCron(min, hour) {
  const m = String(min).padStart(2, '0');
  const h = String(hour).padStart(2, '0');
  return `${h}:${m} ET`;
}

async function startup() {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║       SIGNA DISCORD BOT  v1.0.0        ║');
  console.log('╚════════════════════════════════════════╝\n');

  validateEnv();

  // Verify API key + log account info
  let me;
  try {
    me = await getMe();
    log(`Account verified.`);
    const planStr = formatPlan(me.plan ?? me.plan_name ?? me.tier);
    if (planStr) log(`  Plan:        ${planStr}`);
    if (me.scopes) log(`  Scopes:      ${Array.isArray(me.scopes) ? me.scopes.join(', ') : me.scopes}`);
    const limit = me.rate_limit ?? me.plan?.rate_limit ?? me.plan?.rateLimit;
    if (limit) log(`  Rate limit:  ${limit} req/min`);
    if (me.calls_30d != null) log(`  Calls (30d): ${me.calls_30d}`);
    if (me.quota) log(`  Quota:       ${JSON.stringify(me.quota)}`);
  } catch (err) {
    logErr(`❌ Could not verify Signa account: ${err.message}`);
    logErr('   Bot will continue but jobs may fail. Check your SIGNA_API_KEY.');
  }

  log('');
  log(`Watchlist (${WATCHLIST.length}): ${WATCHLIST.join(', ') || '(empty)'}`);
  log(`Dark-pool ticker: ${DARKPOOL_TICKER}`);
  log('');
  log('Channel routing:');
  for (const [name, url] of Object.entries(CHANNELS)) {
    const explicit = !!process.env[`DISCORD_WEBHOOK_${name.toUpperCase()}`];
    const status = !url ? '❌ NOT SET' : explicit ? '✅ dedicated' : '⚠️  fallback to default';
    log(`  #${name.padEnd(9)} ${status}`);
  }
  log('');
  log('Scheduled jobs (America/New_York, weekdays):');
  log(`  📊 Nightly digest      ${fmtCron(DIGEST_MINUTE, DIGEST_HOUR)}  Mon–Fri    → #signals + #micro (Tier 3)`);
  if (ENABLE_MIDDAY_CHECK)  log(`  ☀️  Midday Tier 3 check  12:30 ET           Mon–Fri    → #micro`);
  if (ENABLE_PREMARKET)     log(`  🌅 Pre-market brief    09:00 ET           Mon–Fri    → #signals`);
  log(`  🌊 Dark pool sweep     :00/:30 9am-4pm ET   Mon–Fri    → #micro`);
  log('');

  // Schedule jobs
  cron.schedule(`${DIGEST_MINUTE} ${DIGEST_HOUR} * * 1-5`, runNightlyDigest, { timezone: TZ });

  if (ENABLE_MIDDAY_CHECK) {
    cron.schedule('30 12 * * 1-5', runMiddayCheck, { timezone: TZ });
  }

  if (ENABLE_PREMARKET) {
    cron.schedule('0 9 * * 1-5', runPremarketBrief, { timezone: TZ });
  }

  cron.schedule('*/30 9-16 * * 1-5', runDarkpoolCheck, { timezone: TZ });

  // Startup notice to Discord
  const nextDigest = `${fmtCron(DIGEST_MINUTE, DIGEST_HOUR)} (Mon–Fri)`;
  const startupPayload = buildStartupNotice(me, nextDigest, WATCHLIST.length);
  await postToDiscord(route('signals'), startupPayload, 'startup');

  log('Bot is running. Press Ctrl+C to stop.\n');
}

// ============================================================
// Graceful shutdown
// ============================================================

process.on('SIGINT', () => {
  log('\nShutting down…');
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  logErr(`Unhandled rejection: ${reason?.message || reason}`);
});

process.on('uncaughtException', (err) => {
  logErr(`Uncaught exception: ${err?.message || err}`);
});

// ============================================================
// CLI flags — manually trigger a job and exit. Useful for testing.
//   node bot.js --digest-now      → fire one nightly digest, exit
//   node bot.js --premarket-now   → fire one pre-market brief, exit
//   node bot.js --darkpool-now    → fire one dark-pool check, exit
//   node bot.js --tier3-now       → fire one tier-3 sweep, exit
// ============================================================

const cliArgs = process.argv.slice(2);

async function runOneShot(label, fn) {
  console.log(`\n[${ts()}] One-shot: ${label}\n`);
  validateEnv();
  try {
    await fn();
    console.log(`\n[${ts()}] ✓ ${label} complete. Check Discord.\n`);
    process.exit(0);
  } catch (err) {
    console.error(`\n[${ts()}] ❌ ${label} failed: ${err.message}\n`);
    process.exit(1);
  }
}

if (cliArgs.includes('--digest-now')) {
  runOneShot('Nightly digest', runNightlyDigest);
} else if (cliArgs.includes('--premarket-now')) {
  runOneShot('Pre-market brief', runPremarketBrief);
} else if (cliArgs.includes('--darkpool-now')) {
  runOneShot('Dark pool check', runDarkpoolCheck);
} else if (cliArgs.includes('--tier3-now')) {
  runOneShot('Tier-3 sweep', runMiddayCheck);
} else {
  // Normal run — start scheduled bot
  startup().catch(err => {
    logErr(`Fatal startup error: ${err.message}`);
    process.exit(1);
  });
}
