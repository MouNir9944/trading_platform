import { useEffect, useMemo, useRef, useState } from "react";
import { CandlestickSeries, ColorType, HistogramSeries, LineSeries, createChart } from "lightweight-charts";

import { analyzeStock } from "../../shared/analysis/stock.js";
import { analyzeCompany, bigMoney, combinedRead } from "../../shared/analysis/company.js";
import { sma, toCandles } from "../../shared/analysis/index.js";
import { usePersistentState, oneOf } from "../lib/persist.js";
import { getStockCompany, getStockHistory, searchStocks } from "../api.js";

const money = (n, digits = 2) => (n == null || !Number.isFinite(Number(n)) ? "—" : `${Number(n) < 0 ? "−" : ""}${Math.abs(Number(n)).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`);
const signed = (n, digits = 1) => (n == null ? "—" : `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(digits)}%`);
const tone = (n) => (n == null ? "" : n >= 0 ? "profit-estimate" : "loss-estimate");
const pctOf = (x, d = 1) => (x == null ? "—" : `${(x * 100).toFixed(d)}%`);
const num = (x, d = 1) => (x == null ? "—" : Number(x).toFixed(d));
const CHART_GROUPS = ["Trend", "Momentum", "Relative strength", "Position", "Risk", "Structure"];
const COMPANY_GROUPS = ["Growth", "Profitability", "Financial health", "Valuation", "Analysts"];
const FUND_GROUPS = ["Fund"];

/** Daily candles with the 50 and 200 day averages. Static: a stock's history does not stream. */
function StockChart({ candles }) {
  const ref = useRef(null);
  useEffect(() => {
    const chart = createChart(ref.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "#0f141d" }, textColor: "#7c8aa3", fontFamily: "JetBrains Mono", fontSize: 11 },
      grid: { vertLines: { color: "#1a2231" }, horzLines: { color: "#1a2231" } },
      rightPriceScale: { borderColor: "#34415a", scaleMargins: { top: 0.08, bottom: 0.2 } },
      timeScale: { borderColor: "#34415a", rightOffset: 3, barSpacing: 6 },
    });
    const up = "#35c48c";
    const down = "#e8604c";
    const series = chart.addSeries(CandlestickSeries, { upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down });
    series.setData(candles);
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volume.setData(candles.map((c) => ({ time: c.time, value: c.volume, color: c.close >= c.open ? "rgba(53,196,140,0.3)" : "rgba(232,96,76,0.3)" })));
    const closes = candles.map((c) => c.close);
    for (const [period, color] of [[50, "#4c8dff"], [200, "#d9a441"]]) {
      const values = sma(closes, period);
      const line = chart.addSeries(LineSeries, { color, lineWidth: 1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
      line.setData(candles.map((c, i) => (values[i] == null ? null : { time: c.time, value: values[i] })).filter(Boolean));
    }
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, candles.length - 200), to: candles.length + 3 });
    return () => chart.remove();
  }, [candles]);
  return <div ref={ref} className="stock-chart" />;
}

/** Points earned per group, with a bar and the reason behind every line. */
function FactorGroups({ factors, groups }) {
  return (
    <div className="sa-factors">
      {groups.map((group) => {
        const rows = factors.filter((f) => f.group === group);
        if (!rows.length) return null;
        const got = rows.reduce((s, f) => s + f.points, 0);
        const max = rows.reduce((s, f) => s + f.max, 0);
        return (
          <div className="sa-group" key={group}>
            <div className="sa-group-head"><strong>{group}</strong><span>{got} / {max}</span></div>
            <div className="sa-bar"><i style={{ width: `${(got / max) * 100}%` }} className={got >= max * 0.66 ? "good" : got >= max * 0.33 ? "mixed" : "bad"} /></div>
            {rows.map((f) => (
              <p key={f.label} className={`sa-factor is-${f.tone}`}><b>{f.tone === "good" ? "✓" : f.tone === "bad" ? "✗" : "•"}</b> <span>{f.note}</span></p>
            ))}
          </div>
        );
      })}
    </div>
  );
}

const Figure = ({ label, value, hint }) => (
  <div title={hint}><span>{label}</span><b>{value}</b></div>
);

/** Revenue and net income, year by year, as bars. */
function YearBars({ history }) {
  const years = [...history].filter((y) => y.revenue != null).sort((a, b) => a.year - b.year);
  if (years.length < 2) return null;
  const max = Math.max(...years.map((y) => y.revenue), 1);
  return (
    <div className="sa-years">
      <p className="sa-sub">Revenue and net profit by year</p>
      {years.map((y) => (
        <div className="sa-year" key={y.year}>
          <span>{y.year}</span>
          <div className="sa-year-bars">
            <i className="rev" style={{ width: `${Math.max(1, (y.revenue / max) * 100)}%` }} />
            {y.netIncome != null && <i className={y.netIncome >= 0 ? "profit" : "loss"} style={{ width: `${Math.max(1, (Math.abs(y.netIncome) / max) * 100)}%` }} />}
          </div>
          <em>{bigMoney(y.revenue)} <small className={tone(y.netIncome)}>{bigMoney(y.netIncome)}</small></em>
        </div>
      ))}
      <p className="sa-legend"><i style={{ background: "#4c8dff" }} />revenue <i style={{ background: "#35c48c" }} />net profit (red when a loss)</p>
    </div>
  );
}

/** Where the analysts' targets sit against the price, and how the ratings split. */
function AnalystView({ analysts, price }) {
  const { targetLow, targetMean, targetHigh, count, trend } = analysts;
  const total = Object.values(trend ?? {}).reduce((s, x) => s + x, 0);
  if (!(count >= 1) && !total) return <p className="an-hint">No analyst coverage found.</p>;
  const lo = Math.min(targetLow ?? price, price) * 0.97;
  const hi = Math.max(targetHigh ?? price, price) * 1.03;
  const at = (x) => `${((x - lo) / (hi - lo)) * 100}%`;
  return (
    <div className="sa-analysts">
      <p className="sa-sub">Analysts ({count ?? total} covering)</p>
      {targetLow != null && targetHigh != null && (
        <div className="sa-target">
          <div className="sa-target-line">
            <i className="range" style={{ left: at(targetLow), width: `${((targetHigh - targetLow) / (hi - lo)) * 100}%` }} />
            {targetMean != null && <i className="mean" style={{ left: at(targetMean) }} title={`Average target ${money(targetMean)}`} />}
            <i className="price" style={{ left: at(price) }} title={`Price ${money(price)}`} />
          </div>
          <div className="sa-target-labels"><span>low {money(targetLow)}</span><span>average {money(targetMean)}</span><span>high {money(targetHigh)}</span></div>
        </div>
      )}
      {total > 0 && (
        <div className="sa-ratings" title="Strong buy, buy, hold, sell, strong sell">
          {[["strongBuy", "Strong buy", "#35c48c"], ["buy", "Buy", "#7be0b5"], ["hold", "Hold", "#7c8aa3"], ["sell", "Sell", "#f59a8d"], ["strongSell", "Strong sell", "#e8604c"]].map(([key, label, color]) => (
            trend[key] > 0 ? <span key={key} style={{ flexGrow: trend[key], background: color }} title={`${label}: ${trend[key]}`}>{trend[key]}</span> : null
          ))}
        </div>
      )}
      {total > 0 && (
        <p className="sa-rating-text">
          {[["strongBuy", "Strong buy"], ["buy", "Buy"], ["hold", "Hold"], ["sell", "Sell"], ["strongSell", "Strong sell"]].filter(([k]) => trend[k] > 0).map(([k, l]) => `${l} ${trend[k]}`).join(" · ")}
        </p>
      )}
      <p className="sa-legend"><span className="sa-mark price" />price <span className="sa-mark mean" />average analyst target <span className="sa-mark range" />target range</p>
    </div>
  );
}

function CompanyTab({ company, analysis, price }) {
  const [more, setMore] = useState(false);
  const p = company.profile;
  const v = company.valuation;
  const g = company.growth;
  const pr = company.profitability;
  const h = company.health;
  const fund = company.fund;
  const summary = p.summary ?? "";
  return (
    <div className="sa-company">
      <div className="sa-about">
        <p className="sa-meta">
          {[p.sector ?? fund?.category, p.industry ?? fund?.family, p.country, p.employees ? `${Number(p.employees).toLocaleString()} employees` : null].filter(Boolean).join(" · ")}
          {p.website ? <> · <a href={p.website} target="_blank" rel="noreferrer">{p.website.replace(/^https?:\/\/(www\.)?/, "")}</a></> : null}
        </p>
        {summary && (
          <p className="sa-summary">
            {more || summary.length < 320 ? summary : `${summary.slice(0, 320)}…`}{" "}
            {summary.length >= 320 && <button type="button" className="link-button" onClick={() => setMore((x) => !x)}>{more ? "less" : "more"}</button>}
          </p>
        )}
      </div>

      <div className={`sa-verdict is-${analysis.verdict.tone}`}>
        <div className="sa-verdict-row">
          <strong>{analysis.verdict.label}</strong>
          {analysis.score != null && <span className={`sa-score-inline is-${analysis.verdict.tone}`}>{analysis.score} / 100</span>}
        </div>
        <p>{analysis.verdict.summary}</p>
      </div>

      {company.kind === "company" ? (
        <>
          <div className="sa-stats">
            <Figure label="Market cap" value={bigMoney(v.marketCap)} />
            <Figure label="P/E (trailing)" value={num(v.trailingPE)} hint="Price divided by the last 12 months of earnings per share" />
            <Figure label="P/E (expected)" value={num(v.forwardPE)} hint="Price divided by analysts' expected earnings per share" />
            <Figure label="PEG" value={num(v.pegRatio, 2)} hint="P/E divided by growth: around 1 is often called fair" />
            <Figure label="Revenue growth" value={pctOf(g.revenueGrowth)} hint="Compared with the same quarter a year ago" />
            <Figure label="Earnings growth" value={pctOf(g.earningsGrowth)} />
            <Figure label="Net margin" value={pctOf(pr.profitMargins)} hint="Profit as a share of revenue" />
            <Figure label="Operating margin" value={pctOf(pr.operatingMargins)} />
            <Figure label="Return on equity" value={pctOf(pr.returnOnEquity, 0)} />
            <Figure label="Free cash flow" value={bigMoney(h.freeCashflow)} hint="Cash left after running and investing in the business" />
            <Figure label="Cash / debt" value={`${bigMoney(h.totalCash)} / ${bigMoney(h.totalDebt)}`} />
            <Figure label="Debt / equity" value={h.debtToEquity == null ? "—" : `${h.debtToEquity.toFixed(0)}%`} />
            <Figure label="Price / sales" value={num(v.priceToSales)} />
            <Figure label="Dividend yield" value={v.dividendYield ? pctOf(v.dividendYield, 2) : "none"} />
            <Figure label="Beta" value={num(v.beta, 2)} hint="How much it moves against the market: above 1 is more volatile" />
            <Figure label="Earnings per share" value={num(v.eps, 2)} />
          </div>
          {company.events.nextEarnings && <p className="sa-event">Next earnings report: <b>{new Date(company.events.nextEarnings).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}</b> (an estimate)</p>}
          <YearBars history={company.history} />
          <AnalystView analysts={company.analysts} price={price} />
        </>
      ) : (
        <>
          <div className="sa-stats">
            <Figure label="Category" value={fund?.category ?? "—"} />
            <Figure label="Manager" value={fund?.family ?? "—"} />
            <Figure label="Yearly cost" value={fund?.expenseRatio == null ? "—" : pctOf(fund.expenseRatio, 2)} />
            <Figure label="Assets" value={bigMoney(fund?.totalAssets)} />
            <Figure label="Yield" value={fund?.yield ? pctOf(fund.yield, 2) : "none"} />
            <Figure label="Beta" value={num(v.beta, 2)} />
          </div>
          {fund?.topHoldings?.length > 0 && (
            <div className="sa-holdings">
              <p className="sa-sub">Top holdings</p>
              {fund.topHoldings.slice(0, 10).map((x) => (
                <div className="sa-holding" key={`${x.symbol}-${x.name}`}>
                  <span>{x.symbol ?? "—"} <small>{x.name ?? ""}</small></span>
                  <i style={{ width: `${Math.min(100, (x.weight ?? 0) * 100 * 4)}%` }} />
                  <b>{pctOf(x.weight)}</b>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <FactorGroups factors={analysis.factors} groups={company.kind === "fund" ? FUND_GROUPS : COMPANY_GROUPS} />
      {analysis.flags.length > 0 && <ul className="sa-warnings">{analysis.flags.map((w) => <li key={w}>{w}</li>)}</ul>}
    </div>
  );
}

/**
 * Find any stock or ETF listed on Binance (by ticker or company name) and read two analyses of it: the chart
 * (trend, momentum, risk) and the company (growth, profitability, debt, valuation, analysts), plus a combined read.
 * Data comes from Yahoo Finance: daily prices and reported figures.
 */
export default function StockResearch({ symbol, onPick, holdings = [] }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [history, setHistory] = useState(null);
  const [company, setCompany] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [companyError, setCompanyError] = useState(null);
  const [tab, setTab] = usePersistentState("pref:stock-research-tab", "chart", oneOf(["chart", "company"]));
  const rootRef = useRef(null);

  // search as you type (debounced); an empty box shows popular tickers
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setSearching(true);
    const id = window.setTimeout(() => {
      searchStocks(query.trim())
        .then((data) => { if (!cancelled) setResults(data.results ?? []); })
        .catch(() => { if (!cancelled) setResults([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, query ? 300 : 0);
    return () => { cancelled = true; window.clearTimeout(id); };
  }, [query, open]);

  useEffect(() => {
    if (!open) return undefined;
    const down = (e) => { if (!rootRef.current?.contains(e.target)) setOpen(false); };
    const key = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); window.removeEventListener("keydown", key); };
  }, [open]);

  // the chart data and the company data load side by side: one failing must not hide the other
  useEffect(() => {
    if (!symbol) { setHistory(null); setCompany(null); return undefined; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setCompanyError(null);
    setHistory(null);
    setCompany(null);
    let pending = 2;
    const done = () => { pending -= 1; if (!cancelled && pending === 0) setLoading(false); };
    getStockHistory(symbol)
      .then((data) => { if (!cancelled) setHistory(data); })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(done);
    getStockCompany(symbol)
      .then((data) => { if (!cancelled) setCompany(data); })
      .catch((err) => { if (!cancelled) setCompanyError(err.message); })
      .finally(done);
    return () => { cancelled = true; };
  }, [symbol]);

  const candles = useMemo(() => (history ? toCandles(history.candles) : null), [history]);
  const analysis = useMemo(() => (candles ? analyzeStock(candles, { benchmark: history.benchmark ? toCandles(history.benchmark.candles) : null }) : null), [candles, history]);
  const price = analysis?.ok ? analysis.stats.price : history?.price ?? null;
  const companyAnalysis = useMemo(() => (company ? analyzeCompany(company, { price }) : null), [company, price]);
  const combined = useMemo(() => (analysis && companyAnalysis ? combinedRead(analysis, companyAnalysis) : null), [analysis, companyAnalysis]);
  const held = holdings.find((h) => h.symbol === symbol);
  const name = history?.name ?? company?.profile?.name ?? null;

  const pick = (next) => { setOpen(false); setQuery(""); setTab("chart"); onPick(next); };
  const submit = () => { if (results[0]) pick(results[0].symbol); };
  const ready = symbol && (history || company);

  return (
    <section className="panel stock-research">
      <div className="panel-heading">
        <div>
          <p className="panel-title">Research a stock</p>
          <p className="panel-subtitle">Search every stock and ETF on Binance: the chart, and the company behind it</p>
        </div>
      </div>

      <div className="stock-search" ref={rootRef}>
        <input
          type="search"
          value={query}
          placeholder="Search by ticker or company (AAPL, apple, gold, semiconductor…)"
          onFocus={() => setOpen(true)}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          autoComplete="off"
          spellCheck={false}
          aria-label="Search stocks"
        />
        {open && (
          <div className="stock-results" role="listbox">
            <p className="cpm-note">{query ? (searching ? "Searching…" : `${results.length} match${results.length === 1 ? "" : "es"} on Binance Stocks`) : "Popular on Binance Stocks · about 7,900 tickers are listed"}</p>
            {results.map((r) => (
              <button type="button" role="option" aria-selected={r.symbol === symbol} key={r.symbol} className={`stock-result${r.symbol === symbol ? " is-current" : ""}`} onClick={() => pick(r.symbol)}>
                <strong>{r.symbol}</strong>
                <span className="stock-result-name">{r.name ?? ""}</span>
                {r.type === "ETF" && <i className="cat-badge cat-other">ETF</i>}
                {!String(r.tradability).includes("BUY") && <i className="cat-badge cat-commodity">{r.tradability === "SELL" ? "sell only" : "closed"}</i>}
              </button>
            ))}
            {!searching && query && results.length === 0 && <p className="cpm-note">Nothing on Binance Stocks matches “{query}”. Try the ticker.</p>}
          </div>
        )}
      </div>

      {!symbol && <p className="log-empty">Pick a stock to see its analysis. Holdings have an Analyze button too.</p>}
      {symbol && loading && !ready && <p className="log-empty">Reading {symbol}'s prices and company figures…</p>}
      {symbol && !loading && !ready && (
        <>
          {error && <p className="order-error">{error}</p>}
          {companyError && <p className="order-error">{companyError}</p>}
        </>
      )}

      {ready && (
        <div className="stock-analysis">
          <div className="sa-head">
            <div>
              <h3>{symbol}{name ? <span> · {name}</span> : null}</h3>
              <p className="sa-meta">{history?.exchange ?? ""}{history?.type ? ` · ${history.type}` : ""}{price != null ? ` · ${money(price)} USD` : ""}{held ? ` · you hold ${held.quantity.toFixed(4)}` : ""}</p>
            </div>
            <div className="sa-scores">
              {analysis?.ok && <div className={`sa-score is-${analysis.verdict.tone}`} title="Chart score: trend, momentum, position, risk"><small>Chart</small><b>{analysis.score}</b></div>}
              {companyAnalysis?.ok && companyAnalysis.score != null && <div className={`sa-score is-${companyAnalysis.verdict.tone}`} title="Company score: growth, profitability, financial health, valuation, analysts"><small>Company</small><b>{companyAnalysis.score}</b></div>}
            </div>
          </div>

          {combined && <p className="sa-combined">{combined}</p>}

          <div className="sa-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "chart"} className={tab === "chart" ? "is-active" : ""} onClick={() => setTab("chart")}>Chart analysis</button>
            <button type="button" role="tab" aria-selected={tab === "company"} className={tab === "company" ? "is-active" : ""} onClick={() => setTab("company")}>{company?.kind === "fund" ? "Fund analysis" : "Company analysis"}</button>
          </div>

          {tab === "chart" && (
            <>
              {error && <p className="order-error">{error}</p>}
              {analysis && !analysis.ok && <p className="order-error">{analysis.reason}</p>}
              {analysis?.ok && (
                <>
                  <div className={`sa-verdict is-${analysis.verdict.tone}`}>
                    <strong>{analysis.verdict.label}</strong>
                    <p>{analysis.verdict.summary}</p>
                  </div>
                  <StockChart candles={candles} />
                  <p className="sa-legend"><i style={{ background: "#4c8dff" }} />50-day average <i style={{ background: "#d9a441" }} />200-day average · daily candles</p>
                  <div className="sa-stats">
                    <Figure label="1 month" value={<span className={tone(analysis.stats.ret1m)}>{signed(analysis.stats.ret1m)}</span>} />
                    <Figure label="3 months" value={<span className={tone(analysis.stats.ret3m)}>{signed(analysis.stats.ret3m)}</span>} />
                    <Figure label="6 months" value={<span className={tone(analysis.stats.ret6m)}>{signed(analysis.stats.ret6m)}</span>} />
                    <Figure label="1 year" value={<span className={tone(analysis.stats.ret1y)}>{signed(analysis.stats.ret1y)}</span>} />
                    <Figure label="From 52w high" value={signed(analysis.stats.fromHigh)} />
                    <Figure label="RSI" value={analysis.stats.rsi ?? "—"} />
                    <Figure label="Volatility" value={analysis.stats.volatility == null ? "—" : `${analysis.stats.volatility}%`} />
                    <Figure label="S&P 500, 3 mo" value={signed(analysis.stats.benchmark3m)} />
                  </div>
                  <FactorGroups factors={analysis.factors} groups={CHART_GROUPS} />
                  <div className="sa-plan">
                    <strong>If you buy: a plan on the numbers</strong>
                    <div className="sa-plan-grid">
                      <div><span>Price</span><b>{money(analysis.plan.entry)}</b></div>
                      <div><span>Stop</span><b className="loss-estimate">{money(analysis.plan.stop)} <em>({analysis.plan.stopPct}%)</em></b></div>
                      <div><span>Target 2:1</span><b className="profit-estimate">{money(analysis.plan.target)} <em>(+{analysis.plan.targetPct}%)</em></b></div>
                      <div><span>52-week high</span><b>{money(analysis.levels.high52)}</b></div>
                      <div><span>50-day avg</span><b>{money(analysis.levels.sma50)}</b></div>
                      <div><span>200-day avg</span><b>{money(analysis.levels.sma200)}</b></div>
                    </div>
                    <p className="an-hint">{analysis.plan.note}</p>
                  </div>
                  {analysis.warnings.length > 0 && <ul className="sa-warnings">{analysis.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
                </>
              )}
            </>
          )}

          {tab === "company" && (
            <>
              {companyError && <p className="order-error">{companyError}</p>}
              {company && companyAnalysis?.ok && <CompanyTab company={company} analysis={companyAnalysis} price={price} />}
              {!company && !companyError && <p className="log-empty">Loading company figures…</p>}
            </>
          )}

          <p className="order-rule-note">
            Two readings of published data (prices and reported figures from Yahoo Finance). They cannot see the company's products, competition, management or the news,
            and a stock with good numbers and a good chart can still fall. This is a way to organise your thinking, not advice to buy or sell.
          </p>
        </div>
      )}
    </section>
  );
}
