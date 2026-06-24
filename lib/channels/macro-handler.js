// macro-handler.js
// #macro channel — twice daily at 09:15 ET and 21:15 ET. Enriches the
// macro-eligible universe (22 tickers: tokenized_equity + etf, no crypto),
// filters, ranks by conviction, posts top 5.
//
// Filter: BULLISH/BEARISH · score (conviction) ≥ 70 · grade ≥ A · R:R ≥ 2.0 ·
// entry/stop/target present · ≥1 trigger · stage alignment via data.stage
// (BULLISH→stage 2 / BEARISH→stage 4).

import { getMacroUniverse } from '../universe-loader.js';
import { runChannelCycle } from './channel-cycle.js';

export function runMacroCycle(ctx) {
  return runChannelCycle(
    {
      channel: 'macro',
      getUniverse: getMacroUniverse,
      minScore: 70,
      minGrade: 'A',
      minRR: 2.0,
      stageAlign: true,
    },
    ctx
  );
}
