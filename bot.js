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
  getSignalFeed,
  getDarkPool,
  getCalendar,
  screenTickers,
  getEnhancedSignal,
  getQuote,
  getSignal,
  runBacktest
} from './signa-client.js';

import {
  buildDailyDigest,
  buildTier3Alert,
  buildWatchlistSummary,
  buildTickerAlert,
  buildDarkPoolAlert,
  buildRegimeChange,
  buildPremarketBrief,
  buildStartupNotice,
  buildEarningsActionCard60,
  buildEarningsActionCard15,
  buildEarningsFollowUp,
  buildBacktestResult,
  buildConsensusAlert
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
  lastDarkpoolAggressor: null,
  lastRegime: null,
  lastWebhookPostAt: new Map() // webhookUrl -> timestamp
};

// Earnings tracker state — resets each day at 7 PM ET (after post-market closes).
// Per-ticker keys tracked: posted60, posted15, postedFollowup,
//                          preGrade, preScore, preDirection, reportedAt.
const earningsState = {
  lastResetDay: null,
  tickers: new Map()
};

function resetEarningsStateIfNewDay() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  if (earningsState.lastResetDay !== today) {
    earningsState.tickers.clear();
    earningsState.lastResetDay = today;
    console.log(`[${ts()}] 🔄 Earnings tracker reset for ${today}`);
  }
}

// Map session label → assumed report time in ET.
function reportTimeFor(timeLabel) {
  if (timeLabel === 'pre-market')  return { hour: 8,  minute: 0 };
  if (timeLabel === 'post-market') return { hour: 16, minute: 5 };
  return { hour: 12, minute: 0 };
}

function minutesUntilReport(timeLabel) {
  const t = reportTimeFor(timeLabel);
  const now = new Date();
  const tHHMM = now.toLocaleString('en-US', {
    timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit'
  });
  const [hh, mm] = tHHMM.split(':').map(Number);
  const nowMin = hh * 60 + mm;
  const reportMin = t.hour * 60 + t.minute;
  return reportMin - nowMin;
}

function getTickerState(ticker) {
  if (!earningsState.tickers.has(ticker)) {
    earningsState.tickers.set(ticker, {
      posted60: false, posted15: false, postedFollowup: false,
      preGrade: null, preScore: null, preDirection: null, reportedAt: null
    });
  }
  return earningsState.tickers.get(ticker);
}

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
// Tier 3 enrichment helper
// Fetches raw signal feed + per-ticker Action Cards, then builds
// the refined Tier 3 alert and posts it to #micro.
// ============================================================
async function emitEnrichedTier3Alert(tier3, allScored, signalIndex, jobLabel) {
  if (!tier3 || tier3.length === 0) return null;

  // Fetch raw signal feed (for model attribution + agent-level levels)
  let signalFeed = [];
  try {
    const feed = await getSignalFeed(200);
    signalFeed = Array.isArray(feed?.signals) ? feed.signals
              : Array.isArray(feed) ? feed
              : [];
  } catch (err) {
    logErr(`  ⚠️  Tier 3 enrichment: signal feed unavailable: ${err.message}`);
  }

  // Fetch Action Cards for each Tier 3 ticker (typically 0-3)
  const actionCards = {};
  await Promise.all(
    tier3.slice(0, 5).map(async (s) => {
      const ticker = String(s.ticker || '').toUpperCase();
      if (!ticker) return;
      try {
        const card = await getSignal(ticker);
        actionCards[ticker] = card?.data ?? card?.action_card ?? card?.signal ?? card;
      } catch (err) {
        // Action Card is enrichment-only; alert still fires without it.
        logErr(`  ⚠️  Action Card unavailable for ${ticker}: ${err.message}`);
      }
    })
  );

  const alert = buildTier3Alert(allScored, { signalFeed, signalIndex, actionCards });
  if (alert) {
    await postToDiscord(route('micro'), alert, jobLabel);
    return alert;
  }
  return null;
}

// Detect 503/nightly_pipeline_pending from a getSignalIndex() rejection.
// Returns true if the error looks like the pipeline wasn't ready yet.
function isPipelinePendingError(reason) {
  const msg = String(reason?.message || reason || '');
  if (msg.includes('503')) return true;
  if (msg.toLowerCase().includes('nightly_pipeline_pending')) return true;
  if (msg.toLowerCase().includes('pipeline_pending')) return true;
  return false;
}

// One-shot retry of /signal-index 5 min after the digest. Updates
// state.lastRegime and posts a regime-change alert if the regime shifted
// from yesterday's. No-op for non-503 failures.
let _signalIndexRetryPending = false;
function scheduleSignalIndexRetry(reason) {
  if (!isPipelinePendingError(reason)) return false;
  if (_signalIndexRetryPending) {
    log(`  signal-index retry already pending — not scheduling another`);
    return false;
  }
  _signalIndexRetryPending = true;
  const delayMs = 5 * 60 * 1000;
  log(`⏳ signal-index 503 (pipeline pending) — retrying in 5 min`);

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

  // The 21:30 digest sometimes races Signa's nightly pipeline. If
  // /signal-index returned 503/nightly_pipeline_pending, schedule a single
  // retry 5 min later so the regime baseline + regime-change alert still fire.
  if (signalIndexRes.status === 'rejected') {
    scheduleSignalIndexRetry(signalIndexRes.reason);
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

  // 2) Tier 3 alerts — enriched with raw feed, signal index, and Action Cards
  const tier3 = scored.filter(s => Number(s.alert_tier ?? s.tier) === 3);
  if (tier3.length > 0) {
    const alert = await emitEnrichedTier3Alert(tier3, scored, signalIndex, 'tier3-alert');
    if (!alert) log('  Tier 3 enrichment returned no alert');
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
    const [scoredRes, signalIndexRes] = await Promise.allSettled([
      getScoredSignals(200),
      getSignalIndex()
    ]);
    let scored = scoredRes.status === 'fulfilled' ? scoredRes.value : [];
    if (!Array.isArray(scored)) scored = scored?.signals || scored?.results || [];
    const signalIndex = signalIndexRes.status === 'fulfilled' ? signalIndexRes.value : null;

    const tier3 = scored.filter(s => Number(s.alert_tier ?? s.tier) === 3);
    if (tier3.length === 0) {
      log('  No Tier 3 signals at midday.');
      return;
    }
    await emitEnrichedTier3Alert(tier3, scored, signalIndex, 'midday-tier3');
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

// Minimum dollar volume on the dominant side before a dark pool alert
// is worth firing. Sub-$10M flips are routine market noise.
const DARKPOOL_MIN_DOLLAR_VOLUME = 10_000_000;

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
    const meetsThreshold = Math.max(buy, sell) >= DARKPOOL_MIN_DOLLAR_VOLUME;

    // Only fire on a true aggressor flip backed by meaningful dollar volume.
    // SELL→SELL (or any same-side repeat) is suppressed because the imbalance
    // direction has not changed, and sub-threshold flips are market noise.
    const shouldAlert = aggressorChanged && meetsThreshold;

    if (shouldAlert) {
      log(`🌊 Dark pool anomaly: ${state.lastDarkpoolAggressor || '—'} → ${agg}, buy=${buy}, sell=${sell}`);
      const alert = buildDarkPoolAlert(summary, DARKPOOL_TICKER);
      if (alert) await postToDiscord(route('micro'), alert, 'darkpool-anomaly');
    } else if (state.lastDarkpoolAggressor !== null && (aggressorChanged || meetsThreshold)) {
      // Diagnostic: log near-misses so we can tune the threshold later.
      log(`🌊 Dark pool noise: ${state.lastDarkpoolAggressor} → ${agg}, buy=${buy}, sell=${sell} — suppressed (changed=${aggressorChanged}, threshold=${meetsThreshold})`);
    }
    state.lastDarkpoolAggressor = agg;
  } catch (err) {
    logErr(`❌ darkpool-check failed: ${err.message}`);
  }
}

// ============================================================
// JOB 5 — Earnings Action Cards (Phase 2)
// Runs every 5 min, 7 AM – 7 PM ET weekdays. For each watchlist ticker
// or Grade-A pipeline ticker reporting today: post a 60-min Action Card,
// a 15-min pulse, and a follow-up after the print completes.
// ============================================================

async function runEarningsCheck() {
  resetEarningsStateIfNewDay();

  let calendar, scored;
  try {
    [calendar, scored] = await Promise.all([
      getCalendar(1),
      getScoredSignals(200)
    ]);
  } catch (err) {
    logErr(`❌ earnings-check: failed to fetch calendar/signals: ${err.message}`);
    return;
  }

  if (!Array.isArray(scored)) scored = scored?.signals || scored?.results || [];

  // Today's earnings (ET-local date)
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  const todays = (calendar?.earnings || []).filter(e => e.date === todayET);
  if (todays.length === 0) return;

  // Build candidate set: watchlist tickers + Grade A scored tickers
  const watchSet = new Set(WATCHLIST);
  const gradeASet = new Set(
    scored
      .filter(s => String(s.grade || '').toUpperCase() === 'A')
      .map(s => String(s.ticker || '').toUpperCase())
  );
  const candidates = todays.filter(e => {
    const tk = String(e.ticker || '').toUpperCase();
    return watchSet.has(tk) || gradeASet.has(tk);
  });
  if (candidates.length === 0) return;

  for (const earn of candidates) {
    const ticker = String(earn.ticker || '').toUpperCase();
    if (!ticker) continue;

    const minsToReport = minutesUntilReport(earn.time);
    const tState = getTickerState(ticker);

    // === T-60 post (window: 65 to 45 min before report) ===
    if (!tState.posted60 && minsToReport <= 65 && minsToReport >= 45) {
      try {
        const [actionCard, quote] = await Promise.all([
          getSignal(ticker).catch(() => null),
          getQuote(ticker).catch(() => null)
        ]);
        const payload = buildEarningsActionCard60(ticker, actionCard, earn, quote);
        const ok = await postToDiscord(route('earnings'), payload, `earnings-T60-${ticker}`);
        if (ok) {
          tState.posted60 = true;
          // Cache the pre-earnings grade for the follow-up post.
          const d = (actionCard?.data ?? actionCard?.action_card ?? actionCard?.signal ?? actionCard) || {};
          tState.preGrade = String(d.grade ?? d.letter_grade ?? '?').toUpperCase();
          tState.preScore = d.score ?? d.composite_score ?? null;
          tState.preDirection = String(d.direction ?? d.bias ?? d.action ?? 'NEUTRAL').toUpperCase();
        }
      } catch (err) {
        logErr(`❌ earnings T-60 failed for ${ticker}: ${err.message}`);
      }
    }

    // === T-15 pulse (window: 20 to 5 min before report) ===
    if (tState.posted60 && !tState.posted15 && minsToReport <= 20 && minsToReport >= 5) {
      try {
        const [actionCard, quote] = await Promise.all([
          getSignal(ticker).catch(() => null),
          getQuote(ticker).catch(() => null)
        ]);
        const payload = buildEarningsActionCard15(ticker, actionCard, earn, quote, tState.preGrade);
        const ok = await postToDiscord(route('earnings'), payload, `earnings-T15-${ticker}`);
        if (ok) tState.posted15 = true;
      } catch (err) {
        logErr(`❌ earnings T-15 failed for ${ticker}: ${err.message}`);
      }
    }

    // === Mark report time once we cross zero ===
    if (tState.posted60 && tState.reportedAt == null && minsToReport <= 0) {
      tState.reportedAt = Date.now();
    }

    // === Follow-up (90 min after report, only if pre-grade was A) ===
    if (
      tState.reportedAt != null &&
      !tState.postedFollowup &&
      tState.preGrade?.startsWith('A') &&
      Date.now() - tState.reportedAt >= 90 * 60 * 1000
    ) {
      try {
        const quote = await getQuote(ticker).catch(() => null);
        if (!quote || quote.change_pct == null) {
          logErr(`⏭️  earnings follow-up: ${ticker} no quote yet, will retry next tick`);
          continue;
        }
        const payload = buildEarningsFollowUp(
          ticker,
          tState.preGrade,
          tState.preScore,
          tState.preDirection,
          quote,
          earn
        );
        if (payload) {
          const ok = await postToDiscord(route('earnings'), payload, `earnings-followup-${ticker}`);
          if (ok) tState.postedFollowup = true;
        } else {
          tState.postedFollowup = true; // skip if no useful payload
        }
      } catch (err) {
        logErr(`❌ earnings follow-up failed for ${ticker}: ${err.message}`);
      }
    }
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
// On-demand: runBacktestForTicker (Phase 2 Feature 3)
//
// Runs a backtest for a single ticker with the swing-default profile,
// fetches an SPY benchmark over the same window, and posts both to
// #backtest. Used by --backtest CLI flag and (later) by the slash
// command.
// ============================================================

// Default exit profiles. The slash command will let the user pick.
export const BACKTEST_PROFILES = {
  swing:    { stopLoss: 0.05, takeProfit: 0.10, holdingPeriod: 30 },
  daytrade: { stopLoss: 0.02, takeProfit: 0.04, holdingPeriod: 5 },
  position: { stopLoss: 0.08, takeProfit: 0.20, holdingPeriod: 90 }
};

// Compute a default 2-year window ending today (ET).
function defaultBacktestWindow() {
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  const start = new Date(todayET);
  start.setFullYear(start.getFullYear() - 2);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: todayET
  };
}

export async function runBacktestForTicker(ticker, options = {}) {
  if (!ticker) throw new Error('runBacktestForTicker: ticker required');
  const t = String(ticker).trim().toUpperCase();
  log(`📊 Backtesting ${t}…`);

  const profileName = options.profile || 'swing';
  const profile = BACKTEST_PROFILES[profileName] || BACKTEST_PROFILES.swing;
  const win = options.window || defaultBacktestWindow();

  const params = {
    symbol: t,
    startDate: options.startDate || win.startDate,
    endDate: options.endDate || win.endDate,
    initialCapital: options.initialCapital || 100000,
    positionSize: options.positionSize || 0.1,
    ...profile
  };

  // Fetch ticker backtest + SPY benchmark in parallel
  const [tickerBT, spyBT] = await Promise.allSettled([
    runBacktest(params),
    runBacktest({ ...params, symbol: 'SPY' })
  ]);

  if (tickerBT.status === 'rejected') {
    logErr(`❌ Backtest failed for ${t}: ${tickerBT.reason?.message || tickerBT.reason}`);
    return false;
  }

  const opts = {
    spyBacktest: spyBT.status === 'fulfilled' ? spyBT.value : null
  };
  if (spyBT.status === 'rejected') {
    logErr(`  ⚠️  SPY benchmark failed: ${spyBT.reason?.message || spyBT.reason} — posting without benchmark`);
  }

  const payload = buildBacktestResult(t, tickerBT.value, opts);
  if (!payload) {
    logErr(`❌ Backtest payload empty for ${t}`);
    return false;
  }

  const ok = await postToDiscord(route('backtest'), payload, `backtest-${t}`);
  if (ok) {
    const s = tickerBT.value.summary;
    log(`  ✓ ${t}: ${s.totalTrades} trades, ${Math.round((s.winRate || 0) * 100)}% WR, ${s.totalReturnPercent?.toFixed(1)}% return`);
  }
  return ok;
}

// ============================================================
// JOB 6 — Multi-Model Consensus Check (Phase 2 Feature 4)
//
// Runs at 21:35 ET weekdays (5 min after the nightly digest).
// Pulls /api/signals/run?scored=true and fires an @here alert for any
// ticker where ≥CONSENSUS_MIN_MODELS independent quant models agree on
// direction with composite_score ≥ CONSENSUS_MIN_SCORE and no internal
// conflict. Posts one alert per qualifying ticker to #signals.
//
// (Originally designed around an LLM consensus agent — Signa doesn't
// expose one. The agent universe is ~19 quant/factor models across
// ta/fundamental/macro categories, and the scored endpoint already
// reports model_count + categories per signal. That's the consensus
// metric we use.)
// ============================================================

const CONSENSUS_MIN_MODELS = 5;
const CONSENSUS_MIN_SCORE = 80;
const CONSENSUS_MAX_PER_DAY = 1;

// State: track which (ticker, direction) we've alerted on today,
// plus a global daily counter so we cap @here pings at
// CONSENSUS_MAX_PER_DAY regardless of how many candidates pass the gate.
const consensusAlertState = {
  lastResetDay: null,
  alerted: new Set(), // keys like "NVDA:BULLISH"
  firedToday: 0
};

function resetConsensusStateIfNewDay() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  if (consensusAlertState.lastResetDay !== today) {
    consensusAlertState.alerted.clear();
    consensusAlertState.firedToday = 0;
    consensusAlertState.lastResetDay = today;
    log(`🔄 Consensus tracker reset for ${today}`);
  }
}

async function runConsensusCheck(opts = {}) {
  resetConsensusStateIfNewDay();
  log('🎯 Running multi-model consensus check…');

  let scored = null;
  let signalIndex = null;
  try {
    const [scoredRes, idxRes] = await Promise.allSettled([
      getScoredSignals(50),
      getSignalIndex()
    ]);
    if (scoredRes.status === 'fulfilled') {
      scored = scoredRes.value;
    } else {
      logErr(`❌ Consensus: scored signals fetch failed: ${scoredRes.reason?.message}`);
      return;
    }
    if (idxRes.status === 'fulfilled') signalIndex = idxRes.value;
  } catch (err) {
    logErr(`❌ Consensus check failed at fetch: ${err.message}`);
    return;
  }

  const rows = Array.isArray(scored?.signals) ? scored.signals : [];
  if (rows.length === 0) {
    log('  No scored signals returned.');
    return;
  }

  const candidates = rows.filter(r => {
    if (r.direction !== 'BULLISH' && r.direction !== 'BEARISH') return false;
    if ((r.model_count || 0) < CONSENSUS_MIN_MODELS) return false;
    if ((r.composite_score || 0) < CONSENSUS_MIN_SCORE) return false;
    if (r.conflict_detected) return false;
    return true;
  });

  if (candidates.length === 0) {
    log(`  No multi-model consensus signals meet gate (≥${CONSENSUS_MIN_MODELS} models, score ≥${CONSENSUS_MIN_SCORE}, no conflict). Scanned ${rows.length} scored rows.`);
    return;
  }

  // Sort by composite_score descending so the single daily alert
  // (capped at CONSENSUS_MAX_PER_DAY) goes to the strongest candidate,
  // not whichever the API returned first.
  candidates.sort((a, b) => (b.composite_score || 0) - (a.composite_score || 0));

  log(`  Found ${candidates.length} consensus candidate(s) of ${rows.length} scored rows. Building alerts…`);

  let firedCount = 0;
  for (const row of candidates) {
    const ticker = String(row.ticker || '').toUpperCase();
    if (!ticker) continue;

    if (consensusAlertState.firedToday >= CONSENSUS_MAX_PER_DAY && !opts.force) {
      log(`    ${ticker} ${row.direction}: daily cap reached (${CONSENSUS_MAX_PER_DAY}) — skipping remaining ${candidates.length - firedCount} candidate(s)`);
      break;
    }

    const alertKey = `${ticker}:${row.direction}`;
    if (consensusAlertState.alerted.has(alertKey) && !opts.force) {
      log(`    ${ticker} ${row.direction}: already alerted today — skipping`);
      continue;
    }

    let actionCard = null;
    try {
      const card = await getSignal(ticker);
      actionCard = card?.data ?? card?.action_card ?? card?.signal ?? card;
    } catch (err) {
      logErr(`    ⚠️  Action Card fetch failed for ${ticker}: ${err.message}`);
    }

    log(`    ${ticker} ${row.direction}: ${row.model_count} models, score ${row.composite_score}, divers ${row.category_diversity ?? 0} → firing`);

    const payload = buildConsensusAlert(row, {
      actionCard,
      regime: signalIndex?.regime
    });
    if (!payload) continue;

    const ok = await postToDiscord(route('signals'), payload, `consensus-${ticker}`);
    if (ok) {
      consensusAlertState.alerted.add(alertKey);
      consensusAlertState.firedToday++;
      firedCount++;
    }
  }

  log(`✓ Consensus check complete. Fired ${firedCount} alert(s).`);
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
  log(`  📊 Earnings tracker    every 5 min 7am-7pm  Mon–Fri    → #earnings`);
  log(`  🎯 Multi-model consensus 21:35 ET           Mon–Fri    → #signals (≥${CONSENSUS_MIN_MODELS} models, score ≥${CONSENSUS_MIN_SCORE}, max ${CONSENSUS_MAX_PER_DAY}/day)`);
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

  // Earnings tracker — every 5 min, 7 AM – 7 PM ET, weekdays.
  cron.schedule('*/5 7-19 * * 1-5', runEarningsCheck, { timezone: TZ });

  // Multi-model consensus — 9:35 PM ET weekdays (5 min after nightly digest).
  cron.schedule('35 21 * * 1-5', runConsensusCheck, { timezone: TZ });

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
//   node bot.js --earnings-now    → fire one earnings check, exit
//   node bot.js --consensus-now   → fire one multi-model consensus check, exit
//   node bot.js --backtest TICKER [profile] → run backtest, post to #backtest, exit
//                                  profile: swing (default) | daytrade | position
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
} else if (cliArgs.includes('--earnings-now')) {
  runOneShot('Earnings check', runEarningsCheck);
} else if (cliArgs.includes('--consensus-now')) {
  runOneShot('Multi-model consensus check', () => runConsensusCheck({ force: true }));
} else if (cliArgs.includes('--backtest')) {
  // node bot.js --backtest NVDA [profile]
  const idx = cliArgs.indexOf('--backtest');
  const ticker = cliArgs[idx + 1];
  const profile = cliArgs[idx + 2];
  if (!ticker || ticker.startsWith('--')) {
    console.error('\n❌ Usage: node bot.js --backtest TICKER [profile]\n');
    console.error('   profile: swing (default) | daytrade | position\n');
    process.exit(1);
  }
  if (profile && !BACKTEST_PROFILES[profile]) {
    console.error(`\n❌ Unknown profile "${profile}". Use: swing, daytrade, or position.\n`);
    process.exit(1);
  }
  runOneShot(
    `Backtest ${ticker.toUpperCase()} (${profile || 'swing'})`,
    () => runBacktestForTicker(ticker, { profile: profile || 'swing' })
  );
} else {
  // Normal run — start scheduled bot
  startup().catch(err => {
    logErr(`Fatal startup error: ${err.message}`);
    process.exit(1);
  });
}
