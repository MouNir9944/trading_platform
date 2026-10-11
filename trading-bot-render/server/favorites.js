/**
 * Favorite trading pairs and favorite stocks, kept on the server (not in the browser) so every device, the Telegram
 * agent and the MCP tools see the same lists.
 *
 *   pairs:  { "spot:BTCUSDT": { market, symbol, note, addedAt }, ... }
 *   stocks: { "AAPL": { symbol, note, addedAt }, ... }
 *
 * The pair shape is exactly what the pair picker already kept in localStorage, so existing favorites move over as they
 * are. Every write goes through one queue so two writers (the dashboard and the bot) never overwrite each other.
 */

export const MAX_FAVORITES = 200;
const MAX_NOTE = 200;
const PAIR = /^[A-Z0-9]{4,20}$/;
const STOCK = /^[A-Z0-9][A-Z0-9.\-]{0,9}$/;
const MARKETS = new Set(["spot", "futures"]);

export const emptyFavorites = () => ({ pairs: {}, stocks: {} });

const note = (v) => (typeof v === "string" ? v.trim().slice(0, MAX_NOTE) : "");
const stamp = (v, now) => (Number.isFinite(v) && v > 0 ? Math.round(v) : now);
const upper = (v) => (typeof v === "string" ? v.trim().toUpperCase() : "");

export const pairKey = (market, symbol) => `${market}:${symbol}`;

function entries(input, label) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Object.assign(new Error(`${label} must be an object`), { httpStatus: 400 });
  const list = Object.values(input);
  if (list.length > MAX_FAVORITES) throw Object.assign(new Error(`at most ${MAX_FAVORITES} ${label}`), { httpStatus: 400 });
  return list;
}

/** Clean a map of favorite pairs: invalid entries are dropped, the key is rebuilt from the entry itself. */
export function normalizePairs(input, now = Date.now()) {
  const out = {};
  for (const e of entries(input, "pairs")) {
    const market = e?.market;
    const symbol = upper(e?.symbol);
    if (!MARKETS.has(market) || !PAIR.test(symbol)) continue;
    out[pairKey(market, symbol)] = { market, symbol, note: note(e.note), addedAt: stamp(e.addedAt, now) };
  }
  return out;
}

/** Clean a map of favorite stocks, keyed by ticker. */
export function normalizeStocks(input, now = Date.now()) {
  const out = {};
  for (const e of entries(input, "stocks")) {
    const symbol = upper(e?.symbol);
    if (!STOCK.test(symbol)) continue;
    out[symbol] = { symbol, note: note(e.note), addedAt: stamp(e.addedAt, now) };
  }
  return out;
}

const NORMALIZE = { pairs: normalizePairs, stocks: normalizeStocks };

export class Favorites {
  constructor({ store, now = Date.now } = {}) {
    this.store = store;
    this.now = now;
    this.queue = Promise.resolve();
  }

  async get() {
    const saved = await this.store.getSetting("favorites");
    return { ...emptyFavorites(), ...(saved && typeof saved === "object" ? saved : {}) };
  }

  /** Replace one list ("pairs" or "stocks") with `map`. */
  set(kind, map) {
    const normalize = NORMALIZE[kind];
    if (!normalize) return Promise.reject(Object.assign(new Error('kind must be "pairs" or "stocks"'), { httpStatus: 400 }));
    const clean = normalize(map, this.now());
    return this.#write((all) => ({ ...all, [kind]: clean }));
  }

  /** Add (or update the note of) one favorite. `item` is { market, symbol } for pairs and { symbol } for stocks. */
  add(kind, item) {
    const normalize = NORMALIZE[kind];
    if (!normalize) return Promise.reject(Object.assign(new Error('kind must be "pairs" or "stocks"'), { httpStatus: 400 }));
    const one = normalize({ x: item }, this.now());
    const [key] = Object.keys(one);
    if (!key) return Promise.reject(Object.assign(new Error(kind === "pairs" ? 'a pair needs market "spot" or "futures" and a symbol like BTCUSDT' : "a stock needs a ticker like AAPL"), { httpStatus: 400 }));
    return this.#write((all) => {
      const current = all[kind][key];
      if (all[kind] && !current && Object.keys(all[kind]).length >= MAX_FAVORITES) throw Object.assign(new Error(`at most ${MAX_FAVORITES} favorites`), { httpStatus: 400 });
      return { ...all, [kind]: { ...all[kind], [key]: current ? { ...current, note: one[key].note || current.note } : one[key] } };
    });
  }

  /** Remove one favorite by its key (see pairKey; a stock's key is its ticker). Removing something absent is not an error. */
  remove(kind, key) {
    if (!NORMALIZE[kind]) return Promise.reject(Object.assign(new Error('kind must be "pairs" or "stocks"'), { httpStatus: 400 }));
    return this.#write((all) => {
      const next = { ...all[kind] };
      delete next[kind === "stocks" ? upper(key) : key];
      return { ...all, [kind]: next };
    });
  }

  #write(change) {
    const run = this.queue.then(async () => {
      const next = change(await this.get());
      await this.store.setSetting("favorites", next);
      return next;
    });
    this.queue = run.catch(() => {});
    return run;
  }
}
