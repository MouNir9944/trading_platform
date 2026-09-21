import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizeSettings } from "../shared/risk.js";
import { createApp } from "./app.js";
import { AutoAmd } from "./autoAmd.js";
import { Notifier } from "./notifier.js";
import { OrderManager } from "./orders.js";
import { FileStore } from "./store.js";

const bar = (i, open, high, low, close) => ({ time: 1_700_000_000 + i * 900, open, high, low, close, volume: 100 });
function noisy(seed, n = 900) {
  let x = seed;
  const rand = () => { x = (x * 1664525 + 1013904223) % 4294967296; return x / 4294967296; };
  const out = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const squeeze = Math.floor(i / 45) % 2 === 0;
    const step = (rand() - 0.5) * (squeeze ? 0.6 : 2.4);
    const open = price;
    const close = price + step;
    const spike = rand() < 0.08 ? rand() * 1.6 : 0;
    out.push(bar(i, open, Math.max(open, close) + rand() * 0.4 + (rand() < 0.5 ? spike : 0), Math.min(open, close) - rand() * 0.4 - (rand() < 0.5 ? spike : 0), close));
    price = close;
  }
  return out;
}

async function harness({ withBot = true } = {}) {
  const store = new FileStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "amdr-")) });
  const notifier = new Notifier({ store, env: {}, fetchFn: async () => new Response("{}") });
  await notifier.init();
  const spot = new OrderManager({ getClient: () => ({}), getMode: () => "testnet", getTradingFee: async () => ({}), store });
  await spot.init();
  const mode = { value: "testnet" };
  const fakeManager = { listOrders: () => [], createOrder: async () => ({ id: "x", status: "WAITING_ENTRY" }), getRiskState: () => ({ capital: 1000, openRisk: 0, blockers: [] }) };
  const bot = new AutoAmd({
    store, notifier, getMode: () => mode.value, getKlines: async () => [],
    managers: { spot: fakeManager, futures: fakeManager }, getRiskSettings: () => normalizeSettings({}),
    getBalance: async () => ({ wallet: 1000, available: 1000 }),
  });
  await bot.init();
  const history = async (market, symbol, interval, total) => {
    if (symbol === "BROKEUSDT") throw new Error("Binance answered 400");
    return noisy(symbol.length + (market === "spot" ? 100 : 0), Math.min(total, 900));
  };
  const { app } = createApp({ orderManager: spot, ...(withBot ? { autoAmd: bot, notifier } : {}), amdHistory: history });
  const server = app.listen(0);
  const call = async (method, url, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api${url}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  return { call, server, mode, notifier, bot };
}

test("bot config: read, change, validate, and arm with the LIVE confirmation", async () => {
  const { call, server, mode } = await harness();
  try {
    const initial = await call("GET", "/amd/config");
    assert.equal(initial.status, 200);
    assert.equal(initial.body.orders, false);
    assert.equal(initial.body.watch, false, "everything starts switched off");

    const saved = await call("PUT", "/amd/config", { pairs: [{ symbol: "btcusdt", interval: "15m" }], market: "spot", watch: true });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.config.pairs, [{ symbol: "BTCUSDT", interval: "15m" }]);
    assert.equal(saved.body.status.watching, true);

    assert.equal((await call("PUT", "/amd/config", { leverage: 99 })).status, 422);
    assert.equal((await call("PUT", "/amd/config", { hack: true })).status, 422);
    assert.equal((await call("PUT", "/amd/config", { armedMode: "live" })).status, 200, "armedMode in a patch is ignored");
    assert.equal((await call("GET", "/amd/config")).body.armedMode, null);

    assert.equal((await call("PUT", "/amd/config", { orders: true })).body.config.armedMode, "testnet");
    await call("PUT", "/amd/config", { orders: false });
    mode.value = "live";
    const refused = await call("PUT", "/amd/config", { orders: true });
    assert.equal(refused.status, 422);
    assert.match(refused.body.detail, /needs the word LIVE/);
    const ok = await call("PUT", "/amd/config", { orders: true, confirm: "LIVE" });
    assert.equal(ok.body.config.armedMode, "live");
    assert.ok(!("confirm" in ok.body.config), "the confirmation is not stored");
  } finally {
    server.close();
  }
});

test("status, scan, the bot log and the notification center", async () => {
  const { call, server, notifier } = await harness();
  try {
    await call("PUT", "/amd/config", { pairs: [{ symbol: "BTCUSDT", interval: "15m" }], market: "spot", watch: true });
    const status = await call("GET", "/amd/status");
    assert.equal(status.status, 200);
    assert.deepEqual(status.body.channels, { telegram: { configured: false }, webhook: { configured: false } });
    const scan = await call("POST", "/amd/scan");
    assert.equal(scan.status, 200);
    assert.equal(scan.body.status.pairs[0].symbol, "BTCUSDT");

    await notifier.push({ type: "signal", source: "amd", title: "From the bot" });
    await notifier.push({ type: "info", source: "system", title: "Not from the bot" });
    assert.deepEqual((await call("GET", "/amd/log")).body.events.map((e) => e.title), ["From the bot"]);
    const all = await call("GET", "/notifications");
    assert.equal(all.body.unread, 2);
    assert.equal(all.body.events.length, 2);
    assert.equal((await call("GET", `/notifications?since=${all.body.events[0].at}`)).body.events.length, 0);
    assert.equal((await call("POST", "/notifications/read", { ids: [all.body.events[0].id] })).body.unread, 1);
    assert.equal((await call("POST", "/notifications/read", {})).body.unread, 0);
    const test = await call("POST", "/notifications/test");
    assert.equal(test.body.event.type, "test");
  } finally {
    server.close();
  }
});

test("without a bot the AMD routes say so", async () => {
  const { call, server } = await harness({ withBot: false });
  try {
    assert.equal((await call("GET", "/amd/config")).status, 503);
    assert.equal((await call("GET", "/notifications")).status, 503);
  } finally {
    server.close();
  }
});

test("backtest: validation, results per pair and pooled, the sweep, and a pair that fails to load", async () => {
  const { call, server } = await harness();
  try {
    for (const body of [{}, { symbols: [] }, { symbols: ["x"] }, { symbols: ["BTCUSDT"], interval: "1s" }, { symbols: ["BTCUSDT"], engine: { maxRangeAtr: 99 } }, { symbols: Array.from({ length: 13 }, (_, i) => `COIN${i}USDT`) }]) {
      assert.equal((await call("POST", "/amd/backtest", body)).status, 422, JSON.stringify(body).slice(0, 60));
    }
    const res = await call("POST", "/amd/backtest", { market: "futures", symbols: ["BTCUSDT", "ETHUSDT", "BROKEUSDT"], interval: "15m", candles: 900, sweep: true, engine: { minRewardRisk: 0 }, trade: { minRewardRisk: 0 } });
    assert.equal(res.status, 200);
    const b = res.body;
    assert.deepEqual(b.perSymbol.map((p) => p.symbol), ["BTCUSDT", "ETHUSDT", "BROKEUSDT"]);
    assert.equal(b.perSymbol[2].error, "Binance answered 400", "one failing pair does not fail the run");
    assert.equal(b.combined.trades, b.perSymbol[0].stats.trades + b.perSymbol[1].stats.trades);
    assert.ok(b.combined.curve.length === b.combined.trades + 1, "the pooled equity curve is included");
    assert.ok(b.perSymbol.every((p) => p.stats.curve === undefined), "per-pair curves are left out to keep the response small");
    assert.ok(b.verdict.label);
    assert.equal(b.options.trade.feePercent, 0.05, "futures fees by default");
    assert.equal(b.options.trade.shorts, true);
    assert.equal(b.sweep.length, 8);
    assert.ok(b.trades.length <= 300);

    const spot = await call("POST", "/amd/backtest", { market: "spot", symbols: ["BTCUSDT"], interval: "1h", candles: 900, engine: { minRewardRisk: 0 }, trade: { minRewardRisk: 0, shorts: true } });
    assert.equal(spot.body.options.trade.feePercent, 0.1, "spot fees by default");
    assert.equal(spot.body.options.trade.shorts, false, "spot cannot short");
    assert.ok(spot.body.trades.every((t) => t.side === "long"));
    assert.equal(spot.body.sweep, undefined);
  } finally {
    server.close();
  }
});
