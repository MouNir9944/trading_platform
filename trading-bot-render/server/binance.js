/**
 * Minimal Binance Spot REST client (Testnet or live), with HMAC signing.
 * Replaces python-binance: only the endpoints this app uses are implemented.
 */
import crypto from "node:crypto";

import { assertMode, MODES } from "./config.js";

const BASE_URLS = {
  testnet: "https://testnet.binance.vision",
  live: "https://api.binance.com",
};
const DEFAULT_MODE = (process.env.BINANCE_TESTNET ?? "true").toLowerCase() === "true" ? "testnet" : "live";
export const DEFAULT_SYMBOL = process.env.TRADING_SYMBOL || "XLMUSDT";
const REQUEST_TIMEOUT_MS = 30_000;
const RECV_WINDOW = 10_000;

export class BinanceError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let currentMode = DEFAULT_MODE;
let modeStore = null;

/** Load the last saved account mode; call once at startup before serving requests. */
export async function initMode(store) {
  modeStore = store;
  const saved = await store.getSetting("account_mode");
  if (MODES.includes(saved)) currentMode = saved;
}

export const getMode = () => currentMode;

export function setMode(mode) {
  currentMode = assertMode(mode);
  modeStore?.setSetting("account_mode", mode).catch((err) => console.error("Could not save account mode:", err.message));
  return mode;
}

export const isTestnet = (mode = getMode()) => mode === "testnet";

function credentials(mode) {
  const env = process.env;
  const [key, secret] = isTestnet(mode)
    ? [env.BINANCE_API_KEY, env.BINANCE_API_SECRET]
    : [
        env.BINANCE_API_KEY_real || env.BINANCE_API_KEY_REAL,
        env.BINANCE_API_SECRET_real || env.BINANCE_API_SECRET_REAL,
      ];
  if (!key || !secret) {
    throw new Error(`Missing Binance ${mode} credentials. Check the matching environment variables.`);
  }
  return { key, secret };
}

const clients = new Map();

export function getClient(mode = getMode()) {
  assertMode(mode);
  if (!clients.has(mode)) clients.set(mode, new BinanceClient(mode));
  return clients.get(mode);
}

export class BinanceClient {
  constructor(mode) {
    this.mode = mode;
    this.baseUrl = BASE_URLS[mode];
    this.timeOffset = 0;
    this.offsetSyncedAt = 0;
    this.bannedUntil = 0; // epoch ms; while in the future, no request is sent
  }

  /** API key pair for signed requests. Futures clients override this. */
  credentials() {
    return credentials(this.mode);
  }

  async request(method, path, params = {}, { signed = false } = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) query.set(key, String(value));
    }
    if (Date.now() < this.bannedUntil) {
      throw new BinanceError(
        `Binance rate limit: requests paused until ${new Date(this.bannedUntil).toISOString()} (IP ban / too many requests)`,
        { status: 429, code: -1003 },
      );
    }
    const headers = {};
    if (signed) {
      const { key, secret } = this.credentials();
      await this.syncTime();
      query.set("recvWindow", String(RECV_WINDOW));
      query.set("timestamp", String(Date.now() + this.timeOffset));
      query.set("signature", crypto.createHmac("sha256", secret).update(query.toString()).digest("hex"));
      headers["X-MBX-APIKEY"] = key;
    }

    let response;
    try {
      response = await fetch(`${this.baseUrl}${path}?${query}`, {
        method,
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Wording kept close to what requests/python-binance produced so transient-error detection matches.
      throw new BinanceError(
        err.name === "TimeoutError" ? "Request timed out" : `Network error: ${err.cause?.code || err.message}`,
      );
    }

    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { msg: text };
    }
    if (response.status === 418 || response.status === 429 || body.code === -1003) {
      this.#pauseAfterLimit(response, body);
    }
    if (!response.ok) {
      throw new BinanceError(`APIError(code=${body.code ?? response.status}): ${body.msg ?? response.statusText}`, {
        status: response.status,
        code: body.code,
      });
    }
    return body;
  }

  /** Back off until the ban / Retry-After window ends instead of extending it with more calls. */
  #pauseAfterLimit(response, body) {
    const banned = /banned until (\d{10,})/.exec(String(body.msg ?? ""));
    const retryAfter = Number(response.headers.get("retry-after"));
    const until = banned
      ? Number(banned[1])
      : Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 60_000);
    this.bannedUntil = Math.max(this.bannedUntil, until);
  }

  /** Align signed timestamps with Binance's clock (hosts can drift). */
  async syncTime() {
    if (Date.now() - this.offsetSyncedAt < 10 * 60_000) return;
    try {
      const { serverTime } = await this.request("GET", this.timePath ?? "/api/v3/time");
      this.timeOffset = serverTime - Date.now();
      this.offsetSyncedAt = Date.now();
    } catch {
      /* keep the previous offset */
    }
  }

  // ---- public market data ----
  getSymbolTicker(symbol) {
    return this.request("GET", "/api/v3/ticker/price", { symbol });
  }
  getKlines(symbol, interval, limit, endTime) {
    return this.request("GET", "/api/v3/klines", { symbol, interval, limit, endTime });
  }
  /** 24h stats for every symbol (weight ~80, so callers cache it). */
  getTicker24h() {
    return this.request("GET", "/api/v3/ticker/24hr");
  }
  getExchangeInfo(symbol) {
    return this.request("GET", "/api/v3/exchangeInfo", { symbol });
  }

  // ---- account / orders (signed) ----
  getAccount() {
    return this.request("GET", "/api/v3/account", {}, { signed: true });
  }
  getOpenOrders(symbol) {
    return this.request("GET", "/api/v3/openOrders", { symbol }, { signed: true });
  }
  getOrder(symbol, orderId) {
    return this.request("GET", "/api/v3/order", { symbol, orderId }, { signed: true });
  }
  createOrder(params) {
    return this.request("POST", "/api/v3/order", params, { signed: true });
  }
  cancelOrder(symbol, orderId) {
    return this.request("DELETE", "/api/v3/order", { symbol, orderId }, { signed: true });
  }
  getOrderList(orderListId) {
    return this.request("GET", "/api/v3/orderList", { orderListId }, { signed: true });
  }
  cancelOrderList(symbol, orderListId) {
    return this.request("DELETE", "/api/v3/orderList", { symbol, orderListId }, { signed: true });
  }

  /** SELL OCO: take-profit LIMIT_MAKER above, STOP_LOSS_LIMIT below. */
  createSellOco({ symbol, quantity, takeProfitPrice, stopPrice, stopLimitPrice }) {
    return this.request(
      "POST",
      "/api/v3/orderList/oco",
      {
        symbol,
        side: "SELL",
        quantity,
        aboveType: "LIMIT_MAKER",
        abovePrice: takeProfitPrice,
        belowType: "STOP_LOSS_LIMIT",
        belowStopPrice: stopPrice,
        belowPrice: stopLimitPrice,
        belowTimeInForce: "GTC",
      },
      { signed: true },
    );
  }

  /** Maker/taker commission in percent. Only served by the live API; callers fall back. */
  async getTradeFee(symbol) {
    const fees = await this.request("GET", "/sapi/v1/asset/tradeFee", { symbol }, { signed: true });
    const fee = Array.isArray(fees) ? fees[0] : fees;
    const maker = fee?.makerCommission ?? fee?.maker;
    const taker = fee?.takerCommission ?? fee?.taker;
    if (maker === undefined || taker === undefined) {
      throw new Error("Binance fee response did not include maker/taker commission");
    }
    return { maker_percent: Number(maker) * 100, taker_percent: Number(taker) * 100 };
  }
}

/**
 * Public USD-M Futures market data (klines, tickers, contract list). Read-only: no keys are used and signed
 * requests are refused, so this client can never place or change an order.
 */
export class FuturesClient extends BinanceClient {
  constructor() {
    super("live");
    this.baseUrl = "https://fapi.binance.com";
  }

  request(method, path, params = {}, options = {}) {
    if (options.signed) throw new Error("Futures trading is not enabled: this client is read-only.");
    return super.request(method, path, params, options);
  }

  getSymbolTicker(symbol) {
    return this.request("GET", "/fapi/v1/ticker/price", { symbol });
  }
  getKlines(symbol, interval, limit, endTime) {
    return this.request("GET", "/fapi/v1/klines", { symbol, interval, limit, endTime });
  }
  getExchangeInfo() {
    return this.request("GET", "/fapi/v1/exchangeInfo");
  }
  getTicker24h() {
    return this.request("GET", "/fapi/v1/ticker/24hr");
  }
  /** Best bid/ask for every contract (the 24h ticker has no spread). */
  getBookTickers() {
    return this.request("GET", "/fapi/v1/ticker/bookTicker");
  }
}

/**
 * Authenticated USD-M Futures client (Binance futures demo/testnet or live). Only what the trading flow needs.
 *
 * Testnet uses the futures demo host and its own API keys (BINANCE_FUTURES_API_KEY / _SECRET): the Spot testnet
 * keys do not work there. Live uses BINANCE_FUTURES_API_KEY_real, falling back to the live Spot key pair when
 * that key has Futures enabled.
 *
 * Conditional orders (stop-loss / take-profit) go through Binance's Algo Order endpoints: the regular order
 * endpoint no longer accepts STOP_MARKET / TAKE_PROFIT_MARKET.
 */
const FUTURES_URLS = {
  testnet: process.env.BINANCE_FUTURES_TESTNET_URL || "https://demo-fapi.binance.com",
  live: "https://fapi.binance.com",
};

export class FuturesTradingClient extends BinanceClient {
  constructor(mode) {
    super(mode);
    this.baseUrl = FUTURES_URLS[mode];
    this.timePath = "/fapi/v1/time";
  }

  credentials() {
    const env = process.env;
    const [key, secret] = isTestnet(this.mode)
      ? [env.BINANCE_FUTURES_API_KEY, env.BINANCE_FUTURES_API_SECRET]
      : [
          env.BINANCE_FUTURES_API_KEY_real || env.BINANCE_API_KEY_real || env.BINANCE_API_KEY_REAL,
          env.BINANCE_FUTURES_API_SECRET_real || env.BINANCE_API_SECRET_real || env.BINANCE_API_SECRET_REAL,
        ];
    if (!key || !secret) {
      throw new Error(
        isTestnet(this.mode)
          ? "Missing Binance futures testnet credentials. Set BINANCE_FUTURES_API_KEY and BINANCE_FUTURES_API_SECRET (the Spot testnet keys do not work for futures)."
          : "Missing Binance live futures credentials. Set BINANCE_FUTURES_API_KEY_real and BINANCE_FUTURES_API_SECRET_real, or enable Futures on your live key.",
      );
    }
    return { key, secret };
  }

  // ---- public ----
  getSymbolTicker(symbol) {
    return this.request("GET", "/fapi/v1/ticker/price", { symbol });
  }
  getKlines(symbol, interval, limit, endTime) {
    return this.request("GET", "/fapi/v1/klines", { symbol, interval, limit, endTime });
  }
  getExchangeInfo() {
    return this.request("GET", "/fapi/v1/exchangeInfo");
  }

  // ---- account ----
  getBalance() {
    return this.request("GET", "/fapi/v2/balance", {}, { signed: true });
  }
  /** Every position (or one symbol's): leverage, margin type, liquidation price, unrealized profit. */
  async getPositions(symbol) {
    try {
      return await this.request("GET", "/fapi/v2/positionRisk", { symbol }, { signed: true });
    } catch (err) {
      if (err.status !== 404) throw err;
      return this.request("GET", "/fapi/v3/positionRisk", { symbol }, { signed: true });
    }
  }
  /** `{dualSidePosition: true}` means Hedge Mode, which this app does not support. */
  getPositionMode() {
    return this.request("GET", "/fapi/v1/positionSide/dual", {}, { signed: true });
  }
  changeMarginType(symbol, marginType) {
    return this.request("POST", "/fapi/v1/marginType", { symbol, marginType }, { signed: true });
  }
  changeLeverage(symbol, leverage) {
    return this.request("POST", "/fapi/v1/leverage", { symbol, leverage }, { signed: true });
  }
  async getCommission(symbol) {
    const rates = await this.request("GET", "/fapi/v1/commissionRate", { symbol }, { signed: true });
    return { maker_percent: Number(rates.makerCommissionRate) * 100, taker_percent: Number(rates.takerCommissionRate) * 100 };
  }

  // ---- regular orders (entry, market close) ----
  createOrder(params) {
    return this.request("POST", "/fapi/v1/order", params, { signed: true });
  }
  getOrder(symbol, orderId) {
    return this.request("GET", "/fapi/v1/order", { symbol, orderId }, { signed: true });
  }
  cancelOrder(symbol, orderId) {
    return this.request("DELETE", "/fapi/v1/order", { symbol, orderId }, { signed: true });
  }
  getOpenOrders(symbol) {
    return this.request("GET", "/fapi/v1/openOrders", { symbol }, { signed: true });
  }
  cancelAllOpenOrders(symbol) {
    return this.request("DELETE", "/fapi/v1/allOpenOrders", { symbol }, { signed: true });
  }
  getUserTrades(symbol, startTime) {
    return this.request("GET", "/fapi/v1/userTrades", { symbol, startTime, limit: 1000 }, { signed: true });
  }

  // ---- conditional orders (stop-loss / take-profit) ----
  /** STOP_MARKET or TAKE_PROFIT_MARKET that closes the whole position when the trigger price is reached. */
  createCloseTrigger({ symbol, side, type, triggerPrice }) {
    return this.request(
      "POST",
      "/fapi/v1/algoOrder",
      { algoType: "CONDITIONAL", symbol, side, type, triggerPrice, closePosition: "true", workingType: "MARK_PRICE" },
      { signed: true },
    );
  }
  getAlgoOrder(algoId) {
    return this.request("GET", "/fapi/v1/algoOrder", { algoId }, { signed: true });
  }
  cancelAlgoOrder(algoId) {
    return this.request("DELETE", "/fapi/v1/algoOrder", { algoId }, { signed: true });
  }
  cancelAllAlgoOrders(symbol) {
    return this.request("DELETE", "/fapi/v1/algoOpenOrders", { symbol }, { signed: true });
  }
}

const futuresTraders = new Map();
export function getFuturesTrader(mode = getMode()) {
  assertMode(mode);
  if (!futuresTraders.has(mode)) futuresTraders.set(mode, new FuturesTradingClient(mode));
  return futuresTraders.get(mode);
}

let futuresClient = null;
export const getFuturesClient = () => (futuresClient ??= new FuturesClient());

// ---- helpers mirroring binance_client.py ----
export async function getAccountBalance(client) {
  const account = await client.getAccount();
  return account.balances.filter((b) => Number(b.free) > 0 || Number(b.locked) > 0);
}

export async function getCurrentPrice(client, symbol = DEFAULT_SYMBOL) {
  return Number((await client.getSymbolTicker(symbol)).price);
}

export const getRecentCandles = (client, symbol = DEFAULT_SYMBOL, interval = "1h", limit = 100, endTime) =>
  client.getKlines(symbol, interval, limit, endTime);

export const getTradingFee = (client, symbol = DEFAULT_SYMBOL) => client.getTradeFee(symbol);
