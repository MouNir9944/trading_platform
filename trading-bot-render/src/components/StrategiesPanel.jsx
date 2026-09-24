import { useEffect, useRef, useState } from "react";
import { ColorType, LineSeries, createChart } from "lightweight-charts";

import {
  compareStrategies, getBot, getBotLog, getStrategies, putBot, runStrategyBacktest, scanBot, sendTestNotification,
} from "../api.js";
import { PERMISSION_HELP } from "./NotificationCenter.jsx";
import { audioState, desktopPermission, playChime, primeAudio, requestDesktop, showDesktop } from "../lib/amdAlerts.js";
import { oneOf, usePersistentState } from "../lib/persist.js";

const INTERVALS = ["5m", "15m", "30m", "1h", "2h", "4h"];
const PRESET_PAIRS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "LINKUSDT", "AVAXUSDT", "TSLAUSDT"];

const r2 = (n, d = 2) => (n == null || !Number.isFinite(n) ? "—" : n.toFixed(d));
const signedR = (n) => (n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}R`);
const signedPct = (n, d = 1) => (n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(d)}%`);
const tone = (n) => (n == null ? "" : n >= 0 ? "profit-estimate" : "loss-estimate");
const pf = (stats) => (stats.trades === 0 ? "—" : stats.profitFactor == null || stats.profitFactor === Infinity ? "∞" : stats.profitFactor.toFixed(2));
const when = (sec, timeZone) => new Intl.DateTimeFormat(undefined, { timeZone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(sec * 1000);
const ago = (ms, now) => (ms ? `${Math.max(0, Math.round((now - ms) / 60_000))} min ago` : "not yet");
const verdictClass = (v) => `is-${v.tone === "good" ? "good" : v.tone === "bad" ? "bad" : "mixed"}`;

/** Default backtest form for a strategy: its own settings plus the way it is traded. */
const formDefaults = (strategy) => ({
  market: "futures", symbols: PRESET_PAIRS, interval: "15m", candles: 3000,
  entryMode: "limit-close", targetMode: "own", targetR: 2, expiryCandles: 3, minRewardRisk: 1,
  riskPerTradePct: 1, longs: true, shorts: strategy.directions.includes("short"), sweep: true,
  params: { ...(strategy.defaults ?? {}) },
});

/** The request body for a backtest, from the form. */
export function backtestBody(f) {
  return {
    market: f.market, symbols: f.symbols, interval: f.interval, candles: Number(f.candles), sweep: f.sweep, riskPerTradePct: Number(f.riskPerTradePct),
    params: Object.fromEntries(Object.entries(f.params ?? {}).map(([k, v]) => [k, Number(v)])),
    trade: { entryMode: f.entryMode, targetMode: f.targetMode, targetR: Number(f.targetR), expiryCandles: Number(f.expiryCandles), minRewardRisk: Number(f.minRewardRisk), longs: f.longs, shorts: f.shorts },
  };
}

// ---------------------------------------------------------------- shared pieces

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

function Kpi({ label, value, sub, cls = "" }) {
  return <div className="bt-kpi"><span>{label}</span><b className={cls}>{value}</b>{sub && <small>{sub}</small>}</div>;
}

/** The chips + add box used to choose the pairs of a test. */
function PairChips({ symbols, onChange, extra = null, setError }) {
  const [input, setInput] = useState("");
  const add = () => {
    const s = input.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,20}$/.test(s)) { setError(`"${input}" is not a valid symbol`); return; }
    setError(null);
    if (!symbols.includes(s) && symbols.length < 12) onChange([...symbols, s]);
    setInput("");
  };
  return (
    <div className="bt-pairs">
      <p className="sa-sub">Pairs ({symbols.length}/12)</p>
      <div className="bt-chips">
        {symbols.map((s) => <span className="bt-chip" key={s}>{s}<button type="button" aria-label={`Remove ${s}`} onClick={() => onChange(symbols.filter((x) => x !== s))}>×</button></span>)}
      </div>
      <div className="bt-add">
        <input value={input} onChange={(e) => setInput(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === "Enter" && add()} placeholder="Add a pair, e.g. AVAXUSDT" spellCheck={false} />
        <button type="button" className="mini-button" onClick={add}>Add</button>
      </div>
      <div className="bt-presets">
        <button type="button" className="link-button" onClick={() => onChange(PRESET_PAIRS)}>Top 10</button>
        {extra}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- backtest results

function Results({ result, timeZone, onUse, current }) {
  const c = result.combined;
  const rr = result.counts.avgPlannedRewardRisk;
  return (
    <div className="bt-results">
      <div className={`sa-verdict ${verdictClass(result.verdict)}`}>
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
              const isCurrent = row.trade.entryMode === current.entryMode && row.trade.targetMode === current.targetMode && (row.trade.targetMode === "own" || row.trade.targetR === Number(current.targetR));
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
        <button type="button" className="mini-button accent" onClick={onUse}>Use these settings for automatic trading</button>
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

function BacktestTab({ strategy, timeZone, botConfig, onUseSettings }) {
  const [form, setForm] = usePersistentState(`pref:bt-form:${strategy.id}`, () => formDefaults(strategy), (v) => v && typeof v === "object");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const params = { ...strategy.defaults, ...(form.params ?? {}) };
  const setParam = (key, value) => set({ params: { ...params, [key]: value } });
  const canShort = strategy.directions.includes("short");
  const entryMode = strategy.supportsRetest ? form.entryMode : "limit-close";

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setResult(await runStrategyBacktest(strategy.id, backtestBody({ ...form, params, entryMode })));
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
        <div className="panel-heading"><div><p className="panel-title">Backtest</p><p className="panel-subtitle">Replays exactly the orders the bot would place, on real history</p></div></div>
        <div className="fut-side-toggle" role="group" aria-label="Market">
          <button type="button" className={form.market === "futures" ? "is-on" : ""} onClick={() => set({ market: "futures" })}>Futures</button>
          <button type="button" className={form.market === "spot" ? "is-on" : ""} onClick={() => set({ market: "spot", shorts: false })}>Spot (long only)</button>
        </div>

        <PairChips
          symbols={form.symbols}
          onChange={(symbols) => set({ symbols })}
          setError={setError}
          extra={botConfig?.pairs?.length > 0 && <button type="button" className="link-button" onClick={() => set({ symbols: botConfig.pairs.map((p) => p.symbol), interval: botConfig.pairs[0].interval, market: botConfig.market })}>The bot's pairs</button>}
        />

        <div className="bt-grid">
          <label>Timeframe<select value={form.interval} onChange={(e) => set({ interval: e.target.value })}>{INTERVALS.map((v) => <option key={v}>{v}</option>)}</select></label>
          <label>History<select value={form.candles} onChange={(e) => set({ candles: e.target.value })}><option value={1000}>1,000 candles</option><option value={3000}>3,000 candles</option><option value={5000}>5,000 candles</option></select></label>
          <label>Entry<select value={entryMode} onChange={(e) => set({ entryMode: e.target.value })}><option value="limit-close">At the signal close</option>{strategy.supportsRetest && <option value="retest">On a retest</option>}</select></label>
          <label>Target<select value={form.targetMode} onChange={(e) => set({ targetMode: e.target.value })}><option value="own">The strategy's own target</option><option value="r">Fixed multiple of the risk</option></select></label>
          {form.targetMode === "r" && <Num label="Target (× risk)" field="targetR" min={1} max={5} step={0.5} />}
          <Num label="Order lapses after (candles)" field="expiryCandles" min={1} max={10} />
          <Num label="Min reward:risk" field="minRewardRisk" min={0} max={5} step={0.5} hint="Signals whose reward:risk is below this are skipped" />
          <Num label="Risk per trade (%)" field="riskPerTradePct" min={0.1} max={10} step={0.1} hint="Only for the equity curve" />
        </div>

        {strategy.params.length > 0 && (
          <>
            <p className="sa-sub">{strategy.name}: its own settings</p>
            <div className="bt-grid">
              {strategy.params.map((p) => (
                <label key={p.key} title={p.hint}>{p.label}<input type="number" min={p.min} max={p.max} step={p.step ?? 1} value={params[p.key]} onChange={(e) => setParam(p.key, e.target.value)} /></label>
              ))}
            </div>
          </>
        )}

        <div className="bt-checks">
          <label className="switch"><input type="checkbox" checked={form.longs} onChange={(e) => set({ longs: e.target.checked })} /> Long trades</label>
          {canShort && <label className="switch"><input type="checkbox" checked={form.shorts && form.market === "futures"} disabled={form.market === "spot"} onChange={(e) => set({ shorts: e.target.checked })} /> Short trades</label>}
          <label className="switch"><input type="checkbox" checked={form.sweep} onChange={(e) => set({ sweep: e.target.checked })} /> Compare other entries and targets</label>
        </div>
        <button type="button" className="primary-button" disabled={busy || form.symbols.length === 0} onClick={run}>{busy ? "Reading history…" : "Run backtest"}</button>
        {busy && <p className="an-hint">Loading up to {Number(form.candles).toLocaleString()} candles for each pair from Binance: this takes 10 to 20 seconds.</p>}
        {error && <p className="order-error">{error}</p>}
        <button type="button" className="link-button" onClick={() => setForm(formDefaults(strategy))}>Reset to defaults</button>
      </section>

      <section className="panel bt-output">
        {!result && !busy && <p className="log-empty">Choose pairs and press Run backtest. You get the win rate, the average result per trade after fees, the worst drawdown and an equity curve, so you can see whether the strategy has ever paid before you trade it.</p>}
        {result && (
          <Results
            result={result} timeZone={timeZone} current={{ ...form, entryMode }}
            onUse={() => onUseSettings({
              market: result.market, entryMode, targetMode: form.targetMode, targetR: Number(form.targetR), expiryCandles: Number(form.expiryCandles),
              longs: form.longs, shorts: canShort && form.shorts, minRewardRisk: Number(form.minRewardRisk),
              params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, Number(v)])),
              pairs: form.symbols.map((symbol) => ({ symbol, interval: form.interval })),
            })}
          />
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- bot log

function BotLog({ timeZone, strategyId = null }) {
  const [events, setEvents] = useState([]);
  useEffect(() => {
    let cancelled = false;
    const load = () => getBotLog(strategyId, 40).then((d) => { if (!cancelled) setEvents(d.events); }).catch(() => {});
    load();
    const id = window.setInterval(load, 10_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [strategyId]);
  return (
    <section className="panel">
      <div className="panel-heading"><div><p className="panel-title">{strategyId ? "Log of this strategy" : "Log of all strategies"}</p><p className="panel-subtitle">Every signal, order and refusal, with the reason</p></div></div>
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

// ---------------------------------------------------------------- auto trading tab

/** The settings that change how the bot trades: a backtest check is only valid for the exact ones it was run with. */
const signature = (c) => JSON.stringify([c.market, c.pairs, c.entryMode, c.targetMode, c.targetR, c.expiryCandles, c.longs, c.shorts, c.minRewardRisk, c.params]);

function AutoTab({ strategy, risk, timeZone, handoff, onHandoffUsed }) {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState(null);
  const [checking, setChecking] = useState(false);
  const [ack, setAck] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [liveWord, setLiveWord] = useState("");
  const [now, setNow] = useState(Date.now());
  const draftRef = useRef(null);
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(id); }, []);

  const reload = async () => {
    const next = await getBot(strategy.id);
    setData(next);
    setLoadError(null);
    setDraft((d) => (d == null || JSON.stringify(d) === JSON.stringify(draftRef.current?.config) ? next.config : d));
    draftRef.current = next;
  };
  useEffect(() => {
    reload().catch((err) => setLoadError(err.message));
    const id = window.setInterval(() => reload().catch(() => {}), 10_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategy.id]);

  // "Use these settings" from the backtest
  useEffect(() => {
    if (handoff && draft) {
      setDraft((d) => ({ ...d, ...handoff, params: { ...d.params, ...handoff.params } }));
      onHandoffUsed();
    }
  }, [handoff, draft, onHandoffUsed]);

  if (loadError && !data) return <div className="futures-notice is-error"><strong>Could not reach the server</strong><p>{loadError}</p></div>;
  if (!data || !draft) return <p className="log-empty">Loading…</p>;

  const { config, status } = data;
  const dirty = JSON.stringify(draft) !== JSON.stringify(config);
  const set = (patch) => setDraft((d) => ({ ...d, ...patch, ...(patch.market === "spot" ? { shorts: false } : {}) }));
  const setParam = (key, value) => setDraft((d) => ({ ...d, params: { ...d.params, [key]: value } }));
  const sig = signature(draft);
  const checkValid = check && check.sig === sig;
  const bad = checkValid && check.groups.some((g) => g.stats.trades > 0 && g.stats.expectancyR <= 0);
  const live = status.mode === "live";
  const settings = risk?.settings;
  const canShort = strategy.directions.includes("short");

  async function save(extra = {}) {
    setBusy(true);
    setError(null);
    try {
      await putBot(strategy.id, { ...draft, armedMode: undefined, ...extra });
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
        const res = await runStrategyBacktest(strategy.id, {
          market: draft.market, symbols, interval, candles: 3000, sweep: false, riskPerTradePct: 1, params: draft.params,
          trade: { entryMode: draft.entryMode, targetMode: draft.targetMode, targetR: draft.targetR, expiryCandles: draft.expiryCandles, minRewardRisk: draft.minRewardRisk, longs: draft.longs, shorts: draft.shorts },
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
          <div><p className="panel-title">Automatic orders: {strategy.name}</p><p className="panel-subtitle">The server watches your pairs, even with every tab closed</p></div>
          <span className={`mode-badge ${live ? "live-badge" : ""}`}>{live ? "LIVE ACCOUNT" : "PAPER"}</span>
        </div>

        <div className={`auto-state ${status.ordering ? "is-on" : ""}`}>
          <div>
            <strong>{status.ordering ? `Placing orders automatically (${status.armedMode === "live" ? "LIVE" : "Paper"})` : status.watching ? "Watching and notifying only: no orders" : "Off"}</strong>
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
              <label>Market<select value={draft.market} onChange={(e) => set({ market: e.target.value })}><option value="futures">Futures{canShort ? " (long and short)" : ""}</option><option value="spot">Spot (long only)</option></select></label>
              <label>Entry<select value={draft.entryMode} onChange={(e) => set({ entryMode: e.target.value })}><option value="limit-close">At the signal close</option>{strategy.supportsRetest && <option value="retest">On a retest</option>}</select></label>
              <label>Target<select value={draft.targetMode} onChange={(e) => set({ targetMode: e.target.value })}><option value="own">The strategy's own</option><option value="r">Multiple of the risk</option></select></label>
              {draft.targetMode === "r" && <label>Target (× risk)<input type="number" min="1" max="5" step="0.5" value={draft.targetR} onChange={(e) => set({ targetR: Number(e.target.value) })} /></label>}
              <label>Entry lapses after (candles)<input type="number" min="1" max="10" value={draft.expiryCandles} onChange={(e) => set({ expiryCandles: Number(e.target.value) })} /></label>
              {draft.market === "futures" && <label title="Capped by the max leverage in your Risk tab and by the liquidation check">Leverage<input type="number" min="1" max="20" value={draft.leverage} onChange={(e) => set({ leverage: Number(e.target.value) })} /></label>}
              <label>Min reward:risk<input type="number" min="0" max="5" step="0.5" value={draft.minRewardRisk} onChange={(e) => set({ minRewardRisk: Number(e.target.value) })} /></label>
              {strategy.params.map((p) => (
                <label key={p.key} title={p.hint}>{p.label}<input type="number" min={p.min} max={p.max} step={p.step ?? 1} value={draft.params[p.key]} onChange={(e) => setParam(p.key, Number(e.target.value))} /></label>
              ))}
            </div>
            <div className="bt-checks">
              <label className="switch"><input type="checkbox" checked={draft.longs} onChange={(e) => set({ longs: e.target.checked })} /> Long</label>
              {canShort && <label className="switch"><input type="checkbox" checked={draft.shorts && draft.market === "futures"} disabled={draft.market === "spot"} onChange={(e) => set({ shorts: e.target.checked })} /> Short</label>}
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
                Size and safety come from your <b>Risk tab</b>, which the server applies to every order of every strategy: {settings.riskPerTradePct}% of capital lost if a stop fills, at most {settings.maxPositionPct}% in one position, minimum reward:risk {settings.minRewardRisk}, {settings.maxLeverage}× leverage, daily loss {settings.maxDailyLossPct}%, and the pause switch.
              </p>
            )}
            <label className="switch"><input type="checkbox" checked={draft.pushSkips} onChange={(e) => set({ pushSkips: e.target.checked })} /> Also send "order not placed" messages to Telegram / webhook</label>
          </div>
        </div>

        <div className="auto-actions">
          <label className="switch"><input type="checkbox" checked={draft.watch || draft.orders} disabled={draft.orders} onChange={(e) => set({ watch: e.target.checked })} /> Watch these pairs and notify me (no orders)</label>
          <button type="button" className="mini-button accent" disabled={busy || !dirty} onClick={() => save()}>{busy ? "Saving…" : dirty ? "Save settings" : "Saved"}</button>
          <button type="button" className="mini-button" disabled={!config.pairs.length || scanning} onClick={async () => { setScanning(true); try { await scanBot(strategy.id); await reload(); } catch (err) { setError(err.message); } finally { setScanning(false); } }}>{scanning ? "Scanning…" : "Scan now"}</button>
        </div>
        {error && <p className="order-error">{error}</p>}

        {!status.ordering && (
          <div className="arm-box">
            <p className="panel-title">Arm automatic orders</p>
            <p className="an-hint">Real orders are placed on the {live ? "LIVE account with real money" : "Paper account"}. First, see how these exact settings did on recent history.</p>
            <button type="button" className="mini-button" disabled={checking || dirty || draft.pairs.length === 0} onClick={runCheck}>{checking ? "Checking history…" : checkValid ? "Check again" : "Check these settings against history"}</button>
            {dirty && <p className="an-hint">Save your settings first: the check must be for the settings that will trade.</p>}
            {checkValid && (
              <div className="arm-check">
                {check.groups.map((g) => (
                  <div className={`sa-verdict ${verdictClass(g.verdict)}`} key={g.interval}>
                    <div className="sa-verdict-row"><strong>{g.interval}: {g.verdict.label}</strong><span className="sa-score-inline">{g.stats.trades} trades · ~{Math.round(g.days)} days</span></div>
                    <p>{g.verdict.text}</p>
                  </div>
                ))}
                {minRR != null && avgRR != null && Number.isFinite(avgRR) && avgRR < minRR && (
                  <p className="order-error">Your Risk tab requires reward:risk of at least {minRR}, but these signals average {r2(avgRR)} : 1. Most orders will be refused by your own rules ("order not placed"). Lower the minimum in the Risk tab, or change the entry or target.</p>
                )}
                {bad && <label className="switch ack"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I understand these settings lost money in the backtest, and I want to trade them anyway</label>}
                {live && <label className="live-word">Type <b>LIVE</b> to confirm real money<input value={liveWord} onChange={(e) => setLiveWord(e.target.value)} placeholder="LIVE" /></label>}
                <button type="button" className="primary-button is-short" disabled={!armable || busy} onClick={() => save({ orders: true, confirm: live ? liveWord : undefined })}>Arm automatic orders on {live ? "the LIVE account" : "Paper"}</button>
                <p className="order-rule-note">Every order still passes your risk rules and gets its stop-loss and take-profit on Binance. Switching the account between Paper and Live switches the bot off. A backtest is history, not a promise.</p>
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
        <BotLog timeZone={timeZone} strategyId={strategy.id} />
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------- one strategy

function StrategyDetail({ strategy, risk, timeZone, onShowOnChart, onChartList }) {
  const [tab, setTab] = usePersistentState("pref:strategy-tab", "backtest", oneOf(["backtest", "auto"]));
  const [handoff, setHandoff] = useState(null);
  const [botConfig, setBotConfig] = useState(null);
  useEffect(() => { getBot(strategy.id).then((d) => setBotConfig(d.config)).catch(() => setBotConfig(null)); }, [strategy.id, tab]);
  const onChart = onChartList.includes(strategy.id);
  return (
    <div className="strat-detail">
      <div className="strat-head">
        <div>
          <h3>{strategy.name}</h3>
          <p>{strategy.description}</p>
          <p className="strat-tags">
            <span>{strategy.directions.length > 1 ? "long and short" : "long only"}</span>
            {strategy.params.length > 0 && <span>{strategy.params.length} setting{strategy.params.length === 1 ? "" : "s"}</span>}
            {strategy.supportsRetest && <span>retest entry</span>}
          </p>
        </div>
        <div className="strat-actions">
          <button type="button" className={`mini-button ${onChart ? "" : "accent"}`} onClick={() => onShowOnChart(strategy.id)}>{onChart ? "On the chart: open it" : "Show on the chart"}</button>
          <div className="segmented" role="tablist" aria-label="Strategy sections">
            <button type="button" role="tab" aria-selected={tab === "backtest"} className={tab === "backtest" ? "is-active" : ""} onClick={() => setTab("backtest")}>Backtest</button>
            <button type="button" role="tab" aria-selected={tab === "auto"} className={tab === "auto" ? "is-active" : ""} onClick={() => setTab("auto")}>Auto trading</button>
          </div>
        </div>
      </div>
      {tab === "backtest" && <BacktestTab key={strategy.id} strategy={strategy} timeZone={timeZone} botConfig={botConfig} onUseSettings={(patch) => { setHandoff(patch); setTab("auto"); }} />}
      {tab === "auto" && <AutoTab key={strategy.id} strategy={strategy} risk={risk} timeZone={timeZone} handoff={handoff} onHandoffUsed={() => setHandoff(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------- compare

function CompareTab({ strategies, onOpen }) {
  const [form, setForm] = usePersistentState("pref:compare-form", { market: "futures", symbols: PRESET_PAIRS, interval: "15m", candles: 3000, minRewardRisk: 1 }, (v) => v && typeof v === "object");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setResult(await compareStrategies({ market: form.market, symbols: form.symbols, interval: form.interval, candles: Number(form.candles), trade: { minRewardRisk: Number(form.minRewardRisk), longs: true, shorts: form.market === "futures" } }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const rows = result ? [...result.rows].sort((a, b) => (b.stats.trades ? b.stats.expectancyR : -99) - (a.stats.trades ? a.stats.expectancyR : -99)) : [];
  return (
    <div className="bt-layout">
      <section className="panel bt-form">
        <div className="panel-heading"><div><p className="panel-title">Compare every strategy</p><p className="panel-subtitle">Same pairs, same history, same fees, each with its default settings</p></div></div>
        <div className="fut-side-toggle" role="group" aria-label="Market">
          <button type="button" className={form.market === "futures" ? "is-on" : ""} onClick={() => set({ market: "futures" })}>Futures</button>
          <button type="button" className={form.market === "spot" ? "is-on" : ""} onClick={() => set({ market: "spot" })}>Spot (long only)</button>
        </div>
        <PairChips symbols={form.symbols} onChange={(symbols) => set({ symbols })} setError={setError} />
        <div className="bt-grid">
          <label>Timeframe<select value={form.interval} onChange={(e) => set({ interval: e.target.value })}>{INTERVALS.map((v) => <option key={v}>{v}</option>)}</select></label>
          <label>History<select value={form.candles} onChange={(e) => set({ candles: e.target.value })}><option value={1000}>1,000 candles</option><option value={3000}>3,000 candles</option><option value={5000}>5,000 candles</option></select></label>
          <label>Min reward:risk<input type="number" min="0" max="5" step="0.5" value={form.minRewardRisk} onChange={(e) => set({ minRewardRisk: e.target.value })} /></label>
        </div>
        <button type="button" className="primary-button" disabled={busy || form.symbols.length === 0} onClick={run}>{busy ? "Testing every strategy…" : "Compare all strategies"}</button>
        {busy && <p className="an-hint">Loading the history once and replaying {strategies.length} strategies: 15 to 40 seconds.</p>}
        {error && <p className="order-error">{error}</p>}
      </section>

      <section className="panel bt-output">
        {!result && !busy && <p className="log-empty">Press "Compare all strategies" to see them side by side on identical footing.</p>}
        {result && (
          <div className="bt-results">
            <div className="bt-table" role="table">
              <div className="bt-row bt-cmp bt-head" role="row"><span>Strategy</span><span>Trades</span><span>Win</span><span>Expectancy</span><span>PF</span><span>Total</span><span>Drawdown</span><span /></div>
              {rows.map((r) => (
                <div className="bt-row bt-cmp" role="row" key={r.id}>
                  <span title={r.summary}><b>{r.name}</b><small className={`cmp-verdict ${verdictClass(r.verdict)}`}>{r.verdict.label}</small></span>
                  <span>{r.stats.trades}</span>
                  <span>{r.stats.winRate == null ? "—" : `${r.stats.winRate.toFixed(0)}%`}</span>
                  <span className={tone(r.stats.trades ? r.stats.expectancyR : null)}>{signedR(r.stats.trades ? r.stats.expectancyR : null)}</span>
                  <span>{pf(r.stats)}</span>
                  <span className={tone(r.stats.trades ? r.stats.totalR : null)}>{signedR(r.stats.trades ? r.stats.totalR : null)}</span>
                  <span>{r.stats.trades ? `${r2(r.stats.equity.maxDrawdownPct, 0)}%` : "—"}</span>
                  <span><button type="button" className="link-button" onClick={() => onOpen(r.id)}>Open</button></span>
                </div>
              ))}
            </div>
            {result.pairs.some((p) => p.error) && <p className="order-error">{result.pairs.filter((p) => p.error).map((p) => `${p.symbol}: ${p.error}`).join(" · ")}</p>}
            <p className="order-rule-note">
              Every strategy enters with a limit order at its signal close and uses its own stop and target, so the table compares signals, not trade management. Read it with care: with this many strategies the best one is often just the luckiest
              (test several timeframes and other pairs before believing it), and a strategy with few trades says little.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- notifications tab

function AlertsTab({ channels, timeZone }) {
  const [permission, setPermission] = useState(desktopPermission);
  const [sound, setSound] = useState(audioState);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

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

  const tg = channels?.telegram?.configured;
  const wh = channels?.webhook?.configured;
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
          <div><b>Telegram</b><p>{tg ? "Configured: every signal, order, fill and close is also sent to your chat, even when nothing is open." : <>Not set up. Create a bot with @BotFather, send it a message, then set <code>TELEGRAM_BOT_TOKEN</code> and <code>TELEGRAM_CHAT_ID</code> in the server environment and restart.</>}</p></div>
          <span className={`chan-state ${tg ? "is-on" : "is-off"}`}>{tg ? "configured" : "not set up"}</span>
        </div>
        <div className="chan">
          <div><b>Webhook</b><p>{wh ? "Configured: each event is POSTed as JSON (title, body, plan) to your URL." : <>Not set up. Set <code>NOTIFY_WEBHOOK_URL</code> to any https address (Discord, Slack, Zapier, Make, your own server) and restart.</>}</p></div>
          <span className={`chan-state ${wh ? "is-on" : "is-off"}`}>{wh ? "configured" : "not set up"}</span>
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

const TABS = [["strategies", "Strategies"], ["compare", "Compare"], ["alerts", "Notifications"]];

export default function StrategiesPanel({ risk, timeZone = "UTC", chartStrategies = [], onShowOnChart = () => {} }) {
  const [tab, setTab] = usePersistentState("pref:strategies-tab", "strategies", oneOf(TABS.map(([id]) => id)));
  const [selected, setSelected] = usePersistentState("pref:strategy-id", "amd_fvg", (v) => typeof v === "string");
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const load = () => getStrategies().then((d) => { setList(d); setError(null); }).catch((err) => setError(err.message));
    load();
    const id = window.setInterval(load, 10_000);
    return () => window.clearInterval(id);
  }, []);

  const strategies = list?.strategies ?? [];
  const current = strategies.find((s) => s.id === selected) ?? strategies[0];
  const badge = (s) => (s.bot?.ordering ? { text: "ordering", cls: "is-order" } : s.bot?.watching ? { text: "watching", cls: "is-watch" } : null);

  return (
    <div className="amdbot-view">
      <div className="amdbot-head">
        <div>
          <h2>Strategies</h2>
          <p>Every strategy can be tested on history, shown on the chart, traded automatically, and announced. Pick one, or compare them all.</p>
        </div>
        <div className="segmented" role="tablist" aria-label="Strategy sections">
          {TABS.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "is-active" : ""} onClick={() => setTab(id)}>{label}</button>)}
        </div>
      </div>
      {error && !list && <div className="futures-notice is-error"><strong>Could not reach the server</strong><p>{error}</p></div>}

      {tab === "strategies" && list && current && (
        <div className="strat-layout">
          <nav className="strat-list" aria-label="Strategies">
            {strategies.map((s) => {
              const b = badge(s);
              return (
                <button key={s.id} type="button" className={`strat-item${s.id === current.id ? " is-active" : ""}`} aria-current={s.id === current.id} onClick={() => setSelected(s.id)}>
                  <b>{s.name}</b>
                  <span>{s.summary}</span>
                  <em>
                    {b && <i className={`strat-badge ${b.cls}`}>{b.text}</i>}
                    {chartStrategies.includes(s.id) && <i className="strat-badge is-chart">on chart</i>}
                  </em>
                </button>
              );
            })}
          </nav>
          <StrategyDetail key={current.id} strategy={current} risk={risk} timeZone={timeZone} onShowOnChart={onShowOnChart} onChartList={chartStrategies} />
        </div>
      )}
      {tab === "compare" && list && <CompareTab strategies={strategies} onOpen={(id) => { setSelected(id); setTab("strategies"); }} />}
      {tab === "alerts" && list && <AlertsTab channels={list.channels} timeZone={timeZone} />}
    </div>
  );
}
