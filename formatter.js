// ============================================================
// formatter.js
// Builds Discord webhook payloads (embed objects).
// All builders respect Discord limits:
//   - 6000 total chars across embeds in one message
//   - 25 fields per embed
//   - 4096 chars description, 1024 chars per field value
// Truncation is graceful — content is shortened, never dropped silently.
// ============================================================

// --- Visual constants ---
export const TIER_EMOJI  = { 1: '🔵', 2: '🟡', 3: '🔴' };
export const GRADE_EMOJI = { A: '🏆', B: '✅', C: '⚠️', D: '📉', F: '💀' };
export const DIR_EMOJI   = { BULLISH: '📈', BEARISH: '📉', NEUTRAL: '➡️', LONG: '📈', SHORT: '📉' };
export const REGIME_COLOR = { RISK_ON: 0x00FF88, TRANSITIONAL: 0xFFCC00, RISK_OFF: 0xFF4444 };
export const DIR_COLOR    = { BULLISH: 0x00FF88, BEARISH: 0xFF4444, NEUTRAL: 0xFFCC00, LONG: 0x00FF88, SHORT: 0xFF4444 };

const FOOTER = { text: 'Signa · getsigna.ai · Signals are observations, not instructions to trade' };

// ============================================================
// Helpers
// ============================================================

function trunc(str, max) {
  if (str == null) return '';
  const s = String(str);
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

function fmtPct(n, digits = 0) {
  if (n == null || isNaN(n)) return '—';
  const v = Math.abs(n) <= 1 ? n * 100 : n;
  return `${v.toFixed(digits)}%`;
}

function fmtMoney(n) {
  if (n == null || isNaN(n)) return '—';
  if (Math.abs(n) >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${Number(n).toFixed(2)}`;
}

function fmtPrice(n) {
  if (n == null || isNaN(n)) return null;
  return `$${Number(n).toFixed(2)}`;
}

function todayStr() {
  return new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', month: 'short', day: 'numeric'
  });
}

function nowET() {
  return new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour12: false
  }) + ' ET';
}

// Sort priority you specified throughout:
// Tier 3 first → Tier 2 BULLISH → Tier 2 BEARISH → Tier 1 Grade A → rest
function priorityScore(s) {
  const tier = Number(s.alert_tier ?? s.tier ?? 1);
  const dir = String(s.direction || s.signal || '').toUpperCase();
  const grade = String(s.grade || 'F').toUpperCase();
  const score = Number(s.composite_score ?? s.score ?? 0);

  if (tier === 3) return 1000 + score;
  if (tier === 2 && (dir === 'BULLISH' || dir === 'LONG')) return 800 + score;
  if (tier === 2 && (dir === 'BEARISH' || dir === 'SHORT')) return 600 + score;
  if (tier === 1 && grade === 'A') return 400 + score;
  return score;
}

export function sortByPriority(signals) {
  return [...signals].sort((a, b) => priorityScore(b) - priorityScore(a));
}

// Cap an embed at Discord limits.
function capEmbed(embed) {
  if (embed.title) embed.title = trunc(embed.title, 256);
  if (embed.description) embed.description = trunc(embed.description, 4096);
  if (embed.footer?.text) embed.footer.text = trunc(embed.footer.text, 2048);
  if (Array.isArray(embed.fields)) {
    embed.fields = embed.fields.slice(0, 25).map(f => ({
      name: trunc(f.name, 256),
      value: trunc(f.value || '\u200b', 1024),
      inline: !!f.inline
    }));
  }
  return embed;
}

// Total char budget across embeds = 6000. Trim if over.
function fitMessage(embeds) {
  let total = 0;
  const out = [];
  for (const e of embeds) {
    const capped = capEmbed({ ...e });
    const size = embedCharCount(capped);
    if (total + size > 5800) break; // leave headroom
    out.push(capped);
    total += size;
  }
  return out;
}

function embedCharCount(e) {
  let n = 0;
  if (e.title) n += e.title.length;
  if (e.description) n += e.description.length;
  if (e.footer?.text) n += e.footer.text.length;
  if (e.author?.name) n += e.author.name.length;
  if (Array.isArray(e.fields)) {
    for (const f of e.fields) n += (f.name?.length || 0) + (f.value?.length || 0);
  }
  return n;
}

// ============================================================
// 1) buildDailyDigest
// ============================================================

export function buildDailyDigest(signalIndex, scoredSignals, calendar, darkpoolData, watchlist) {
  const sorted = sortByPriority(scoredSignals || []);
  const bullish = sorted.filter(s => /BULL|LONG/i.test(s.direction || s.signal || ''));
  const bearish = sorted.filter(s => /BEAR|SHORT/i.test(s.direction || s.signal || ''));
  const tier3 = sorted.filter(s => Number(s.alert_tier ?? s.tier) === 3);

  const regime = signalIndex?.regime || 'TRANSITIONAL';
  const color = REGIME_COLOR[regime] ?? REGIME_COLOR.TRANSITIONAL;
  const idxScore = signalIndex?.score ?? '—';
  const sentiment = signalIndex?.sentiment ? String(signalIndex.sentiment).toLowerCase() : null;
  const total = signalIndex?.total_signals ?? sorted.length;
  const bullCount = signalIndex?.bullish_count ?? bullish.length;
  const bearCount = signalIndex?.bearish_count ?? bearish.length;
  const bullBias = signalIndex?.bull_bias != null ? fmtPct(signalIndex.bull_bias, 0) : '—';

  const regimeBadge = regime === 'RISK_ON' ? '🟢 RISK_ON'
                    : regime === 'RISK_OFF' ? '🔴 RISK_OFF'
                    : '🟡 TRANSITIONAL';

  // If the API gave us a sentiment label (greed/fear/neutral), include it.
  const sentimentLabel = sentiment
    ? ` _(${sentiment})_`
    : '';

  const description = [
    `**Regime:** ${regimeBadge}${sentimentLabel}   **Signal Index:** \`${idxScore}/100\`   **Bull Bias:** \`${bullBias}\``,
    `**Signals:** ${total}  ·  📈 ${bullCount} bullish  ·  📉 ${bearCount} bearish`,
    tier3.length > 0
      ? `\n🚨 **${tier3.length} TIER 3 high-conviction signal${tier3.length > 1 ? 's' : ''} detected** — see alerts channel.`
      : `\n_No Tier 3 signals tonight._`
  ].join('\n');

  const fields = [];

  // Top signals from the index endpoint (these are the conviction picks across
  // the whole 30+ model pipeline — worth surfacing even if they're not in
  // the scored array we got from /signals/run).
  const indexTop = (signalIndex?.top_signals || []).slice(0, 5);
  if (indexTop.length > 0) {
    fields.push({
      name: '⭐ Top Index Signals',
      value: indexTop.map(s => {
        const dir = String(s.direction || '').toUpperCase();
        const dEmoji = /BULL/.test(dir) ? '📈' : /BEAR/.test(dir) ? '📉' : '➡️';
        const grade = String(s.grade || '?').toUpperCase();
        const gEmoji = GRADE_EMOJI[grade] || '·';
        return `${dEmoji}${gEmoji} **${s.symbol}** \`${s.score}\` · ${grade} · ${dir}`;
      }).join('\n'),
      inline: false
    });
  }

  // Top BULLISH (tier 2+)
  const topBull = bullish.filter(s => Number(s.alert_tier ?? s.tier) >= 2).slice(0, 5);
  if (topBull.length > 0) {
    fields.push({
      name: '🟢 Top Buy Signals (Tier 2+)',
      value: topBull.map(s => formatSignalLine(s)).join('\n') || '_none_',
      inline: false
    });
  } else {
    fields.push({
      name: '🟢 Top Buy Signals (Tier 2+)',
      value: '_No Tier 2+ bullish signals tonight._',
      inline: false
    });
  }

  // Top BEARISH
  const topBear = bearish.slice(0, 3);
  if (topBear.length > 0) {
    fields.push({
      name: '🔴 Avoid / Bearish',
      value: topBear.map(s => formatSignalLine(s)).join('\n'),
      inline: false
    });
  }

  // Dark pool
  if (darkpoolData?.summary) {
    const s = darkpoolData.summary;
    const ticker = darkpoolData.prints?.[0]?.ticker || 'SPY';
    const aggColor = s.net_aggressor === 'BUY' ? '🟢' : s.net_aggressor === 'SELL' ? '🔴' : '⚪';
    fields.push({
      name: `🌊 Dark Pool (${ticker})`,
      value: [
        `Net aggressor: ${aggColor} **${s.net_aggressor || 'NEUTRAL'}**`,
        `Total premium: **${fmtMoney(s.total_premium)}**`,
        `Buy: ${fmtMoney(s.buy_premium)}  ·  Sell: ${fmtMoney(s.sell_premium)}`,
        `Blocks: \`${s.block_count ?? 0}\`  ·  Prints: \`${s.total ?? s.active ?? 0}\``
      ].join('\n'),
      inline: true
    });
  }

  // Earnings next 48h — prioritize watchlist hits, then biggest by EPS magnitude.
  if (calendar?.earnings?.length > 0) {
    const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const tomorrowET = new Date(Date.now() + 24 * 60 * 60 * 1000)
      .toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const dayAfterET = new Date(Date.now() + 48 * 60 * 60 * 1000)
      .toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    const window = new Set([todayET, tomorrowET, dayAfterET]);
    const upcoming = calendar.earnings.filter(e => window.has(e.date));

    const watchSet = new Set((watchlist || []).map(t => String(t).toUpperCase()));
    const watchHits = upcoming.filter(e => watchSet.has(e.ticker.toUpperCase()));
    const others = upcoming
      .filter(e => !watchSet.has(e.ticker.toUpperCase()))
      .sort((a, b) => Math.abs(Number(b.epsEstimate) || 0) - Math.abs(Number(a.epsEstimate) || 0));

    const display = [...watchHits, ...others].slice(0, 5);

    if (display.length > 0) {
      const moreCount = upcoming.length - display.length;
      fields.push({
        name: '📅 Earnings Next 48h',
        value: display.map(e => {
          const star = watchSet.has(e.ticker.toUpperCase()) ? '⭐ ' : '';
          const tag = e.time === 'pre-market' ? '🌅 pre' : e.time === 'post-market' ? '🌙 post' : '·';
          const eps = e.epsEstimate != null ? `EPS \`${Number(e.epsEstimate).toFixed(2)}\`` : '';
          return `${star}**${e.ticker}** ${tag} ${eps}`.trim();
        }).join('\n') + (moreCount > 0 ? `\n_+${moreCount} more_` : ''),
        inline: true
      });
    }
  }

  const embed = {
    title: `📊 Signa Daily Digest — ${todayStr()}`,
    description,
    color,
    fields,
    footer: FOOTER,
    timestamp: new Date().toISOString()
  };

  return { embeds: fitMessage([embed]) };
}

function formatSignalLine(s) {
  const tier = Number(s.alert_tier ?? s.tier ?? 1);
  const grade = String(s.grade || '?').toUpperCase();
  const score = s.composite_score ?? s.score ?? 0;
  const conf = s.confidence != null
    ? (s.confidence <= 1 ? Math.round(s.confidence * 100) : Math.round(s.confidence))
    : 0;
  const driver = s.key_drivers?.[0] || s.reasons?.[0] || s.reason || '';
  const tEmoji = TIER_EMOJI[tier] || '⚪';
  const gEmoji = GRADE_EMOJI[grade] || '·';
  return `${tEmoji}${gEmoji} **${s.ticker}**  \`${score}\` · ${conf}% conf — ${trunc(driver, 90)}`;
}

// ============================================================
// 2) buildTier3Alert — refined (Phase 2)
//
// Signature: buildTier3Alert(signals, opts?)
//
// signals: array of scored signals (from getScoredSignals())
// opts (all optional):
//   - signalFeed: array of raw signals (from getSignalFeed()) — used to find
//                 entry/stop/target levels from agreeing agents
//   - signalIndex: normalized signal index obj (from getSignalIndex()) — used
//                  for regime + sizing context
//   - actionCards: { TICKER: actionCardData } — pre-fetched Action Cards for
//                  finer grades (A+/B+/etc.). Async fetch happens in bot.js,
//                  this function is sync.
// ============================================================

// Convert a Signa regime string into a sizing recommendation.
// Mirrors Signa's published methodology: full size in RISK_ON, dampened
// in TRANSITIONAL, defensive in RISK_OFF.
function sizingForRegime(regime, direction) {
  const r = String(regime || '').toUpperCase();
  const dir = String(direction || '').toUpperCase();
  const isBull = /BULL|LONG/.test(dir);
  const isBear = /BEAR|SHORT/.test(dir);

  if (r === 'RISK_ON') {
    return {
      multiplier: 1.0,
      label: isBull ? 'Full size — regime favors bulls'
            : isBear ? '0.5× — regime headwind for shorts'
            : 'Full size'
    };
  }
  if (r === 'RISK_OFF') {
    return {
      multiplier: isBull ? 0.35 : isBear ? 1.0 : 0.5,
      label: isBull ? '0.35× — RISK_OFF dampens longs heavily; consider skipping'
            : isBear ? 'Full size — regime favors shorts'
            : '0.5× — defensive regime'
    };
  }
  // TRANSITIONAL or unknown
  return {
    multiplier: 0.65,
    label: '0.65× — TRANSITIONAL regime; require strong confluence'
  };
}

// Find the strongest agreeing agent in the signal feed for a given
// (ticker, direction) pair. Returns levels if any agent supplied them.
function findAgreeingAgents(signalFeed, ticker, direction) {
  if (!Array.isArray(signalFeed)) return [];
  const dir = String(direction || '').toUpperCase();
  const wantBull = /BULL|LONG|BUY/.test(dir);
  const wantBear = /BEAR|SHORT|SELL/.test(dir);

  return signalFeed
    .filter(s => String(s.ticker || '').toUpperCase() === String(ticker).toUpperCase())
    .filter(s => {
      const sig = String(s.signal || '').toUpperCase();
      if (wantBull) return /BULL|LONG|BUY/.test(sig);
      if (wantBear) return /BEAR|SHORT|SELL/.test(sig);
      return true;
    })
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0));
}

// Pick the best entry/stop/target across agreeing agents.
// Strategy: take the median of each level across all agents that supplied it,
// since different models may suggest slightly different levels.
function consensusLevels(agreeingAgents) {
  const median = (arr) => {
    const nums = arr.filter(x => x != null && !isNaN(Number(x))).map(Number).sort((a, b) => a - b);
    if (nums.length === 0) return null;
    const mid = Math.floor(nums.length / 2);
    return nums.length % 2 === 0 ? (nums[mid - 1] + nums[mid]) / 2 : nums[mid];
  };
  return {
    entry:  median(agreeingAgents.map(a => a.entry_price)),
    stop:   median(agreeingAgents.map(a => a.stop_level)),
    target: median(agreeingAgents.map(a => a.target_price))
  };
}

// Friendly model name from agent ID or model_name field.
function friendlyModelName(agent) {
  return agent.model_name || agent.modelName
    || (agent.model_id || agent.modelId || '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    || 'Unknown';
}

export function buildTier3Alert(signals, opts = {}) {
  const tier3 = (signals || []).filter(s => Number(s.alert_tier ?? s.tier) === 3);
  if (tier3.length === 0) return null;

  const signalFeed = opts.signalFeed || [];
  const signalIndex = opts.signalIndex || null;
  const actionCards = opts.actionCards || {};

  const sorted = sortByPriority(tier3).slice(0, 5);

  const embeds = sorted.map(s => {
    const ticker = String(s.ticker || '').toUpperCase();
    const dir = String(s.direction || s.signal || 'NEUTRAL').toUpperCase();
    // Prefer Action Card grade (e.g. "A+", "B-") over scored grade ("A").
    const acData = actionCards[ticker];
    const acGrade = acData
      ? String(acData.grade ?? acData.letter_grade ?? '').toUpperCase()
      : null;
    const grade = acGrade || String(s.grade || '?').toUpperCase();

    const score = s.composite_score ?? s.score ?? 0;
    const conf = s.confidence != null
      ? (s.confidence <= 1 ? Math.round(s.confidence * 100) : Math.round(s.confidence))
      : 0;
    const color = DIR_COLOR[dir] ?? DIR_COLOR.NEUTRAL;

    // Regime: use index regime if available, else per-signal regime
    const regime = signalIndex?.regime || s.regime || 'UNKNOWN';
    const sizing = sizingForRegime(regime, dir);

    // Find agreeing agents in raw feed for richer model attribution + levels
    const agreeing = findAgreeingAgents(signalFeed, ticker, dir);
    const topAgents = agreeing.slice(0, 3);
    const topModelStr = topAgents.length > 0
      ? topAgents
          .map(a => {
            const name = friendlyModelName(a);
            const c = a.confidence != null
              ? Math.round((a.confidence <= 1 ? a.confidence * 100 : a.confidence))
              : null;
            return c != null ? `${name} (${c})` : name;
          })
          .join(', ')
      : null;

    // Levels: prefer parent signal, fall back to feed consensus
    let entry  = s.entry_price;
    let stop   = s.stop_level;
    let target = s.target_price;
    if (entry == null && stop == null && target == null && agreeing.length > 0) {
      const lv = consensusLevels(agreeing);
      entry  = lv.entry;
      stop   = lv.stop;
      target = lv.target;
    }

    const descLines = [
      `**Score:** \`${score}/100\`   **Confidence:** \`${conf}%\`   **Grade:** ${GRADE_EMOJI[grade?.[0]] || ''} \`${grade}\``,
      `**Regime:** ${regime}  ·  **Sizing:** ${sizing.label}`,
      topModelStr
        ? `**${s.model_count ?? agreeing.length} models agreeing** — top: ${topModelStr}`
        : `**Models:** ${s.model_count ?? 0} agreeing${s.category_diversity ? ` · diversity ${s.category_diversity}` : ''}`
    ];
    if (s.conflict_detected) {
      descLines.push('⚠️  **Model conflict detected** — read drivers carefully.');
    }

    const fields = [];

    const drivers = (s.key_drivers || []).slice(0, 4);
    if (drivers.length > 0) {
      fields.push({
        name: 'Key Drivers',
        value: drivers.map((d, i) => `${i + 1}. ${trunc(d, 120)}`).join('\n'),
        inline: false
      });
    }

    if (s.risks?.length > 0) {
      fields.push({
        name: 'Risks',
        value: s.risks.slice(0, 3).map((r, i) => `${i + 1}. ${trunc(r, 120)}`).join('\n'),
        inline: false
      });
    }

    const posLines = [];
    if (entry  != null) posLines.push(`Entry \`${fmtPrice(entry)}\``);
    if (stop   != null) posLines.push(`Stop \`${fmtPrice(stop)}\``);
    if (target != null) posLines.push(`Target \`${fmtPrice(target)}\``);
    const finalSize = (s.suggested_size_pct != null && s.suggested_size_pct > 0)
      ? s.suggested_size_pct
      : Math.round(sizing.multiplier * 100);
    posLines.push(`Size \`${finalSize}%\``);
    fields.push({ name: 'Position', value: posLines.join('  ·  '), inline: false });

    return {
      title: `🔴 ${ticker} — ${dir} · Tier 3 · Grade ${grade}`,
      description: descLines.join('\n'),
      color,
      fields,
      footer: FOOTER,
      timestamp: s.generated_at || new Date().toISOString()
    };
  });

  return {
    content: '🚨 @here HIGH CONVICTION TIER 3 SIGNAL',
    embeds: fitMessage(embeds)
  };
}

// ============================================================
// 3) buildWatchlistSummary
// ============================================================

export function buildWatchlistSummary(screenerResults, watchlist) {
  if (!screenerResults?.results) return null;
  const scored = screenerResults.results.filter(r => r.signal && r.score != null);
  const noSignal = screenerResults.results.filter(r => !r.signal || r.score == null);

  if (scored.length === 0 && noSignal.length === 0) return null;

  const sorted = sortByPriority(scored);

  const lines = sorted.map(r => {
    const dir = String(r.signal || '').toUpperCase();
    const dEmoji = DIR_EMOJI[dir] || '·';
    const grade = String(r.grade || '?').toUpperCase();
    const gEmoji = GRADE_EMOJI[grade] || '·';
    const conf = r.confidence != null
      ? (r.confidence <= 1 ? Math.round(r.confidence * 100) : Math.round(r.confidence))
      : 0;
    return `${dEmoji}${gEmoji} \`${r.ticker.padEnd(6)}\` ${grade} · score \`${r.score}\` · ${conf}% conf`;
  });

  const fields = [];
  if (lines.length > 0) {
    // Cap lines to fit field
    let chunk = '';
    for (const ln of lines) {
      if ((chunk + '\n' + ln).length > 1000) break;
      chunk += (chunk ? '\n' : '') + ln;
    }
    fields.push({ name: `Scored (${sorted.length})`, value: chunk, inline: false });
  }

  if (noSignal.length > 0) {
    const tickers = noSignal.map(r => r.ticker).join(', ');
    fields.push({
      name: `⚪ No Signal (${noSignal.length})`,
      value: trunc(tickers, 1000),
      inline: false
    });
  }

  const embed = {
    title: `📋 Watchlist Scan — ${todayStr()}`,
    color: 0x00CCFF,
    description: `Scanned **${(watchlist || []).length}** tickers · ${scored.length} active · ${noSignal.length} dormant`,
    fields,
    footer: FOOTER,
    timestamp: new Date().toISOString()
  };

  return { embeds: fitMessage([embed]) };
}

// ============================================================
// 4) buildTickerAlert — single-stock deep-dive
// ============================================================

export function buildTickerAlert(ticker, signalData, enhancedData) {
  const data = enhancedData || signalData || {};
  const dir = String(
    data.direction || data.signal || data.action || 'NEUTRAL'
  ).toUpperCase();
  const grade = String(data.grade || '?').toUpperCase();
  const tier = Number(data.alert_tier ?? data.tier ?? 1);
  const score = data.composite_score ?? data.score ?? 0;
  const conf = data.confidence != null
    ? (data.confidence <= 1 ? Math.round(data.confidence * 100) : Math.round(data.confidence))
    : 0;
  const color = DIR_COLOR[dir] ?? DIR_COLOR.NEUTRAL;
  const dEmoji = DIR_EMOJI[dir] || '·';

  const descLines = [
    `**Grade:** ${GRADE_EMOJI[grade] || ''} \`${grade}\`   **Tier:** ${TIER_EMOJI[tier] || ''} \`${tier}\``,
    `**Score:** \`${score}/100\`   **Confidence:** \`${conf}%\``,
    data.regime ? `**Regime:** ${data.regime}` : null
  ].filter(Boolean);

  const posLines = [];
  if (data.entry_price != null) posLines.push(`Entry: \`${fmtPrice(data.entry_price)}\``);
  if (data.stop_level != null) posLines.push(`Stop: \`${fmtPrice(data.stop_level)}\``);
  if (data.target_price != null) posLines.push(`Target: \`${fmtPrice(data.target_price)}\``);

  const fields = [];
  if (posLines.length > 0) {
    fields.push({ name: 'Position', value: posLines.join('  ·  '), inline: false });
  }

  const drivers = data.key_drivers || data.reasons || [];
  if (drivers.length > 0) {
    fields.push({
      name: 'Key Drivers',
      value: drivers.slice(0, 5).map((d, i) => `${i + 1}. ${trunc(d, 150)}`).join('\n'),
      inline: false
    });
  }

  if (data.risks?.length > 0) {
    fields.push({
      name: 'Risks',
      value: data.risks.slice(0, 3).map((r, i) => `${i + 1}. ${trunc(r, 150)}`).join('\n'),
      inline: false
    });
  }

  const embed = {
    title: `${dEmoji} ${ticker} — ${dir} · Grade ${grade}`,
    description: descLines.join('\n'),
    color,
    fields,
    footer: FOOTER,
    timestamp: new Date().toISOString()
  };

  return { embeds: fitMessage([embed]) };
}

// ============================================================
// 5) buildDarkPoolAlert
// ============================================================

export function buildDarkPoolAlert(summary, ticker) {
  if (!summary) return null;
  const agg = summary.net_aggressor || 'NEUTRAL';
  const aggColor = agg === 'BUY' ? '🟢' : agg === 'SELL' ? '🔴' : '⚪';
  const color = agg === 'BUY' ? DIR_COLOR.BULLISH
              : agg === 'SELL' ? DIR_COLOR.BEARISH
              : DIR_COLOR.NEUTRAL;

  const buy = summary.buy_premium || 0;
  const sell = summary.sell_premium || 0;
  const total = buy + sell || 1;
  const buyPct = Math.round((buy / total) * 100);
  const sellPct = 100 - buyPct;

  const description = [
    `Net aggressor: ${aggColor} **${agg}**`,
    `Total premium: **${fmtMoney(summary.total_premium)}**`,
    `Buy ${fmtMoney(buy)} (${buyPct}%) · Sell ${fmtMoney(sell)} (${sellPct}%)`,
    `Blocks: \`${summary.block_count ?? 0}\` · Active prints: \`${summary.active ?? summary.total ?? 0}\``
  ].join('\n');

  const embed = {
    title: `🌊 Dark Pool Alert — ${ticker}`,
    description,
    color,
    footer: FOOTER,
    timestamp: new Date().toISOString()
  };

  return { embeds: fitMessage([embed]) };
}

// ============================================================
// 6) buildRegimeChange
// ============================================================

export function buildRegimeChange(oldRegime, newRegime) {
  const color = REGIME_COLOR[newRegime] ?? REGIME_COLOR.TRANSITIONAL;
  const arrow = '→';

  const meaning = {
    RISK_ON: 'Confidence boosted across signals. Bullish biases amplified, position sizes can scale up per Signa multipliers.',
    TRANSITIONAL: 'Confidence held steady. Mixed signals expected — favor higher-conviction Tier 2+ entries only.',
    RISK_OFF: 'Confidence damped. Signa down-weights all signals. Bearish/defensive signals weighted higher; reduce risk.'
  }[newRegime] || 'Regime change detected.';

  const embed = {
    title: '⚠️ Market Regime Change Detected',
    description: [
      `**${oldRegime || 'UNKNOWN'}**  ${arrow}  **${newRegime}**`,
      '',
      meaning
    ].join('\n'),
    color,
    footer: FOOTER,
    timestamp: new Date().toISOString()
  };

  return { embeds: fitMessage([embed]) };
}

// ============================================================
// 7) buildPremarketBrief
// ============================================================

export function buildPremarketBrief(earnings, watchlistSignals) {
  // Use ET-local date, not UTC, so this still works around midnight UTC.
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const todays = (earnings?.earnings || earnings || []).filter(e => e.date === todayET);
  const watchSet = new Set((watchlistSignals?.watchlist || []).map(t => t.toUpperCase()));

  const fields = [];

  if (todays.length > 0) {
    // 1) Watchlist hits FIRST — these are the ones the user actually cares about.
    const watchHits = todays.filter(e => watchSet.has(e.ticker.toUpperCase()));
    // 2) Then the biggest names by EPS estimate magnitude (often the most-watched companies).
    const others = todays
      .filter(e => !watchSet.has(e.ticker.toUpperCase()))
      .sort((a, b) => Math.abs(Number(b.epsEstimate) || 0) - Math.abs(Number(a.epsEstimate) || 0))
      .slice(0, watchHits.length > 0 ? 6 : 10);

    const fmt = (e, star = false) => {
      const tag = e.time === 'pre-market' ? '🌅 pre' : e.time === 'post-market' ? '🌙 post' : '·';
      const eps = e.epsEstimate != null ? ` · EPS \`${Number(e.epsEstimate).toFixed(2)}\`` : '';
      const prefix = star ? '⭐ ' : '';
      return `${prefix}**${e.ticker}** ${tag}${eps}  ${trunc(e.name || '', 40)}`;
    };

    if (watchHits.length > 0) {
      fields.push({
        name: `⭐ Watchlist Earnings Today (${watchHits.length})`,
        value: watchHits.map(e => fmt(e, true)).join('\n'),
        inline: false
      });
    }
    if (others.length > 0) {
      const moreNote = todays.length > (watchHits.length + others.length)
        ? `\n_… +${todays.length - watchHits.length - others.length} more reporting today_`
        : '';
      fields.push({
        name: `📅 Other Notable Earnings Today (${todays.length} total)`,
        value: others.map(e => fmt(e)).join('\n') + moreNote,
        inline: false
      });
    }
  } else {
    fields.push({
      name: '📅 Earnings Today',
      value: '_No earnings scheduled today._',
      inline: false
    });
  }

  const active = sortByPriority(watchlistSignals?.signals || []).slice(0, 8);
  if (active.length > 0) {
    fields.push({
      name: "📈 Yesterday's Top Signals (still active)",
      value: active.map(formatSignalLine).join('\n'),
      inline: false
    });
  }

  const embed = {
    title: `☀️ Pre-Market Brief — ${todayStr()}`,
    color: 0xFFCC00,
    description: `Pre-market briefing · ${nowET()}`,
    fields,
    footer: FOOTER,
    timestamp: new Date().toISOString()
  };

  return { embeds: fitMessage([embed]) };
}

// ============================================================
// Earnings Action Cards (Phase 2)
// ============================================================

// Internal: extract drivers from a /api/v1/signal Action Card response.
// Signa's response shape varies — we normalize across common field names.
function extractActionCardData(actionCard) {
  if (!actionCard) return null;
  const d = actionCard.data ?? actionCard.action_card ?? actionCard.signal ?? actionCard;

  const grade = String(d.grade ?? d.letter_grade ?? d.actionCardGrade ?? '?').toUpperCase();
  const score = d.score ?? d.composite_score ?? d.confidence_score;
  const direction = String(d.direction ?? d.bias ?? d.action ?? '').toUpperCase();
  const tier = d.tier ?? d.alert_tier;

  // Drivers can be: drivers[], indicators[], signals[], reasons[], triggers[]
  const driverList = d.drivers ?? d.indicators ?? d.bullish_drivers ?? d.signals ?? [];
  const bullishDrivers = Array.isArray(driverList)
    ? driverList.filter(x => {
        const dir = String(x.direction || x.signal || x.side || '').toLowerCase();
        return dir.includes('bull') || dir.includes('buy') || x.value === true || x.bullish === true;
      })
    : [];
  const bearishDrivers = Array.isArray(driverList)
    ? driverList.filter(x => {
        const dir = String(x.direction || x.signal || x.side || '').toLowerCase();
        return dir.includes('bear') || dir.includes('sell') || x.bearish === true;
      })
    : [];

  // Fallback to reasons/triggers if no structured drivers
  const reasons = d.key_drivers ?? d.reasons ?? d.triggers ?? [];

  return {
    grade,
    score: score != null ? Math.round(Number(score)) : null,
    direction: direction || (grade === 'A' || grade === 'A+' || grade === 'B' ? 'BULLISH' : 'NEUTRAL'),
    tier,
    bullishDrivers: bullishDrivers.slice(0, 5),
    bearishDrivers: bearishDrivers.slice(0, 3),
    reasons: Array.isArray(reasons) ? reasons.slice(0, 5) : [],
    entry: d.entry_price ?? d.entry,
    stop: d.stop_level ?? d.stop_loss ?? d.stop,
    target: d.target_price ?? d.take_profit ?? d.target,
    sizeMultiplier: d.regime_multiplier ?? d.size_multiplier,
    suggestedSize: d.suggested_size_pct ?? d.position_size_pct,
    regime: d.regime,
    confidence: d.confidence,
    totalDrivers: Array.isArray(driverList) ? driverList.length : null,
    bullishCount: bullishDrivers.length,
    bearishCount: bearishDrivers.length
  };
}

function formatDriver(drv) {
  if (typeof drv === 'string') return trunc(drv, 90);
  const name = drv.name ?? drv.indicator ?? drv.driver ?? drv.label ?? '';
  const value = drv.value ?? drv.note ?? drv.detail ?? '';
  if (name && value) return `${trunc(name, 30)} — ${trunc(String(value), 60)}`;
  return trunc(name || JSON.stringify(drv), 90);
}

// 60-min full Action Card
export function buildEarningsActionCard60(ticker, actionCard, earnings, quote) {
  const data = extractActionCardData(actionCard);
  if (!data) {
    return buildEarningsFallback(ticker, earnings, quote, 60);
  }
  const dir = data.direction;
  const color = DIR_COLOR[dir] ?? DIR_COLOR.NEUTRAL;
  const dEmoji = DIR_EMOJI[dir] || '·';
  const gEmoji = GRADE_EMOJI[data.grade?.[0]] || '·'; // first letter for A+/A/B
  const epsEst = earnings?.epsEstimate != null ? `$${Number(earnings.epsEstimate).toFixed(2)}` : '—';
  const reportTime = earnings?.time === 'pre-market' ? '🌅 Pre-market'
                    : earnings?.time === 'post-market' ? '🌙 Post-market'
                    : '·';
  const price = quote?.price != null ? fmtPrice(quote.price) : null;
  const change = quote?.change_pct != null
    ? (Number(quote.change_pct) >= 0 ? `+${Number(quote.change_pct).toFixed(2)}%` : `${Number(quote.change_pct).toFixed(2)}%`)
    : null;

  const headerLines = [
    `**Reports in:** ~60 min  ·  **Session:** ${reportTime}  ·  **EPS Est:** \`${epsEst}\``,
    `${gEmoji} **Grade ${data.grade}**  ·  Score \`${data.score ?? '—'}/100\`  ·  ${dEmoji} **${dir}**`,
    price ? `**Last:** ${price}${change ? ` (${change})` : ''}` : null,
    data.totalDrivers
      ? `**Driver consensus:** ${data.bullishCount}/${data.totalDrivers} bullish · ${data.bearishCount}/${data.totalDrivers} bearish`
      : null,
    data.regime && data.regime !== 'RISK_ON'
      ? `⚠️  Regime: **${data.regime}**${data.sizeMultiplier && data.sizeMultiplier < 1 ? ` (size × ${data.sizeMultiplier})` : ''}`
      : data.regime ? `**Regime:** ${data.regime}` : null
  ].filter(Boolean);

  const fields = [];

  // Top bullish drivers
  if (data.bullishDrivers.length > 0) {
    fields.push({
      name: '✅ Top Bullish Drivers',
      value: data.bullishDrivers.map((d, i) => `${i + 1}. ${formatDriver(d)}`).join('\n'),
      inline: false
    });
  } else if (data.reasons.length > 0) {
    fields.push({
      name: '✅ Key Drivers',
      value: data.reasons.map((r, i) => `${i + 1}. ${trunc(r, 90)}`).join('\n'),
      inline: false
    });
  }

  // Bearish drivers (risks)
  if (data.bearishDrivers.length > 0) {
    fields.push({
      name: '⚠️  Counter-signals',
      value: data.bearishDrivers.map((d, i) => `${i + 1}. ${formatDriver(d)}`).join('\n'),
      inline: false
    });
  }

  // Position guide
  const posLines = [];
  if (data.entry != null) posLines.push(`Entry \`${fmtPrice(data.entry)}\``);
  if (data.stop != null)  posLines.push(`Stop \`${fmtPrice(data.stop)}\``);
  if (data.target != null) posLines.push(`Target \`${fmtPrice(data.target)}\``);
  if (data.suggestedSize != null && data.suggestedSize > 0) posLines.push(`Size \`${data.suggestedSize}%\``);
  if (posLines.length > 0) {
    fields.push({
      name: '📍 Position Guide',
      value: posLines.join('  ·  '),
      inline: false
    });
  }

  const embed = {
    title: `📊 ${ticker} — Earnings Action Card (T-60min)`,
    description: headerLines.join('\n'),
    color,
    fields,
    footer: FOOTER,
    timestamp: new Date().toISOString()
  };

  return { embeds: fitMessage([embed]) };
}

// 15-min short pulse
export function buildEarningsActionCard15(ticker, actionCard, earnings, quote, prevGrade) {
  const data = extractActionCardData(actionCard);
  const grade = data?.grade ?? prevGrade ?? '?';
  const dir = data?.direction || 'NEUTRAL';
  const color = DIR_COLOR[dir] ?? DIR_COLOR.NEUTRAL;
  const gEmoji = GRADE_EMOJI[grade?.[0]] || '·';
  const dEmoji = DIR_EMOJI[dir] || '·';
  const epsEst = earnings?.epsEstimate != null ? `$${Number(earnings.epsEstimate).toFixed(2)}` : '—';
  const price = quote?.price != null ? fmtPrice(quote.price) : '—';
  const change = quote?.change_pct != null
    ? (Number(quote.change_pct) >= 0 ? `+${Number(quote.change_pct).toFixed(2)}%` : `${Number(quote.change_pct).toFixed(2)}%`)
    : null;

  const gradeChange = prevGrade && data?.grade && prevGrade !== data.grade
    ? `  _(was ${prevGrade} at T-60)_`
    : '';

  const description = [
    `⏰ **Reports in ~15 min** · EPS Est \`${epsEst}\``,
    `${gEmoji} Grade **${grade}**${gradeChange}  ·  ${dEmoji} **${dir}**  ·  Score \`${data?.score ?? '—'}\``,
    `Last: **${price}**${change ? ` (${change})` : ''}`
  ].join('\n');

  const embed = {
    title: `⚡ ${ticker} — T-15min Pulse`,
    description,
    color,
    footer: FOOTER,
    timestamp: new Date().toISOString()
  };
  return { embeds: fitMessage([embed]) };
}

// Follow-up after earnings: pre-grade vs price reaction
export function buildEarningsFollowUp(ticker, preEarningsGrade, preEarningsScore, preEarningsDirection, quote, earnings) {
  if (!quote || quote.change_pct == null) return null;
  const changePct = Number(quote.change_pct);
  const reaction = changePct >= 1 ? 'BEAT (price up)'
                 : changePct <= -1 ? 'MISS (price down)'
                 : 'INLINE';
  const validated = (preEarningsDirection === 'BULLISH' && changePct >= 1)
                  || (preEarningsDirection === 'BEARISH' && changePct <= -1);
  const verdict = validated
    ? `✅ **Signa called it** — pre-grade ${preEarningsGrade} ${preEarningsDirection} → ${reaction}`
    : `❌ **Signa missed** — pre-grade ${preEarningsGrade} ${preEarningsDirection} → ${reaction}`;

  const color = validated ? 0x00FF88 : 0xFF4444;
  const gEmoji = GRADE_EMOJI[preEarningsGrade?.[0]] || '·';
  const epsEst = earnings?.epsEstimate != null ? `$${Number(earnings.epsEstimate).toFixed(2)}` : '—';

  const description = [
    `**Pre-earnings:** ${gEmoji} Grade ${preEarningsGrade} · Score \`${preEarningsScore ?? '—'}\` · **${preEarningsDirection}**`,
    `**EPS Est:** \`${epsEst}\``,
    `**Price reaction:** ${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}% → ${fmtPrice(quote.price)}`,
    '',
    verdict
  ].join('\n');

  const embed = {
    title: `🔔 ${ticker} — Earnings Follow-Up`,
    description,
    color,
    footer: FOOTER,
    timestamp: new Date().toISOString()
  };
  return { embeds: fitMessage([embed]) };
}

// Fallback if Signa's Action Card endpoint fails for a ticker
function buildEarningsFallback(ticker, earnings, quote, minutesBefore) {
  const epsEst = earnings?.epsEstimate != null ? `$${Number(earnings.epsEstimate).toFixed(2)}` : '—';
  const reportTime = earnings?.time === 'pre-market' ? '🌅 Pre-market'
                    : earnings?.time === 'post-market' ? '🌙 Post-market' : '·';
  const price = quote?.price != null ? fmtPrice(quote.price) : '—';
  const description = [
    `⚠️  Action Card data unavailable from Signa for ${ticker}.`,
    `**Reports in ~${minutesBefore} min** · ${reportTime} · EPS Est \`${epsEst}\` · Last \`${price}\``
  ].join('\n');
  const embed = {
    title: `📊 ${ticker} — Earnings (T-${minutesBefore}min, partial)`,
    description,
    color: 0xFFCC00,
    footer: FOOTER,
    timestamp: new Date().toISOString()
  };
  return { embeds: fitMessage([embed]) };
}

// ============================================================
// Backtest result (Phase 2 Feature 3)
//
// Embed shows: win rate, Sharpe, Sortino, max DD, total return,
// profit factor, trade count + SPY benchmark side-by-side for context.
// Includes honest disclosure of exit rules used.
// ============================================================

function fmtNum(n, digits = 2, suffix = '') {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toFixed(digits) + suffix;
}

function pickPriceFor(equityArr, when = 'end') {
  if (!Array.isArray(equityArr) || equityArr.length === 0) return null;
  return when === 'start' ? equityArr[0]?.value : equityArr[equityArr.length - 1]?.value;
}

// Compute SPY-equivalent buy-and-hold return for the same window.
// We can't run a separate backtest call here (caller decides), so this
// expects a `spyBacktest` arg that the caller has already fetched.
export function buildBacktestResult(symbol, backtest, opts = {}) {
  if (!backtest?.summary) {
    return null;
  }
  const s = backtest.summary;
  const cfg = backtest.config || {};
  const spy = opts.spyBacktest || null; // optional SPY backtest for benchmark

  // Derive percentages — Signa returns winRate as 0-1, returns as %.
  const winRatePct = s.winRate != null ? Math.round(s.winRate * 100) : null;
  const totalReturnPct = s.totalReturnPercent;
  const annualizedPct = s.annualizedReturn;
  const maxDDPct = s.maxDrawdownPercent;
  const sharpe = s.sharpeRatio;
  const sortino = s.sortinoRatio;
  const profitFactor = s.profitFactor;

  // Profitable strategy? Profit factor > 1 AND positive total return.
  const isProfitable = (profitFactor > 1) && (totalReturnPct > 0);
  const color = isProfitable ? 0x00FF88 : (totalReturnPct < 0 ? 0xFF4444 : 0xFFCC00);

  // SPY benchmark — strategy alpha vs market
  let spyTotalReturn = null;
  let alphaPct = null;
  if (spy?.summary?.totalReturnPercent != null) {
    spyTotalReturn = spy.summary.totalReturnPercent;
    alphaPct = totalReturnPct - spyTotalReturn;
  }

  // Build header
  const headerLines = [
    `**Strategy:** Signa signals + ${fmtNum(cfg.stopLoss * 100, 0)}% stop / ${fmtNum(cfg.takeProfit * 100, 0)}% target / ${cfg.holdingPeriod || '?'}d max hold`,
    `**Window:** \`${(cfg.startDate || '').slice(0, 10)}\` → \`${(cfg.endDate || '').slice(0, 10)}\` (${s.totalDays || '?'} days)`,
    `**Capital:** ${fmtMoney(cfg.initialCapital)}  ·  **Position size:** ${fmtNum(cfg.positionSize * 100, 0)}%`
  ];

  // Core stats block — readable, mono-aligned
  const coreStats = [
    `📈 **Win Rate:**       \`${winRatePct != null ? winRatePct + '%' : '—'}\` (${s.winningTrades || 0}W / ${s.losingTrades || 0}L · ${s.totalTrades || 0} trades)`,
    `💰 **Total Return:**   \`${fmtNum(totalReturnPct, 2, '%')}\``,
    `📊 **Annualized:**     \`${fmtNum(annualizedPct, 2, '%')}\``,
    `📉 **Max Drawdown:**   \`${fmtNum(maxDDPct, 2, '%')}\``,
    `⚡ **Sharpe Ratio:**   \`${fmtNum(sharpe, 2)}\``,
    `🎯 **Profit Factor:**  \`${fmtNum(profitFactor, 2)}\` (need > 1.0 to be profitable)`,
    `⏱️  **Avg Holding:**    \`${fmtNum(s.avgHoldingDays, 1)} days\``
  ];

  const fields = [
    {
      name: '📋 Backtest Configuration',
      value: headerLines.join('\n'),
      inline: false
    },
    {
      name: '📊 Performance',
      value: coreStats.join('\n'),
      inline: false
    }
  ];

  // SPY benchmark row
  if (spyTotalReturn != null) {
    const alphaSign = alphaPct >= 0 ? '+' : '';
    const alphaEmoji = alphaPct >= 0 ? '🟢' : '🔴';
    fields.push({
      name: '🆚 vs SPY (Buy & Hold Benchmark)',
      value: [
        `${symbol} strategy:  \`${fmtNum(totalReturnPct, 2, '%')}\``,
        `SPY benchmark:  \`${fmtNum(spyTotalReturn, 2, '%')}\` (same window)`,
        `${alphaEmoji} **Alpha:** \`${alphaSign}${fmtNum(alphaPct, 2, ' pp')}\``
      ].join('\n'),
      inline: false
    });
  }

  // Win/loss size (useful for risk-adjusting reads)
  if (s.avgWin != null || s.avgLoss != null) {
    fields.push({
      name: '💵 Trade Sizes',
      value: [
        `Avg win: \`${fmtMoney(s.avgWin)}\``,
        `Avg loss: \`${fmtMoney(s.avgLoss)}\``,
        s.expectedValue != null ? `Expected value per trade: \`${fmtNum(s.expectedValue, 2, '%')}\`` : null
      ].filter(Boolean).join('  ·  '),
      inline: false
    });
  }

  // Verdict — content-friendly summary
  let verdict = '';
  if (isProfitable && alphaPct != null && alphaPct > 0) {
    verdict = `✅ **Strategy beat the market** with ${fmtNum(alphaPct, 1, ' pp')} of alpha and a positive profit factor.`;
  } else if (isProfitable) {
    verdict = `🟡 **Strategy was profitable** but underperformed buy & hold by ${fmtNum(Math.abs(alphaPct ?? 0), 1, ' pp')}.`;
  } else if (totalReturnPct >= 0) {
    verdict = `🟡 **Marginal returns** — profit factor below 1.0 means losses outweighed wins despite total return.`;
  } else {
    verdict = `🔴 **Strategy lost money.** With these exit rules, ${symbol} was unprofitable over this window${alphaPct != null ? ` (vs SPY ${fmtNum(spyTotalReturn, 1, '%')})` : ''}.`;
  }

  fields.push({
    name: '💬 Verdict',
    value: verdict,
    inline: false
  });

  // Honest caveat about endpoint behavior
  fields.push({
    name: '⚠️  Disclosure',
    value: [
      `The Signa backtest endpoint applies its full signal stream to ${symbol} with the chosen exits — it is NOT a single-agent backtest.`,
      `Different exit rules will produce dramatically different results.`,
      `Past performance ≠ future returns.`
    ].join(' '),
    inline: false
  });

  const embed = {
    title: `📊 ${symbol} — Backtest Result`,
    color,
    fields,
    footer: FOOTER,
    timestamp: new Date().toISOString()
  };

  return { embeds: fitMessage([embed]) };
}

// ============================================================
// Startup confirmation
// ============================================================

export function buildStartupNotice(accountInfo, nextDigestTime, watchlistCount) {
  // accountInfo.plan can be a string OR an object — normalize either way.
  const rawPlan = accountInfo?.plan ?? accountInfo?.plan_name ?? accountInfo?.tier;
  let plan = 'Member';
  if (typeof rawPlan === 'string') {
    plan = rawPlan;
  } else if (rawPlan && typeof rawPlan === 'object') {
    plan = rawPlan.name || rawPlan.plan_name || rawPlan.tier || rawPlan.label || 'Member';
  }
  const embed = {
    title: '🟢 Signa Bot Online',
    description: [
      `Started **${todayStr()}** at \`${nowET()}\``,
      `Plan: **${plan}**`,
      `Watchlist: **${watchlistCount}** tickers`,
      `Next digest: **${nextDigestTime}**`
    ].join('\n'),
    color: 0x00FF88,
    footer: FOOTER,
    timestamp: new Date().toISOString()
  };
  return { embeds: fitMessage([embed]) };
}
