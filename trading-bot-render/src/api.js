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

export function getPrice(symbol = "XLMUSDT") {
  return getJson(`/market/price?symbol=${symbol}`);
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

export function getCandles(symbol = "XLMUSDT", interval = "1h", limit = 100) {
  return getJson(`/market/candles?symbol=${symbol}&interval=${interval}&limit=${limit}`);
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
