import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as binance from "./binance.js";
import { OrderManager } from "./orders.js";
import { PaperFuturesClient, PaperSpotClient, paperSummary, resetPaperBroker, setPaperFuturesBalance, setPaperSpotBalance } from "./paperBroker.js";
import { FileStore } from "./store.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Public market data (exchange rules, live price) is real Binance data even in tests, so every public
// endpoint the paper clients touch is faked here. Prices are mutable module state the tests move around
// to simulate the market crossing an order's price.
let spotPrice = 50;
let futuresPrice = 50000;

function spotExchangeInfo() {
  return {
    symbols: [{
      symbol: "XLMUSDT", status: "TRADING", baseAsset: "XLM", quoteAsset: "USDT",
      filters: [
        { filterType: "PRICE_FILTER", tickSize: "0.0001" },
        { filterType: "LOT_SIZE", stepSize: "0.1", minQty: "0.1" },
        { filterType: "NOTIONAL", minNotional: "5" },
      ],
    }],
  };
}
function futuresExchangeInfo() {
  return {
    symbols: [{
      symbol: "BTCUSDT", status: "TRADING", contractType: "PERPETUAL", quoteAsset: "USDT",
      filters: [
        { filterType: "PRICE_FILTER", tickSize: "0.1" },
        { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001" },
        { filterType: "MIN_NOTIONAL", notional: "5" },
      ],
    }],
  };
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const ok = (body) => new Response(JSON.stringify(body), { status: 200 });
  if (u.pathname === "/api/v3/exchangeInfo") return ok(spotExchangeInfo());
  if (u.pathname === "/api/v3/ticker/price") return ok({ symbol: u.searchParams.get("symbol"), price: String(spotPrice) });
  if (u.pathname === "/api/v3/time") return ok({ serverTime: Date.now() });
  if (u.pathname === "/fapi/v1/exchangeInfo") return ok(futuresExchangeInfo());
  if (u.pathname === "/fapi/v1/ticker/price") return ok({ symbol: u.searchParams.get("symbol"), price: String(futuresPrice) });
  if (u.pathname === "/fapi/v1/time") return ok({ serverTime: Date.now() });
  throw new Error(`Unexpected fetch in paperBroker.test.js: ${u.pathname}`);
};
test.after(() => { globalThis.fetch = realFetch; });

test("binance.js routes paper mode to the simulated clients, live mode to the real ones", () => {
  assert.ok(binance.getClient("paper") instanceof PaperSpotClient);
  assert.ok(binance.getFuturesTrader("paper") instanceof PaperFuturesClient);
  assert.ok(!(binance.getClient("live") instanceof PaperSpotClient));
  assert.equal(binance.isPaper("paper"), true);
  assert.equal(binance.isPaper("live"), false);
});

test("paper spot: a limit buy locks the quote balance, fills once price reaches it, and the OCO take-profit closes it", async () => {
  resetPaperBroker(1000, 1000);
  const client = new PaperSpotClient();
  spotPrice = 50;

  const before = await client.getAccount();
  assert.equal(before.balances.find((b) => b.asset === "USDT").free, "1000");

  const entry = await client.createOrder({ symbol: "XLMUSDT", side: "BUY", type: "LIMIT", quantity: "10", price: "49" });
  assert.equal(entry.status, "NEW");

  const locked = await client.getAccount();
  const usdtLocked = locked.balances.find((b) => b.asset === "USDT");
  assert.ok(Number(usdtLocked.free) < 1000, "the order's cost is reserved, not spent");
  assert.ok(Number(usdtLocked.locked) > 0);

  // Price is still above the limit: the order has not filled yet.
  assert.equal((await client.getOrder("XLMUSDT", entry.orderId)).status, "NEW");

  spotPrice = 49; // price reaches the limit
  const filled = await client.getOrder("XLMUSDT", entry.orderId);
  assert.equal(filled.status, "FILLED");
  assert.equal(filled.executedQty, "10");

  const afterFill = await client.getAccount();
  assert.equal(Number(afterFill.balances.find((b) => b.asset === "XLM").free), 10);
  assert.equal(Number(afterFill.balances.find((b) => b.asset === "USDT").locked), 0);

  const oco = await client.createSellOco({ symbol: "XLMUSDT", quantity: "10", takeProfitPrice: "55", stopPrice: "45", stopLimitPrice: "44.9" });
  assert.equal(oco.orders.length, 2);
  const [tpId, slId] = oco.orders.map((o) => o.orderId);

  spotPrice = 56; // above the take-profit price
  const tp = await client.getOrder("XLMUSDT", tpId);
  assert.equal(tp.status, "FILLED");
  const sl = await client.getOrder("XLMUSDT", slId);
  assert.equal(sl.status, "CANCELED", "the sibling leg of the OCO is cancelled once one side fills");

  const after = await client.getAccount();
  assert.equal(Number(after.balances.find((b) => b.asset === "XLM").free), 0);
  assert.ok(Number(after.balances.find((b) => b.asset === "USDT").free) > 1000, "selling above the entry grew the balance");
});

test("paper spot: cancelling a resting limit entry releases the locked balance", async () => {
  resetPaperBroker(1000, 1000);
  const client = new PaperSpotClient();
  spotPrice = 50;
  const entry = await client.createOrder({ symbol: "XLMUSDT", side: "BUY", type: "LIMIT", quantity: "10", price: "49" });
  assert.ok(Number((await client.getAccount()).balances.find((b) => b.asset === "USDT").locked) > 0);

  await client.cancelOrder("XLMUSDT", entry.orderId);
  const after = await client.getAccount();
  const usdt = after.balances.find((b) => b.asset === "USDT");
  assert.equal(usdt.free, "1000");
  assert.equal(usdt.locked, "0");
});

test("paper spot: an order costing more than the free balance is refused", async () => {
  resetPaperBroker(10, 1000);
  const client = new PaperSpotClient();
  spotPrice = 50;
  await assert.rejects(
    client.createOrder({ symbol: "XLMUSDT", side: "BUY", type: "LIMIT", quantity: "10", price: "49" }),
    /insufficient balance/i,
  );
});

test("fee methods return the same already-processed {maker_percent, taker_percent} shape the real clients return", async () => {
  const spot = await new PaperSpotClient().getTradeFee("XLMUSDT");
  assert.equal(typeof spot.maker_percent, "number");
  assert.equal(typeof spot.taker_percent, "number");

  const futures = await new PaperFuturesClient().getCommission("BTCUSDT");
  assert.equal(typeof futures.maker_percent, "number");
  assert.equal(typeof futures.taker_percent, "number");
});

test("paper futures: a filled long is protected by stop/take-profit, and margin/wallet track correctly", async () => {
  resetPaperBroker(1000, 1000);
  const client = new PaperFuturesClient();
  futuresPrice = 50000;

  await client.changeLeverage("BTCUSDT", 10);
  const before = (await client.getBalance())[0];
  assert.equal(before.balance, "1000");
  assert.equal(before.availableBalance, "1000");

  const entry = await client.createOrder({ symbol: "BTCUSDT", side: "BUY", type: "LIMIT", quantity: "0.02", price: "50000" });
  assert.equal(entry.status, "NEW");
  const reserved = (await client.getBalance())[0];
  assert.equal(Number(reserved.availableBalance), 900, "0.02 x 50000 / 10x leverage = 100 margin reserved");

  const filled = await client.getOrder("BTCUSDT", entry.orderId);
  assert.equal(filled.status, "FILLED");

  const openPosition = (await client.getPositions("BTCUSDT"))[0];
  assert.equal(openPosition.positionAmt, "0.02");
  assert.equal(openPosition.leverage, "10");

  const stop = await client.createCloseTrigger({ symbol: "BTCUSDT", side: "SELL", type: "STOP_MARKET", triggerPrice: "49000" });
  const target = await client.createCloseTrigger({ symbol: "BTCUSDT", side: "SELL", type: "TAKE_PROFIT_MARKET", triggerPrice: "52000" });

  futuresPrice = 52500; // above the take-profit trigger
  const tpStatus = await client.getAlgoOrder(target.algoId);
  assert.equal(tpStatus.algoStatus, "FINISHED");

  const closedPosition = (await client.getPositions("BTCUSDT"))[0];
  assert.equal(closedPosition.positionAmt, "0");

  const wallet = (await client.getBalance())[0];
  assert.ok(Number(wallet.balance) > 1000, "closing above the entry realized a profit");

  const stopStatus = await client.getAlgoOrder(stop.algoId);
  assert.equal(stopStatus.algoStatus, "CANCELED", "the other leg is cancelled once the position closes");

  const trades = await client.getUserTrades("BTCUSDT", 0);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].side, "SELL");
});

test("paper futures: an adverse move past the liquidation price force-closes the position without going negative", async () => {
  resetPaperBroker(1000, 1000);
  const client = new PaperFuturesClient();
  futuresPrice = 50000;
  await client.changeLeverage("BTCUSDT", 20); // liquidation is close: about 100/20 - 0.5 = 4.5% away
  const entry = await client.createOrder({ symbol: "BTCUSDT", side: "BUY", type: "LIMIT", quantity: "0.02", price: "50000" });
  await client.getOrder("BTCUSDT", entry.orderId); // fills at 50000 (price already at the limit)

  futuresPrice = 40000; // well past the liquidation price for a 20x long
  const positions = await client.getPositions("BTCUSDT");
  assert.equal(positions[0].positionAmt, "0", "the position was liquidated");
  const wallet = (await client.getBalance())[0];
  assert.ok(Number(wallet.balance) < 1000, "liquidation loses the position's margin");
  assert.ok(Number(wallet.balance) >= 0, "isolated margin never goes negative");
});

test("paper futures: a market close settles an open position at the current price", async () => {
  resetPaperBroker(1000, 1000);
  const client = new PaperFuturesClient();
  futuresPrice = 50000;
  await client.changeLeverage("BTCUSDT", 5);
  const entry = await client.createOrder({ symbol: "BTCUSDT", side: "BUY", type: "LIMIT", quantity: "0.01", price: "50000" });
  await client.getOrder("BTCUSDT", entry.orderId);
  assert.equal((await client.getPositions("BTCUSDT"))[0].positionAmt, "0.01");

  futuresPrice = 51000;
  await client.createOrder({ symbol: "BTCUSDT", side: "SELL", type: "MARKET", quantity: "0.01", reduceOnly: "true" });
  assert.equal((await client.getPositions("BTCUSDT"))[0].positionAmt, "0");
  const wallet = (await client.getBalance())[0];
  assert.ok(Number(wallet.balance) > 1000);
});

test("editing the paper balance directly overwrites it, and resetting restores a clean starting balance", () => {
  resetPaperBroker(1000, 1000);
  setPaperSpotBalance("USDT", 5000);
  setPaperFuturesBalance(2000);
  const summary = paperSummary();
  assert.equal(summary.spot.free, 5000);
  assert.equal(summary.futures.wallet, 2000);

  resetPaperBroker(250, 750);
  const after = paperSummary();
  assert.equal(after.spot.free, 250);
  assert.equal(after.futures.wallet, 750);
});

test("a negative paper balance is refused", () => {
  resetPaperBroker(1000, 1000);
  assert.throws(() => setPaperSpotBalance("USDT", -1), /zero or a positive number/);
  assert.throws(() => setPaperFuturesBalance(-1), /zero or a positive number/);
});

test("integration: OrderManager creates and fills a paper order through the real binance.js wiring", async () => {
  resetPaperBroker(1000, 1000);
  spotPrice = 50;
  const store = new FileStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "paper-order-")) });
  const manager = new OrderManager({ getClient: binance.getClient, getMode: () => "paper", getTradingFee: binance.getTradingFee, store, pollMs: 10 });
  await manager.init();

  const order = await manager.createOrder({ symbol: "XLMUSDT", entry_price: 49, capital_usdt: 100, stop_loss_price: 45, take_profit_price: 60 });
  assert.equal(order.status, "WAITING_ENTRY");
  assert.ok(order.quantity > 0);

  spotPrice = 49; // price reaches the limit entry
  await sleep(80);
  assert.equal(manager.listOrders("paper")[0].status, "PROTECTED");

  spotPrice = 60; // above the take-profit
  await sleep(80);
  const closed = manager.listOrders("paper")[0];
  assert.equal(closed.status, "CLOSED");
  assert.ok(closed.realized_profit_usdt > 0);
  manager.stop();
});
