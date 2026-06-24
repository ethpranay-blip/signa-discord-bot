// test-universe-loader.js
// Dry-run for lib/universe-loader.js — prints counts, asset_class breakdown,
// ticker lists for each exported view, and the rows the Signa filter skips.
// Read-only. Run: node scripts/test-universe-loader.js

import {
  getSupportedUniverse,
  getSkippedUniverse,
  getSignalsUniverse,
  getMicroUniverse,
  getMacroUniverse,
  SIGNA_SUPPORTED_CLASSES,
} from '../lib/universe-loader.js';

function breakdown(rows) {
  const by = {};
  for (const r of rows) by[r.asset_class] = (by[r.asset_class] || 0) + 1;
  return by;
}

function show(label, rows) {
  console.log(`\n=== ${label} (${rows.length}) ===`);
  console.log('  by asset_class:', breakdown(rows));
  console.log('  tickers:', rows.map((r) => r.ticker).join(', '));
}

console.log('SIGNA_SUPPORTED_CLASSES:', [...SIGNA_SUPPORTED_CLASSES].join(', '));

const supported = getSupportedUniverse();
const skipped = getSkippedUniverse();

show('Supported universe (Signa-servable)', supported);
show('getSignalsUniverse()', getSignalsUniverse());
show('getMicroUniverse()', getMicroUniverse());
show('getMacroUniverse()', getMacroUniverse());

console.log(`\n=== Skipped by Signa filter (${skipped.length}) ===`);
const skipBy = {};
for (const r of skipped) {
  const k = r.skip_reason;
  (skipBy[k] = skipBy[k] || []).push(r.ticker);
}
for (const [reason, tickers] of Object.entries(skipBy)) {
  console.log(`  ${reason}: ${tickers.join(', ')}`);
}
