// signal-cache.js
// Shared in-memory cache for /api/v1/signal responses across the Signa-driven
// channels. Lets #micro reuse #signals' fetches (same 50-ticker universe) and
// a re-run within TTL cost zero API calls.
//
// In-memory only — dies on restart by design (Phase 2.5: no disk persistence).

const TTL_MS = parseInt(process.env.SIGNAL_CACHE_TTL_MS || '1800000', 10); // 30 min

const store = new Map(); // ticker(upper) -> { data, fetchedAt }
let hits = 0;
let misses = 0;

function key(t) {
  return String(t).trim().toUpperCase();
}

export const signalCache = {
  TTL_MS,

  get(ticker) {
    const e = store.get(key(ticker));
    return e ? e.data : null;
  },

  set(ticker, data) {
    store.set(key(ticker), { data, fetchedAt: Date.now() });
  },

  // Existence regardless of freshness (callers pair this with age() < TTL_MS).
  has(ticker) {
    return store.has(key(ticker));
  },

  // ms since fetched; Infinity if absent.
  age(ticker) {
    const e = store.get(key(ticker));
    return e ? Date.now() - e.fetchedAt : Infinity;
  },

  // True when present AND within TTL — the "usable cached" predicate.
  fresh(ticker) {
    return this.has(ticker) && this.age(ticker) < TTL_MS;
  },

  hit() { hits++; },
  miss() { misses++; },

  clear() {
    store.clear();
    hits = 0;
    misses = 0;
  },

  stats() {
    let oldestAge = 0;
    const now = Date.now();
    for (const { fetchedAt } of store.values()) {
      const a = now - fetchedAt;
      if (a > oldestAge) oldestAge = a;
    }
    return { size: store.size, hits, misses, oldestAge };
  },
};
