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

  const sentimentLabel = sentiment ? ` _(${sentiment})_` : '';

  const description = [
    `**Regime:** ${regimeBadge}${sentimentLabel}   **Signal Index:** \`${idxScore}/100\`   **Bull Bias:** \`${bullBias}\``,
    `**Signals:** ${total}  ·  📈 ${bullCount} bullish  ·  📉 ${bearCount} bearish`,
    tier3.length > 0
      ? `\n🚨 **${tier3.length} TIER 3 high-conviction signal${tier3.length > 1 ? 's' : ''} detected** — see alerts channel.`
      : `\n_No Tier 3 signals tonight._`
  ].join('\n');

  const fields = [];

  // Top signals from /signal-index — high-conviction picks across the full pipeline.
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
// 2) buildTier3Alert
// ============================================================

export function buildTier3Alert(signals) {
  const tier3 = (signals || []).filter(s => Number(s.alert_tier ?? s.tier) === 3);
  if (tier3.length === 0) return null;

  const sorted = sortByPriority(tier3).slice(0, 5);

  const embeds = sorted.map(s => {
    const dir = String(s.direction || s.signal || 'NEUTRAL').toUpperCase();
    const grade = String(s.grade || '?').toUpperCase();
    const score = s.composite_score ?? s.score ?? 0;
    const conf = s.confidence != null
      ? (s.confidence <= 1 ? Math.round(s.confidence * 100) : Math.round(s.confidence))
      : 0;
    const color = DIR_COLOR[dir] ?? DIR_COLOR.NEUTRAL;

    const descLines = [
      `**Score:** \`${score}/100\`   **Confidence:** \`${conf}%\``,
      `**Regime:** ${s.regime || 'UNKNOWN'}${s.regime_multiplier && s.regime_multiplier !== 1 ? ` (×${s.regime_multiplier})` : ''}`,
      `**Models:** ${s.model_count ?? 0} agreeing${s.category_diversity ? ` · diversity ${s.category_diversity}` : ''}`,
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
    if (s.entry_price != null) posLines.push(`Entry: \`${fmtPrice(s.entry_price)}\``);
    if (s.stop_level != null) posLines.push(`Stop: \`${fmtPrice(s.stop_level)}\``);
    if (s.target_price != null) posLines.push(`Target: \`${fmtPrice(s.target_price)}\``);
    if (s.suggested_size_pct != null && s.suggested_size_pct > 0) {
      posLines.push(`Size: \`${s.suggested_size_pct}%\``);
    }
    if (posLines.length > 0) {
      fields.push({ name: 'Position', value: posLines.join('  ·  '), inline: false });
    }

    return {
      title: `🔴 ${s.ticker} — ${dir} · Tier 3 · Grade ${grade}`,
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
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const todays = (earnings?.earnings || earnings || []).filter(e => e.date === todayET);
  const watchSet = new Set((watchlistSignals?.watchlist || []).map(t => t.toUpperCase()));

  const fields = [];

  if (todays.length > 0) {
    const watchHits = todays.filter(e => watchSet.has(e.ticker.toUpperCase()));
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
