/**
 * Which phase of its life a company is in, and how to value it there.
 *
 * Three yes/no questions decide the phase:
 *   1. Is revenue growing?        latest quarter against the same quarter a year ago
 *   2. Is it profitable?          net profit over the last twelve months
 *   3. Is it returning capital?   dividends and buybacks paid over the last twelve months
 *
 *   profitable and returning capital                       -> 4  Capital return
 *   profitable and growing, not returning capital          -> 3  Operating leverage
 *   growing, not profitable                                -> 2  Hyper growth  (1 Startup while revenue is under $100M)
 *   anything else (not growing, and not both profitable
 *     and returning capital)                               -> 5  Decline
 *
 * That covers all eight yes/no combinations exactly once. When a question cannot be answered from the data, every
 * way it could resolve is tried: if they all lead to the same phase the phase is still given (marked as inferred),
 * otherwise the phase is left open and the possible ones are listed.
 *
 * Each phase has its own yardstick, because the right measure depends on what the business is doing:
 *   1 Startup, 2 Hyper growth   price / sales (forward)       and price / gross profit (trailing)
 *   3 Operating leverage        price / earnings (forward)    and price / free cash flow (forward)
 *   4 Capital return            price / earnings (trailing)   and price / free cash flow (trailing)
 *   5 Decline                   price / earnings (forward)    and price / free cash flow (forward)
 *
 * Yahoo publishes no forward cash flow, so "forward" price / free cash flow is an estimate: today's free cash flow
 * scaled by how much analysts expect revenue to change next year (the same cash margin on next year's revenue).
 * It is labelled as an estimate wherever it appears.
 *
 * The valuation bands are rough rules of thumb, not recommendations: what is cheap depends on the sector and the
 * interest rate. They are collected in VALUATION_BANDS so they are easy to change.
 */

export const PHASE_THRESHOLDS = Object.freeze({
  startupRevenue: 100e6, // below this a growing, unprofitable company is a startup; above it, hyper growth
  hyperGrowth: 0.3, // typical hyper-growth speed, used only to word a note
  returnShareOfFcf: 0.1, // returning capital = paying out at least this share of free cash flow...
  returnShareOfCap: 0.005, // ...or at least this share of the market value, over the last year
  flatGrowth: 0.02, // revenue within +/-2% is called out as roughly flat
  staleDays: 400, // a figure older than this, against the latest revenue date, no longer describes the company
});

export const VALUATION_BANDS = Object.freeze({
  ps: { low: 2, high: 10 },
  pgp: { low: 4, high: 20 },
  pe: { low: 15, high: 30 },
  pfcf: { low: 15, high: 30 },
});

export const PHASES = Object.freeze({
  1: { id: 1, name: "Startup", tagline: "Early and not yet profitable: still proving the business, so it is judged on sales." },
  2: { id: 2, name: "Hyper growth", tagline: "Growing fast but not yet profitable: judged on sales and on the gross profit each sale leaves." },
  3: { id: 3, name: "Operating leverage", tagline: "Growing and now profitable: extra revenue adds more profit than cost. Judged on expected earnings and cash flow." },
  4: { id: 4, name: "Capital return", tagline: "Profitable and handing cash back to owners. Judged on what it earns and generates today." },
  5: { id: 5, name: "Decline", tagline: "Revenue is shrinking, or profits are not being shared. What matters is what is still expected to be left." },
});

const METRICS = {
  ps: { label: "Price / sales", help: "Market value divided by revenue" },
  pgp: { label: "Price / gross profit", help: "Market value divided by gross profit (revenue minus the direct cost of sales)" },
  pe: { label: "Price / earnings", help: "Share price divided by earnings per share" },
  pfcf: { label: "Price / free cash flow", help: "Market value divided by the cash left after running and investing in the business" },
};

/** What each phase is measured by: [metric, basis asked for]. */
const PHASE_METRICS = {
  1: [["ps", "forward"], ["pgp", "trailing"]],
  2: [["ps", "forward"], ["pgp", "trailing"]],
  3: [["pe", "forward"], ["pfcf", "forward"]],
  4: [["pe", "trailing"], ["pfcf", "trailing"]],
  5: [["pe", "forward"], ["pfcf", "forward"]],
};

const T = PHASE_THRESHOLDS;
const round = (n, d = 1) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const pct = (v, d = 0) => (v == null ? "—" : `${round(v * 100, d)}%`);
const money = (n) => {
  if (n == null) return "—";
  const a = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (a >= 1e12) return `${sign}$${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(0)}M`;
  return `${sign}$${Math.round(a).toLocaleString()}`;
};
const positive = (n) => n != null && Number.isFinite(n) && n > 0;
const ratio = (a, b) => (positive(a) && positive(b) ? a / b : null);
const daysBetween = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

// ---------- reading the time series ----------

const last = (series) => (series?.length ? series[series.length - 1] : null);

/** The newest date we have revenue for: the yardstick for "is this figure still current". */
function referenceDate(fundamentals) {
  const dates = [last(fundamentals?.trailing?.revenue)?.date, last(fundamentals?.annual?.revenue)?.date].filter(Boolean);
  return dates.length ? dates.sort().at(-1) : null;
}

/** Newest value of a metric across the trailing and annual series, or null if there is none or it is stale. */
function latest(fundamentals, metric) {
  if (!fundamentals) return null;
  const points = [last(fundamentals.trailing?.[metric]), last(fundamentals.annual?.[metric])].filter(Boolean).sort((a, b) => (a.date < b.date ? -1 : 1));
  const point = points.at(-1);
  if (!point) return null;
  const ref = referenceDate(fundamentals);
  if (ref && daysBetween(ref, point.date) > T.staleDays) return null;
  return point;
}

/**
 * Free cash flow over the last twelve months. The dated figure from the statements wins: the single number in Yahoo's
 * summary is sometimes stale or computed differently (for example $16B against $67B for the same company and period).
 */
function freeCashFlow(company) {
  return latest(company.fundamentals, "freeCashFlow")?.value ?? company.health?.freeCashflow ?? null;
}

function revenueNow(company) {
  const r = company.growth?.revenue;
  return positive(r) ? r : latest(company.fundamentals, "revenue")?.value ?? null;
}

/** Revenue growth as a fraction, with a description of where it came from. */
function revenueGrowth(company) {
  const g = company.growth?.revenueGrowth;
  if (g != null) return { value: g, source: "the latest quarter against the same quarter a year ago" };
  const f = company.fundamentals;
  const trailing = f?.trailing?.revenue ?? [];
  const now = last(trailing);
  const yearAgo = now && trailing.find((p) => { const d = daysBetween(p.date, now.date); return d >= 330 && d <= 400; });
  if (positive(yearAgo?.value) && now.value != null) return { value: now.value / yearAgo.value - 1, source: "the last twelve months against the twelve before" };
  const annual = f?.annual?.revenue ?? company.history?.filter((y) => y.revenue != null).sort((a, b) => a.year - b.year).map((y) => ({ value: y.revenue })) ?? [];
  if (annual.length >= 2 && positive(annual.at(-2).value)) return { value: annual.at(-1).value / annual.at(-2).value - 1, source: "the last fiscal year against the one before" };
  return null;
}

// ---------- the three questions ----------

function askGrowing(company) {
  const revenue = revenueNow(company);
  if (company.growth?.revenue === 0 || revenue === 0) {
    return { key: "growing", question: "Is revenue growing?", answer: false, preRevenue: true, detail: "No revenue yet.", growth: null, revenue: 0 };
  }
  const g = revenueGrowth(company);
  if (!g) return { key: "growing", question: "Is revenue growing?", answer: null, detail: "No revenue growth figure is available.", growth: null, revenue };
  const up = g.value > 0;
  return {
    key: "growing",
    question: "Is revenue growing?",
    answer: up,
    detail: `Revenue is ${up ? "up" : "down"} ${pct(Math.abs(g.value), 1)} (${g.source}).`,
    growth: g.value,
    revenue,
  };
}

function askProfitable(company) {
  const m = company.profitability?.profitMargins;
  if (m != null) {
    return { key: "profitable", question: "Is it profitable?", answer: m > 0, margin: m, detail: m > 0 ? `Keeps ${pct(m, 1)} of revenue as net profit.` : `Loses ${pct(-m, 1)} of revenue (net margin ${pct(m, 1)}).` };
  }
  const income = latest(company.fundamentals, "netIncome");
  if (income) return { key: "profitable", question: "Is it profitable?", answer: income.value > 0, margin: null, detail: `Net income over the last year: ${money(income.value)}.` };
  const op = company.profitability?.operatingMargins;
  if (op != null) return { key: "profitable", question: "Is it profitable?", answer: op > 0, margin: null, detail: `Net profit is not reported; operating margin is ${pct(op, 1)}.` };
  return { key: "profitable", question: "Is it profitable?", answer: null, margin: null, detail: "No profit figure is available." };
}

function askReturning(company) {
  const q = { key: "returning", question: "Is it returning capital?" };
  const cap = company.valuation?.marketCap;
  const f = company.fundamentals;
  const yieldNow = company.valuation?.dividendYield;
  const hasStatements = Boolean(f && (f.trailing?.revenue || f.annual?.revenue));

  // Without the cash-flow statement a dividend is visible but a buyback is not.
  if (!hasStatements) {
    if (yieldNow != null && cap > 0 && yieldNow >= T.returnShareOfCap) return { ...q, answer: true, returned: yieldNow * cap, detail: `Pays a ${pct(yieldNow, 2)} dividend yield. Buybacks could not be checked.` };
    return { ...q, answer: null, returned: null, detail: "Dividends and buybacks could not be checked." };
  }

  const dividendsPaid = latest(f, "dividends")?.value ?? 0;
  const buybacks = latest(f, "buybacks")?.value ?? 0;
  const dividends = dividendsPaid > 0 ? dividendsPaid : yieldNow > 0 && cap > 0 && !f.annual?.dividends && !f.trailing?.dividends ? yieldNow * cap : 0;
  const returned = dividends + buybacks;
  const fcf = freeCashFlow(company);
  const ofFcf = positive(fcf) ? returned / fcf : null;
  const ofCap = positive(cap) ? returned / cap : null;
  const yes = returned > 0 && ((ofFcf != null && ofFcf >= T.returnShareOfFcf) || (ofCap != null && ofCap >= T.returnShareOfCap));

  const parts = [dividends > 0 ? `${money(dividends)} in dividends` : null, buybacks > 0 ? `${money(buybacks)} in buybacks` : null].filter(Boolean);
  let detail;
  if (returned <= 0) detail = "No dividends or buybacks in the last year.";
  else {
    const share = [ofFcf != null ? `${pct(ofFcf)} of free cash flow` : null, ofCap != null ? `${pct(ofCap, 1)} of market value` : null].filter(Boolean).join(", ");
    detail = `Paid ${parts.join(" and ")} over the last year (${share}).${yes ? "" : " That is only a token amount."}`;
  }
  return { ...q, answer: yes, returned, detail };
}

// ---------- the decision ----------

/** The phase for one combination of answers (all true/false). */
function decide(growing, profitable, returning, { revenue, preRevenue }) {
  if (profitable && returning) return 4;
  if (profitable && growing) return 3;
  if (growing && !profitable) return positive(revenue) && revenue >= T.startupRevenue ? 2 : 1;
  if (preRevenue && !profitable) return 1;
  return 5;
}

/** Try every way the unknown answers could turn out. */
function resolve(answers, extra) {
  const options = answers.map((a) => (a.answer == null ? [true, false] : [a.answer]));
  const phases = new Set();
  for (const g of options[0]) for (const p of options[1]) for (const r of options[2]) phases.add(decide(g, p, r, extra));
  return [...phases].sort();
}

function bandOf(key, value) {
  const band = VALUATION_BANDS[key];
  if (value == null || !band) return null;
  return value < band.low ? "low" : value > band.high ? "high" : "moderate";
}

// ---------- valuation ----------

function valuationInputs(company, price) {
  const v = company.valuation ?? {};
  const fwd = company.forward ?? {};
  const f = company.fundamentals;
  const marketCap = positive(v.marketCap) ? v.marketCap : null;
  const revenue = revenueNow(company);
  const margin = company.profitability?.grossMargins;
  const grossProfit = latest(f, "grossProfit")?.value ?? (positive(revenue) && margin != null ? revenue * margin : null);
  const fcf = freeCashFlow(company);
  const forwardEps = positive(fwd.forwardEps) ? fwd.forwardEps : positive(fwd.epsNextYear) ? fwd.epsNextYear : null;
  return {
    marketCap,
    revenue,
    revenueNext: positive(fwd.revenueNextYear) ? fwd.revenueNextYear : null,
    grossProfit: positive(grossProfit) ? grossProfit : null,
    fcf,
    peTrailing: positive(v.trailingPE) ? v.trailingPE : null,
    peForward: positive(v.forwardPE) ? v.forwardPE : ratio(price, forwardEps),
    psTrailing: ratio(marketCap, revenue) ?? (positive(v.priceToSales) ? v.priceToSales : null),
  };
}

function computeMetric(key, asked, x) {
  const base = { key, ...METRICS[key], asked };
  const finish = (value, basis, note, alt = null) => ({ ...base, value: round(value, 1), basis, note, alt: alt && alt.value != null ? { basis: alt.basis, value: round(alt.value, 1) } : null, band: bandOf(key, value) });

  if (key === "ps") {
    const forward = ratio(x.marketCap, x.revenueNext);
    if (asked === "forward" && forward != null) return finish(forward, "forward", "Market value divided by the revenue analysts expect next fiscal year.", { basis: "trailing", value: x.psTrailing });
    if (x.psTrailing != null) return finish(x.psTrailing, "trailing", asked === "forward" ? "No analyst revenue estimate is available, so this uses the last twelve months of revenue." : "Market value divided by the last twelve months of revenue.", { basis: "forward", value: forward });
    return finish(null, asked, "Market value or revenue is missing.");
  }
  if (key === "pgp") {
    const value = ratio(x.marketCap, x.grossProfit);
    return finish(value, "trailing", value != null ? "Market value divided by the last twelve months of gross profit." : "Gross profit is missing or not positive.");
  }
  if (key === "pe") {
    const alt = (basis) => ({ basis, value: basis === "forward" ? x.peForward : x.peTrailing });
    if (asked === "forward") {
      if (x.peForward != null) return finish(x.peForward, "forward", "Share price divided by the earnings per share analysts expect next fiscal year.", alt("trailing"));
      if (x.peTrailing != null) return finish(x.peTrailing, "trailing", "No positive earnings estimate is available, so this uses the last twelve months.");
      return finish(null, "forward", "Earnings are negative, so a price / earnings ratio means nothing here.");
    }
    if (x.peTrailing != null) return finish(x.peTrailing, "trailing", "Share price divided by the last twelve months of earnings per share.", alt("forward"));
    return finish(null, "trailing", "Earnings over the last twelve months are negative, so a price / earnings ratio means nothing here.", alt("forward"));
  }
  // pfcf
  const trailing = ratio(x.marketCap, x.fcf);
  const scaled = positive(x.fcf) && x.revenueNext && positive(x.revenue) ? x.fcf * (x.revenueNext / x.revenue) : null;
  const forward = ratio(x.marketCap, scaled);
  if (!positive(x.fcf)) return finish(null, asked, x.fcf == null ? "Free cash flow is not reported." : `Free cash flow is negative (${money(x.fcf)}): the company spends more cash than it makes, so this ratio means nothing here.`);
  if (asked === "forward") {
    if (forward != null) return finish(forward, "estimated", "Estimate: today's free cash flow grown by the revenue growth analysts expect next year (same cash margin). No forward cash flow is published.", { basis: "trailing", value: trailing });
    return finish(trailing, "trailing", "No analyst revenue estimate is available to project cash flow, so this uses the last twelve months.");
  }
  return finish(trailing, "trailing", "Market value divided by the last twelve months of free cash flow.", { basis: "estimated", value: forward });
}

/** How the phase's two yardsticks read. */
export function phaseValuation(company, phase, { price = null } = {}) {
  const spec = PHASE_METRICS[phase];
  if (!spec) return null;
  const x = valuationInputs(company, price);
  const metrics = spec.map(([key, asked]) => computeMetric(key, asked, x));
  const bands = metrics.map((m) => m.band).filter(Boolean);
  let read;
  if (!bands.length) read = { tone: "mixed", label: "Cannot be valued on these measures", summary: "The figures this phase relies on are missing or negative." };
  else if (bands.every((b) => b === "low")) read = { tone: "good", label: bands.length === 2 ? "Low on both measures" : "Low on the one available measure", summary: "Below the usual range on what this phase is judged by. Cheap can also mean the market expects trouble." };
  else if (bands.every((b) => b === "high")) read = { tone: "bad", label: bands.length === 2 ? "High on both measures" : "High on the one available measure", summary: "Above the usual range on what this phase is judged by: the price already assumes a lot goes right." };
  else read = { tone: "mixed", label: bands.length === 2 ? "In the middle, or the two disagree" : "Moderate", summary: "Neither clearly cheap nor clearly expensive on what this phase is judged by." };
  return { metrics, read };
}

// ---------- the whole answer ----------

/** Classify a company and value it for its phase. `company` is the object served by /stocks/company. */
export function analyzePhase(company, { price = null } = {}) {
  if (!company || company.kind !== "company") return { ok: false, reason: "Only companies have a phase." };
  const growing = askGrowing(company);
  const profitable = askProfitable(company);
  const returning = askReturning(company);
  const answers = [growing, profitable, returning];
  const extra = { revenue: growing.revenue, preRevenue: Boolean(growing.preRevenue) };
  const phases = resolve(answers, extra);
  const known = answers.filter((a) => a.answer != null).length;
  const phase = phases.length === 1 ? phases[0] : null;
  const inferred = phase != null && known < 3;

  const notes = [];
  const g = growing.growth;
  if (g != null && Math.abs(g) < T.flatGrowth) notes.push(`Revenue growth of ${pct(g, 1)} is close to flat, so the first answer could flip in a quarter or two.`);
  if (profitable.margin != null && profitable.margin > 0 && profitable.margin < 0.01) notes.push("Net profit is barely above zero, so the second answer could flip easily.");
  if (phase === 2 && g != null && g < T.hyperGrowth) notes.push(`Growing ${pct(g)}, slower than the 30% or more usually called hyper growth. The label only means "growing, not yet profitable" at scale.`);
  if (phase === 3 && g != null && g >= T.hyperGrowth) notes.push(`Growing ${pct(g)} while profitable: unusually fast for this phase.`);
  if (phase === 4 && g != null && g >= 0.15) notes.push(`Still growing ${pct(g)} while returning capital: a strong business, young for this phase.`);
  if (phase === 5 && profitable.answer && !returning.answer) notes.push("Profitable but shrinking and keeping its cash: it may be a turnaround, or a business with no better use for the money.");
  if (growing.answer && !profitable.answer && returning.answer) notes.push("It returns capital while unprofitable: check whether that is paid from cash on hand or from debt.");
  if (growing.preRevenue) notes.push("No revenue yet: a pre-revenue company is treated as a startup.");
  if (inferred) notes.push("Some answers were missing; every way they could turn out leads to the same phase.");
  if (phase == null) notes.push(`The data does not settle it: it could be ${phases.map((p) => `phase ${p} (${PHASES[p].name})`).join(" or ")}.`);
  if (!company.fundamentals) notes.push("Detailed financial statements were unavailable, so buybacks and some figures could not be read.");

  const info = phase ? PHASES[phase] : null;
  return {
    ok: true,
    phase,
    name: info?.name ?? null,
    tagline: info?.tagline ?? null,
    inferred,
    candidates: phase ? [] : phases.map((p) => ({ phase: p, name: PHASES[p].name })),
    answers: answers.map(({ key, question, answer, detail }) => ({ key, question, answer, detail })),
    notes,
    valuation: phase ? phaseValuation(company, phase, { price }) : null,
  };
}
