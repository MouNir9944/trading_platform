import { useEffect, useState } from "react";

import { SESSIONS, STRATEGIES, backtest, currentSession, hourlyProfile, sessionLocalRange, tzLabel } from "../../shared/analysis/index.js";

const TREND_LABELS = {
  uptrend: ["Uptrend", "up", "Higher highs and higher lows"],
  downtrend: ["Downtrend", "down", "Lower highs and lower lows"],
  "weak-uptrend": ["Weak uptrend", "up", "Mixed swings, leaning up"],
  "weak-downtrend": ["Weak downtrend", "down", "Mixed swings, leaning down"],
  range: ["Range", "flat", "No clear sequence of swings"],
};

const BIAS_LABELS = { bullish: "Bullish lean", bearish: "Bearish lean", neutral: "Neutral" };

export default function AnalysisPanel({ analysis, symbol, interval, currentPrice, feePercent, loadHistory, loadHourly, timeZone = "UTC", onApply, canApply = true }) {
  const [results, setResults] = useState({});
  const [busy, setBusy] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [error, setError] = useState(null);
  const [hours, setHours] = useState(null);
  const [hoursBusy, setHoursBusy] = useState(false);

  // Backtests belong to one pair + timeframe.
  useEffect(() => {
    setResults({});
    setExpanded(null);
    setError(null);
  }, [symbol, interval]);

  useEffect(() => setHours(null), [symbol]);

  if (!analysis) {
    return <p className="log-empty">Waiting for at least 30 candles of {symbol} to analyse.</p>;
  }

  const { structure, latest, signals, summary } = analysis;
  const price = currentPrice ?? latest.close;
  // Stops and targets are measured from the candle the signals were judged on.
  const evalClose = analysis.ctx.candles[analysis.evalIndex].close;
  const [trendName, trendTone, trendHint] = TREND_LABELS[structure.trend] ?? TREND_LABELS.range;
  const lastBreak = structure.breaks[structure.breaks.length - 1];
  const barsSinceBreak = lastBreak ? analysis.ctx.candles.length - 1 - lastBreak.index : null;
  const support = structure.supports[0];
  const resistance = structure.resistances[0];

  async function findBusyHours() {
    setHoursBusy(true);
    setError(null);
    try {
      const candles = await loadHourly();
      if (candles.length < 72) throw new Error("Not enough hourly history for this pair");
      setHours(hourlyProfile(candles, timeZone));
    } catch (err) {
      setError(err.message);
    } finally {
      setHoursBusy(false);
    }
  }

  async function runBacktest(id) {
    setExpanded(id);
    if (results[id]) return;
    setBusy(id);
    setError(null);
    try {
      const candles = await loadHistory();
      if (candles.length < 120) throw new Error("Not enough history to backtest this pair and timeframe");
      const result = backtest(candles, id, { feePercent });
      setResults((prev) => ({ ...prev, [id]: { ...result, from: candles[0].time, to: candles[candles.length - 1].time } }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  function apply(signal) {
    const entry = price;
    const base = evalClose;
    const stopLossPercent = Math.max(0.1, ((base - signal.stopLoss) / base) * 100);
    const takeProfitPercent = Math.max(0.1, ((signal.takeProfit - base) / base) * 100);
    onApply({
      entry,
      stopLossPercent: Number(stopLossPercent.toFixed(2)),
      takeProfitPercent: Number(takeProfitPercent.toFixed(2)),
    });
  }

  return (
    <div className="analysis">
      <section className="an-card">
        <div className="an-head">
          <h3>Market structure</h3>
          <span className={`tone-chip tone-${trendTone}`}>{trendName}</span>
        </div>
        <p className="an-hint">{trendHint}. Judged on swing highs and lows ({structure.swings.length} found).</p>
        <dl className="an-rows">
          <div>
            <dt>Last structure break</dt>
            <dd>
              {lastBreak
                ? <><b className={lastBreak.direction === "bull" ? "profit-estimate" : "loss-estimate"}>{lastBreak.direction === "bull" ? "Bullish" : "Bearish"} {lastBreak.type}</b> · {barsSinceBreak === 0 ? "this candle" : `${barsSinceBreak} candles ago`}</>
                : "None in view"}
            </dd>
          </div>
          <div>
            <dt>Nearest resistance</dt>
            <dd>{resistance ? <>{fmt(resistance.price)} <em>+{pct(resistance.price, price)}% · {resistance.touches}×</em></> : "—"}</dd>
          </div>
          <div>
            <dt>Nearest support</dt>
            <dd>{support ? <>{fmt(support.price)} <em>−{pct(price, support.price)}% · {support.touches}×</em></> : "—"}</dd>
          </div>
        </dl>
      </section>

      <section className="an-card">
        <div className="an-head">
          <h3>Indicators</h3>
          <span className="an-note">last price {fmt(latest.close)}</span>
        </div>
        <div className="ind-grid">
          <Indicator label="RSI 14" value={num(latest.rsi, 1)} tag={rsiTag(latest.rsi)} />
          <Indicator label="MACD hist" value={num(latest.macd.histogram, 6)} tag={latest.macd.histogram == null ? null : latest.macd.histogram >= 0 ? ["bullish", "up"] : ["bearish", "down"]} />
          <Indicator label="Bollinger %B" value={num(latest.bollinger.percentB, 2)} tag={bbTag(latest.bollinger)} />
          <Indicator label="ATR 14" value={latest.atrPercent == null ? "—" : `${latest.atrPercent.toFixed(2)}%`} tag={["of price", "flat"]} />
          <Indicator label="Stoch %K" value={num(latest.stochastic.k, 0)} tag={stochTag(latest.stochastic.k)} />
          <Indicator label="ADX 14" value={num(latest.adx.value, 0)} tag={adxTag(latest.adx)} />
          <Indicator label="Supertrend" value={latest.supertrend.direction === 1 ? "Up" : latest.supertrend.direction === -1 ? "Down" : "—"} tag={latest.supertrend.direction === 1 ? ["long", "up"] : latest.supertrend.direction === -1 ? ["short", "down"] : null} />
          <Indicator label="vs EMA 50" value={latest.ema50 == null ? "—" : `${latest.close >= latest.ema50 ? "+" : "−"}${pct(Math.max(latest.close, latest.ema50), Math.min(latest.close, latest.ema50))}%`} tag={latest.ema50 == null ? null : latest.close >= latest.ema50 ? ["above", "up"] : ["below", "down"]} />
          <Indicator label="Volume" value={latest.volumeRatio == null ? "—" : `${latest.volumeRatio.toFixed(1)}×`} tag={["vs 20-avg", "flat"]} />
        </div>
      </section>

      <SmcCard smc={analysis.smc} price={price} />

      <TradingHours
        timeZone={timeZone}
        hours={hours}
        busy={hoursBusy}
        symbol={symbol}
        onFind={findBusyHours}
      />

      <section className="an-card">
        <div className="an-head">
          <h3>Strategies</h3>
          <span className={`tone-chip tone-${summary.bias === "bullish" ? "up" : summary.bias === "bearish" ? "down" : "flat"}`}>{BIAS_LABELS[summary.bias]}</span>
        </div>
        <p className="an-hint">
          {summary.buys} buy · {summary.sells} exit · {summary.holds} wait. Judged on the last closed candle
          ({new Date(analysis.evalTime * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}).
        </p>
        {error && <p className="order-error">{error}</p>}
        <ul className="strategy-list">
          {signals.map((signal) => {
            const strategy = STRATEGIES.find((s) => s.id === signal.id);
            const result = results[signal.id];
            const open = expanded === signal.id;
            return (
              <li key={signal.id} className={`strategy ${open ? "is-open" : ""}`}>
                <div className="strategy-top">
                  <div className="strategy-name">
                    <strong>{signal.name}</strong>
                    <span>{signal.reasons.join(" · ")}</span>
                  </div>
                  <b className={`signal-pill ${signal.signal}`}>{signal.signal === "SELL" ? "EXIT" : signal.signal}</b>
                </div>
                {signal.signal === "BUY" && (
                  <div className="setup-line">
                    <span>SL {fmt(signal.stopLoss)} · TP {fmt(signal.takeProfit)} · R:R {(((signal.takeProfit - evalClose) / (evalClose - signal.stopLoss)) || 0).toFixed(1)}</span>
                    {canApply && <button type="button" className="mini-button accent" onClick={() => apply(signal)}>Use setup</button>}
                  </div>
                )}
                <div className="strategy-actions">
                  <button type="button" className="mini-button" onClick={() => (open ? setExpanded(null) : runBacktest(signal.id))} disabled={busy === signal.id}>
                    {busy === signal.id ? "Testing…" : open ? "Hide backtest" : result ? "Show backtest" : "Backtest"}
                  </button>
                </div>
                {open && (
                  <div className="backtest">
                    <p className="an-hint">{strategy.description}</p>
                    {busy === signal.id && <p className="an-hint">Loading up to 1000 candles and replaying the strategy…</p>}
                    {result && <BacktestResult result={result} />}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <p className="an-disclaimer">
          Signals are indicators, not advice. A backtest replays the past with fees and worst-case fills; it does not predict the future. Use setup only fills the order ticket, and nothing is placed until you press the button there.
        </p>
      </section>
    </div>
  );
}

function BacktestResult({ result }) {
  const { stats, equity, trades } = result;
  if (!stats.trades) {
    return <p className="an-hint">No trades in this period ({stats.candles} candles). The strategy never signalled a valid entry.</p>;
  }
  const tone = stats.totalReturnPct >= 0 ? "profit-estimate" : "loss-estimate";
  const beat = stats.totalReturnPct - (stats.buyHoldPct ?? 0);
  return (
    <div>
      <div className="bt-grid">
        <Stat label="Return" value={`${signed(stats.totalReturnPct)}%`} tone={tone} />
        <Stat label="Buy & hold" value={`${signed(stats.buyHoldPct)}%`} />
        <Stat label="Trades" value={stats.trades} />
        <Stat label="Win rate" value={`${stats.winRate.toFixed(0)}%`} />
        <Stat label="Profit factor" value={stats.profitFactor === Infinity ? "∞" : stats.profitFactor == null ? "—" : stats.profitFactor.toFixed(2)} />
        <Stat label="Max drawdown" value={`−${stats.maxDrawdownPct.toFixed(1)}%`} tone="loss-estimate" />
        <Stat label="Avg win" value={stats.avgWinPct == null ? "—" : `+${stats.avgWinPct.toFixed(2)}%`} />
        <Stat label="Avg loss" value={stats.avgLossPct == null ? "—" : `${stats.avgLossPct.toFixed(2)}%`} />
        <Stat label="Per trade" value={`${signed(stats.expectancyPct, 2)}%`} />
      </div>
      <Sparkline equity={equity} />
      <p className="an-hint">
        {new Date(result.from * 1000).toLocaleDateString()} → {new Date(result.to * 1000).toLocaleDateString()} · {stats.candles} candles ·
        {" "}{beat >= 0 ? "beat" : "trailed"} buy & hold by {Math.abs(beat).toFixed(1)} pts.
        {stats.trades < 20 && " Few trades: treat these numbers as anecdotal, not proof."}
        {trades.some((t) => t.open) && " Includes one trade still open at the end."}
      </p>
    </div>
  );
}

function Sparkline({ equity }) {
  if (equity.length < 2) return null;
  const values = [1, ...equity.map((p) => p.equity)];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values.map((v, i) => `${(i / (values.length - 1)) * 100},${30 - ((v - min) / span) * 28 - 1}`).join(" ");
  const up = values[values.length - 1] >= 1;
  return (
    <svg className="sparkline" viewBox="0 0 100 30" preserveAspectRatio="none" role="img" aria-label="Equity curve">
      <line x1="0" x2="100" y1={30 - ((1 - min) / span) * 28 - 1} y2={30 - ((1 - min) / span) * 28 - 1} className="spark-base" />
      <polyline points={points} className={up ? "spark-up" : "spark-down"} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Stat({ label, value, tone = "" }) {
  return <div className="bt-stat"><span>{label}</span><b className={tone}>{value}</b></div>;
}

function Indicator({ label, value, tag }) {
  return (
    <div className="ind">
      <span>{label}</span>
      <b>{value}</b>
      {tag && <em className={`tag-${tag[1]}`}>{tag[0]}</em>}
    </div>
  );
}

const num = (v, digits) => (v == null ? "—" : Number(v).toFixed(digits));
const fmt = (v) => (v == null ? "—" : v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(4) : v.toFixed(6));
const pct = (a, b) => (((a - b) / b) * 100).toFixed(2);
const signed = (v, digits = 1) => (v == null ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(digits)}`);

function rsiTag(v) {
  if (v == null) return null;
  return v < 30 ? ["oversold", "up"] : v > 70 ? ["overbought", "down"] : ["neutral", "flat"];
}
function stochTag(v) {
  if (v == null) return null;
  return v < 20 ? ["oversold", "up"] : v > 80 ? ["overbought", "down"] : ["neutral", "flat"];
}
function bbTag(b) {
  if (b.percentB == null) return null;
  if (b.squeeze) return ["squeeze", "hold"];
  return b.percentB > 1 ? ["above band", "down"] : b.percentB < 0 ? ["below band", "up"] : ["inside", "flat"];
}
function adxTag({ value, plusDi, minusDi }) {
  if (value == null) return null;
  const strength = value >= 25 ? "strong" : value >= 18 ? "building" : "weak";
  return [`${strength} ${plusDi >= minusDi ? "↑" : "↓"}`, value >= 18 ? (plusDi >= minusDi ? "up" : "down") : "flat"];
}


const pad = (h) => `${String(h).padStart(2, "0")}:00`;

/** Which session is open now (in your local time) and when the market is usually busiest. */
function TradingHours({ timeZone, hours, busy, symbol, onFind }) {
  const now = new Date();
  const { session, next, minutesLeft } = currentSession(now);
  const localNow = now.toLocaleTimeString("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const currentHour = Number(localNow.slice(0, 2));
  const left = `${Math.floor(minutesLeft / 60)}h ${String(minutesLeft % 60).padStart(2, "0")}m`;
  const range = (hs) => {
    const runs = [];
    for (const h of hs) {
      const last = runs[runs.length - 1];
      if (last && h === (last.to + 1) % 24) last.to = h;
      else runs.push({ from: h, to: h });
    }
    return runs.map((r) => (r.from === r.to ? pad(r.from) : `${pad(r.from)}–${pad((r.to + 1) % 24)}`)).join(", ");
  };

  return (
    <section className="an-card">
      <div className="an-head">
        <h3>Trading hours</h3>
        <span className="an-note">{localNow} {tzLabel(timeZone, now)}</span>
      </div>
      <p className="an-hint">
        Crypto trades 24/7, but activity and price moves cluster around the sessions below. Now: <b style={{ color: session.color }}>{session.name}</b>,
        {" "}{left} left, then {next.name}.
      </p>
      <ul className="session-list">
        {SESSIONS.map((s) => (
          <li key={s.id} className={s.id === session.id ? "is-now" : ""}>
            <i style={{ background: s.color }} />
            <span>{s.name}</span>
            <b>{sessionLocalRange(s, timeZone, now)}</b>
          </li>
        ))}
      </ul>
      <p className="an-hint">Session hours are approximate (they shift an hour with daylight saving).</p>

      {hours ? (
        <>
          <div className="hour-bars" role="img" aria-label={`Average trading activity by hour for ${symbol}`}>
            {hours.hours.map((h) => (
              <div
                key={h.hour}
                className={`hour-bar ${hours.top.includes(h.hour) ? "is-top" : ""} ${hours.quiet.includes(h.hour) ? "is-quiet" : ""} ${h.hour === currentHour ? "is-now" : ""}`}
                title={`${pad(h.hour)}: volume ${h.activity >= 1 ? "peak" : `${Math.round(h.activity * 100)}% of peak`}, average candle range ${h.avgRangePct.toFixed(2)}%`}
              >
                <span style={{ height: `${Math.max(4, h.activity * 100)}%` }} />
                <em>{h.hour % 3 === 0 ? String(h.hour).padStart(2, "0") : ""}</em>
              </div>
            ))}
          </div>
          <p className="an-hint">
            <b>Busiest ({tzLabel(timeZone, now)}):</b> {range(hours.top)}. <b>Quietest:</b> {range(hours.quiet)}.
            {" "}Based on about {hours.days} days of {symbol} hourly volume; the outlined bar is the hour it is now.
          </p>
        </>
      ) : (
        <button type="button" className="mini-button accent" onClick={onFind} disabled={busy}>
          {busy ? "Analysing…" : `Find busiest hours for ${symbol}`}
        </button>
      )}
    </section>
  );
}

/** Fair value gaps, order blocks, liquidity and premium/discount, nearest to the current price first. */
function SmcCard({ smc, price }) {
  if (!smc) return null;
  const distance = (top, bottom) => (price > top ? ((price - top) / price) * 100 : price < bottom ? ((bottom - price) / price) * 100 : 0);
  const where = (top, bottom) => (price > top ? `${distance(top, bottom).toFixed(2)}% below price` : price < bottom ? `${distance(top, bottom).toFixed(2)}% above price` : "price is inside it");
  const range = (a, b) => `${fmt(Math.min(a, b))} – ${fmt(Math.max(a, b))}`;
  const nearest = (list) => [...list].sort((a, b) => distance(a.top, a.bottom) - distance(b.top, b.bottom)).slice(0, 3);

  const gaps = nearest(smc.fvgs.filter((g) => g.filledAt == null));
  const blocks = nearest(smc.orderBlocks.filter((b) => b.mitigatedAt == null));
  const pools = smc.liquidity.filter((p) => p.brokenAt == null);
  const openPools = pools.filter((p) => p.sweptAt == null).sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price)).slice(0, 3);
  const sweeps = pools.filter((p) => p.sweptAt != null).slice(-2);
  const pd = smc.premiumDiscount;
  const zoneTone = { premium: "down", discount: "up", equilibrium: "flat" };

  return (
    <section className="an-card">
      <div className="an-head">
        <h3>Smart money concepts</h3>
        {pd && <span className={`tone-chip tone-${zoneTone[pd.zone]}`}>{pd.zone === "equilibrium" ? "Equilibrium" : pd.zone === "premium" ? "Premium" : "Discount"} {Math.round(pd.position * 100)}%</span>}
      </div>
      <p className="an-hint">
        {pd
          ? <>Price is in the <b>{pd.zone}</b> half of its swing range ({range(pd.high, pd.low)}){pd.brokeOut ? `, having broken out ${pd.brokeOut} it` : ""}. Discount favours buying, premium favours selling; the middle is neutral.</>
          : "Not enough swings yet to define a range."}
      </p>

      <h4 className="smc-title">Fair value gaps <em>(open)</em></h4>
      <ul className="smc-list">
        {gaps.length === 0 && <li className="smc-empty">None open in view.</li>}
        {gaps.map((g) => (
          <li key={`g${g.index}`}>
            <i className={`smc-dot ${g.type === "bull" ? "up" : "down"}`} />
            <span><b>{g.type === "bull" ? "Bullish" : "Bearish"}</b> {range(g.top, g.bottom)}</span>
            <em>{where(g.top, g.bottom)}{g.touchedAt != null ? ` · ${Math.round(g.fillPct * 100)}% filled` : ""}</em>
          </li>
        ))}
      </ul>

      <h4 className="smc-title">Order blocks <em>(unmitigated)</em></h4>
      <ul className="smc-list">
        {blocks.length === 0 && <li className="smc-empty">None in view.</li>}
        {blocks.map((b) => (
          <li key={`b${b.index}`}>
            <i className={`smc-dot ${b.type === "bull" ? "up" : "down"}`} />
            <span><b>{b.type === "bull" ? "Bullish" : "Bearish"}</b> {range(b.top, b.bottom)}</span>
            <em>{where(b.top, b.bottom)} · from a {b.breakType}</em>
          </li>
        ))}
      </ul>

      <h4 className="smc-title">Liquidity <em>(equal highs / lows)</em></h4>
      <ul className="smc-list">
        {openPools.length === 0 && sweeps.length === 0 && <li className="smc-empty">No equal highs or lows nearby.</li>}
        {openPools.map((p) => (
          <li key={`p${p.firstIndex}${p.type}`}>
            <i className={`smc-dot ${p.type === "high" ? "down" : "up"}`} />
            <span><b>{p.type === "high" ? "Equal highs" : "Equal lows"}</b> {fmt(p.price)} ×{p.touches}</span>
            <em>{p.type === "high" ? "buy stops above" : "sell stops below"} · {(Math.abs(p.price - price) / price * 100).toFixed(2)}% {p.price > price ? "above" : "below"}</em>
          </li>
        ))}
        {sweeps.map((p) => (
          <li key={`s${p.firstIndex}${p.type}`}>
            <i className="smc-dot flat" />
            <span><b>{p.type === "high" ? "Highs" : "Lows"} swept</b> {fmt(p.price)}</span>
            <em>wicked through and closed back: a liquidity grab</em>
          </li>
        ))}
      </ul>
      <p className="an-hint">Zones are drawn on the chart when the FVG, Order blocks, Liquidity or Prem/Disc chips are on. A gap is filled once price trades fully through it, and a block is mitigated once price closes through it.</p>
    </section>
  );
}
