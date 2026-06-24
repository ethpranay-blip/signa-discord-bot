// micro-handler.js
// #micro channel — hourly at :30 during US market hours (9-16 ET). Enriches the
// full micro-eligible universe (50 tickers), filters, ranks by conviction,
// posts top 5. Reuses #signals' cached signals when run within TTL.
//
// Filter: BULLISH/BEARISH · score (conviction) ≥ 55 · grade ≥ B · R:R ≥ 2.0 ·
// entry/stop/target present · ≥1 trigger. No stage filter.
// Differentiated from #signals by a lower score floor (55 vs 65) and a lower
// grade floor (B vs B+), so the two channels surface different names.

import { getMicroUniverse } from '../universe-loader.js';
import { runChannelCycle } from './channel-cycle.js';

export function runMicroCycle(ctx) {
  return runChannelCycle(
    {
      channel: 'micro',
      getUniverse: getMicroUniverse,
      minScore: 55,
      minGrade: 'B',
      minRR: 2.0,
      stageAlign: false,
    },
    ctx
  );
}
