import assert from "node:assert/strict";
import test from "node:test";

import { TOOLS, TOOL_BY_NAME, ToolError, assertTradeAllowed, executeTool, httpApi, offeredTools, validateArgs } from "./agent/tools.js";

/** A fake platform: records every call and answers from a table of "METHOD path" -> response. */
function fakePlatform(routes = {}) {
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    const key = `${method} ${path.split("?")[0]}`;
    const answer = routes[key];
    if (answer === undefined) throw new ToolError(`no route ${key}`);
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer(path, body) : answer;
  };
  return { api, calls };
}
const PAPER = { mode: "paper", paper: true };
const LIVE = { mode: "live", paper: false };
const TRADING = { allowTrading: true };

// ---------- validation ----------

test("validateArgs: required, types, enums, ranges, patterns and unknown arguments", () => {
  const schema = TOOL_BY_NAME.place_futures_order.input_schema;
  const good = { symbol: "BTCUSDT", entry_price: 60000, margin_usdt: 100, leverage: 3, stop_loss_price: 59000, take_profit_price: 62000 };
  assert.deepEqual(validateArgs(schema, good), []);
  assert.match(validateArgs(schema, { ...good, leverage: 3.5 }).join(), /leverage must be a whole number/);
  assert.match(validateArgs(schema, { ...good, leverage: 500 }).join(), /at most 125/);
  assert.match(validateArgs(schema, { ...good, entry_price: -1 }).join(), /greater than 0/);
  assert.match(validateArgs(schema, { ...good, entry_price: "60000" }).join(), /must be a number/);
  assert.match(validateArgs(schema, { ...good, symbol: "BTC/USDT" }).join(), /format/);
  assert.match(validateArgs(schema, { ...good, extra: 1 }).join(), /unknown argument extra/);
  const { symbol: _omit, ...missing } = good;
  assert.match(validateArgs(schema, missing).join(), /symbol is required/);
  assert.deepEqual(validateArgs(schema, null), ["arguments must be an object"]);
  assert.match(validateArgs(TOOL_BY_NAME.get_price.input_schema, { symbol: "BTCUSDT", market: "options" }).join(), /one of spot, futures/);
  assert.equal(validateArgs(TOOL_BY_NAME.get_price.input_schema, { symbol: "BTCUSDT", market: NaN }).length, 1);
});

test("every tool has a name, a description and a well-formed schema", () => {
  const names = new Set();
  for (const t of TOOLS) {
    assert.ok(!names.has(t.name), `duplicate ${t.name}`);
    names.add(t.name);
    assert.ok(t.description.length > 20);
    assert.equal(t.input_schema.type, "object");
    assert.equal(t.input_schema.additionalProperties, false);
    assert.ok(["read", "safe", "trade"].includes(t.kind));
    assert.equal(typeof t.run, "function");
    if (t.kind === "trade") assert.equal(typeof t.describe, "function", `${t.name} must say what the user is approving`);
    for (const r of t.input_schema.required ?? []) assert.ok(t.input_schema.properties[r], `${t.name} requires unknown ${r}`);
  }
});

test("the tool list leaves out everything an agent must never do", () => {
  const forbidden = /mode|risk_set|reset|arm|bot|history|delete_all|cleanup|withdraw|transfer/i;
  for (const t of TOOLS) assert.doesNotMatch(t.name, forbidden, `${t.name} should not be offered to an agent`);
  assert.ok(!TOOLS.some((t) => t.name === "risk_status" && t.kind !== "read"), "risk can be read but not changed");
});

// ---------- policy ----------

test("trading tools are only offered when trading is switched on", () => {
  const off = offeredTools({}).map((t) => t.name);
  const on = offeredTools(TRADING).map((t) => t.name);
  for (const name of ["place_spot_order", "place_futures_order", "cancel_order", "close_futures_position"]) {
    assert.ok(!off.includes(name), `${name} must be hidden by default`);
    assert.ok(on.includes(name));
  }
  assert.ok(off.includes("get_price") && off.includes("add_favorite"));
});

test("a tool switched off in the settings is not offered, and cannot be run", async () => {
  const config = { allowTrading: true, tools: { get_news: false, place_spot_order: false } };
  const names = offeredTools(config).map((t) => t.name);
  assert.ok(!names.includes("get_news") && !names.includes("place_spot_order") && names.includes("place_futures_order"));
  await assert.rejects(executeTool("get_news", {}, fakePlatform(), config), /Unknown or disabled/);
  await assert.rejects(executeTool("nope", {}, fakePlatform(), config), /Unknown or disabled/);
});

test("a trading tool never runs without confirmation, even when the model asks for it", async () => {
  const platform = fakePlatform({ "GET /api/account/mode": PAPER, "POST /api/orders/conditional": { id: "o1" } });
  const args = { symbol: "xlmusdt", entry_price: 0.2, capital_usdt: 50, stop_loss_price: 0.19, take_profit_price: 0.23 };
  await assert.rejects(executeTool("place_spot_order", args, platform, TRADING), /needs the user's confirmation/);
  assert.equal(platform.calls.filter((c) => c.method === "POST").length, 0, "nothing was sent");
  const done = await executeTool("place_spot_order", args, platform, TRADING, { confirmed: true });
  assert.deepEqual(done, { id: "o1" });
  assert.deepEqual(platform.calls.at(-1), { method: "POST", path: "/api/orders/conditional", body: { symbol: "XLMUSDT", entry_price: 0.2, capital_usdt: 50, stop_loss_price: 0.19, take_profit_price: 0.23 } });
});

test("a trade is refused when trading is off in the settings, even if confirmed", async () => {
  const platform = fakePlatform({ "GET /api/account/mode": PAPER });
  await assert.rejects(executeTool("cancel_order", { order_id: "abcd1234", market: "spot" }, platform, { allowTrading: false }, { confirmed: true }), /Unknown or disabled/);
  await assert.rejects(assertTradeAllowed({}, platform.api), /switched off/);
});

test("the live account needs its own switch, checked at the moment the trade would run", async () => {
  const args = { order_id: "abcd1234", market: "spot" };
  const live = fakePlatform({ "GET /api/account/mode": LIVE, "DELETE /api/orders/abcd1234": { ok: true } });
  await assert.rejects(executeTool("cancel_order", args, live, TRADING, { confirmed: true }), /LIVE account/);
  assert.equal(live.calls.filter((c) => c.method === "DELETE").length, 0);
  assert.deepEqual(await executeTool("cancel_order", args, live, { ...TRADING, allowLive: true }, { confirmed: true }), { ok: true });
  // the mode is read every time: the platform switching to live between the proposal and the tap is caught
  let mode = PAPER;
  const flip = fakePlatform({ "GET /api/account/mode": () => mode, "DELETE /api/orders/abcd1234": { ok: true } });
  await executeTool("cancel_order", args, flip, TRADING, { confirmed: true });
  mode = LIVE;
  await assert.rejects(executeTool("cancel_order", args, flip, TRADING, { confirmed: true }), /LIVE account/);
});

test("invalid arguments are refused before anything is sent", async () => {
  const platform = fakePlatform({ "GET /api/account/mode": PAPER });
  await assert.rejects(executeTool("place_futures_order", { symbol: "BTCUSDT", entry_price: 1, margin_usdt: 1, leverage: 0, stop_loss_price: 1, take_profit_price: 2 }, platform, TRADING, { confirmed: true }), /Invalid arguments.*at least 1/);
  assert.equal(platform.calls.length, 0);
});

test("each trading tool describes what the user is approving, in plain words", () => {
  assert.match(TOOL_BY_NAME.place_spot_order.describe({ symbol: "xlmusdt", entry_price: 0.2, capital_usdt: 50, stop_loss_price: 0.19, take_profit_price: 0.23 }), /Spot BUY XLMUSDT.*0\.2.*50 USDT.*0\.19.*0\.23/);
  assert.match(TOOL_BY_NAME.place_futures_order.describe({ symbol: "BTCUSDT", entry_price: 60000, margin_usdt: 100, leverage: 3, stop_loss_price: 59000, take_profit_price: 62000 }), /LONG BTCUSDT.*x3/);
  assert.match(TOOL_BY_NAME.place_futures_order.describe({ symbol: "BTCUSDT", entry_price: 60000, margin_usdt: 100, leverage: 3, stop_loss_price: 61000, take_profit_price: 58000 }), /SHORT/);
  assert.match(TOOL_BY_NAME.cancel_order.describe({ order_id: "abcd1234", market: "futures" }), /futures order abcd1234/);
  assert.match(TOOL_BY_NAME.close_futures_position.describe({ symbol: "ethusdt" }), /ETHUSDT futures position at market/);
});

// ---------- the read tools ----------

test("platform_status, get_price and risk_status pass the platform's answer through", async () => {
  const platform = fakePlatform({
    "GET /api/account/mode": PAPER, "GET /api/status": { storage: "mongodb", mode: "paper" },
    "GET /api/market/price": { symbol: "BTCUSDT", price: 61234.5 },
    "GET /api/risk": { settings: { riskPerTradePct: 1 }, state: { status: "ok" }, stats: { huge: true } },
  });
  assert.deepEqual(await executeTool("platform_status", {}, platform, {}), { accountMode: "paper", simulatedMoney: true, storage: "mongodb" });
  assert.equal((await executeTool("get_price", { symbol: "btcusdt", market: "futures" }, platform, {})).price, 61234.5);
  assert.equal(platform.calls.find((c) => c.path.startsWith("/api/market/price")).path, "/api/market/price?symbol=BTCUSDT&market=futures");
  assert.deepEqual(await executeTool("risk_status", {}, platform, {}), { settings: { riskPerTradePct: 1 }, state: { status: "ok" } });
});

test("analyze_symbol turns candles into a short technical read", async () => {
  const T0 = 1_700_000_000_000;
  const klines = Array.from({ length: 300 }, (_, i) => {
    const p = 100 + Math.sin(i / 8) * 6 + i * 0.05;
    return [T0 + i * 3_600_000, p, p + 1, p - 1, p + 0.3, 100 + (i % 7), T0 + (i + 1) * 3_600_000 - 1];
  });
  const platform = fakePlatform({ "GET /api/market/candles": { candles: klines } });
  const r = await executeTool("analyze_symbol", { symbol: "ethusdt", interval: "4h" }, platform, {});
  assert.equal(r.symbol, "ETHUSDT");
  assert.equal(r.interval, "4h");
  assert.ok(typeof r.price === "number" && typeof r.rsi === "number");
  assert.ok(["uptrend", "downtrend", "range", "weak-uptrend", "weak-downtrend"].includes(r.trend));
  assert.ok(Array.isArray(r.activeSignals) && Array.isArray(r.nearestSupport));
  assert.match(platform.calls[0].path, /symbol=ETHUSDT&interval=4h&limit=300&market=spot/);
  await assert.rejects(executeTool("analyze_symbol", { symbol: "ETHUSDT" }, fakePlatform({ "GET /api/market/candles": { candles: [] } }), {}), /Not enough candles/);
});

test("get_balance keeps only held assets (spot) and returns positions (futures)", async () => {
  const platform = fakePlatform({
    "GET /api/account/balance": { balances: [{ asset: "USDT", free: "10", locked: "0" }, { asset: "DUST", free: "0", locked: "0" }] },
    "GET /api/futures/account": { wallet: 500, available: 450, positions: [{ symbol: "BTCUSDT" }], other: "x" },
  });
  assert.deepEqual((await executeTool("get_balance", {}, platform, {})).balances.map((b) => b.asset), ["USDT"]);
  assert.deepEqual(await executeTool("get_balance", { market: "futures" }, platform, {}), { wallet: 500, available: 450, positions: [{ symbol: "BTCUSDT" }] });
});

test("list_orders separates active orders from recent finished ones and trims the fields", async () => {
  const orders = [
    ...Array.from({ length: 8 }, (_, i) => ({ id: `done${i}`, symbol: "BTCUSDT", status: "CLOSED", secret: "no" })),
    { id: "live1", symbol: "XLMUSDT", status: "PROTECTED", entry_price: 0.2, stop_loss_price: 0.19, take_profit_price: 0.23, internal: "no" },
  ];
  const r = await executeTool("list_orders", {}, fakePlatform({ "GET /api/orders": { orders } }), {});
  assert.deepEqual(r.active, [{ id: "live1", symbol: "XLMUSDT", status: "PROTECTED", entry_price: 0.2, stop_loss_price: 0.19, take_profit_price: 0.23 }]);
  assert.equal(r.recentFinished.length, 5);
  assert.ok(!("secret" in r.recentFinished[0]));
});

test("stock_company_analysis returns the score, the phase with its three answers, and the phase's valuation", async () => {
  const company = {
    kind: "company", profile: { name: "Acme Corp", sector: "Technology" },
    valuation: { marketCap: 50e9, trailingPE: 28, forwardPE: 22, priceToSales: 5.5, dividendYield: 0 },
    growth: { revenueGrowth: 0.22, revenue: 9e9 },
    profitability: { profitMargins: 0.24, grossMargins: 0.7, operatingMargins: 0.28, returnOnEquity: 0.25 },
    health: { freeCashflow: 2e9, totalCash: 6e9, totalDebt: 2e9, debtToEquity: 30, currentRatio: 2.4 },
    forward: { revenueNextYear: 12e9, forwardEps: 2.2 }, analysts: {}, events: {}, history: [],
    fundamentals: { annual: { revenue: [{ date: "2025-12-31", value: 9e9 }] }, trailing: { buybacks: [{ date: "2025-12-31", value: 0.5e9 }] } },
  };
  const r = await executeTool("stock_company_analysis", { symbol: "acme" }, fakePlatform({ "GET /api/stocks/company": company }), {});
  assert.equal(r.symbol, "ACME");
  assert.equal(r.name, "Acme Corp");
  assert.equal(r.phase.phase, 4);
  assert.equal(r.phase.answers.length, 3);
  assert.deepEqual(r.phase.valuation.measures.map((m) => m.basis), ["trailing", "trailing"]);
});

test("get_news labels the headlines as untrusted and keeps them short", async () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ title: `Headline ${i} ${"x".repeat(400)}`, source: "Wire", publishedAt: 1 }));
  const r = await executeTool("get_news", {}, fakePlatform({ "GET /api/news": { items } }), {});
  assert.equal(r.untrustedHeadlines.length, 8);
  assert.ok(r.untrustedHeadlines.every((h) => h.title.length <= 200));
});

// ---------- favorites tools ----------

test("add_favorite and remove_favorite use the favorites API", async () => {
  const platform = fakePlatform({ "POST /api/favorites/pairs": {}, "POST /api/favorites/stocks": {}, "DELETE /api/favorites/pairs/spot%3ABTCUSDT": {}, "DELETE /api/favorites/stocks/AAPL": {} });
  assert.deepEqual(await executeTool("add_favorite", { kind: "pairs", symbol: "btcusdt", market: "spot", note: "core" }, platform, {}), { added: "spot:BTCUSDT" });
  assert.deepEqual(platform.calls[0].body, { market: "spot", symbol: "BTCUSDT", note: "core" });
  assert.deepEqual(await executeTool("add_favorite", { kind: "stocks", symbol: "aapl" }, platform, {}), { added: "AAPL" });
  assert.deepEqual(await executeTool("remove_favorite", { kind: "pairs", symbol: "BTCUSDT", market: "spot" }, platform, {}), { removed: "spot:BTCUSDT" });
  assert.deepEqual(await executeTool("remove_favorite", { kind: "stocks", symbol: "aapl" }, platform, {}), { removed: "AAPL" });
  await assert.rejects(executeTool("add_favorite", { kind: "pairs", symbol: "BTCUSDT" }, platform, {}), /needs a market/);
});

// ---------- talking to the platform ----------

test("httpApi: sends the dashboard login, passes the error text on, and reports an unreachable platform", async () => {
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push({ url, init });
    if (String(url).endsWith("/bad")) return new Response(JSON.stringify({ detail: "Risk rules refused this order" }), { status: 400 });
    if (String(url).endsWith("/down")) throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const api = httpApi({ baseUrl: "http://127.0.0.1:8000/", username: "admin", password: "pw", fetchFn });
  assert.deepEqual(await api("POST", "/api/x", { a: 1 }), { ok: true });
  assert.equal(seen[0].url, "http://127.0.0.1:8000/api/x");
  assert.equal(seen[0].init.headers.Authorization, `Basic ${Buffer.from("admin:pw").toString("base64")}`);
  assert.equal(seen[0].init.body, '{"a":1}');
  await assert.rejects(api("GET", "/bad"), /Risk rules refused this order/);
  await assert.rejects(api("GET", "/down"), /Could not reach the platform \(ECONNREFUSED\)/);
  const open = httpApi({ baseUrl: "http://h", fetchFn });
  await open("GET", "/ok");
  assert.equal(seen.at(-1).init.headers.Authorization, undefined, "no login configured, none sent");
});
