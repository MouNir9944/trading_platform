import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "./app.js";
import { OrderManager } from "./orders.js";
import { FileStore } from "./store.js";
import { buildEquityOrder, buildPositions, fetchAllTrades, getPortfolio, quotePrice, valuePortfolio } from "./stocks.js";

const trade = (symbol, side, qty, price, at, id = `${symbol}-${at}`) => ({ executionId: id, symbol, side, qty: String(qty), price: String(price), executionAt: at });

// The account from the dashboard screenshot: GLD bought twice and sold twice, MRVL and MAGS bought once.
const trades = [
  trade("GLD", "BUY", 0.04738356, 420.4495, 1),
  trade("MRVL", "BUY", 0.0817524, 226.66, 2),
  trade("GLD", "BUY", 0.06467624, 398.91, 3),
  trade("MAGS", "BUY", 0.28336668, 69.98, 4),
  trade("GLD", "SELL", 0.015, 399.026, 5),
  trade("GLD", "SELL", 0.013, 399.336, 6),
];

test("positions are rebuilt from trades by average cost", () => {
  const bySymbol = Object.fromEntries(buildPositions(trades).map((p) => [p.symbol, p]));
  assert.ok(Math.abs(bySymbol.GLD.quantity - 0.08405980) < 1e-9, "0.1120598 bought - 0.028 sold");
  const boughtCost = 0.04738356 * 420.4495 + 0.06467624 * 398.91;
  const average = boughtCost / (0.04738356 + 0.06467624);
  assert.ok(Math.abs(bySymbol.GLD.avgCost - average) < 1e-9, "selling does not change the average cost of what is left");
  assert.ok(Math.abs(bySymbol.GLD.realized - ((399.026 - average) * 0.015 + (399.336 - average) * 0.013)) < 1e-9);
  assert.equal(bySymbol.MAGS.quantity, 0.28336668);
  assert.ok(Math.abs(bySymbol.MRVL.avgCost - 226.66) < 1e-9);
});

test("selling everything closes the position; order of arrival does not matter", () => {
  const shuffled = [trade("X", "SELL", 2, 12, 20), trade("X", "BUY", 2, 10, 10)];
  const [x] = buildPositions(shuffled);
  assert.equal(x.quantity, 0);
  assert.equal(x.avgCost, null);
  assert.equal(x.realized, 4);
  assert.deepEqual(valuePortfolio([x], {}).holdings, []);
});

test("holdings are valued at the bid with profit and loss against cost", () => {
  const quotes = { GLD: { bidPrice: "400.9", askPrice: "505" }, MRVL: { bidPrice: "244.3" }, MAGS: { bidPrice: "70.49" } };
  const { holdings, totals } = valuePortfolio(buildPositions(trades), quotes, { GLD: "SPDR Gold" });
  assert.deepEqual(holdings.map((h) => h.symbol), ["GLD", "MRVL", "MAGS"].sort((a, b) => holdings.find((h) => h.symbol === b).value - holdings.find((h) => h.symbol === a).value));
  const gld = holdings.find((h) => h.symbol === "GLD");
  assert.equal(gld.price, 400.9, "valued at the bid, not the ask");
  assert.equal(gld.name, "SPDR Gold");
  assert.ok(Math.abs(gld.value - 0.0840598 * 400.9) < 1e-6);
  assert.ok(gld.pnl < 0 && gld.pnlPct < 0, "bought higher, so a loss");
  assert.ok(holdings.find((h) => h.symbol === "MRVL").pnl > 0);
  assert.ok(Math.abs(totals.value - holdings.reduce((s, h) => s + h.value, 0)) < 1e-9);
  assert.equal(quotePrice({ bidPrice: "0", askPrice: "12" }), 12);
  assert.equal(quotePrice(undefined), null);
  // an unpriced holding still shows, without a value, and does not break the totals
  assert.equal(valuePortfolio(buildPositions(trades), {}).holdings[0].value, null);
});

test("trade history is fetched window by window and pages until done", async () => {
  const day = 86_400_000;
  const now = 1_800_000_000_000;
  const calls = [];
  const all = [
    ...Array.from({ length: 130 }, (_, i) => trade("A", "BUY", 1, 10, now - 5 * day - i, `recent-${i}`)),
    trade("B", "BUY", 1, 5, now - 120 * day, "older"),
  ];
  const client = {
    async tradeHistory({ startTime, endTime, current, size }) {
      calls.push([startTime, endTime, current]);
      const inWindow = all.filter((t) => t.executionAt >= startTime && t.executionAt <= endTime);
      return { total: inWindow.length, rows: inWindow.slice((current - 1) * size, current * size) };
    },
  };
  const rows = await fetchAllTrades(client, now);
  assert.equal(rows.length, 131);
  assert.equal(new Set(rows.map((r) => r.executionId)).size, 131, "no duplicates");
  assert.ok(calls.some((c) => c[2] === 2), "a second page was requested for the busy window");
  assert.ok(calls.length <= 12, "and it stops after empty windows");
});

test("getPortfolio combines trades, quotes and tokenized names, and tolerates a failed quote", async () => {
  const client = {
    async tradeHistory({ current }) { return current === 1 ? { total: trades.length, rows: trades } : { total: trades.length, rows: [] }; },
    async quote(symbol) { if (symbol === "MAGS") throw new Error("no quote"); return { bidPrice: "100", askPrice: "101" }; },
    async tokenizedAssets() { return [{ underlyingEquitySymbol: "MRVL", assetName: "Marvell (bStocks)" }]; },
  };
  const result = await getPortfolio(client, 100);
  assert.equal(result.holdings.length, 3);
  assert.equal(result.holdings.find((h) => h.symbol === "MRVL").name, "Marvell");
  assert.equal(result.holdings.find((h) => h.symbol === "MAGS").value, null);
  assert.equal(result.tradeCount, 6);
});

// ---- order validation: Binance's rules ----

const info = { minNotional: "5.00000000", fractionable: true };
const fails = (body, pattern, i = info) => assert.throws(() => buildEquityOrder(body, { info: i }), pattern);

test("a market buy is placed by amount, a market sell by quantity", () => {
  const buy = buildEquityOrder({ symbol: "gld", side: "BUY", order_type: "MARKET", notional: 10.129 }, { info });
  assert.deepEqual([buy.symbol, buy.side, buy.orderType, buy.notional, buy.walletType, buy.quoteAsset, buy.tokenize], ["GLD", "BUY", "MARKET", "10.12", "MAIN", "USDC", "false"]);
  assert.equal(buy.quantity, undefined);
  assert.match(buy.clientOrderId, /^[a-zA-Z0-9-_]{32,36}$/);
  assert.notEqual(buy.clientOrderId, buildEquityOrder({ symbol: "GLD", side: "BUY", order_type: "MARKET", notional: 10 }, { info }).clientOrderId);

  const sell = buildEquityOrder({ symbol: "GLD", side: "SELL", order_type: "MARKET", quantity: 0.05 }, { info });
  assert.deepEqual([sell.quantity, sell.notional, sell.walletType], ["0.05", undefined, undefined]);

  fails({ symbol: "GLD", side: "BUY", order_type: "MARKET", quantity: 1 }, /placed by amount/);
  fails({ symbol: "GLD", side: "BUY", order_type: "MARKET" }, /notional must be/);
  fails({ symbol: "GLD", side: "SELL", order_type: "MARKET", notional: 5 }, /placed by quantity/);
  fails({ symbol: "GLD", side: "BUY", order_type: "MARKET", notional: 2 }, /minimum for GLD is 5/);
  fails({ symbol: "GLD", side: "BUY", order_type: "MARKET", notional: 10, price: 400 }, /no price/);
});

test("a limit order needs price, quantity and a session; GTC and fractions follow Binance's rules", () => {
  const ok = buildEquityOrder({ symbol: "AAPL", side: "BUY", order_type: "LIMIT", price: 200.5, quantity: 0.1, trading_session: "extended", time_in_force: "GTC", wallet_type: "card", quote_asset: "usdt", tokenize: true }, { info });
  assert.deepEqual([ok.price, ok.quantity, ok.tradingSession, ok.timeInForce, ok.walletType, ok.quoteAsset, ok.tokenize], ["200.5", "0.1", "EXTENDED", "GTC", "CARD", "USDT", "true"]);
  assert.equal(buildEquityOrder({ symbol: "AAPL", side: "SELL", order_type: "LIMIT", price: 200, quantity: 1 }, { info }).timeInForce, "DAY");

  fails({ symbol: "AAPL", side: "BUY", order_type: "LIMIT", quantity: 1 }, /price must be/);
  fails({ symbol: "AAPL", side: "BUY", order_type: "LIMIT", price: 200.123, quantity: 1 }, /2 decimals/);
  fails({ symbol: "AAPL", side: "BUY", order_type: "LIMIT", price: 200, quantity: 0.5, time_in_force: "GTC" }, /EXTENDED or 24H/);
  fails({ symbol: "AAPL", side: "BUY", order_type: "LIMIT", price: 200, quantity: 0.5 }, /below Binance's minimum/, { minNotional: "500" });
  fails({ symbol: "AAPL", side: "BUY", order_type: "LIMIT", price: 200, quantity: 1.5 }, /cannot be traded in fractions/, { fractionable: false });
  fails({ symbol: "AAPL", side: "BUY", order_type: "LIMIT", price: 200, quantity: 1, trading_session: "night" }, /trading_session/);
  fails({ symbol: "AAPL", side: "BUY", order_type: "LIMIT", price: 200, quantity: 1, time_in_force: "IOC" }, /time_in_force/);
});

test("bad symbols, sides and types are refused", () => {
  fails({ symbol: "aapl;drop", side: "BUY", order_type: "MARKET", notional: 10 }, /ticker/);
  fails({ symbol: "AAPL", side: "HOLD", order_type: "MARKET", notional: 10 }, /BUY or SELL/);
  fails({ symbol: "AAPL", side: "BUY", order_type: "STOP", notional: 10 }, /MARKET or LIMIT/);
  fails({ symbol: "AAPL", side: "BUY", order_type: "MARKET", notional: "10" }, /positive number/);
});

// ---- HTTP ----

test("HTTP: portfolio, symbols, order placement with Binance's own checks, cancel", async () => {
  const placed = [];
  const fake = {
    async tradeHistory({ current }) { return { total: trades.length, rows: current === 1 ? trades : [] }; },
    async quote() { return { bidPrice: "100", askPrice: "101" }; },
    async tokenizedAssets() { return []; },
    async exchangeInfo(symbol) {
      const all = [
        { symbol: "GLD", tradability: "BUY_SELL", fractionable: true, minNotional: "5", stepSize: "0.000000001", extendedSession: true, overnightSupported: true },
        { symbol: "OLDCO", tradability: "SELL_ONLY", fractionable: false, minNotional: "5" },
      ];
      return { symbols: symbol ? all.filter((s) => s.symbol === symbol) : all };
    },
    async placeOrder(params) { placed.push(params); return { orderId: "abc", status: "NEW" }; },
    async cancelOrder(orderId) { return { orderId, status: "CANCELED" }; },
    async openOrders() { return []; },
    async orderHistory() { return { rows: [] }; },
  };
  const store = new FileStore({ dir: (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "stk-")) });
  const spot = new OrderManager({ getClient: () => ({}), getMode: () => "testnet", getTradingFee: async () => ({}), store });
  await spot.init();
  const yahooFake = { async daily(symbol) { return { symbol, name: `${symbol} Inc.`, candles: [] }; }, async search() { return []; } };
  const { app } = createApp({ orderManager: spot, stocksClient: fake, stockData: yahooFake });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  try {
    const portfolio = await (await fetch(`${base}/stocks/portfolio`)).json();
    assert.equal(portfolio.holdings.length, 3);
    assert.ok(portfolio.totals.value > 0);
    assert.equal(portfolio.holdings.find((h) => h.symbol === "GLD").name, "GLD Inc.", "holdings without a name get one");
    const symbols = await (await fetch(`${base}/stocks/symbols`)).json();
    assert.equal(symbols.symbols[0].symbol, "GLD");
    assert.equal((await fetch(`${base}/stocks/quote?symbol=bad;x`)).status, 422);

    const post = (body) => fetch(`${base}/stocks/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const ok = await post({ symbol: "GLD", side: "BUY", order_type: "MARKET", notional: 10 });
    assert.equal(ok.status, 200);
    assert.equal(placed.length, 1);
    assert.equal(placed[0].notional, "10");
    assert.equal((await post({ symbol: "GLD", side: "BUY", order_type: "MARKET", notional: 1 })).status, 422, "below Binance's minimum");
    const sellOnly = await post({ symbol: "OLDCO", side: "BUY", order_type: "MARKET", notional: 10 });
    assert.equal(sellOnly.status, 422);
    assert.match((await sellOnly.json()).detail, /cannot be bought/);
    assert.equal((await post({ symbol: "NOPE", side: "BUY", order_type: "MARKET", notional: 10 })).status, 422);
    assert.equal(placed.length, 1, "refused orders never reach Binance");

    const cancelled = await (await fetch(`${base}/stocks/orders/abc`, { method: "DELETE" })).json();
    assert.equal(cancelled.status, "CANCELED");
  } finally {
    server.close();
  }
});

test("order fees are part of the cost, and reduce what a sale earns", () => {
  const withIds = [
    { ...trade("Z", "BUY", 1, 100, 1), orderId: "o1" },
    { ...trade("Z", "BUY", 1, 100, 2), orderId: "o2" },
    { ...trade("Z", "SELL", 1, 120, 3), orderId: "o3" },
  ];
  const orders = [{ orderId: "o1", fee: "0.5" }, { orderId: "o2", fee: "0.5" }, { orderId: "o3", fee: "0.4" }];
  const [z] = buildPositions(withIds, orders);
  assert.equal(z.quantity, 1);
  assert.ok(Math.abs(z.avgCost - 100.5) < 1e-9, "each buy cost 100 + 0.5 fee");
  assert.ok(Math.abs(z.realized - (120 - 0.4 - 100.5)) < 1e-9);
  // an order filled in two parts shares its fee by value
  const split = [{ ...trade("Y", "BUY", 1, 10, 1, "a"), orderId: "s" }, { ...trade("Y", "BUY", 3, 10, 2, "b"), orderId: "s" }];
  const [y] = buildPositions(split, [{ orderId: "s", fee: "0.4" }]);
  assert.ok(Math.abs(y.cost - 40.4) < 1e-9);
});
