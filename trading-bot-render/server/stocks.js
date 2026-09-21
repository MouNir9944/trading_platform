/**
 * Binance Stocks (US-listed stocks and ETFs): a separate product from Spot, with its own API under
 * /sapi/v1/equity/*. It exists on the LIVE account only (there is no testnet), so this always uses the live keys.
 *
 * Binance offers quotes, orders and trade history but NO holdings endpoint, so the portfolio is rebuilt from the
 * account's executed trades (average-cost method) and valued at the live bid. Things that change a position
 * without a trade (transfers, tokenization, corporate actions) are therefore not reflected.
 */
import crypto from "node:crypto";

import { BinanceClient } from "./binance.js";
import { decimalString } from "./decimal.js";

const DAY_MS = 86_400_000;
const WINDOW_MS = 90 * DAY_MS; // the history endpoints need a time range; 90 days per request is accepted
const PAGE_SIZE = 100;
const MAX_WINDOWS = 12;
const DUST = 1e-9;

export class StocksClient extends BinanceClient {
  constructor() {
    super("live");
  }

  exchangeInfo(symbol) {
    return this.request("GET", "/sapi/v1/equity/market/exchangeInfo", { symbol }, { signed: true });
  }
  quote(symbol) {
    return this.request("GET", "/sapi/v1/equity/market/quote", { symbol }, { signed: true });
  }
  tokenizedAssets() {
    return this.request("GET", "/sapi/v1/equity/market/tokenized-assets", {}, { signed: true });
  }
  tradeHistory(params) {
    return this.request("GET", "/sapi/v1/equity/trade/history", params, { signed: true });
  }
  orderHistory(params) {
    return this.request("GET", "/sapi/v1/equity/order/history", params, { signed: true });
  }
  openOrders() {
    return this.request("GET", "/sapi/v1/equity/order/open-orders", {}, { signed: true });
  }
  placeOrder(params) {
    return this.request("POST", "/sapi/v1/equity/order/place", params, { signed: true });
  }
  cancelOrder(orderId) {
    return this.request("POST", "/sapi/v1/equity/order/cancel", { orderId }, { signed: true });
  }
}

let stocksClient = null;
export const getStocksClient = () => (stocksClient ??= new StocksClient());

/** Walk back through the history window by window (the endpoints need a time range), paging inside each. */
async function fetchWindows(fetchPage, keyOf, now) {
  const byId = new Map();
  let empty = 0;
  for (let i = 0; i < MAX_WINDOWS && empty < 3; i++) {
    const endTime = now - i * WINDOW_MS;
    const startTime = endTime - WINDOW_MS;
    let found = 0;
    for (let page = 1; ; page++) {
      const result = await fetchPage({ startTime, endTime, current: page, size: PAGE_SIZE });
      const rows = result.rows ?? [];
      for (const row of rows) byId.set(keyOf(row), row);
      found += rows.length;
      if (rows.length < PAGE_SIZE || found >= (result.total ?? found)) break;
    }
    empty = found === 0 ? empty + 1 : 0;
  }
  return [...byId.values()];
}

/** Every executed trade, de-duplicated. Stops after three empty windows in a row. */
export const fetchAllTrades = (client, now = Date.now()) => fetchWindows((p) => client.tradeHistory(p), (row) => row.executionId, now);

/** Every order (they carry the fee, which the trade rows do not). */
export const fetchAllOrders = (client, now = Date.now()) => fetchWindows((p) => client.orderHistory(p), (row) => row.orderId, now);

/**
 * Each order's fee (from order history) spread over its trades in proportion to their value. Binance counts the
 * fee in a position's cost, so without it the average cost comes out a little low.
 */
export function feeShares(trades, orders = []) {
  const feeByOrder = new Map(orders.map((o) => [o.orderId, Number(o.fee) || 0]));
  const valueByOrder = new Map();
  for (const t of trades) valueByOrder.set(t.orderId, (valueByOrder.get(t.orderId) ?? 0) + Number(t.qty) * Number(t.price));
  return (t) => {
    const total = valueByOrder.get(t.orderId) ?? 0;
    return total > 0 ? ((feeByOrder.get(t.orderId) ?? 0) * Number(t.qty) * Number(t.price)) / total : 0;
  };
}

/**
 * Positions from executed trades, oldest first, by the average-cost method: a buy adds to quantity and cost (fee
 * included), a sell removes the average cost of what it sold and books the difference, net of its fee, as realized profit.
 */
export function buildPositions(trades, orders = []) {
  const bySymbol = new Map();
  const feeOf = feeShares(trades, orders);
  for (const t of [...trades].sort((a, b) => Number(a.executionAt) - Number(b.executionAt))) {
    const qty = Number(t.qty);
    const price = Number(t.price);
    if (!(qty > 0) || !(price > 0)) continue;
    const fee = feeOf(t);
    const p = bySymbol.get(t.symbol) ?? { symbol: t.symbol, quantity: 0, cost: 0, realized: 0, lastTradeAt: 0, trades: 0 };
    if (t.side === "BUY") {
      p.quantity += qty;
      p.cost += qty * price + fee;
    } else {
      const average = p.quantity > 0 ? p.cost / p.quantity : price;
      const sold = Math.min(qty, p.quantity);
      p.realized += price * sold - fee - average * sold;
      p.cost -= average * sold;
      p.quantity -= sold;
    }
    if (p.quantity < DUST) { p.quantity = 0; p.cost = 0; }
    p.lastTradeAt = Math.max(p.lastTradeAt, Number(t.executionAt) || 0);
    p.trades += 1;
    bySymbol.set(t.symbol, p);
  }
  return [...bySymbol.values()].map((p) => ({ ...p, avgCost: p.quantity > 0 ? p.cost / p.quantity : null }));
}

/** The price a holding can be sold at now: the bid. Falls back to the ask, then to nothing. */
export function quotePrice(quote) {
  const bid = Number(quote?.bidPrice);
  const ask = Number(quote?.askPrice);
  if (bid > 0) return bid;
  return ask > 0 ? ask : null;
}

/** Open positions valued with the given quotes ({SYMBOL: quote}). */
export function valuePortfolio(positions, quotes, names = {}) {
  const holdings = positions
    .filter((p) => p.quantity > 0)
    .map((p) => {
      const price = quotePrice(quotes[p.symbol]);
      const value = price == null ? null : p.quantity * price;
      const pnl = value == null ? null : value - p.cost;
      return {
        symbol: p.symbol,
        name: names[p.symbol] ?? null,
        quantity: p.quantity,
        avgCost: p.avgCost,
        costBasis: p.cost,
        price,
        value,
        pnl,
        pnlPct: pnl == null || p.cost <= 0 ? null : (pnl / p.cost) * 100,
        realized: p.realized,
        lastTradeAt: p.lastTradeAt,
      };
    })
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const sum = (key) => holdings.reduce((total, h) => total + (h[key] ?? 0), 0);
  const priced = holdings.filter((h) => h.value != null);
  return {
    holdings,
    totals: {
      value: sum("value"),
      cost: priced.reduce((total, h) => total + h.costBasis, 0),
      pnl: sum("pnl"),
      realized: positions.reduce((total, p) => total + p.realized, 0),
    },
  };
}

export async function getPortfolio(client, now = Date.now()) {
  const trades = await fetchAllTrades(client, now);
  let orders = [];
  try {
    orders = await fetchAllOrders(client, now);
  } catch { /* without fees the average cost is slightly low, but the holdings are right */ }
  const positions = buildPositions(trades, orders);
  const open = positions.filter((p) => p.quantity > 0);
  const quotes = {};
  await Promise.all(open.map(async (p) => {
    try {
      quotes[p.symbol] = await client.quote(p.symbol);
    } catch { /* an unpriced holding still shows, without a value */ }
  }));
  const names = {};
  try {
    for (const asset of await client.tokenizedAssets()) names[asset.underlyingEquitySymbol] = String(asset.assetName).replace(/\s*\(bStocks\)/i, "");
  } catch { /* names are a nicety */ }
  return { ...valuePortfolio(positions, quotes, names), tradeCount: trades.length, updatedAt: now };
}

const bad = (message) => Object.assign(new Error(message), { httpStatus: 422 });
const decimals = (value) => (String(value).split(".")[1] ?? "").length;

/**
 * Turn what the ticket sends into the exact parameters Binance expects, refusing anything its rules forbid:
 *  MARKET BUY: `notional` (money to spend) only;  MARKET SELL: `quantity` only;
 *  LIMIT: `price` (2 decimals at most), `quantity` and a trading session; GTC only for LIMIT, and a fractional GTC
 *  order must use the EXTENDED or 24H session.
 */
export function buildEquityOrder(body, { info = null } = {}) {
  const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) throw bad("symbol must be a US stock ticker such as AAPL");
  const side = body.side;
  if (side !== "BUY" && side !== "SELL") throw bad("side must be BUY or SELL");
  const type = body.order_type;
  if (type !== "MARKET" && type !== "LIMIT") throw bad("order_type must be MARKET or LIMIT");
  const positive = (value, name) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw bad(`${name} must be a positive number`);
    return value;
  };

  const quoteAsset = String(body.quote_asset ?? "USDC").toUpperCase();
  if (!/^[A-Z]{3,5}$/.test(quoteAsset)) throw bad("quote_asset must be a currency code such as USDC");
  const params = {
    symbol, side, orderType: type, quoteAsset,
    clientOrderId: crypto.randomUUID(), // makes a retried request idempotent
    tokenize: body.tokenize === true ? "true" : "false",
  };
  if (side === "BUY") {
    const wallet = String(body.wallet_type ?? "MAIN").toUpperCase();
    if (wallet !== "MAIN" && wallet !== "CARD") throw bad("wallet_type must be MAIN or CARD");
    params.walletType = wallet;
  }

  if (type === "MARKET") {
    if (body.price != null) throw bad("a market order has no price");
    if (side === "BUY") {
      if (body.quantity != null) throw bad("a market buy is placed by amount (notional), not quantity");
      const notional = Math.floor(positive(body.notional, "notional") * 100) / 100;
      if (notional <= 0) throw bad("notional is below 0.01");
      if (info?.minNotional && notional < Number(info.minNotional)) throw bad(`Binance's minimum for ${symbol} is ${info.minNotional} (you entered ${notional})`);
      params.notional = decimalString(notional);
    } else {
      if (body.notional != null) throw bad("a market sell is placed by quantity, not notional");
      params.quantity = decimalString(positive(body.quantity, "quantity"));
    }
  } else {
    if (body.notional != null) throw bad("a limit order is placed by quantity and price");
    const price = positive(body.price, "price");
    if (decimals(price) > 2) throw bad("price can have at most 2 decimals");
    const quantity = positive(body.quantity, "quantity");
    const session = String(body.trading_session ?? "RTH").toUpperCase();
    if (!["RTH", "EXTENDED", "24H"].includes(session)) throw bad("trading_session must be RTH, EXTENDED or 24H");
    const tif = String(body.time_in_force ?? "DAY").toUpperCase();
    if (tif !== "DAY" && tif !== "GTC") throw bad("time_in_force must be DAY or GTC");
    if (tif === "GTC" && !Number.isInteger(quantity) && session === "RTH") throw bad("a fractional-share GTC order needs the EXTENDED or 24H session");
    if (info?.fractionable === false && !Number.isInteger(quantity)) throw bad(`${symbol} cannot be traded in fractions: use a whole number of shares`);
    if (info?.minNotional && price * quantity < Number(info.minNotional)) throw bad(`Order value ${(price * quantity).toFixed(2)} is below Binance's minimum of ${info.minNotional} for ${symbol}`);
    Object.assign(params, { price: decimalString(price), quantity: decimalString(quantity), tradingSession: session, timeInForce: tif });
  }
  return params;
}
