/**
 * A local, simulated broker used by "paper" mode: no Binance account, no API keys, no real money.
 * It implements the same method surface as `BinanceClient` / `FuturesTradingClient` (see binance.js), so
 * `OrderManager` / `FuturesManager` / the autobots run completely unchanged against it - they cannot tell
 * the difference between a real client and this one.
 *
 * Market data (prices, candles, exchange rules) is real: every public method delegates to Binance's live,
 * unauthenticated endpoints. Only the account - balances, orders, fills, positions - is simulated locally,
 * with the starting capital the user chose. Limit entries and stop-loss/take-profit fill the moment the
 * live price crosses them; futures positions carry the same liquidation math shown elsewhere in the app.
 */
import { decimalString } from "./decimal.js";
import { getClient, getFuturesClient } from "./binance.js";

export const PAPER_FEE_PERCENT = 0.1; // flat maker/taker %, close to Binance's default VIP0 spot rate
const FUTURES_FEE_PERCENT = 0.05; // close to Binance's default VIP0 futures taker rate
const MAINTENANCE_MARGIN_PCT = 0.5; // mirrors shared/risk.js's approximation
const DEFAULT_SPOT_USDT = 10_000;
const DEFAULT_FUTURES_USDT = 10_000;
const TRIGGERED = new Set(["TRIGGERING", "TRIGGERED", "FINISHED"]);

const round2 = (n) => Math.round(n * 100) / 100;
const round8 = (n) => Math.round(n * 1e8) / 1e8;

let store = null;
let idCounter = 1;
const nextId = (prefix) => `${prefix}${Date.now().toString(36)}${(idCounter++).toString(36)}`;

function freshSpotLedger() {
  return { balances: { USDT: DEFAULT_SPOT_USDT }, locked: {}, orders: {}, orderLists: {} };
}
function freshFuturesLedger() {
  return { wallet: DEFAULT_FUTURES_USDT, leverage: {}, positions: {}, orders: {}, pendingMargin: {}, algoOrders: {}, trades: {} };
}

let spot = freshSpotLedger();
let futures = freshFuturesLedger();

/** Load any saved paper ledgers; call once at startup, before serving requests. */
export async function initPaperBroker(theStore) {
  store = theStore;
  const savedSpot = await store.getSetting("paper_spot_ledger");
  if (savedSpot && typeof savedSpot === "object") spot = { ...freshSpotLedger(), ...savedSpot };
  const savedFutures = await store.getSetting("paper_futures_ledger");
  if (savedFutures && typeof savedFutures === "object") futures = { ...freshFuturesLedger(), ...savedFutures };
}

let saveQueue = Promise.resolve();
function persistSpot() {
  if (!store) return;
  saveQueue = saveQueue.then(() => store.setSetting("paper_spot_ledger", spot)).catch((err) => console.error(`Paper spot ledger save failed: ${err.message}`));
}
function persistFutures() {
  if (!store) return;
  saveQueue = saveQueue.then(() => store.setSetting("paper_futures_ledger", futures)).catch((err) => console.error(`Paper futures ledger save failed: ${err.message}`));
}

/** Directly set an asset's paper balance (spot) - the "capital" the practice account starts a test with. */
export function setPaperSpotBalance(asset, amount) {
  if (!Number.isFinite(amount) || amount < 0) throw new Error("Balance must be zero or a positive number");
  spot.balances[asset] = round8(amount);
  persistSpot();
  return { asset, free: spot.balances[asset] };
}

/** Directly set the paper futures wallet balance. */
export function setPaperFuturesBalance(amount) {
  if (!Number.isFinite(amount) || amount < 0) throw new Error("Balance must be zero or a positive number");
  futures.wallet = round2(amount);
  persistFutures();
  return { asset: "USDT", balance: futures.wallet };
}

/** Wipe every simulated order/position and reset both ledgers to a starting balance. */
export function resetPaperBroker(spotUsdt = DEFAULT_SPOT_USDT, futuresUsdt = DEFAULT_FUTURES_USDT) {
  spot = { ...freshSpotLedger(), balances: { USDT: round8(spotUsdt) } };
  futures = { ...freshFuturesLedger(), wallet: round2(futuresUsdt) };
  persistSpot();
  persistFutures();
}

export function paperSummary() {
  const usedMargin = round2(Object.values(futures.pendingMargin).reduce((s, m) => s + m, 0) + Object.values(futures.positions).reduce((s, p) => s + p.margin, 0));
  return {
    spot: { asset: "USDT", free: spot.balances.USDT ?? 0, locked: spot.locked.USDT ?? 0 },
    futures: { asset: "USDT", wallet: futures.wallet, available: round2(futures.wallet - usedMargin) },
  };
}

// ---------------------------------------------------------------------------------------------
// Spot
// ---------------------------------------------------------------------------------------------

function spotFree(asset) {
  return spot.balances[asset] ?? 0;
}
function spotLocked(asset) {
  return spot.locked[asset] ?? 0;
}
function addFree(asset, amount) {
  spot.balances[asset] = round8((spot.balances[asset] ?? 0) + amount);
}
function addLocked(asset, amount) {
  spot.locked[asset] = round8((spot.locked[asset] ?? 0) + amount);
}
function lockFree(asset, amount) {
  addFree(asset, -amount);
  addLocked(asset, amount);
}
function unlockToFree(asset, amount) {
  addLocked(asset, -amount);
  addFree(asset, amount);
}

export class PaperSpotClient {
  constructor() {
    this.mode = "paper";
  }

  // ---- public market data: delegate to the real, unauthenticated live endpoints ----
  getSymbolTicker(symbol) {
    return getClient("live").getSymbolTicker(symbol);
  }
  getKlines(symbol, interval, limit, endTime) {
    return getClient("live").getKlines(symbol, interval, limit, endTime);
  }
  getTicker24h() {
    return getClient("live").getTicker24h();
  }
  getExchangeInfo(symbol) {
    return getClient("live").getExchangeInfo(symbol);
  }

  async #price(symbol) {
    return Number((await this.getSymbolTicker(symbol)).price);
  }
  async #assetsOf(symbol) {
    const info = await this.getExchangeInfo(symbol);
    const row = info.symbols?.[0];
    if (!row) throw new Error(`Tradable symbol not found: ${symbol}`);
    return { base: row.baseAsset, quote: row.quoteAsset };
  }

  // ---- account ----
  async getAccount() {
    const assets = new Set([...Object.keys(spot.balances), ...Object.keys(spot.locked)]);
    return { balances: [...assets].map((asset) => ({ asset, free: decimalString(spotFree(asset)), locked: decimalString(spotLocked(asset)) })) };
  }

  getTradeFee() {
    return { maker_percent: PAPER_FEE_PERCENT, taker_percent: PAPER_FEE_PERCENT };
  }

  async getOpenOrders(symbol) {
    return Object.values(spot.orders).filter((o) => (!symbol || o.symbol === symbol) && o.status === "NEW");
  }

  async createOrder(params) {
    const { symbol, side, type } = params;
    const quantity = Number(params.quantity);
    if (type === "MARKET") {
      const price = await this.#price(symbol);
      const { base, quote } = await this.#assetsOf(symbol);
      if (side === "SELL") {
        // The base asset is expected to already be free (an OCO cancel unlocks it just before this runs).
        addFree(base, -quantity);
        addFree(quote, round2(quantity * price * (1 - PAPER_FEE_PERCENT / 100)));
      } else {
        addFree(quote, -round2(quantity * price * (1 + PAPER_FEE_PERCENT / 100)));
        addFree(base, quantity);
      }
      persistSpot();
      return { symbol, orderId: nextId("p"), status: "FILLED", executedQty: decimalString(quantity), cummulativeQuoteQty: decimalString(round2(quantity * price)) };
    }

    // LIMIT BUY entry: reserve the quote asset now, fill later (lazily, in getOrder) once price allows it.
    const price = Number(params.price);
    const { quote } = await this.#assetsOf(symbol);
    const cost = round2((quantity * price) / (1 - PAPER_FEE_PERCENT / 100));
    if (spotFree(quote) < cost) throw new Error("Account has insufficient balance for requested action.");
    lockFree(quote, cost);
    const orderId = nextId("p");
    spot.orders[orderId] = { orderId, symbol, side, type, status: "NEW", price, origQty: quantity, executedQty: 0, quoteLocked: cost, quoteAsset: quote, time: Date.now(), updateTime: Date.now() };
    persistSpot();
    return { symbol, orderId, status: "NEW", executedQty: "0" };
  }

  /** SELL OCO: a take-profit LIMIT_MAKER above and a STOP_LOSS_LIMIT below, sharing one order-list id. */
  async createSellOco({ symbol, quantity, takeProfitPrice, stopPrice, stopLimitPrice }) {
    const qty = Number(quantity);
    const { base } = await this.#assetsOf(symbol);
    lockFree(base, qty);
    const orderListId = nextId("l");
    const tpId = nextId("p");
    const slId = nextId("p");
    spot.orders[tpId] = { orderId: tpId, symbol, side: "SELL", type: "LIMIT_MAKER", status: "NEW", price: Number(takeProfitPrice), origQty: qty, executedQty: 0, orderListId, siblingId: slId, baseAsset: base, time: Date.now(), updateTime: Date.now() };
    spot.orders[slId] = { orderId: slId, symbol, side: "SELL", type: "STOP_LOSS_LIMIT", status: "NEW", price: Number(stopLimitPrice), stopPrice: Number(stopPrice), origQty: qty, executedQty: 0, orderListId, siblingId: tpId, baseAsset: base, time: Date.now(), updateTime: Date.now() };
    spot.orderLists[orderListId] = { orderListId, symbol, orderIds: [tpId, slId] };
    persistSpot();
    return { orderListId, orders: [{ symbol, orderId: tpId }, { symbol, orderId: slId }] };
  }

  /** Lazily decide, on every poll, whether a resting order should now be considered filled. */
  async getOrder(symbol, orderId) {
    const order = spot.orders[String(orderId)];
    if (!order) throw new Error("Order not found");
    if (order.status !== "NEW") return toOrderResponse(order);

    const price = await this.#price(symbol);
    const isEntry = order.side === "BUY";
    const isTakeProfit = order.type === "LIMIT_MAKER";
    const filled = isEntry ? price <= order.price : isTakeProfit ? price >= order.price : price <= order.stopPrice;
    if (!filled) return toOrderResponse(order);

    const fillPrice = isEntry ? order.price : isTakeProfit ? order.price : order.price; // stop leg fills near its limit price
    order.status = "FILLED";
    order.executedQty = order.origQty;
    order.updateTime = Date.now();
    order.cummulativeQuoteQty = round2(order.origQty * fillPrice);

    if (isEntry) {
      const { base } = await this.#assetsOf(symbol);
      addLocked(order.quoteAsset, -order.quoteLocked);
      addFree(base, order.origQty);
    } else {
      addLocked(order.baseAsset, -order.origQty);
      const { quote } = await this.#assetsOf(symbol);
      addFree(quote, round2(order.origQty * fillPrice * (1 - PAPER_FEE_PERCENT / 100)));
      if (order.siblingId && spot.orders[order.siblingId]?.status === "NEW") {
        spot.orders[order.siblingId].status = "CANCELED";
        spot.orders[order.siblingId].updateTime = Date.now();
      }
    }
    persistSpot();
    return toOrderResponse(order);
  }

  async cancelOrder(symbol, orderId) {
    const order = spot.orders[String(orderId)];
    if (!order) throw new Error("Order not found");
    if (order.status === "NEW") {
      if (order.side === "BUY") unlockToFree(order.quoteAsset, order.quoteLocked);
      else unlockToFree(order.baseAsset, order.origQty);
      order.status = "CANCELED";
      order.updateTime = Date.now();
      persistSpot();
    }
    return toOrderResponse(order);
  }

  async getOrderList(orderListId) {
    const list = spot.orderLists[String(orderListId)];
    if (!list) throw new Error("Order list not found");
    return { orderListId: list.orderListId, orders: list.orderIds.map((id) => ({ symbol: list.symbol, orderId: id })) };
  }

  async cancelOrderList(symbol, orderListId) {
    const list = spot.orderLists[String(orderListId)];
    if (!list) throw new Error("Order list not found");
    for (const id of list.orderIds) await this.cancelOrder(symbol, id);
    return { orderListId: list.orderListId };
  }
}

function toOrderResponse(order) {
  return {
    symbol: order.symbol,
    orderId: order.orderId,
    status: order.status,
    executedQty: decimalString(order.executedQty ?? 0),
    cummulativeQuoteQty: decimalString(order.cummulativeQuoteQty ?? 0),
    price: decimalString(order.price ?? 0),
    stopPrice: order.stopPrice != null ? decimalString(order.stopPrice) : undefined,
    updateTime: order.updateTime,
  };
}

// ---------------------------------------------------------------------------------------------
// Futures
// ---------------------------------------------------------------------------------------------

function usedMargin() {
  return round2(Object.values(futures.pendingMargin).reduce((s, m) => s + m, 0) + Object.values(futures.positions).reduce((s, p) => s + p.margin, 0));
}

function liquidationPrice(side, entryPrice, leverage) {
  const pct = Math.max(0, 100 / leverage - MAINTENANCE_MARGIN_PCT) / 100;
  return side === "LONG" ? entryPrice * (1 - pct) : entryPrice * (1 + pct);
}

function closeFuturesPosition(symbol, exitPrice) {
  const pos = futures.positions[symbol];
  if (!pos) return null;
  const pnl = (exitPrice - pos.entryPrice) * pos.quantity * (pos.side === "LONG" ? 1 : -1);
  const commission = round2(exitPrice * pos.quantity * (FUTURES_FEE_PERCENT / 100));
  // The margin itself was never deducted from the wallet (only reserved via usedMargin()), so closing only
  // ever applies the P&L - capped at -margin, since isolated margin never loses more than what was put up.
  futures.wallet = round2(Math.max(0, futures.wallet + Math.max(pnl, -pos.margin) - commission));
  const exitSide = pos.side === "LONG" ? "SELL" : "BUY";
  (futures.trades[symbol] ??= []).push({ time: Date.now(), symbol, side: exitSide, qty: pos.quantity, price: exitPrice, realizedPnl: pnl, commission, commissionAsset: "USDT" });
  delete futures.positions[symbol];
  for (const algo of Object.values(futures.algoOrders)) {
    if (algo.symbol === symbol && algo.algoStatus === "WORKING") algo.algoStatus = "CANCELED";
  }
  persistFutures();
  return { pnl, exitPrice };
}

export class PaperFuturesClient {
  constructor() {
    this.mode = "paper";
  }

  // ---- public market data: delegate to the real, unauthenticated public futures API ----
  getSymbolTicker(symbol) {
    return getFuturesClient().getSymbolTicker(symbol);
  }
  getKlines(symbol, interval, limit, endTime) {
    return getFuturesClient().getKlines(symbol, interval, limit, endTime);
  }
  getExchangeInfo() {
    return getFuturesClient().getExchangeInfo();
  }

  async #price(symbol) {
    return Number((await this.getSymbolTicker(symbol)).price);
  }

  // ---- account ----
  async getBalance() {
    return [{ asset: "USDT", balance: String(futures.wallet), availableBalance: String(round2(futures.wallet - usedMargin())) }];
  }

  async getPositions(symbol) {
    // Liquidation is checked lazily: every poll re-prices whatever position(s) are open.
    const symbols = symbol ? [symbol] : Object.keys(futures.positions);
    const rows = [];
    for (const sym of symbols) {
      const pos = futures.positions[sym];
      if (!pos) {
        if (symbol) rows.push(zeroPositionRow(sym));
        continue;
      }
      const mark = await this.#price(sym);
      const liq = liquidationPrice(pos.side, pos.entryPrice, pos.leverage);
      const breached = pos.side === "LONG" ? mark <= liq : mark >= liq;
      if (breached) {
        closeFuturesPosition(sym, liq);
        if (symbol) rows.push(zeroPositionRow(sym));
        continue;
      }
      const amt = pos.side === "LONG" ? pos.quantity : -pos.quantity;
      const unrealized = (mark - pos.entryPrice) * pos.quantity * (pos.side === "LONG" ? 1 : -1);
      rows.push({
        symbol: sym,
        positionAmt: String(amt),
        entryPrice: String(pos.entryPrice),
        markPrice: String(mark),
        unRealizedProfit: String(unrealized),
        liquidationPrice: String(liq),
        leverage: String(pos.leverage),
        marginType: "isolated",
        notional: String(pos.quantity * mark),
      });
    }
    return rows;
  }

  async getPositionMode() {
    return { dualSidePosition: false };
  }

  async changeMarginType(symbol) {
    futures.marginType = { ...futures.marginType, [symbol]: "ISOLATED" };
    return { msg: "success" };
  }

  async changeLeverage(symbol, leverage) {
    futures.leverage[symbol] = Number(leverage);
    persistFutures();
    return { symbol, leverage: Number(leverage) };
  }

  getCommission() {
    return { maker_percent: FUTURES_FEE_PERCENT, taker_percent: FUTURES_FEE_PERCENT };
  }

  async createOrder(params) {
    const { symbol, side, type } = params;
    const quantity = Number(params.quantity);
    if (type === "MARKET") {
      const price = await this.#price(symbol);
      closeFuturesPosition(symbol, price);
      return { symbol, orderId: nextId("f"), status: "FILLED", executedQty: decimalString(quantity) };
    }
    const price = Number(params.price);
    const leverage = futures.leverage[symbol] ?? 1;
    const margin = round2((quantity * price) / leverage);
    if (margin > round2(futures.wallet - usedMargin())) throw new Error("Insufficient futures margin");
    const orderId = nextId("f");
    futures.orders[orderId] = { orderId, symbol, side, type: "LIMIT", status: "NEW", price, quantity, time: Date.now(), updateTime: Date.now() };
    futures.pendingMargin[orderId] = margin;
    persistFutures();
    return { symbol, orderId, status: "NEW", executedQty: "0" };
  }

  async getOrder(symbol, orderId) {
    const order = futures.orders[String(orderId)];
    if (!order) throw new Error("Order not found");
    if (order.status !== "NEW") return toFuturesOrderResponse(order);

    const price = await this.#price(symbol);
    const filled = order.side === "BUY" ? price <= order.price : price >= order.price;
    if (!filled) return toFuturesOrderResponse(order);

    const margin = futures.pendingMargin[order.orderId] ?? 0;
    delete futures.pendingMargin[order.orderId];
    futures.positions[symbol] = { side: order.side === "BUY" ? "LONG" : "SHORT", quantity: order.quantity, entryPrice: order.price, leverage: futures.leverage[symbol] ?? 1, margin, marginType: "ISOLATED" };
    order.status = "FILLED";
    order.executedQty = order.quantity;
    order.updateTime = Date.now();
    persistFutures();
    return toFuturesOrderResponse(order);
  }

  async cancelOrder(symbol, orderId) {
    const order = futures.orders[String(orderId)];
    if (!order) throw new Error("Order not found");
    if (order.status === "NEW") {
      delete futures.pendingMargin[order.orderId];
      order.status = "CANCELED";
      order.updateTime = Date.now();
      persistFutures();
    }
    return toFuturesOrderResponse(order);
  }

  async getOpenOrders(symbol) {
    return Object.values(futures.orders).filter((o) => (!symbol || o.symbol === symbol) && o.status === "NEW").map(toFuturesOrderResponse);
  }

  async cancelAllOpenOrders(symbol) {
    for (const order of Object.values(futures.orders)) {
      if (order.symbol === symbol && order.status === "NEW") await this.cancelOrder(symbol, order.orderId);
    }
    return { msg: "success" };
  }

  async getUserTrades(symbol, startTime) {
    return (futures.trades[symbol] ?? []).filter((t) => !startTime || t.time >= startTime);
  }

  /** STOP_MARKET or TAKE_PROFIT_MARKET that closes the whole position when the trigger price is reached. */
  async createCloseTrigger({ symbol, side, type, triggerPrice }) {
    const algoId = nextId("a");
    futures.algoOrders[algoId] = { algoId, symbol, side, type, triggerPrice: Number(triggerPrice), algoStatus: "WORKING" };
    persistFutures();
    return { algoId };
  }

  async getAlgoOrder(algoId) {
    const algo = futures.algoOrders[String(algoId)];
    if (!algo) throw new Error("Algo order not found");
    if (algo.algoStatus !== "WORKING") return { ...algo };
    if (!futures.positions[algo.symbol]) return { ...algo }; // position already closed some other way

    const price = await this.#price(algo.symbol);
    const isStop = algo.type === "STOP_MARKET";
    const closingLong = algo.side === "SELL";
    const triggered = isStop ? (closingLong ? price <= algo.triggerPrice : price >= algo.triggerPrice) : (closingLong ? price >= algo.triggerPrice : price <= algo.triggerPrice);
    if (!triggered) return { ...algo };

    closeFuturesPosition(algo.symbol, algo.triggerPrice);
    algo.algoStatus = "FINISHED";
    return { ...algo };
  }

  async cancelAlgoOrder(algoId) {
    const algo = futures.algoOrders[String(algoId)];
    if (algo && algo.algoStatus === "WORKING") {
      algo.algoStatus = "CANCELED";
      persistFutures();
    }
    return { msg: "success" };
  }

  async cancelAllAlgoOrders(symbol) {
    for (const algo of Object.values(futures.algoOrders)) {
      if (algo.symbol === symbol && algo.algoStatus === "WORKING") algo.algoStatus = "CANCELED";
    }
    persistFutures();
    return { msg: "success" };
  }
}

function zeroPositionRow(symbol) {
  return { symbol, positionAmt: "0", entryPrice: "0", markPrice: "0", unRealizedProfit: "0", liquidationPrice: "0", leverage: String(futures.leverage[symbol] ?? 1), marginType: "isolated", notional: "0" };
}

function toFuturesOrderResponse(order) {
  return { symbol: order.symbol, orderId: order.orderId, status: order.status, executedQty: decimalString(order.executedQty ?? 0), price: decimalString(order.price ?? 0), updateTime: order.updateTime };
}
