// basic-card-formatter.js
// Shared "basic" card for the Signa-driven channels (#signals / #micro / #macro).
// Phase 2 only — this is the lightweight card. The rich Confidence Breakdown
// card is Phase 3 and intentionally NOT built here.
//
// Card shape:
//   Header:  TICKER · Grade · Direction · Conviction NN  (the value we rank on)
//   Levels:  Entry $X.XX · Stop $X.XX · Target $X.XX · R:R N.NR
//   Drivers: top 2-3 signa.triggers (names only)
//   Footer:  #channel · asset_class · timestamp ET

const DIR_COLOR = {
  BULLISH: 0x2ecc71,
  BEARISH: 0xe74c3c,
};

function money(x) {
  const n = Number(x);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : '—';
}

function rr(x) {
  const n = Number(x);
  return Number.isFinite(n) ? `${n.toFixed(1)}R` : '—';
}

// Derive display direction from engine.direction + signa.action.
// Per recon: do NOT use data.direction (it reads "WAIT" even on bullish names).
export function deriveDirection(sig) {
  const eng = String(sig?.engine?.direction || '').toUpperCase(); // BULLISH/BEARISH/NEUTRAL/''
  const act = String(sig?.signa?.action || '').toUpperCase();      // BUY/HOLD/AVOID/''
  let label = eng;
  if (!label) {
    if (act === 'BUY') label = 'BULLISH';
    else if (act === 'AVOID') label = 'BEARISH';
    else if (act === 'HOLD') label = 'NEUTRAL';
    else label = 'UNKNOWN';
  }
  return { label, action: act || '—' };
}

// triggers → array of names (signa.triggers items are {name,...} or strings)
export function triggerNames(sig, n = 3) {
  const arr = Array.isArray(sig?.signa?.triggers) ? sig.signa.triggers : [];
  return arr
    .map((t) => (typeof t === 'string' ? t : t?.name))
    .filter(Boolean)
    .slice(0, n);
}

// Build the normalized "call" object the channel engine logs + renders.
export function buildCall({ channel, pick, sig, asset_class, tsEt, cycleISO }) {
  const signa = sig?.signa || {};
  const data = sig?.data || {};
  const dir = deriveDirection(sig);
  const grade = String(signa.grade || sig?.engine?.grade || '—').toUpperCase();
  const drivers = triggerNames(sig, 3);
  return {
    channel,
    ticker: String(pick.symbol).toUpperCase(),
    asset_class: asset_class || null,
    grade,
    direction: dir.label,
    action: dir.action,
    score: pick.score ?? null, // scan score that ranked this pick
    conviction: signa.conviction ?? null,
    entry: data.entry ?? null,
    stop: data.stop ?? null,
    target: data.target ?? null,
    rr_card: data.rr ?? null,
    triggers: drivers,
    ts_et: tsEt,
    cycle_id: cycleISO,
    // call_id: cycleISO-ticker-direction-channel (channel suffix for uniqueness)
    call_id: `${cycleISO}-${String(pick.symbol).toUpperCase()}-${dir.label}-${channel}`,
  };
}

// Discord embed for live posting.
export function buildEmbed(call) {
  const header = `${call.ticker} · ${call.grade} · ${call.direction} · Conviction ${call.conviction ?? '—'}`;
  const levels = `**Entry** ${money(call.entry)} · **Stop** ${money(call.stop)} · **Target** ${money(call.target)} · **R:R** ${rr(call.rr_card)}`;
  const drivers = call.triggers.length ? `**Drivers:** ${call.triggers.join(', ')}` : '**Drivers:** —';
  return {
    title: header,
    description: `${levels}\n${drivers}`,
    color: DIR_COLOR[call.direction] ?? 0x95a5a6,
    footer: { text: `#${call.channel} · ${call.asset_class || '—'} · ${call.ts_et}` },
  };
}

// Plain-text rendering for stdout (dry / channels-disabled mode).
export function renderText(call) {
  const lines = [
    `  ┌─ ${call.ticker} · ${call.grade} · ${call.direction}${call.action && call.action !== '—' ? ` (${call.action})` : ''} · Conviction ${call.conviction ?? '—'}`,
    `  │  Entry ${money(call.entry)} · Stop ${money(call.stop)} · Target ${money(call.target)} · R:R ${rr(call.rr_card)}`,
    `  │  Drivers: ${call.triggers.length ? call.triggers.join(', ') : '—'}`,
    `  └─ #${call.channel} · ${call.asset_class || '—'} · ${call.ts_et}`,
  ];
  return lines.join('\n');
}
