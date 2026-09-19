import express from "express";
import fs from "node:fs";
import path from "node:path";

import { basicAuth } from "./auth.js";
import * as binance from "./binance.js";
import { assertMode, ROOT_DIR } from "./config.js";
import { OrderManager } from "./orders.js";
import {
  calculateExitPrices,
  calculatePositionSizeByRisk,
  generateSignal,
  klinesToCandles,
} from "./strategy.js";

const DIST_DIR = path.join(ROOT_DIR, "dist");
const SYMBOLS_TTL_MS = 5 * 60_000;

/** Route wrapper: any thrown error becomes `{detail}` with the given status (FastAPI-style). */
const handle = (status, fn) => async (req, res) => {
  try {
    res.json(await fn(req, res));
  } catch (err) {
    res.status(err.httpStatus ?? status).json({ detail: err.message || String(err) });
  }
};

const badRequest = (message) => Object.assign(new Error(message), { httpStatus: 422 });

function requireNumber(value, name, { positive = true } = {}) {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n) || (positive && n <= 0)) throw badRequest(`${name} must be a positive number`);
  return n;
}

function parseMode(value) {
  const mode = String(value ?? binance.getMode()).toLowerCase();
  return assertMode(mode);
}

export function createApp({ orderManager, auth } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // Render terminates TLS in front of the service
  app.use(express.json());

  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  if (auth) app.use(basicAuth(auth));

  const api = express.Router();
  const manager =
    orderManager ??
    new OrderManager({
      getClient: binance.getClient,
      getMode: binance.getMode,
      getTradingFee: binance.getTradingFee,
    });

  api.get("/", handle(500, () => ({ status: "ok", message: "Trading bot API is running" })));

  api.get("/account/balance", handle(500, async () => ({
    balances: await binance.getAccountBalance(binance.getClient()),
  })));

  api.get("/market/price", handle(500, async (req) => {
    const symbol = String(req.query.symbol || binance.DEFAULT_SYMBOL);
    return { symbol, price: await binance.getCurrentPrice(binance.getClient(), symbol) };
  }));

  api.get("/market/candles", handle(500, async (req) => {
    const symbol = String(req.query.symbol || binance.DEFAULT_SYMBOL);
    const interval = String(req.query.interval || "1h");
    const limit = Number(req.query.limit || 100);
    return { symbol, interval, candles: await binance.getRecentCandles(binance.getClient(), symbol, interval, limit) };
  }));

  const symbolCache = new Map();
  api.get("/market/symbols", handle(500, async (req) => {
    const quote = String(req.query.quote || "USDT").toUpperCase();
    const mode = binance.getMode();
    const key = `${mode}:${quote}`;
    const cached = symbolCache.get(key);
    if (cached && Date.now() - cached.at < SYMBOLS_TTL_MS) return { symbols: cached.symbols };
    const info = await binance.getClient(mode).getExchangeInfo();
    const symbols = info.symbols
      .filter((s) => s.status === "TRADING" && s.isSpotTradingAllowed && s.quoteAsset === quote)
      .map((s) => s.symbol)
      .sort();
    symbolCache.set(key, { at: Date.now(), symbols });
    return { symbols };
  }));

  api.get("/account/trading-fee", handle(500, async (req) => {
    const symbol = String(req.query.symbol || binance.DEFAULT_SYMBOL);
    return { symbol, ...(await binance.getTradingFee(binance.getClient(), symbol)) };
  }));

  api.get("/account/mode", handle(500, () => {
    const mode = binance.getMode();
    return { mode, testnet: binance.isTestnet(mode) };
  }));

  api.post("/account/mode", handle(400, (req) => {
    const mode = binance.setMode(String(req.body?.mode ?? "").toLowerCase());
    return { mode, testnet: binance.isTestnet(mode) };
  }));

  api.get("/orders", handle(400, (req) => {
    const mode = parseMode(req.query.mode);
    return { orders: manager.listOrders(mode), mode, testnet: binance.isTestnet(mode) };
  }));

  api.get("/orders/binance-open", handle(500, async (req) => {
    const mode = parseMode(req.query.mode);
    const symbol = req.query.symbol ? String(req.query.symbol) : undefined;
    return { orders: await binance.getClient(mode).getOpenOrders(symbol), mode };
  }));

  api.delete("/orders/binance-open/:symbol/:orderId", handle(400, async (req) => {
    const mode = parseMode(req.query.mode ?? "testnet");
    const order = await binance.getClient(mode).cancelOrder(req.params.symbol.toUpperCase(), req.params.orderId);
    return { cancelled: true, order };
  }));

  api.get("/orders/limits", handle(500, () => manager.getLimits()));

  api.post("/orders/limits", handle(400, (req) =>
    manager.setLimits(Number(req.query.max_open_orders), Number(req.query.max_daily_orders))));

  api.post("/orders/conditional", handle(400, (req) => {
    const body = req.body ?? {};
    const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
    if (!/^[A-Z0-9]{5,20}$/.test(symbol)) throw badRequest("symbol must be 5-20 letters/digits");
    return manager.createOrder({
      symbol,
      entry_price: requireNumber(body.entry_price, "entry_price"),
      capital_usdt: requireNumber(body.capital_usdt, "capital_usdt"),
      stop_loss_price: requireNumber(body.stop_loss_price, "stop_loss_price"),
      take_profit_price: requireNumber(body.take_profit_price, "take_profit_price"),
    });
  }));

  api.patch("/orders/:orderId/entry", handle(400, (req) => {
    const body = req.body ?? {};
    const steps = body.steps ?? 1;
    if (!Number.isInteger(steps) || steps < 1 || steps > 100) throw badRequest("steps must be an integer from 1 to 100");
    return manager.modifyEntryPrice(req.params.orderId, {
      entry_price: body.entry_price == null ? null : requireNumber(body.entry_price, "entry_price"),
      direction: body.direction ?? null,
      steps,
    });
  }));

  // Static "history"/"cleanup-all" routes must be registered before "/orders/:orderId".
  api.delete("/orders/history", handle(400, () => manager.clearHistory(binance.getMode())));
  api.post("/orders/cleanup-all", handle(400, () => manager.cleanupAllAccounts()));
  api.delete("/orders/:orderId", handle(400, (req) => manager.cancelOrder(req.params.orderId)));
  api.delete("/orders/:orderId/history", handle(400, (req) => manager.deleteHistory(req.params.orderId)));

  api.get("/strategy/signal", handle(500, async (req) => {
    const symbol = String(req.query.symbol || binance.DEFAULT_SYMBOL);
    const interval = String(req.query.interval || "1h");
    const capital = Number(req.query.capital_usdt || 1000);
    const klines = await binance.getRecentCandles(binance.getClient(), symbol, interval, 100);
    const candles = klinesToCandles(klines);
    const signal = generateSignal(candles);
    const currentPrice = candles[candles.length - 1].close;
    const result = { symbol, interval, current_price: currentPrice, signal };
    if (signal === "BUY") {
      const quantity = calculatePositionSizeByRisk(capital, currentPrice);
      result.position_sizing = {
        capital_usdt: capital,
        quantity: Math.round(quantity * 1e4) / 1e4,
        ...calculateExitPrices(currentPrice),
      };
    }
    return result;
  }));

  app.use("/api", api);
  app.use("/api", (_req, res) => res.status(404).json({ detail: "Not found" }));

  // Built React app (SPA fallback for everything that isn't /api).
  if (fs.existsSync(DIST_DIR)) {
    app.use(express.static(DIST_DIR, { index: false, maxAge: "1h" }));
    app.get("*", (_req, res) => res.sendFile(path.join(DIST_DIR, "index.html")));
  }

  return { app, manager };
}
