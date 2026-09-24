import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RISK_DEFAULTS, checkOrder, estimateTrade, normalizeSettings, riskSetup } from "../shared/risk.js";
import { createApp } from "./app.js";
import { FuturesTradingClient } from "./binance.js";
import { FuturesManager, futuresSymbolInfo, parsePosition, summarizeTrades } from "./futures.js";
import { OrderManager } from "./orders.js";
import { FileStore } from "./store.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** In-memory USD-M futures stand-in: orders, conditional (algo) orders, one position and a trade list. */
function fakeFutures({ balance = 1000, hedge = false } = {}) {
  const state = {
    nextId: 500, orders: new Map(), algos: new Map(), calls: [], position: 0, trades: [],
    failStop: false, failTarget: false, hedge, balance,
  };
  const client = {
    async getExchangeInfo() {
      return {
        symbols: [
          { symbol: "BTCUSDT", status: "TRADING", contractType: "PERPETUAL", quoteAsset: "USDT", filters: [
            { filterType: "PRICE_FILTER", tickSize: "0.10" }, { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001" }, { filterType: "MIN_NOTIONAL", notional: "5" },
          ] },
          { symbol: "BTCUSDT_261225", status: "TRADING", contractType: "CURRENT_QUARTER", quoteAsset: "USDT", filters: [] },
          { symbol: "BTCUSDC", status: "TRADING", contractType: "PERPETUAL", quoteAsset: "USDC", filters: [] },
        ],
      };
    },
    async getPositionMode() { return { dualSidePosition: state.hedge }; },
    async getBalance() { return [{ asset: "USDT", balance: String(state.balance), availableBalance: String(state.balance), crossUnPnl: "0" }]; },
    async getPositions() {
      return state.position === 0 ? [{ symbol: "BTCUSDT", positionAmt: "0" }] : [{ symbol: "BTCUSDT", positionAmt: String(state.position), entryPrice: "50000", markPrice: "50100", unRealizedProfit: "1.2", liquidationPrice: "34000", leverage: "3", marginType: "isolated", notional: String(state.position * 50100) }];
    },
    async changeMarginType(symbol, type) { state.calls.push(["marginType", symbol, type]); return {}; },
    async changeLeverage(symbol, leverage) { state.calls.push(["leverage", symbol, leverage]); return {}; },
    async createOrder(params) {
      const orderId = state.nextId++;
      state.orders.set(String(orderId), { ...params, orderId, status: "NEW", executedQty: "0" });
      state.calls.push(["order", params]);
      if (params.type === "MARKET") state.position = 0;
      return { orderId };
    },
    async getOrder(_s, orderId) {
      const order = state.orders.get(String(orderId));
      if (!order) throw new Error("APIError(code=-2013): Order does not exist.");
      return order;
    },
    async cancelOrder(_s, orderId) {
      const order = state.orders.get(String(orderId));
      if (!order || order.status === "FILLED") throw new Error("APIError(code=-2011): Unknown order sent.");
      order.status = "CANCELED";
      return { orderId };
    },
    async createCloseTrigger(params) {
      if ((params.type === "STOP_MARKET" && state.failStop) || (params.type === "TAKE_PROFIT_MARKET" && state.failTarget)) {
        throw new Error("APIError(code=-2021): Order would immediately trigger.");
      }
      const algoId = state.nextId++;
      state.algos.set(String(algoId), { ...params, algoId, algoStatus: "NEW", actualOrderId: "" });
      return { algoId };
    },
    async getAlgoOrder(algoId) { return state.algos.get(String(algoId)); },
    async cancelAlgoOrder(algoId) {
      const algo = state.algos.get(String(algoId));
      if (algo && algo.algoStatus === "NEW") algo.algoStatus = "CANCELED";
      return {};
    },
    async cancelAllAlgoOrders() { for (const a of state.algos.values()) if (a.algoStatus === "NEW") a.algoStatus = "CANCELED"; return {}; },
    async getUserTrades() { return state.trades; },
  };
  return { state, client };
}

async function makeManager(client, { settings = {}, limits = { max_open_orders: 3, max_daily_orders: 20 }, dir = fs.mkdtempSync(path.join(os.tmpdir(), "fut-")) } = {}) {
  const store = new FileStore({ dir });
  const manager = new FuturesManager({
    getClient: () => client,
    getMode: () => "paper",
    getRiskSettings: () => normalizeSettings(settings),
    getLimits: () => limits,
    store,
    pollMs: 10,
  });
  await manager.init();
  return { manager, store, dir };
}

const longTicket = { symbol: "BTCUSDT", entry_price: 50000, margin_usdt: 100, leverage: 3, stop_loss_price: 49500, take_profit_price: 51500 };
const shortTicket = { symbol: "BTCUSDT", entry_price: 50000, margin_usdt: 100, leverage: 3, stop_loss_price: 50500, take_profit_price: 48500 };

const fillEntry = (state, order, price = "50000") => {
  const entry = state.orders.get(order.entry_order_id);
  Object.assign(entry, { status: "FILLED", executedQty: entry.quantity, avgPrice: price, updateTime: Date.now() });
  state.position = (entry.side === "BUY" ? 1 : -1) * Number(entry.quantity);
};

test("long: limit entry, isolated margin and leverage, then stop-loss and take-profit close the position; take-profit fills", async () => {
  const { state, client } = fakeFutures();
  const { manager } = await makeManager(client);
  const order = await manager.createOrder(longTicket);

  assert.equal(order.status, "WAITING_ENTRY");
  assert.equal(order.side, "LONG");
  assert.equal(order.quantity, 0.006); // 100 margin x 3 / 50000
  assert.equal(order.notional_usdt, 300);
  assert.deepEqual(state.calls.filter((c) => c[0] !== "order"), [["marginType", "BTCUSDT", "ISOLATED"], ["leverage", "BTCUSDT", 3]]);
  const entry = state.orders.get(order.entry_order_id);
  assert.deepEqual([entry.side, entry.type, entry.quantity, entry.price, entry.timeInForce], ["BUY", "LIMIT", "0.006", "50000", "GTC"]);

  fillEntry(state, order);
  await sleep(80);
  const protectedOrder = manager.listOrders("paper")[0];
  assert.equal(protectedOrder.status, "PROTECTED");
  const algos = [...state.algos.values()];
  assert.equal(algos.length, 2);
  const sl = algos.find((a) => a.type === "STOP_MARKET");
  const tp = algos.find((a) => a.type === "TAKE_PROFIT_MARKET");
  assert.deepEqual([sl.side, sl.triggerPrice], ["SELL", "49500"]);
  assert.deepEqual([tp.side, tp.triggerPrice], ["SELL", "51500"]);

  // Take-profit triggers on Binance: the manager cancels the stop and books the trade from Binance's own trade list.
  Object.assign(tp, { algoStatus: "FINISHED", actualOrderId: "9001" });
  state.position = 0;
  state.trades = [
    { symbol: "BTCUSDT", side: "BUY", qty: "0.006", price: "50000", realizedPnl: "0", commission: "0.15", commissionAsset: "USDT", time: Date.now() },
    { symbol: "BTCUSDT", side: "SELL", qty: "0.006", price: "51500", realizedPnl: "9", commission: "0.15", commissionAsset: "USDT", time: Date.now() + 5 },
  ];
  await sleep(120);
  const closed = manager.listOrders("paper")[0];
  assert.equal(closed.status, "CLOSED");
  assert.equal(closed.message, "Take-profit triggered");
  assert.equal(closed.exit_price, 51500);
  assert.equal(closed.realized_profit_usdt, 8.7); // 9 realized - 0.30 commissions
  assert.equal(sl.algoStatus, "CANCELED", "the other leg is cancelled");
  assert.ok(closed.closed_at, "close time is recorded for the risk rules");
  manager.stop();
});

test("short: entry is a SELL and the protection is on the other side", async () => {
  const { state, client } = fakeFutures();
  const { manager } = await makeManager(client);
  const order = await manager.createOrder(shortTicket);
  assert.equal(order.side, "SHORT");
  assert.equal(state.orders.get(order.entry_order_id).side, "SELL");
  fillEntry(state, order);
  await sleep(80);
  const algos = [...state.algos.values()];
  assert.ok(algos.every((a) => a.side === "BUY"));
  assert.equal(algos.find((a) => a.type === "STOP_MARKET").triggerPrice, "50500");
  assert.equal(algos.find((a) => a.type === "TAKE_PROFIT_MARKET").triggerPrice, "48500");
  manager.stop();
});

test("if the stop-loss cannot be placed, the filled position is closed instead of left unprotected", async () => {
  const { state, client } = fakeFutures();
  state.failStop = true;
  const { manager } = await makeManager(client);
  const order = await manager.createOrder(longTicket);
  fillEntry(state, order);
  await sleep(80);
  const failed = manager.listOrders("paper")[0];
  assert.equal(failed.status, "ERROR");
  assert.match(failed.message, /Stop-loss could not be placed/);
  assert.match(failed.message, /closed at market/);
  const close = [...state.orders.values()].find((o) => o.type === "MARKET");
  assert.deepEqual([close.side, close.reduceOnly, close.quantity], ["SELL", "true", "0.006"]);
  assert.equal(state.position, 0);
  manager.stop();
});

test("a take-profit that fails is retried and a stop-loss cancelled by hand is placed again", async () => {
  const { state, client } = fakeFutures();
  state.failTarget = true;
  const { manager } = await makeManager(client);
  const order = await manager.createOrder(longTicket);
  fillEntry(state, order);
  await sleep(60);
  let current = manager.listOrders("paper")[0];
  assert.equal(current.status, "PROTECTED");
  assert.equal(current.tp_algo_id, null);

  state.failTarget = false;
  await sleep(80);
  current = manager.listOrders("paper")[0];
  assert.ok(current.tp_algo_id, "the missing take-profit was placed");

  state.algos.get(current.sl_algo_id).algoStatus = "CANCELED"; // someone cancels the stop on Binance
  await sleep(80);
  const replaced = manager.listOrders("paper")[0];
  assert.notEqual(replaced.sl_algo_id, current.sl_algo_id);
  assert.equal(state.algos.get(replaced.sl_algo_id).algoStatus, "NEW");
  manager.stop();
});

test("a position closed outside the app (or liquidated) closes the record", async () => {
  const { state, client } = fakeFutures();
  const { manager } = await makeManager(client);
  const order = await manager.createOrder(longTicket);
  fillEntry(state, order);
  await sleep(60);
  state.position = 0;
  state.trades = [{ symbol: "BTCUSDT", side: "SELL", qty: "0.006", price: "49000", realizedPnl: "-6", commission: "0.15", commissionAsset: "USDT", time: Date.now() + 5 }];
  await sleep(120);
  const closed = manager.listOrders("paper")[0];
  assert.equal(closed.status, "CLOSED");
  assert.match(closed.message, /closed on Binance/);
  assert.equal(closed.realized_profit_usdt, -6.15);
  manager.stop();
});

test("cancelling a waiting entry, and closing a protected position at market", async () => {
  const { state, client } = fakeFutures();
  const { manager } = await makeManager(client);
  manager.pollMs = 60_000;
  const waiting = await manager.createOrder(longTicket);
  assert.equal((await manager.cancelOrder(waiting.id)).status, "CANCELLED");

  const { manager: m2 } = await makeManager(client);
  m2.pollMs = 10;
  const order = await m2.createOrder(longTicket);
  fillEntry(state, order);
  await sleep(60);
  state.trades = [{ symbol: "BTCUSDT", side: "SELL", qty: "0.006", price: "50100", realizedPnl: "0.6", commission: "0.15", commissionAsset: "USDT", time: Date.now() + 5 }];
  const done = await m2.cancelOrder(order.id);
  assert.equal(done.status, "CLOSED");
  assert.equal(done.message, "Position closed at market");
  assert.equal(state.position, 0);
  manager.stop();
  m2.stop();
});

test("orders the futures rules refuse never reach Binance", async () => {
  const { state, client } = fakeFutures();
  const { manager } = await makeManager(client);
  const reach = () => state.calls.filter((c) => c[0] === "order").length;

  // above the user's leverage limit (default 5x)
  await assert.rejects(manager.createOrder({ ...longTicket, leverage: 8 }), /above your 5× limit/);
  // stop too close to liquidation: 20x liquidates about 4.5% away, a 6% stop cannot work
  await assert.rejects(manager.createOrder({ ...longTicket, leverage: 20, stop_loss_price: 47000, take_profit_price: 56000 }), /liquidated about/);
  // too much risk: 1% of 1000 = 10 USDT, this stop would lose ~30
  await assert.rejects(manager.createOrder({ ...longTicket, margin_usdt: 300, leverage: 5, stop_loss_price: 49000, take_profit_price: 52500 }), /Risk per trade/);
  // prices that do not describe a long or a short
  await assert.rejects(manager.createOrder({ ...longTicket, take_profit_price: 49000 }), /Prices must satisfy/);
  // more margin than the account has
  await assert.rejects(manager.createOrder({ ...longTicket, margin_usdt: 5000 }), /Insufficient futures margin/);
  // below the exchange minimum
  await assert.rejects(manager.createOrder({ symbol: "BTCUSDT", entry_price: 100, margin_usdt: 0.5, leverage: 1, stop_loss_price: 99, take_profit_price: 103 }), /below Binance's minimum/);
  // dated and non-USDT contracts
  await assert.rejects(manager.createOrder({ ...longTicket, symbol: "BTCUSDT_261225" }), /dated contract/);
  await assert.rejects(manager.createOrder({ ...longTicket, symbol: "BTCUSDC" }), /USDT-margined/);
  assert.equal(reach(), 0, "nothing was sent");
  assert.equal(state.calls.filter((c) => c[0] === "leverage").length, 0, "and the account settings were not touched");
});

test("account safety: hedge mode, an existing position and a second order on the same contract are refused", async () => {
  const hedge = fakeFutures({ hedge: true });
  assert.rejects((await makeManager(hedge.client)).manager.createOrder(longTicket), /Hedge Mode/);

  const held = fakeFutures();
  held.state.position = 0.01;
  await assert.rejects((await makeManager(held.client)).manager.createOrder(longTicket), /already have an open BTCUSDT position/);

  const { state, client } = fakeFutures();
  const { manager } = await makeManager(client);
  manager.pollMs = 60_000;
  await manager.createOrder(longTicket);
  await assert.rejects(manager.createOrder(longTicket), /already an active BTCUSDT futures order/);
  assert.equal(state.calls.filter((c) => c[0] === "order").length, 1);
});

test("order limits apply to futures orders", async () => {
  const { client } = fakeFutures();
  const { manager } = await makeManager(client, { limits: { max_open_orders: 1, max_daily_orders: 5 } });
  manager.pollMs = 60_000;
  await manager.createOrder(longTicket);
  await assert.rejects(manager.createOrder({ ...longTicket, symbol: "ETHUSDT" }), /Maximum open orders reached/);
});

test("futures orders are stored with the spot ones but each manager only loads its own", async () => {
  const { client } = fakeFutures();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fut-shared-"));
  const { manager, store } = await makeManager(client, { dir });
  manager.pollMs = 60_000;
  const order = await manager.createOrder(longTicket);
  await manager.flush();

  const spot = new OrderManager({ getClient: () => ({}), getMode: () => "paper", getTradingFee: async () => ({}), store });
  await spot.init();
  assert.equal(spot.listOrders("paper").length, 0, "the spot manager ignores futures orders");

  const restarted = new FuturesManager({ getClient: () => client, getMode: () => "paper", getRiskSettings: () => ({ ...RISK_DEFAULTS }), getLimits: () => ({ max_open_orders: 3, max_daily_orders: 9 }), store, pollMs: 60_000 });
  await restarted.init();
  assert.equal(restarted.listOrders("paper")[0].id, order.id);
  assert.equal(restarted.listOrders("paper")[0].side, "LONG");
});

test("helpers: symbol info, positions and trade summary", () => {
  const info = futuresSymbolInfo({ symbols: [{ symbol: "X", status: "TRADING", contractType: "PERPETUAL", quoteAsset: "USDT", filters: [{ filterType: "PRICE_FILTER", tickSize: "0.01" }, { filterType: "LOT_SIZE", stepSize: "0.1", minQty: "0.1" }, { filterType: "MIN_NOTIONAL", notional: "5" }] }] }, "X");
  assert.deepEqual(info, { tickSize: 0.01, stepSize: 0.1, minQty: 0.1, minNotional: 5, quoteAsset: "USDT" });
  assert.equal(parsePosition({ positionAmt: "0" }), null);
  assert.equal(parsePosition({ symbol: "X", positionAmt: "-2", entryPrice: "10", markPrice: "9", unRealizedProfit: "2", liquidationPrice: "0", leverage: "5", marginType: "isolated" }).side, "SHORT");
  const sum = summarizeTrades([
    { symbol: "X", side: "SELL", qty: "1", price: "10", realizedPnl: "0", commission: "0.01", commissionAsset: "USDT", time: 10_000 },
    { symbol: "X", side: "BUY", qty: "1", price: "9", realizedPnl: "1", commission: "0.01", commissionAsset: "USDT", time: 20_000 },
    { symbol: "X", side: "BUY", qty: "5", price: "1", realizedPnl: "50", commission: "0", commissionAsset: "USDT", time: 1 }, // before this trade
  ], { symbol: "X", side: "SHORT", entry_filled_at: new Date(10_000).toISOString() });
  assert.deepEqual([sum.price, sum.quantity, Math.round(sum.profit * 100) / 100], [9, 1, 0.98]);
});

// ---- shared risk rules with shorts and leverage ----

const baseState = { capital: 1000, openRisk: 0, blockers: [] };

test("risk: a short's loss and gain mirror a long's, fees included", () => {
  const long = estimateTrade({ entry: 100, stop: 99, target: 103, quantity: 1, feePercent: 0.05 });
  const short = estimateTrade({ entry: 100, stop: 101, target: 97, quantity: 1, feePercent: 0.05, side: "short" });
  assert.ok(Math.abs(long.riskUsd - short.riskUsd) < 0.2 && short.riskUsd > 1);
  assert.ok(short.rewardUsd > 2.7 && short.rewardUsd < 3);
});

test("risk: leverage cap, liquidation buffer and margin-based size limit", () => {
  const ok = { entry: 100, stop: 99, target: 103, quantity: 3, feePercent: 0.05, leverage: 3 };
  const good = checkOrder({ settings: RISK_DEFAULTS, state: baseState, order: ok });
  assert.equal(good.allowed, true);
  assert.equal(good.marginUsd, 100);
  assert.ok(Math.abs(good.liquidationPct - 32.83) < 0.01);

  // margin is what the 25% size limit measures: 300 notional at 3x is 10% of capital, so allowed; at 1x it would be 30%
  assert.equal(checkOrder({ settings: RISK_DEFAULTS, state: baseState, order: { ...ok, leverage: 1 } }).violations.some((v) => v.code === "position_size"), true);

  const tooHigh = checkOrder({ settings: RISK_DEFAULTS, state: baseState, order: { ...ok, leverage: 10 } });
  assert.ok(tooHigh.violations.some((v) => v.code === "leverage"));

  const nearLiq = checkOrder({ settings: { ...RISK_DEFAULTS, enabled: false }, state: baseState, order: { entry: 100, stop: 94, target: 112, quantity: 1, feePercent: 0.05, leverage: 20 } });
  assert.ok(nearLiq.violations.some((v) => v.code === "liquidation"), "the liquidation rule holds even with the limits switched off");
  assert.ok(nearLiq.maxSafeLeverage >= 1 && nearLiq.maxSafeLeverage < 20);

  assert.throws(() => normalizeSettings({ maxLeverage: 0 }), /maxLeverage/);
  assert.equal(normalizeSettings({ maxLeverage: 10 }).maxLeverage, 10);
});

test("risk: futures setup sizes a short on the margin, with the stop above and the target below", () => {
  const settings = { ...RISK_DEFAULTS };
  const short = riskSetup({ settings, state: baseState, price: 100, atrPct: 0.8, availableQuote: 1000, feePercent: 0.05, side: "short", leverage: 3, futures: true });
  assert.ok(short.stopPrice > 100 && short.targetPrice < 100);
  assert.equal(short.side, "short");
  assert.ok(short.riskPct <= settings.riskPerTradePct + 1e-6);
  assert.ok(Math.abs(short.capitalUsd - short.positionValue / 3) < 1e-9, "the margin is the notional divided by leverage");
  const check = checkOrder({ settings, state: baseState, order: { entry: 100, stop: short.stopPrice, target: short.targetPrice, quantity: short.positionValue / 100, feePercent: 0.05, side: "short", leverage: 3 } });
  assert.ok(check.rewardRisk >= 1.9, `net reward:risk ${check.rewardRisk}`);
  assert.equal(check.violations.filter((v) => v.code !== "position_size").length, 0);
});

// ---- the client and the HTTP layer ----

test("futures client signs requests for the live host and uses the algo endpoint for stop and target", async () => {
  const saved = { fetch: globalThis.fetch, key: process.env.BINANCE_FUTURES_API_KEY_real, secret: process.env.BINANCE_FUTURES_API_SECRET_real };
  process.env.BINANCE_FUTURES_API_KEY_real = "test-key";
  process.env.BINANCE_FUTURES_API_SECRET_real = "test-secret";
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), method: init.method, headers: init.headers });
    return new Response(JSON.stringify(String(url).includes("/time") ? { serverTime: Date.now() } : { algoId: 1 }), { status: 200 });
  };
  try {
    const client = new FuturesTradingClient("live");
    await client.createCloseTrigger({ symbol: "BTCUSDT", side: "SELL", type: "STOP_MARKET", triggerPrice: "49500" });
    const call = seen.find((c) => c.url.includes("/algoOrder"));
    const url = new URL(call.url);
    assert.equal(url.origin, "https://fapi.binance.com");
    assert.equal(url.pathname, "/fapi/v1/algoOrder");
    assert.equal(call.method, "POST");
    assert.equal(call.headers["X-MBX-APIKEY"], "test-key");
    assert.deepEqual(
      ["algoType", "symbol", "side", "type", "triggerPrice", "closePosition", "workingType"].map((k) => url.searchParams.get(k)),
      ["CONDITIONAL", "BTCUSDT", "SELL", "STOP_MARKET", "49500", "true", "MARK_PRICE"],
    );
    assert.match(url.searchParams.get("signature"), /^[0-9a-f]{64}$/);
    assert.ok(seen.some((c) => c.url.includes("/fapi/v1/time")), "time is synced on the futures host");

    delete process.env.BINANCE_FUTURES_API_KEY_real;
    await assert.rejects(new FuturesTradingClient("live").getBalance(), /Missing Binance live futures credentials/);
  } finally {
    globalThis.fetch = saved.fetch;
    for (const [name, value] of [["BINANCE_FUTURES_API_KEY_real", saved.key], ["BINANCE_FUTURES_API_SECRET_real", saved.secret]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("HTTP: futures routes validate input, and report when futures trading is unavailable", async () => {
  const { client } = fakeFutures();
  const { manager: futures, store } = await makeManager(client);
  const spot = new OrderManager({ getClient: () => ({}), getMode: () => "paper", getTradingFee: async () => ({}), store });
  await spot.init();

  const { app } = createApp({ orderManager: spot, futuresManager: futures });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  try {
    const post = (url, body) => fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post("/futures/orders", { ...longTicket, leverage: 2.5 })).status, 422);
    assert.equal((await post("/futures/orders", { ...longTicket, symbol: "x" })).status, 422);
    assert.equal((await post("/futures/orders", { ...longTicket, entry_price: "50000" })).status, 422);
    assert.equal((await post("/futures/positions/close", {})).status, 422);
    const created = await post("/futures/orders", longTicket);
    assert.equal(created.status, 200);
    const body = await created.json();
    assert.equal(body.side, "LONG");
    const list = await (await fetch(`${base}/futures/orders?mode=paper`)).json();
    assert.equal(list.orders.length, 1);
    assert.equal((await fetch(`${base}/orders?mode=paper`).then((r) => r.json())).orders.length, 0, "spot list is separate");
    const cancelled = await (await fetch(`${base}/futures/orders/${body.id}`, { method: "DELETE" })).json();
    assert.equal(cancelled.status, "CANCELLED");
  } finally {
    server.close();
    futures.stop();
  }

  const { app: bare } = createApp({ orderManager: spot });
  const bareServer = bare.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${bareServer.address().port}/api/futures/orders`);
    assert.equal(res.status, 503);
  } finally {
    bareServer.close();
  }
});
