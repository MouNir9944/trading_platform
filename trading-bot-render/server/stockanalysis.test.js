import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { analyzeStock, maxDrawdown, returnOver } from "../shared/analysis/stock.js";
import { createApp } from "./app.js";
import { OrderManager } from "./orders.js";
import { createStockData, fromYahooSymbol, parseChart, parseSearch, toYahooSymbol } from "./stockData.js";
import { FileStore } from "./store.js";

/** Deterministic daily candles: exponential drift with bounded noise, plus optional shaping of the closes. */
function series({ n = 400, start = 100, drift = 0.0006, noise = 0.008, seed = 7, volume = 5_000_000, shape = (c) => c } = {}) {
  let x = seed;
  const rand = () => { x = (x * 1664525 + 1013904223) % 4294967296; return x / 4294967296 - 0.5; };
  const closes = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    price *= 1 + drift + noise * 2 * rand();
    closes.push(price);
  }
  const shaped = shape(closes);
  return shaped.map((close, i) => {
    const open = i ? shaped[i - 1] : close;
    const range = close * 0.006;
    return { time: 1_700_000_000 + i * 86400, open, high: Math.max(open, close) + range, low: Math.min(open, close) - range, close, volume };
  });
}

const factorOf = (result, label) => result.factors.find((f) => f.label === label);

test("a steady uptrend reads favourable, with every trend measure scored", () => {
  const a = analyzeStock(series());
  assert.equal(a.ok, true);
  assert.ok(a.score >= 65, `score ${a.score}`);
  assert.ok(["good", "caution"].includes(a.verdict.tone), a.verdict.label);
  assert.equal(factorOf(a, "Price vs 200-day average").points, 10);
  assert.equal(factorOf(a, "50-day above 200-day").points, 6);
  assert.equal(a.downtrend, false);
  assert.ok(a.score <= 100);
});

test("a steady decline is called a downtrend, whatever the momentum", () => {
  const a = analyzeStock(series({ drift: -0.0012 }));
  assert.equal(a.downtrend, true);
  assert.match(a.verdict.label, /Downtrend/);
  assert.equal(a.verdict.tone, "bad");
  assert.ok(a.score < 45, `score ${a.score}`);
  assert.equal(factorOf(a, "Price vs 200-day average").points, 0);
});

test("a stock that shot up recently is flagged as stretched, not simply favourable", () => {
  const a = analyzeStock(series({ drift: 0.0003, noise: 0.004, shape: (closes) => closes.map((c, i) => (i >= closes.length - 25 ? c * (1 + 0.016 * (i - (closes.length - 25))) : c)) }));
  assert.equal(a.stretched, true);
  assert.notEqual(a.verdict.tone, "good");
});

test("too little history is refused, and 100 days works without the 200-day measures", () => {
  const few = analyzeStock(series({ n: 40 }));
  assert.equal(few.ok, false);
  assert.match(few.reason, /at least 60/);
  const partial = analyzeStock(series({ n: 100 }));
  assert.equal(partial.ok, true);
  assert.equal(factorOf(partial, "Price vs 200-day average"), undefined);
  assert.ok(partial.warnings.some((w) => /days of history/.test(w)));
  assert.ok(partial.score >= 0 && partial.score <= 100, "the score is scaled to what could be measured");
});

test("relative strength compares the last 3 months with the benchmark", () => {
  const stock = series({ drift: 0.0015, noise: 0.004 });
  const ahead = analyzeStock(stock, { benchmark: series({ drift: 0.0002, noise: 0.004, seed: 3 }) });
  const behind = analyzeStock(stock, { benchmark: series({ drift: 0.004, noise: 0.004, seed: 3 }) });
  assert.equal(factorOf(ahead, "3 months vs the market").points, 10);
  assert.equal(factorOf(behind, "3 months vs the market").points, 0);
  assert.equal(factorOf(analyzeStock(stock), "3 months vs the market"), undefined);
  assert.ok(analyzeStock(stock).warnings.some((w) => /benchmark/.test(w)));
});

test("the plan puts the stop below price, at least one daily range away, with a 2:1 target", () => {
  const { plan, stats } = analyzeStock(series());
  assert.ok(plan.stop < plan.entry);
  assert.ok(((plan.entry - plan.stop) / plan.entry) * 100 >= stats.atrPct * 0.99, "not tighter than one daily range");
  assert.ok(Math.abs(plan.target - (plan.entry + 2 * (plan.entry - plan.stop))) < 1e-9);
  assert.ok(plan.stopPct < 0 && plan.targetPct > 0);
});

test("warnings: thin trading, a big recent move and a very volatile stock", () => {
  assert.ok(analyzeStock(series({ volume: 500 })).warnings.some((w) => /Thin trading/.test(w)));
  const gap = analyzeStock(series({ shape: (c) => c.map((v, i) => (i >= c.length - 2 ? v * 1.15 : v)) }));
  assert.ok(gap.warnings.some((w) => /above 8%/.test(w)));
  assert.ok(analyzeStock(series({ noise: 0.09, drift: 0 })).warnings.some((w) => /volatile|swings a lot/i.test(w)));
});

test("helpers: returns and drawdown", () => {
  assert.ok(Math.abs(returnOver([100, 110, 121], 2) - 21) < 1e-9);
  assert.equal(returnOver([100, 110], 5), null);
  assert.equal(Math.round(maxDrawdown([100, 120, 90, 110])), 25);
});

// ---- price history and search from Yahoo ----

const chartJson = {
  chart: {
    result: [{
      meta: { longName: "Apple Inc.", currency: "USD", fullExchangeName: "NasdaqGS", instrumentType: "EQUITY", regularMarketPrice: 200, fiftyTwoWeekHigh: 220, fiftyTwoWeekLow: 150 },
      timestamp: [1000, 2000, 3000, 4000],
      indicators: { quote: [{ open: [1, 2, null, 4], high: [2, 3, 4, 5], low: [0.5, 1.5, 2.5, 3.5], close: [1.5, 2.5, 3.5, 4.5], volume: [10, 20, 30, null] }] },
    }],
  },
};

test("Yahoo chart data becomes candles, dropping bars with gaps", () => {
  const parsed = parseChart(chartJson, "AAPL");
  assert.equal(parsed.name, "Apple Inc.");
  assert.equal(parsed.candles.length, 3, "the bar with a missing open is dropped");
  assert.deepEqual(parsed.candles[0], [1_000_000, 1, 2, 0.5, 1.5, 10]);
  assert.equal(parsed.candles[2][5], 0, "a missing volume becomes 0");
  assert.equal(parsed.fiftyTwoWeekHigh, 220);
  assert.throws(() => parseChart({ chart: { result: null, error: { description: "Not Found" } } }, "ZZZ"), /No price history for ZZZ: Not Found/);
  assert.throws(() => parseChart({}, "ZZZ"), /No price history found/);
});

test("search results keep only stocks and ETFs with plain tickers, as Binance-style symbols", () => {
  const rows = parseSearch({
    quotes: [
      { symbol: "AAPL", shortname: "Apple Inc.", quoteType: "EQUITY", exchDisp: "NASDAQ" },
      { symbol: "SAAPL=F", shortname: "Apple futures", quoteType: "FUTURE" },
      { symbol: "AAPL.TO", shortname: "Apple CDR", quoteType: "EQUITY" },
      { symbol: "BRK-B", longname: "Berkshire Hathaway", quoteType: "EQUITY" },
      { symbol: "SPY", shortname: "SPDR S&P 500", quoteType: "ETF" },
      { symbol: "^GSPC", shortname: "S&P 500", quoteType: "INDEX" },
    ],
  });
  assert.deepEqual(rows.map((r) => r.symbol), ["AAPL", "BRK.B", "SPY"]);
  assert.equal(toYahooSymbol("BRK.B"), "BRK-B");
  assert.equal(fromYahooSymbol("BRK-B"), "BRK.B");
});

test("the data service caches, maps symbols and reports failures plainly", async () => {
  const calls = [];
  let mode = "ok";
  const fetchFn = async (url) => {
    calls.push(String(url));
    if (mode === "404") return new Response("{}", { status: 404 });
    if (mode === "429") return new Response("{}", { status: 429 });
    if (mode === "down") throw Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } });
    return new Response(JSON.stringify(chartJson), { status: 200 });
  };
  const data = createStockData({ fetchFn });
  await data.daily("BRK.B");
  assert.match(calls[0], /chart\/BRK-B\?range=2y&interval=1d/);
  await data.daily("BRK.B");
  assert.equal(calls.length, 1, "the second call is served from the cache");
  mode = "404";
  await assert.rejects(data.daily("NOPE"), /No price history for NOPE/);
  mode = "429";
  await assert.rejects(data.daily("RATE"), /rate limiting/);
  mode = "down";
  await assert.rejects(data.daily("DOWN"), /Could not reach the price history service/);
  mode = "ok";
  await data.daily("DOWN");
  assert.equal(calls.length, 5, "a failure is not cached: the next call tries again");
});

// ---- HTTP: search and history ----

test("HTTP: search by ticker or company name (only Binance-listed stocks), and history with a benchmark", async () => {
  const listed = ["AAPL", "AAPX", "SPY", "GLD", "BRK.B", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA"].map((symbol) => ({ symbol, tradability: "BUY_SELL", fractionable: true, minNotional: "5", stepSize: "0.000000001", extendedSession: true, overnightSupported: true }));
  const fakeStocks = { async exchangeInfo() { return { symbols: listed }; } };
  const daily = new Map([
    ["AAPL", { symbol: "AAPL", name: "Apple Inc.", candles: [[1, 1, 1, 1, 1, 1]] }],
    ["SPY", { symbol: "SPY", name: "SPDR S&P 500", candles: [[2, 2, 2, 2, 2, 2]] }],
  ]);
  const fakeYahoo = {
    async daily(symbol) { if (!daily.has(symbol)) throw new Error(`No price history found for ${symbol}`); return daily.get(symbol); },
    async search(q) { return q === "apple" ? [{ symbol: "AAPL", name: "Apple Inc.", type: "EQUITY" }, { symbol: "APLE", name: "Apple Hospitality", type: "EQUITY" }] : []; },
  };
  const store = new FileStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "stk-")) });
  const spot = new OrderManager({ getClient: () => ({}), getMode: () => "paper", getTradingFee: async () => ({}), store });
  await spot.init();
  const { app } = createApp({ orderManager: spot, stocksClient: fakeStocks, stockData: fakeYahoo });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const get = async (url) => { const r = await fetch(`${base}${url}`); return { status: r.status, body: await r.json() }; };
  try {
    const byName = (await get("/stocks/search?q=apple")).body.results;
    assert.equal(byName[0].symbol, "AAPL");
    assert.equal(byName[0].name, "Apple Inc.", "names come from the search service");
    assert.ok(!byName.some((r) => r.symbol === "APLE"), "APLE is not listed on Binance, so it is not offered");
    const prefix = (await get("/stocks/search?q=aap")).body.results.map((r) => r.symbol);
    assert.deepEqual(prefix.slice(0, 2).sort(), ["AAPL", "AAPX"], "ticker prefix matches");
    assert.equal((await get("/stocks/search?q=gld")).body.results[0].symbol, "GLD", "exact ticker first, no name service needed");
    assert.deepEqual((await get("/stocks/search?q=zzzz")).body.results, []);
    const popular = (await get("/stocks/search")).body.results.map((r) => r.symbol);
    assert.ok(popular.includes("AAPL") && popular.includes("SPY") && !popular.includes("V"), "the starter list only has listed tickers");
    assert.equal((await get(`/stocks/search?q=${"x".repeat(60)}`)).status, 422);

    const history = await get("/stocks/history?symbol=AAPL");
    assert.equal(history.body.name, "Apple Inc.");
    assert.equal(history.body.benchmark.symbol, "SPY");
    assert.equal(history.body.listed.tradability, "BUY_SELL");
    assert.equal((await get("/stocks/history?symbol=SPY")).body.benchmark, null, "the benchmark is not compared with itself");
    assert.equal((await get("/stocks/history?symbol=NOTLISTED")).status, 422);
    assert.equal((await get("/stocks/history?symbol=bad!")).status, 422);
    assert.equal((await get("/stocks/history?symbol=MSFT")).status, 500, "a price-history failure is reported, not hidden");
  } finally {
    server.close();
  }
});
