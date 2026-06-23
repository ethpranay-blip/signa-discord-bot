// ============================================================
// signa-client.js
// Thin wrapper around the Signa API (app.getsigna.ai).
// - Retry: 3 attempts, exponential backoff (1s/2s/4s) on 429 + 5xx
// - Rate-limit guard: sliding window, 58 req/hr (Founding plan: 60/hr · 1000/day)
// - Auth: Authorization: Bearer ${SIGNA_API_KEY}
// - Run directly (`node signa-client.js`) to test every endpoint.
// ============================================================

import fetch from 'node-fetch';
import 'dotenv/config';

const BASE_URL = 'https://app.getsigna.ai';
const API_KEY = process.env.SIGNA_API_KEY;

// --- Sliding-window rate limit guard (hourly budget) ---
const RATE_LIMIT_WINDOW_MS = 3_600_000; // 1 hour
const RATE_LIMIT_MAX = 58; // stay 2 under the 60/hr Founding plan limit
const _requestTimestamps = [];

async function rateLimitGuard() {
  const now = Date.now();
  while (_requestTimestamps.length > 0 && _requestTimestamps[0] < now - RATE_LIMIT_WINDOW_MS) {
    _requestTimestamps.shift();
  }
  if (_requestTimestamps.length >= RATE_LIMIT_MAX) {
    const waitMs = RATE_LIMIT_WINDOW_MS - (now - _requestTimestamps[0]) + 50;
    await new Promise(r => setTimeout(r, waitMs));
    return rateLimitGuard();
  }
  _requestTimestamps.push(Date.now());
}

function ts() {
  return new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour12: false
  }) + ' ET';
}

function buildQuery(params) {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (entries.length === 0) return '';
  return '?' + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

async function signaFetch(path, options = {}) {
  if (!API_KEY) {
    throw new Error('SIGNA_API_KEY is missing — set it in your .env file. Generate one at app.getsigna.ai/dashboard/api-keys');
  }

  const url = `${BASE_URL}${path}`;
  const headers = {
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    ...(options.headers || {})
  };

  const fetchOpts = {
    method: options.method || 'GET',
    headers,
    ...(options.body ? { body: options.body } : {})
  };

  const delays = [1000, 2000, 4000];
  let lastErr;

  for (let attempt = 0; attempt < 3; attempt++) {
    await rateLimitGuard();

    let res;
    try {
      res = await fetch(url, fetchOpts);
    } catch (networkErr) {
      lastErr = new Error(`Network error reaching Signa (${path}): ${networkErr.message}`);
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, delays[attempt]));
        continue;
      }
      throw lastErr;
    }

    if (res.ok) {
      let body;
      try {
        body = await res.json();
      } catch (parseErr) {
        throw new Error(`Signa returned non-JSON for ${path}: ${parseErr.message}`);
      }
      // Attach the upstream request id as a non-enumerable property so existing
      // callers see no behavior change but callers that need it (e.g. getGex
      // logging an implausible flip) can read body.__requestId.
      const reqId = res.headers.get('x-request-id')
                 || res.headers.get('x-amzn-trace-id')
                 || res.headers.get('request-id')
                 || null;
      if (reqId && body && typeof body === 'object') {
        try { Object.defineProperty(body, '__requestId', { value: reqId, enumerable: false }); }
        catch { /* frozen/sealed — ignore */ }
      }
      return body;
    }

    // Auth-style errors — never retry, give a precise message
    if (res.status === 401) {
      throw new Error('Signa API returned 401 — your API key may be expired or invalid. Generate a new one at app.getsigna.ai/dashboard/api-keys');
    }
    if (res.status === 403) {
      throw new Error(`Signa API returned 403 — endpoint ${path} requires a higher plan tier than your current account. Check your plan at app.getsigna.ai`);
    }
    if (res.status === 404) {
      throw new Error(`Signa API returned 404 — endpoint or resource not found: ${path}`);
    }

    // Retry: 429 + 5xx
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10) * 1000;
      const wait = retryAfter > 0 ? retryAfter : delays[attempt];
      lastErr = new Error(`Signa returned ${res.status} on ${path}`);
      if (attempt < 2) {
        console.log(`[${ts()}] ⚠️  Signa ${res.status} on ${path} — retrying in ${wait}ms (attempt ${attempt + 2}/3)`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
    }

    const body = await res.text().catch(() => '');
    throw new Error(`Signa API error ${res.status} on ${path}: ${body.slice(0, 300)}`);
  }

  throw lastErr || new Error(`Signa fetch failed after 3 attempts: ${path}`);
}

// ============================================================
// Public v1 endpoints (Bearer-authed)
// ============================================================

export async function getMe() {
  return signaFetch('/api/v1/me');
}

// getSignalIndex — Signa's response uses different field names than originally
// documented. We normalize to a stable shape so the rest of the bot doesn't care.
//
// Stable output shape:
//   { score, regime, sentiment, bull_bias, total_signals,
//     bullish_count, bearish_count, neutral_count,
//     avg_confidence, top_signals, generated_at, raw }
export async function getSignalIndex() {
  const raw = await signaFetch('/api/v1/signal-index');

  // Sentiment ("greed"/"fear"/"neutral") → regime mapping.
  // Greed = market leaning bullish = RISK_ON
  // Fear  = market leaning bearish = RISK_OFF
  // Neutral / mixed = TRANSITIONAL
  const sentimentToRegime = (s) => {
    const v = String(s || '').toLowerCase();
    if (v === 'greed' || v === 'extreme_greed' || v === 'risk_on')  return 'RISK_ON';
    if (v === 'fear'  || v === 'extreme_fear'  || v === 'risk_off') return 'RISK_OFF';
    return 'TRANSITIONAL';
  };

  // Field accessors that handle both the original spec shape AND the actual shape.
  const score        = raw?.score        ?? raw?.value;
  const sentiment    = raw?.sentiment    ?? raw?.regime;
  const regime       = raw?.regime       ?? sentimentToRegime(raw?.sentiment);
  const components   = raw?.components   ?? {};
  const totalSignals = raw?.total_signals ?? raw?.coveredCount ?? raw?.symbolCount;
  const bullishPct   = components.bullish ?? raw?.bull_bias_pct;
  const bearishPct   = components.bearish ?? raw?.bear_bias_pct;
  const neutralPct   = components.neutral;

  // bull_bias as a 0-1 fraction, derived if needed
  let bullBias = raw?.bull_bias;
  if (bullBias == null && bullishPct != null) {
    bullBias = bullishPct > 1 ? bullishPct / 100 : bullishPct;
  }

  // Counts from percentages × covered count (only meaningful if both exist)
  const cov = totalSignals;
  const bullishCount = raw?.bullish_count
    ?? (bullishPct != null && cov ? Math.round((bullishPct / 100) * cov) : null);
  const bearishCount = raw?.bearish_count
    ?? (bearishPct != null && cov ? Math.round((bearishPct / 100) * cov) : null);
  const neutralCount = raw?.neutral_count
    ?? (neutralPct != null && cov ? Math.round((neutralPct / 100) * cov) : null);

  return {
    score,
    regime,
    sentiment,
    bull_bias: bullBias,
    total_signals: totalSignals,
    bullish_count: bullishCount,
    bearish_count: bearishCount,
    neutral_count: neutralCount,
    avg_confidence: components.avgConfidence,
    avg_score: components.avgScore,
    grade_a_count: components.gradeA,
    grade_b_count: components.gradeB,
    top_signals: Array.isArray(raw?.topSignals) ? raw.topSignals : [],
    universe: raw?.universe,
    generated_at: raw?.meta?.generated_at || raw?.timestamp,
    raw // pass-through in case downstream needs the original
  };
}

export async function getSignal(ticker) {
  if (!ticker) throw new Error('getSignal: ticker is required');
  return signaFetch(`/api/v1/signal?sym=${encodeURIComponent(ticker)}`);
}

export async function getGex(symbol) {
  if (!symbol) throw new Error('getGex: symbol is required');
  return signaFetch(`/api/v1/gex/${encodeURIComponent(String(symbol).toUpperCase())}`);
}

// isGexPlausible — guard against corrupted /gex responses where the
// gamma flip level disagrees wildly with the call/put walls (Signa has
// returned e.g. SPY flip=565 while callWall=753, putWall=750, spot~751).
//
// Rule: flip must sit roughly between putWall × 0.9 and callWall × 1.1.
// If either wall is missing or non-positive, treat as implausible.
// Returns true only when all three values exist, are finite, and the
// flip is within the plausibility band.
export function isGexPlausible(gexData) {
  const levels = gexData?.levels ?? gexData ?? {};
  const flip     = Number(levels.gammaFlipLevel ?? levels.flipLevel);
  const callWall = Number(levels.callWall);
  const putWall  = Number(levels.putWall);
  if (!Number.isFinite(flip))     return false;
  if (!Number.isFinite(callWall) || callWall <= 0) return false;
  if (!Number.isFinite(putWall)  || putWall  <= 0) return false;
  const lo = Math.min(putWall, callWall) * 0.9;
  const hi = Math.max(putWall, callWall) * 1.1;
  return flip >= lo && flip <= hi;
}

// Hysteresis band (fraction of the flip level) within which spot is treated
// as sitting AT the flip — a neutral regime — rather than flipping the
// boolean. Tunable via GEX_FLIP_NEUTRAL_BAND_PCT (in percent, e.g. "0.15").
const _bandPct = Number(process.env.GEX_FLIP_NEUTRAL_BAND_PCT);
export const GEX_FLIP_NEUTRAL_BAND =
  (Number.isFinite(_bandPct) && _bandPct >= 0 ? _bandPct : 0.15) / 100;

// deriveGexRegime — deterministic gamma regime from a SINGLE /gex snapshot.
//
// Reads the spot (underlying.price) and flip (gammaFlipLevel) from the SAME
// response, so the result is a pure function of that one snapshot. This is
// the fix for the regime flicker: Signa's `levels.regimeAboveFlip` boolean is
// re-evaluated against a *live* spot at request time, so consecutive calls on
// otherwise-identical data return true/false/true when price hovers at the
// flip. Deriving from the snapshot's own spot removes that source mixing.
//
// A neutral band (GEX_FLIP_NEUTRAL_BAND) treats spot within ±band of the flip
// as 'AT_FLIP', so sub-point noise at the boundary settles on one stable
// state instead of oscillating the gate.
//
// Returns 'ABOVE' | 'BELOW' | 'AT_FLIP' | null  (null = insufficient data).
export function deriveGexRegime(gexData, band = GEX_FLIP_NEUTRAL_BAND) {
  const levels = gexData?.levels ?? {};
  const flip = Number(levels.gammaFlipLevel ?? levels.flipLevel);
  const spot = Number(gexData?.underlying?.price ?? gexData?.underlying?.regularClose);
  if (!Number.isFinite(flip) || flip <= 0) return null;
  if (!Number.isFinite(spot) || spot <= 0) return null;
  const delta = (spot - flip) / flip;
  if (Math.abs(delta) <= band) return 'AT_FLIP';
  return delta > 0 ? 'ABOVE' : 'BELOW';
}

export function getEnhancedSignal() {
  throw new Error('getEnhancedSignal: /api/v1/enhanced-signal is not available on the Founding plan — use getSignal() instead.');
}

export async function getAnalysis(ticker) {
  if (!ticker) throw new Error('getAnalysis: ticker is required');
  return signaFetch(`/api/v1/analysis?ticker=${encodeURIComponent(ticker)}`);
}

export async function getQuote(ticker) {
  if (!ticker) throw new Error('getQuote: ticker is required');
  return signaFetch(`/api/v1/quote/${encodeURIComponent(ticker)}`);
}

export async function getHistory(ticker) {
  if (!ticker) throw new Error('getHistory: ticker is required');
  return signaFetch(`/api/v1/history/${encodeURIComponent(ticker)}`);
}

// /api/v1/scan REQUIRES `symbols=` (comma-separated tickers).
// It evaluates the given list and returns: symbol, score, tier (HOT/WATCH/etc),
// bias (bullish/bearish), confidence, stage, triggers[], price, change24h, rsi.
// Optional filters: grade, direction, limit (server-side filtering of the list).
export async function scan(params = {}) {
  if (!params.symbols) {
    throw new Error('scan: symbols parameter is required (comma-separated tickers, or array)');
  }
  const symbols = Array.isArray(params.symbols)
    ? params.symbols.map(s => String(s).trim().toUpperCase()).filter(Boolean).join(',')
    : String(params.symbols).trim().toUpperCase();

  const allowed = ['grade', 'tier', 'direction', 'limit'];
  const filtered = { symbols };
  for (const k of allowed) if (params[k] !== undefined) filtered[k] = params[k];
  return signaFetch(`/api/v1/scan${buildQuery(filtered)}`);
}

// ============================================================
// Internal endpoints (same Bearer; same origin in browser)
// ============================================================

export function getScoredSignals() {
  throw new Error('getScoredSignals: /api/signals/run is not available on the Founding plan — use getSignal() per ticker instead.');
}

export function getSignalFeed() {
  throw new Error('getSignalFeed: /api/signals/feed is not available on the Founding plan — use getSignal() per ticker instead.');
}

// screenTickers — runs your watchlist through the Signa pipeline and returns
// a normalized result shape compatible with the original /api/screener output:
//   { results: [{ ticker, signal, grade, score, confidence, tier, reasons, ... }],
//     pipeline_count, local_count }
//
// Implementation note: /api/screener is session-authed only (rejects Bearer),
// so we route through /api/v1/scan?symbols=... which is fully Bearer-authed
// and returns equivalent (in fact richer) data.
export async function screenTickers(tickers = []) {
  if (!Array.isArray(tickers) || tickers.length === 0) {
    throw new Error('screenTickers: pass an array of at least one ticker');
  }
  const clean = tickers.map(t => String(t).trim().toUpperCase()).filter(Boolean).slice(0, 50);
  if (clean.length === 0) {
    throw new Error('screenTickers: no valid tickers after cleaning');
  }

  const raw = await signaFetch(`/api/v1/scan?symbols=${encodeURIComponent(clean.join(','))}`);

  // /api/v1/scan returns: { ok, results: [{symbol, score, tier, bias, confidence, stage, triggers, ...}], meta }
  // We normalize to the shape the rest of the bot expects.
  const items = Array.isArray(raw?.results) ? raw.results : [];

  // Map Signa "tier" labels (HOT/WATCH/etc.) to numeric tiers used by the bot.
  // HOT  → tier 3 if score ≥ 70 else tier 2
  // WATCH → tier 2 if score ≥ 55 else tier 1
  // anything else → tier 1
  const tierFromLabel = (label, score) => {
    const s = Number(score) || 0;
    const L = String(label || '').toUpperCase();
    if (L === 'HOT')   return s >= 70 ? 3 : 2;
    if (L === 'WATCH') return s >= 55 ? 2 : 1;
    return 1;
  };

  // Score → letter grade (A ≥ 70, B ≥ 55, C ≥ 40, D ≥ 25, F otherwise).
  const gradeFromScore = (score) => {
    const s = Number(score) || 0;
    if (s >= 70) return 'A';
    if (s >= 55) return 'B';
    if (s >= 40) return 'C';
    if (s >= 25) return 'D';
    return 'F';
  };

  const dirFromBias = (bias) => {
    const b = String(bias || '').toLowerCase();
    if (b.includes('bull')) return 'BULLISH';
    if (b.includes('bear')) return 'BEARISH';
    return 'NEUTRAL';
  };

  const found = new Set();
  const results = items.map(r => {
    const ticker = String(r.symbol || r.ticker || '').toUpperCase();
    if (ticker) found.add(ticker);
    return {
      ticker,
      signal: dirFromBias(r.bias),
      grade: gradeFromScore(r.score),
      score: r.score != null ? Math.round(Number(r.score)) : null,
      confidence: r.confidence != null ? Number(r.confidence) : null,
      total_agents: Array.isArray(r.triggers) ? r.triggers.length : null,
      tier: tierFromLabel(r.tier, r.score),
      reasons: Array.isArray(r.triggers) ? r.triggers.slice(0, 5) : [],
      run_at: raw?.meta?.generated_at || new Date().toISOString(),
      source: 'pipeline',
      // Pass-through extras that may be useful downstream
      price: r.price != null ? Number(r.price) : null,
      change24h: r.change24h != null ? Number(r.change24h) : null,
      rsi: r.rsi != null ? Number(r.rsi) : null,
      stage: r.stage != null ? Number(r.stage) : null
    };
  });

  // Tickers we asked about that didn't come back get a "no signal" stub so
  // the formatter can show them under "⚪ No Signal" the same way as before.
  for (const t of clean) {
    if (!found.has(t)) {
      results.push({
        ticker: t,
        signal: null,
        grade: null,
        score: null,
        confidence: null,
        total_agents: null,
        tier: null,
        reasons: [],
        run_at: null,
        source: 'local'
      });
    }
  }

  return {
    results,
    pipeline_count: results.filter(r => r.source === 'pipeline').length,
    local_count: results.filter(r => r.source === 'local').length
  };
}

export function getDarkPool() {
  throw new Error('getDarkPool: /api/darkpool/prints is not available on the Founding plan — flow data is in signa.flowScore from getSignal().');
}

// runAgent — NOT USED by any scheduled job in bot.js. Kept exported for future
// extension. /api/agents/run is session-authed only (rejects Bearer tokens),
// so calling it from the bot will fail with a clear message. To run a single
// agent on demand, do it from the browser while logged into app.getsigna.ai.
export async function runAgent(agentId, ticker = null) {
  if (!agentId) throw new Error('runAgent: agentId is required');
  throw new Error(
    'runAgent: /api/agents/run is session-authed only and cannot be called with a Bearer token. ' +
    'Run agents from the Signa dashboard while logged into app.getsigna.ai. ' +
    `(requested: agentId=${agentId}${ticker ? `, ticker=${ticker}` : ''})`
  );
}

export function getCalendar() {
  throw new Error('getCalendar: /api/calendar is not available on the Founding plan.');
}

// ============================================================
// runBacktest — POST /api/v1/backtest
//
// IMPORTANT: Despite documentation hints, this endpoint does NOT filter
// signals by agent — `agent`, `agentId`, `strategy`, `agents[]`, and
// `signalThreshold` are all silently ignored. The endpoint is a generic
// signal-driven trade simulator.
//
// To get real multi-trade results (not just buy-and-hold), you MUST
// pass `stopLoss`, `takeProfit`, and `holdingPeriod`. Otherwise the
// engine returns one buy-at-first-signal/exit-at-end-of-period trade,
// which produces meaningless win-rate/Sharpe/drawdown stats.
//
// Window cannot exceed 5 years. We cap at 4 years 11 months to be safe.
//
// Required Signa params:
//   - symbol         e.g. "NVDA"
//   - startDate      ISO date "YYYY-MM-DD"
//   - endDate        ISO date "YYYY-MM-DD"
//   - initialCapital positive number
//   - positionSize   number 0–1 (e.g. 0.1 = 10%)
//
// Recommended (or you get a single-trade result):
//   - stopLoss       e.g. 0.05 = 5% stop
//   - takeProfit     e.g. 0.10 = 10% target
//   - holdingPeriod  e.g. 30   = max 30-day hold
// ============================================================

export function runBacktest() {
  throw new Error('runBacktest: POST /api/v1/backtest is not available on the Founding plan.');
}

// ============================================================
// runTests — exercise every endpoint, log ✅/❌, return summary
// ============================================================

export async function runTests() {
  const results = [];
  const TEST_TICKER = 'NVDA';

  async function check(name, fn) {
    process.stdout.write(`[${ts()}] Testing ${name.padEnd(28)} ... `);
    const t0 = Date.now();
    try {
      const data = await fn();
      const ms = Date.now() - t0;
      console.log(`✅  ${ms}ms`);
      results.push({ name, ok: true, ms, sample: summarize(data) });
      return data;
    } catch (err) {
      console.log(`❌  ${err.message}`);
      results.push({ name, ok: false, error: err.message });
      return null;
    }
  }

  console.log(`\n=== Signa API Test Suite — ${ts()} ===\n`);

  // Documented Founding-plan endpoints
  await check('getMe',                 () => getMe());
  await check('getSignalIndex',        () => getSignalIndex());
  await check('getSignal(NVDA)',       () => getSignal(TEST_TICKER));
  await check('getGex(SPY)',           () => getGex('SPY'));
  await check('getAnalysis(NVDA)',     () => getAnalysis(TEST_TICKER));
  await check('getQuote(NVDA)',        () => getQuote(TEST_TICKER));
  await check('getHistory(NVDA)',      () => getHistory(TEST_TICKER));
  await check('scan(symbols=…)',       () => scan({ symbols: ['NVDA', 'AAPL', 'SPY'] }));
  await check('screenTickers([NVDA])', () => screenTickers(['NVDA', 'AAPL']));

  // Unavailable on Founding plan — stubs throw a clear error
  for (const name of ['getScoredSignals', 'getSignalFeed', 'getDarkPool', 'getCalendar', 'runBacktest', 'getEnhancedSignal']) {
    console.log(`[${ts()}] Skipped ${name.padEnd(20)} ... ⏭️   (not available on Founding plan)`);
  }

  // /api/agents/run is session-authed only — not callable from a server bot.
  console.log(`[${ts()}] Skipped runAgent             ... ⏭️   (session-only endpoint)`);

  const passed = results.filter(r => r.ok).length;
  const failed = results.length - passed;

  console.log(`\n=== Summary ===`);
  console.log(`Passed: ${passed}/${results.length}`);
  if (failed > 0) {
    console.log(`Failed: ${failed}`);
    for (const r of results.filter(r => !r.ok)) {
      console.log(`  ❌ ${r.name}: ${r.error}`);
    }
  } else {
    console.log(`All endpoints reachable — ready to run \`node bot.js\``);
  }
  console.log('');

  return { passed, failed, total: results.length, results };
}

function summarize(data) {
  if (data == null) return 'null';
  if (Array.isArray(data)) return `array(${data.length})`;
  if (typeof data !== 'object') return String(data).slice(0, 60);
  const keys = Object.keys(data);
  return `obj{${keys.slice(0, 5).join(',')}${keys.length > 5 ? ',…' : ''}}`;
}

// Run automatically when invoked directly: `node signa-client.js`
const isDirect = import.meta.url === `file://${process.argv[1]}`
  || process.argv[1]?.endsWith('signa-client.js');

if (isDirect) {
  runTests()
    .then(r => process.exit(r.failed > 0 ? 1 : 0))
    .catch(err => {
      console.error(`\n❌ Test runner crashed: ${err.message}\n`);
      process.exit(1);
    });
}
