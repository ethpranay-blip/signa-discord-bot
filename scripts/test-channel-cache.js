// test-channel-cache.js
// In-process verification for the Phase 2.5 shared signal cache + channel filters.
// The cache is in-memory per-process, so two separate `node bot.js` CLI runs
// CANNOT share it (each is a fresh process). This harness runs the cycles in ONE
// process — mirroring the long-running cron bot — to exercise cache reuse.
//
// Read-only re: Discord/JSONL (channelsEnabled:false → stdout, no posts/writes).
// Run: node scripts/test-channel-cache.js

import 'dotenv/config';
import { getSignal } from '../signa-client.js';
import { signalCache } from '../lib/channels/signal-cache.js';
import { runSignalsCycle } from '../lib/channels/signals-handler.js';
import { runMicroCycle } from '../lib/channels/micro-handler.js';
import { runMacroCycle } from '../lib/channels/macro-handler.js';

const ctx = {
  getSignal,
  post: async () => {},
  track: async () => {},
  log: (...a) => console.log(...a),
  channelsEnabled: false, // stdout only, no JSONL
  // checkQuota intentionally omitted for a clean cache count
};

function delta(before, after) {
  return `Δhits=${after.hits - before.hits} Δmisses=${after.misses - before.misses}`;
}

console.log('\n================ RUN 1 — #signals (cold cache) ================');
let s0 = signalCache.stats();
await runSignalsCycle(ctx);
let s1 = signalCache.stats();
console.log('cache.stats():', s1, '|', delta(s0, s1));

// (d) Stage field discovery on a sample cached signal.
const sample = signalCache.get('AAPL') || signalCache.get('SPY');
if (sample) {
  const sg = sample.signa || {};
  console.log('\n[stage-field discovery] signa.wyckoffStage =', sg.wyckoffStage,
    '· signa.weinsteinStage =', sg.weinsteinStage,
    '· data.stage =', sample.data?.stage, '·', sample.data?.stageDescription);
}

console.log('\n================ RUN 2 — #signals (warm, within TTL) ================');
s0 = signalCache.stats();
await runSignalsCycle(ctx);
s1 = signalCache.stats();
console.log('cache.stats():', s1, '|', delta(s0, s1), '  (expect Δmisses=0, all hits)');

console.log('\n================ RUN 3 — #micro (cross-channel reuse) ================');
s0 = signalCache.stats();
await runMicroCycle(ctx);
s1 = signalCache.stats();
console.log('cache.stats():', s1, '|', delta(s0, s1), '  (expect Δmisses=0 — micro shares signals universe)');

console.log('\n================ RUN 4 — #macro (cross-channel reuse; data.stage filter) ================');
s0 = signalCache.stats();
await runMacroCycle(ctx);
s1 = signalCache.stats();
console.log('cache.stats():', s1, '|', delta(s0, s1), '  (expect Δmisses=0 — macro universe ⊂ signals)');

process.exit(0);
