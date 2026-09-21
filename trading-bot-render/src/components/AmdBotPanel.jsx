import { useEffect, useMemo, useRef, useState } from "react";
import { ColorType, LineSeries, createChart } from "lightweight-charts";

import { getAmdLog, getAmdStatus, putAmdConfig, runAmdBacktest, scanAmdNow, sendTestNotification } from "../api.js";
import { PERMISSION_HELP } from "./NotificationCenter.jsx";
import { audioState, desktopPermission, playChime, primeAudio, requestDesktop, showDesktop } from "../lib/amdAlerts.js";
import { usePersistentState, oneOf } from "../lib/persist.js";

const INTERVALS = ["5m", "15m", "30m", "1h", "2h", "4h"];
const PRESET_PAIRS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "LINKUSDT", "AVAXUSDT", "TSLAUSDT"];
const FORM_KEY = "amd-backtest-form";

const r2 = (n, d = 2) => (n == null || !Number.isFinite(n) ? "—" : n.toFixed(d));
const signedR = (n) => (n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}R`);
const signedPct = (n, d = 1) => (n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(d)}%`);
const tone = (n) => (n == null ? "" : n >= 0 ? "profit-estimate" : "loss-estimate");
const pf = (stats) => (stats.trades === 0 ? "—" : stats.profitFactor == null || stats.profitFactor === Infinity ? "∞" : stats.profitFactor.toFixed(2));
const when = (sec, timeZone) => new Intl.DateTimeFormat(undefined, { timeZone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(sec * 1000);
const ago = (ms, now) => (ms ? `${Math.max(0, Math.round((now - ms) / 60_000))} min ago` : "not yet");

const FORM_DEFAULTS = {
  market: "futures", symbols: PRESET_PAIRS, interval: "15m", candles: 3000,
  entryMode: "limit-close", targetMode: "range", targetR: 2, expiryCandles: 3, minRewardRisk: 1,
  minRangeBars: 10, maxRangeAtr: 3.5, riskPerTradePct: 1, longs: true, shorts: true, sweep: true,
};

function loadForm() {
  try { return { ...FORM_DEFAULTS, ...JSON.parse(window.localStorage.getItem(FORM_KEY) ?? "{}") }; } catch { return { ...FORM_DEFAULTS }; }
}

/** The request body for a backtest, from the form. */
export function backtestBody(f) {
  return {
    market: f.market, symbols: f.symbols, interval: f.interval, candles: Number(f.candles), sweep: f.sweep, riskPerTradePct: Number(f.riskPerTradePct),
    engine: { minRangeBars: Number(f.minRangeBars), maxRangeAtr: Number(f.maxRangeAtr), minRewardRisk: Number(f.minRewardRisk) },
    trade: { entryMode: f.entryMode, targetMode: f.targetMode, targetR: Number(f.targetR), expiryCandles: Number(f.expiryCandles), minRewardRisk: Number(f.minRewardRisk), longs: f.longs, shorts: f.shorts },
  };
}

// ---------------------------------------------------------------- equity chart

function EquityChart({ curve }) {
  const ref = useRef(null);
  useEffect(() => {
    const chart = createChart(ref.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "#0f141d" }, textColor: "#7c8aa3", fontFamily: "JetBrains Mono", fontSize: 11 },
      grid: { vertLines: { color: "#1a2231" }, horzLines: { color: "#1a2231" } },
      rightPriceScale: { borderColor: "#34415a" },
      timeScale: { borderColor: "#34415a", timeVisible: true },
    });
    const byTime = new Map();
    for (const p of curve) if (p.time != null) byTime.set(p.time, p.equity);
    const points = [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value }));
    const up = points.length && points[points.length - 1].value >= points[0].value;
    const line = chart.addSeries(LineSeries, { color: up ? "#35c48c" : "#e8604c", lineWidth: 2, priceLineVisible: false });
    line.setData(points);
    if (points.length) line.createPriceLine({ price: points[0].value, color: "#7c8aa3", lineStyle: 2, lineWidth: 1, title: "start" });
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [curve]);
  return <div ref={ref} className="bt-equity" />;
}

// ---------------------------------------------------------------- results

function Kpi({ label, value, sub, cls = "" }) {
  return <div className="bt-kpi"><span>{label}</span><b className={cls}>{value}</b>{sub && <small>{sub}</small>}</div>;
}

function Results({ result, timeZone, onUse, current }) {
  const c = result.combined;
  const rr = result.counts.avgPlannedRewardRisk;
  return (
    <div className="bt-results">
      <div className={`sa-verdict is-${result.verdict.tone === "good" ? "good" : result.verdict.tone === "bad" ? "bad" : "mixed"}`}>
        <div className="sa-verdict-row"><strong>{result.verdict.label}</strong><span className="sa-score-inline">{c.trades} trades · {result.perSymbol.filter((p) => !p.error).length} pairs · {result.interval}</span></div>
        <p>{result.verdict.text}</p>
      </div>

      <div className="bt-kpis">
        <Kpi label="Expectancy" value={signedR(c.expectancyR)} sub="average per trade, after fees" cls={tone(c.expectancyR)} />
        <Kpi label="Win rate" value={c.winRate == null ? "—" : `${c.winRate.toFixed(0)}%`} sub={`${c.wins} wins · ${c.losses} losses`} />
        <Kpi label="Profit factor" value={pf(c)} sub="gains ÷ losses" />
        <Kpi label="Total" value={signedR(c.totalR)} sub={`at ${c.equity.riskPerTradePct}% risk: ${signedPct(c.equity.returnPct)}`} cls={tone(c.totalR)} />
        <Kpi label="Worst drawdown" value={`${r2(c.maxDrawdownR, 1)}R`} sub={`${r2(c.equity.maxDrawdownPct, 0)}% of equity`} />
        <Kpi label="Longest losing run" value={c.maxLossStreak} sub="trades in a row" />
        <Kpi label="Planned reward:risk" value={rr == null ? "—" : `${r2(rr)} : 1`} sub="average at entry" />
        <Kpi label="Signals → trades" value={`${result.counts.signals} → ${result.counts.filled}`} sub={`missed ${result.counts.missed.expired + result.counts.missed.targetFirst}, busy ${result.counts.missed.busy}`} />
      </div>

      {c.halves && (
        <p className="an-hint">Stability: the first half of the trades averaged <b className={tone(c.halves.first)}>{signedR(c.halves.first)}</b> and the second half <b className={tone(c.halves.second)}>{signedR(c.halves.second)}</b>. A real edge should show in both.</p>
      )}

      {c.curve.length > 1 && (
        <>
          <p className="sa-sub">Equity curve (start 1,000, risking {c.equity.riskPerTradePct}% per trade, compounding)</p>
          <EquityChart curve={c.curve} />
        </>
      )}

      <p className="sa-sub">By pair</p>
      <div className="bt-table" role="table">
        <div className="bt-row bt-head" role="row"><span>Pair</span><span>Trades</span><span>Win</span><span>Expectancy</span><span>PF</span><span>Total</span><span>Buy &amp; hold</span></div>
        {result.perSymbol.map((p) => (
          <div className="bt-row" role="row" key={p.symbol}>
            <span><b>{p.symbol}</b></span>
            {p.error ? <span className="bt-err">{p.error}</span> : (
              <>
                <span>{p.stats.trades}</span>
                <span>{p.stats.winRate == null ? "—" : `${p.stats.winRate.toFixed(0)}%`}</span>
                <span className={tone(p.stats.expectancyR)}>{signedR(p.stats.expectancyR)}</span>
                <span>{pf(p.stats)}</span>
                <span className={tone(p.stats.totalR)}>{signedR(p.stats.totalR)}</span>
                <span className={tone(p.buyAndHoldPct)}>{signedPct(p.buyAndHoldPct)}</span>
              </>
            )}
          </div>
        ))}
      </div>

      {result.sweep && (
        <>
          <p className="sa-sub">Other ways to trade the same signals</p>
          <div className="bt-table" role="table">
            <div className="bt-row bt-sweep bt-head" role="row"><span>Entry and target</span><span>Trades</span><span>Win</span><span>Expectancy</span><span>PF</span></div>
            {result.sweep.map((row) => {
              const isCurrent = row.trade.entryMode === current.entryMode && row.trade.targetMode === current.targetMode && (row.trade.targetMode === "range" || row.trade.targetR === Number(current.targetR));
              return (
                <div className={`bt-row bt-sweep${isCurrent ? " is-current" : ""}`} role="row" key={row.label}>
                  <span>{row.label}{isCurrent ? " ← yours" : ""}</span>
                  <span>{row.stats.trades}</span>
                  <span>{row.stats.winRate == null ? "—" : `${row.stats.winRate.toFixed(0)}%`}</span>
                  <span className={tone(row.stats.expectancyR)}>{signedR(row.stats.expectancyR)}</span>
                  <span>{pf(row.stats)}</span>
                </div>
              );
            })}
          </div>
          <p className="an-hint">Careful: picking the best row of a table like this is fitting to the past. Differences between rows this small are usually noise, not a better strategy.</p>
        </>
      )}

      <p className="sa-sub">Latest trades</p>
      <div className="bt-table" role="table">
        <div className="bt-row bt-trades bt-head" role="row"><span>Entered</span><span>Pair</span><span>Side</span><span>Entry</span><span>Exit</span><span>Result</span><span>R</span></div>
        {result.trades.slice(0, 25).map((t) => (
          <div className="bt-row bt-trades" role="row" key={`${t.symbol}-${t.id}`}>
            <span>{when(t.entryTime, timeZone)}</span><span>{t.symbol}</span><span>{t.side}</span><span>{r2(t.entry, t.entry < 10 ? 4 : 2)}</span><span>{r2(t.exitPrice, t.exitPrice < 10 ? 4 : 2)}</span>
            <span>{t.reason === "target" ? "target" : "stop"}</span><span className={tone(t.r)}>{signedR(t.r)}</span>
          </div>
        ))}
        {result.trades.length === 0 && <p className="log-empty">No trades.</p>}
      </div>

      <div className="bt-actions">
        <button type="button" className="mini-button accent" onClick={onUse}>Use these settings for the bot</button>
      </div>
      <p className="order-rule-note">
        How the replay works: a limit order is placed after each signal candle closes and lapses after {result.options.trade.expiryCandles} candles if not filled; it fills at its price (or at the open when price gaps through);
        if price reaches the target first the trade is missed, never chased; when both stop and target fall inside one candle the stop wins; only the stop can end a trade on the candle that fills it; fees {result.options.trade.feePercent}% each way; one position per pair.
        Trades still open at the end are left out. Pairs are treated as independent, so the pooled curve ignores that a real account cannot take every trade at once.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- backtest tab

function BacktestTab({ timeZone, botConfig, onUseSettings }) {
  const [form, setForm] = useState(loadForm);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  useEffect(() => {
    try { window.localStorage.setItem(FORM_KEY, JSON.stringify(form)); } catch { /* storage unavailable */ }
  }, [form]);

  const addSymbol = () => {
    const s = input.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,20}$/.test(s)) { setError(`"${input}" is not a valid symbol`); return; }
    setError(null);
    if (!form.symbols.includes(s) && form.symbols.length < 12) set({ symbols: [...form.symbols, s] });
    setInput("");
  };

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setResult(await runAmdBacktest(backtestBody(form)));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const Num = ({ label, field, min, max, step = 1, hint }) => (
    <label title={hint}>{label}<input type="number" min={min} max={max} step={step} value={form[field]} onChange={(e) => set({ [field]: e.target.value })} /></label>
  );

  return (
    <div className="bt-layout">
      <section className="panel bt-form">
        <div className="panel-heading"><div><p className="panel-title">Backtest the AMD signal</p><p className="panel-subtitle">Replays exactly the orders the bot would place, on real history</p></div></div>
        <div className="fut-side-toggle" role="group" aria-label="Market">
          <button type="button" className={form.market === "futures" ? "is-on" : ""} onClick={() => set({ market: "futures" })}>Futures</button>
          <button type="button" className={form.market === "spot" ? "is-on" : ""} onClick={() => set({ market: "spot", shorts: false })}>Spot (long only)</button>
        </div>

        <div className="bt-pairs">
          <p className="sa-sub">Pairs ({form.symbols.length}/12)</p>
          <div className="bt-chips">
            {form.symbols.map((s) => <span className="bt-chip" key={s}>{s}<button type="button" aria-label={`Remove ${s}`} onClick={() => set({ symbols: form.symbols.filter((x) => x !== s) })}>×</button></span>)}
          </div>
          <div className="bt-add">
            <input value={input} onChange={(e) => setInput(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === "Enter" && addSymbol()} placeholder="Add a pair, e.g. AVAXUSDT" spellCheck={false} />
            <button type="button" className="mini-button" onClick={addSymbol}>Add</button>
          </div>
          <div className="bt-presets">
            <button type="button" className="link-button" onClick={() => set({ symbols: PRESET_PAIRS })}>Top 10</button>
            {botConfig?.pairs?.length > 0 && <button type="button" className="link-button" onClick={() => set({ symbols: botConfig.pairs.map((p) => p.symbol), interval: botConfig.pairs[0].interval, market: botConfig.market })}>The bot's pairs</button>}
          </div>
        </div>

        <div className="bt-grid">
          <label>Timeframe<select value={form.interval} onChange={(e) => set({ interval: e.target.value })}>{INTERVALS.map((v) => <option key={v}>{v}</option>)}</select></label>
          <label>History<select value={form.candles} onChange={(e) => set({ candles: e.target.value })}><option value={1000}>1,000 candles</option><option value={3000}>3,000 candles</option><option value={5000}>5,000 candles</option></select></label>
          <label>Entry<select value={form.entryMode} onChange={(e) => set({ entryMode: e.target.value })}><option value="limit-close">At the signal close</option><option value="fvg-retest">On a retest of the gap</option></select></label>
          <label>Target<select value={form.targetMode} onChange={(e) => set({ targetMode: e.target.value })}><option value="range">Far side of the range</option><option value="r">Fixed multiple of the risk</option></select></label>
          {form.targetMode === "r" && <Num label="Target (× risk)" field="targetR" min={1} max={5} step={0.5} />}
          <Num label="Order lapses after (candles)" field="expiryCandles" min={1} max={10} />
          <Num label="Min reward:risk" field="minRewardRisk" min={0} max={5} step={0.5} hint="Signals whose reward:risk is below this are skipped" />
          <Num label="Risk per trade (%)" field="riskPerTradePct" min={0.1} max={10} step={0.1} hint="Only for the equity curve" />
          <Num label="Min range candles" field="minRangeBars" min={4} max={40} />
          <Num label="Max range height (ATR)" field="maxRangeAtr" min={1.5} max={6} step={0.5} />
        </div>
        <div className="bt-checks">
          <label className="switch"><input type="checkbox" checked={form.longs} onChange={(e) => set({ longs: e.target.checked })} /> Long trades</label>
          <label className="switch"><input type="checkbox" checked={form.shorts && form.market === "futures"} disabled={form.market === "spot"} onChange={(e) => set({ shorts: e.target.checked })} /> Short trades</label>
          <label className="switch"><input type="checkbox" checked={form.sweep} onChange={(e) => set({ sweep: e.target.checked })} /> Compare other entries and targets</label>
        </div>
        <button type="button" className="primary-button" disabled={busy || form.symbols.length === 0} onClick={run}>{busy ? "Reading history…" : "Run backtest"}</button>
        {busy && <p className="an-hint">Loading up to {Number(form.candles).toLocaleString()} candles for each pair from Binance: this takes 10 to 20 seconds.</p>}
        {error && <p className="order-error">{error}</p>}
        <button type="button" className="link-button" onClick={() => setForm({ ...FORM_DEFAULTS })}>Reset to defaults</button>
      </section>

      <section className="panel bt-output">
        {!result && !busy && <p className="log-empty">Choose pairs and press Run backtest. You get the win rate, the average result per trade after fees, the worst drawdown and an equity curve, so you can see whether the signal has ever paid before you trade it.</p>}
        {result && <Results result={result} timeZone={timeZone} current={form} onUse={() => onUseSettings({ market: result.market, entryMode: form.entryMode, targetMode: form.targetMode, targetR: Number(form.targetR), expiryCandles: Number(form.expiryCandles), longs: form.longs, shorts: form.shorts, engine: { minRangeBars: Number(form.minRangeBars), maxRangeAtr: Number(form.maxRangeAtr), minRewardRisk: Number(form.minRewardRisk) }, pairs: form.symbols.map((symbol) => ({ symbol, interval: form.interval })) })} />}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- auto trading tab

/** The settings that change how the bot trades: a backtest check is only valid for the exact ones it was run with. */
const signature = (c) => JSON.stringify([c.market, c.pairs, c.entryMode, c.targetMode, c.targetR, c.expiryCandles, c.longs, c.shorts, c.engine]);

function AutoTab({ risk, timeZone, data, reload, draft, setDraft }) {
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState(null);
  const [checking, setChecking] = useState(false);
  const [ack, setAck] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [liveWord, setLiveWord] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(id); }, []);

  const { config, status } = data;
  const dirty = JSON.stringify(draft) !== JSON.stringify(config);
  const set = (patch) => setDraft((d) => ({ ...d, ...patch, ...(patch.market === "spot" ? { shorts: false } : {}) }));
  const setEngine = (patch) => setDraft((d) => ({ ...d, engine: { ...d.engine, ...patch } }));
  const sig = signature(draft);
  const checkValid = check && check.sig === sig;
  const bad = checkValid && check.groups.some((g) => g.stats.trades === 0 ? false : g.stats.expectancyR <= 0);
  const live = status.mode === "live";
  const settings = risk?.settings;

  async function save(extra = {}) {
    setBusy(true);
    setError(null);
    try {
      await putAmdConfig({ ...draft, armedMode: undefined, ...extra });
      await reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function runCheck() {
    setChecking(true);
    setError(null);
    try {
      const byInterval = new Map();
      for (const p of draft.pairs) byInterval.set(p.interval, [...(byInterval.get(p.interval) ?? []), p.symbol]);
      const groups = [];
      for (const [interval, symbols] of byInterval) {
        const res = await runAmdBacktest({
          market: draft.market, symbols, interval, candles: 3000, sweep: false, riskPerTradePct: 1,
          engine: draft.engine,
          trade: { entryMode: draft.entryMode, targetMode: draft.targetMode, targetR: draft.targetR, expiryCandles: draft.expiryCandles, minRewardRisk: draft.engine.minRewardRisk, longs: draft.longs, shorts: draft.shorts },
        });
        groups.push({ interval, symbols, stats: res.combined, verdict: res.verdict, avgRR: res.counts.avgPlannedRewardRisk, days: (res.perSymbol.find((p) => p.to)?.to - res.perSymbol.find((p) => p.from)?.from) / 86400 });
      }
      setCheck({ sig, at: Date.now(), groups });
      setAck(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setChecking(false);
    }
  }

  const updatePair = (i, patch) => set({ pairs: draft.pairs.map((p, k) => (k === i ? { ...p, ...patch } : p)) });
  const addPair = () => set({ pairs: [...draft.pairs, { symbol: "", interval: draft.pairs[0]?.interval ?? "15m" }].slice(0, 12) });
  const minRR = settings?.minRewardRisk;
  const avgRR = checkValid ? Math.min(...check.groups.map((g) => g.avgRR ?? Infinity)) : null;
  const armable = checkValid && !dirty && draft.pairs.length > 0 && (!bad || ack) && (!live || liveWord === "LIVE");

  return (
    <div className="auto-layout">
      <section className="panel">
        <div className="panel-heading">
          <div><p className="panel-title">Automatic AMD orders</p><p className="panel-subtitle">The server watches your pairs, even with every tab closed</p></div>
          <span className={`testnet-badge ${live ? "live-badge" : ""}`}>{live ? "LIVE ACCOUNT" : "TESTNET"}</span>
        </div>

        <div className={`auto-state ${status.ordering ? "is-on" : ""}`}>
          <div>
            <strong>{status.ordering ? `Placing orders automatically (${status.armedMode === "live" ? "LIVE" : "Testnet"})` : status.watching ? "Watching and notifying only: no orders" : "Off"}</strong>
            <p>{status.blocked ?? (status.ordering ? `${status.today.count} of ${status.today.max} orders today · ${status.pending.length} open · last check ${ago(status.lastTickAt, now)}` : status.watching ? `Last check ${ago(status.lastTickAt, now)}. You are told about signals; nothing is bought.` : "Nothing is being watched.")}</p>
          </div>
          {status.ordering && <button type="button" className="mini-button danger" disabled={busy} onClick={() => save({ orders: false })}>Stop automatic orders</button>}
        </div>

        <div className="auto-cards">
          <div className="auto-card">
            <p className="sa-sub">Pairs to watch (max 12)</p>
            {draft.pairs.map((p, i) => (
              <div className="auto-pair" key={i}>
                <input value={p.symbol} placeholder="BTCUSDT" spellCheck={false} onChange={(e) => updatePair(i, { symbol: e.target.value.toUpperCase() })} aria-label="Pair" />
                <select value={p.interval} onChange={(e) => updatePair(i, { interval: e.target.value })} aria-label="Timeframe">{INTERVALS.map((v) => <option key={v}>{v}</option>)}</select>
                <button type="button" aria-label="Remove pair" onClick={() => set({ pairs: draft.pairs.filter((_, k) => k !== i) })}>×</button>
              </div>
            ))}
            <button type="button" className="mini-button" onClick={addPair} disabled={draft.pairs.length >= 12}>+ Add a pair</button>
            {draft.pairs.length === 0 && <p className="an-hint">Add at least one pair to watch.</p>}
          </div>

          <div className="auto-card">
            <p className="sa-sub">How it trades</p>
            <div className="bt-grid">
              <label>Market<select value={draft.market} onChange={(e) => set({ market: e.target.value })}><option value="futures">Futures (long and short)</option><option value="spot">Spot (long only)</option></select></label>
              <label>Entry<select value={draft.entryMode} onChange={(e) => set({ entryMode: e.target.value })}><option value="limit-close">At the signal close</option><option value="fvg-retest">On a retest of the gap</option></select></label>
              <label>Target<select value={draft.targetMode} onChange={(e) => set({ targetMode: e.target.value })}><option value="range">Far side of the range</option><option value="r">Multiple of the risk</option></select></label>
              {draft.targetMode === "r" && <label>Target (× risk)<input type="number" min="1" max="5" step="0.5" value={draft.targetR} onChange={(e) => set({ targetR: Number(e.target.value) })} /></label>}
              <label>Entry lapses after (candles)<input type="number" min="1" max="10" value={draft.expiryCandles} onChange={(e) => set({ expiryCandles: Number(e.target.value) })} /></label>
              {draft.market === "futures" && <label title="Capped by the max leverage in your Risk tab and by the liquidation check">Leverage<input type="number" min="1" max="20" value={draft.leverage} onChange={(e) => set({ leverage: Number(e.target.value) })} /></label>}
              <label>Min reward:risk<input type="number" min="0" max="5" step="0.5" value={draft.engine.minRewardRisk} onChange={(e) => setEngine({ minRewardRisk: Number(e.target.value) })} /></label>
            </div>
            <div className="bt-checks">
              <label className="switch"><input type="checkbox" checked={draft.longs} onChange={(e) => set({ longs: e.target.checked })} /> Long</label>
              <label className="switch"><input type="checkbox" checked={draft.shorts && draft.market === "futures"} disabled={draft.market === "spot"} onChange={(e) => set({ shorts: e.target.checked })} /> Short</label>
            </div>
          </div>

          <div className="auto-card">
            <p className="sa-sub">Its own limits</p>
            <div className="bt-grid">
              <label>Max open orders<input type="number" min="1" max="10" value={draft.maxOpenOrders} onChange={(e) => set({ maxOpenOrders: Number(e.target.value) })} /></label>
              <label>Max orders per day<input type="number" min="1" max="50" value={draft.maxOrdersPerDay} onChange={(e) => set({ maxOrdersPerDay: Number(e.target.value) })} /></label>
            </div>
            {settings && (
              <p className="an-hint">
                Size and safety come from your <b>Risk tab</b>, which the server applies to every order: {settings.riskPerTradePct}% of capital lost if a stop fills, at most {settings.maxPositionPct}% in one position, minimum reward:risk {settings.minRewardRisk}, {settings.maxLeverage}× leverage, daily loss {settings.maxDailyLossPct}%, and the pause switch.
              </p>
            )}
            <label className="switch"><input type="checkbox" checked={draft.pushSkips} onChange={(e) => set({ pushSkips: e.target.checked })} /> Also send "order not placed" messages to Telegram / webhook</label>
          </div>
        </div>

        <div className="auto-actions">
          <label className="switch"><input type="checkbox" checked={draft.watch || draft.orders} disabled={draft.orders} onChange={(e) => set({ watch: e.target.checked })} /> Watch these pairs and notify me (no orders)</label>
          <button type="button" className="mini-button accent" disabled={busy || !dirty} onClick={() => save()}>{busy ? "Saving…" : dirty ? "Save settings" : "Saved"}</button>
          <button type="button" className="mini-button" disabled={!config.pairs.length || scanning} onClick={async () => { setScanning(true); try { await scanAmdNow(); await reload(); } catch (err) { setError(err.message); } finally { setScanning(false); } }}>{scanning ? "Scanning…" : "Scan now"}</button>
        </div>
        {error && <p className="order-error">{error}</p>}

        {!status.ordering && (
          <div className="arm-box">
            <p className="panel-title">Arm automatic orders</p>
            <p className="an-hint">Real orders are placed on the {live ? "LIVE account with real money" : "Testnet account"}. First, see how these exact settings did on recent history.</p>
            <button type="button" className="mini-button" disabled={checking || dirty || draft.pairs.length === 0} onClick={runCheck}>{checking ? "Checking history…" : checkValid ? "Check again" : "Check these settings against history"}</button>
            {dirty && <p className="an-hint">Save your settings first: the check must be for the settings that will trade.</p>}
            {checkValid && (
              <div className="arm-check">
                {check.groups.map((g) => (
                  <div className={`sa-verdict is-${g.verdict.tone === "good" ? "good" : g.verdict.tone === "bad" ? "bad" : "mixed"}`} key={g.interval}>
                    <div className="sa-verdict-row"><strong>{g.interval}: {g.verdict.label}</strong><span className="sa-score-inline">{g.stats.trades} trades · ~{Math.round(g.days)} days</span></div>
                    <p>{g.verdict.text}</p>
                  </div>
                ))}
                {minRR != null && avgRR != null && avgRR < minRR && (
                  <p className="order-error">Your Risk tab requires reward:risk of at least {minRR}, but these signals average {r2(avgRR)} : 1. Most orders will be refused by your own rules ("order not placed"). Lower the minimum in the Risk tab, or try the "retest of the gap" entry.</p>
                )}
                {bad && <label className="switch ack"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I understand these settings lost money in the backtest, and I want to trade them anyway</label>}
                {live && <label className="live-word">Type <b>LIVE</b> to confirm real money<input value={liveWord} onChange={(e) => setLiveWord(e.target.value)} placeholder="LIVE" /></label>}
                <button type="button" className="primary-button is-short" disabled={!armable || busy} onClick={() => save({ orders: true, confirm: live ? liveWord : undefined })}>Arm automatic orders on {live ? "the LIVE account" : "Testnet"}</button>
                <p className="order-rule-note">Every order still passes your risk rules and gets its stop-loss and take-profit on Binance. Switching the account between Testnet and Live switches the bot off. A backtest is history, not a promise.</p>
              </div>
            )}
          </div>
        )}
      </section>

      <aside className="auto-side">
        <section className="panel">
          <div className="panel-heading"><div><p className="panel-title">What it is doing</p></div></div>
          {status.pairs.length === 0 && <p className="log-empty">No pairs yet.</p>}
          {status.pairs.map((p) => (
            <div className="auto-scan" key={`${p.symbol}-${p.interval}`}>
              <b>{p.symbol}</b><span>{p.interval}</span>
              <em className={p.error ? "loss-estimate" : ""}>{p.error ? p.error : p.checkedAt ? `checked ${ago(p.checkedAt, now)}` : "not checked yet"}</em>
            </div>
          ))}
          {status.pending.length > 0 && <p className="sa-sub">Orders it placed and is following</p>}
          {status.pending.map((p) => <div className="auto-scan" key={p.id}><b>{p.symbol}</b><span>{p.dir === "bull" ? "buy" : "sell"}</span><em>{p.status.replace("_", " ").toLowerCase()}</em></div>)}
        </section>
        <BotLog timeZone={timeZone} />
      </aside>
    </div>
  );
}

function BotLog({ timeZone }) {
  const [events, setEvents] = useState([]);
  useEffect(() => {
    let cancelled = false;
    const load = () => getAmdLog(40).then((d) => { if (!cancelled) setEvents(d.events); }).catch(() => {});
    load();
    const id = window.setInterval(load, 10_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);
  return (
    <section className="panel">
      <div className="panel-heading"><div><p className="panel-title">Bot log</p><p className="panel-subtitle">Every signal, order and refusal, with the reason</p></div></div>
      {events.length === 0 && <p className="log-empty">Nothing yet.</p>}
      {events.map((e) => (
        <div className={`notif-item is-${e.level}`} key={e.id}>
          <i aria-hidden="true">{e.level === "success" ? "●" : e.level === "error" ? "✕" : e.level === "warn" ? "▲" : "•"}</i>
          <div>
            <p className="notif-title">{e.title}</p>
            {e.body && <p className="notif-body">{e.body}</p>}
            <p className="notif-time">{new Intl.DateTimeFormat(undefined, { timeZone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(e.at)}</p>
          </div>
        </div>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------- notifications tab

function AlertsTab({ data, timeZone }) {
  const [permission, setPermission] = useState(desktopPermission);
  const [sound, setSound] = useState(audioState);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const channels = data.channels;

  const test = async () => {
    setBusy(true);
    setMsg(null);
    setSound(primeAudio());
    try {
      const res = await sendTestNotification();
      const parts = Object.entries(res.event.delivery ?? {}).map(([k, v]) => `${k}: ${v}`);
      setMsg(`Test sent to the app${parts.length ? ` · ${parts.join(" · ")}` : ""}. It should appear as a card within 10 seconds.`);
      setSound(playChime("up") ? "running" : audioState());
      showDesktop("Test notification", "System notifications work.", "test");
    } catch (err) {
      setMsg(`Could not send: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="alerts-layout">
      <section className="panel">
        <div className="panel-heading"><div><p className="panel-title">How you are notified</p><p className="panel-subtitle">Detection runs on the server, so it works with this page closed</p></div></div>
        <div className="chan">
          <div><b>In the app</b><p>The 🔔 in the header and cards on any screen. Anything that happened while you were away is waiting there as unread.</p></div>
          <span className="chan-state is-on">always on</span>
        </div>
        <div className="chan">
          <div><b>System notification (this browser)</b><p>{PERMISSION_HELP[permission]}</p></div>
          {permission === "default" && <button type="button" className="mini-button accent" onClick={async () => setPermission(await requestDesktop())}>Turn on</button>}
          {permission !== "default" && <span className={`chan-state ${permission === "granted" ? "is-on" : "is-off"}`}>{permission}</span>}
        </div>
        <div className="chan">
          <div><b>Sound</b><p>{sound === "running" ? "Ready: a chime plays when something new arrives." : sound === "unsupported" ? "This browser has no audio." : "Blocked until you click on the page once (a browser rule). Press the test button below to unlock it."}</p></div>
          <span className={`chan-state ${sound === "running" ? "is-on" : "is-off"}`}>{sound === "running" ? "ready" : sound}</span>
        </div>
        <div className="chan">
          <div><b>Telegram</b><p>{channels.telegram.configured ? "Configured: every signal, order, fill and close is also sent to your chat, even when nothing is open." : <>Not set up. Create a bot with @BotFather, send it a message, then set <code>TELEGRAM_BOT_TOKEN</code> and <code>TELEGRAM_CHAT_ID</code> in the server environment and restart.</>}</p></div>
          <span className={`chan-state ${channels.telegram.configured ? "is-on" : "is-off"}`}>{channels.telegram.configured ? "configured" : "not set up"}</span>
        </div>
        <div className="chan">
          <div><b>Webhook</b><p>{channels.webhook.configured ? "Configured: each event is POSTed as JSON (title, body, plan) to your URL." : <>Not set up. Set <code>NOTIFY_WEBHOOK_URL</code> to any https address (Discord, Slack, Zapier, Make, your own server) and restart.</>}</p></div>
          <span className={`chan-state ${channels.webhook.configured ? "is-on" : "is-off"}`}>{channels.webhook.configured ? "configured" : "not set up"}</span>
        </div>
        <button type="button" className="primary-button" disabled={busy} onClick={test}>Send a test notification</button>
        {msg && <p className="order-note">{msg}</p>}
        <p className="order-rule-note">The test goes through every channel above and shows what each one answered. Secrets stay on the server: this page never sees your Telegram token.</p>
      </section>
      <BotLog timeZone={timeZone} />
    </div>
  );
}

// ---------------------------------------------------------------- the screen

const TABS = [["backtest", "Backtest"], ["auto", "Auto trading"], ["alerts", "Notifications"]];

export default function AmdBotPanel({ risk, timeZone = "UTC", initialTab = "backtest" }) {
  const [tab, setTab] = usePersistentState("pref:amd-bot-tab", initialTab, oneOf(TABS.map(([id]) => id)));
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState(null);
  const draftReady = useRef(false);

  const reload = useMemo(() => async () => {
    const next = await getAmdStatus();
    setData(next);
    setError(null);
    if (!draftReady.current) { draftReady.current = true; setDraft(next.config); }
    else setDraft((d) => (d && JSON.stringify(d) !== JSON.stringify(next.config) && draftIsClean.current ? next.config : d));
  }, []);
  const draftIsClean = useRef(true);
  useEffect(() => { draftIsClean.current = !data || !draft || JSON.stringify(draft) === JSON.stringify(data.config); }, [data, draft]);

  useEffect(() => {
    reload().catch((err) => setError(err.message));
    const id = window.setInterval(() => reload().catch(() => {}), 10_000);
    return () => window.clearInterval(id);
  }, [reload]);

  return (
    <div className="amdbot-view">
      <div className="amdbot-head">
        <div>
          <h2>AMD bot</h2>
          <p>Accumulation, Manipulation, FVG, Distribution: test it on history, trade it automatically, get told when it fires.</p>
        </div>
        <div className="segmented" role="tablist" aria-label="AMD bot sections">
          {TABS.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "is-active" : ""} onClick={() => setTab(id)}>{label}</button>)}
        </div>
      </div>
      {error && !data && <div className="futures-notice is-error"><strong>Could not reach the server</strong><p>{error}</p></div>}
      {tab === "backtest" && <BacktestTab timeZone={timeZone} botConfig={data?.config} onUseSettings={(patch) => { setDraft((d) => ({ ...(d ?? data?.config), ...patch })); setTab("auto"); }} />}
      {tab === "auto" && data && draft && <AutoTab risk={risk} timeZone={timeZone} data={data} reload={reload} draft={draft} setDraft={setDraft} />}
      {tab === "alerts" && data && <AlertsTab data={data} timeZone={timeZone} />}
    </div>
  );
}
