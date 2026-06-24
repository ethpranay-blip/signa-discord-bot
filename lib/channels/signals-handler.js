// signals-handler.js
// #signals channel — hourly at :02 during US market hours (9-16 ET). Enriches
// the full signals-eligible universe (50 tickers), filters, ranks by conviction,
// posts top 5.
//
// Filter: BULLISH/BEARISH · score (conviction) ≥ 65 · grade ≥ B+ · R:R ≥ 2.0 ·
// entry/stop/target present · ≥1 trigger.

import { getSignalsUniverse } from '../universe-loader.js';
import { runChannelCycle } from './channel-cycle.js';

export function runSignalsCycle(ctx) {
  return runChannelCycle(
    {
      channel: 'signals',
      getUniverse: getSignalsUniverse,
      minScore: 65,
      minGrade: 'B+',
      minRR: 2.0,
      stageAlign: false,
    },
    ctx
  );
}
