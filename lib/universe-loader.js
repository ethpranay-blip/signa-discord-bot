// universe-loader.js
// -----------------------------------------------------------------------------
// Loads the Tradeable Universe from the in-repo JSON snapshot and exposes
// filtered views for the Signa-driven channel feeds.
//
// The universe is baked into the repo at lib/data/universe.json so the bot has
// zero external-file dependency at runtime (Railway never sees the xlsx). The
// xlsx (paper-trading/signa_tracker.xlsx) remains the human-editable source of
// truth; regenerate the JSON with `node scripts/regen-universe.js` after edits.
//
// Recon (SIGNA_API_RECON.md, Steps A / A.5) established which asset classes the
// Signa API actually serves with usable data:
//   - crypto_perp     ✅  /signal returns engine + trade levels (BTC verified)
//   - tokenized_equity✅  /signal returns engine + trade levels (AAPL verified)
//   - etf             ✅  /signal returns engine + trade levels (SPY verified;
//                          GLD/SLV/USO/CPER/URA confirmed in Step A.5 retest)
//   - index           ❌  NDX misresolves (price 23.4), SPX has engine-only and
//                          no trade levels/price → not actionable, skipped
//   - commodity       ❌  the xlsx ships non-standard symbols (XAU/XAG/COPPER/
//                          WTI) that misresolve (XAU=$16, not spot gold). The
//                          tradeable substitutes (GLD/SLV/USO/CPER) are ETFs and
//                          belong under asset_class='etf', not 'commodity'.
//                          Until the xlsx is updated, commodity rows are skipped.
//
// This module only READS the snapshot. It does not mutate it. Substitution of
// commodity symbols is a user decision (see "Recommended Universe changes").
// -----------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// In-repo universe snapshot. Resolved relative to this module so it works
// identically on Mac (local dev) and Railway (production deploy).
const UNIVERSE_JSON_PATH = path.join(__dirname, 'data', 'universe.json');

// Asset classes the Signa API serves with usable signal + trade-level data.
// Add 'index' here only if NDX/SPX start returning trade levels (they do not
// today). Add 'commodity' only if the xlsx commodity rows are migrated to the
// ETF proxies (GLD/SLV/USO/CPER) — at which point they should just be 'etf'.
const SIGNA_SUPPORTED_CLASSES = new Set([
  'crypto_perp',
  'tokenized_equity',
  'etf',
]);

// Individual tickers to drop regardless of class (e.g. confirmed bad
// resolution). Empty today — the class filter already removes the broken
// index/commodity symbols. Adjust here if a specific supported-class symbol is
// found to misresolve.
const SKIP_TICKERS = new Set([]);

// Truthy coercion. The JSON snapshot already stores literal booleans, but stay
// defensive against a hand-edited file using yes/no/1/0/"TRUE".
function toBool(v) {
  if (v === true) return true;
  if (v === false || v === null || v === undefined) return false;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === 'y' || s === '1';
}

// In-memory cache — parse once, reuse for the life of the process.
let _cache = null;

function loadUniverse() {
  if (_cache) return _cache;

  let raw;
  try {
    raw = fs.readFileSync(UNIVERSE_JSON_PATH, 'utf8');
  } catch (err) {
    throw new Error(
      `universe-loader: could not read ${UNIVERSE_JSON_PATH}: ${err.message}. ` +
        `Regenerate it with \`node scripts/regen-universe.js\`.`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `universe-loader: ${UNIVERSE_JSON_PATH} is not valid JSON: ${err.message}`
    );
  }

  const rows = Array.isArray(parsed.tickers) ? parsed.tickers : [];

  const all = rows
    .filter((r) => r.ticker != null && String(r.ticker).trim() !== '')
    .map((r) => ({
      ticker: String(r.ticker).trim().toUpperCase(),
      asset_class: r.asset_class ? String(r.asset_class).trim() : null,
      exchanges: r.exchanges ?? null,
      signals_eligible: toBool(r.signals_eligible),
      micro_eligible: toBool(r.micro_eligible),
      macro_eligible: toBool(r.macro_eligible),
    }));

  // Split into what Signa can actually serve vs. what we runtime-skip, so
  // callers/tests can introspect why a ticker was excluded.
  const supported = [];
  const skipped = [];
  for (const row of all) {
    if (SKIP_TICKERS.has(row.ticker)) {
      skipped.push({ ...row, skip_reason: 'SKIP_TICKERS' });
    } else if (!SIGNA_SUPPORTED_CLASSES.has(row.asset_class)) {
      skipped.push({
        ...row,
        skip_reason: `unsupported asset_class: ${row.asset_class}`,
      });
    } else {
      supported.push(row);
    }
  }

  _cache = { all, supported, skipped };

  // First-load diagnostic — visible in Railway startup logs for verification.
  const signalsN = supported.filter((r) => r.signals_eligible).length;
  const microN = supported.filter((r) => r.micro_eligible).length;
  const macroN = supported.filter((r) => r.macro_eligible).length;
  console.log(
    `📚 Universe loaded: ${supported.length} total, ${signalsN} signals, ` +
      `${microN} micro, ${macroN} macro`
  );

  return _cache;
}

// Force a re-read on next access (e.g. after the xlsx is updated). Mainly for
// tests / long-running processes; the channels themselves do not need this.
export function clearUniverseCache() {
  _cache = null;
}

// Full supported universe (any eligibility), Signa-servable classes only.
export function getSupportedUniverse() {
  return loadUniverse().supported;
}

// Rows excluded by the Signa-supported filter, with reasons.
export function getSkippedUniverse() {
  return loadUniverse().skipped;
}

// Signals channel: supported class AND signals_eligible.
export function getSignalsUniverse() {
  return loadUniverse().supported.filter((r) => r.signals_eligible);
}

// Micro channel: supported class AND micro_eligible.
export function getMicroUniverse() {
  return loadUniverse().supported.filter((r) => r.micro_eligible);
}

// Macro channel: supported class AND macro_eligible.
export function getMacroUniverse() {
  return loadUniverse().supported.filter((r) => r.macro_eligible);
}

export { SIGNA_SUPPORTED_CLASSES, SKIP_TICKERS, UNIVERSE_JSON_PATH };
