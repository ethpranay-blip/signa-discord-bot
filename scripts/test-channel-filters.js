// test-channel-filters.js
// Verification (c): side-by-side top-5 for #signals / #micro / #macro using the
// FINAL filter set. Runs all three in ONE process so #micro/#macro reuse
// #signals' warm cache (the in-memory cache cannot persist across separate CLI
// runs). Captures picks via stubbed post/track — nothing is sent to Discord or
// written to JSONL. Run: node scripts/test-channel-filters.js

import 'dotenv/config';
import { getSignal } from '../signa-client.js';
import { signalCache } from '../lib/channels/signal-cache.js';
import { runSignalsCycle } from '../lib/channels/signals-handler.js';
import { runMicroCycle } from '../lib/channels/micro-handler.js';
import { runMacroCycle } from '../lib/channels/macro-handler.js';

const picks = { signals: [], micro: [], macro: [] };
function ctxFor(channel) {
  return {
    getSignal,
    log: () => {},
    channelsEnabled: true, // exercises post+track path, both stubbed below
    post: async () => {},
    track: async (row) => {
      if (row.type === 'call') picks[channel].push(row);
    },
  };
}

await runSignalsCycle(ctxFor('signals')); // cold: fetches 50
await runMicroCycle(ctxFor('micro'));     // warm: 0 calls
await runMacroCycle(ctxFor('macro'));     // warm: 0 calls

const row = (p) => p ? `${p.ticker.padEnd(6)} ${String(p.grade).padEnd(3)} ${String(p.direction).padEnd(7)} conv=${p.conviction}` : '—';
console.log('\nFINAL FILTER SET — top-5 side by side\n');
console.log('  #signals (conv≥65, grade≥B+)        | #micro (conv≥55, grade≥B)          | #macro (conv≥70, grade≥A, stage)');
console.log('  ' + '-'.repeat(36) + '|' + '-'.repeat(36) + '|' + '-'.repeat(34));
for (let i = 0; i < 5; i++) {
  const s = row(picks.signals[i]).padEnd(34);
  const m = row(picks.micro[i]).padEnd(34);
  const k = row(picks.macro[i]);
  console.log(`  ${s} | ${m} | ${k}`);
}

const sSet = new Set(picks.signals.map((p) => p.ticker));
const mSet = new Set(picks.micro.map((p) => p.ticker));
const identical = picks.signals.length === picks.micro.length && [...sSet].every((t) => mSet.has(t));
console.log(`\n  cache: ${JSON.stringify(signalCache.stats())}`);
console.log(`  #signals vs #micro: ${identical ? 'IDENTICAL ❌' : 'DIFFERENT ✅'}  (signals=${[...sSet].join(',')} | micro=${[...mSet].join(',')})`);
console.log(`  #micro-only names: ${[...mSet].filter((t) => !sSet.has(t)).join(',') || '(none)'}`);
process.exit(0);
