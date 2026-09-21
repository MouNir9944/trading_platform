// All requests go through the /api prefix: served by the same Express process in
// production, and proxied to it by vite.config.js during development.

const BASE = "/api";

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed: ${res.status}`);
  }
  return res.json();
}

export function getPrice(symbol = "XLMUSDT", market = "spot") {
  return getJson(`/market/price?symbol=${symbol}&market=${market}`);
}

/** `source: "live"` reads live public data whatever the account mode is. */
export function getMarketOverview(quote = "USDT", market = "spot", source) {
  return getJson(`/market/overview?quote=${quote}&market=${market}${source ? `&source=${source}` : ""}`);
}

export function getStatus() {
  return getJson(`/status`);
}

export function getBalance() {
  return getJson(`/account/balance`);
}

export function getAccountMode() {
  return getJson("/account/mode");
}

export async function setAccountMode(mode) {
  const res = await fetch(`${BASE}/account/mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed: ${res.status}`);
  }
  return res.json();
}

export function getTradingFee(symbol = "XLMUSDT") {
  return getJson(`/account/trading-fee?symbol=${symbol}`);
}

export function getSignal(symbol = "XLMUSDT", interval = "1h", capitalUsdt = 1000) {
  return getJson(`/strategy/signal?symbol=${symbol}&interval=${interval}&capital_usdt=${capitalUsdt}`);
}

export function getCandles(symbol = "XLMUSDT", interval = "1h", limit = 100, endTime, market = "spot", source) {
  const before = endTime ? `&end_time=${endTime}` : "";
  return getJson(`/market/candles?symbol=${symbol}&interval=${interval}&limit=${limit}${before}&market=${market}${source ? `&source=${source}` : ""}`);
}

export function getSymbols(quote = "USDT") {
  return getJson(`/market/symbols?quote=${quote}`);
}

export function getOrders(mode = "testnet") {
  return getJson(`/orders?mode=${mode}`);
}

export function getBinanceOpenOrders(symbol, mode = "testnet") {
  const params = new URLSearchParams({ mode });
  if (symbol) params.set("symbol", symbol);
  return getJson(`/orders/binance-open?${params.toString()}`);
}

export async function cancelBinanceOpenOrder(symbol, orderId, mode = "testnet") {
  const res = await fetch(`${BASE}/orders/binance-open/${symbol}/${orderId}?mode=${mode}`, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed: ${res.status}`);
  }
  return res.json();
}

export function getOrderLimits() {
  return getJson("/orders/limits");
}

export async function setOrderLimits(maxOpenOrders, maxDailyOrders) {
  const res = await fetch(`${BASE}/orders/limits?max_open_orders=${maxOpenOrders}&max_daily_orders=${maxDailyOrders}`, { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed: ${res.status}`);
  }
  return res.json();
}

export async function createConditionalOrder(order) {
  const res = await fetch(`${BASE}/orders/conditional`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(order),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed: ${res.status}`);
  }
  return res.json();
}

export async function modifyEntryPrice(orderId, payload) {
  const res = await fetch(`${BASE}/orders/${orderId}/entry`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed: ${res.status}`);
  }
  return res.json();
}

export async function cancelOrder(orderId) {
  const res = await fetch(`${BASE}/orders/${orderId}`, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed: ${res.status}`);
  }
  return res.json();
}

export async function deleteOrderHistory(orderId) {
  const res = await fetch(`${BASE}/orders/${orderId}/history`, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed: ${res.status}`);
  }
  return res.json();
}

export async function clearOrderHistory() {
  const res = await fetch(`${BASE}/orders/history`, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed: ${res.status}`);
  }
  return res.json();
}

export function getRisk(market = "spot") {
  return getJson(`/risk?market=${market}`);
}

async function sendJson(path, method, body) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `Request failed: ${res.status}`);
  }
  return res.json();
}

export const updateRisk = (patch, market = "spot") => sendJson(`/risk?market=${market}`, "PUT", patch);
export const resetRiskDrawdown = (market = "spot") => sendJson(`/risk/reset-drawdown?market=${market}`, "POST");

// ---- futures trading ----
export const getFuturesAccount = (mode = "testnet") => getJson(`/futures/account?mode=${mode}`);
export const getFuturesOrders = (mode = "testnet") => getJson(`/futures/orders?mode=${mode}`);
export const createFuturesOrder = (order) => sendJson("/futures/orders", "POST", order);
export const cancelFuturesOrder = (orderId) => sendJson(`/futures/orders/${orderId}`, "DELETE");
export const deleteFuturesOrderHistory = (orderId) => sendJson(`/futures/orders/${orderId}/history`, "DELETE");
export const clearFuturesOrderHistory = () => sendJson("/futures/orders/history", "DELETE");
export const closeFuturesPosition = (symbol) => sendJson("/futures/positions/close", "POST", { symbol });

export function getSymbolInfo(symbol, market = "spot") {
  return getJson(`/market/symbol-info?symbol=${symbol}&market=${market}`);
}

// ---- Binance Stocks (live account only) ----
export const getStockPortfolio = () => getJson("/stocks/portfolio");
export const getStockSymbols = () => getJson("/stocks/symbols");
export const getStockQuote = (symbol) => getJson(`/stocks/quote?symbol=${encodeURIComponent(symbol)}`);
export const getStockOrders = () => getJson("/stocks/orders");
export const placeStockOrder = (order) => sendJson("/stocks/orders", "POST", order);
export const cancelStockOrder = (orderId) => sendJson(`/stocks/orders/${encodeURIComponent(orderId)}`, "DELETE");
export const searchStocks = (q) => getJson(`/stocks/search?q=${encodeURIComponent(q)}`);
export const getStockHistory = (symbol) => getJson(`/stocks/history?symbol=${encodeURIComponent(symbol)}`);
export const getStockCompany = (symbol) => getJson(`/stocks/company?symbol=${encodeURIComponent(symbol)}`);

// ---- economic news ----
export const getNews = (days = 7) => getJson(`/news?days=${days}`);
export const getNewsCalendar = () => getJson("/news/calendar");

// ---- AMD bot, backtest and notifications ----
export const getNotifications = (since = 0, limit = 50) => getJson(`/notifications?since=${since}&limit=${limit}`);
export const markNotificationsRead = (ids = null) => sendJson("/notifications/read", "POST", ids ? { ids } : {});
export const sendTestNotification = () => sendJson("/notifications/test", "POST");
export const getAmdStatus = () => getJson("/amd/status");
export const putAmdConfig = (patch) => sendJson("/amd/config", "PUT", patch);
export const scanAmdNow = () => sendJson("/amd/scan", "POST");
export const getAmdLog = (limit = 50) => getJson(`/amd/log?limit=${limit}`);
export const runAmdBacktest = (body) => sendJson("/amd/backtest", "POST", body);
