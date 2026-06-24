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
  isGexPlausible,
  deriveGexRegime,
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
  buildNightlySummary,
  buildRegimeOutlook,
  buildMacroOutlook,
  rankResults
} from './formatter.js';

import { startDiscordBot } from './discord-bot.js';

// ---- Paper-validation track logging (measurement only; no behavior change) ----
// Appends one JSON line per CALL + one cycle-summary line per hourly scan to
// TRACK_LOG_PATH. Feeds the offline ingest → signa_tracker.xlsx. File writes only.
import { appendFile } from 'node:fs/promises';

const TRACK_LOG_PATH = process.env.TRACK_LOG_PATH || './signa_track.jsonl';

async function logTrack(record) {
  try {
    await appendFile(TRACK_LOG_PATH, JSON.stringify(record) + '\n');
  } catch (e) {
    logErr(`📝 track-log write failed: ${e.message}`);
  }
}

// Signed distance of spot from the gamma flip ((spot-flip)/flip) — same inputs
// gate 5 uses, so the log matches the verdict.
function gexDist(gex) {
  const lv = gex?.levels || {};
  const flip = Number(lv.gammaFlipLevel ?? lv.flipLevel);
  const spot = Number(gex?.underlying?.price ?? gex?.underlying?.regularClose);
  if (!Number.isFinite(flip) || flip <= 0 || !Number.isFinite(spot) || spot <= 0) return null;
  return (spot - flip) / flip;
}

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
let DRY_RUN = false;     // set by --dry-run modifier on action flags; previews posts instead of sending

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

// In DRY_RUN, print a readable preview of an embed payload instead of POSTing.
function logPayloadPreview(payload, jobLabel) {
  const embeds = payload.embeds || [];
  log(`📝 [DRY] ${jobLabel}: would post ${embeds.length} embed(s)${payload.content ? ' + content' : ''}`);
  for (const e of embeds) {
    if (e.title) console.log(`      ┌─ ${e.title}`);
    if (e.description) for (const ln of String(e.description).split('\n')) console.log(`      │ ${ln}`);
    for (const f of (e.fields || [])) {
      console.log(`      ├─ ${f.name}`);
      for (const ln of String(f.value).split('\n')) console.log(`      │   ${ln}`);
    }
    console.log('      └─');
  }
}

async function postToDiscord(webhookUrl, payload, jobLabel = 'job') {
  if (!payload || (!payload.content && (!payload.embeds || payload.embeds.length === 0))) {
    log(`⏭️  ${jobLabel}: empty payload, skipping`);
    return false;
  }
  if (DRY_RUN) {
    logPayloadPreview(payload, jobLabel);
    return true;
  }
  if (!webhookUrl) {
    logErr(`❌ ${jobLabel}: webhook URL missing`);
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

function computeVerdict(signalData, tickerGex) {
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

  // Gate 5 — regime alignment, judged against THIS ticker's own GEX (tickerGex),
  // not the index's. Regime is derived deterministically from the snapshot's own
  // spot vs flip (see deriveGexRegime) so the gate can't flicker between calls.
  //   • null     → 'unavailable' (GEX missing or failed the plausibility check):
  //                renders ⚠️, can never reach CALL.
  //   • AT_FLIP  → 'neutral': price sits at the flip, regime is ambiguous — also
  //                ⚠️ and blocks CALL, but distinct from a confident disagreement.
  //   • ABOVE/BELOW → boolean agreement with the intended direction.
  let gate5;
  const regime = deriveGexRegime(tickerGex);
  if (regime === null) {
    gate5 = 'unavailable';
  } else if (regime === 'AT_FLIP') {
    gate5 = 'neutral';
  } else {
    gate5 = (intendedDir === 'LONG'  && regime === 'ABOVE')
         || (intendedDir === 'SHORT' && regime === 'BELOW');
  }

  const gate6 = data.stop != null && data.target != null;

  const verdict = (gate1 && gate2 && gate3 && gate4 && gate5 === true && gate6) ? 'CALL' : 'NO-CALL';
  return { verdict, gates: { gate1, gate2, gate3, gate4, gate5, gate6 }, engineFresh };
}

// sanitizeGex — wrap a getGex() result. Returns the raw GEX response if
// it passes the plausibility check; otherwise logs a warning with the
// upstream request_id and returns null. All call sites that consume
// SPY/QQQ GEX must pipe through this so a corrupted flip never reaches
// a regime card or gate-5 evaluation.
function sanitizeGex(raw, label) {
  if (!raw) return null;
  if (isGexPlausible(raw)) return raw;
  const lv = raw?.levels ?? {};
  const reqId = raw.__requestId || 'n/a';
  logErr(
    `⚠️  GEX/${label} implausible (request_id=${reqId}): ` +
    `flip=${lv.gammaFlipLevel} callWall=${lv.callWall} putWall=${lv.putWall} ` +
    `— treating GEX as unavailable this cycle, suppressing regime publish.`
  );
  return null;
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

  // 1. Sweep watchlist — for each ticker fetch its signal AND its OWN GEX, so
  //    gate 5 judges every name against its own gamma flip/walls (not the
  //    index's). 1500ms stagger between tickers; signal+GEX run together per
  //    ticker so a GEX failure never discards the signal (allSettled).
  const sweepResults = [];
  const gexBySymbol = new Map();
  for (let i = 0; i < WATCHLIST.length; i++) {
    const ticker = WATCHLIST[i];
    const [sigRes, gexRes] = await Promise.allSettled([getSignal(ticker), getGex(ticker)]);
    const sig    = sigRes.status === 'fulfilled' ? sigRes.value : null;
    const gexRaw = gexRes.status === 'fulfilled' ? gexRes.value : null;
    if (sigRes.status === 'rejected') logErr(`  signal failed for ${ticker}: ${sigRes.reason?.message}`);
    if (gexRes.status === 'rejected') logErr(`  GEX failed for ${ticker}: ${gexRes.reason?.message}`);
    sweepResults.push({ ticker, signal: sig, error: sigRes.status === 'rejected' ? sigRes.reason?.message : null });
    gexBySymbol.set(ticker, sanitizeGex(gexRaw, ticker));
    if (i < WATCHLIST.length - 1) await new Promise(r => setTimeout(r, 1500));
  }

  // 2. Market-level GEX for the #macro regime card — deliberately SPY/QQQ
  //    (the index-wide regime context), kept separate from the per-ticker
  //    gate-5 evaluation above. Reuse the sweep's GEX if SPY/QQQ are on the
  //    watchlist (the common case); otherwise fetch them explicitly.
  const spyGex = gexBySymbol.has('SPY')
    ? gexBySymbol.get('SPY')
    : sanitizeGex(await getGex('SPY').catch(e => { logErr(`  ⚠️  GEX/SPY failed: ${e.message}`); return null; }), 'SPY');
  const qqqGex = gexBySymbol.has('QQQ')
    ? gexBySymbol.get('QQQ')
    : sanitizeGex(await getGex('QQQ').catch(e => { logErr(`  ⚠️  GEX/QQQ failed: ${e.message}`); return null; }), 'QQQ');

  // 3. Compute verdicts — each ticker against its OWN GEX
  const allResults = [];
  for (const r of sweepResults) {
    if (!r.signal) continue;
    const gex = gexBySymbol.get(r.ticker) ?? null;
    const verdict = computeVerdict(r.signal, gex);
    allResults.push({ ticker: r.ticker, signal: r.signal, verdict, gex });
  }

  // Cache for nightly summary
  state.lastCycleResults = allResults;
  state.lastCycleTime    = new Date().toISOString();

  // 4. CALL verdicts → #signals (card shows the ticker's OWN GEX)
  const callResults = allResults.filter(r => r.verdict.verdict === 'CALL');
  for (const r of callResults) {
    const card = buildCallCard(r.ticker, r.signal, r.gex, r.verdict);
    if (card) await postToDiscord(route('signals'), card, `hourly-call-${r.ticker}`);
  }

  // ===== PAPER-TRACK LOGGING (measurement layer — file writes only, no posts) =====
  {
    const nowEt = new Date().toLocaleString('en-US', { timeZone: TZ, hour12: false }) + ' ET';
    const todayEt = new Date().toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD

    // Tally which gates failed across every evaluated name this cycle.
    // gate5 is 'unavailable'/'neutral'/false unless true; all non-true = a fail.
    const gateFails = { g1: 0, g2: 0, g3: 0, g4: 0, g5: 0, g6: 0 };
    let cameClose = 0;
    for (const r of allResults) {
      const g = r.verdict.gates;
      const fails = [];
      if (g.gate1 !== true) fails.push('g1');
      if (g.gate2 !== true) fails.push('g2');
      if (g.gate3 !== true) fails.push('g3');
      if (g.gate4 !== true) fails.push('g4');
      if (g.gate5 !== true) fails.push('g5');
      if (g.gate6 !== true) fails.push('g6');
      for (const f of fails) gateFails[f]++;
      if (fails.length === 1) cameClose++;   // "came close" = missed by exactly one gate
    }

    // One row per CALL.
    for (const r of callResults) {
      const s = r.signal?.signa || {};
      const d = r.signal?.data || {};
      await logTrack({
        type: 'call',
        call_id: `${state.lastCycleTime}-${r.ticker}-${String(s.action || '').toUpperCase()}`,
        ts_et: nowEt,
        ticker: r.ticker,
        direction: String(s.action || '').toUpperCase(),
        grade: String(s.grade || '').toUpperCase(),
        conviction: s.conviction ?? null,
        flow_score: s.flowScore ?? null,
        risk_rating: s.riskRating ?? null,
        regime_gex: deriveGexRegime(r.gex),          // ABOVE | BELOW | AT_FLIP | null
        signa_regime: s.regimeClass ?? null,
        gex_dist: gexDist(r.gex),
        entry: d.entry ?? null,
        stop: d.stop ?? null,
        target: d.target ?? null,
        rr_card: d.rr ?? null,
        spot_at_call: r.gex?.underlying?.price ?? d.price ?? null,
        triggers: Array.isArray(s.triggers)
          ? s.triggers.map(t => (typeof t === 'string' ? t : t?.name)).filter(Boolean)
          : []
      });
    }

    // One summary row per hourly cycle (ingest groups these by date).
    await logTrack({
      type: 'cycle',
      cycle_id: state.lastCycleTime,
      ts_et: nowEt,
      date: todayEt,
      candidates_evaluated: WATCHLIST.length,
      signals_returned: allResults.length,
      calls_fired: callResults.length,
      came_close: cameClose,
      gate_fails: gateFails
    });
  }
  // ===== END PAPER-TRACK LOGGING =====

  // 5. Watchlist grid → #micro
  if (allResults.length > 0) {
    const grid = buildWatchlistGrid(allResults);
    if (grid) await postToDiscord(route('micro'), grid, 'hourly-grid');
  }

  // 6. GEX regime → #macro on flip. Derived deterministically (spot vs flip
  //    with a neutral band) so price hovering at the flip doesn't spam #macro
  //    with phantom flips. AT_FLIP/unknown is treated as "no change".
  const spyRegime = deriveGexRegime(spyGex); // 'ABOVE' | 'BELOW' | 'AT_FLIP' | null
  const newGexRegime = spyRegime === 'ABOVE' ? 'ABOVE_FLIP' : spyRegime === 'BELOW' ? 'BELOW_FLIP' : null;
  if (newGexRegime && newGexRegime !== state.lastGexRegime) {
    log(`  GEX regime flip: ${state.lastGexRegime ?? 'none'} → ${newGexRegime}`);
    const regimeMsg = buildRegimeUpdate(spyGex, qqqGex);
    if (regimeMsg) await postToDiscord(route('macro'), regimeMsg, 'hourly-regime-flip');
    state.lastGexRegime = newGexRegime;
  }

  // 7. High-flow names — counted for the summary log only. Flow alerts to
  //    #darkpool were removed (channel retired); no webhook publishing.
  const FLOW_ALERT_THRESHOLD = 75;
  const flowHits = allResults.filter(r => Number(r.signal?.signa?.flowScore ?? 0) > FLOW_ALERT_THRESHOLD);

  const ms = Date.now() - t0;
  log(`✓ Hourly scan: ${WATCHLIST.length} tickers swept, ${allResults.length} signals, ${callResults.length} CALLs, ${flowHits.length} high-flow (log only) — ${ms}ms`);
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
  const spyRaw      = spyGexRes.status      === 'fulfilled' ? spyGexRes.value      : null;
  const spyGex      = sanitizeGex(spyRaw, 'SPY');

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
    const spyRaw      = spyGexRes.status      === 'fulfilled' ? spyGexRes.value      : null;
    const qqqRaw      = qqqGexRes.status      === 'fulfilled' ? qqqGexRes.value      : null;
    const spyGex      = sanitizeGex(spyRaw, 'SPY');
    const qqqGex      = sanitizeGex(qqqRaw, 'QQQ');
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
// JOB 4 — Macro outlook (twice daily, 12h apart: ~09:15 & ~21:15 ET)
// The day's outlook for #macro: overall regime + SPY/QQQ market-level
// gamma context + the top-5 tradeable names by Signa score (same ranking
// as the #micro feed). Pass { dryRun: true } to preview without posting.
// ============================================================

async function runMacroOutlook({ dryRun = false } = {}) {
  const prevDry = DRY_RUN;
  if (dryRun) DRY_RUN = true;
  log('───────────────────────────────────');
  log('🗓️  Running macro outlook…');
  const t0 = Date.now();
  try {
    if (haltPolling) { log('⛔ Macro outlook skipped — polling halted (401).'); return; }
    if (!(await checkQuota())) return;

    // Sweep the watchlist for current signals (ranking uses signa.conviction;
    // per-ticker GEX is not needed here — market gamma context is SPY/QQQ).
    const sigs = [];
    for (let i = 0; i < WATCHLIST.length; i++) {
      const ticker = WATCHLIST[i];
      try {
        sigs.push({ ticker, signal: await getSignal(ticker) });
      } catch (err) {
        logErr(`  signal failed for ${ticker}: ${err.message}`);
      }
      if (i < WATCHLIST.length - 1) await new Promise(r => setTimeout(r, 1500));
    }

    // Market-level context: signal-index regime + SPY/QQQ gamma.
    const [idxRes, spyRes, qqqRes] = await Promise.allSettled([
      getSignalIndex(), getGex('SPY'), getGex('QQQ')
    ]);
    const signalIndex = idxRes.status === 'fulfilled' ? idxRes.value : null;
    const spyGex = sanitizeGex(spyRes.status === 'fulfilled' ? spyRes.value : null, 'SPY');
    const qqqGex = sanitizeGex(qqqRes.status === 'fulfilled' ? qqqRes.value : null, 'QQQ');
    if (idxRes.status === 'rejected') {
      logErr(`  ⚠️  signal-index failed: ${idxRes.reason?.message}`);
      scheduleSignalIndexRetry(idxRes.reason);
    }

    const top5 = rankResults(sigs).slice(0, 5);
    log(`  Top 5: ${top5.map(r => `${r.ticker}(${Math.round(Number(r.signal?.signa?.conviction ?? 0))})`).join(', ') || '—'}`);

    const outlook = buildMacroOutlook(signalIndex, spyGex, qqqGex, top5);
    if (outlook) await postToDiscord(route('macro'), outlook, 'macro-outlook');

    const ms = Date.now() - t0;
    log(`✓ Macro outlook complete in ${ms}ms — regime ${signalIndex?.regime || 'UNKNOWN'}, ${top5.length} top names`);
  } finally {
    DRY_RUN = prevDry;
    log('───────────────────────────────────');
  }
}

// ============================================================
// Disabled stubs — undocumented endpoints / out of scope
// ============================================================

function runDarkpoolCheck() {
  // /api/darkpool/prints is not available on the Founding plan.
  // Flow (signa.flowScore) is computed in the hourly scan but no longer
  // published — the #darkpool channel was retired.
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
  const gexRaw = gexRes.status    === 'fulfilled' ? gexRes.value    : null;
  const gex    = sanitizeGex(gexRaw, t);

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
  log(`Hourly scan: ${WATCHLIST.length} signals + ${WATCHLIST.length} GEX (per-ticker) + 1 quota ≈ ${WATCHLIST.length * 2 + 1} calls/hr`);
  log('');
  log('Scheduled jobs (America/New_York, weekdays):');
  log('  🔁 Hourly scan          :00 every hour     Mon–Fri    → #signals (CALLs) · #micro (grid) · #macro (regime flip)');
  if (ENABLE_PREMARKET) {
    log('  🌅 Pre-market brief    09:00 ET           Mon–Fri    → #macro (GEX) · #signals (screener)');
  }
  log(`  📊 Nightly digest      ${fmtCron(DIGEST_MINUTE, DIGEST_HOUR)}  Mon–Fri    → #macro (outlook) · #signals (CALL summary)`);
  log('  🗓️  Macro outlook       09:15 & 21:15 ET  Mon–Fri    → #macro (regime + top-5 watchlist, 12h cadence)');
  log('');
  log('Disabled (undocumented endpoints on Founding plan):');
  log('  🌊 Dark pool / flow    (flowScore computed in hourly scan but not published; #darkpool retired)');
  log('  📅 Earnings tracker    (/api/calendar not on Founding; #earnings channel kept)');
  log('  🎯 Multi-model consensus (replaced by hourly CALL verdict routing to #signals)');
  log('');

  // Schedule jobs
  cron.schedule('0 * * * 1-5', runHourlyScan, { timezone: TZ });

  if (ENABLE_PREMARKET) {
    cron.schedule('0 9 * * 1-5', runPremarketBrief, { timezone: TZ });
  }

  cron.schedule(`${DIGEST_MINUTE} ${DIGEST_HOUR} * * 1-5`, runNightlyDigest, { timezone: TZ });

  // Macro outlook — twice daily, 12h apart. timezone:TZ resolves these to the
  // correct ET moment year-round (node-cron applies DST), so no hardcoded UTC
  // offset is needed.  09:15 ET = ~15 min before the 09:30 open · 21:15 ET = +12h.
  cron.schedule('15 9 * * 1-5',  () => runMacroOutlook(), { timezone: TZ });
  cron.schedule('15 21 * * 1-5', () => runMacroOutlook(), { timezone: TZ });

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
//   node bot.js --dry-run [TICKER]   → fetch signal + that ticker's GEX, compute verdict, log only
//   node bot.js --post-test TICKER   → fetch signal + that ticker's GEX, build call card,
//                                       POST only to DISCORD_TEST_WEBHOOK_URL, exit
//   node bot.js --run-hourly-now     → run one hourly scan cycle and exit
//   node bot.js --digest-now         → run nightly digest and exit
//   node bot.js --premarket-now      → run pre-market brief and exit
//   node bot.js --post-macro-now     → run the macro outlook once → #macro and exit
//
//   Add --dry-run to any action flag above to PREVIEW (build payloads, log them,
//   send nothing to Discord), e.g. `node bot.js --run-hourly-now --dry-run`.
// ============================================================

const cliArgs = process.argv.slice(2);
const dryRun  = cliArgs.includes('--dry-run');
const ACTION_FLAGS = ['--post-test', '--run-hourly-now', '--digest-now', '--premarket-now', '--post-macro-now', '--backtest'];
const hasAction = ACTION_FLAGS.some(f => cliArgs.includes(f));

async function runOneShot(label, fn, dry = false) {
  console.log(`\n[${ts()}] One-shot: ${label}${dry ? '  [DRY-RUN — no Discord posts]' : ''}\n`);
  validateEnv();
  if (dry) DRY_RUN = true;
  try {
    await fn();
    console.log(`\n[${ts()}] ✓ ${label} complete.${dry ? ' (dry-run — nothing posted)' : ' Check Discord.'}\n`);
    process.exit(0);
  } catch (err) {
    console.error(`\n[${ts()}] ❌ ${label} failed: ${err.message}\n`);
    process.exit(1);
  }
}

if (cliArgs.includes('--dry-run') && !hasAction) {
  // Bare --dry-run [TICKER]: fetch signal + that ticker's GEX, compute verdict,
  // log to console — no Discord post. (With an action flag, --dry-run instead
  // acts as a preview modifier on that action, handled below.)
  validateEnv();
  const dryIdx    = cliArgs.indexOf('--dry-run');
  const testTicker = (cliArgs[dryIdx + 1] && !cliArgs[dryIdx + 1].startsWith('--'))
    ? cliArgs[dryIdx + 1].toUpperCase()
    : 'NVDA';
  console.log(`\n[${ts()}] Dry run — fetching ${testTicker} signal + ${testTicker} GEX…\n`);
  (async () => {
    try {
      const [sig, gexRaw] = await Promise.all([getSignal(testTicker), getGex(testTicker)]);
      const gex = sanitizeGex(gexRaw, testTicker);
      const verdict = computeVerdict(sig, gex);

      console.log(`\n=== ${testTicker} — signa surface ===`);
      console.log(JSON.stringify(sig?.signa || sig, null, 2).slice(0, 1200));
      console.log(`\n=== ${testTicker} — data surface ===`);
      console.log(JSON.stringify(sig?.data || {}, null, 2).slice(0, 600));
      console.log(`\n=== ${testTicker} GEX levels ===`);
      console.log(gex
        ? JSON.stringify(gex?.levels || gex, null, 2).slice(0, 600)
        : `(unavailable — raw: ${JSON.stringify(gexRaw?.levels || gexRaw, null, 2).slice(0, 300)})`);
      const spot = gex?.underlying?.price;
      const flip = gex?.levels?.gammaFlipLevel ?? gex?.levels?.flipLevel;
      const regime = deriveGexRegime(gex);
      console.log(`\n=== ${testTicker} regime (deterministic) ===`);
      console.log(`spot=${spot ?? '—'}  flip=${flip ?? '—'}  →  regimeAboveFlip(raw)=${gex?.levels?.regimeAboveFlip ?? '—'}  derived=${regime ?? 'unavailable'}`);
      console.log('\n=== Verdict ===');
      console.log(`VERDICT: ${verdict.verdict}`);
      for (let i = 1; i <= 6; i++) {
        const g = `gate${i}`;
        const v = verdict.gates[g];
        const soft = v === 'unavailable' || v === 'neutral';
        const mark = v === true ? '✅' : soft ? '⚠️ ' : '❌';
        console.log(`  ${mark} ${g}${soft ? ` (${v})` : ''}`);
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
      const [sig, gexRaw] = await Promise.all([getSignal(testTicker), getGex(testTicker)]);
      const gex = sanitizeGex(gexRaw, testTicker);
      const verdict = computeVerdict(sig, gex);
      console.log(`Verdict: ${verdict.verdict}  (gate5=${verdict.gates.gate5})`);
      const card = buildCallCard(testTicker, sig, gex, verdict, { isPreview: true });
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
  runOneShot('Hourly scan', runHourlyScan, dryRun);
} else if (cliArgs.includes('--digest-now')) {
  runOneShot('Nightly digest', runNightlyDigest, dryRun);
} else if (cliArgs.includes('--premarket-now')) {
  runOneShot('Pre-market brief', runPremarketBrief, dryRun);
} else if (cliArgs.includes('--post-macro-now')) {
  // Build the macro outlook and post it to #macro (or preview with --dry-run).
  validateEnv();
  console.log(`\n[${ts()}] Macro outlook${dryRun ? '  [DRY-RUN — no Discord posts]' : ' → #macro'}\n`);
  (async () => {
    try {
      await runMacroOutlook({ dryRun });
      console.log(`\n[${ts()}] ✓ Macro outlook complete.${dryRun ? ' (dry-run — nothing posted)' : ' Check #macro.'}\n`);
      process.exit(0);
    } catch (err) {
      console.error(`\n[${ts()}] ❌ Macro outlook failed: ${err.message}\n`);
      process.exit(1);
    }
  })();
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
    console.error('                --digest-now, --premarket-now, --post-macro-now, --backtest');
    console.error('   Tip: add --dry-run to any action flag to preview without posting.\n');
    process.exit(1);
  }
  // Normal run — start scheduled bot
  startup().catch(err => {
    logErr(`Fatal startup error: ${err.message}`);
    process.exit(1);
  });
}
