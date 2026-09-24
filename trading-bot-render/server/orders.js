/**
 * Conditional spot order execution: a limit BUY that, once filled, is protected by an OCO
 * (take-profit + stop-loss). Port of trade_executor.py; the background monitors are async
 * loops instead of threads and resume from the persisted store on startup.
 */
import crypto from "node:crypto";

import { RISK_DEFAULTS, checkOrder, computeCapital, computeRiskState, normalizeSettings } from "../shared/risk.js";
import { decimalString, formatDecimal } from "./decimal.js";

const DEFAULT_TRADING_FEE_PERCENT = 0.1;
const STOP_LIMIT_BUFFER_PERCENT = 0.1;
const ACTIVE = new Set(["WAITING_ENTRY", "PROTECTED", "MODIFYING"]);
const POLL_MS = 5000;
const DEFAULT_LIMITS = { max_open_orders: 1, max_daily_orders: 5 };

// unref'd: an idle poll timer must never keep the process (or a test run) alive on its own.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());
const round2 = (n) => Math.round(n * 100) / 100;
const isUnknownOrder = (err) => /-2011|Unknown order/.test(String(err?.message ?? err));

/** Thrown when the risk rules refuse an order. `violations` lists every broken rule. */
export class RiskBlockedError extends Error {
  constructor(message, violations) {
    super(message);
    this.violations = violations;
  }
}

export class OrderManager {
  /**
   * @param {object} deps
   * @param {(mode?: string) => object} deps.getClient
   * @param {() => string} deps.getMode
   * @param {(client, symbol) => Promise<{maker_percent: number, taker_percent: number}>} deps.getTradingFee
   * @param {import("./store.js").FileStore | import("./store.js").MongoStore} deps.store
   */
  constructor({ getClient, getMode, getTradingFee, store, pollMs = POLL_MS }) {
    this.getClient = getClient;
    this.getMode = getMode;
    this.getTradingFee = getTradingFee;
    this.store = store;
    this.pollMs = pollMs;
    this.stopped = false;
    this.limits = { ...DEFAULT_LIMITS };
    this.riskSettings = { ...RISK_DEFAULTS };
    this.orders = {};
    this.writeQueue = Promise.resolve();
  }

  /** Load persisted orders and limits. Call before start(). */
  async init() {
    // Futures orders live in the same store but belong to the FuturesManager.
    this.orders = Object.fromEntries((await this.store.loadOrders()).filter((order) => order.market !== "futures").map((order) => [order.id, order]));
    this.limits = { ...DEFAULT_LIMITS, ...((await this.store.getSetting("limits")) ?? {}) };
    try {
      this.riskSettings = normalizeSettings((await this.store.getSetting("risk")) ?? {});
    } catch (err) {
      console.error(`Ignoring invalid saved risk settings: ${err.message}`);
    }
  }

  // ---- risk management ----
  getRiskSettings() {
    return { ...this.riskSettings };
  }

  /** Validate and persist a partial settings update. Takes effect on the next order. */
  setRiskSettings(patch) {
    this.riskSettings = normalizeSettings(patch, this.riskSettings);
    this.#queue(() => this.store.setSetting("risk", { ...this.riskSettings }));
    return this.getRiskSettings();
  }

  /** Measure drawdown from now on (after the user has reviewed a drawdown halt). */
  resetDrawdown() {
    return this.setRiskSettings({ drawdownResetAt: new Date().toISOString() });
  }

  /** Where the given account mode stands against every limit. `quoteTotal` is the quote-asset balance. */
  getRiskState(mode, quoteTotal, now = Date.now()) {
    const orders = this.listOrders(mode);
    const settings = this.getRiskSettings();
    const capital = computeCapital(settings, { quoteTotal, orders });
    return computeRiskState({ orders, settings, capital, now });
  }

  /** Resolves once every queued database write has finished. */
  flush() {
    return this.writeQueue;
  }

  /** Resume monitoring anything that was in flight when the process last stopped. */
  start() {
    for (const order of Object.values(this.orders)) {
      if (order.status === "MODIFYING") {
        order.status = "ERROR";
        order.message = "Entry price update was interrupted; cancel or place a new order";
        this.#save(order.id);
      } else if (order.status === "WAITING_ENTRY" || order.status === "PROTECTED") {
        this.#spawnMonitor(order.id);
      }
    }
  }

  stop() {
    this.stopped = true;
  }

  listOrders(accountMode) {
    return Object.values(this.orders)
      .filter((order) => !accountMode || order.account_mode === accountMode)
      .map((order) => ({ ...order }));
  }

  getLimits() {
    return { ...this.limits };
  }

  setLimits(maxOpenOrders, maxDailyOrders) {
    const validOpen = Number.isInteger(maxOpenOrders) && maxOpenOrders >= 1 && maxOpenOrders <= 100;
    const validDaily = Number.isInteger(maxDailyOrders) && maxDailyOrders >= 1 && maxDailyOrders <= 500;
    if (!validOpen || !validDaily) throw new Error("Limits are outside the allowed range");
    this.limits = { max_open_orders: maxOpenOrders, max_daily_orders: maxDailyOrders };
    this.#queue(() => this.store.setSetting("limits", { ...this.limits }));
    return { ...this.limits };
  }

  async createOrder({ symbol, entry_price, capital_usdt, stop_loss_price, take_profit_price }) {
    const accountMode = this.getMode();
    this.#checkLimits(accountMode);
    const client = this.getClient(accountMode);
    const info = await getSymbolInfo(client, symbol);
    const feePercent = await this.#feePercent(client, symbol);
    const entryPrice = formatDecimal(entry_price, info.tickSize);
    const stopLossPrice = formatDecimal(stop_loss_price, info.tickSize);
    const takeProfitPrice = formatDecimal(take_profit_price, info.tickSize);

    const balance = await getQuoteBalance(client, info.quoteAsset);
    if (capital_usdt > balance.free) {
      throw new Error(`Insufficient ${info.quoteAsset} balance for a ${capital_usdt.toFixed(2)} USDT order`);
    }
    const quantity = formatDecimal((capital_usdt * (1 - feePercent / 100)) / entryPrice, info.stepSize);

    if (!(stopLossPrice < entryPrice && entryPrice < takeProfitPrice)) {
      throw new Error("Prices must satisfy stop-loss < entry < take-profit");
    }
    if (quantity <= 0 || quantity < info.minQty) throw new Error("Quantity is below the exchange lot-size minimum");
    const orderValue = entryPrice * quantity;
    if (info.minNotional > 0 && orderValue < info.minNotional) {
      throw new Error(`Order value ${orderValue.toFixed(2)} ${info.quoteAsset} is below Binance's minimum of ${info.minNotional} ${info.quoteAsset} for ${symbol}. Use a larger size (this is an exchange rule, not a risk rule).`);
    }

    // Risk rules are enforced here, on the server, so no client can bypass them.
    const state = this.getRiskState(accountMode, balance.free + balance.locked);
    const verdict = checkOrder({
      settings: this.riskSettings,
      state,
      order: { entry: entryPrice, stop: stopLossPrice, target: takeProfitPrice, quantity, feePercent },
    });
    if (!verdict.allowed) {
      const size = verdict.suggestedPositionValue > 0 && verdict.violations.every((v) => ["risk_per_trade", "position_size", "open_risk"].includes(v.code))
        ? ` Largest position that fits your limits with this stop: about ${verdict.suggestedPositionValue.toFixed(2)} USDT.`
        : "";
      throw new RiskBlockedError(`Risk check blocked this order. ${verdict.violations.map((v) => v.message).join(" ")}${size}`, verdict.violations);
    }

    const order = {
      id: crypto.randomUUID().replace(/-/g, "").slice(0, 12),
      symbol,
      entry_price: entryPrice,
      capital_usdt,
      quantity,
      stop_loss_price: stopLossPrice,
      take_profit_price: takeProfitPrice,
      fee_percent: feePercent,
      ...estimate({ entryPrice, quantity, stopLossPrice, takeProfitPrice, feePercent }),
      account_mode: accountMode,
      created_at: new Date().toISOString(),
      exit_price: null,
      realized_profit_usdt: null,
      status: "PLACING",
      entry_order_id: null,
      exit_order_list_id: null,
      exit_order_ids: null,
      message: "",
    };

    const entry = await client.createOrder({
      symbol,
      side: "BUY",
      type: "LIMIT",
      timeInForce: "GTC",
      quantity: decimalString(quantity),
      price: decimalString(entryPrice),
    });
    order.entry_order_id = String(entry.orderId);
    order.status = "WAITING_ENTRY";
    this.orders[order.id] = order;
    // The Binance order already exists, so a database hiccup must not stop the monitor from starting.
    await this.#save(order.id);

    this.#spawnMonitor(order.id);
    return { ...order };
  }

  #checkLimits(accountMode) {
    const today = new Date().toISOString().slice(0, 10);
    const accountOrders = Object.values(this.orders).filter((order) => order.account_mode === accountMode);
    const openCount = accountOrders.filter((order) => ACTIVE.has(order.status)).length;
    const dailyCount = accountOrders.filter((order) => order.created_at.slice(0, 10) === today).length;
    if (openCount >= this.limits.max_open_orders) {
      throw new Error(`Maximum open orders reached (${this.limits.max_open_orders})`);
    }
    if (dailyCount >= this.limits.max_daily_orders) {
      throw new Error(`Maximum daily orders reached (${this.limits.max_daily_orders})`);
    }
  }

  /** Cancel-and-replace a waiting limit BUY so its price can move up or down. */
  async modifyEntryPrice(orderId, { entry_price = null, direction = null, steps = 1 } = {}) {
    const order = this.#get(orderId);
    if (order.status !== "WAITING_ENTRY" || !order.entry_order_id) {
      throw new Error("Only waiting entry orders can change price");
    }
    if (steps < 1) throw new Error("Steps must be at least 1");

    const client = this.getClient(order.account_mode);
    const info = await getSymbolInfo(client, order.symbol);

    let requested;
    if (direction !== null) {
      const dir = String(direction).toLowerCase();
      if (dir !== "up" && dir !== "down") throw new Error("Direction must be up or down");
      const delta = info.tickSize * steps;
      requested = dir === "up" ? order.entry_price + delta : order.entry_price - delta;
    } else if (entry_price !== null) {
      requested = entry_price;
    } else {
      throw new Error("Provide entry_price or direction");
    }

    const newEntryPrice = formatDecimal(requested, info.tickSize);
    if (newEntryPrice <= 0) throw new Error("Entry price must be greater than zero");
    if (!(order.stop_loss_price < newEntryPrice && newEntryPrice < order.take_profit_price)) {
      throw new Error("New entry must stay between stop-loss and take-profit");
    }
    if (newEntryPrice === order.entry_price) return { ...order };

    const feePercent = order.fee_percent;
    const quantity = formatDecimal((order.capital_usdt * (1 - feePercent / 100)) / newEntryPrice, info.stepSize);
    if (quantity <= 0) throw new Error("Quantity is below the exchange lot-size minimum");

    const previousOrderId = order.entry_order_id;
    this.#update(orderId, { status: "MODIFYING", message: "Updating entry price…" });

    let entry;
    try {
      try {
        await client.cancelOrder(order.symbol, previousOrderId);
      } catch (err) {
        if (!isUnknownOrder(err)) throw err;
        // The old order is gone; if it filled meanwhile, replacing it would buy twice.
        const previous = await client.getOrder(order.symbol, previousOrderId);
        if (previous.status === "FILLED" || previous.status === "PARTIALLY_FILLED") {
          this.#update(orderId, { status: "WAITING_ENTRY", message: "Entry filled before the price update; keeping the original entry" });
          throw new Error("Entry order already filled; price was not changed");
        }
      }

      entry = await client.createOrder({
        symbol: order.symbol,
        side: "BUY",
        type: "LIMIT",
        timeInForce: "GTC",
        quantity: decimalString(quantity),
        price: decimalString(newEntryPrice),
      });
    } catch (err) {
      if (this.#get(orderId).status === "MODIFYING") {
        this.#update(orderId, { status: "ERROR", message: `Failed to update entry price: ${err.message}` });
      }
      throw err;
    }

    this.#update(orderId, {
      status: "WAITING_ENTRY",
      entry_price: newEntryPrice,
      quantity,
      entry_order_id: String(entry.orderId),
      ...estimate({
        entryPrice: newEntryPrice,
        quantity,
        stopLossPrice: order.stop_loss_price,
        takeProfitPrice: order.take_profit_price,
        feePercent,
      }),
      message: `Entry price updated to ${newEntryPrice}`,
    });
    return { ...this.#get(orderId) };
  }

  async cancelOrder(orderId) {
    const order = this.#get(orderId);
    if (order.status === "WAITING_ENTRY" && order.entry_order_id) {
      try {
        await this.getClient(order.account_mode).cancelOrder(order.symbol, order.entry_order_id);
        this.#update(orderId, { status: "CANCELLED", message: "Entry order cancelled" });
      } catch (err) {
        if (!isUnknownOrder(err)) throw err;
        this.#update(orderId, { status: "CANCELLED", message: "Entry was already cancelled or closed on Binance" });
      }
    } else if (order.status === "PROTECTED" && order.exit_order_list_id) {
      const client = this.getClient(order.account_mode);
      await cancelOco(client, order.symbol, order.exit_order_list_id);
      const info = await getSymbolInfo(client, order.symbol);
      const quantity = formatDecimal(order.quantity, info.stepSize);
      const sell = await client.createOrder({
        symbol: order.symbol,
        side: "SELL",
        type: "MARKET",
        quantity: decimalString(quantity),
      });
      const executedQty = Number(sell.executedQty) || quantity;
      const quoteTotal = Number(sell.cummulativeQuoteQty) || 0;
      const exitPrice = quoteTotal ? quoteTotal / executedQty : Number((await client.getSymbolTicker(order.symbol)).price);
      this.#update(orderId, {
        status: "CLOSED",
        quantity: executedQty,
        exit_price: exitPrice,
        realized_profit_usdt: realizedProfit(order, exitPrice, executedQty),
        message: "OCO cancelled; position sold at market",
      });
    }
    return { ...this.#get(orderId) };
  }

  deleteHistory(orderId) {
    const order = this.orders[orderId];
    if (!order) throw new Error("Order not found");
    if (ACTIVE.has(order.status)) throw new Error("Cancel the active Binance order before deleting it");
    delete this.orders[orderId];
    this.#queue(() => this.store.removeOrders([orderId]));
    return { deleted: orderId };
  }

  clearHistory(accountMode) {
    const removed = Object.values(this.orders)
      .filter((order) => !ACTIVE.has(order.status) && (!accountMode || order.account_mode === accountMode))
      .map((order) => order.id);
    for (const id of removed) delete this.orders[id];
    this.#queue(() => this.store.removeOrders(removed));
    return { deleted: removed.length };
  }

  /** Forget every order of this mode, active or not. Only for resetting the paper account: its simulated
   * exchange (balances, orders) is wiped at the same time, so any still-active record here would otherwise
   * be orphaned - its monitor polling an order id the simulated exchange no longer knows about. */
  clearAccount(accountMode) {
    const removed = Object.values(this.orders)
      .filter((order) => order.account_mode === accountMode)
      .map((order) => order.id);
    for (const id of removed) delete this.orders[id];
    this.#queue(() => this.store.removeOrders(removed));
    return { deleted: removed.length };
  }

  async cleanupAllAccounts() {
    const cancelled = { paper: [], live: [] };
    const errors = [];
    for (const mode of ["paper", "live"]) {
      try {
        const client = this.getClient(mode);
        for (const open of await client.getOpenOrders()) {
          try {
            const result = await client.cancelOrder(open.symbol, open.orderId);
            cancelled[mode].push({ symbol: open.symbol, orderId: result.orderId ?? open.orderId });
          } catch (err) {
            errors.push({ mode, symbol: open.symbol, orderId: open.orderId, error: err.message });
          }
        }
      } catch (err) {
        errors.push({ mode, error: err.message });
      }
    }
    const removed = Object.keys(this.orders);
    this.orders = {};
    this.#queue(() => this.store.removeOrders(removed));
    return { cancelled, errors };
  }

  // ---- monitors ----
  #spawnMonitor(orderId) {
    this.#monitor(orderId).catch((err) => {
      try {
        this.#update(orderId, { status: "ERROR", message: `Monitor crashed: ${err.message}` });
      } catch {
        /* order was deleted */
      }
    });
  }

  async #monitor(orderId) {
    while (!this.stopped) {
      const order = this.orders[orderId];
      if (!order) return;
      if (order.status === "PROTECTED") return this.#monitorExit(orderId);
      if (order.status === "MODIFYING") {
        await sleep(Math.min(1000, this.pollMs));
        continue;
      }
      if (order.status !== "WAITING_ENTRY" && order.status !== "PLACING") return;

      try {
        const client = this.getClient(order.account_mode);
        const entry = await client.getOrder(order.symbol, order.entry_order_id);
        if (entry.status === "CANCELED" || entry.status === "EXPIRED") {
          // A price update may have cancelled this id on purpose.
          const latest = this.orders[orderId];
          if (!latest) return;
          if (latest.status === "MODIFYING" || latest.entry_order_id !== order.entry_order_id) continue;
          this.#update(orderId, { status: "CANCELLED", message: "Entry order cancelled on Binance" });
          return;
        }
        if (entry.status === "REJECTED") {
          this.#update(orderId, { status: "ERROR", message: "Entry order rejected by Binance" });
          return;
        }
        if (entry.status === "FILLED") {
          await this.#placeProtection(orderId, order, client, entry);
          return this.#monitorExit(orderId);
        }
      } catch (err) {
        if (!this.orders[orderId]) return;
        if (isTransientNetworkError(err) || isRateLimitError(err)) {
          // Keep watching: giving up here would leave a filled entry without its stop-loss.
          await sleep(Math.min(30_000, this.pollMs * 3));
          continue;
        }
        this.#update(orderId, { status: "ERROR", message: err.message });
        return;
      }
      await sleep(this.pollMs);
    }
  }

  async #placeProtection(orderId, order, client, entry) {
    const info = await getSymbolInfo(client, order.symbol);
    const filledQuantity = formatDecimal(Number(entry.executedQty), info.stepSize);
    const stopLimitPrice = formatDecimal(order.stop_loss_price * (1 - STOP_LIMIT_BUFFER_PERCENT / 100), info.tickSize);
    const oco = await client.createSellOco({
      symbol: order.symbol,
      quantity: decimalString(filledQuantity),
      takeProfitPrice: decimalString(order.take_profit_price),
      stopPrice: decimalString(order.stop_loss_price),
      stopLimitPrice: decimalString(stopLimitPrice),
    });
    this.#update(orderId, {
      status: "PROTECTED",
      quantity: filledQuantity,
      exit_order_list_id: String(oco.orderListId ?? ""),
      exit_order_ids: (oco.orders ?? []).map((item) => String(item.orderId)),
      message: "Entry filled; SL/TP OCO is active",
    });
  }

  async #monitorExit(orderId) {
    let failures = 0;
    while (!this.stopped) {
      const order = this.orders[orderId];
      if (!order || order.status !== "PROTECTED") return;
      try {
        const client = this.getClient(order.account_mode);
        let childIds = order.exit_order_ids ?? [];
        if (!childIds.length && order.exit_order_list_id) {
          const list = await client.getOrderList(order.exit_order_list_id);
          childIds = (list.orders ?? []).map((item) => String(item.orderId));
          if (childIds.length) this.#update(orderId, { exit_order_ids: childIds });
        }
        for (const childId of childIds) {
          const child = await client.getOrder(order.symbol, childId);
          if (child.status === "FILLED") {
            const executedQty = Number(child.executedQty) || order.quantity;
            const quoteTotal = Number(child.cummulativeQuoteQty) || 0;
            const exitPrice = quoteTotal ? quoteTotal / executedQty : Number(child.price || child.stopPrice);
            this.#update(orderId, {
              status: "CLOSED",
              quantity: executedQty,
              exit_price: exitPrice,
              realized_profit_usdt: realizedProfit(order, exitPrice, executedQty),
              message: "OCO exit filled on Binance",
            });
            return;
          }
        }
        failures = 0;
        if (order.message.startsWith("Exit monitor retry:")) {
          this.#update(orderId, { message: "Entry filled; SL/TP OCO is active" });
        }
      } catch (err) {
        failures += 1;
        // Transient network timeouts shouldn't replace the status message on every poll.
        if (failures >= 3 || !(isTransientNetworkError(err) || isRateLimitError(err))) {
          this.#update(orderId, { status: "PROTECTED", message: `Exit monitor retry: ${err.message}` });
        }
        await sleep(isRateLimitError(err) ? 30_000 : Math.min(30_000, this.pollMs * failures));
        continue;
      }
      await sleep(this.pollMs);
    }
  }

  // ---- internals ----
  #get(orderId) {
    const order = this.orders[orderId];
    if (!order) throw new Error("Order not found");
    return order;
  }

  #update(orderId, changes) {
    // Remember when a trade closed: the daily-loss and loss-streak rules depend on it.
    if (changes.status === "CLOSED") changes = { closed_at: new Date().toISOString(), ...changes };
    Object.assign(this.#get(orderId), changes);
    this.#save(orderId);
  }

  async #feePercent(client, symbol) {
    try {
      const fees = await this.getTradingFee(client, symbol);
      return Math.max(fees.maker_percent, fees.taker_percent);
    } catch {
      return DEFAULT_TRADING_FEE_PERCENT;
    }
  }

  /** Persist a snapshot of one order; writes run strictly in order so the last state always wins. */
  #save(orderId) {
    const snapshot = { ...this.orders[orderId] };
    return this.#queue(() => this.store.saveOrder(snapshot));
  }

  #queue(write) {
    this.writeQueue = this.writeQueue
      .then(write)
      .catch((err) => console.error(`Database write failed: ${err.message}`));
    return this.writeQueue;
  }
}

/** Fee-aware profit/loss estimates shown in the order ticket. */
function estimate({ entryPrice, quantity, stopLossPrice, takeProfitPrice, feePercent }) {
  const afterFee = 1 - feePercent / 100;
  const buyValue = entryPrice * quantity;
  const buyFee = (buyValue * feePercent) / 100;
  const estimatedLoss = Math.max(0, buyValue + buyFee - stopLossPrice * quantity * afterFee);
  const estimatedProfit = takeProfitPrice * quantity * afterFee - buyValue - buyFee;
  return {
    gross_loss_usdt: round2(Math.max(0, buyValue - stopLossPrice * quantity)),
    gross_profit_usdt: round2(Math.max(0, takeProfitPrice * quantity - buyValue)),
    estimated_fees_usdt: round2(buyFee + (Math.max(stopLossPrice, takeProfitPrice) * quantity * feePercent) / 100),
    estimated_loss_usdt: round2(estimatedLoss),
    estimated_profit_usdt: round2(estimatedProfit),
  };
}

function realizedProfit(order, exitPrice, quantity) {
  const afterFee = 1 - order.fee_percent / 100;
  const beforeFee = 1 + order.fee_percent / 100;
  return round2(exitPrice * quantity * afterFee - order.entry_price * quantity * beforeFee);
}

export async function getSymbolInfo(client, symbol) {
  const { symbols } = await client.getExchangeInfo(symbol.toUpperCase());
  const info = symbols?.[0];
  if (!info || info.status !== "TRADING") throw new Error(`Tradable symbol not found: ${symbol}`);
  const filters = Object.fromEntries(info.filters.map((f) => [f.filterType, f]));
  return {
    tickSize: Number(filters.PRICE_FILTER.tickSize),
    stepSize: Number(filters.LOT_SIZE.stepSize),
    minQty: Number(filters.LOT_SIZE.minQty ?? 0),
    // Binance calls this NOTIONAL (newer) or MIN_NOTIONAL (older): the smallest order value it accepts.
    minNotional: Number(filters.NOTIONAL?.minNotional ?? filters.MIN_NOTIONAL?.minNotional ?? 0),
    quoteAsset: info.quoteAsset,
  };
}

async function getQuoteBalance(client, asset) {
  const account = await client.getAccount();
  const balance = account.balances.find((b) => b.asset === asset);
  return { free: balance ? Number(balance.free) : 0, locked: balance ? Number(balance.locked) : 0 };
}

/** Cancel a Spot OCO via the order-list endpoint, falling back to its child orders. */
async function cancelOco(client, symbol, orderListId) {
  try {
    await client.cancelOrderList(symbol, orderListId);
  } catch {
    const list = await client.getOrderList(orderListId);
    for (const child of list.orders ?? []) await client.cancelOrder(symbol, child.orderId);
  }
}

const TRANSIENT_TOKENS = [
  "timed out",
  "timeout",
  "network error",
  "connection reset",
  "connection aborted",
  "temporarily unavailable",
  "name resolution",
  "fetch failed",
];

export function isRateLimitError(err) {
  return err?.status === 429 || err?.status === 418 || err?.code === -1003;
}

export function isTransientNetworkError(err) {
  const text = String(err?.message ?? err).toLowerCase();
  return TRANSIENT_TOKENS.some((token) => text.includes(token));
}
