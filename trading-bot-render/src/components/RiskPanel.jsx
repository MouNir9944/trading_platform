import { useEffect, useState } from "react";

import { RISK_DEFAULTS, checkOrder, lossAfterStreak } from "../../shared/risk.js";
import { usePersistentState, isText } from "../lib/persist.js";

const FIELDS = [
  ["riskPerTradePct", "Risk per trade", "%", "0.1", "Max % of capital lost if a stop-loss fills (fees included)."],
  ["maxPositionPct", "Max position size", "%", "1", "Max % of capital in one position."],
  ["maxOpenRiskPct", "Max open risk", "%", "0.5", "Total % of capital at risk across all open orders."],
  ["minRewardRisk", "Min reward : risk", "×", "0.1", "Refuse trades whose target is closer than this multiple of the risk. 0 = off."],
  ["maxDailyLossPct", "Daily loss limit", "%", "0.5", "Stop trading for the UTC day once net P/L is this far below zero."],
  ["maxLossStreak", "Losing streak", "trades", "1", "Losses in a row that trigger a cooldown."],
  ["cooldownMinutes", "Cooldown", "min", "5", "How long to pause after that streak."],
  ["maxDrawdownPct", "Max drawdown", "%", "1", "Halt when equity falls this far from its peak (until you reset it)."],
  ["maxLeverage", "Max leverage", "×", "1", "Futures only: the highest leverage an order may use."],
];

const money = (n, digits = 2) => (n == null ? "—" : `${n < 0 ? "−" : ""}${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`);

/** The Risk tab: status, meters, position-size calculator, rules editor and performance stats. */
export default function RiskPanel({ risk, currentPrice, feePercent, availableQuote, onSave, onResetDrawdown, onUseSetup }) {
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [stopPct, setStopPct] = usePersistentState("pref:risk-calc-stop-percent", "1", isText);
  const [rr, setRr] = usePersistentState("pref:risk-calc-reward-risk", "2", isText);

  const settings = risk?.settings;
  // Reset the form only when the saved values really change: the data is re-fetched every few seconds
  // and that must not wipe what you are typing.
  const settingsKey = settings ? JSON.stringify(settings) : "";
  useEffect(() => {
    if (settings) setDraft(Object.fromEntries([...FIELDS.map(([key]) => [key, String(settings[key])]), ["fixedCapital", String(settings.fixedCapital)]]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsKey]);

  if (!risk || !draft) return <p className="log-empty">Loading risk data…</p>;
  const { state, stats } = risk;

  const dirty = FIELDS.some(([key]) => Number(draft[key]) !== settings[key]) || Number(draft.fixedCapital) !== settings.fixedCapital;

  async function save(patch) {
    setSaving(true);
    setError(null);
    try {
      await onSave(patch);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function resetDrawdown() {
    setSaving(true);
    setError(null);
    try {
      await onResetDrawdown();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const saveDraft = () => save({ ...Object.fromEntries(FIELDS.map(([key]) => [key, Number(draft[key])])), fixedCapital: Number(draft.fixedCapital) });

  // ---- position-size calculator: ask the same rules the server enforces ----
  const stop = Number(stopPct);
  const ratio = Number(rr);
  const calcReady = state.capitalKnown && currentPrice > 0 && stop > 0 && stop < 100 && ratio > 0;
  let calc = null;
  if (calcReady) {
    const entry = currentPrice;
    const stopPrice = entry * (1 - stop / 100);
    // The ratio is measured AFTER fees, so the suggested target always earns `ratio` times what the stop loses.
    const f = feePercent / 100;
    const netRiskPerUnit = entry * (1 + f) - stopPrice * (1 - f);
    const targetPrice = (entry * (1 + f) + ratio * netRiskPerUnit) / (1 - f);
    const probe = checkOrder({ settings, state, order: { entry, stop: stopPrice, target: targetPrice, quantity: 1, feePercent } });
    const value = Math.max(0, probe.suggestedPositionValue ?? 0);
    const quantity = value / entry;
    const sized = checkOrder({ settings, state, order: { entry, stop: stopPrice, target: targetPrice, quantity, feePercent } });
    const capitalNeeded = value / (1 - feePercent / 100);
    calc = { value, quantity, sized, capitalNeeded, entry, stopPrice, targetPrice, percentOfAvailable: availableQuote > 0 ? (capitalNeeded / availableQuote) * 100 : null };
  }

  const statusMeta = {
    ok: ["Within limits", "ok", "All risk rules are satisfied."],
    warning: ["Close to a limit", "warn", "You are using most of a risk budget. New orders may be refused soon."],
    halted: ["Trading halted", "bad", "New orders are blocked until the reasons below clear."],
    off: ["Limits switched off", "off", "Risk limits are disabled. Only the kill switch applies."],
  }[state.status];

  return (
    <div className="risk">
      <section className={`risk-banner is-${statusMeta[1]}`}>
        <div>
          <strong>{statusMeta[0]}</strong>
          <p>{statusMeta[2]}</p>
        </div>
        <button type="button" className={`mini-button ${settings.paused ? "accent" : ""}`} disabled={saving} onClick={() => save({ paused: !settings.paused })}>
          {settings.paused ? "Resume trading" : "Pause trading"}
        </button>
      </section>

      {state.blockers.length > 0 && (
        <ul className="risk-blockers">
          {state.blockers.map((b) => <li key={b.code}>{b.message}</li>)}
          {state.blockers.some((b) => b.code === "drawdown") && <li><button type="button" className="mini-button" disabled={saving} onClick={resetDrawdown}>Reset drawdown baseline</button></li>}
        </ul>
      )}
      {risk.balanceError && <p className="order-error">Could not read the account balance: {risk.balanceError}. Limits that depend on capital are not checked until it loads.</p>}
      {error && <p className="order-error">{error}</p>}

      <section className="an-card">
        <div className="an-head">
          <h3>Capital and limits</h3>
          <span className="an-note">{settings.capitalMode === "fixed" ? "fixed amount" : "account equity"}</span>
        </div>
        <p className="risk-capital">{state.capitalKnown ? <>{money(state.capital)} <small>USDT</small></> : "Unknown"}</p>
        <div className="meters">
          <Meter label="Today's P/L" value={`${state.todayPnl >= 0 ? "+" : "−"}${money(Math.abs(state.todayPnl))} USDT`} hint={state.dailyLossLimit != null ? `limit −${money(state.dailyLossLimit)}` : ""} usage={state.usage.dailyLoss} />
          <Meter label="Open risk" value={`${money(state.openRisk)} USDT`} hint={state.openRiskPct != null ? `${state.openRiskPct.toFixed(2)}% of ${settings.maxOpenRiskPct}%` : ""} usage={state.usage.openRisk} />
          <Meter label="Drawdown" value={`${money(state.drawdownUsd)} USDT`} hint={state.drawdownPct != null ? `${state.drawdownPct.toFixed(1)}% of ${settings.maxDrawdownPct}%` : ""} usage={state.usage.drawdown} />
          <Meter label="Losing streak" value={`${state.lossStreak}`} hint={`of ${settings.maxLossStreak} allowed`} usage={state.usage.lossStreak} />
        </div>
      </section>

      <section className="an-card">
        <div className="an-head"><h3>Position size calculator</h3></div>
        <p className="an-hint">How much to buy so that a stop-out costs about {settings.riskPerTradePct}% of capital, within your other limits.</p>
        <div className="calc-inputs">
          <label>Stop-loss below entry<span><input type="number" step="0.1" min="0.05" value={stopPct} onChange={(e) => setStopPct(e.target.value)} /> %</span></label>
          <label>Target (reward : risk, after fees)<span><input type="number" step="0.1" min="0.1" value={rr} onChange={(e) => setRr(e.target.value)} /> ×</span></label>
        </div>
        {calc ? (
          <>
            <dl className="an-rows">
              <div><dt>Position size</dt><dd><b>{money(calc.value)}</b> USDT{state.capital ? <em> · {((calc.value / state.capital) * 100).toFixed(1)}% of capital</em> : null}</dd></div>
              <div><dt>Quantity at {money(calc.entry, 4)}</dt><dd>{calc.quantity.toFixed(4)}</dd></div>
              <div><dt>Lost if stopped</dt><dd className="loss-estimate">−{money(calc.sized.riskUsd)} USDT<em> · {calc.sized.riskPct?.toFixed(2)}%</em></dd></div>
              <div><dt>Gained at target</dt><dd className="profit-estimate">+{money(calc.sized.rewardUsd)} USDT</dd></div>
            </dl>
            {calc.value <= 0 && <p className="order-error">Your current limits leave no room for a new position with this stop.</p>}
            {!calc.sized.allowed && calc.value > 0 && <ul className="risk-violations">{calc.sized.violations.map((v) => <li key={v.code}>{v.message}</li>)}</ul>}
            <button
              type="button"
              className="mini-button accent"
              disabled={calc.value <= 0 || calc.percentOfAvailable == null}
              onClick={() => onUseSetup({ entry: calc.entry, stopLossPercent: stop, takeProfitPercent: Math.ceil((calc.targetPrice / calc.entry - 1) * 10000) / 100, capitalPercent: Math.min(100, Math.floor(calc.percentOfAvailable * 100) / 100) })}
            >
              Use in trade ticket
            </button>
          </>
        ) : <p className="an-hint">Waiting for the price and account capital…</p>}
      </section>

      <section className="an-card">
        <div className="an-head">
          <h3>Rules</h3>
          <label className="switch"><input type="checkbox" checked={settings.enabled} disabled={saving} onChange={(e) => save({ enabled: e.target.checked })} /> Enforce limits</label>
        </div>
        <p className="an-hint">Enforced by the server on every order, so no screen can bypass them. Changes apply to the next order.</p>
        <div className="rule-grid">
          <label className="rule wide">
            <span>Capital base</span>
            <select value={settings.capitalMode} disabled={saving} onChange={(e) => save({ capitalMode: e.target.value })}>
              <option value="auto">Account equity (USDT balance + open positions)</option>
              <option value="fixed">A fixed amount</option>
            </select>
          </label>
          {settings.capitalMode === "fixed" && (
            <label className="rule wide"><span>Fixed capital</span><span><input type="number" min="1" value={draft.fixedCapital} onChange={(e) => setDraft({ ...draft, fixedCapital: e.target.value })} /> USDT</span></label>
          )}
          {FIELDS.map(([key, label, unit, step, help]) => (
            <label className="rule" key={key} title={help}>
              <span>{label}</span>
              <span><input type="number" step={step} value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} /> {unit}</span>
            </label>
          ))}
        </div>
        <div className="rule-actions">
          <button type="button" className="mini-button accent" disabled={!dirty || saving} onClick={saveDraft}>{saving ? "Saving…" : "Save rules"}</button>
          <button type="button" className="mini-button" disabled={saving} onClick={() => save(Object.fromEntries(Object.entries(RISK_DEFAULTS).filter(([k]) => k !== "drawdownResetAt" && k !== "paused")))}>Restore defaults</button>
        </div>
        <p className="an-hint">
          At {settings.riskPerTradePct}% risk per trade, {settings.maxLossStreak} losses in a row cost about {(lossAfterStreak(settings.riskPerTradePct, settings.maxLossStreak) * 100).toFixed(1)}% of capital and 10 in a row about {(lossAfterStreak(settings.riskPerTradePct, 10) * 100).toFixed(1)}%.
        </p>
      </section>

      <section className="an-card">
        <div className="an-head"><h3>Your results</h3><span className="an-note">{stats.trades} closed {risk.mode} trades</span></div>
        {stats.trades === 0 ? <p className="an-hint">No closed trades yet. Statistics appear after your first completed trade.</p> : (
          <div className="bt-grid">
            <Stat label="Total P/L" value={`${stats.totalPnl >= 0 ? "+" : "−"}${money(Math.abs(stats.totalPnl))}`} tone={stats.totalPnl >= 0 ? "profit-estimate" : "loss-estimate"} />
            <Stat label="Win rate" value={`${stats.winRate.toFixed(0)}%`} />
            <Stat label="Profit factor" value={stats.profitFactor === Infinity ? "∞" : stats.profitFactor == null ? "—" : stats.profitFactor.toFixed(2)} />
            <Stat label="Avg win" value={stats.avgWin == null ? "—" : `+${money(stats.avgWin)}`} />
            <Stat label="Avg loss" value={stats.avgLoss == null ? "—" : money(stats.avgLoss)} />
            <Stat label="Per trade" value={`${stats.expectancy >= 0 ? "+" : "−"}${money(Math.abs(stats.expectancy))}`} />
            <Stat label="Best" value={`+${money(stats.best)}`} />
            <Stat label="Worst" value={money(stats.worst)} />
            <Stat label="Max drawdown" value={`−${money(stats.maxDrawdownUsd)}`} tone="loss-estimate" />
          </div>
        )}
        {stats.trades > 0 && stats.trades < 30 && <p className="an-hint">With fewer than 30 trades these numbers say little about your real edge.</p>}
      </section>
    </div>
  );
}

function Meter({ label, value, hint, usage }) {
  const pct = usage == null ? 0 : Math.min(100, usage * 100);
  const tone = usage == null ? "" : usage >= 1 ? "bad" : usage >= 0.7 ? "warn" : "ok";
  return (
    <div className="meter">
      <div className="meter-top"><span>{label}</span><b>{value}</b></div>
      <div className={`meter-bar ${tone}`} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /></div>
      <small>{hint}</small>
    </div>
  );
}

function Stat({ label, value, tone = "" }) {
  return <div className="bt-stat"><span>{label}</span><b className={tone}>{value}</b></div>;
}

