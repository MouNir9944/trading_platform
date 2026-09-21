/**
 * Daily price history and name search for US stocks and ETFs, from Yahoo Finance's public chart and search
 * endpoints (no key). Binance Stocks has no price history, and only ~260 of its ~7,900 tickers have a Binance
 * futures contract or spot token, so this is the source the stock analyzer reads.
 *
 * It is an unofficial endpoint: it can change or rate-limit, so everything is cached and every failure is reported
 * as a normal error instead of breaking the page.
 */

const CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
const SEARCH_URL = "https://query1.finance.yahoo.com/v1/finance/search";
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; TradingTerminal/1.0)", Accept: "application/json" };
const PLAIN_HEADERS = { "User-Agent": HEADERS["User-Agent"] }; // the crumb endpoint answers 406 to an Accept header
const TIMEOUT_MS = 15_000;
const SUMMARY_URL = "https://query2.finance.yahoo.com/v10/finance/quoteSummary";
const COOKIE_URL = "https://fc.yahoo.com/";
const CRUMB_URL = "https://query1.finance.yahoo.com/v1/test/getcrumb";
const MODULES = ["price", "assetProfile", "summaryDetail", "defaultKeyStatistics", "financialData", "calendarEvents", "recommendationTrend", "incomeStatementHistory", "fundProfile", "topHoldings"].join(",");
const COMPANY_TTL_MS = 6 * 3600_000;
const SESSION_TTL_MS = 50 * 60_000;
const HISTORY_TTL_MS = 30 * 60_000;
const SEARCH_TTL_MS = 10 * 60_000;

/** Binance writes BRK.B, Yahoo writes BRK-B. */
export const toYahooSymbol = (symbol) => symbol.replace(/\./g, "-");
export const fromYahooSymbol = (symbol) => symbol.replace(/-/g, ".");

/** Yahoo chart JSON -> `{symbol, name, ..., candles: [[ms, open, high, low, close, volume], ...]}`, gaps removed. */
export function parseChart(json, symbol) {
  const result = json?.chart?.result?.[0];
  if (!result?.timestamp?.length) {
    const reason = json?.chart?.error?.description;
    throw new Error(reason ? `No price history for ${symbol}: ${reason}` : `No price history found for ${symbol}`);
  }
  const q = result.indicators?.quote?.[0] ?? {};
  const candles = [];
  result.timestamp.forEach((t, i) => {
    const bar = [q.open?.[i], q.high?.[i], q.low?.[i], q.close?.[i]];
    if (bar.some((v) => v == null || !Number.isFinite(v))) return;
    candles.push([t * 1000, ...bar, q.volume?.[i] ?? 0]);
  });
  if (candles.length < 2) throw new Error(`No usable price history for ${symbol}`);
  const meta = result.meta ?? {};
  return {
    symbol,
    name: meta.longName ?? meta.shortName ?? null,
    currency: meta.currency ?? null,
    exchange: meta.fullExchangeName ?? meta.exchangeName ?? null,
    type: meta.instrumentType ?? null,
    price: meta.regularMarketPrice ?? candles[candles.length - 1][4],
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null,
    fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? null,
    candles,
  };
}

/** Yahoo search JSON -> stocks and ETFs only (no futures, currencies or foreign listings), Binance-style tickers. */
export function parseSearch(json) {
  return (json?.quotes ?? [])
    .filter((q) => (q.quoteType === "EQUITY" || q.quoteType === "ETF") && q.symbol && !/[.=^]/.test(q.symbol.replace(/-/g, "")))
    .map((q) => ({ symbol: fromYahooSymbol(q.symbol), name: q.longname ?? q.shortname ?? null, type: q.quoteType, exchange: q.exchDisp ?? null }));
}

/** Yahoo wraps numbers as {raw, fmt}; empty objects mean "no value". */
const raw = (v) => (v && typeof v === "object" ? (Number.isFinite(v.raw) ? v.raw : null) : Number.isFinite(v) ? v : null);

/**
 * Yahoo quoteSummary JSON -> one flat object for the company analysis. `kind` is "fund" for ETFs and funds
 * (which report costs and holdings instead of financials) and "company" otherwise. Missing figures stay null.
 */
export function parseCompany(json, symbol) {
  const r = json?.quoteSummary?.result?.[0];
  if (!r) {
    const reason = json?.quoteSummary?.error?.description;
    throw new Error(reason ? `No company data for ${symbol}: ${reason}` : `No company data found for ${symbol}`);
  }
  const price = r.price ?? {};
  const profile = r.assetProfile ?? {};
  const detail = r.summaryDetail ?? {};
  const stats = r.defaultKeyStatistics ?? {};
  const fin = r.financialData ?? {};
  const trend = (r.recommendationTrend?.trend ?? [])[0] ?? {};
  const isFund = /ETF|MUTUALFUND/i.test(price.quoteType ?? "") || Boolean(r.fundProfile && Object.keys(r.fundProfile).length);
  const earningsDate = (r.calendarEvents?.earnings?.earningsDate ?? []).map((d) => raw(d)).filter(Boolean).sort((a, b) => a - b)[0];
  const exDividend = raw(r.calendarEvents?.exDividendDate);
  const statements = (r.incomeStatementHistory?.incomeStatementHistory ?? []).map((y) => ({
    year: y.endDate?.raw ? new Date(y.endDate.raw * 1000).getUTCFullYear() : null,
    revenue: raw(y.totalRevenue),
    grossProfit: raw(y.grossProfit),
    netIncome: raw(y.netIncome),
  })).filter((y) => y.year);
  const fees = r.fundProfile?.feesExpensesInvestment ?? {};

  return {
    symbol,
    kind: isFund ? "fund" : "company",
    profile: {
      name: price.longName ?? price.shortName ?? null,
      sector: profile.sector ?? null,
      industry: profile.industry ?? null,
      employees: raw(profile.fullTimeEmployees),
      website: profile.website ?? null,
      country: profile.country ?? null,
      summary: profile.longBusinessSummary ?? null,
    },
    valuation: {
      marketCap: raw(price.marketCap) ?? raw(detail.marketCap),
      trailingPE: raw(detail.trailingPE),
      forwardPE: raw(detail.forwardPE) ?? raw(stats.forwardPE),
      pegRatio: raw(stats.pegRatio),
      priceToBook: raw(stats.priceToBook),
      priceToSales: raw(detail.priceToSalesTrailing12Months),
      beta: raw(detail.beta) ?? raw(stats.beta),
      eps: raw(stats.trailingEps),
      dividendYield: raw(detail.dividendYield),
      shortPercentOfFloat: raw(stats.shortPercentOfFloat),
      heldByInsiders: raw(stats.heldPercentInsiders),
      heldByInstitutions: raw(stats.heldPercentInstitutions),
    },
    growth: { revenueGrowth: raw(fin.revenueGrowth), earningsGrowth: raw(fin.earningsGrowth), revenue: raw(fin.totalRevenue) },
    profitability: {
      grossMargins: raw(fin.grossMargins),
      operatingMargins: raw(fin.operatingMargins),
      profitMargins: raw(fin.profitMargins),
      returnOnEquity: raw(fin.returnOnEquity),
      returnOnAssets: raw(fin.returnOnAssets),
      ebitda: raw(fin.ebitda),
    },
    health: {
      totalCash: raw(fin.totalCash),
      totalDebt: raw(fin.totalDebt),
      debtToEquity: raw(fin.debtToEquity),
      currentRatio: raw(fin.currentRatio),
      freeCashflow: raw(fin.freeCashflow),
      operatingCashflow: raw(fin.operatingCashflow),
    },
    analysts: {
      targetMean: raw(fin.targetMeanPrice),
      targetLow: raw(fin.targetLowPrice),
      targetHigh: raw(fin.targetHighPrice),
      recommendation: fin.recommendationKey && fin.recommendationKey !== "none" ? fin.recommendationKey : null,
      count: raw(fin.numberOfAnalystOpinions),
      trend: { strongBuy: trend.strongBuy ?? 0, buy: trend.buy ?? 0, hold: trend.hold ?? 0, sell: trend.sell ?? 0, strongSell: trend.strongSell ?? 0 },
    },
    events: { nextEarnings: earningsDate ? earningsDate * 1000 : null, exDividendDate: exDividend ? exDividend * 1000 : null },
    history: statements,
    fund: isFund ? {
      category: r.fundProfile?.categoryName ?? null,
      family: r.fundProfile?.family ?? null,
      expenseRatio: raw(fees.annualReportExpenseRatio),
      totalAssets: raw(detail.totalAssets),
      yield: raw(detail.yield),
      topHoldings: (r.topHoldings?.holdings ?? []).map((h) => ({ symbol: h.symbol ?? null, name: h.holdingName ?? null, weight: raw(h.holdingPercent) })),
    } : null,
  };
}

export function createStockData({ fetchFn = fetch, now = Date.now } = {}) {
  const cache = new Map();
  const cached = (key, ttl, load) => {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttl) return hit.value;
    const value = Promise.resolve().then(load);
    cache.set(key, { at: now(), value });
    value.catch(() => cache.get(key)?.value === value && cache.delete(key)); // failures are not cached
    return value;
  };

  async function getJson(url) {
    let response;
    try {
      response = await fetchFn(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new Error(err.name === "TimeoutError" ? "The price history service timed out" : `Could not reach the price history service (${err.cause?.code || err.message})`);
    }
    if (response.status === 404) return { chart: { error: { description: "not found" } } };
    if (response.status === 429) throw new Error("The price history service is rate limiting requests: try again in a minute");
    if (!response.ok) throw new Error(`The price history service answered ${response.status}`);
    return response.json();
  }

  // Yahoo's fundamentals need a session cookie and a "crumb" taken with it.
  let session = null;
  async function getSession(force = false) {
    if (!force && session && now() - session.at < SESSION_TTL_MS) return session;
    const first = await fetchFn(COOKIE_URL, { headers: PLAIN_HEADERS, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const setCookies = first.headers.getSetCookie?.() ?? [first.headers.get("set-cookie")].filter(Boolean);
    const cookie = setCookies.map((c) => c.split(";")[0]).join("; ");
    if (!cookie) throw new Error("The company data service did not start a session");
    const res = await fetchFn(CRUMB_URL, { headers: { ...PLAIN_HEADERS, Cookie: cookie }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const crumb = (await res.text()).trim();
    if (!res.ok || !crumb || /[<{\s]/.test(crumb)) throw new Error("The company data service refused a session (try again in a minute)");
    session = { cookie, crumb, at: now() };
    return session;
  }

  async function getSummary(symbol) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { cookie, crumb } = await getSession(attempt > 0);
      let response;
      try {
        response = await fetchFn(`${SUMMARY_URL}/${encodeURIComponent(toYahooSymbol(symbol))}?modules=${MODULES}&crumb=${encodeURIComponent(crumb)}`, {
          headers: { ...PLAIN_HEADERS, Cookie: cookie },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        throw new Error(err.name === "TimeoutError" ? "The company data service timed out" : `Could not reach the company data service (${err.cause?.code || err.message})`);
      }
      if ((response.status === 401 || response.status === 403) && attempt === 0) continue; // stale session: start a new one
      if (response.status === 404) return { quoteSummary: { error: { description: "not found" } } };
      if (response.status === 429) throw new Error("The company data service is rate limiting requests: try again in a minute");
      if (!response.ok) throw new Error(`The company data service answered ${response.status}`);
      return response.json();
    }
    throw new Error("The company data service refused the request");
  }

  return {
    /** Company profile, valuation, growth, margins, debt, analyst targets and earnings date (or fund facts for an ETF). */
    company: (symbol) => cached(`company:${symbol}`, COMPANY_TTL_MS, async () => parseCompany(await getSummary(symbol), symbol)),
    /** Two years of daily candles plus name and 52-week range. */
    daily: (symbol) => cached(`daily:${symbol}`, HISTORY_TTL_MS, async () =>
      parseChart(await getJson(`${CHART_URL}/${encodeURIComponent(toYahooSymbol(symbol))}?range=2y&interval=1d`), symbol)),
    /** Companies whose name or ticker matches; the caller keeps only those Binance lists. */
    search: (query) => cached(`search:${query.toLowerCase()}`, SEARCH_TTL_MS, async () =>
      parseSearch(await getJson(`${SEARCH_URL}?q=${encodeURIComponent(query)}&quotesCount=25&newsCount=0`))),
  };
}
