/**
 * Minimal Binance Spot REST client (Testnet or live), with HMAC signing.
 * Replaces python-binance: only the endpoints this app uses are implemented.
 */
import crypto from "node:crypto";
import fs from "node:fs";

import { assertMode, dataPath, writeFileSafe } from "./config.js";

const BASE_URLS = {
  testnet: "https://testnet.binance.vision",
  live: "https://api.binance.com",
};
const MODE_FILE = dataPath("account_mode.txt");
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

export function getMode() {
  try {
    const mode = fs.readFileSync(MODE_FILE, "utf-8").trim().toLowerCase();
    return mode === "testnet" || mode === "live" ? mode : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

export function setMode(mode) {
  writeFileSafe(MODE_FILE, assertMode(mode));
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
      const { key, secret } = credentials(this.mode);
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
      const { serverTime } = await this.request("GET", "/api/v3/time");
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
  getKlines(symbol, interval, limit) {
    return this.request("GET", "/api/v3/klines", { symbol, interval, limit });
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

// ---- helpers mirroring binance_client.py ----
export async function getAccountBalance(client) {
  const account = await client.getAccount();
  return account.balances.filter((b) => Number(b.free) > 0 || Number(b.locked) > 0);
}

export async function getCurrentPrice(client, symbol = DEFAULT_SYMBOL) {
  return Number((await client.getSymbolTicker(symbol)).price);
}

export const getRecentCandles = (client, symbol = DEFAULT_SYMBOL, interval = "1h", limit = 100) =>
  client.getKlines(symbol, interval, limit);

export const getTradingFee = (client, symbol = DEFAULT_SYMBOL) => client.getTradeFee(symbol);
