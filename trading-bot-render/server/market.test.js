import assert from "node:assert/strict";
import test from "node:test";

import { MIN_SCORED_VOLUME, buildOverview, createMarketCaps, percentiles, spreadFit, volatilityFit } from "./market.js";

const ticker = (symbol, o = {}) => ({
  symbol,
  lastPrice: "100",
  priceChangePercent: "1.5",
  bidPrice: "99.99",
  askPrice: "100.01",
  highPrice: "104",
  lowPrice: "98",
  quoteVolume: "50000000",
  count: "100000",
  ...o,
});

const tradable = (...bases) => new Map(bases.map((b) => [`${b}USDT`, { base: b }]));

test("percentiles, volatility fit and spread fit", () => {
  assert.deepEqual(percentiles([10, 30, 20]), [0, 1, 0.5]);
  assert.equal(volatilityFit(0), 0);
  assert.equal(volatilityFit(1), 0.5);
  assert.equal(volatilityFit(2), 1);
  assert.equal(volatilityFit(8), 1);
  assert.equal(volatilityFit(14), 0.5);
  assert.equal(volatilityFit(30), 0);
  assert.equal(volatilityFit(null), 0);
  assert.equal(spreadFit(0), 1);
  assert.equal(spreadFit(0.05), 0.5);
  assert.equal(spreadFit(0.5), 0);
  assert.equal(spreadFit(null), 0.5);
});

test("overview filters non-tradable pairs and stablecoins and computes 24h stats", () => {
  const rows = buildOverview({
    tickers: [ticker("AAAUSDT"), ticker("USDCUSDT"), ticker("ZZZUSDT"), ticker("BADUSDT", { lastPrice: "0" })],
    tradable: tradable("AAA", "USDC", "BAD"), // ZZZ is not tradable on this account
  });
  assert.deepEqual(rows.map((r) => r.symbol), ["AAAUSDT"]);
  const [r] = rows;
  assert.equal(r.base, "AAA");
  assert.equal(r.change24h, 1.5);
  near(r.spreadPct, (0.02 / 100) * 100); // (100.01-99.99)/100 = 0.02%
  near(r.rangePct, ((104 - 98) / 98) * 100);
});

function near(a, b, eps = 1e-6) {
  assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);
}

test("a liquid, tight-spread, moderately volatile large cap outranks thin and wild pairs", () => {
  const caps = new Map([["BIG", { marketCap: 5e11, rank: 1 }], ["MID", { marketCap: 2e9, rank: 60 }], ["WILD", { marketCap: 5e7, rank: 700 }]]);
  const rows = buildOverview({
    tickers: [
      ticker("BIGUSDT", { quoteVolume: "900000000", count: "2000000", highPrice: "104", lowPrice: "98" }),
      ticker("MIDUSDT", { quoteVolume: "40000000", count: "150000" }),
      ticker("WILDUSDT", { quoteVolume: "3000000", count: "20000", highPrice: "150", lowPrice: "90", bidPrice: "99.5", askPrice: "100.5", priceChangePercent: "40" }),
      ticker("THINUSDT", { quoteVolume: "200000" }), // below the scoring threshold
    ],
    tradable: tradable("BIG", "MID", "WILD", "THIN"),
    marketCaps: caps,
  });
  assert.deepEqual(rows.map((r) => r.symbol), ["BIGUSDT", "MIDUSDT", "WILDUSDT", "THINUSDT"]);
  const [big, mid, wild, thin] = rows;
  assert.ok(big.score > mid.score && mid.score > wild.score, `${big.score} > ${mid.score} > ${wild.score}`);
  assert.equal(big.scoreRank, 1);
  assert.equal(thin.score, null); // listed, but not scored
  assert.equal(thin.scoreRank, null);
  assert.ok(big.reasons.some((x) => x.includes("Deep liquidity")));
  assert.ok(wild.warnings.some((x) => x.includes("Very volatile")));
  assert.ok(wild.warnings.some((x) => x.includes("Small cap")));
  assert.ok(wild.warnings.some((x) => x.includes("Wide spread")));
  assert.ok(wild.warnings.some((x) => x.includes("Big 24h move")));
  assert.equal(big.marketCapRank, 1);
  assert.ok(big.score <= 100 && wild.score >= 0);
});

test("without market caps the ranking still works and says the cap is unknown", () => {
  const rows = buildOverview({ tickers: [ticker("AAAUSDT"), ticker("BBBUSDT", { quoteVolume: "2000000" })], tradable: tradable("AAA", "BBB") });
  assert.equal(rows[0].symbol, "AAAUSDT");
  assert.equal(rows[0].marketCap, null);
  assert.ok(rows[0].warnings.includes("Market cap unknown"));
  assert.ok(rows.every((r) => Number.isInteger(r.score)));
});

test("fallback data with no volume floor (minVolume 0) still scores every pair", () => {
  const rows = buildOverview({ tickers: [ticker("AAAUSDT", { quoteVolume: "10" })], tradable: tradable("AAA"), minVolume: 0 });
  assert.equal(typeof rows[0].score, "number");
  assert.ok(MIN_SCORED_VOLUME > 0);
});

test("market caps: largest coin wins a shared symbol, results are cached, failures keep the old data", async () => {
  let calls = 0;
  let fail = false;
  let clock = 1000;
  const page = (coins) => ({ ok: true, json: async () => coins });
  const fetchImpl = async (url) => {
    calls++;
    if (fail) return { ok: false, status: 429, json: async () => ({}) };
    const p = Number(new URL(url).searchParams.get("page"));
    if (p === 1) return page([{ symbol: "btc", market_cap: 1e12, market_cap_rank: 1 }, { symbol: "abc", market_cap: 5e9, market_cap_rank: 40 }]);
    if (p === 2) return page([{ symbol: "abc", market_cap: 1e6, market_cap_rank: 900 }, { symbol: "xyz", market_cap: 3e8, market_cap_rank: 200 }]);
    return page([]);
  };
  const caps = createMarketCaps({ fetchImpl, ttlMs: 10_000, retryMs: 1_000, now: () => clock });

  const first = await caps.get();
  assert.equal(calls, 3);
  assert.deepEqual(first.get("ABC"), { marketCap: 5e9, rank: 40 }); // not the tiny clone on page 2
  assert.equal(first.get("XYZ").rank, 200);

  await caps.get();
  assert.equal(calls, 3, "served from cache");

  clock += 20_000;
  fail = true;
  const stale = await caps.get(); // refresh fails: keep the old map
  assert.equal(stale.get("BTC").marketCap, 1e12);
  const callsAfterFailure = calls;
  await caps.get();
  assert.equal(calls, callsAfterFailure, "does not hammer the API while it is failing");

  clock += 2_000;
  fail = false;
  assert.equal((await caps.get()).get("XYZ").marketCap, 3e8); // recovers
});

test("concurrent market cap requests share one fetch", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return { ok: true, json: async () => [{ symbol: "btc", market_cap: 1, market_cap_rank: 1 }] }; };
  const caps = createMarketCaps({ fetchImpl, pages: 1 });
  await Promise.all([caps.get(), caps.get(), caps.get()]);
  assert.equal(calls, 1);
});

// ---- asset classes ----
import { categorizeFutures, categorizeSpot, equityBasesFrom } from "./categories.js";
import { RANGE_BANDS } from "./market.js";

test("categories: futures underlying types and spot stock tokens / forex", () => {
  const eq = equityBasesFrom({ symbols: [{ baseAsset: "TSLA", underlyingType: "EQUITY" }, { baseAsset: "005930", underlyingType: "KR_EQUITY" }, { baseAsset: "XAU", underlyingType: "COMMODITY" }, { baseAsset: "BTC", underlyingType: "COIN" }] });
  assert.ok(eq.has("TSLA") && eq.has("005930") && !eq.has("XAU") && !eq.has("BTC"));
  assert.ok(eq.has("NVDA"), "the built-in fallback tickers are always included");

  const type = (underlyingType) => categorizeFutures({ underlyingType });
  assert.deepEqual(["EQUITY", "KR_EQUITY", "HK_EQUITY", "CN_EQUITY"].map(type), ["stock", "stock", "stock", "stock"]);
  assert.equal(type("COMMODITY"), "commodity");
  assert.equal(type("FX"), "forex");
  assert.equal(type("INDEX"), "other");
  assert.equal(type("PREMARKET"), "other");
  assert.equal(type("COIN"), "crypto");
  assert.equal(type(undefined), "crypto");

  assert.equal(categorizeSpot("TSLAB", "USDT", eq), "stock");
  assert.equal(categorizeSpot("NVDAB", "USDT", eq), "stock");
  assert.equal(categorizeSpot("EUR", "USDT", eq), "forex");
  assert.equal(categorizeSpot("GBP", "USDT", eq), "forex");
  assert.equal(categorizeSpot("EUR", "BTC", eq), "crypto"); // only USDT pairs count as forex
  assert.equal(categorizeSpot("BTC", "USDT", eq), "crypto");
  assert.equal(categorizeSpot("WBTC", "USDT", eq), "crypto"); // ends in B, but "WBT" is not a stock
  assert.equal(categorizeSpot("ARB", "USDT", eq), "crypto");
  assert.equal(categorizeSpot("B", "USDT", eq), "crypto");
});

test("scoring is category-aware: the same 2% day is healthy for a stock, sleepy for crypto and huge for forex", () => {
  assert.equal(volatilityFit(2, RANGE_BANDS.stock), 1);
  assert.equal(volatilityFit(2, RANGE_BANDS.crypto), 1);
  assert.equal(volatilityFit(1, RANGE_BANDS.crypto), 0.5);
  assert.equal(volatilityFit(1, RANGE_BANDS.stock), 1);
  assert.equal(volatilityFit(0.8, RANGE_BANDS.forex), 1);
  assert.ok(volatilityFit(2.5, RANGE_BANDS.forex) < 0.6);
  assert.equal(volatilityFit(4, RANGE_BANDS.forex), 0); // a 4% day is an extreme move for a currency
  assert.equal(volatilityFit(9, RANGE_BANDS.stock) < volatilityFit(9, RANGE_BANDS.crypto), true);
});

test("overview keeps forex pairs, skips market caps for non-crypto, and uses per-category volume floors", () => {
  const tradableMixed = new Map([
    ["BTCUSDT", { base: "BTC", category: "crypto" }],
    ["TSLABUSDT", { base: "TSLAB", category: "stock" }],
    ["EURUSDT", { base: "EUR", category: "forex" }],
    ["USDCUSDT", { base: "USDC", category: "crypto" }],
  ]);
  const caps = new Map([["BTC", { marketCap: 1e12, rank: 1 }], ["TSLAB", { marketCap: 5e11, rank: 3 }]]);
  const rows = buildOverview({
    tickers: [
      ticker("BTCUSDT", { quoteVolume: "900000000", count: "2000000" }),
      ticker("TSLABUSDT", { quoteVolume: "400000", count: "6000", highPrice: "102", lowPrice: "100" }),
      ticker("EURUSDT", { quoteVolume: "20000000", count: "23000", highPrice: "100.6", lowPrice: "100" }),
      ticker("USDCUSDT"),
    ],
    tradable: tradableMixed,
    marketCaps: caps,
  });
  const by = Object.fromEntries(rows.map((r) => [r.symbol, r]));
  assert.ok(!by.USDCUSDT, "stablecoins stay excluded");
  assert.ok(by.EURUSDT, "EUR/USDT is kept: it is the forex pair, not a stablecoin");
  assert.equal(by.EURUSDT.category, "forex");
  assert.equal(by.TSLABUSDT.marketCap, null, "no CoinGecko market cap for a stock token");
  assert.equal(by.BTCUSDT.marketCap, 1e12);
  assert.equal(typeof by.TSLABUSDT.score, "number", "$400K is enough to score a stock token (floor $100K)");
  assert.ok(!by.TSLABUSDT.warnings.includes("Market cap unknown"));
  assert.ok(by.EURUSDT.reasons.some((x) => x.includes("Healthy 24h range for a forex")), by.EURUSDT.reasons.join("|"));
  // A crypto with the same $400K would not be scored
  const thinCrypto = buildOverview({ tickers: [ticker("BTCUSDT", { quoteVolume: "400000" })], tradable: new Map([["BTCUSDT", { base: "BTC", category: "crypto" }]]) });
  assert.equal(thinCrypto[0].score, null);
});
