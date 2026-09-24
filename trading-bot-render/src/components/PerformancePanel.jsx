import { useEffect, useMemo, useState } from "react";

import { getFuturesOrders, getOrders, getStockPerformance } from "../api.js";
import { performanceReport } from "../../shared/analysis/performance.js";
import { oneOf, usePersistentState } from "../lib/persist.js";
import PnlBars from "./PnlBars.jsx";

const PERIODS = [["7", "7D"], ["30", "30D"], ["90", "90D"], ["365", "1Y"], ["all", "All"]];

const signed = (n, digits = 2) => (n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(digits)}`);
const tone = (n) => (n == null || n === 0 ? "" : n > 0 ? "profit-estimate" : "loss-estimate");
const dateLabel = (iso) => iso.slice(5).replace("-", "/"); // "2026-03-04" -> "03/04"

/** KPI tiles shared by the trading and stocks sections. */
function Summary({ summary }) {
  return (
    <div className="bt-kpis">
      <div className="bt-kpi"><span>Realized P/L</span><b className={tone(summary.total)}>{signed(summary.total)} USD</b><small>{summary.trades} closed trade{summary.trades === 1 ? "" : "s"}</small></div>
      <div className="bt-kpi"><span>Win rate</span><b>{summary.winRate == null ? "—" : `${summary.winRate.toFixed(0)}%`}</b><small>{summary.wins} win{summary.wins === 1 ? "" : "s"} · {summary.losses} loss{summary.losses === 1 ? "" : "es"}</small></div>
      <div className="bt-kpi"><span>Avg / trade</span><b className={tone(summary.avgPerTrade)}>{signed(summary.avgPerTrade)}</b><small>avg / day {signed(summary.avgPerDay)}</small></div>
      <div className="bt-kpi"><span>Best day</span><b className="profit-estimate">{summary.bestDay ? signed(summary.bestDay.pnl) : "—"}</b><small>{summary.bestDay?.date ?? "no closed trades yet"}</small></div>
      <div className="bt-kpi"><span>Worst day</span><b className="loss-estimate">{summary.worstDay ? signed(summary.worstDay.pnl) : "—"}</b><small>{summary.worstDay?.date ?? "no closed trades yet"}</small></div>
      <div className="bt-kpi"><span>Trading days</span><b>{summary.tradingDays}</b><small>{summary.bestWinStreakDays ? `best streak ${summary.bestWinStreakDays}d win` : "—"}</small></div>
      <div className="bt-kpi"><span>Current streak</span><b className={tone(summary.currentStreakDays)}>{summary.currentStreakDays === 0 ? "—" : `${Math.abs(summary.currentStreakDays)}d ${summary.currentStreakDays > 0 ? "winning" : "losing"}`}</b><small>worst run {summary.bestLossStreakDays}d losing</small></div>
    </div>
  );
}

/** Daily bars (with a period picker) and the full monthly history. */
function Charts({ daily, monthly, period, onPeriod }) {
  const shown = period === "all" ? daily : daily.slice(-Number(period));
  return (
    <>
      <div className="perf-chart-head">
        <p className="sa-sub">Daily P&amp;L</p>
        <div className="segmented segmented-small" role="group" aria-label="Period">
          {PERIODS.map(([id, label]) => <button key={id} type="button" className={period === id ? "is-active" : ""} onClick={() => onPeriod(id)}>{label}</button>)}
        </div>
      </div>
      <PnlBars rows={shown} labelOf={(r) => dateLabel(r.date)} formatValue={(n) => `${signed(n)} USD`} formatTitle={(r) => `${r.date}: ${signed(r.pnl)} USD · ${r.trades} trade${r.trades === 1 ? "" : "s"}`} />

      <p className="sa-sub" style={{ marginTop: 16 }}>Monthly P&amp;L</p>
      <PnlBars rows={monthly} labelOf={(r) => r.label.slice(0, 3)} formatValue={(n) => `${signed(n)} USD`} formatTitle={(r) => `${r.label}: ${signed(r.pnl)} USD · ${r.trades} trade${r.trades === 1 ? "" : "s"}`} />
    </>
  );
}

/** Realized P/L grouped by symbol, biggest movers first. */
function BySymbol({ trades, title }) {
  const rows = useMemo(() => {
    const bySymbol = new Map();
    for (const t of trades) {
      const row = bySymbol.get(t.symbol) ?? { symbol: t.symbol, pnl: 0, trades: 0, wins: 0 };
      row.pnl += t.pnl;
      row.trades += 1;
      if (t.pnl > 0) row.wins += 1;
      bySymbol.set(t.symbol, row);
    }
    return [...bySymbol.values()].sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl)).slice(0, 15);
  }, [trades]);
  if (!rows.length) return null;
  return (
    <>
      <p className="sa-sub" style={{ marginTop: 16 }}>{title}</p>
      <div className="bt-table" role="table">
        <div className="bt-row bt-head" role="row"><span>Symbol</span><span>Trades</span><span>Win</span><span>Realized P/L</span></div>
        {rows.map((r) => (
          <div className="bt-row" role="row" key={r.symbol}>
            <span><b>{r.symbol}</b></span>
            <span>{r.trades}</span>
            <span>{Math.round((r.wins / r.trades) * 100)}%</span>
            <span className={tone(r.pnl)}>{signed(r.pnl)} USD</span>
          </div>
        ))}
      </div>
    </>
  );
}

/** The most recently closed trades, newest first. */
function Recent({ trades, timeZone, marketLabel }) {
  const rows = [...trades].sort((a, b) => b.time - a.time).slice(0, 20);
  if (!rows.length) return null;
  return (
    <>
      <p className="sa-sub" style={{ marginTop: 16 }}>Recently closed</p>
      <div className="bt-table" role="table">
        <div className="bt-row bt-trades bt-head" role="row"><span>Closed</span><span>Symbol</span>{marketLabel && <span>Market</span>}<span>Result</span></div>
        {rows.map((t, i) => (
          <div className="bt-row bt-trades" role="row" key={`${t.symbol}-${t.time}-${i}`}>
            <span>{new Intl.DateTimeFormat(undefined, { timeZone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(t.time)}</span>
            <span>{t.symbol}</span>
            {marketLabel && <span>{t.market}</span>}
            <span className={tone(t.pnl)}>{signed(t.pnl)} USD</span>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- trading

function TradingPerformance({ mode, timeZone }) {
  const [market, setMarket] = usePersistentState("pref:perf-market", "all", oneOf(["all", "spot", "futures"]));
  const [period, setPeriod] = usePersistentState("pref:perf-period", "30", oneOf(PERIODS.map(([id]) => id)));
  const [trades, setTrades] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => Promise.all([getOrders(mode), getFuturesOrders(mode)])
      .then(([spot, futures]) => {
        if (cancelled) return;
        const closed = (orders, market) => orders.orders
          .filter((o) => o.status === "CLOSED" && Number.isFinite(o.realized_profit_usdt))
          .map((o) => ({ time: Date.parse(o.closed_at ?? o.updated_at ?? o.created_at), pnl: o.realized_profit_usdt, symbol: o.symbol, market }));
        setTrades([...closed(spot, "spot"), ...closed(futures, "futures")]);
        setError(null);
      })
      .catch((err) => cancelled || setError(err.message));
    load();
    const id = window.setInterval(load, 30_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [mode]);

  const filtered = useMemo(() => (trades ?? []).filter((t) => market === "all" || t.market === market), [trades, market]);
  const report = useMemo(() => performanceReport(filtered, { timeZone }), [filtered, timeZone]);

  if (error && !trades) return <div className="futures-notice is-error"><strong>Could not reach the server</strong><p>{error}</p></div>;
  if (!trades) return <p className="log-empty">Loading…</p>;

  return (
    <section className="panel">
      <div className="panel-heading">
        <div><p className="panel-title">Trading account · {mode === "live" ? "Live" : "Paper"}</p><p className="panel-subtitle">Spot and futures orders closed on this account, bucketed by day and month in your time zone</p></div>
        <div className="segmented" role="group" aria-label="Market">
          <button type="button" className={market === "all" ? "is-active" : ""} onClick={() => setMarket("all")}>All</button>
          <button type="button" className={market === "spot" ? "is-active" : ""} onClick={() => setMarket("spot")}>Spot</button>
          <button type="button" className={market === "futures" ? "is-active" : ""} onClick={() => setMarket("futures")}>Futures</button>
        </div>
      </div>
      {error && <p className="order-error">Could not refresh just now: {error}</p>}
      {filtered.length === 0 ? (
        <p className="log-empty">No closed {market === "all" ? "" : `${market} `}trades on the {mode} account yet. Realized profit and loss appears here once an order closes.</p>
      ) : (
        <>
          <Summary summary={report.summary} />
          <Charts daily={report.daily} monthly={report.monthly} period={period} onPeriod={setPeriod} />
          <BySymbol trades={filtered} title="By pair" />
          <Recent trades={filtered} timeZone={timeZone} marketLabel={market === "all"} />
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- stocks

function StocksPerformance({ timeZone }) {
  const [period, setPeriod] = usePersistentState("pref:perf-stock-period", "30", oneOf(PERIODS.map(([id]) => id)));
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => getStockPerformance()
      .then((d) => { if (!cancelled) { setData(d); setError(null); } })
      .catch((err) => cancelled || setError(err.message));
    load();
    const id = window.setInterval(load, 60_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  const report = useMemo(() => performanceReport(data?.events ?? [], { timeZone }), [data, timeZone]);

  if (error && !data) return <div className="futures-notice is-error"><strong>Could not reach the server</strong><p>{error}</p></div>;
  if (!data) return <p className="log-empty">Loading…</p>;

  return (
    <section className="panel">
      <div className="panel-heading">
        <div><p className="panel-title">Stocks account</p><p className="panel-subtitle">Realized profit and loss from Binance Stocks, bucketed by day and month in your time zone · live account only</p></div>
      </div>
      {error && <p className="order-error">Could not refresh just now: {error}</p>}
      {data.events.length === 0 ? (
        <p className="log-empty">No closed (sold) stock positions yet. This account has {data.tradeCount} recorded trade{data.tradeCount === 1 ? "" : "s"} in total, all still held.</p>
      ) : (
        <>
          <Summary summary={report.summary} />
          <Charts daily={report.daily} monthly={report.monthly} period={period} onPeriod={setPeriod} />
          <BySymbol trades={data.events} title="By stock" />
          <Recent trades={data.events} timeZone={timeZone} />
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- the screen

export default function PerformancePanel({ mode, timeZone = "UTC" }) {
  const [tab, setTab] = usePersistentState("pref:performance-tab", "trading", oneOf(["trading", "stocks"]));
  return (
    <div className="amdbot-view">
      <div className="amdbot-head">
        <div>
          <h2>Performance</h2>
          <p>How the account has actually done: realized profit and loss by day and by month, for trading and for stocks.</p>
        </div>
        <div className="segmented" role="tablist" aria-label="Account">
          <button type="button" role="tab" aria-selected={tab === "trading"} className={tab === "trading" ? "is-active" : ""} onClick={() => setTab("trading")}>Trading</button>
          <button type="button" role="tab" aria-selected={tab === "stocks"} className={tab === "stocks" ? "is-active" : ""} onClick={() => setTab("stocks")}>Stocks</button>
        </div>
      </div>
      {tab === "trading" && <TradingPerformance mode={mode} timeZone={timeZone} />}
      {tab === "stocks" && <StocksPerformance timeZone={timeZone} />}
    </div>
  );
}
