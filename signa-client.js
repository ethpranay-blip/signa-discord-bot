// ============================================================
// signa-client.js
// Thin wrapper around the Signa API (app.getsigna.ai).
// - Retry: 3 attempts, exponential backoff (1s/2s/4s) on 429 + 5xx
// - Rate-limit guard: sliding window, 100 req/min (well below 2000/min cap)
// - Auth: Authorization: Bearer ${SIGNA_API_KEY}
// - Run directly (`node signa-client.js`) to test every endpoint.
// ============================================================

import fetch from 'node-fetch';
import 'dotenv/config';

const BASE_URL = 'https://app.getsigna.ai';
const API_KEY = process.env.SIGNA_API_KEY;

// --- Sliding-window rate limit guard ---
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 100; // safety margin under the 2000/min Founding cap
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
      try {
        return await res.json();
      } catch (parseErr) {
        throw new Error(`Signa returned non-JSON for ${path}: ${parseErr.message}`);
      }
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

export async function getEnhancedSignal(ticker) {
  if (!ticker) throw new Error('getEnhancedSignal: ticker is required');
  return signaFetch(`/api/v1/enhanced-signal?sym=${encodeURIComponent(ticker)}`);
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

export async function getScoredSignals(limit = 200) {
  return signaFetch(`/api/signals/run?scored=true&limit=${limit}`);
}

export async function getSignalFeed(limit = 200) {
  return signaFetch(`/api/signals/feed?limit=${limit}`);
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

export async function getDarkPool(ticker = 'SPY', limit = 100) {
  return signaFetch(`/api/darkpool/prints?ticker=${encodeURIComponent(ticker)}&limit=${limit}`);
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

export async function getCalendar(weeks = 2) {
  return signaFetch(`/api/calendar?weeks=${weeks}`);
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

const MAX_BACKTEST_DAYS = 4 * 365 + 11 * 30; // ~4 years 11 months

export async function runBacktest({
  symbol,
  startDate,
  endDate,
  initialCapital = 100000,
  positionSize = 0.1,
  stopLoss = 0.05,
  takeProfit = 0.10,
  holdingPeriod = 30
} = {}) {
  if (!symbol) throw new Error('runBacktest: symbol is required');
  if (!startDate || !endDate) throw new Error('runBacktest: startDate and endDate are required (ISO YYYY-MM-DD)');

  // Defensive clamp on window length so we never trip the 5y cap.
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (isNaN(start) || isNaN(end)) {
    throw new Error('runBacktest: startDate/endDate must be valid YYYY-MM-DD');
  }
  const days = Math.round((end - start) / (1000 * 60 * 60 * 24));
  if (days > MAX_BACKTEST_DAYS) {
    const newStart = new Date(end.getTime() - MAX_BACKTEST_DAYS * 24 * 60 * 60 * 1000);
    startDate = newStart.toISOString().slice(0, 10);
  }
  if (days < 30) {
    throw new Error('runBacktest: window too short (need at least 30 days)');
  }

  // Validate position size + capital (Signa enforces these)
  if (positionSize <= 0 || positionSize > 1) {
    throw new Error('runBacktest: positionSize must be between 0 and 1');
  }
  if (initialCapital <= 0) {
    throw new Error('runBacktest: initialCapital must be a positive number');
  }

  const body = {
    symbol: String(symbol).toUpperCase(),
    startDate,
    endDate,
    initialCapital,
    positionSize,
    stopLoss,
    takeProfit,
    holdingPeriod
  };

  const raw = await signaFetch('/api/v1/backtest', {
    method: 'POST',
    body: JSON.stringify(body)
  });

  // Normalize response — Signa returns { ok, backtest: { config, summary, equity, trades, ... } }
  const bt = raw?.backtest || raw;
  if (!bt?.summary) {
    throw new Error('runBacktest: unexpected response shape — no summary field');
  }

  // Merge request params with response config — Signa drops some fields
  // (notably holdingPeriod) from the response, so we use what we sent
  // as the source of truth for display.
  const mergedConfig = { ...body, ...(bt.config || {}) };
  if (body.holdingPeriod != null) mergedConfig.holdingPeriod = body.holdingPeriod;

  return {
    config: mergedConfig,
    summary: bt.summary,
    equity: Array.isArray(bt.equity) ? bt.equity : [],
    trades: Array.isArray(bt.trades) ? bt.trades : [],
    monthlyReturns: Array.isArray(bt.monthlyReturns) ? bt.monthlyReturns : [],
    monteCarlo: bt.monteCarlo || null,
    raw
  };
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

  await check('getMe',                 () => getMe());
  await check('getSignalIndex',        () => getSignalIndex());
  await check('getSignal(NVDA)',       () => getSignal(TEST_TICKER));
  await check('getEnhancedSignal',     () => getEnhancedSignal(TEST_TICKER));
  await check('getAnalysis(NVDA)',     () => getAnalysis(TEST_TICKER));
  await check('getQuote(NVDA)',        () => getQuote(TEST_TICKER));
  await check('getHistory(NVDA)',      () => getHistory(TEST_TICKER));
  await check('scan(symbols=…)',       () => scan({ symbols: ['NVDA', 'AAPL', 'SPY'] }));
  await check('getScoredSignals',      () => getScoredSignals(10));
  await check('getSignalFeed',         () => getSignalFeed(10));
  await check('screenTickers([NVDA])', () => screenTickers(['NVDA', 'AAPL']));
  await check('getDarkPool(SPY)',      () => getDarkPool('SPY', 5));
  await check('getCalendar(1w)',       () => getCalendar(1));

  // /api/agents/run is session-authed only — not callable from a server bot.
  // Skipped in the test suite by design. See runAgent() for details.
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
