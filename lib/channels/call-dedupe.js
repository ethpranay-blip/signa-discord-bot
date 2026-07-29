// call-dedupe.js
// The channel cycles re-evaluate the whole universe every run, so a setup that
// stays valid was being logged as a brand-new CALL on every cycle — AAPL alone
// produced 222 rows across 20 days (~11/day). That makes the paper-validation
// stats unreadable: 631 rows looked like 631 trades but were ~54 ticker-days,
// and any hit-rate computed from them just measures "did these few names go up".
//
// This tracks the last logged setup per (channel, ticker, direction) and lets a
// new CALL through only when the setup is genuinely new or materially different.
// In-memory, seeded from the track log at startup so restarts/redeploys don't
// resurrect duplicates.

const MOVE_PCT = 1.0;                       // level move that counts as a new setup
const TTL_MS = 7 * 24 * 3600 * 1000;        // after a week, treat it as a fresh setup

const last = new Map();                     // key -> { entry, stop, target, at }

const keyOf = (channel, ticker, direction) =>
  `${channel}|${String(ticker).toUpperCase()}|${String(direction || '').toUpperCase()}`;

function movedEnough(a, b) {
  const pct = (x, y) => (x && y ? Math.abs(x - y) / Math.abs(x) * 100 : Infinity);
  return pct(a.entry, b.entry) > MOVE_PCT
      || pct(a.stop, b.stop) > MOVE_PCT
      || pct(a.target, b.target) > MOVE_PCT;
}

// Should this call be logged as a new CALL row?
export function isNewSetup(call, now = Date.now()) {
  const k = keyOf(call.channel, call.ticker, call.direction);
  const prev = last.get(k);
  if (!prev) return true;
  if (now - prev.at > TTL_MS) return true;
  return movedEnough(prev, call);
}

// Record what was logged so later cycles can compare against it.
export function remember(call, now = Date.now()) {
  last.set(keyOf(call.channel, call.ticker, call.direction), {
    entry: call.entry, stop: call.stop, target: call.target, at: now,
  });
}

// Rebuild state from existing track-log rows (call rows only), so a redeploy
// doesn't re-log setups that are already recorded.
export function seedFromRows(rows = []) {
  let seeded = 0;
  for (const r of rows) {
    if (r?.type !== 'call' || !r.ticker) continue;
    const at = Date.parse(String(r.call_id || '').slice(0, 24)) || Date.now();
    last.set(keyOf(r.channel, r.ticker, r.direction), {
      entry: r.entry, stop: r.stop, target: r.target, at,
    });
    seeded++;
  }
  return seeded;
}

export function _reset() { last.clear(); }   // tests only
