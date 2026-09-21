/**
 * The AMD bot: watches the pairs you choose on the SERVER (so it works with every tab closed), and for each fresh
 * signal it notifies you and, if you armed it, places the order through the same managers, risk rules and exchange
 * protection as a manual order.
 *
 * Safety, in the order it matters:
 *  - everything is OFF until you switch it on; "watch" (notifications only) and "orders" are separate switches;
 *  - orders are armed for ONE account mode. If the account is switched (testnet <-> live) they stop until re-armed,
 *    and arming live needs the word LIVE;
 *  - the bot never bypasses a rule: size comes from your risk limits, the leverage is capped by your limit and by the
 *    liquidation check, and the spot / futures managers apply every other rule again when the order is created;
 *  - hard caps of its own: open orders, orders per day, one per contract; entries that do not fill lapse and are cancelled;
 *  - it only acts on signals from the last closed candles, once each (remembered across restarts), and never chases a
 *    price that has already moved past the target or the stop;
 *  - every step (signal, order, fill, close, refusal, error) is a notification with the reason.
 */
import { checkOrder } from "../shared/risk.js";
import { AMD_DEFAULTS, findAmd } from "../shared/analysis/amd.js";
import { AMD_TRADE_DEFAULTS, ENTRY_MODES, TARGET_MODES, planTrade } from "../shared/analysis/amdTrade.js";
import { toCandles } from "../shared/analysis/index.js";
import { RiskBlockedError } from "./orders.js";

export const INTERVAL_MS = { "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000 };
const MAX_PAIRS = 12;
const MAX_SEEN = 3000;
const STALE_CANDLES = 1; // a signal formed more than this many candles ago is history, not news

export const AUTO_DEFAULTS = Object.freeze({
  watch: false,
  orders: false,
  armedMode: null,
  market: "futures",
  pairs: [],
  entryMode: AMD_TRADE_DEFAULTS.entryMode,
  targetMode: AMD_TRADE_DEFAULTS.targetMode,
  targetR: AMD_TRADE_DEFAULTS.targetR,
  expiryCandles: AMD_TRADE_DEFAULTS.expiryCandles,
  longs: true,
  shorts: true,
  leverage: 3,
  maxOpenOrders: 2,
  maxOrdersPerDay: 3,
  pushSkips: false, // send "skipped" events to Telegram / the webhook too (they always show in the app)
  engine: { minRangeBars: AMD_DEFAULTS.minRangeBars, maxRangeAtr: AMD_DEFAULTS.maxRangeAtr, minRewardRisk: AMD_DEFAULTS.minRewardRisk },
});

const bad = (message) => Object.assign(new Error(message), { httpStatus: 422 });
const inRange = (value, name, min, max, integer = false) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw bad(`${name} must be ${integer ? "a whole number " : ""}between ${min} and ${max}`);
  return n;
};

/** Validate a partial config over the current one. Throws a readable error on anything wrong. */
export function normalizeAutoConfig(patch, current = AUTO_DEFAULTS) {
  const next = { ...current, engine: { ...current.engine } };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!(key in AUTO_DEFAULTS)) throw bad(`Unknown setting: ${key}`);
    if (key === "armedMode") continue; // set only by arming
    if (["watch", "orders", "longs", "shorts", "pushSkips"].includes(key)) {
      if (typeof value !== "boolean") throw bad(`${key} must be true or false`);
      next[key] = value;
    } else if (key === "market") {
      if (value !== "spot" && value !== "futures") throw bad("market must be spot or futures");
      next.market = value;
    } else if (key === "entryMode") {
      if (!ENTRY_MODES.includes(value)) throw bad(`entryMode must be one of ${ENTRY_MODES.join(", ")}`);
      next.entryMode = value;
    } else if (key === "targetMode") {
      if (!TARGET_MODES.includes(value)) throw bad(`targetMode must be one of ${TARGET_MODES.join(", ")}`);
      next.targetMode = value;
    } else if (key === "targetR") next.targetR = inRange(value, "targetR", 1, 5);
    else if (key === "expiryCandles") next.expiryCandles = inRange(value, "expiryCandles", 1, 10, true);
    else if (key === "leverage") next.leverage = inRange(value, "leverage", 1, 20, true);
    else if (key === "maxOpenOrders") next.maxOpenOrders = inRange(value, "maxOpenOrders", 1, 10, true);
    else if (key === "maxOrdersPerDay") next.maxOrdersPerDay = inRange(value, "maxOrdersPerDay", 1, 50, true);
    else if (key === "engine") {
      const e = value ?? {};
      next.engine = {
        minRangeBars: e.minRangeBars == null ? next.engine.minRangeBars : inRange(e.minRangeBars, "minRangeBars", 4, 40, true),
        maxRangeAtr: e.maxRangeAtr == null ? next.engine.maxRangeAtr : inRange(e.maxRangeAtr, "maxRangeAtr", 1.5, 6),
        minRewardRisk: e.minRewardRisk == null ? next.engine.minRewardRisk : inRange(e.minRewardRisk, "minRewardRisk", 0, 5),
      };
    } else if (key === "pairs") {
      if (!Array.isArray(value)) throw bad("pairs must be a list");
      if (value.length > MAX_PAIRS) throw bad(`at most ${MAX_PAIRS} pairs`);
      const seen = new Set();
      next.pairs = value.map((p) => {
        const symbol = String(p?.symbol ?? "").trim().toUpperCase();
        if (!/^[A-Z0-9]{4,20}$/.test(symbol)) throw bad(`"${p?.symbol}" is not a valid symbol`);
        if (!INTERVAL_MS[p?.interval]) throw bad(`timeframe must be one of ${Object.keys(INTERVAL_MS).join(", ")}`);
        const id = `${symbol}:${p.interval}`;
        if (seen.has(id)) throw bad(`${symbol} ${p.interval} is listed twice`);
        seen.add(id);
        return { symbol, interval: p.interval };
      });
    }
  }
  if (next.market === "spot") next.shorts = false; // spot cannot be shorted
  return next;
}

const round = (n, d) => Math.floor(n * 10 ** d) / 10 ** d;

/**
 * Rules that no position size can fix (a paused switch, a daily loss stop, a reward:risk minimum, liquidation, the leverage
 * cap). The size rules are left out: the bot picks the size that satisfies them.
 */
function refusals(verdict) {
  const blocking = verdict.violations.filter((v) => !["risk_per_trade", "position_size", "open_risk"].includes(v.code));
  return blocking.length ? `Your risk rules refuse this trade: ${blocking.map((v) => v.message).join(" ")}` : null;
}
const fmt = (n) => (n == null || !Number.isFinite(n) ? "—" : Math.abs(n) >= 1000 ? n.toFixed(2) : Math.abs(n) >= 1 ? n.toFixed(4) : n.toPrecision(4));

export class AutoAmd {
  /**
   * @param {object} deps
   * @param {object} deps.store       getSetting / setSetting
   * @param {import("./notifier.js").Notifier} deps.notifier
   * @param {() => string} deps.getMode
   * @param {(market, mode, symbol, interval, limit) => Promise<any[]>} deps.getKlines  Binance kline rows
   * @param {{spot: object, futures: object}} deps.managers  OrderManager and FuturesManager
   * @param {() => object} deps.getRiskSettings
   * @param {(market, mode) => Promise<{wallet: number, available: number}>} deps.getBalance  quote-asset (USDT) balance
   */
  constructor({ store, notifier, getMode, getKlines, managers, getRiskSettings, getBalance, now = Date.now, tickMs = 30_000 }) {
    Object.assign(this, { store, notifier, getMode, getKlines, managers, getRiskSettings, getBalance, now, tickMs });
    this.config = { ...AUTO_DEFAULTS, engine: { ...AUTO_DEFAULTS.engine } };
    this.seen = new Set();
    this.pending = [];
    this.day = null;
    this.count = 0;
    this.pairState = new Map();
    this.running = false;
    this.timer = null;
    this.lastTickAt = null;
    this.modeWarned = false;
    this.writeQueue = Promise.resolve();
  }

  async init() {
    try {
      this.config = normalizeAutoConfig((await this.store.getSetting("auto_amd")) ?? {});
      const saved = (await this.store.getSetting("auto_amd")) ?? {};
      this.config.armedMode = saved.armedMode === "testnet" || saved.armedMode === "live" ? saved.armedMode : null;
      if (!this.config.orders) this.config.armedMode = null;
    } catch (err) {
      console.error(`Ignoring invalid saved bot settings: ${err.message}`);
    }
    const state = (await this.store.getSetting("auto_amd_state")) ?? {};
    this.seen = new Set(state.seen ?? []);
    this.pending = state.pending ?? [];
    this.day = state.day ?? null;
    this.count = state.count ?? 0;
  }

  flush() {
    return this.writeQueue;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((err) => console.error(`AMD bot tick failed: ${err.message}`)), this.tickMs);
    this.timer.unref();
    setTimeout(() => this.tick().catch(() => {}), 3000).unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  getConfig() {
    return { ...this.config, engine: { ...this.config.engine }, pairs: this.config.pairs.map((p) => ({ ...p })) };
  }

  /** Change settings. Arming orders is a deliberate act: live needs the word LIVE, and it binds to the current account mode. */
  async setConfig(patch, { confirm } = {}) {
    const before = this.config;
    const next = normalizeAutoConfig(patch, before);
    const mode = this.getMode();
    next.armedMode = before.armedMode;
    if (next.market !== before.market) next.orders = false; // a different market is a different bot: re-arm on purpose
    if (next.orders && !before.orders) {
      if (!next.pairs.length) throw bad("Add at least one pair before arming orders");
      if (mode === "live" && confirm !== "LIVE") throw bad("Arming automatic orders on the LIVE account needs the word LIVE as confirmation");
      next.armedMode = mode;
      next.watch = true;
    }
    if (!next.orders) next.armedMode = null;
    this.config = next;
    this.modeWarned = false;
    this.#saveConfig();
    if (next.orders && !before.orders) {
      await this.notifier.push({ type: "armed", level: "warn", source: "amd", title: `Automatic orders ARMED on ${mode === "live" ? "the LIVE account" : "Testnet"}`, body: `${next.pairs.map((p) => `${p.symbol} ${p.interval}`).join(", ")} · ${next.market} · risk from your limits · max ${next.maxOpenOrders} open, ${next.maxOrdersPerDay} a day.` });
    } else if (!next.orders && before.orders) {
      await this.notifier.push({ type: "disarmed", level: "info", source: "amd", title: "Automatic orders switched off", body: "Open orders keep their stop-loss and take-profit on Binance." });
    }
    return this.getConfig();
  }

  /** Where things stand, for the app. */
  status() {
    const mode = this.getMode();
    const c = this.config;
    const armedHere = c.orders && c.armedMode === mode;
    return {
      mode,
      watching: c.watch || c.orders,
      ordering: armedHere,
      armedMode: c.armedMode,
      blocked: c.orders && !armedHere ? `Orders were armed for ${c.armedMode}, the account is now on ${mode}: switched off until you arm them again.` : null,
      lastTickAt: this.lastTickAt,
      today: { count: this.#todayCount(), max: c.maxOrdersPerDay },
      pending: this.pending.map((p) => ({ ...p })),
      pairs: c.pairs.map((p) => ({ ...p, ...(this.pairState.get(this.#key(p)) ?? {}) })),
    };
  }

  #key(pair) {
    return `${this.config.market}:${pair.symbol}:${pair.interval}`;
  }

  #todayCount() {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    return this.day === day ? this.count : 0;
  }

  #saveConfig() {
    const snapshot = { ...this.config };
    this.writeQueue = this.writeQueue.then(() => this.store.setSetting("auto_amd", snapshot)).catch((err) => console.error(`Could not save bot settings: ${err.message}`));
  }

  #saveState() {
    while (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.values().next().value);
    const snapshot = { seen: [...this.seen], pending: this.pending.map((p) => ({ ...p })), day: this.day, count: this.count };
    this.writeQueue = this.writeQueue.then(() => this.store.setSetting("auto_amd_state", snapshot)).catch((err) => console.error(`Could not save bot state: ${err.message}`));
  }

  async #note(event) {
    const external = event.type === "skipped" ? this.config.pushSkips : event.external;
    return this.notifier.push({ source: "amd", ...event, external });
  }

  /** One pass: follow the orders already placed, then look at each pair whose candle has just closed. */
  async tick({ force = false } = {}) {
    if (this.running) return this.status();
    this.running = true;
    try {
      this.lastTickAt = this.now();
      await this.#follow();
      if (this.config.watch || this.config.orders) {
        for (const pair of this.config.pairs) await this.scanPair(pair, { force });
      }
    } finally {
      this.running = false;
    }
    return this.status();
  }

  async scanPair(pair, { force = false } = {}) {
    const { market } = this.config;
    const mode = this.getMode();
    const ms = INTERVAL_MS[pair.interval];
    const key = this.#key(pair);
    const state = this.pairState.get(key) ?? {};
    this.pairState.set(key, state);
    const nowMs = this.now();
    const latestClosedOpen = Math.floor(nowMs / ms) * ms - ms;
    if (!force && state.lastClosedOpen >= latestClosedOpen && !state.error) return; // this candle was already looked at

    let candles;
    try {
      candles = toCandles(await this.getKlines(market, mode, pair.symbol, pair.interval, 500));
    } catch (err) {
      state.error = err.message;
      state.checkedAt = nowMs;
      return;
    }
    const last = candles[candles.length - 1];
    const closed = last && last.closeTime != null && last.closeTime > nowMs ? candles.slice(0, -1) : candles;
    state.checkedAt = nowMs;
    if (closed.length < 60) { state.error = `only ${closed.length} closed candles`; return; }
    state.error = null;
    state.lastClosedOpen = closed[closed.length - 1].time * 1000;

    const fresh = [];
    for (const setup of findAmd(closed, null, this.config.engine)) {
      if (closed.length - 1 - setup.formedAt > STALE_CANDLES) continue;
      const id = `${key}:${setup.dir}:${closed[setup.formedAt].time}`;
      if (this.seen.has(id)) continue;
      this.seen.add(id);
      if (setup.status === "active") fresh.push({ setup, id });
    }
    if (fresh.length) this.#saveState();
    for (const { setup, id } of fresh) {
      state.lastSignal = { id, dir: setup.dir, at: nowMs };
      await this.#handle(pair, closed, setup, id);
    }
  }

  async #handle(pair, closed, setup, id) {
    const { market } = this.config;
    const opts = this.#tradeOptions();
    const show = planTrade(setup, { ...opts, longs: true, shorts: true });
    const buy = setup.dir === "bull";
    const clock = new Date(closed[setup.formedAt].time * 1000).toISOString().slice(11, 16);
    await this.#note({
      type: "signal",
      level: buy ? "success" : "warn",
      title: `AMD ${buy ? "buy" : "sell"} signal · ${pair.symbol} ${pair.interval}`,
      body: `${buy ? "Range low swept, then a bullish" : "Range high swept, then a bearish"} fair value gap closed (${clock} UTC).${show.ok ? ` Entry ${fmt(show.entry)}, stop ${fmt(show.stop)}, target ${fmt(show.target)} (${show.rewardRisk.toFixed(1)}R).` : ` No trade plan: ${show.reason}.`}${!buy && market === "spot" ? " Spot is long-only: treat it as an exit warning." : ""}`,
      symbol: pair.symbol, market, interval: pair.interval, dir: setup.dir,
      plan: show.ok ? { side: show.side, entry: show.entry, stopLoss: show.stop, target: show.target, riskReward: show.rewardRisk } : null,
      signalId: id,
    });
    if (this.config.orders) await this.#order(pair, closed, setup, id);
  }

  #tradeOptions() {
    const c = this.config;
    return {
      entryMode: c.entryMode, targetMode: c.targetMode, targetR: c.targetR, expiryCandles: c.expiryCandles,
      longs: c.longs, shorts: c.market === "futures" && c.shorts, minRewardRisk: c.engine.minRewardRisk,
    };
  }

  async #skip(pair, setup, id, reason, level = "info") {
    await this.#note({ type: "skipped", level, title: `Order not placed · ${pair.symbol} ${pair.interval}`, body: reason, symbol: pair.symbol, market: this.config.market, interval: pair.interval, dir: setup.dir, signalId: id });
  }

  async #order(pair, closed, setup, id) {
    const c = this.config;
    const mode = this.getMode();
    if (c.armedMode !== mode) {
      if (!this.modeWarned) {
        this.modeWarned = true;
        await this.#note({ type: "error", level: "warn", title: "Automatic orders are paused", body: `They were armed for ${c.armedMode}, but the account is on ${mode}. Arm them again on purpose to continue.`, external: true });
      }
      return;
    }
    if (setup.dir === "bear" && c.market === "spot") return; // spot is long-only: the signal was announced as an exit warning
    const plan = planTrade(setup, this.#tradeOptions());
    if (!plan.ok) return this.#skip(pair, setup, id, `The signal does not make a tradable plan: ${plan.reason}.`);

    const price = closed[closed.length - 1].close;
    const long = plan.side === "long";
    if (long ? price >= plan.target || price <= plan.stop : price <= plan.target || price >= plan.stop) {
      return this.#skip(pair, setup, id, `Price ${fmt(price)} has already moved past the target or the stop.`);
    }

    const active = this.pending.filter((p) => p.market === c.market && p.mode === mode);
    if (active.length >= c.maxOpenOrders) return this.#skip(pair, setup, id, `Already ${active.length} automatic orders open (limit ${c.maxOpenOrders}).`);
    if (active.some((p) => p.symbol === pair.symbol)) return this.#skip(pair, setup, id, `There is already an automatic ${pair.symbol} order open.`);
    if (this.#todayCount() >= c.maxOrdersPerDay) return this.#skip(pair, setup, id, `Daily limit of ${c.maxOrdersPerDay} automatic orders reached.`, "warn");

    let sized;
    try {
      sized = await this.#size(plan, pair.symbol, mode);
    } catch (err) {
      return this.#note({ type: "error", level: "error", title: `Could not size the order · ${pair.symbol}`, body: err.message, symbol: pair.symbol, market: c.market, interval: pair.interval, signalId: id, external: true });
    }
    if (!sized.ok) return this.#skip(pair, setup, id, sized.reason);

    let order;
    try {
      order = await (c.market === "futures" ? this.managers.futures : this.managers.spot).createOrder(sized.args);
    } catch (err) {
      const blocked = err instanceof RiskBlockedError;
      return this.#note({
        type: blocked ? "skipped" : "error", level: blocked ? "warn" : "error", external: blocked ? c.pushSkips : true,
        title: blocked ? `Blocked by your risk rules · ${pair.symbol}` : `Order failed · ${pair.symbol} ${pair.interval}`,
        body: err.message, symbol: pair.symbol, market: c.market, interval: pair.interval, dir: setup.dir, signalId: id,
      });
    }

    const nowMs = this.now();
    const day = new Date(nowMs).toISOString().slice(0, 10);
    if (this.day !== day) { this.day = day; this.count = 0; }
    this.count += 1;
    this.pending.push({
      id: order.id, market: c.market, mode, symbol: pair.symbol, interval: pair.interval, dir: setup.dir, signalId: id,
      createdAt: nowMs, expireAt: nowMs + c.expiryCandles * INTERVAL_MS[pair.interval], status: order.status,
    });
    this.#saveState();
    await this.#note({
      type: "order", level: "success", title: `${plan.side === "long" ? "Buy" : "Sell short"} order placed · ${pair.symbol} ${pair.interval}`,
      body: `${mode === "live" ? "LIVE" : "Testnet"} · limit ${fmt(plan.entry)}, stop ${fmt(plan.stop)}, target ${fmt(plan.target)} (${plan.rewardRisk.toFixed(1)}R)${sized.note ? ` · ${sized.note}` : ""}. It is cancelled if not filled within ${c.expiryCandles} candles.`,
      symbol: pair.symbol, market: c.market, interval: pair.interval, dir: setup.dir, orderId: order.id, signalId: id,
      plan: { side: plan.side, entry: plan.entry, stopLoss: plan.stop, target: plan.target, riskReward: plan.rewardRisk },
    });
  }

  /** Position size from the user's own risk limits: the largest one that passes every rule, within the balance. */
  async #size(plan, symbol, mode) {
    const c = this.config;
    const settings = this.getRiskSettings();
    const long = plan.side === "long";
    const balance = await this.getBalance(c.market, mode);
    if (c.market === "spot") {
      const feePercent = 0.1;
      const state = this.managers.spot.getRiskState(mode, balance.wallet);
      const verdict = checkOrder({ settings, state, order: { entry: plan.entry, stop: plan.stop, target: plan.target, quantity: 1, feePercent, side: "long", leverage: 1 } });
      const refused = refusals(verdict);
      if (refused) return { ok: false, reason: refused };
      const notional = Math.min(verdict.suggestedPositionValue ?? 0, balance.available * (1 - feePercent / 100) * 0.98);
      if (!(notional > 0)) return { ok: false, reason: "Your risk limits or free balance leave no room for a new position." };
      const capital = round(notional / (1 - feePercent / 100), 2);
      return { ok: true, args: { symbol, entry_price: plan.entry, capital_usdt: capital, stop_loss_price: plan.stop, take_profit_price: plan.target }, note: `${capital.toFixed(2)} USDT` };
    }
    const feePercent = 0.05;
    const state = this.managers.futures.getRiskState(mode, balance.wallet);
    let leverage = Math.min(c.leverage, settings.maxLeverage ?? c.leverage);
    let verdict;
    for (let attempt = 0; attempt < 3; attempt++) {
      verdict = checkOrder({ settings, state, order: { entry: plan.entry, stop: plan.stop, target: plan.target, quantity: 1, feePercent, side: plan.side, leverage } });
      if (verdict.maxSafeLeverage != null && leverage > verdict.maxSafeLeverage) leverage = Math.max(1, verdict.maxSafeLeverage); // liquidation must come after the stop
      else break;
    }
    const refused = refusals(verdict);
    if (refused) return { ok: false, reason: refused };
    const notional = Math.min(verdict.suggestedPositionValue ?? 0, balance.available * leverage * 0.95);
    if (!(notional > 0)) return { ok: false, reason: "Your risk limits or free margin leave no room for a new position." };
    const margin = round(notional / leverage, 2);
    return { ok: true, args: { symbol, entry_price: plan.entry, margin_usdt: margin, leverage, stop_loss_price: plan.stop, take_profit_price: plan.target }, note: `${margin.toFixed(2)} USDT margin at ${leverage}×${long ? "" : " (short)"}` };
  }

  /** Follow the orders the bot placed: report fills and closes, and cancel entries that never filled. */
  async #follow() {
    if (!this.pending.length) return;
    const nowMs = this.now();
    const keep = [];
    for (const rec of this.pending) {
      const manager = rec.market === "futures" ? this.managers.futures : this.managers.spot;
      const order = manager.listOrders(rec.mode).find((o) => o.id === rec.id);
      const where = { symbol: rec.symbol, market: rec.market, interval: rec.interval, dir: rec.dir, orderId: rec.id };
      if (!order) continue; // deleted from history: nothing left to follow
      if (order.status !== rec.status) {
        rec.status = order.status;
        if (order.status === "PROTECTED") await this.#note({ type: "filled", level: "success", title: `Entry filled · ${rec.symbol}`, body: "Stop-loss and take-profit are active on Binance.", ...where });
        else if (order.status === "CLOSED") {
          const pnl = order.realized_profit_usdt;
          await this.#note({ type: "closed", level: pnl == null ? "info" : pnl >= 0 ? "success" : "warn", title: `Trade closed · ${rec.symbol} ${pnl == null ? "" : `${pnl >= 0 ? "+" : "−"}${Math.abs(pnl).toFixed(2)} USDT`}`.trim(), body: order.message || "Closed.", ...where });
          continue;
        } else if (order.status === "CANCELLED") { await this.#note({ type: "cancelled", level: "info", title: `Order cancelled · ${rec.symbol}`, body: order.message || "The entry order was cancelled.", ...where }); continue; }
        else if (order.status === "ERROR") { await this.#note({ type: "error", level: "error", title: `Order error · ${rec.symbol}`, body: order.message || "The order ended in an error: check Binance.", external: true, ...where }); continue; }
      }
      if (order.status === "WAITING_ENTRY" && nowMs > rec.expireAt) {
        try {
          await manager.cancelOrder(rec.id);
          await this.#note({ type: "cancelled", level: "info", title: `Entry not filled · ${rec.symbol} ${rec.interval}`, body: `Price did not come back within ${this.config.expiryCandles} candles, so the order was cancelled.`, ...where });
          continue;
        } catch { /* it may have filled just now: the next pass reports it */ }
      }
      keep.push(rec);
    }
    this.pending = keep;
    this.#saveState();
  }
}
