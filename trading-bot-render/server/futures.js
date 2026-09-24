/**
 * USD-M futures trading: a limit entry (long or short) that, once filled, is protected by a stop-loss and a
 * take-profit that live on Binance (conditional "algo" orders that close the whole position). Same lifecycle and
 * same persistence as the spot OrderManager, plus what futures adds: leverage, isolated margin, shorts and
 * liquidation.
 *
 * Safety rules built into this file:
 *  - isolated margin only; One-way position mode only; USDT-margined perpetual contracts only;
 *  - the risk rules are enforced here, on the server (see shared/risk.js), including the leverage cap and a check
 *    that the stop triggers well before the liquidation price;
 *  - one managed order per contract, and never on top of a position that already exists on Binance, because the
 *    stop and take-profit close "the whole position";
 *  - if the stop-loss cannot be placed after the entry fills, the position is closed at market rather than left
 *    unprotected; a stop-loss that disappears from Binance is placed again.
 */
import crypto from "node:crypto";

import { checkOrder, computeCapital, computeRiskState, estimateTrade } from "../shared/risk.js";
import { decimalString, formatDecimal } from "./decimal.js";
import { RiskBlockedError, isRateLimitError, isTransientNetworkError } from "./orders.js";

const DEFAULT_FEE_PERCENT = 0.05; // taker rate of the base VIP tier; used when the commission endpoint is unavailable
const ACTIVE = new Set(["WAITING_ENTRY", "PROTECTED"]);
const POLL_MS = 5000;
const INFO_TTL_MS = 5 * 60_000;
const TRIGGERED = new Set(["TRIGGERING", "TRIGGERED", "FINISHED"]);
const DEAD = new Set(["CANCELED", "CANCELLED", "EXPIRED", "REJECTED"]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());
const round2 = (n) => Math.round(n * 100) / 100;
const isUnknownOrder = (err) => /-2011|-2013|-4139|Unknown order|does not exist/i.test(String(err?.message ?? err));
const isNoChange = (err) => /-4046|No need to change/i.test(String(err?.message ?? err));

export function futuresSymbolInfo(exchangeInfo, symbol) {
  const contract = exchangeInfo.symbols?.find((s) => s.symbol === symbol);
  if (!contract || contract.status !== "TRADING") throw new Error(`Tradable futures contract not found: ${symbol}`);
  if (!/PERPETUAL/.test(contract.contractType ?? "")) throw new Error(`${symbol} is a dated contract; only perpetual contracts can be traded here.`);
  if (contract.quoteAsset !== "USDT") throw new Error(`${symbol} is margined in ${contract.quoteAsset}; only USDT-margined contracts are supported.`);
  const filters = Object.fromEntries(contract.filters.map((f) => [f.filterType, f]));
  return {
    tickSize: Number(filters.PRICE_FILTER.tickSize),
    stepSize: Number(filters.LOT_SIZE.stepSize),
    minQty: Number(filters.LOT_SIZE.minQty ?? 0),
    minNotional: Number(filters.MIN_NOTIONAL?.notional ?? 0),
    quoteAsset: contract.quoteAsset,
  };
}

/** One position row from Binance, in the shape the dashboard uses. Empty positions return null. */
export function parsePosition(p) {
  const amount = Number(p.positionAmt);
  if (!Number.isFinite(amount) || amount === 0) return null;
  return {
    symbol: p.symbol,
    side: amount > 0 ? "LONG" : "SHORT",
    quantity: Math.abs(amount),
    entryPrice: Number(p.entryPrice),
    markPrice: Number(p.markPrice),
    unrealizedProfit: Number(p.unRealizedProfit ?? p.unrealizedProfit ?? 0),
    liquidationPrice: Number(p.liquidationPrice) || null,
    leverage: Number(p.leverage) || null,
    marginType: String(p.marginType ?? "").toUpperCase() || null,
    notional: Math.abs(Number(p.notional ?? amount * Number(p.markPrice))),
  };
}

export class FuturesManager {
  /**
   * @param {object} deps
   * @param {(mode: string) => object} deps.getClient  authenticated futures client for a mode
   * @param {() => string} deps.getMode
   * @param {() => object} deps.getRiskSettings
   * @param {() => {max_open_orders: number, max_daily_orders: number}} deps.getLimits
   * @param {object} deps.store  same store as the spot OrderManager
   */
  constructor({ getClient, getMode, getRiskSettings, getLimits, store, pollMs = POLL_MS }) {
    this.getClient = getClient;
    this.getMode = getMode;
    this.getRiskSettings = getRiskSettings;
    this.getLimits = getLimits;
    this.store = store;
    this.pollMs = pollMs;
    this.stopped = false;
    this.orders = {};
    this.writeQueue = Promise.resolve();
    this.infoCache = new Map();
  }

  async init() {
    this.orders = Object.fromEntries((await this.store.loadOrders()).filter((o) => o.market === "futures").map((o) => [o.id, o]));
  }

  flush() {
    return this.writeQueue;
  }

  /** Resume monitoring whatever was in flight when the process last stopped. */
  start() {
    for (const order of Object.values(this.orders)) {
      if (ACTIVE.has(order.status)) this.#spawnMonitor(order.id);
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

  /** Where this account stands against every limit. `walletBalance` is the USDT wallet balance of the futures account. */
  getRiskState(mode, walletBalance, now = Date.now()) {
    const settings = this.getRiskSettings();
    const capital = computeCapital(settings, { quoteTotal: walletBalance });
    return computeRiskState({ orders: this.listOrders(mode), settings, capital, now });
  }

  /** Futures wallet, open positions and account mode checks, for the dashboard. */
  async getAccount(mode) {
    const client = this.getClient(mode);
    const [balances, positions, dual] = await Promise.all([
      client.getBalance(),
      client.getPositions(),
      client.getPositionMode().catch(() => null),
    ]);
    const usdt = balances.find((b) => b.asset === "USDT");
    const wallet = Number(usdt?.balance ?? 0);
    const open = positions.map(parsePosition).filter(Boolean);
    return {
      mode,
      wallet,
      available: Number(usdt?.availableBalance ?? 0),
      unrealized: open.reduce((sum, p) => sum + p.unrealizedProfit, 0),
      positions: open,
      hedgeMode: dual ? Boolean(dual.dualSidePosition) : null,
    };
  }

  async createOrder({ symbol, entry_price, margin_usdt, leverage, stop_loss_price, take_profit_price }) {
    const mode = this.getMode();
    this.#checkLimits(mode);
    const client = this.getClient(mode);
    const info = await this.#symbolInfo(client, mode, symbol);

    const entryPrice = formatDecimal(entry_price, info.tickSize);
    const stopLossPrice = formatDecimal(stop_loss_price, info.tickSize);
    const takeProfitPrice = formatDecimal(take_profit_price, info.tickSize);
    let side;
    if (stopLossPrice < entryPrice && entryPrice < takeProfitPrice) side = "long";
    else if (takeProfitPrice < entryPrice && entryPrice < stopLossPrice) side = "short";
    else throw new Error("Prices must satisfy stop-loss < entry < take-profit (long) or take-profit < entry < stop-loss (short)");
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > 125) throw new Error("Leverage must be a whole number from 1 to 125");

    const active = Object.values(this.orders).find((o) => o.account_mode === mode && o.symbol === symbol && ACTIVE.has(o.status));
    if (active) throw new Error(`There is already an active ${symbol} futures order. Cancel it or wait for it to close: the stop and target close the whole position.`);

    const [dual, balances, positions, feePercent] = await Promise.all([
      client.getPositionMode(),
      client.getBalance(),
      client.getPositions(symbol),
      this.#feePercent(client, symbol),
    ]);
    if (dual.dualSidePosition) throw new Error("Your futures account is in Hedge Mode. Switch it to One-way Mode in the Binance futures settings, then try again.");
    if (positions.some((p) => Number(p.positionAmt) !== 0)) throw new Error(`You already have an open ${symbol} position on Binance. Close it first (Positions list) so the stop-loss and target only manage this trade.`);

    const usdt = balances.find((b) => b.asset === "USDT");
    const wallet = Number(usdt?.balance ?? 0);
    const available = Number(usdt?.availableBalance ?? 0);
    if (margin_usdt > available) throw new Error(`Insufficient futures margin: ${margin_usdt.toFixed(2)} USDT needed, ${available.toFixed(2)} available.`);

    const notional = margin_usdt * leverage;
    const quantity = formatDecimal(notional / entryPrice, info.stepSize);
    if (quantity <= 0 || quantity < info.minQty) throw new Error("Quantity is below the exchange lot-size minimum");
    const orderValue = entryPrice * quantity;
    if (info.minNotional > 0 && orderValue < info.minNotional) {
      throw new Error(`Order value ${orderValue.toFixed(2)} USDT is below Binance's minimum of ${info.minNotional} USDT for ${symbol}. Use more margin or higher leverage (this is an exchange rule, not a risk rule).`);
    }

    // Risk rules are enforced here, on the server, so no client can bypass them.
    const settings = this.getRiskSettings();
    const state = this.getRiskState(mode, wallet);
    const verdict = checkOrder({
      settings, state,
      order: { entry: entryPrice, stop: stopLossPrice, target: takeProfitPrice, quantity, feePercent, side, leverage },
    });
    if (!verdict.allowed) {
      const fits = verdict.suggestedPositionValue > 0 && verdict.violations.every((v) => ["risk_per_trade", "position_size", "open_risk"].includes(v.code))
        ? ` Largest position that fits your limits with this stop: about ${verdict.suggestedPositionValue.toFixed(2)} USDT notional.`
        : "";
      throw new RiskBlockedError(`Risk check blocked this order. ${verdict.violations.map((v) => v.message).join(" ")}${fits}`, verdict.violations);
    }

    // Isolated margin, then leverage. Both are per-contract account settings on Binance.
    try {
      await client.changeMarginType(symbol, "ISOLATED");
    } catch (err) {
      if (!isNoChange(err)) throw err;
    }
    await client.changeLeverage(symbol, leverage);

    const trade = estimateTrade({ entry: entryPrice, stop: stopLossPrice, target: takeProfitPrice, quantity, feePercent, side });
    const order = {
      id: crypto.randomUUID().replace(/-/g, "").slice(0, 12),
      market: "futures",
      symbol,
      side: side === "long" ? "LONG" : "SHORT",
      leverage,
      margin_type: "ISOLATED",
      entry_price: entryPrice,
      capital_usdt: margin_usdt,
      notional_usdt: round2(orderValue),
      quantity,
      stop_loss_price: stopLossPrice,
      take_profit_price: takeProfitPrice,
      fee_percent: feePercent,
      estimated_loss_usdt: round2(trade.riskUsd),
      estimated_profit_usdt: round2(trade.rewardUsd),
      liquidation_pct: verdict.liquidationPct == null ? null : Number(verdict.liquidationPct.toFixed(2)),
      account_mode: mode,
      created_at: new Date().toISOString(),
      exit_price: null,
      realized_profit_usdt: null,
      status: "PLACING",
      entry_order_id: null,
      entry_filled_at: null,
      sl_algo_id: null,
      tp_algo_id: null,
      message: "",
    };

    const entry = await client.createOrder({
      symbol,
      side: side === "long" ? "BUY" : "SELL",
      type: "LIMIT",
      timeInForce: "GTC",
      quantity: decimalString(quantity),
      price: decimalString(entryPrice),
    });
    order.entry_order_id = String(entry.orderId);
    order.status = "WAITING_ENTRY";
    this.orders[order.id] = order;
    await this.#save(order.id); // the Binance order exists already: a database hiccup must not stop the monitor
    this.#spawnMonitor(order.id);
    return { ...order };
  }

  async cancelOrder(orderId) {
    const order = this.#get(orderId);
    const client = this.getClient(order.account_mode);
    if (order.status === "WAITING_ENTRY" && order.entry_order_id) {
      try {
        await client.cancelOrder(order.symbol, order.entry_order_id);
      } catch (err) {
        if (!isUnknownOrder(err)) throw err;
        const entry = await client.getOrder(order.symbol, order.entry_order_id);
        if (Number(entry.executedQty) > 0) throw new Error("The entry order already filled; its stop-loss and target are being placed. Use Close position instead.");
      }
      this.#update(orderId, { status: "CANCELLED", message: "Entry order cancelled" });
    } else if (order.status === "PROTECTED") {
      await this.#closeAtMarket(order, client);
      await this.#settle(orderId, "Position closed at market");
    }
    return { ...this.#get(orderId) };
  }

  /** Close an open position (managed or not) at market and remove its stop-loss / take-profit. */
  async closePosition(symbol, mode = this.getMode()) {
    const client = this.getClient(mode);
    const position = (await client.getPositions(symbol)).map(parsePosition).find(Boolean);
    if (!position) throw new Error(`No open ${symbol} position on Binance`);
    await client.cancelAllAlgoOrders(symbol).catch(() => {});
    await client.createOrder({
      symbol,
      side: position.side === "LONG" ? "SELL" : "BUY",
      type: "MARKET",
      quantity: decimalString(position.quantity),
      reduceOnly: "true",
    });
    return { closed: true, symbol, side: position.side, quantity: position.quantity };
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
   * exchange (balances, positions, orders) is wiped at the same time, so any still-active record here would
   * otherwise be orphaned - its monitor polling an order/position the simulated exchange no longer knows about. */
  clearAccount(accountMode) {
    const removed = Object.values(this.orders)
      .filter((order) => order.account_mode === accountMode)
      .map((order) => order.id);
    for (const id of removed) delete this.orders[id];
    this.#queue(() => this.store.removeOrders(removed));
    return { deleted: removed.length };
  }

  // ---- monitoring ----
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
      if (order.status === "PROTECTED") return this.#monitorPosition(orderId);
      if (order.status !== "WAITING_ENTRY" && order.status !== "PLACING") return;
      try {
        const client = this.getClient(order.account_mode);
        let entry = await client.getOrder(order.symbol, order.entry_order_id);
        if (entry.status === "PARTIALLY_FILLED") {
          // Do not leave a partial position unprotected while the rest waits: keep what filled, drop the remainder.
          try {
            await client.cancelOrder(order.symbol, order.entry_order_id);
          } catch (err) {
            if (!isUnknownOrder(err)) throw err;
          }
          entry = await client.getOrder(order.symbol, order.entry_order_id);
        }
        const executed = Number(entry.executedQty) || 0;
        if (entry.status === "FILLED" || (executed > 0 && DEAD.has(entry.status))) {
          const filled = await this.#protect(orderId, entry, executed);
          if (!filled) return;
          return this.#monitorPosition(orderId);
        }
        if (DEAD.has(entry.status)) {
          this.#update(orderId, {
            status: entry.status === "REJECTED" ? "ERROR" : "CANCELLED",
            message: entry.status === "REJECTED" ? "Entry order rejected by Binance" : "Entry order cancelled on Binance",
          });
          return;
        }
      } catch (err) {
        if (!this.orders[orderId]) return;
        if (isTransientNetworkError(err) || isRateLimitError(err)) {
          await sleep(Math.min(30_000, this.pollMs * 3)); // keep watching: giving up could leave a fill unprotected
          continue;
        }
        this.#update(orderId, { status: "ERROR", message: err.message });
        return;
      }
      await sleep(this.pollMs);
    }
  }

  /** Place the stop-loss and take-profit for a filled entry. Returns false if the position had to be abandoned. */
  async #protect(orderId, entry, executedQty) {
    const order = this.#get(orderId);
    const client = this.getClient(order.account_mode);
    const long = order.side === "LONG";
    const exitSide = long ? "SELL" : "BUY";
    const patch = {
      quantity: executedQty,
      entry_filled_at: new Date(Number(entry.updateTime) || Date.now()).toISOString(),
    };

    let stop;
    try {
      stop = await client.createCloseTrigger({ symbol: order.symbol, side: exitSide, type: "STOP_MARKET", triggerPrice: decimalString(order.stop_loss_price) });
    } catch (err) {
      // No stop-loss means no position: close it now instead of leaving it exposed.
      let closed = "";
      try {
        await this.#closeAtMarket({ ...order, ...patch }, client);
        closed = " The position was closed at market.";
      } catch (closeErr) {
        closed = ` COULD NOT CLOSE THE POSITION (${closeErr.message}): close it manually on Binance now.`;
      }
      this.#update(orderId, { ...patch, status: "ERROR", message: `Stop-loss could not be placed (${err.message}).${closed}` });
      return false;
    }

    let target = null;
    let note = "Entry filled; stop-loss and take-profit are active";
    try {
      target = await client.createCloseTrigger({ symbol: order.symbol, side: exitSide, type: "TAKE_PROFIT_MARKET", triggerPrice: decimalString(order.take_profit_price) });
    } catch (err) {
      note = `Entry filled and stop-loss is active, but the take-profit could not be placed (${err.message}). It will be retried.`;
    }
    this.#update(orderId, {
      ...patch,
      status: "PROTECTED",
      sl_algo_id: stop.algoId == null ? null : String(stop.algoId),
      tp_algo_id: target?.algoId == null ? null : String(target.algoId),
      message: note,
    });
    return true;
  }

  async #monitorPosition(orderId) {
    let failures = 0;
    let flat = 0;
    while (!this.stopped) {
      const order = this.orders[orderId];
      if (!order || order.status !== "PROTECTED") return;
      try {
        const client = this.getClient(order.account_mode);
        const [positions, sl, tp] = await Promise.all([
          client.getPositions(order.symbol),
          order.sl_algo_id ? client.getAlgoOrder(order.sl_algo_id) : null,
          order.tp_algo_id ? client.getAlgoOrder(order.tp_algo_id) : null,
        ]);
        const triggered = (a) => a && (a.actualOrderId || TRIGGERED.has(String(a.algoStatus).toUpperCase()));
        flat = positions.some((p) => Number(p.positionAmt) !== 0) ? 0 : flat + 1;

        if (triggered(sl) || triggered(tp) || flat >= 2) {
          const reason = triggered(sl) ? "Stop-loss triggered" : triggered(tp) ? "Take-profit triggered" : "Position closed on Binance (manually or liquidated)";
          await this.#settle(orderId, reason);
          return;
        }

        // A stop-loss or target that vanished from Binance (cancelled by hand) is put back.
        const exitSide = order.side === "LONG" ? "SELL" : "BUY";
        const gone = (a) => a && DEAD.has(String(a.algoStatus).toUpperCase());
        if (gone(sl) || !order.sl_algo_id) {
          const again = await client.createCloseTrigger({ symbol: order.symbol, side: exitSide, type: "STOP_MARKET", triggerPrice: decimalString(order.stop_loss_price) });
          this.#update(orderId, { sl_algo_id: String(again.algoId), message: "Stop-loss was missing on Binance and has been placed again" });
        }
        if (gone(tp) || !order.tp_algo_id) {
          const again = await client.createCloseTrigger({ symbol: order.symbol, side: exitSide, type: "TAKE_PROFIT_MARKET", triggerPrice: decimalString(order.take_profit_price) });
          this.#update(orderId, { tp_algo_id: String(again.algoId), message: "Take-profit was missing on Binance and has been placed again" });
        }
        failures = 0;
        if (order.message.startsWith("Position monitor retry:")) this.#update(orderId, { message: "Stop-loss and take-profit are active" });
      } catch (err) {
        failures += 1;
        if (failures >= 3 || !(isTransientNetworkError(err) || isRateLimitError(err))) {
          this.#update(orderId, { message: `Position monitor retry: ${err.message}` });
        }
        await sleep(isRateLimitError(err) ? 30_000 : Math.min(30_000, this.pollMs * failures));
        continue;
      }
      await sleep(this.pollMs);
    }
  }

  /** Cancel the remaining stop/target, work out what the trade earned, and close the record. */
  async #settle(orderId, reason) {
    const order = this.#get(orderId);
    const client = this.getClient(order.account_mode);
    for (const id of [order.sl_algo_id, order.tp_algo_id]) {
      if (!id) continue;
      try {
        await client.cancelAlgoOrder(id);
      } catch { /* already triggered or gone */ }
    }
    let exit = { price: null, quantity: order.quantity, profit: null };
    try {
      exit = summarizeTrades(await client.getUserTrades(order.symbol, Date.parse(order.entry_filled_at ?? order.created_at) - 2000), order);
    } catch { /* the trade history is only for the P&L figure */ }
    this.#update(orderId, {
      status: "CLOSED",
      exit_price: exit.price,
      quantity: exit.quantity || order.quantity,
      realized_profit_usdt: exit.profit == null ? null : round2(exit.profit),
      message: reason,
    });
  }

  async #closeAtMarket(order, client) {
    await client.cancelAllAlgoOrders(order.symbol).catch(() => {});
    for (const id of [order.sl_algo_id, order.tp_algo_id]) {
      if (id) await client.cancelAlgoOrder(id).catch(() => {});
    }
    const position = (await client.getPositions(order.symbol)).map(parsePosition).find(Boolean);
    if (!position) return; // already flat
    await client.createOrder({
      symbol: order.symbol,
      side: position.side === "LONG" ? "SELL" : "BUY",
      type: "MARKET",
      quantity: decimalString(position.quantity),
      reduceOnly: "true",
    });
  }

  // ---- internals ----
  #checkLimits(mode) {
    const limits = this.getLimits();
    const today = new Date().toISOString().slice(0, 10);
    const own = Object.values(this.orders).filter((o) => o.account_mode === mode);
    if (own.filter((o) => ACTIVE.has(o.status)).length >= limits.max_open_orders) throw new Error(`Maximum open orders reached (${limits.max_open_orders})`);
    if (own.filter((o) => o.created_at.slice(0, 10) === today).length >= limits.max_daily_orders) throw new Error(`Maximum daily orders reached (${limits.max_daily_orders})`);
  }

  async #symbolInfo(client, mode, symbol) {
    let cached = this.infoCache.get(mode);
    if (!cached || Date.now() - cached.at > INFO_TTL_MS) {
      cached = { at: Date.now(), info: await client.getExchangeInfo() };
      this.infoCache.set(mode, cached);
    }
    return futuresSymbolInfo(cached.info, symbol);
  }

  async #feePercent(client, symbol) {
    try {
      const fees = await client.getCommission(symbol);
      return Math.max(fees.maker_percent, fees.taker_percent);
    } catch {
      return DEFAULT_FEE_PERCENT;
    }
  }

  #get(orderId) {
    const order = this.orders[orderId];
    if (!order) throw new Error("Order not found");
    return order;
  }

  #update(orderId, changes) {
    if (changes.status === "CLOSED") changes = { closed_at: new Date().toISOString(), ...changes };
    Object.assign(this.#get(orderId), changes);
    this.#save(orderId);
  }

  #save(orderId) {
    const snapshot = { ...this.orders[orderId] };
    return this.#queue(() => this.store.saveOrder(snapshot));
  }

  #queue(write) {
    this.writeQueue = this.writeQueue.then(write).catch((err) => console.error(`Database write failed: ${err.message}`));
    return this.writeQueue;
  }
}

/**
 * Net result of a position from Binance's trade list: realized P&L minus commissions, and the average exit price.
 * Funding payments are not included. Commissions paid in another asset (BNB) are not converted.
 */
export function summarizeTrades(trades, order) {
  const since = Date.parse(order.entry_filled_at ?? order.created_at) - 2000;
  const mine = trades.filter((t) => Number(t.time) >= since && t.symbol === order.symbol);
  const exitSide = order.side === "LONG" ? "SELL" : "BUY";
  const exits = mine.filter((t) => t.side === exitSide);
  const quantity = exits.reduce((sum, t) => sum + Number(t.qty), 0);
  const price = quantity > 0 ? exits.reduce((sum, t) => sum + Number(t.price) * Number(t.qty), 0) / quantity : null;
  const realized = mine.reduce((sum, t) => sum + Number(t.realizedPnl || 0), 0);
  const commission = mine.filter((t) => (t.commissionAsset ?? "USDT") === "USDT").reduce((sum, t) => sum + Number(t.commission || 0), 0);
  return { price, quantity, profit: mine.length ? realized - commission : null };
}
