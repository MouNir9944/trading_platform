/**
 * Market overview: 24h stats for every spot pair, market caps, and a "how good is this pair to trade"
 * score. Pure functions plus one small cached market-cap fetcher, so everything is testable offline.
 *
 * Market cap is not available from Binance, so it comes from CoinGecko's public API (no key, no user
 * data sent). If CoinGecko is unreachable the overview still works, just without market caps.
 */

const STABLECOINS = new Set([
  "USDC", "FDUSD", "TUSD", "USDP", "DAI", "BUSD", "USDS", "AEUR", "EUR", "EURI", "USDE", "PYUSD", "XUSD", "UST", "USD1", "RLUSD",
]);

/** Pairs below this 24h quote volume (USD) are listed but not scored: too thin to trade sensibly. */
export const MIN_SCORED_VOLUME = 1_000_000;

/** A healthy 24h range depends on the asset class: a stock moving 8% in a day is wild, a crypto is not. */
export const RANGE_BANDS = { crypto: [2, 8], stock: [1, 4], commodity: [1, 4], forex: [0.3, 1.5], other: [2, 8] };

/** Minimum 24h volume (USD) to be scored. Stocks and forex trade far thinner than crypto on Binance. */
export const MIN_VOLUME_BY_CATEGORY = { crypto: MIN_SCORED_VOLUME, stock: 100_000, commodity: 500_000, forex: 500_000, other: 500_000 };

const WEIGHTS = { liquidity: 0.35, spread: 0.2, volatility: 0.25, activity: 0.1, size: 0.1 };

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/** 0..1 percentile of each value within the list (ties share the lowest rank). */
export function percentiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const last = Math.max(1, sorted.length - 1);
  return values.map((v) => sorted.indexOf(v) / last);
}

/**
 * How well the 24h range suits short trades with a 0.5-1.5% stop and a few-percent target.
 * Flat pairs never reach the target; extremely wild ones get stopped out by noise.
 */
export function volatilityFit(rangePct, [low, high] = [2, 8]) {
  if (!Number.isFinite(rangePct)) return 0;
  if (rangePct < low) return clamp01(rangePct / low);
  if (rangePct <= high) return 1;
  return clamp01(1 - (rangePct - high) / (1.5 * high));
}

export const spreadFit = (spreadPct) => (spreadPct == null ? 0.5 : clamp01(1 - spreadPct / 0.1));

/**
 * @param tickers   Binance /api/v3/ticker/24hr rows
 * @param tradable  Map<symbol, {base}> of pairs the account can actually trade
 * @param marketCaps Map<BASE, {marketCap, rank}>
 */
export function buildOverview({ tickers, tradable, marketCaps = new Map(), minVolume = MIN_SCORED_VOLUME }) {
  const rows = [];
  for (const t of tickers) {
    const info = tradable.get(t.symbol);
    const category = info?.category ?? "crypto";
    if (!info || (STABLECOINS.has(info.base) && category !== "forex")) continue;
    const price = Number(t.lastPrice);
    if (!(price > 0)) continue;
    const bid = Number(t.bidPrice);
    const ask = Number(t.askPrice);
    const low = Number(t.lowPrice);
    const cap = category === "crypto" ? marketCaps.get(info.base) : undefined; // CoinGecko only covers crypto
    rows.push({
      symbol: t.symbol,
      base: info.base,
      category,
      contract: info.contract ?? null,
      price,
      change24h: Number(t.priceChangePercent),
      quoteVolume: Number(t.quoteVolume),
      trades: Number(t.count),
      spreadPct: bid > 0 && ask > 0 ? ((ask - bid) / ((ask + bid) / 2)) * 100 : null,
      rangePct: low > 0 ? ((Number(t.highPrice) - low) / low) * 100 : null,
      marketCap: cap?.marketCap ?? null,
      marketCapRank: cap?.rank ?? null,
      score: null,
      scoreRank: null,
      reasons: [],
      warnings: [],
    });
  }

  // `minVolume` overrides the per-category thresholds (0 disables them, e.g. for testnet's synthetic data).
  const eligible = rows.filter((r) => r.quoteVolume >= (minVolume === MIN_SCORED_VOLUME ? MIN_VOLUME_BY_CATEGORY[r.category] ?? minVolume : minVolume));
  const liquidity = percentiles(eligible.map((r) => r.quoteVolume));
  const activity = percentiles(eligible.map((r) => r.trades));
  const withCap = eligible.filter((r) => r.marketCap > 0);
  const sizes = percentiles(withCap.map((r) => Math.log10(r.marketCap)));
  const sizeByPair = new Map(withCap.map((r, i) => [r.symbol, sizes[i]]));

  eligible.forEach((r, i) => {
    const parts = {
      liquidity: liquidity[i],
      spread: spreadFit(r.spreadPct),
      volatility: volatilityFit(r.rangePct, RANGE_BANDS[r.category] ?? RANGE_BANDS.crypto),
      activity: activity[i],
      size: sizeByPair.get(r.symbol) ?? 0.4,
    };
    r.score = Math.round(100 * Object.entries(WEIGHTS).reduce((sum, [key, w]) => sum + w * parts[key], 0));
    r.parts = parts;
    r.reasons = explain(r, parts);
    r.warnings = warn(r);
  });

  eligible.sort((a, b) => b.score - a.score || b.quoteVolume - a.quoteVolume).forEach((r, i) => { r.scoreRank = i + 1; });
  return rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.quoteVolume - a.quoteVolume);
}

const money = (n) => (n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(0)}M` : `$${Math.round(n / 1e3)}K`);

function explain(r, p) {
  const out = [];
  if (p.liquidity >= 0.75) out.push(`Deep liquidity (${money(r.quoteVolume)} traded in 24h)`);
  if (p.spread >= 0.9 && r.spreadPct != null) out.push(`Tight spread (${r.spreadPct.toFixed(3)}%)`);
  if (p.volatility >= 1) out.push(`Healthy 24h range for ${r.category === "crypto" ? "a crypto" : r.category === "other" ? "this asset" : `a ${r.category}`} (${r.rangePct.toFixed(1)}%)`);
  if (p.activity >= 0.75) out.push("Very active order flow");
  if (p.size >= 0.75 && r.marketCapRank) out.push(`Large cap (#${r.marketCapRank})`);
  return out.slice(0, 3);
}

function warn(r) {
  const out = [];
  const band = RANGE_BANDS[r.category] ?? RANGE_BANDS.crypto;
  if (r.rangePct > band[1] * 1.5) out.push(`Very volatile for ${r.category === "crypto" ? "a crypto" : `a ${r.category}`} (${r.rangePct.toFixed(1)}% 24h range)`);
  else if (r.rangePct < band[0] / 2) out.push("Barely moving: targets may take long to hit");
  if (r.spreadPct > 0.05) out.push(`Wide spread (${r.spreadPct.toFixed(3)}%)`);
  if (r.quoteVolume < 5_000_000) out.push("Modest liquidity: expect slippage on larger orders");
  if (r.category !== "crypto") { /* no market cap for stocks, commodities or forex */ }
  else if (r.marketCapRank == null) out.push("Market cap unknown");
  else if (r.marketCapRank > 300) out.push(`Small cap (#${r.marketCapRank}): higher risk`);
  if (Math.abs(r.change24h) > 15) out.push(`Big 24h move (${r.change24h > 0 ? "+" : ""}${r.change24h.toFixed(0)}%)`);
  return out;
}

/**
 * CoinGecko market caps, cached. Symbols are not unique on CoinGecko; the largest coin wins
 * (the list is ordered by market cap, so the first entry for a symbol is kept).
 */
export function createMarketCaps({ fetchImpl = fetch, ttlMs = 15 * 60_000, retryMs = 60_000, pages = 3, now = () => Date.now() } = {}) {
  let map = new Map();
  let expiresAt = 0;
  let inflight = null;

  async function load() {
    const next = new Map();
    for (let page = 1; page <= pages; page++) {
      try {
        const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}&sparkline=false`;
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
        if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
        for (const coin of await res.json()) {
          const key = String(coin.symbol ?? "").toUpperCase();
          if (key && coin.market_cap > 0 && !next.has(key)) next.set(key, { marketCap: coin.market_cap, rank: coin.market_cap_rank ?? null });
        }
      } catch {
        break; // keep what we have
      }
    }
    if (next.size > 0) {
      map = next;
      expiresAt = now() + ttlMs;
    } else {
      expiresAt = now() + retryMs; // keep the stale map and try again soon
    }
    return map;
  }

  return {
    async get() {
      if (now() < expiresAt) return map;
      inflight ??= load().finally(() => { inflight = null; });
      return inflight;
    },
  };
}
