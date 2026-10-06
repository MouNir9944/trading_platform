import assert from "node:assert/strict";
import test from "node:test";

import { analyzeCompany } from "../shared/analysis/company.js";
import { PHASES, PHASE_THRESHOLDS, analyzePhase, phaseValuation } from "../shared/analysis/phase.js";
import { createStockData, parseCompany, parseFundamentals } from "./stockData.js";

const near = (a, b, eps = 0.06) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);
const v = (raw) => ({ raw, fmt: String(raw) });

/**
 * A company with the three answers set directly. Defaults: market value $50B, revenue $9B (so past the startup size),
 * gross margin 70%, free cash flow $2B, next year's revenue $12B.
 */
function company({ growing = true, profitable = true, returning = true, revenue = 9e9, fundamentals = undefined, ...over } = {}) {
  const fcf = 2e9;
  return {
    kind: "company",
    profile: { name: "Acme", sector: "Technology" },
    valuation: { marketCap: 50e9, trailingPE: profitable ? 28 : null, forwardPE: profitable ? 22 : null, priceToSales: 5.5, dividendYield: 0 },
    growth: { revenueGrowth: growing ? 0.22 : -0.08, revenue },
    profitability: { profitMargins: profitable ? 0.24 : -0.1, grossMargins: 0.7, operatingMargins: profitable ? 0.28 : -0.05 },
    health: { freeCashflow: fcf },
    forward: { revenueNextYear: 12e9, forwardEps: profitable ? 2.2 : null },
    history: [],
    // buybacks of 20% of free cash flow count as returning capital, a token $10M does not
    fundamentals: fundamentals === undefined
      ? { annual: { revenue: [{ date: "2025-12-31", value: revenue }] }, trailing: { buybacks: [{ date: "2025-12-31", value: returning ? 0.2 * fcf : 10e6 }] } }
      : fundamentals,
    ...over,
  };
}
const phaseOf = (c) => analyzePhase(c).phase;

// ---------- the three questions decide the phase ----------

test("all eight yes/no combinations land on exactly one phase", () => {
  const table = [
    // growing, profitable, returning -> phase
    [true, true, true, 4],
    [true, true, false, 3],
    [true, false, false, 2], // growing, not profitable: hyper growth (revenue is above the startup size)
    [true, false, true, 2],
    [false, true, true, 4],
    [false, true, false, 5],
    [false, false, false, 5],
    [false, false, true, 5],
  ];
  for (const [growing, profitable, returning, expected] of table) {
    const r = analyzePhase(company({ growing, profitable, returning }));
    assert.deepEqual(r.answers.map((a) => a.answer), [growing, profitable, returning]);
    assert.equal(r.phase, expected, `growing=${growing} profitable=${profitable} returning=${returning}`);
    assert.equal(r.name, PHASES[expected].name);
  }
});

test("growing but unprofitable is a startup below $100M of revenue, hyper growth above it", () => {
  assert.equal(phaseOf(company({ profitable: false, returning: false, revenue: PHASE_THRESHOLDS.startupRevenue - 1 })), 1);
  assert.equal(phaseOf(company({ profitable: false, returning: false, revenue: PHASE_THRESHOLDS.startupRevenue })), 2);
});

test("no revenue yet and no profit is a startup, not a decline", () => {
  const c = company({ profitable: false, returning: false, revenue: 0, growth: { revenueGrowth: null, revenue: 0 } });
  const r = analyzePhase(c);
  assert.equal(r.phase, 1);
  assert.equal(r.answers[0].answer, false);
  assert.ok(r.notes.some((n) => /No revenue yet/.test(n)));
});

test("a startup and a hyper-growth company are valued the same way, and so on down the phases", () => {
  const keys = (phase) => phaseValuation(company(), phase).metrics.map((m) => `${m.key}:${m.asked}`);
  assert.deepEqual(keys(1), ["ps:forward", "pgp:trailing"]);
  assert.deepEqual(keys(2), keys(1));
  assert.deepEqual(keys(3), ["pe:forward", "pfcf:forward"]);
  assert.deepEqual(keys(4), ["pe:trailing", "pfcf:trailing"]);
  assert.deepEqual(keys(5), keys(3));
});

// ---------- questions that cannot be answered ----------

test("a missing answer is resolved when every way it could turn out gives the same phase", () => {
  // Not profitable and not growing is a decline whatever the third answer is.
  const c = company({ growing: false, profitable: false, returning: false, fundamentals: null, valuation: { marketCap: 50e9, dividendYield: 0 } });
  const r = analyzePhase(c);
  assert.equal(r.answers[2].answer, null);
  assert.equal(r.phase, 5);
  assert.equal(r.inferred, true);
  assert.ok(r.notes.some((n) => /same phase/.test(n)));
});

test("a missing answer that matters leaves the phase open and lists the candidates", () => {
  // Growing and profitable: phase 3 if it returns no capital, phase 4 if it does. Buybacks cannot be checked here.
  const c = company({ fundamentals: null, valuation: { marketCap: 50e9, trailingPE: 28, forwardPE: 22, dividendYield: 0 } });
  const r = analyzePhase(c);
  assert.equal(r.answers[2].answer, null);
  assert.equal(r.phase, null);
  assert.deepEqual(r.candidates.map((x) => x.phase), [3, 4]);
  assert.equal(r.valuation, null);
  assert.ok(r.notes.some((n) => /phase 3 .* or phase 4/.test(n)));
});

test("nothing known at all gives no phase rather than a guess", () => {
  const r = analyzePhase({ kind: "company", valuation: {}, growth: {}, profitability: {}, health: {}, fundamentals: null });
  assert.equal(r.ok, true);
  assert.equal(r.phase, null);
  assert.ok(r.candidates.length > 1);
});

test("funds have no phase", () => {
  assert.equal(analyzePhase({ kind: "fund" }).ok, false);
  assert.equal(analyzeCompany({ kind: "fund", profile: {}, fund: {}, events: {} }).phase, undefined);
});

// ---------- returning capital ----------

test("returning capital: a real buyback or dividend counts, a token amount does not", () => {
  const yes = analyzePhase(company({ returning: true })).answers[2];
  assert.equal(yes.answer, true);
  assert.match(yes.detail, /buybacks/);
  const token = analyzePhase(company({ returning: false })).answers[2];
  assert.equal(token.answer, false);
  assert.match(token.detail, /token/);
  const none = analyzePhase(company({ fundamentals: { annual: { revenue: [{ date: "2025-12-31", value: 9e9 }] }, trailing: {} } })).answers[2];
  assert.equal(none.answer, false);
  assert.match(none.detail, /No dividends or buybacks/);
});

test("returning capital: the share of market value also counts when free cash flow is small", () => {
  // $0.4B back on a $50B company is 0.8% of its value, above the 0.5% line, even though it is 100% of FCF here.
  const c = company({ health: { freeCashflow: -1e9 }, fundamentals: { annual: { revenue: [{ date: "2025-12-31", value: 9e9 }] }, trailing: { dividends: [{ date: "2025-12-31", value: 0.4e9 }] } } });
  assert.equal(analyzePhase(c).answers[2].answer, true);
});

test("returning capital: a figure older than a year against the latest revenue is ignored", () => {
  const c = company({
    fundamentals: {
      trailing: { revenue: [{ date: "2026-06-30", value: 9e9 }] },
      annual: { buybacks: [{ date: "2023-12-31", value: 5e9 }] }, // stopped long ago
    },
  });
  assert.equal(analyzePhase(c).answers[2].answer, false);
});

test("returning capital: the newest of the annual and trailing figures wins", () => {
  const c = company({
    fundamentals: {
      annual: { revenue: [{ date: "2025-12-31", value: 9e9 }], dividends: [{ date: "2025-12-31", value: 0 }] }, // dividend cut to zero
      trailing: { dividends: [{ date: "2025-06-30", value: 1e9 }] }, // the older trailing figure
    },
  });
  assert.equal(analyzePhase(c).answers[2].answer, false);
});

test("returning capital: with no statements a visible dividend still answers yes", () => {
  const c = company({ fundamentals: null, valuation: { marketCap: 50e9, trailingPE: 28, forwardPE: 22, dividendYield: 0.03 } });
  const r = analyzePhase(c);
  assert.equal(r.answers[2].answer, true);
  assert.match(r.answers[2].detail, /Buybacks could not be checked/);
  assert.equal(r.phase, 4);
});

// ---------- revenue growth and profit sources ----------

test("revenue growth: falls back to the trailing series, then to annual figures", () => {
  const base = { growth: { revenueGrowth: null, revenue: 9e9 } };
  const trailing = analyzePhase(company({ ...base, fundamentals: { trailing: { revenue: [{ date: "2025-06-30", value: 8e9 }, { date: "2026-06-30", value: 9e9 }] }, annual: {} } }));
  assert.equal(trailing.answers[0].answer, true);
  assert.match(trailing.answers[0].detail, /12\.5%.*twelve months/);
  const annual = analyzePhase(company({ ...base, fundamentals: { annual: { revenue: [{ date: "2024-12-31", value: 10e9 }, { date: "2025-12-31", value: 9e9 }] }, trailing: {} } }));
  assert.equal(annual.answers[0].answer, false);
  assert.match(annual.answers[0].detail, /fiscal year/);
});

test("profit: net margin first, then net income, then operating margin", () => {
  assert.equal(analyzePhase(company({ profitable: false })).answers[1].answer, false);
  const income = analyzePhase(company({ profitability: { profitMargins: null }, fundamentals: { annual: { revenue: [{ date: "2025-12-31", value: 9e9 }], netIncome: [{ date: "2025-12-31", value: 1e9 }] }, trailing: {} } }));
  assert.equal(income.answers[1].answer, true);
  const operating = analyzePhase(company({ profitability: { profitMargins: null, operatingMargins: -0.2 }, fundamentals: null }));
  assert.equal(operating.answers[1].answer, false);
  assert.match(operating.answers[1].detail, /operating margin/);
});

test("notes call out the borderline and unusual cases", () => {
  const flat = analyzePhase(company({ growth: { revenueGrowth: 0.005, revenue: 9e9 } }));
  assert.ok(flat.notes.some((n) => /close to flat/.test(n)));
  const slow = analyzePhase(company({ profitable: false, returning: false, growth: { revenueGrowth: 0.12, revenue: 9e9 } }));
  assert.equal(slow.phase, 2);
  assert.ok(slow.notes.some((n) => /slower than the 30%/.test(n)));
  const fast = analyzePhase(company({ returning: false, growth: { revenueGrowth: 0.9, revenue: 9e9 } }));
  assert.equal(fast.phase, 3);
  assert.ok(fast.notes.some((n) => /unusually fast/.test(n)));
  const odd = analyzePhase(company({ profitable: false, returning: true }));
  assert.ok(odd.notes.some((n) => /unprofitable/.test(n)));
});

// ---------- valuation by phase ----------

test("phases 1 and 2: forward price/sales and trailing price/gross profit", () => {
  const [ps, pgp] = phaseValuation(company(), 2).metrics;
  assert.equal(ps.basis, "forward");
  near(ps.value, 50 / 12); // market value over next year's expected revenue
  assert.equal(ps.alt.basis, "trailing");
  near(ps.alt.value, 50 / 9);
  assert.equal(pgp.basis, "trailing");
  near(pgp.value, 50 / (9 * 0.7)); // gross profit = revenue x gross margin
});

test("price/gross profit prefers the reported trailing gross profit", () => {
  const c = company({ fundamentals: { annual: { revenue: [{ date: "2025-12-31", value: 9e9 }] }, trailing: { grossProfit: [{ date: "2025-12-31", value: 5e9 }] } } });
  near(phaseValuation(c, 1).metrics[1].value, 10);
});

test("phase 3 and 5: forward P/E and an estimated forward price/free cash flow", () => {
  for (const phase of [3, 5]) {
    const [pe, pfcf] = phaseValuation(company(), phase).metrics;
    assert.equal(pe.basis, "forward");
    assert.equal(pe.value, 22);
    assert.equal(pe.alt.value, 28); // the trailing figure alongside
    assert.equal(pfcf.basis, "estimated");
    near(pfcf.value, 50 / (2 * (12 / 9))); // free cash flow scaled by expected revenue growth
    assert.match(pfcf.note, /Estimate/);
    near(pfcf.alt.value, 25);
  }
});

test("phase 4: trailing P/E and trailing price/free cash flow", () => {
  const [pe, pfcf] = phaseValuation(company(), 4).metrics;
  assert.equal(pe.basis, "trailing");
  assert.equal(pe.value, 28);
  assert.equal(pfcf.basis, "trailing");
  near(pfcf.value, 25);
  assert.equal(pfcf.alt.basis, "estimated");
});

test("free cash flow comes from the dated statements when they disagree with the summary figure", () => {
  const c = company({ health: { freeCashflow: 0.5e9 }, fundamentals: { annual: { revenue: [{ date: "2025-12-31", value: 9e9 }] }, trailing: { freeCashFlow: [{ date: "2025-12-31", value: 4e9 }] } } });
  near(phaseValuation(c, 4).metrics[1].value, 12.5);
});

test("a ratio that cannot be computed says why instead of showing nonsense", () => {
  const loss = phaseValuation(company({ profitable: false }), 4);
  assert.equal(loss.metrics[0].value, null);
  assert.match(loss.metrics[0].note, /negative/);
  const burn = phaseValuation(company({ health: { freeCashflow: -3e9 } }), 3).metrics[1];
  assert.equal(burn.value, null);
  assert.match(burn.note, /negative/);
  const noCap = phaseValuation(company({ valuation: { trailingPE: 28, forwardPE: 22 } }), 1);
  assert.equal(noCap.metrics[0].value, null);
  assert.equal(noCap.read.label, "Cannot be valued on these measures");
});

test("with no analyst estimates the forward measures fall back to trailing and say so", () => {
  const c = company({ forward: {}, valuation: { marketCap: 50e9, trailingPE: 28, forwardPE: null } });
  const [ps] = phaseValuation(c, 1).metrics;
  assert.equal(ps.basis, "trailing");
  assert.match(ps.note, /No analyst revenue estimate/);
  const [pe, pfcf] = phaseValuation(c, 3).metrics;
  assert.equal(pe.basis, "trailing");
  assert.equal(pe.value, 28);
  assert.equal(pfcf.basis, "trailing");
  near(pfcf.value, 25);
});

test("forward P/E falls back to price over expected earnings per share", () => {
  const c = company({ valuation: { marketCap: 50e9, trailingPE: 28, forwardPE: null } });
  near(phaseValuation(c, 3, { price: 44 }).metrics[0].value, 20);
});

test("bands and the overall read", () => {
  const cheap = phaseValuation(company({ valuation: { marketCap: 50e9, trailingPE: 9, forwardPE: 8 }, health: { freeCashflow: 6e9 } }), 4);
  assert.deepEqual(cheap.metrics.map((m) => m.band), ["low", "low"]);
  assert.equal(cheap.read.tone, "good");
  const rich = phaseValuation(company({ valuation: { marketCap: 50e9, trailingPE: 80, forwardPE: 60 }, health: { freeCashflow: 0.5e9 } }), 4);
  assert.deepEqual(rich.metrics.map((m) => m.band), ["high", "high"]);
  assert.equal(rich.read.tone, "bad");
  const mixed = phaseValuation(company({ valuation: { marketCap: 50e9, trailingPE: 9, forwardPE: 8 }, health: { freeCashflow: 0.5e9 } }), 4);
  assert.equal(mixed.read.tone, "mixed");
});

test("analyzeCompany carries the phase", () => {
  const r = analyzeCompany(company(), { price: 100 });
  assert.equal(r.phase.ok, true);
  assert.equal(r.phase.phase, 4);
  assert.equal(r.phase.valuation.metrics.length, 2);
});

// ---------- the data feeding it ----------

const series = (type, points) => ({ meta: { type: [type] }, [type]: points.map(([asOfDate, raw]) => ({ asOfDate, reportedValue: v(raw) })) });

test("parseFundamentals: sorts by date, stores cash paid out as positive, ignores unknown series", () => {
  const f = parseFundamentals({
    timeseries: {
      result: [
        series("annualRepurchaseOfCapitalStock", [["2025-09-30", -90e9], ["2024-09-30", -95e9]]),
        series("annualCashDividendsPaid", [["2025-09-30", -15e9]]),
        series("trailingFreeCashFlow", [["2026-06-30", 136e9]]),
        series("annualBasicAverageShares", [["2025-09-30", 14.9e9]]),
        series("annualSomethingElse", [["2025-09-30", 1]]),
        { meta: { type: ["annualTotalRevenue"] }, timestamp: [] },
      ],
    },
  });
  assert.deepEqual(f.annual.buybacks.map((p) => [p.date, p.value]), [["2024-09-30", 95e9], ["2025-09-30", 90e9]]);
  assert.equal(f.annual.dividends[0].value, 15e9);
  assert.equal(f.trailing.freeCashFlow[0].value, 136e9);
  assert.equal(f.annual.shares[0].value, 14.9e9);
  assert.equal(f.annual.revenue, undefined);
  assert.equal(parseFundamentals({ timeseries: { result: [] } }), null);
  assert.equal(parseFundamentals({}), null);
});

const summaryJson = () => ({
  quoteSummary: {
    result: [{
      price: { longName: "Acme Corp", quoteType: "EQUITY", marketCap: v(50e9) },
      summaryDetail: { trailingPE: v(28) },
      defaultKeyStatistics: { forwardEps: v(2.2) },
      financialData: { revenueGrowth: v(0.22), totalRevenue: v(9e9), profitMargins: v(0.24) },
      earningsTrend: {
        trend: [
          { period: "0y", revenueEstimate: { avg: v(10e9) }, earningsEstimate: { avg: v(1.9) } },
          { period: "+1y", revenueEstimate: { avg: v(12e9) }, earningsEstimate: { avg: v(2.4) } },
          { period: "0q", revenueEstimate: { avg: v(2e9) } },
        ],
      },
    }],
  },
});

test("parseCompany reads the analysts' forward estimates", () => {
  const c = parseCompany(summaryJson(), "ACME");
  assert.deepEqual(c.forward, { revenueThisYear: 10e9, revenueNextYear: 12e9, epsThisYear: 1.9, epsNextYear: 2.4, forwardEps: 2.2 });
  assert.equal(c.fundamentals, null);
  const bare = parseCompany({ quoteSummary: { result: [{ price: { quoteType: "EQUITY" } }] } }, "X");
  assert.equal(bare.forward.revenueNextYear, null);
});

function fakeYahoo({ timeseries }) {
  const calls = [];
  const fetchFn = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith("https://fc.yahoo.com")) { const h = new Headers(); h.append("set-cookie", "A3=c; Path=/"); return new Response("", { status: 404, headers: h }); }
    if (u.includes("getcrumb")) return new Response("crumb", { status: 200 });
    if (u.includes("quoteSummary")) return new Response(JSON.stringify(summaryJson()), { status: 200 });
    if (u.includes("fundamentals-timeseries")) return timeseries(u);
    throw new Error(`unexpected ${u}`);
  };
  return { fetchFn, calls };
}

test("company() adds the fundamentals, in a second call that reuses the same session", async () => {
  const { fetchFn, calls } = fakeYahoo({ timeseries: () => new Response(JSON.stringify({ timeseries: { result: [series("annualTotalRevenue", [["2025-12-31", 9e9]])] } }), { status: 200 }) });
  const company = await createStockData({ fetchFn }).company("ACME");
  assert.equal(company.fundamentals.annual.revenue[0].value, 9e9);
  assert.equal(calls.filter((u) => u.startsWith("https://fc.yahoo.com")).length, 1, "one session for both requests");
  assert.ok(calls.some((u) => /fundamentals-timeseries\/v1\/finance\/timeseries\/ACME\?/.test(u)));
});

test("company() still loads when the fundamentals cannot be fetched", async () => {
  for (const timeseries of [() => new Response("{}", { status: 500 }), () => { throw new Error("network down"); }, () => new Response("not json", { status: 200 })]) {
    const { fetchFn } = fakeYahoo({ timeseries });
    const company = await createStockData({ fetchFn }).company("ACME");
    assert.equal(company.profile.name, "Acme Corp");
    assert.equal(company.fundamentals, null);
    assert.equal(company.forward.revenueNextYear, 12e9);
  }
});
