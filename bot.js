// ============================================================
// bot.js
// Main entry: schedules cron jobs, posts to Discord webhooks,
// and handles startup validation. Run with `node bot.js`.
//
// Signal source: Signa REST API (app.getsigna.ai)
//   Primary: GET /api/v1/signal per ticker (hourly poll)
//   Regime:  GET /api/v1/gex/SPY + /api/v1/gex/QQQ
//   Index:   GET /api/v1/signal-index
//   Screener: GET /api/v1/scan
//   Rate limit: 60 req/hr · 1,000/day (Founding plan)
// ============================================================

import 'dotenv/config';
import cron from 'node-cron';
import fetch from 'node-fetch';

import {
  getMe,
  getSignalIndex,
  getSignal,
  getGex,
  getQuote,
  scan,
  screenTickers
} from './signa-client.js';

import {
  buildWatchlistSummary,
  buildTickerAlert,
  buildRegimeChange,
  buildStartupNotice,
  buildSignaSlashResponse,
  buildCallCard,
  buildWatchlistGrid,
  buildRegimeUpdate,
  buildFlowHighlight,
  buildNightlySummary,
  buildRegimeOutlook
} from './formatter.js';

import { startDiscordBot } from './discord-bot.js';

// --- Environment ---
const SIGNA_API_KEY = process.env.SIGNA_API_KEY;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const DISCORD_ALERTS_WEBHOOK_URL = process.env.DISCORD_ALERTS_WEBHOOK_URL || DISCORD_WEBHOOK_URL;
const WATCHLIST = (process.env.WATCHLIST || '')
  .split(',')
  .map(t => t.trim().toUpperCase())
  .filter(Boolean)
  .slice(0, 50);
const DIGEST_HOUR   = parseInt(process.env.DIGEST_HOUR   || '21', 10);
const DIGEST_MINUTE = parseInt(process.env.DIGEST_MINUTE || '30', 10);
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

// route('signals') → returns the webhook URL for #signals.
// Logs a warning the first time a channel falls back to the default.
const _fallbackWarned = new Set();
function route(channel) {
  const url = CHANNELS[channel];
  if (!url) {
    if (!_fallbackWarned.has(channel)) {
      console.warn(`[${ts()}] ⚠️  No webhook configured for #${channel} and no DISCORD_WEBHOOK_URL fallback — events will be dropped.`);
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
  lastRegime: null,         // from signal-index, for nightly change detection
  lastGexRegime: null,      // 'ABOVE_FLIP' | 'BELOW_FLIP' — from SPY GEX, updated hourly
  lastCycleResults: [],     // [{ticker, signal, verdict}] from last hourly scan
  lastCycleTime: null,      // ISO string
  lastWebhookPostAt: new Map()
};

let haltPolling = false; // set true on 401; cleared on process restart

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

// Detect 503/nightly_pipeline_pending from a getSignalIndex() rejection.
function isPipelinePendingError(reason) {
  const msg = String(reason?.message || reason || '');
  if (msg.includes('503')) return true;
  if (msg.toLowerCase().includes('nightly_pipeline_pending')) return true;
  if (msg.toLowerCase().includes('pipeline_pending')) return true;
  return false;
}

let _signalIndexRetryPending = false;
function scheduleSignalIndexRetry(reason) {
  if (!isPipelinePendingError(reason)) return false;
  if (_signalIndexRetryPending) {
    log('  signal-index retry already pending — not scheduling another');
    return false;
  }
  _signalIndexRetryPending = true;
  const delayMs = 5 * 60 * 1000;
  log('⏳ signal-index 503 (pipeline pending) — retrying in 5 min');

  setTimeout(async () => {
    try {
      const idx = await getSignalIndex();
      if (!idx?.regime) {
        log('🔄 signal-index retry: no regime in response, skipping');
        return;
      }
      log(`🔄 signal-index retry succeeded — regime ${idx.regime}`);
      if (state.lastRegime && state.lastRegime !== idx.regime) {
        const change = buildRegimeChange(state.lastRegime, idx.regime);
        await postToDiscord(route('macro'), change, 'regime-change-retry');
      }
      state.lastRegime = idx.regime;
    } catch (err) {
      logErr(`❌ signal-index retry failed: ${err.message}`);
    } finally {
      _signalIndexRetryPending = false;
    }
  }, delayMs);
  return true;
}

// ============================================================
// computeVerdict — 6-gate filter (brief §3)
// ============================================================

function computeVerdict(signalData, spyGex) {
  const signa  = signalData?.signa  || {};
  const data   = signalData?.data   || {};
  const engine = signalData?.engine || {};

  // engine staleness: only treat engine as fresh if runAt is within 1 trading day
  const engineFresh = engine.runAt
    ? (Date.now() - new Date(engine.runAt).getTime()) < 86_400_000
    : false;

  const intendedDir = String(signa.action || '').toUpperCase();

  const gate1 = signa.alphaEvent === true;
  const gate2 = ['A+', 'A'].includes(String(signa.grade || '').toUpperCase());
  const gate3 = ['LONG', 'SHORT'].includes(intendedDir);
  const gate4 = Number(signa.flowScore ?? 0) > 65;

  const regimeAbove = spyGex?.levels?.regimeAboveFlip;
  const gate5 = (intendedDir === 'LONG'  && regimeAbove === true)
             || (intendedDir === 'SHORT' && regimeAbove === false);

  const gate6 = data.stop != null && data.target != null;

  const verdict = (gate1 && gate2 && gate3 && gate4 && gate5 && gate6) ? 'CALL' : 'NO-CALL';
  return { verdict, gates: { gate1, gate2, gate3, gate4, gate5, gate6 }, engineFresh };
}

// ============================================================
// checkQuota — read /me to verify remaining call budget.
// Returns true if safe to proceed. On 401, sets haltPolling.
// ============================================================

async function checkQuota() {
  if (haltPolling) {
    log('⛔ Polling halted (401 received previously). Restart with a valid SIGNA_API_KEY.');
    return false;
  }
  try {
    const me = await getMe();
    const remaining = me?.api?.calls_remaining ?? me?.calls_remaining ?? me?.quota?.remaining ?? null;
    if (remaining !== null) {
      log(`📊 Quota: ${remaining} calls remaining`);
      if (remaining < 20) {
        log('⚠️  Skipping cycle — fewer than 20 calls remaining this hour.');
        return false;
      }
    }
    return true;
  } catch (err) {
    if (/401/i.test(err.message)) {
      haltPolling = true;
      logErr('❌ API key invalid (401) — halting all polling. Fix SIGNA_API_KEY and restart.');
      await postToDiscord(route('signals'), {
        embeds: [{
          title: '⛔ Signa Bot: API Key Invalid',
          description: 'Received 401 from Signa API. All polling halted. Check SIGNA_API_KEY and restart.',
          color: 0xFF4444,
          timestamp: new Date().toISOString()
        }]
      }, 'halt-alert').catch(() => {});
      return false;
    }
    logErr(`⚠️  Quota check failed (${err.message}) — proceeding`);
    return true; // non-401 errors don't halt
  }
}

// ============================================================
// JOB 1 — Hourly scan (primary job, replaces midday + consensus)
// /signal per watchlist ticker → GEX → 6-gate verdict → route
// ============================================================

async function runHourlyScan() {
  log('───────────────────────────────────');
  log('🔁 Running hourly scan…');
  const t0 = Date.now();

  if (haltPolling) { log('⛔ Scan skipped — polling halted (401).'); return; }

  if (WATCHLIST.length === 0) {
    log('⏭️  Hourly scan: WATCHLIST is empty — set the WATCHLIST env var.');
    return;
  }

  if (!(await checkQuota())) return;

  // 1. Sweep watchlist — 1500ms stagger between calls
  const sweepResults = [];
  for (let i = 0; i < WATCHLIST.length; i++) {
    const ticker = WATCHLIST[i];
    try {
      const sig = await getSignal(ticker);
      sweepResults.push({ ticker, signal: sig, error: null });
    } catch (err) {
      sweepResults.push({ ticker, signal: null, error: err.message });
      logErr(`  signal failed for ${ticker}: ${err.message}`);
    }
    if (i < WATCHLIST.length - 1) await new Promise(r => setTimeout(r, 1500));
  }

  // 2. GEX — SPY primary, QQQ confirmation
  const [spyRes, qqqRes] = await Promise.allSettled([getGex('SPY'), getGex('QQQ')]);
  const spyGex = spyRes.status === 'fulfilled' ? spyRes.value : null;
  const qqqGex = qqqRes.status === 'fulfilled' ? qqqRes.value : null;
  if (!spyGex) logErr(`  ⚠️  GEX/SPY failed: ${spyRes.reason?.message}`);

  // 3. Compute verdicts
  const allResults = [];
  for (const r of sweepResults) {
    if (!r.signal) continue;
    const verdict = computeVerdict(r.signal, spyGex);
    allResults.push({ ticker: r.ticker, signal: r.signal, verdict });
  }

  // Cache for nightly summary
  state.lastCycleResults = allResults;
  state.lastCycleTime    = new Date().toISOString();

  // 4. CALL verdicts → #signals
  const callResults = allResults.filter(r => r.verdict.verdict === 'CALL');
  for (const r of callResults) {
    const card = buildCallCard(r.ticker, r.signal, spyGex, r.verdict);
    if (card) await postToDiscord(route('signals'), card, `hourly-call-${r.ticker}`);
  }

  // 5. Watchlist grid → #micro
  if (allResults.length > 0) {
    const grid = buildWatchlistGrid(allResults);
    if (grid) await postToDiscord(route('micro'), grid, 'hourly-grid');
  }

  // 6. GEX regime → #macro on flip
  if (spyGex?.levels) {
    const regimeAbove  = spyGex.levels.regimeAboveFlip;
    const newGexRegime = regimeAbove === true ? 'ABOVE_FLIP' : regimeAbove === false ? 'BELOW_FLIP' : null;
    if (newGexRegime && newGexRegime !== state.lastGexRegime) {
      log(`  GEX regime flip: ${state.lastGexRegime ?? 'none'} → ${newGexRegime}`);
      const regimeMsg = buildRegimeUpdate(spyGex, qqqGex);
      if (regimeMsg) await postToDiscord(route('macro'), regimeMsg, 'hourly-regime-flip');
      state.lastGexRegime = newGexRegime;
    }
  }

  // 7. Flow highlights → #darkpool (flowScore > 75)
  const FLOW_ALERT_THRESHOLD = 75;
  const flowHits = allResults.filter(r => Number(r.signal?.signa?.flowScore ?? 0) > FLOW_ALERT_THRESHOLD);
  for (const r of flowHits) {
    const msg = buildFlowHighlight(r.ticker, r.signal);
    if (msg) await postToDiscord(route('darkpool'), msg, `hourly-flow-${r.ticker}`);
  }

  const ms = Date.now() - t0;
  log(`✓ Hourly scan: ${WATCHLIST.length} tickers swept, ${allResults.length} signals, ${callResults.length} CALLs, ${flowHits.length} flow alerts — ${ms}ms`);
  log('───────────────────────────────────');
}

// ============================================================
// JOB 2 — Nightly digest (DIGEST_HOUR:DIGEST_MINUTE ET)
// Regime outlook → #macro. CALL summary → #signals.
// ============================================================

async function runNightlyDigest() {
  log('───────────────────────────────────');
  log('📊 Running nightly digest…');
  const t0 = Date.now();

  const [signalIndexRes, spyGexRes] = await Promise.allSettled([
    getSignalIndex(),
    getGex('SPY')
  ]);

  const signalIndex = signalIndexRes.status === 'fulfilled' ? signalIndexRes.value : null;
  const spyGex      = spyGexRes.status      === 'fulfilled' ? spyGexRes.value      : null;

  if (signalIndexRes.status === 'rejected') {
    logErr(`  ⚠️  signal-index failed: ${signalIndexRes.reason?.message}`);
    scheduleSignalIndexRetry(signalIndexRes.reason);
  }

  // Regime change detection (signal-index derived)
  if (signalIndex?.regime && state.lastRegime && state.lastRegime !== signalIndex.regime) {
    const change = buildRegimeChange(state.lastRegime, signalIndex.regime);
    await postToDiscord(route('macro'), change, 'regime-change');
  }
  if (signalIndex?.regime) state.lastRegime = signalIndex.regime;

  // 1) Regime outlook → #macro
  const outlook = buildRegimeOutlook(signalIndex, spyGex);
  if (outlook) await postToDiscord(route('macro'), outlook, 'nightly-regime-outlook');

  // 2) CALL summary → #signals
  const summary = buildNightlySummary(signalIndex, state.lastCycleResults, state.lastCycleTime);
  if (summary) await postToDiscord(route('signals'), summary, 'nightly-summary');

  const ms = Date.now() - t0;
  log(`✓ Digest complete in ${ms}ms — regime ${signalIndex?.regime || 'UNKNOWN'}, ${state.lastCycleResults?.length || 0} in last cycle`);
  log('───────────────────────────────────');
}

// ============================================================
// JOB 3 — Pre-market brief (09:00 ET)
// GEX regime → #macro. Watchlist screener → #signals.
// ============================================================

async function runPremarketBrief() {
  log('🌅 Pre-market brief…');
  try {
    const [signalIndexRes, spyGexRes, qqqGexRes, screenerRes] = await Promise.allSettled([
      getSignalIndex(),
      getGex('SPY'),
      getGex('QQQ'),
      WATCHLIST.length > 0 ? screenTickers(WATCHLIST) : Promise.resolve(null)
    ]);

    const signalIndex = signalIndexRes.status === 'fulfilled' ? signalIndexRes.value : null;
    const spyGex      = spyGexRes.status      === 'fulfilled' ? spyGexRes.value      : null;
    const qqqGex      = qqqGexRes.status      === 'fulfilled' ? qqqGexRes.value      : null;
    const screener    = screenerRes.status     === 'fulfilled' ? screenerRes.value    : null;

    for (const [name, r] of [
      ['signal-index', signalIndexRes],
      ['GEX SPY',      spyGexRes],
      ['GEX QQQ',      qqqGexRes],
      ['screener',     screenerRes]
    ]) {
      if (r.status === 'rejected') logErr(`  ⚠️  ${name} failed: ${r.reason?.message}`);
    }

    // Regime update → #macro (GEX walls + signal-index)
    const regimeMsg = buildRegimeUpdate(spyGex, qqqGex);
    if (regimeMsg) await postToDiscord(route('macro'), regimeMsg, 'premarket-regime');

    // Screener candidates → #signals
    if (screener) {
      const brief = buildWatchlistSummary(screener, WATCHLIST);
      if (brief) await postToDiscord(route('signals'), brief, 'premarket-screener');
    }
  } catch (err) {
    logErr(`❌ premarket-brief failed: ${err.message}`);
  }
}

// ============================================================
// Disabled stubs — undocumented endpoints / out of scope
// ============================================================

function runDarkpoolCheck() {
  // /api/darkpool/prints is not available on the Founding plan.
  // Flow data is available via signa.flowScore in the hourly scan → #darkpool.
}

function runEarningsCheck() {
  // /api/calendar is not available on the Founding plan.
  // get_fundamentals is Professional-gated. #earnings channel kept for future use.
}

function runConsensusCheck() {
  // Replaced by hourly scan CALL verdict routing to #signals.
}

// ============================================================
// On-demand: lookupTicker (exported for slash-command use)
// Uses getSignal() + getGex() instead of deprecated endpoints.
// ============================================================

export async function lookupTicker(ticker) {
  if (!ticker) throw new Error('lookupTicker: ticker required');
  const t = String(ticker).trim().toUpperCase();
  log(`🔍 Looking up ${t}…`);

  const [signalRes, quoteRes, gexRes] = await Promise.allSettled([
    getSignal(t),
    getQuote(t),
    getGex(t)
  ]);

  const signal = signalRes.status === 'fulfilled' ? signalRes.value : null;
  const quote  = quoteRes.status  === 'fulfilled' ? quoteRes.value  : null;
  const gex    = gexRes.status    === 'fulfilled' ? gexRes.value    : null;

  if (!signal && !quote) {
    logErr(`  No data for ${t}`);
    return false;
  }

  const payload = buildSignaSlashResponse(t, signal, quote) || buildTickerAlert(t, signal || quote, null);
  return postToDiscord(route('lookups'), payload, `lookup-${t}`);
}

// ============================================================
// Backtest — not available on Founding plan
// ============================================================

export const BACKTEST_PROFILES = {
  swing:    { stopLoss: 0.05, takeProfit: 0.10, holdingPeriod: 30 },
  daytrade: { stopLoss: 0.02, takeProfit: 0.04, holdingPeriod: 5  },
  position: { stopLoss: 0.08, takeProfit: 0.20, holdingPeriod: 90 }
};

export async function runBacktestForTicker() {
  throw new Error(
    'Backtest is not available on the Founding plan — POST /api/v1/backtest is an undocumented endpoint.'
  );
}

// ============================================================
// Startup
// ============================================================

function validateEnv() {
  const missing = [];
  if (!SIGNA_API_KEY)       missing.push('SIGNA_API_KEY');
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
  console.log('║       SIGNA DISCORD BOT  v2.0.0        ║');
  console.log('╚════════════════════════════════════════╝\n');

  validateEnv();

  // Verify API key, log account info, check scopes
  let me;
  try {
    me = await getMe();
    log('Account verified.');
    const planStr = formatPlan(me.plan ?? me.plan_name ?? me.tier);
    if (planStr) log(`  Plan:        ${planStr}`);
    if (me.scopes) log(`  Scopes:      ${Array.isArray(me.scopes) ? me.scopes.join(', ') : me.scopes}`);
    const remaining = me?.api?.calls_remaining ?? me?.calls_remaining ?? me?.quota?.remaining;
    if (remaining != null) log(`  Quota:       ${remaining} calls remaining this hour`);
    // Warn on potentially missing scopes
    const scopes  = Array.isArray(me.scopes) ? me.scopes : [];
    const needed  = ['signals', 'screener', 'options_flow'];
    const missing = needed.filter(s => !scopes.includes(s));
    if (missing.length > 0 && scopes.length > 0) {
      logErr(`  ⚠️  Key may be missing scopes: ${missing.join(', ')} — some features may return 403.`);
    }
  } catch (err) {
    logErr(`❌ Could not verify Signa account: ${err.message}`);
    logErr('   Bot will continue but jobs may fail. Check your SIGNA_API_KEY.');
  }

  log('');
  log(`Watchlist (${WATCHLIST.length}): ${WATCHLIST.join(', ') || '(empty)'}`);
  log('');
  log('Channel routing:');
  for (const [name, url] of Object.entries(CHANNELS)) {
    const explicit = !!process.env[`DISCORD_WEBHOOK_${name.toUpperCase()}`];
    const status = !url ? '❌ NOT SET' : explicit ? '✅ dedicated' : '⚠️  fallback to default';
    log(`  #${name.padEnd(9)} ${status}`);
  }
  log('');
  log('Rate limit: 60 req/hr · 1,000/day (Founding plan)');
  log(`Hourly scan: ${WATCHLIST.length} tickers + 2 GEX + 1 quota = ~${WATCHLIST.length + 3} calls/hr`);
  log('');
  log('Scheduled jobs (America/New_York, weekdays):');
  log('  🔁 Hourly scan          :00 every hour     Mon–Fri    → #signals (CALLs) · #micro (grid) · #macro (regime flip) · #darkpool (flow)');
  if (ENABLE_PREMARKET) {
    log('  🌅 Pre-market brief    09:00 ET           Mon–Fri    → #macro (GEX) · #signals (screener)');
  }
  log(`  📊 Nightly digest      ${fmtCron(DIGEST_MINUTE, DIGEST_HOUR)}  Mon–Fri    → #macro (outlook) · #signals (CALL summary)`);
  log('');
  log('Disabled (undocumented endpoints on Founding plan):');
  log('  🌊 Dark pool sweep     (flow data via signa.flowScore in hourly scan → #darkpool)');
  log('  📅 Earnings tracker    (/api/calendar not on Founding; #earnings channel kept)');
  log('  🎯 Multi-model consensus (replaced by hourly CALL verdict routing to #signals)');
  log('');

  // Schedule jobs
  cron.schedule('0 * * * 1-5', runHourlyScan, { timezone: TZ });

  if (ENABLE_PREMARKET) {
    cron.schedule('0 9 * * 1-5', runPremarketBrief, { timezone: TZ });
  }

  cron.schedule(`${DIGEST_MINUTE} ${DIGEST_HOUR} * * 1-5`, runNightlyDigest, { timezone: TZ });

  // Startup notice to Discord
  const nextDigest = `${fmtCron(DIGEST_MINUTE, DIGEST_HOUR)} (Mon–Fri)`;
  const startupPayload = buildStartupNotice(me, nextDigest, WATCHLIST.length);
  await postToDiscord(route('signals'), startupPayload, 'startup');

  // Discord Gateway bot for slash commands. Failure MUST NOT crash cron bot.
  try {
    await startDiscordBot();
  } catch (err) {
    logErr(`Discord bot failed to start (cron jobs unaffected): ${err.message}`);
  }

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
// CLI flags
//   node bot.js --dry-run [TICKER]   → fetch signal + SPY GEX, compute verdict, log only
//   node bot.js --post-test TICKER   → fetch signal + SPY GEX, build call card,
//                                       POST only to DISCORD_TEST_WEBHOOK_URL, exit
//   node bot.js --run-hourly-now     → run one hourly scan cycle and exit
//   node bot.js --digest-now         → run nightly digest and exit
//   node bot.js --premarket-now      → run pre-market brief and exit
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

if (cliArgs.includes('--dry-run')) {
  // Fetch signal + GEX, compute verdict, log to console — no Discord post
  validateEnv();
  const dryIdx    = cliArgs.indexOf('--dry-run');
  const testTicker = (cliArgs[dryIdx + 1] && !cliArgs[dryIdx + 1].startsWith('--'))
    ? cliArgs[dryIdx + 1].toUpperCase()
    : 'NVDA';
  console.log(`\n[${ts()}] Dry run — fetching ${testTicker} signal + SPY GEX…\n`);
  (async () => {
    try {
      const [sig, spyGex] = await Promise.all([getSignal(testTicker), getGex('SPY')]);
      const verdict = computeVerdict(sig, spyGex);

      console.log(`\n=== ${testTicker} — signa surface ===`);
      console.log(JSON.stringify(sig?.signa || sig, null, 2).slice(0, 1200));
      console.log(`\n=== ${testTicker} — data surface ===`);
      console.log(JSON.stringify(sig?.data || {}, null, 2).slice(0, 600));
      console.log('\n=== SPY GEX levels ===');
      console.log(JSON.stringify(spyGex?.levels || spyGex, null, 2).slice(0, 600));
      console.log('\n=== Verdict ===');
      console.log(`VERDICT: ${verdict.verdict}`);
      for (let i = 1; i <= 6; i++) {
        const g = `gate${i}`;
        console.log(`  ${verdict.gates[g] ? '✅' : '❌'} ${g}`);
      }
      console.log('\n✓ Dry run complete — no Discord posts made.\n');
      process.exit(0);
    } catch (err) {
      console.error(`\n❌ Dry run failed: ${err.message}\n`);
      process.exit(1);
    }
  })();
} else if (cliArgs.includes('--post-test')) {
  // Fetch signal + GEX, build call card, POST only to DISCORD_TEST_WEBHOOK_URL, exit.
  // Never starts the scheduler, the gateway client, or posts a startup card.
  const postIdx = cliArgs.indexOf('--post-test');
  const rawTicker = cliArgs[postIdx + 1];
  if (!rawTicker || rawTicker.startsWith('--')) {
    console.error('\n❌ --post-test requires a TICKER argument (e.g. `node bot.js --post-test NVDA`).\n');
    process.exit(1);
  }
  const testTicker = rawTicker.toUpperCase();
  const testWebhook = process.env.DISCORD_TEST_WEBHOOK_URL;
  if (!SIGNA_API_KEY) {
    console.error('\n❌ SIGNA_API_KEY is not set. Add it to .env before running --post-test.\n');
    process.exit(1);
  }
  if (!testWebhook) {
    console.error('\n❌ DISCORD_TEST_WEBHOOK_URL is not set. Add a #test channel webhook to .env first.\n');
    process.exit(1);
  }
  console.log(`\n[${ts()}] Post-test — ${testTicker} → DISCORD_TEST_WEBHOOK_URL\n`);
  (async () => {
    try {
      const [sig, spyGex] = await Promise.all([getSignal(testTicker), getGex('SPY')]);
      const verdict = computeVerdict(sig, spyGex);
      console.log(`Verdict: ${verdict.verdict}`);
      const card = buildCallCard(testTicker, sig, spyGex, verdict, { isPreview: true });
      if (!card) {
        console.error('\n❌ buildCallCard returned empty payload — nothing to post.\n');
        process.exit(1);
      }
      const ok = await postToDiscord(testWebhook, card, `post-test-${testTicker}`);
      if (!ok) {
        console.error('\n❌ Post-test failed — see error above.\n');
        process.exit(1);
      }
      console.log(`\n✓ Post-test complete — card posted to test webhook.\n`);
      process.exit(0);
    } catch (err) {
      console.error(`\n❌ Post-test failed: ${err.message}\n`);
      process.exit(1);
    }
  })();
} else if (cliArgs.includes('--run-hourly-now')) {
  runOneShot('Hourly scan', runHourlyScan);
} else if (cliArgs.includes('--digest-now')) {
  runOneShot('Nightly digest', runNightlyDigest);
} else if (cliArgs.includes('--premarket-now')) {
  runOneShot('Pre-market brief', runPremarketBrief);
} else if (cliArgs.includes('--backtest')) {
  console.error('\n❌ Backtest is not available on the Founding plan.');
  console.error('   POST /api/v1/backtest is an undocumented endpoint not included in Founding tier.\n');
  process.exit(1);
} else {
  // Unknown flag guard: any --flag we did not match above must error out
  // rather than silently fall through to launching the scheduled bot.
  const unknownFlag = cliArgs.find(a => a.startsWith('--'));
  if (unknownFlag) {
    console.error(`\n❌ Unknown CLI flag: ${unknownFlag}`);
    console.error('   Known flags: --dry-run [TICKER], --post-test TICKER, --run-hourly-now,');
    console.error('                --digest-now, --premarket-now, --backtest\n');
    process.exit(1);
  }
  // Normal run — start scheduled bot
  startup().catch(err => {
    logErr(`Fatal startup error: ${err.message}`);
    process.exit(1);
  });
}
