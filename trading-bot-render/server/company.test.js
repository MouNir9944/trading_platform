import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { analyzeCompany, combinedRead } from "../shared/analysis/company.js";
import { createApp } from "./app.js";
import { OrderManager } from "./orders.js";
import { createStockData, parseCompany } from "./stockData.js";
import { FileStore } from "./store.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 20);
const v = (raw) => ({ raw, fmt: String(raw) });

/** Yahoo quoteSummary JSON for a healthy, profitable company. */
const companyJson = (overrides = {}) => ({
  quoteSummary: {
    result: [{
      price: { longName: "Acme Corp", quoteType: "EQUITY", marketCap: v(50e9) },
      assetProfile: { sector: "Technology", industry: "Software", fullTimeEmployees: 12000, website: "https://acme.test", country: "United States", longBusinessSummary: "Acme makes software." },
      summaryDetail: { trailingPE: v(28), forwardPE: v(22), dividendYield: v(0.01), beta: v(1.1) },
      defaultKeyStatistics: { pegRatio: v(1.2), priceToBook: v(6), trailingEps: v(4), shortPercentOfFloat: v(0.02) },
      financialData: {
        revenueGrowth: v(0.22), earningsGrowth: v(0.3), totalRevenue: v(9e9),
        grossMargins: v(0.7), operatingMargins: v(0.28), profitMargins: v(0.24), returnOnEquity: v(0.25),
        totalCash: v(6e9), totalDebt: v(2e9), debtToEquity: v(30), currentRatio: v(2.4), freeCashflow: v(2e9),
        targetMeanPrice: v(150), targetLowPrice: v(110), targetHighPrice: v(190), recommendationKey: "buy", numberOfAnalystOpinions: v(30),
      },
      recommendationTrend: { trend: [{ period: "0m", strongBuy: 10, buy: 12, hold: 6, sell: 1, strongSell: 1 }] },
      calendarEvents: { earnings: { earningsDate: [v((NOW + 40 * DAY) / 1000)] } },
      incomeStatementHistory: {
        incomeStatementHistory: [2025, 2024, 2023, 2022].map((year, i) => ({ endDate: v(Date.UTC(year, 11, 31) / 1000), totalRevenue: v((9 - i * 1.5) * 1e9), netIncome: v((2 - i * 0.3) * 1e9), grossProfit: v(6e9) })),
      },
      ...overrides,
    }],
  },
});

const fundJson = (extra = {}) => ({
  quoteSummary: {
    result: [{
      price: { longName: "Big Index ETF", quoteType: "ETF" },
      summaryDetail: { totalAssets: v(20e9), yield: v(0.012) },
      fundProfile: { categoryName: "Large Blend", family: "Vanguard", feesExpensesInvestment: { annualReportExpenseRatio: v(0.0003) } },
      topHoldings: { holdings: ["A", "B", "C", "D", "E"].map((s) => ({ symbol: s, holdingName: `${s} Inc`, holdingPercent: v(0.05) })) },
      ...extra,
    }],
  },
});

test("company data is flattened, with missing numbers left null and years in order", () => {
  const c = parseCompany(companyJson(), "ACME");
  assert.equal(c.kind, "company");
  assert.equal(c.profile.name, "Acme Corp");
  assert.equal(c.profile.employees, 12000);
  assert.equal(c.valuation.forwardPE, 22);
  assert.equal(c.health.debtToEquity, 30);
  assert.equal(c.analysts.recommendation, "buy");
  assert.equal(c.analysts.trend.strongBuy, 10);
  assert.equal(c.events.nextEarnings, NOW + 40 * DAY);
  assert.deepEqual(c.history.map((y) => y.year).sort(), [2022, 2023, 2024, 2025]);
  assert.equal(c.fund, null);

  const sparse = parseCompany({ quoteSummary: { result: [{ price: { longName: "Tiny", quoteType: "EQUITY" }, financialData: { revenueGrowth: {}, recommendationKey: "none" } }] } }, "TINY");
  assert.equal(sparse.growth.revenueGrowth, null, "an empty {} means no value");
  assert.equal(sparse.analysts.recommendation, null);
  assert.deepEqual(sparse.history, []);
  assert.throws(() => parseCompany({ quoteSummary: { result: null, error: { description: "Not Found" } } }, "ZZZ"), /No company data for ZZZ: Not Found/);
});

test("an ETF is a fund: cost, size and holdings instead of financials", () => {
  const f = parseCompany(fundJson(), "IDX");
  assert.equal(f.kind, "fund");
  assert.deepEqual([f.fund.category, f.fund.expenseRatio, f.fund.totalAssets], ["Large Blend", 0.0003, 20e9]);
  assert.equal(f.fund.topHoldings.length, 5);
});

test("a healthy, growing, profitable company scores high and explains every point", () => {
  const a = analyzeCompany(parseCompany(companyJson(), "ACME"), { price: 100, now: NOW });
  assert.equal(a.ok, true);
  assert.ok(a.score >= 80, `score ${a.score}`);
  assert.equal(a.verdict.tone, "good");
  assert.ok(a.factors.length >= 12);
  assert.ok(a.factors.every((f) => f.note && f.points >= 0 && f.points <= f.max));
  assert.ok(a.factors.find((f) => f.label === "Average price target").note.includes("50% above"), "target 150 vs price 100");
  assert.equal(a.flags.length, 0, `unexpected flags: ${a.flags.join(" | ")}`);
});

test("a loss-making company that burns cash is weak and flagged", () => {
  const json = companyJson({
    financialData: { revenueGrowth: v(0.1), earningsGrowth: v(-0.5), profitMargins: v(-0.4), operatingMargins: v(-0.3), returnOnEquity: v(-0.5), totalCash: v(1e9), totalDebt: v(4e9), debtToEquity: v(250), currentRatio: v(0.8), freeCashflow: v(-1.5e9), targetMeanPrice: v(12), recommendationKey: "hold", numberOfAnalystOpinions: v(20) },
    summaryDetail: { trailingPE: {}, forwardPE: {} },
    defaultKeyStatistics: { shortPercentOfFloat: v(0.15) },
  });
  const a = analyzeCompany(parseCompany(json, "LOSS"), { price: 15, now: NOW });
  assert.ok(a.score < 40, `score ${a.score}`);
  assert.equal(a.verdict.tone, "bad");
  for (const pattern of [/Not profitable/, /Burning cash/, /Very high debt/, /sold short/, /below the current price/]) {
    assert.ok(a.flags.some((flag) => pattern.test(flag)), `missing flag ${pattern}: ${a.flags.join(" | ")}`);
  }
  assert.ok(a.factors.find((f) => f.label === "Price against earnings (P/E)").note.includes("No profits"));
});

test("banks and insurers are not scored on debt or liquidity", () => {
  const bank = analyzeCompany(parseCompany(companyJson({ assetProfile: { sector: "Financial Services" }, financialData: { ...companyJson().quoteSummary.result[0].financialData, debtToEquity: v(900), currentRatio: v(0.2) } }), "BANK"), { price: 100, now: NOW });
  assert.equal(bank.factors.find((f) => f.label === "Debt against equity"), undefined);
  assert.equal(bank.factors.find((f) => f.label === "Short-term liquidity"), undefined);
  assert.ok(bank.flags.some((f) => /Financial company/.test(f)));
  assert.ok(!bank.flags.some((f) => /Very high debt/.test(f)));
});

test("earnings close by, thin analyst coverage, small size and too little data are all reported", () => {
  const soon = analyzeCompany(parseCompany(companyJson({ calendarEvents: { earnings: { earningsDate: [v((NOW + 9 * DAY) / 1000)] } } }), "SOON"), { price: 100, now: NOW });
  assert.ok(soon.flags.some((f) => /Earnings report in 9 days/.test(f)));
  const small = analyzeCompany(parseCompany(companyJson({ price: { longName: "Small", quoteType: "EQUITY", marketCap: v(300e6) }, financialData: { ...companyJson().quoteSummary.result[0].financialData, numberOfAnalystOpinions: v(2) } }), "SM"), { price: 100, now: NOW });
  assert.ok(small.flags.some((f) => /Small company/.test(f)));
  assert.ok(small.flags.some((f) => /Few or no analysts/.test(f)));
  assert.equal(small.factors.find((f) => f.label === "Average price target"), undefined, "a target from 2 analysts is not used");
  const empty = analyzeCompany(parseCompany({ quoteSummary: { result: [{ price: { longName: "Nothing", quoteType: "EQUITY" } }] } }, "NIL"), { price: 10, now: NOW });
  assert.equal(empty.score, null);
  assert.match(empty.verdict.label, /Not enough data/);
});

test("funds are described, not scored: cost, size, concentration, leverage, commodities", () => {
  const cheap = analyzeCompany(parseCompany(fundJson(), "IDX"), { now: NOW });
  assert.equal(cheap.kind, "fund");
  assert.equal(cheap.score, null);
  assert.equal(cheap.flags.length, 0);
  assert.ok(cheap.factors.find((f) => f.label === "Yearly cost").tone === "good");

  const bad = analyzeCompany(parseCompany(fundJson({
    price: { longName: "UltraPro 3x Bull Tech", quoteType: "ETF" },
    summaryDetail: { totalAssets: v(20e6) },
    fundProfile: { categoryName: "Trading--Leveraged Equity", feesExpensesInvestment: { annualReportExpenseRatio: v(0.0095) } },
  }), "TQQQ"), { now: NOW });
  for (const pattern of [/High cost/, /Small fund/, /Leveraged or inverse/]) assert.ok(bad.flags.some((f) => pattern.test(f)), `missing ${pattern}`);

  const gold = analyzeCompany(parseCompany(fundJson({ fundProfile: { categoryName: "Commodities Focused" } }), "GLD"), { now: NOW });
  assert.ok(gold.flags.some((f) => /commodity fund holds no companies/.test(f)));
});

test("the combined read says when chart and business agree or disagree", () => {
  const chart = (tone) => ({ ok: true, verdict: { tone } });
  const company = (score) => ({ ok: true, kind: "company", score });
  assert.match(combinedRead(chart("good"), company(80)), /agree/);
  assert.match(combinedRead(chart("good"), company(30)), /momentum bet/);
  assert.match(combinedRead(chart("caution"), company(50)), /reasonable trade/);
  assert.match(combinedRead(chart("bad"), company(80)), /sound business in a weak chart/);
  assert.match(combinedRead(chart("bad"), company(20)), /Both/);
  assert.match(combinedRead(chart("mixed"), company(50)), /mixed/);
  assert.match(combinedRead(chart("mixed"), company(84)), /strong business with an undecided chart/);
  assert.match(combinedRead(chart("mixed"), company(20)), /Weak numbers/);
  assert.match(combinedRead(chart("good"), { ok: true, kind: "fund", score: null }), /no company score/);
  assert.equal(combinedRead({ ok: false }, company(50)), null);
});

// ---- the Yahoo session: cookie, crumb, retry ----

test("the data service starts a session (no Accept header on the crumb call), retries a stale one, and caches", async () => {
  const seen = [];
  let crumbValid = "crumb-1";
  let issued = 0;
  const fetchFn = async (url, init = {}) => {
    const u = String(url);
    const headers = init.headers ?? {};
    seen.push({ u, headers });
    if (u.startsWith("https://fc.yahoo.com")) {
      issued += 1;
      const h = new Headers();
      h.append("set-cookie", `A3=cookie${issued}; Path=/; Domain=.yahoo.com`);
      return new Response("", { status: 404, headers: h });
    }
    if (u.includes("getcrumb")) {
      if (headers.Accept) return new Response("{}", { status: 406 }); // what Yahoo does
      return new Response(`crumb-${issued}`, { status: 200 });
    }
    if (u.includes("quoteSummary")) {
      const asked = new URL(u).searchParams.get("crumb");
      if (asked !== crumbValid) return new Response("{}", { status: 401 });
      return new Response(JSON.stringify(companyJson()), { status: 200 });
    }
    throw new Error(`unexpected ${u}`);
  };
  const data = createStockData({ fetchFn });
  crumbValid = "crumb-2"; // the first session's crumb is already stale, so the first summary call is refused
  const company = await data.company("ACME");
  assert.equal(company.profile.name, "Acme Corp");
  assert.equal(issued, 2, "a fresh session was started after the 401");
  assert.ok(seen.filter((s) => s.u.includes("getcrumb")).every((s) => !s.headers.Accept), "the crumb call sends no Accept header");
  assert.ok(seen.filter((s) => s.u.includes("quoteSummary")).every((s) => /A3=cookie\d/.test(s.headers.Cookie)), "the cookie travels with the request");
  const before = seen.length;
  await data.company("ACME");
  assert.equal(seen.length, before, "served from the cache");

  const broken = createStockData({ fetchFn: async (url) => (String(url).startsWith("https://fc.yahoo.com") ? new Response("", { status: 404 }) : new Response("{}", { status: 200 })) });
  await assert.rejects(broken.company("X"), /did not start a session/);
});

// ---- HTTP ----

test("HTTP: /stocks/company needs a listed ticker and reports failures", async () => {
  const listed = ["AAPL", "SPY"].map((symbol) => ({ symbol, tradability: "BUY_SELL", fractionable: true, minNotional: "5" }));
  const fakeStocks = { async exchangeInfo() { return { symbols: listed }; } };
  const fakeYahoo = { async company(symbol) { if (symbol === "SPY") throw new Error("The company data service is rate limiting requests: try again in a minute"); return parseCompany(companyJson(), symbol); } };
  const store = new FileStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "co-")) });
  const spot = new OrderManager({ getClient: () => ({}), getMode: () => "paper", getTradingFee: async () => ({}), store });
  await spot.init();
  const { app } = createApp({ orderManager: spot, stocksClient: fakeStocks, stockData: fakeYahoo });
  const server = app.listen(0);
  const get = async (url) => { const r = await fetch(`http://127.0.0.1:${server.address().port}/api${url}`); return { status: r.status, body: await r.json() }; };
  try {
    const ok = await get("/stocks/company?symbol=AAPL");
    assert.equal(ok.status, 200);
    assert.equal(ok.body.profile.name, "Acme Corp");
    assert.equal((await get("/stocks/company?symbol=NOTLISTED")).status, 422);
    assert.equal((await get("/stocks/company?symbol=bad!")).status, 422);
    const failing = await get("/stocks/company?symbol=SPY");
    assert.equal(failing.status, 500);
    assert.match(failing.body.detail, /rate limiting/);
  } finally {
    server.close();
  }
});
