// channel-cycle.js
// Shared pipeline for the Signa-driven channels (#signals / #micro / #macro).
// One implementation, three thin config wrappers.
//
// Phase 2.5 rework: /api/v1/scan returns a non-deterministic ~20-symbol subset,
// so we no longer use it. Instead we enrich EVERY ticker in the channel's
// universe via /api/v1/signal (through a shared 30-min cache), apply a
// per-channel filter, rank survivors by conviction, and take the top 5.
//
// Dependency-injected (ctx) so this module never imports bot.js (avoids a
// circular import). ctx provides: getSignal, post, track, log, channelsEnabled,
// and (optionally) checkQuota.

import { buildCall, buildEmbed, renderText } from './basic-card-formatter.js';
import { signalCache } from './signal-cache.js';

const TOP_N = 5;
const TZ = 'America/New_York';

// "score" in the filter set == signa.conviction (confirmed). Per-channel floor
// is config.minScore. Other shared requirements: BULLISH/BEARISH direction,
// entry/stop/target present, ≥1 trigger.

// Grade ordering — higher rank = better. Used for ">= 'B'" style gates.
const GRADE_RANK = {
  'A+': 11, A: 10, 'A-': 9,
  'B+': 8, B: 7, 'B-': 6,
  'C+': 5, C: 4, 'C-': 3,
  D: 2, F: 1,
};
function gradeRank(g) {
  return GRADE_RANK[String(g || '').toUpperCase().trim()] ?? 0;
}

function nowStamps() {
  const d = new Date();
  return {
    iso: d.toISOString(),
    et: d.toLocaleString('en-US', { timeZone: TZ, hour12: false }) + ' ET',
    date: d.toLocaleDateString('en-CA', { timeZone: TZ }),
  };
}

function triggerNames(sig) {
  const arr = Array.isArray(sig?.signa?.triggers) ? sig.signa.triggers : [];
  return arr.map((t) => (typeof t === 'string' ? t : t?.name)).filter(Boolean);
}

// Surface-agreement gate (Option B from SIGNA_FIELD_AUDIT.md). /api/v1/signal
// carries two surfaces: engine (nightly consensus → engine.direction, the trade
// direction we use) and data (live single-pass → data.bias + the entry/stop/
// target levels). The levels are coherent with data.bias, so when engine and
// data disagree (or the live bias is neutral) the levels look "inverted" against
// engine.direction. Signa flags the disagreement explicitly in
// crossSurfaceConflict. We reject those rather than print a contradictory card.
export function surfacesAgree(signal) {
  const engineDir = signal?.engine?.direction;       // 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  const dataBias = signal?.data?.bias;               // 'bullish' | 'bearish' | 'neutral'
  const conflict = signal?.crossSurfaceConflict;     // string when surfaces disagree

  // Reject if Signa's explicit conflict field is populated.
  if (conflict && conflict.trim().length > 0) {
    return { ok: false, reason: 'surface_conflict', detail: conflict };
  }
  // Reject if engine has a direction but the live bias is neutral.
  if ((engineDir === 'BULLISH' || engineDir === 'BEARISH') && dataBias === 'neutral') {
    return { ok: false, reason: 'neutral_live_bias', detail: `engine=${engineDir} data.bias=${dataBias}` };
  }
  // Reject if the surfaces are outright opposite (defense in depth — Signa should
  // already have populated crossSurfaceConflict for these).
  if (engineDir === 'BULLISH' && dataBias === 'bearish') {
    return { ok: false, reason: 'surface_opposite', detail: 'engine=BULLISH data.bias=bearish' };
  }
  if (engineDir === 'BEARISH' && dataBias === 'bullish') {
    return { ok: false, reason: 'surface_opposite', detail: 'engine=BEARISH data.bias=bullish' };
  }
  return { ok: true };
}

// Levels/direction coherence guard — DEFENSE IN DEPTH. With surfacesAgree() above
// gating on Signa's own crossSurfaceConflict/data.bias, this should be unreachable
// in normal operation (its counter `coh` is expected to stay 0). It catches any
// future Signa response shapes we haven't anticipated — e.g. levels whose geometry
// contradicts the stated direction even though the surfaces nominally agree. If
// `coh` ever goes >0 in production, that's a signal to investigate.
function levelsCoherent(direction, entry, stop, target) {
  const e = Number(entry), s = Number(stop), t = Number(target);
  if (!Number.isFinite(e) || !Number.isFinite(s) || !Number.isFinite(t)) return false;
  if (direction === 'BULLISH') return s < e && t > e; // long: stop below, target above
  if (direction === 'BEARISH') return s > e && t < e; // short: stop above, target below
  return false;                                        // unknown direction → reject
}

// Stage alignment (macro only). Uses data.stage (Weinstein stage 1-4) which IS
// present on /api/v1/signal: BULLISH must be stage 2 (advancing/markup),
// BEARISH must be stage 4 (declining/markdown). (signa.wyckoffStage /
// signa.weinsteinStage do not exist on the response — recon-confirmed — so we
// read the live data.stage instead.) Returns { pass, degraded }; degraded=true
// only if data.stage is absent, in which case we accept by fallback + warn.
function stageAligns(sig) {
  const dir = String(sig?.engine?.direction || '').toUpperCase();
  const stage = Number(sig?.data?.stage);
  if (Number.isFinite(stage)) {
    if (dir === 'BULLISH') return { pass: stage === 2, degraded: false };
    if (dir === 'BEARISH') return { pass: stage === 4, degraded: false };
    return { pass: false, degraded: false };
  }
  return { pass: true, degraded: true }; // no stage data → accept by fallback
}

// Evaluate one signal against shared + per-channel checks. Returns the
// individual booleans (for audit counters) plus an overall `pass`.
function evaluate(sig, config) {
  const eng = sig?.engine || {};
  const signa = sig?.signa || {};
  const data = sig?.data || {};

  const dir = String(eng.direction || '').toUpperCase();
  let stageDegraded = false;
  let stagePass = true;
  if (config.stageAlign) {
    const r = stageAligns(sig);
    stagePass = r.pass;
    stageDegraded = r.degraded;
  }
  const sa = surfacesAgree(sig);

  const checks = {
    direction: dir === 'BULLISH' || dir === 'BEARISH',
    conviction: Number(signa.conviction) >= config.minScore,
    grade: gradeRank(signa.grade) >= gradeRank(config.minGrade),
    triggers: triggerNames(sig).length >= 1,
    rr: Number(data.rr) >= config.minRR,
    surface: sa.ok, // Option B: engine/data surface agreement (before levels)
    levels: data.entry != null && data.stop != null && data.target != null,
    coherence: levelsCoherent(dir, data.entry, data.stop, data.target), // defense in depth
    stage: stagePass,
  };
  checks.pass = Object.values(checks).every(Boolean);
  checks._stageDegraded = stageDegraded;
  checks._surfaceReason = sa.ok ? null : sa.reason;
  checks._surfaceDetail = sa.ok ? null : sa.detail;
  return checks;
}

export async function runChannelCycle(config, ctx) {
  const { channel, getUniverse } = config;
  const { getSignal, post, track, log, channelsEnabled, checkQuota } = ctx;
  const stamp = nowStamps();
  const liveTag = channelsEnabled ? 'LIVE' : 'DRY (stdout only, no JSONL)';

  log('───────────────────────────────────');
  log(`📡 #${channel} cycle starting [${liveTag}]`);

  // 5. Daily quota gate — skip (don't crash) if at limit.
  if (typeof checkQuota === 'function') {
    let ok = true;
    try { ok = await checkQuota(); } catch (e) { log(`   ⚠️  quota check error: ${e.message} — proceeding`); }
    if (!ok) {
      log(`   ⛔ quota gate: skipping #${channel} cycle (at/over daily limit)`);
      return { channel, skipped: 'quota', calls_posted: 0 };
    }
  }

  const universe = getUniverse();
  log(`   universe: ${universe.length} tickers`);
  if (universe.length === 0) {
    log('   ⏭️  empty universe — nothing to do');
    return { channel, universe_size: 0, passing_count: 0, top5_count: 0, calls_posted: 0 };
  }

  // 1-2. Enrich every ticker via cache-or-fetch.
  const enriched = [];
  let apiCalls = 0;
  for (const u of universe) {
    const ticker = String(u.ticker).toUpperCase();
    let sig;
    if (signalCache.fresh(ticker)) {
      sig = signalCache.get(ticker);
      signalCache.hit();
    } else {
      try {
        sig = await getSignal(ticker);
        signalCache.set(ticker, sig);
        signalCache.miss();
        apiCalls++;
      } catch (err) {
        log(`   ⚠️  enrich failed for ${ticker}: ${err.message} — skipping`);
        continue;
      }
    }
    enriched.push({ ticker, asset_class: u.asset_class, sig });
  }

  // 3. Filter + per-check audit counters. dir/conv/.../stage are PASS counts;
  //    rej.* are REJECTION counts (surface-agreement reasons + the coh safety net).
  const counts = { direction: 0, conviction: 0, grade: 0, triggers: 0, rr: 0, levels: 0, stage: 0 };
  const rej = { sc: 0, nb: 0, so: 0, coh: 0 };
  let stageDegraded = 0;
  const passing = [];
  for (const e of enriched) {
    const c = evaluate(e.sig, config);
    for (const k of Object.keys(counts)) if (c[k]) counts[k]++;
    if (c._stageDegraded) stageDegraded++;

    // Surface-agreement rejections (Option B) — log reason + detail per ticker.
    if (!c.surface) {
      if (c._surfaceReason === 'surface_conflict') rej.sc++;
      else if (c._surfaceReason === 'neutral_live_bias') rej.nb++;
      else if (c._surfaceReason === 'surface_opposite') rej.so++;
      log(`   ⚠️  Surface mismatch rejected ${e.ticker}: ${c._surfaceReason} — ${c._surfaceDetail}`);
    }

    // Defense in depth: surfaces agreed but geometry still contradicts direction.
    // Expected unreachable (coh stays 0). If it fires, Signa returned a shape we
    // haven't anticipated — investigate.
    if (c.surface && c.direction && c.levels && !c.coherence) {
      rej.coh++;
      const d = e.sig?.data || {};
      const dir = String(e.sig?.engine?.direction || '').toUpperCase();
      log(`   ⚠️  Coherence guard (defense-in-depth) rejected ${e.ticker}: ${dir} but stop=${d.stop} entry=${d.entry} target=${d.target}`);
    }

    if (c.pass) passing.push(e);
  }
  if (config.stageAlign && stageDegraded > 0) {
    log(`   ⚠️  stage filter degraded for ${stageDegraded}/${enriched.length} tickers (no wyckoff/weinstein field, no "Stage N" trigger — accepted by fallback)`);
  }

  // Rank survivors by conviction desc, take top 5.
  passing.sort((a, b) => (Number(b.sig?.signa?.conviction) || 0) - (Number(a.sig?.signa?.conviction) || 0));
  const top = passing.slice(0, TOP_N);

  const cstats = signalCache.stats();
  log(`   cache: size=${cstats.size} hits=${cstats.hits} misses=${cstats.misses} oldestAge=${Math.round(cstats.oldestAge / 1000)}s · this cycle: ${apiCalls} API call(s)`);
  log(`   filter checks (passed/${enriched.length}): dir=${counts.direction} conv=${counts.conviction} grade=${counts.grade} trig=${counts.triggers} rr=${counts.rr} levels=${counts.levels} stage=${counts.stage} | rejects: sc=${rej.sc} nb=${rej.nb} so=${rej.so} coh=${rej.coh}`);
  log(`   → ${passing.length} passed all checks → top ${top.length}`);

  // 4. Empty cycle: no post, no "no calls" noise, but DO write a cycle summary.
  const cycleRow = {
    type: 'cycle',
    channel,
    cycle_id: stamp.iso,
    ts_et: stamp.et,
    date: stamp.date,
    universe_size: universe.length,
    passing_count: passing.length,
    top5_count: top.length,
    calls_posted: 0, // updated below
  };

  if (top.length === 0) {
    log(`   ⏭️  #${channel}: 0 passing tickers — skipping cycle (no post)`);
    if (channelsEnabled) await track(cycleRow);
    return cycleRow;
  }

  // Build + post + log each top pick.
  const calls = [];
  for (const e of top) {
    const call = buildCall({
      channel,
      pick: { symbol: e.ticker, score: e.sig?.engine?.score ?? e.sig?.signa?.conviction ?? null },
      sig: e.sig,
      asset_class: e.asset_class,
      tsEt: stamp.et,
      cycleISO: stamp.iso,
    });
    calls.push(call);

    if (channelsEnabled) {
      await post(channel, buildEmbed(call), `${channel}-${call.ticker}`);
      await track({
        type: 'call',
        channel,
        call_id: call.call_id,
        ts_et: call.ts_et,
        ticker: call.ticker,
        asset_class: call.asset_class,
        direction: call.direction,
        grade: call.grade,
        conviction: call.conviction,
        score: call.score,
        entry: call.entry,
        stop: call.stop,
        target: call.target,
        rr_card: call.rr_card,
        triggers: call.triggers,
      });
    } else {
      console.log(renderText(call));
    }
  }

  cycleRow.calls_posted = calls.length;
  if (channelsEnabled) await track(cycleRow);

  log(`   ✓ #${channel} cycle done — ${calls.length} card(s) ${channelsEnabled ? 'posted + logged' : 'previewed (stdout)'}`);
  return cycleRow;
}
