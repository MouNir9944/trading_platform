import express from "express";
import fs from "node:fs";
import path from "node:path";

import { basicAuth } from "./auth.js";
import * as binance from "./binance.js";
import { assertMode, ROOT_DIR } from "./config.js";
import { getSymbolInfo } from "./orders.js";
import { buildEquityOrder, getPortfolio, getStocksClient } from "./stocks.js";
import { createStockData } from "./stockData.js";
import { createNews } from "./news.js";
import { INTERVAL_MS } from "./autoAmd.js";
import { fetchHistory } from "./candles.js";
import { toCandles } from "../shared/analysis/index.js";
import { backtestAmd, sweepAmd } from "../shared/analysis/amdTrade.js";
import { MIN_SCORED_VOLUME, buildOverview, createMarketCaps } from "./market.js";
import { categorizeFutures, categorizeSpot, equityBasesFrom } from "./categories.js";
import { computeCapital, computeRiskState, tradeStats } from "../shared/risk.js";
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

/**
 * Short-lived response cache with in-flight de-duplication. The dashboard polls often and Render's
 * outbound IP is shared, so identical Binance calls within a few seconds are served once.
 */
function createCache() {
  const entries = new Map();
  return {
    get(key, ttlMs, load) {
      const hit = entries.get(key);
      if (hit && Date.now() - hit.at < ttlMs) return hit.value;
      const value = Promise.resolve().then(load);
      entries.set(key, { at: Date.now(), value });
      value.catch(() => entries.get(key)?.value === value && entries.delete(key));
      return value;
    },
    clear: () => entries.clear(),
  };
}

/** Which market a request is about. Futures data is read-only and always comes from the live public API. */
const marketOf = (req) => (req.query.market === "futures" ? "futures" : "spot");

/**
 * Which account's market data a request reads. `source=live` asks for the live public data whatever the account
 * mode is (the multi-chart screen uses it: Testnet lists only a few pairs and its prices are synthetic).
 */
const dataMode = (req) => (req.query.source === "live" ? "live" : binance.getMode());

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

export function createApp({ orderManager, futuresManager = null, stocksClient = null, stockData = null, news = null, autoAmd = null, notifier = null, amdHistory = null, auth, storage = "file", marketCaps = createMarketCaps() }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // Render terminates TLS in front of the service
  app.use(express.json());
  const cache = createCache();

  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  if (auth) app.use(basicAuth(auth));

  const api = express.Router();
  // Anything that changes orders/balances invalidates cached reads.
  api.use((req, res, next) => {
    if (req.method !== "GET") res.on("finish", () => cache.clear());
    next();
  });
  const manager = orderManager;
  const futures = () => {
    if (!futuresManager) throw Object.assign(new Error("Futures trading is not available on this server"), { httpStatus: 503 });
    return futuresManager;
  };

  api.get("/", handle(500, () => ({ status: "ok", message: "Trading bot API is running" })));
  api.get("/status", handle(500, () => ({ storage, mode: binance.getMode() })));

  api.get("/account/balance", handle(500, async () => {
    const mode = binance.getMode();
    return {
      balances: await cache.get(`balance:${mode}`, 4000, () => binance.getAccountBalance(binance.getClient(mode))),
    };
  }));

  api.get("/market/price", handle(500, async (req) => {
    const symbol = String(req.query.symbol || binance.DEFAULT_SYMBOL);
    const mode = dataMode(req);
    const market = marketOf(req);
    const price = await cache.get(`price:${market}:${mode}:${symbol}`, 1500, () =>
      binance.getCurrentPrice(dataClient(market, mode), symbol));
    return { symbol, price };
  }));

  api.get("/market/candles", handle(500, async (req) => {
    const symbol = String(req.query.symbol || binance.DEFAULT_SYMBOL);
    const interval = String(req.query.interval || "1h");
    const limit = Math.min(1000, Math.max(1, Math.floor(Number(req.query.limit || 100)) || 100));
    // end_time (ms) pages backwards: candles that opened at or before it.
    const endTime = req.query.end_time ? Number(req.query.end_time) : undefined;
    if (endTime !== undefined && !Number.isFinite(endTime)) throw badRequest("end_time must be a number");
    const mode = dataMode(req);
    const market = marketOf(req);
    const candles = await cache.get(`candles:${market}:${mode}:${symbol}:${interval}:${limit}:${endTime ?? ""}`, endTime ? 60_000 : 2000, () =>
      binance.getRecentCandles(dataClient(market, mode), symbol, interval, limit, endTime));
    return { symbol, interval, candles };
  }));

  const dataClient = (market, mode) => (market === "futures" ? binance.getFuturesClient() : binance.getClient(mode));

  // USD-M futures contract list (public, cached): also names every listed stock, used to tag spot stock tokens.
  let futuresInfoCache = { at: 0, info: null };
  async function getFuturesInfo() {
    if (futuresInfoCache.info && Date.now() - futuresInfoCache.at < SYMBOLS_TTL_MS) return futuresInfoCache.info;
    try {
      const info = await binance.getFuturesClient().getExchangeInfo();
      futuresInfoCache = { at: Date.now(), info };
      return info;
    } catch (err) {
      if (futuresInfoCache.info) return futuresInfoCache.info; // stale is fine: this list rarely changes
      throw err;
    }
  }

  async function getTradableFutures(quote) {
    const info = await getFuturesInfo();
    return new Map(
      info.symbols
        .filter((s) => s.status === "TRADING" && s.quoteAsset === quote && /PERPETUAL/.test(s.contractType))
        .map((s) => [s.symbol, { base: s.baseAsset, category: categorizeFutures(s), contract: s.contractType }]),
    );
  }

  // Spot pairs the account can trade for one quote asset, from exchangeInfo (cached).
  const tradableCache = new Map();
  async function getTradable(mode, quote) {
    const key = `${mode}:${quote}`;
    const cached = tradableCache.get(key);
    if (cached && Date.now() - cached.at < SYMBOLS_TTL_MS) return cached.map;
    const info = await binance.getClient(mode).getExchangeInfo();
    const map = new Map(
      info.symbols
        .filter((s) => s.status === "TRADING" && s.isSpotTradingAllowed && s.quoteAsset === quote && !(s.permissions ?? []).includes("LEVERAGED"))
        .map((s) => [s.symbol, { base: s.baseAsset }]),
    );
    let equities;
    try {
      equities = equityBasesFrom(await getFuturesInfo());
    } catch {
      equities = equityBasesFrom(null);
    }
    for (const [symbol, row] of map) map.set(symbol, { ...row, category: categorizeSpot(row.base, quote, equities) });
    tradableCache.set(key, { at: Date.now(), map });
    return map;
  }

  api.get("/market/symbols", handle(500, async (req) => {
    const quote = String(req.query.quote || "USDT").toUpperCase();
    return { symbols: [...(await getTradable(binance.getMode(), quote)).keys()].sort() };
  }));

  /**
   * Every tradable pair with 24h stats, market cap and a trade-worthiness score. Ranking uses LIVE public
   * Binance data even in Testnet mode (Testnet volumes are synthetic), limited to pairs Testnet supports.
   */
  api.get("/market/overview", handle(500, async (req) => {
    const quote = String(req.query.quote || "USDT").toUpperCase();
    if (!/^[A-Z]{2,6}$/.test(quote)) throw badRequest("quote must be a currency code such as USDT");
    const mode = dataMode(req);
    const market = marketOf(req);
    return cache.get(`overview:${market}:${mode}:${quote}`, 60_000, async () => {
      if (market === "futures") {
        const client = binance.getFuturesClient();
        const [tradableFutures, tickers, books, caps] = await Promise.all([getTradableFutures(quote), client.getTicker24h(), client.getBookTickers(), marketCaps.get()]);
        const book = new Map(books.map((b) => [b.symbol, b]));
        const merged = tickers.map((t) => ({ ...t, bidPrice: book.get(t.symbol)?.bidPrice, askPrice: book.get(t.symbol)?.askPrice }));
        return {
          quote, mode, market, source: "live", updatedAt: Date.now(), marketCapAvailable: caps.size > 0,
          pairs: buildOverview({ tickers: merged, tradable: tradableFutures, marketCaps: caps, minVolume: MIN_SCORED_VOLUME }),
        };
      }
      const tradable = await getTradable(mode, quote);
      let source = "live";
      let tickers;
      try {
        tickers = await binance.getClient("live").getTicker24h();
      } catch (err) {
        if (mode === "live") throw err;
        source = mode; // live public data unreachable (e.g. regional block): fall back to this account's own data
        tickers = await binance.getClient(mode).getTicker24h();
      }
      const caps = await marketCaps.get();
      const pairs = buildOverview({ tickers, tradable, marketCaps: caps, minVolume: source === "live" ? MIN_SCORED_VOLUME : 0 });
      return { quote, mode, market, source, updatedAt: Date.now(), marketCapAvailable: caps.size > 0, pairs };
    });
  }));

  /** Risk settings + where the current account stands against every limit, for spot or futures. */
  async function riskSnapshot(market = "spot") {
    const mode = binance.getMode();
    const settings = manager.getRiskSettings();
    let quoteTotal = null;
    let balanceError = null;
    if (settings.capitalMode === "auto") {
      try {
        if (market === "futures") {
          quoteTotal = (await cache.get(`futures-account:${mode}`, 4000, () => futures().getAccount(mode))).wallet;
        } else {
          const balances = await cache.get(`balance:${mode}`, 4000, () => binance.getAccountBalance(binance.getClient(mode)));
          const usdt = balances.find((b) => b.asset === "USDT");
          quoteTotal = usdt ? Number(usdt.free) + Number(usdt.locked) : 0;
        }
      } catch (err) {
        balanceError = err.message;
      }
    }
    const orders = market === "futures" ? futures().listOrders(mode) : manager.listOrders(mode);
    // Futures margin is already inside the wallet balance; spot money in open positions is not.
    const capital = computeCapital(settings, { quoteTotal, orders: market === "futures" ? [] : orders });
    return { mode, market, settings, state: computeRiskState({ orders, settings, capital }), stats: tradeStats(orders), balanceError };
  }

  api.get("/risk", handle(500, (req) => riskSnapshot(marketOf(req))));
  api.put("/risk", handle(400, async (req) => {
    manager.setRiskSettings(req.body ?? {});
    return riskSnapshot(marketOf(req));
  }));
  api.post("/risk/reset-drawdown", handle(400, async (req) => {
    manager.resetDrawdown();
    return riskSnapshot(marketOf(req));
  }));

  // Exchange rules for one pair (tick size, lot size, minimum order value). Rarely changes: cached.
  api.get("/market/symbol-info", handle(500, async (req) => {
    const symbol = String(req.query.symbol || binance.DEFAULT_SYMBOL).toUpperCase();
    const mode = binance.getMode();
    if (marketOf(req) === "futures") {
      const contract = (await getFuturesInfo()).symbols.find((s) => s.symbol === symbol);
      if (!contract) throw badRequest(`Unknown futures contract: ${symbol}`);
      const f = Object.fromEntries(contract.filters.map((x) => [x.filterType, x]));
      return {
        symbol,
        market: "futures",
        contract: contract.contractType,
        category: categorizeFutures(contract),
        tickSize: Number(f.PRICE_FILTER?.tickSize ?? 0),
        stepSize: Number(f.LOT_SIZE?.stepSize ?? 0),
        minQty: Number(f.LOT_SIZE?.minQty ?? 0),
        minNotional: Number(f.MIN_NOTIONAL?.notional ?? 0),
        quoteAsset: contract.quoteAsset,
      };
    }
    const info = await cache.get(`symbol-info:${mode}:${symbol}`, 5 * 60_000, () => getSymbolInfo(binance.getClient(mode), symbol));
    let category = "crypto";
    try {
      category = (await getTradable(mode, "USDT")).get(symbol)?.category ?? "crypto";
    } catch { /* category is only a hint for sizing */ }
    return { symbol, market: "spot", category, ...info };
  }));

  api.get("/account/trading-fee", handle(500, async (req) => {
    const symbol = String(req.query.symbol || binance.DEFAULT_SYMBOL);
    const mode = binance.getMode();
    return { symbol, ...(await cache.get(`fee:${mode}:${symbol}`, 60_000, () =>
      binance.getTradingFee(binance.getClient(mode), symbol))) };
  }));

  api.get("/account/mode", handle(500, () => {
    const mode = binance.getMode();
    return { mode, testnet: binance.isTestnet(mode) };
  }));

  api.post("/account/mode", handle(400, (req) => {
    const mode = binance.setMode(String(req.body?.mode ?? "").toLowerCase());
    return { mode, testnet: binance.isTestnet(mode) };
  }));

  // ---- AMD bot, its backtest and the notification center ----
  const bot = () => {
    if (!autoAmd) throw Object.assign(new Error("The AMD bot is not available on this server"), { httpStatus: 503 });
    return autoAmd;
  };
  const hub = () => {
    if (!notifier) throw Object.assign(new Error("Notifications are not available on this server"), { httpStatus: 503 });
    return notifier;
  };

  api.get("/amd/config", handle(500, () => bot().getConfig()));
  api.put("/amd/config", handle(400, async (req) => {
    const { confirm, ...patch } = req.body ?? {};
    return { config: await bot().setConfig(patch, { confirm }), status: bot().status() };
  }));
  api.get("/amd/status", handle(500, () => ({ config: bot().getConfig(), status: bot().status(), channels: hub().channels() })));
  api.post("/amd/scan", handle(500, async () => ({ status: await bot().tick({ force: true }) })));
  api.get("/amd/log", handle(500, (req) => hub().list({ source: "amd", limit: Math.min(200, Math.max(1, Number(req.query.limit) || 50)) })));

  api.get("/notifications", handle(500, (req) => ({
    ...hub().list({ since: Number(req.query.since) || 0, limit: Math.min(200, Math.max(1, Number(req.query.limit) || 50)) }),
    channels: hub().channels(),
  })));
  api.post("/notifications/read", handle(400, (req) => hub().markRead(Array.isArray(req.body?.ids) ? req.body.ids.map(String) : null)));
  api.post("/notifications/test", handle(500, () => hub().test()));

  // Replays the bot's exact orders over real history (live public data, whatever the account mode is).
  const loadHistory = amdHistory ?? (async (market, symbol, interval, total) => {
    const client = binance.getFuturesClient && market === "futures" ? binance.getFuturesClient() : binance.getClient("live");
    return toCandles(await cache.get(`amd-history:${market}:${symbol}:${interval}:${total}`, 10 * 60_000, () => fetchHistory((s, i, l, e) => client.getKlines(s, i, l, e), symbol, interval, total)));
  });
  api.post("/amd/backtest", handle(400, async (req) => {
    const b = req.body ?? {};
    const market = b.market === "spot" ? "spot" : "futures";
    const symbols = [...new Set((Array.isArray(b.symbols) ? b.symbols : []).map((x) => String(x).trim().toUpperCase()))];
    if (!symbols.length || symbols.length > 12) throw badRequest("choose between 1 and 12 pairs");
    for (const s of symbols) if (!/^[A-Z0-9]{4,20}$/.test(s)) throw badRequest(`"${s}" is not a valid symbol`);
    const interval = String(b.interval ?? "15m");
    if (!INTERVAL_MS[interval]) throw badRequest(`timeframe must be one of ${Object.keys(INTERVAL_MS).join(", ")}`);
    const total = Math.min(5000, Math.max(300, Math.floor(Number(b.candles) || 3000)));
    const num = (v, d, lo, hi) => { const n = Number(v ?? d); if (!Number.isFinite(n) || n < lo || n > hi) throw badRequest(`value must be between ${lo} and ${hi}`); return n; };
    const engine = { minRangeBars: num(b.engine?.minRangeBars, 10, 4, 40), maxRangeAtr: num(b.engine?.maxRangeAtr, 3.5, 1.5, 6), minRewardRisk: num(b.engine?.minRewardRisk, 1, 0, 5) };
    const trade = {
      entryMode: b.trade?.entryMode === "fvg-retest" ? "fvg-retest" : "limit-close",
      targetMode: b.trade?.targetMode === "r" ? "r" : "range",
      targetR: num(b.trade?.targetR, 2, 1, 5),
      expiryCandles: Math.round(num(b.trade?.expiryCandles, 3, 1, 10)),
      feePercent: num(b.trade?.feePercent, market === "spot" ? 0.1 : 0.05, 0, 1),
      minRewardRisk: num(b.trade?.minRewardRisk, 1, 0, 5),
      longs: b.trade?.longs !== false,
      shorts: market === "futures" && b.trade?.shorts !== false,
    };
    const summary = { startEquity: 1000, riskPerTradePct: num(b.riskPerTradePct, 1, 0.1, 10) };

    const datasets = [];
    for (let i = 0; i < symbols.length; i += 4) {
      const chunk = symbols.slice(i, i + 4);
      const loaded = await Promise.all(chunk.map(async (symbol) => {
        try {
          return { symbol, candles: await loadHistory(market, symbol, interval, total) };
        } catch (err) {
          return { symbol, candles: [], error: err.message };
        }
      }));
      datasets.push(...loaded);
    }
    const result = backtestAmd(datasets, { engine, trade, summary });
    result.perSymbol = result.perSymbol.map((p) => ({ ...p, error: datasets.find((d) => d.symbol === p.symbol)?.error ?? p.error, stats: { ...p.stats, curve: undefined } }));
    result.trades = result.trades.slice(0, 300);
    const out = { market, interval, candlesRequested: total, ...result };
    if (b.sweep) out.sweep = sweepAmd(datasets, { engine, trade, summary }).map((row) => ({ ...row, stats: { ...row.stats, curve: undefined } }));
    return out;
  }));

  // ---- economic news: public feeds of central banks and business publishers, and this week's calendar ----
  let newsService = news;
  const newsFeed = () => (newsService ??= createNews());
  api.get("/news", handle(500, (req) => newsFeed().news(Number(req.query.days) || 7)));
  api.get("/news/calendar", handle(500, () => newsFeed().calendar()));

  // ---- Binance Stocks (US stocks and ETFs): a separate product with its own API, live account only ----
  const stocks = () => stocksClient ?? getStocksClient();
  const stockSymbol = (value) => {
    const symbol = String(value ?? "").trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) throw badRequest("symbol must be a US stock ticker such as AAPL");
    return symbol;
  };

  let stockDataInstance = stockData;
  const yahoo = () => (stockDataInstance ??= createStockData());

  api.get("/stocks/portfolio", handle(500, () => cache.get("stocks:portfolio", 45_000, async () => {
    const portfolio = await getPortfolio(stocks());
    // Company names for the holdings that Binance's own tokenized list does not name.
    await Promise.all(portfolio.holdings.filter((h) => !h.name).map(async (h) => {
      try { h.name = (await yahoo().daily(h.symbol)).name; } catch { /* the name is a nicety */ }
    }));
    return portfolio;
  })));

  // Every ticker Binance Stocks lists (about 7,900), keyed by symbol.
  const stockList = () => cache.get("stocks:list", 5 * 60_000, async () => {
    const info = await stocks().exchangeInfo();
    return new Map((info.symbols ?? []).map((s) => [s.symbol, {
      symbol: s.symbol,
      tradability: s.tradability,
      fractionable: s.fractionable,
      minNotional: Number(s.minNotional),
      stepSize: s.stepSize,
      extendedSession: Boolean(s.extendedSession),
      overnight: Boolean(s.overnightSupported),
    }]));
  });

  api.get("/stocks/symbols", handle(500, async () => ({ symbols: [...(await stockList()).values()].sort((a, b) => a.symbol.localeCompare(b.symbol)) })));

  const POPULAR_STOCKS = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "SPY", "QQQ", "GLD", "BRK.B", "JPM", "V", "COST", "AMD", "NFLX", "VOO", "IWM", "DIA", "XOM"];

  /** Find a listed stock by ticker or company name ("apple", "AAPL", "gold"). Only tickers Binance lists are returned. */
  api.get("/stocks/search", handle(500, async (req) => {
    const q = String(req.query.q ?? "").trim();
    if (q.length > 40) throw badRequest("search text is too long");
    const list = await stockList();
    if (!q) return { results: POPULAR_STOCKS.filter((t) => list.has(t)).map((t) => ({ ...list.get(t), name: null, type: null })) };

    const ticker = q.toUpperCase().replace(/[^A-Z0-9.]/g, "");
    const out = new Map();
    const add = (symbol, extra = {}) => {
      const listed = list.get(symbol);
      if (listed && !out.has(symbol)) out.set(symbol, { ...listed, name: extra.name ?? null, type: extra.type ?? null });
    };
    if (ticker) add(ticker);
    let remote = [];
    try { remote = await yahoo().search(q); } catch { /* ticker matches still work without the name search */ }
    for (const r of remote) add(r.symbol, r);
    if (ticker) {
      let prefix = 0;
      for (const symbol of list.keys()) if (symbol.startsWith(ticker) && prefix < 12) { add(symbol); prefix += 1; }
      let inside = 0;
      for (const symbol of list.keys()) if (!symbol.startsWith(ticker) && symbol.includes(ticker) && inside < 6) { add(symbol); inside += 1; }
    }
    return { results: [...out.values()].slice(0, 30) };
  }));

  /** Profile, valuation, growth, margins, debt, analyst targets and earnings date (or fund facts) for the company analysis. */
  api.get("/stocks/company", handle(500, async (req) => {
    const symbol = stockSymbol(req.query.symbol);
    if (!(await stockList()).has(symbol)) throw badRequest(`${symbol} is not on Binance Stocks`);
    return yahoo().company(symbol);
  }));

  /** Two years of daily candles (plus the S&P 500 ETF as a benchmark) for the stock analyzer. */
  api.get("/stocks/history", handle(500, async (req) => {
    const symbol = stockSymbol(req.query.symbol);
    const listed = (await stockList()).get(symbol);
    if (!listed) throw badRequest(`${symbol} is not on Binance Stocks`);
    const [data, benchmark] = await Promise.all([yahoo().daily(symbol), symbol === "SPY" ? null : yahoo().daily("SPY").catch(() => null)]);
    return { ...data, listed, benchmark: benchmark ? { symbol: "SPY", candles: benchmark.candles } : null };
  }));

  api.get("/stocks/quote", handle(500, async (req) => {
    const symbol = stockSymbol(req.query.symbol);
    return cache.get(`stocks:quote:${symbol}`, 3000, () => stocks().quote(symbol));
  }));

  api.get("/stocks/orders", handle(500, () => cache.get("stocks:orders", 5000, async () => {
    const now = Date.now();
    const [open, history] = await Promise.all([
      stocks().openOrders(),
      stocks().orderHistory({ startTime: now - 30 * 86_400_000, endTime: now, current: 1, size: 20 }),
    ]);
    return { open, recent: history.rows ?? [] };
  })));

  api.post("/stocks/orders", handle(400, async (req) => {
    const symbol = stockSymbol(req.body?.symbol);
    const side = req.body?.side;
    // Binance's own rules for the ticker: tradable now, in fractions or not, minimum order value.
    const info = (await stocks().exchangeInfo(symbol)).symbols?.[0];
    if (!info) throw badRequest(`${symbol} is not available on Binance Stocks`);
    if (!String(info.tradability ?? "").includes(side)) throw badRequest(`${symbol} cannot be ${side === "BUY" ? "bought" : "sold"} right now (tradability: ${info.tradability})`);
    const params = buildEquityOrder(req.body ?? {}, { info });
    return stocks().placeOrder(params);
  }));

  api.delete("/stocks/orders/:orderId", handle(400, async (req) => stocks().cancelOrder(String(req.params.orderId))));

  // ---- futures trading (USD-M perpetuals: crypto, stocks, commodities, and forex contracts when Binance lists them) ----
  api.get("/futures/account", handle(500, async (req) => {
    const mode = parseMode(req.query.mode);
    return cache.get(`futures-account:${mode}`, 4000, () => futures().getAccount(mode));
  }));

  api.get("/futures/orders", handle(400, (req) => {
    const mode = parseMode(req.query.mode);
    return { orders: futures().listOrders(mode), mode, testnet: binance.isTestnet(mode) };
  }));

  api.post("/futures/orders", handle(400, (req) => {
    const body = req.body ?? {};
    const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
    if (!/^[A-Z0-9]{5,20}$/.test(symbol)) throw badRequest("symbol must be 5-20 letters/digits");
    const leverage = body.leverage;
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > 125) throw badRequest("leverage must be a whole number from 1 to 125");
    return futures().createOrder({
      symbol,
      entry_price: requireNumber(body.entry_price, "entry_price"),
      margin_usdt: requireNumber(body.margin_usdt, "margin_usdt"),
      leverage,
      stop_loss_price: requireNumber(body.stop_loss_price, "stop_loss_price"),
      take_profit_price: requireNumber(body.take_profit_price, "take_profit_price"),
    });
  }));

  api.post("/futures/positions/close", handle(400, (req) => {
    const symbol = typeof req.body?.symbol === "string" ? req.body.symbol.trim().toUpperCase() : "";
    if (!/^[A-Z0-9]{5,20}$/.test(symbol)) throw badRequest("symbol must be 5-20 letters/digits");
    return futures().closePosition(symbol, binance.getMode());
  }));

  // Static "history" route before "/futures/orders/:orderId".
  api.delete("/futures/orders/history", handle(400, () => futures().clearHistory(binance.getMode())));
  api.delete("/futures/orders/:orderId", handle(400, (req) => futures().cancelOrder(req.params.orderId)));
  api.delete("/futures/orders/:orderId/history", handle(400, (req) => futures().deleteHistory(req.params.orderId)));

  api.get("/orders", handle(400, (req) => {
    const mode = parseMode(req.query.mode);
    return { orders: manager.listOrders(mode), mode, testnet: binance.isTestnet(mode) };
  }));

  api.get("/orders/binance-open", handle(500, async (req) => {
    const mode = parseMode(req.query.mode);
    const symbol = req.query.symbol ? String(req.query.symbol) : undefined;
    const orders = await cache.get(`open:${mode}:${symbol ?? ""}`, 4000, () =>
      binance.getClient(mode).getOpenOrders(symbol));
    return { orders, mode };
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
