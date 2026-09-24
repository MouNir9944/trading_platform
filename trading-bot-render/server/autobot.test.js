import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkOrder, computeRiskState, normalizeSettings } from "../shared/risk.js";
import { STRATEGY_BY_ID } from "../shared/strategies/index.js";
import { AutoTrader, INTERVAL_MS, createBots, normalizeAutoConfig as normalize } from "./autoTrader.js";
import { Notifier } from "./notifier.js";
import { RiskBlockedError } from "./orders.js";
import { FileStore } from "./store.js";

const AMD = STRATEGY_BY_ID.amd_fvg;
const normalizeAutoConfig = (patch, current) => normalize(AMD, patch, current);
const MS = INTERVAL_MS["15m"];
const T = Math.floor(1_800_000_000_000 / MS) * MS; // the start of the candle that is "now"
const NOW = T + 20_000;

// ---- market data: the AMD scenario, padded so there are enough candles, as Binance kline rows ----

function candleList({ extra = [], flipped = false } = {}) {
  const c = [];
  for (let i = 0; i < 40; i++) c.push(i % 2 === 0 ? [99.8, 100.6, 99.4, 100.2] : [100.2, 100.6, 99.4, 99.8]);
  for (let i = 0; i < 20; i++) c.push([i % 2 === 0 ? 99.8 : 100.2, i === 5 ? 101.7 : 100.6, i === 9 ? 98.3 : 99.4, i % 2 === 0 ? 100.2 : 99.8]);
  c.push([98.3, 98.4, 97.9, 98.3], [98.3, 99.4, 98.2, 99.3], [99.3, 99.6, 98.8, 99.4], ...extra);
  return flipped ? c.map(([o, h, l, cl]) => [200 - o, 200 - l, 200 - h, 200 - cl]) : c;
}

/** Kline rows ending with the latest CLOSED candle just before "now", plus a still-forming one. */
function klines(candles, { forming = true } = {}) {
  const lastOpen = T - MS;
  const rows = candles.map(([o, h, l, c], i) => {
    const open = lastOpen - (candles.length - 1 - i) * MS;
    return [open, o, h, l, c, 100, open + MS - 1];
  });
  if (forming) rows.push([T, 99.4, 99.5, 99.3, 99.45, 10, T + MS - 1]);
  return rows;
}

// ---- fakes ----

function fakeManager(clock, modeRef, getSettings) {
  const orders = [];
  return {
    orders,
    calls: [],
    reject: null,
    listOrders: (mode) => orders.filter((o) => o.account_mode === mode).map((o) => ({ ...o })),
    async createOrder(args) {
      if (this.reject) throw this.reject;
      const order = { id: `o${orders.length + 1}`, status: "WAITING_ENTRY", account_mode: modeRef.mode, created_at: new Date(clock.now).toISOString(), message: "", ...args };
      orders.push(order);
      this.calls.push(args);
      return { ...order };
    },
    async cancelOrder(id) {
      const order = orders.find((o) => o.id === id);
      order.status = "CANCELLED";
      order.message = "Entry order cancelled";
      return { ...order };
    },
    getRiskState: (mode, wallet) => computeRiskState({ orders: [], settings: getSettings(), capital: wallet }), // the real calculation: paused, daily loss...
  };
}

async function makeBot({ candles = candleList(), mode = "paper", risk = { minRewardRisk: 1 }, dir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-")), env = {}, fetchFn = async () => new Response("{}", { status: 200 }), rows } = {}) {
  const clock = { now: NOW };
  const modeRef = { mode };
  const store = new FileStore({ dir });
  const notifier = new Notifier({ store, env, fetchFn, now: () => clock.now });
  await notifier.init();
  const settings = () => normalizeSettings(risk);
  const spot = fakeManager(clock, modeRef, settings);
  const futures = fakeManager(clock, modeRef, settings);
  const feed = { rows: rows ?? klines(candles), calls: 0 };
  const bot = new AutoTrader({
    strategy: AMD, store, notifier,
    getMode: () => modeRef.mode,
    getKlines: async () => { feed.calls += 1; return feed.rows; },
    managers: { spot, futures },
    getRiskSettings: settings,
    getBalance: async () => ({ wallet: 1000, available: 1000 }),
    now: () => clock.now,
  });
  await bot.init();
  return { bot, notifier, spot, futures, clock, modeRef, store, feed, dir };
}

const pair = { symbol: "BTCUSDT", interval: "15m" };
const types = (notifier) => notifier.list({ limit: 50 }).events.map((e) => e.type).reverse();

// ---- config ----

test("bot settings are validated, and spot can never be set to short", () => {
  const ok = normalizeAutoConfig({ market: "spot", shorts: true, pairs: [{ symbol: "btcusdt", interval: "15m" }], leverage: 4 });
  assert.equal(ok.shorts, false, "spot is long-only");
  assert.deepEqual(ok.pairs, [{ symbol: "BTCUSDT", interval: "15m" }]);
  for (const [patch, pattern] of [
    [{ nope: 1 }, /Unknown setting/],
    [{ leverage: 50 }, /leverage must be/],
    [{ leverage: 2.5 }, /whole number/],
    [{ market: "margin" }, /market must be/],
    [{ pairs: [{ symbol: "x", interval: "15m" }] }, /not a valid symbol/],
    [{ pairs: [{ symbol: "BTCUSDT", interval: "1s" }] }, /timeframe must be/],
    [{ pairs: [pair, pair] }, /listed twice/],
    [{ pairs: Array.from({ length: 13 }, (_, i) => ({ symbol: `COIN${i}USDT`, interval: "15m" })) }, /at most 12/],
    [{ watch: "yes" }, /true or false/],
    [{ entryMode: "market" }, /entryMode/],
    [{ params: { maxRangeAtr: 99 } }, /Max range height/],
    [{ params: { nope: 1 } }, /no setting called/],
  ]) assert.throws(() => normalizeAutoConfig(patch), pattern, JSON.stringify(patch));
  assert.equal(normalizeAutoConfig({ armedMode: "live" }).armedMode, null, "arming is not a setting");
});

test("arming orders is deliberate: pairs are needed, LIVE needs the word LIVE, and it binds to the account mode", async () => {
  const { bot, modeRef } = await makeBot();
  await assert.rejects(bot.setConfig({ orders: true }), /at least one pair/);
  await bot.setConfig({ pairs: [pair], market: "spot" });
  const armed = await bot.setConfig({ orders: true });
  assert.equal(armed.armedMode, "paper");
  assert.equal(armed.watch, true, "orders imply watching");
  assert.equal(bot.status().ordering, true);

  modeRef.mode = "live";
  assert.equal(bot.status().ordering, false, "switching the account switches the orders off");
  assert.match(bot.status().blocked, /armed for paper, the account is now on live/);
  await bot.setConfig({ orders: false });
  assert.equal(bot.getConfig().armedMode, null);
  await assert.rejects(bot.setConfig({ orders: true }), /needs the word LIVE/);
  await assert.rejects(bot.setConfig({ orders: true }, { confirm: "live" }), /needs the word LIVE/, "the word must be exact");
  assert.equal((await bot.setConfig({ orders: true }, { confirm: "LIVE" })).armedMode, "live");

  const changed = await bot.setConfig({ market: "futures" });
  assert.equal(changed.orders, false, "a different market is a different bot: it must be armed again");
  assert.equal(changed.armedMode, null);
});

// ---- signals ----

test("watching: a fresh signal is announced once, from closed candles only, and a closed candle is looked at once", async () => {
  const { bot, notifier, spot, feed } = await makeBot();
  await bot.setConfig({ watch: true, pairs: [pair], market: "spot" });
  await bot.tick();
  const [signal] = notifier.list().events;
  assert.equal(signal.type, "signal");
  assert.equal(signal.dir, "bull");
  assert.match(signal.title, /AMD: sweep then fair value gap: buy signal · BTCUSDT 15m/);
  assert.ok(signal.plan.entry === 99.4 && signal.plan.stopLoss < 97.9 && signal.plan.target === 101.7);
  assert.equal(spot.calls.length, 0, "watching never orders");
  assert.equal(notifier.list().events.length, 1);

  await bot.tick();
  assert.equal(feed.calls, 1, "the same closed candle is not fetched again");
  await bot.tick({ force: true });
  assert.equal(notifier.list().events.length, 1, "and forcing a scan does not repeat a signal");
});

test("a signal that formed more than a candle ago is history, and a forming candle is ignored", async () => {
  const old = await makeBot({ candles: candleList({ extra: [[99.4, 99.9, 99.3, 99.6], [99.6, 100.0, 99.4, 99.8], [99.8, 100.1, 99.5, 99.9]] }) });
  await old.bot.setConfig({ watch: true, pairs: [pair], market: "spot" });
  await old.bot.tick();
  assert.equal(old.notifier.list().events.length, 0);

  // the same data, but the last "closed" candle is really still forming: the signal candle is then the last CLOSED one
  const rows = klines(candleList(), { forming: false });
  rows[rows.length - 1][6] = NOW + MS; // the signal candle itself has not closed yet
  const forming = await makeBot({ rows });
  await forming.bot.setConfig({ watch: true, pairs: [pair], market: "spot" });
  await forming.bot.tick();
  assert.equal(forming.notifier.list().events.length, 0, "the signal candle had not closed, so it does not count yet");
});

test("bearish setups on spot are announced as exit warnings and never ordered", async () => {
  const { bot, notifier, spot } = await makeBot({ candles: candleList({ flipped: true }) });
  await bot.setConfig({ pairs: [pair], market: "spot" });
  await bot.setConfig({ orders: true });
  await bot.tick();
  const [signal] = notifier.list().events;
  assert.equal(signal.dir, "bear");
  assert.match(signal.body, /long-only/);
  assert.equal(spot.calls.length, 0);
});

// ---- orders ----

test("armed on spot: the order comes from the plan and is sized by the risk rules", async () => {
  const { bot, notifier, spot } = await makeBot();
  await bot.setConfig({ pairs: [pair], market: "spot" });
  await bot.setConfig({ orders: true });
  await bot.tick();
  assert.equal(spot.calls.length, 1);
  const args = spot.calls[0];
  assert.deepEqual([args.symbol, args.entry_price, args.take_profit_price], ["BTCUSDT", 99.4, 101.7]);
  assert.ok(args.stop_loss_price < 97.9 && args.stop_loss_price > 97);
  // never more than the 25% position limit, and a stop-out never costs more than 1% of the 1000 USDT
  assert.ok(args.capital_usdt > 0 && args.capital_usdt <= 250.3, `capital ${args.capital_usdt}`);
  const quantity = (args.capital_usdt * 0.999) / args.entry_price;
  const loss = quantity * args.entry_price * 1.001 - quantity * args.stop_loss_price * 0.999;
  assert.ok(loss <= 10.0001, `loss if stopped ${loss}`);
  assert.deepEqual(types(notifier), ["armed", "signal", "order"]);
  assert.equal(bot.status().today.count, 1);
  assert.equal(bot.status().pending.length, 1);
});

test("the bot says when your risk rules refuse the trade, instead of failing at the exchange", async () => {
  const strict = await makeBot({ risk: { minRewardRisk: 1.5 } }); // the default rule: the AMD plan here is about 1.3
  await strict.bot.setConfig({ pairs: [pair], market: "spot" });
  await strict.bot.setConfig({ orders: true });
  await strict.bot.tick();
  assert.equal(strict.spot.calls.length, 0);
  const skipped = strict.notifier.list().events.find((e) => e.type === "skipped");
  assert.match(skipped.body, /Reward-to-risk is \d\.\d+, below the 1\.5 minimum/);

  const paused = await makeBot({ risk: { minRewardRisk: 1, paused: true } });
  await paused.bot.setConfig({ pairs: [pair], market: "spot" });
  await paused.bot.setConfig({ orders: true });
  await paused.bot.tick();
  assert.equal(paused.spot.calls.length, 0);
  assert.match(paused.notifier.list().events.find((e) => e.type === "skipped").body, /paused/i);
});

test("a refusal by the order manager is reported with its reason", async () => {
  const { bot, notifier, spot } = await makeBot();
  spot.reject = new RiskBlockedError("Risk check blocked this order. Daily loss limit reached.", []);
  await bot.setConfig({ pairs: [pair], market: "spot" });
  await bot.setConfig({ orders: true });
  await bot.tick();
  const event = notifier.list().events.find((e) => /blocked by your risk rules/.test(e.title));
  assert.equal(event.type, "skipped");
  assert.match(event.body, /Daily loss limit/);
  assert.equal(bot.status().pending.length, 0);

  const failing = await makeBot();
  failing.spot.reject = new Error("APIError(code=-2010): insufficient balance");
  await failing.bot.setConfig({ pairs: [pair], market: "spot" });
  await failing.bot.setConfig({ orders: true });
  await failing.bot.tick();
  const error = failing.notifier.list().events.find((e) => e.type === "error");
  assert.match(error.body, /insufficient balance/);
  assert.equal(error.level, "error");
});

test("futures: a bearish setup becomes a short, and the leverage is capped by your limit", async () => {
  const { bot, futures } = await makeBot({ candles: candleList({ flipped: true }) });
  await bot.setConfig({ pairs: [pair], market: "futures", leverage: 20 });
  await bot.setConfig({ orders: true });
  await bot.tick();
  assert.equal(futures.calls.length, 1);
  const a = futures.calls[0];
  assert.ok(a.stop_loss_price > a.entry_price && a.take_profit_price < a.entry_price, "a short: stop above, target below");
  assert.ok(a.leverage <= 5, `leverage ${a.leverage} must respect the 5x limit`);
  assert.ok(a.margin_usdt > 0);
  // the same checks the futures manager makes: the stop must come before liquidation, and the size must fit the limits
  const verdict = checkOrder({ settings: normalizeSettings({ minRewardRisk: 1 }), state: { capital: 1000, openRisk: 0, blockers: [] }, order: { entry: a.entry_price, stop: a.stop_loss_price, target: a.take_profit_price, quantity: (a.margin_usdt * a.leverage) / a.entry_price, feePercent: 0.05, side: "short", leverage: a.leverage } });
  assert.equal(verdict.allowed, true, verdict.violations.map((v) => v.message).join(" "));
});

test("its own caps: open orders, orders per day, and never a second order on the same contract", async () => {
  const two = [pair, { symbol: "ETHUSDT", interval: "15m" }];
  const { bot, notifier, spot } = await makeBot();
  await bot.setConfig({ pairs: two, market: "spot", maxOpenOrders: 1 });
  await bot.setConfig({ orders: true });
  await bot.tick();
  assert.equal(spot.calls.length, 1, "the second pair is over the open-order limit");
  assert.match(notifier.list().events.find((e) => e.type === "skipped").body, /Already 1 automatic orders open/);

  const daily = await makeBot();
  await daily.bot.setConfig({ pairs: two, market: "spot", maxOpenOrders: 5, maxOrdersPerDay: 1 });
  await daily.bot.setConfig({ orders: true });
  await daily.bot.tick();
  assert.equal(daily.spot.calls.length, 1);
  assert.match(daily.notifier.list().events.find((e) => e.type === "skipped").body, /Daily limit of 1/);
});

test("a setup that has already reached its target is neither announced nor traded", async () => {
  const { bot, notifier, spot } = await makeBot({ candles: candleList({ extra: [[99.4, 102.0, 99.4, 101.9]] }) });
  await bot.setConfig({ pairs: [pair], market: "spot" });
  await bot.setConfig({ orders: true });
  await bot.tick();
  assert.equal(spot.calls.length, 0);
  assert.equal(notifier.list().events.filter((e) => e.type === "signal").length, 0, "a finished setup is not news");
});

test("account mode switched after arming: no orders, and one warning", async () => {
  const { bot, notifier, spot, modeRef } = await makeBot();
  await bot.setConfig({ pairs: [pair], market: "spot" });
  await bot.setConfig({ orders: true });
  modeRef.mode = "live";
  await bot.tick();
  await bot.tick({ force: true });
  assert.equal(spot.calls.length, 0);
  assert.equal(notifier.list().events.filter((e) => /paused/.test(e.title)).length, 1);
});

// ---- following the orders ----

test("fills, closes and unfilled entries are reported once, and stale entries are cancelled", async () => {
  const { bot, notifier, spot, clock } = await makeBot();
  await bot.setConfig({ pairs: [pair], market: "spot" });
  await bot.setConfig({ orders: true });
  await bot.tick();
  const order = spot.orders[0];

  spot.orders[0].status = "PROTECTED";
  await bot.tick();
  await bot.tick();
  assert.equal(notifier.list().events.filter((e) => e.type === "filled").length, 1);

  Object.assign(spot.orders[0], { status: "CLOSED", realized_profit_usdt: 4.2, message: "OCO exit filled on Binance" });
  await bot.tick();
  const closed = notifier.list().events.find((e) => e.type === "closed");
  assert.match(closed.title, /\+4\.20 USDT/);
  assert.equal(bot.status().pending.length, 0);

  // a second bot run: an entry that never fills lapses after the expiry
  const late = await makeBot();
  await late.bot.setConfig({ pairs: [pair], market: "spot" });
  await late.bot.setConfig({ orders: true });
  await late.bot.tick();
  late.clock.now += 4 * MS;
  await late.bot.tick();
  assert.equal(late.spot.orders[0].status, "CANCELLED");
  assert.ok(late.notifier.list().events.some((e) => e.type === "cancelled" && /not filled/i.test(e.title)));
  assert.equal(late.bot.status().pending.length, 0);
  void order;
  void clock;
});

test("it remembers across a restart: no repeated signals, and the armed state and pending orders come back", async () => {
  const first = await makeBot();
  await first.bot.setConfig({ pairs: [pair], market: "spot" });
  await first.bot.setConfig({ orders: true });
  await first.bot.tick();
  await first.bot.flush();
  await first.notifier.flush();

  const store = new FileStore({ dir: first.dir });
  const notifier = new Notifier({ store, now: () => NOW });
  await notifier.init();
  const again = new AutoTrader({
    strategy: AMD, store, notifier, getMode: () => "paper", getKlines: async () => klines(candleList()),
    managers: { spot: first.spot, futures: first.futures }, getRiskSettings: () => normalizeSettings({ minRewardRisk: 1 }),
    getBalance: async () => ({ wallet: 1000, available: 1000 }), now: () => NOW,
  });
  await again.init();
  assert.equal(again.getConfig().orders, true);
  assert.equal(again.getConfig().armedMode, "paper");
  assert.equal(again.status().pending.length, 1);
  const before = notifier.list().events.length;
  await again.tick({ force: true });
  assert.equal(notifier.list().events.length, before, "the signal is not announced or ordered again");
  assert.equal(first.spot.calls.length, 1);
});

// ---- notifications ----

test("notifications are saved, counted as unread, marked read, capped, and survive a restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-"));
  let clock = 1000;
  const store = new FileStore({ dir });
  const n = new Notifier({ store, now: () => clock });
  await n.init();
  await n.push({ type: "signal", title: "A" });
  clock = 2000;
  const b = await n.push({ type: "order", title: "B", level: "success" });
  assert.deepEqual(n.list().events.map((e) => e.title), ["B", "A"], "newest first");
  assert.equal(n.list().unread, 2);
  assert.deepEqual(n.list({ since: 1000 }).events.map((e) => e.title), ["B"]);
  assert.equal(n.markRead([b.id]).unread, 1);
  assert.equal(n.markRead().unread, 0);
  await n.flush();

  const again = new Notifier({ store, now: () => clock });
  await again.init();
  assert.equal(again.list().events.length, 2);
  assert.equal(again.list().unread, 0);

  for (let i = 0; i < 320; i++) await n.push({ type: "info", title: `n${i}`, external: false });
  assert.equal(n.list({ limit: 1000 }).events.length, 300);
});

test("Telegram and webhook: only what is configured is used, failures are recorded not thrown, secrets never leak", async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    if (String(url).includes("hooks.test")) throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    return new Response("{}", { status: 200 });
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-"));
  const none = new Notifier({ store: new FileStore({ dir }), env: {}, fetchFn });
  await none.init();
  assert.deepEqual(none.channels(), { telegram: { configured: false }, webhook: { configured: false } });
  await none.push({ type: "signal", title: "Nothing to send to" });
  assert.equal(calls.length, 0);

  const env = { TELEGRAM_BOT_TOKEN: "123:SECRET", TELEGRAM_CHAT_ID: "42", NOTIFY_WEBHOOK_URL: "https://hooks.test/in" };
  const n = new Notifier({ store: new FileStore({ dir }), env, fetchFn });
  await n.init();
  assert.deepEqual(n.channels(), { telegram: { configured: true }, webhook: { configured: true } });
  const e = await n.push({ type: "order", title: "Buy order placed", body: "Entry 99.4" });
  const telegram = calls.find((c) => c.url.startsWith("https://api.telegram.org/bot123:SECRET/sendMessage"));
  assert.deepEqual([telegram.body.chat_id, telegram.body.text], ["42", "Buy order placed\nEntry 99.4"]);
  assert.equal(e.delivery.telegram, "sent");
  assert.match(e.delivery.webhook, /failed: ECONNREFUSED/, "a failing channel is recorded, not thrown");
  assert.ok(!JSON.stringify(n.list()).includes("SECRET"), "the token is never in what the app receives");

  const skipped = await n.push({ type: "skipped", title: "Quiet", external: false });
  assert.deepEqual(skipped.delivery, {}, "events marked internal are not sent out");
  assert.equal((await n.test()).event.type, "test");
});

// ---- several strategies ----

test("each strategy has its own bot, settings and state, and a symbol already traded is left alone", async () => {
  const supertrend = STRATEGY_BY_ID.supertrend;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bots-"));
  const store = new FileStore({ dir });
  const notifier = new Notifier({ store, env: {}, fetchFn: async () => new Response("{}"), now: () => NOW });
  await notifier.init();
  const clock = { now: NOW };
  const settings = () => normalizeSettings({ minRewardRisk: 1 });
  const spot = fakeManager(clock, { mode: "paper" }, settings);
  const futures = fakeManager(clock, { mode: "paper" }, settings);
  let busy = false;
  const bots = createBots([AMD, supertrend], {
    store, notifier, getMode: () => "paper", getKlines: async () => klines(candleList()), managers: { spot, futures },
    getRiskSettings: settings, getBalance: async () => ({ wallet: 1000, available: 1000 }), isBusy: () => busy, now: () => NOW,
  });
  await bots.init();
  assert.deepEqual(bots.all().map((b) => b.strategy.id), ["amd_fvg", "supertrend"]);

  await bots.get("supertrend").setConfig({ watch: true, pairs: [pair] });
  assert.equal(bots.get("amd_fvg").getConfig().watch, false, "another strategy's switches are not touched");
  assert.equal(bots.get("supertrend").getConfig().shorts, false, "a long-only strategy cannot be set to short");
  assert.deepEqual(bots.get("supertrend").getConfig().params, { atrPeriod: 10, multiplier: 3, rewardR: 2 }, "its own settings start at their defaults");
  await bots.get("supertrend").setConfig({ params: { multiplier: 2 } });
  assert.equal(bots.get("supertrend").getConfig().params.multiplier, 2);
  assert.equal(bots.get("supertrend").getConfig().params.atrPeriod, 10, "only the given setting changes");
  await assert.rejects(bots.get("supertrend").setConfig({ entryMode: "retest" }), /no retest entry/);
  await assert.rejects(bots.get("supertrend").setConfig({ params: { minRangeBars: 12 } }), /no setting called/);

  // an order on the symbol from anyone else stops a second strategy from stacking another one
  await bots.get("amd_fvg").setConfig({ pairs: [pair], market: "spot" });
  await bots.get("amd_fvg").setConfig({ orders: true });
  busy = true;
  await bots.get("amd_fvg").tick({ force: true });
  assert.equal(spot.calls.length, 0);
  const skip = notifier.list().events.find((e) => e.type === "skipped");
  assert.match(skip.body, /already an open BTCUSDT order or position/);
  assert.equal(skip.strategy, "amd_fvg");
  assert.equal(notifier.list({ strategy: "supertrend" }).events.length, 0, "events are filed under their own strategy");
  assert.ok(notifier.list({ strategy: "amd_fvg" }).events.length >= 2);
  busy = false;
  await bots.flush();
});

test("settings saved by the AMD-only bot of earlier versions are picked up, with the old names translated", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-"));
  const store = new FileStore({ dir });
  await store.setSetting("auto_amd", { watch: true, orders: false, market: "spot", pairs: [pair], entryMode: "fvg-retest", targetMode: "range", engine: { minRangeBars: 14, maxRangeAtr: 3, minRewardRisk: 1.5 } });
  const notifier = new Notifier({ store, env: {}, now: () => NOW });
  await notifier.init();
  const settings = () => normalizeSettings({});
  const bots = createBots([AMD], { store, notifier, getMode: () => "paper", getKlines: async () => [], managers: { spot: fakeManager({ now: NOW }, {}, settings), futures: fakeManager({ now: NOW }, {}, settings) }, getRiskSettings: settings, getBalance: async () => ({ wallet: 1, available: 1 }), now: () => NOW });
  await bots.init();
  const c = bots.get("amd_fvg").getConfig();
  assert.deepEqual([c.watch, c.market, c.entryMode, c.targetMode, c.minRewardRisk], [true, "spot", "retest", "own", 1.5]);
  assert.equal(c.params.minRangeBars, 14);
  assert.equal(c.params.maxRangeAtr, 3);
  assert.equal(c.params.maxFvgBars, 8, "settings added since keep their default");
});
