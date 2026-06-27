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

// Levels/direction coherence guard. Rejects signals whose stop/target geometry
// contradicts the stated direction — Signa has returned BULLISH names with a
// stop ABOVE entry and a target BELOW it (AUDIT_2026-06-27 CF-1), which would
// post a "BUY" card telling users to set a stop above the entry. entry/stop/
// target must all be numeric and sit on the correct sides of entry.
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
  const checks = {
    direction: dir === 'BULLISH' || dir === 'BEARISH',
    coherence: levelsCoherent(dir, data.entry, data.stop, data.target),
    conviction: Number(signa.conviction) >= config.minScore,
    levels: data.entry != null && data.stop != null && data.target != null,
    triggers: triggerNames(sig).length >= 1,
    grade: gradeRank(signa.grade) >= gradeRank(config.minGrade),
    rr: Number(data.rr) >= config.minRR,
    stage: stagePass,
  };
  checks.pass = Object.values(checks).every(Boolean);
  checks._stageDegraded = stageDegraded;
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

  // 3. Filter + per-check audit counters.
  const counts = { direction: 0, coherence: 0, conviction: 0, levels: 0, triggers: 0, grade: 0, rr: 0, stage: 0 };
  let stageDegraded = 0;
  const passing = [];
  for (const e of enriched) {
    const c = evaluate(e.sig, config);
    for (const k of Object.keys(counts)) if (c[k]) counts[k]++;
    if (c._stageDegraded) stageDegraded++;
    // Coherence rejections get a per-ticker log so we can see how often Signa
    // returns direction/levels that contradict each other (only the "garbage"
    // case: direction valid + levels present, but geometry wrong).
    if (c.direction && c.levels && !c.coherence) {
      const d = e.sig?.data || {};
      const dir = String(e.sig?.engine?.direction || '').toUpperCase();
      log(`   ⚠️  Coherence guard rejected ${e.ticker}: ${dir} but stop=${d.stop} entry=${d.entry} target=${d.target}`);
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
  log(`   filter checks (passed/${enriched.length}): dir=${counts.direction} coh=${counts.coherence} conv=${counts.conviction} levels=${counts.levels} trig=${counts.triggers} grade=${counts.grade} rr=${counts.rr} stage=${counts.stage}`);
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
