import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApp } from "./app.js";
import { decimalString, formatDecimal } from "./decimal.js";
import { BinanceClient } from "./binance.js";
import { OrderManager } from "./orders.js";
import { Signal, generateSignal } from "./strategy.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("formatDecimal floors to the exchange step without float noise", () => {
  assert.equal(formatDecimal(0.30000000000000004, 0.001), 0.3);
  assert.equal(formatDecimal(55.819, 0.01), 55.81);
  assert.equal(formatDecimal(8.9599, 0.01), 8.95);
  assert.equal(formatDecimal(123.456, 1), 123);
  assert.equal(formatDecimal(0.00012345, 1e-7), 0.0001234);
  assert.equal(formatDecimal(-0.5, 1), 0);
  assert.equal(decimalString(1e-7), "0.0000001");
  assert.equal(decimalString(1.5e21), "1500000000000000000000");
});

test("generateSignal detects a confirmed bullish crossover", () => {
  // Long decline, then a sharp breakout on the last candle.
  const closes = [...Array(30).fill(0).map((_, i) => 100 - i * 0.5), 200];
  const candles = closes.map((close, i) => ({ openTime: i, open: close, high: close, low: close, close, volume: 1 }));
  assert.equal(generateSignal(candles), Signal.BUY);
  assert.equal(generateSignal(candles.slice(0, 10)), Signal.HOLD);
});

/** In-memory Binance stand-in: an entry order that we can fill on demand. */
function fakeExchange() {
  const state = { orders: new Map(), nextId: 100, ocoCalls: [], cancelled: [] };
  const client = {
    async getExchangeInfo() {
      return {
        symbols: [{
          symbol: "XLMUSDT", status: "TRADING", quoteAsset: "USDT",
          filters: [
            { filterType: "PRICE_FILTER", tickSize: "0.0001" },
            { filterType: "LOT_SIZE", stepSize: "0.1" },
          ],
        }],
      };
    },
    async getAccount() {
      return { balances: [{ asset: "USDT", free: "1000", locked: "0" }] };
    },
    async createOrder(params) {
      const orderId = state.nextId++;
      state.orders.set(String(orderId), { ...params, orderId, status: "NEW", executedQty: "0" });
      return { orderId };
    },
    async getOrder(_symbol, orderId) {
      const order = state.orders.get(String(orderId));
      if (!order) throw new Error("APIError(code=-2013): Order does not exist.");
      return order;
    },
    async cancelOrder(_symbol, orderId) {
      const order = state.orders.get(String(orderId));
      if (!order) throw new Error("APIError(code=-2011): Unknown order sent.");
      if (order.status === "FILLED") throw new Error("APIError(code=-2011): Unknown order sent.");
      order.status = "CANCELED";
      state.cancelled.push(String(orderId));
      return { orderId };
    },
    async createSellOco(params) {
      state.ocoCalls.push(params);
      const a = state.nextId++;
      const b = state.nextId++;
      state.orders.set(String(a), { orderId: a, status: "NEW" });
      state.orders.set(String(b), { orderId: b, status: "NEW" });
      return { orderListId: 7, orders: [{ orderId: a }, { orderId: b }] };
    },
    async getOrderList() {
      return { orders: [] };
    },
  };
  return { state, client };
}

function makeManager(client) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orders-"));
  const manager = new OrderManager({
    getClient: () => client,
    getMode: () => "testnet",
    getTradingFee: async () => { throw new Error("no fee endpoint on testnet"); },
    storePath: path.join(dir, "orders.json"),
    limitsPath: path.join(dir, "limits.json"),
    pollMs: 10,
  });
  return { manager, dir };
}

const ticket = {
  symbol: "XLMUSDT", entry_price: 0.25, capital_usdt: 100, stop_loss_price: 0.24, take_profit_price: 0.27,
};

test("filled entry gets an OCO, then closes with realized profit when the target fills", async () => {
  const { state, client } = fakeExchange();
  const { manager } = makeManager(client);

  const order = await manager.createOrder(ticket);
  assert.equal(order.status, "WAITING_ENTRY");
  assert.equal(order.fee_percent, 0.1); // fee endpoint failed -> default
  assert.equal(order.quantity, 399.6); // floor(100*0.999/0.25 to 0.1)
  const placed = state.orders.get(order.entry_order_id);
  assert.deepEqual([placed.side, placed.quantity, placed.price], ["BUY", "399.6", "0.25"]);

  // Entry fills -> monitor places the OCO.
  Object.assign(placed, { status: "FILLED", executedQty: "399.6" });
  await sleep(80);
  const protectedOrder = manager.listOrders("testnet")[0];
  assert.equal(protectedOrder.status, "PROTECTED");
  assert.equal(state.ocoCalls.length, 1);
  assert.deepEqual(
    { ...state.ocoCalls[0] },
    { symbol: "XLMUSDT", quantity: "399.6", takeProfitPrice: "0.27", stopPrice: "0.24", stopLimitPrice: "0.2397" },
  );

  // Take-profit leg fills -> closed.
  const tp = state.orders.get(protectedOrder.exit_order_ids[0]);
  Object.assign(tp, { status: "FILLED", executedQty: "399.6", cummulativeQuoteQty: String(399.6 * 0.27) });
  await sleep(80);
  const closed = manager.listOrders("testnet")[0];
  assert.equal(closed.status, "CLOSED");
  assert.ok(closed.realized_profit_usdt > 0);
  manager.stop();
});

test("changing the entry price never re-buys an entry that already filled", async () => {
  const { state, client } = fakeExchange();
  const { manager } = makeManager(client);
  manager.pollMs = 60_000; // keep the monitor out of the way

  const order = await manager.createOrder(ticket);
  state.orders.get(order.entry_order_id).status = "FILLED"; // filled just before the edit
  const before = state.orders.size;

  await assert.rejects(manager.modifyEntryPrice(order.id, { direction: "up" }), /already filled/);
  assert.equal(state.orders.size, before, "no replacement order may be created");
  assert.equal(manager.listOrders()[0].status, "WAITING_ENTRY");
  manager.stop();
});

test("changing a waiting entry price replaces the limit order", async () => {
  const { state, client } = fakeExchange();
  const { manager } = makeManager(client);
  manager.pollMs = 60_000;

  const order = await manager.createOrder(ticket);
  const updated = await manager.modifyEntryPrice(order.id, { direction: "up", steps: 2 });
  assert.equal(updated.entry_price, 0.2502);
  assert.notEqual(updated.entry_order_id, order.entry_order_id);
  assert.equal(state.orders.get(order.entry_order_id).status, "CANCELED");
  manager.stop();
});

test("order limits are enforced and persisted; state survives a restart", async () => {
  const { client } = fakeExchange();
  const { manager, dir } = makeManager(client);
  manager.pollMs = 60_000;
  manager.setLimits(1, 5);
  await manager.createOrder(ticket);
  await assert.rejects(manager.createOrder(ticket), /Maximum open orders/);

  const again = new OrderManager({
    getClient: () => client, getMode: () => "testnet", getTradingFee: async () => ({}),
    storePath: path.join(dir, "orders.json"), limitsPath: path.join(dir, "limits.json"), pollMs: 60_000,
  });
  assert.equal(again.listOrders().length, 1);
  assert.deepEqual(again.getLimits(), { max_open_orders: 1, max_daily_orders: 5 });
  manager.stop();
});

test("HTTP layer: basic auth, health check, validation and error shape", async () => {
  const { client } = fakeExchange();
  const { manager } = makeManager(client);
  const { app } = createApp({ orderManager: manager, auth: { username: "admin", password: "s3cret" } });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const authed = { Authorization: `Basic ${Buffer.from("admin:s3cret").toString("base64")}` };
  try {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/api/orders`)).status, 401);
    assert.equal((await fetch(`${base}/api/orders`, { headers: { Authorization: `Basic ${Buffer.from("admin:nope").toString("base64")}` } })).status, 401);

    const list = await fetch(`${base}/api/orders?mode=testnet`, { headers: authed });
    assert.equal(list.status, 200);
    assert.deepEqual((await list.json()).orders, []);

    const bad = await fetch(`${base}/api/orders/conditional`, {
      method: "POST", headers: { ...authed, "Content-Type": "application/json" },
      body: JSON.stringify({ ...ticket, entry_price: -1 }),
    });
    assert.equal(bad.status, 422);
    assert.match((await bad.json()).detail, /entry_price/);

    const badMode = await fetch(`${base}/api/orders?mode=bogus`, { headers: authed });
    assert.equal(badMode.status, 400);
  } finally {
    server.close();
    manager.stop();
  }
});

test("a Binance IP ban pauses requests instead of extending the ban", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  const until = Date.now() + 60_000;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ code: -1003, msg: `Way too much request weight used; IP banned until ${until}.` }), { status: 418 });
  };
  try {
    const client = new BinanceClient("testnet");
    await assert.rejects(client.getSymbolTicker("XLMUSDT"), /code=-1003/);
    await assert.rejects(client.getSymbolTicker("XLMUSDT"), /requests paused until/);
    await assert.rejects(client.getKlines("XLMUSDT", "1m", 1), /requests paused until/);
    assert.equal(calls, 1, "no further requests while banned");
    assert.equal(client.bannedUntil, until);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a rate-limited monitor keeps watching the entry instead of giving up", async () => {
  const { state, client } = fakeExchange();
  const { manager } = makeManager(client);
  const order = await manager.createOrder(ticket);

  let banned = true;
  const realGetOrder = client.getOrder;
  client.getOrder = async (...args) => {
    if (banned) throw Object.assign(new Error("Binance rate limit: requests paused"), { status: 429, code: -1003 });
    return realGetOrder(...args);
  };
  manager.pollMs = 5;
  await sleep(60);
  assert.equal(manager.listOrders()[0].status, "WAITING_ENTRY");

  banned = false;
  Object.assign(state.orders.get(order.entry_order_id), { status: "FILLED", executedQty: "399.6" });
  await sleep(200); // first retry is delayed by the rate-limit backoff (3 x pollMs)
  assert.equal(manager.listOrders()[0].status, "PROTECTED");
  manager.stop();
});
