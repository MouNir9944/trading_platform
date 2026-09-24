import { useEffect, useMemo, useState } from "react";

import { checkOrder, riskSetup } from "../../shared/risk.js";
import { closeFuturesPosition, createFuturesOrder, setPaperBalance } from "../api.js";
import { usePersistentState, oneOf, isText } from "../lib/persist.js";

const FEE_PERCENT = 0.05; // the server uses your real commission rate; this is only for the preview

const fmt = (value, digits = 2) => (value == null || !Number.isFinite(Number(value)) ? "—" : Number(value).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits }));
const price = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: n >= 1000 ? 2 : n >= 1 ? 4 : 6 });
};
const round = (n, digits) => Math.round(n * 10 ** digits) / 10 ** digits;

/**
 * Futures trade ticket: long or short with leverage on isolated margin. The stop-loss and take-profit are
 * placed on Binance once the entry fills. Every limit shown here is also enforced on the server.
 */
export default function FuturesTicket({
  symbol, currentPrice, mode, account, accountError, risk, analysis, symbolInfo, orders, plan, limitsRow, orderLimitReached,
  onOrdersChange, onRiskRefresh, onAccountRefresh, onDraftChange = () => {},
}) {
  const [side, setSide] = usePersistentState("pref:futures-side", "long", oneOf(["long", "short"]));
  const [entryPrice, setEntryPrice] = useState("");
  const [leverage, setLeverage] = usePersistentState("pref:futures-leverage", "3", isText);
  const [marginPercent, setMarginPercent] = usePersistentState("pref:futures-margin-percent", "10", isText);
  const [stopPct, setStopPct] = usePersistentState("pref:futures-stop-percent", "1", isText);
  const [targetPct, setTargetPct] = usePersistentState("pref:futures-target-percent", "2", isText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [closing, setClosing] = useState(null);
  const [editingBalance, setEditingBalance] = useState(false);
  const [balanceDraft, setBalanceDraft] = useState("");
  const [autoRisk, setAutoRisk] = useState(() => {
    try { return window.localStorage.getItem("auto-risk-futures") !== "0"; } catch { return true; }
  });

  const settings = risk?.settings;
  const maxLeverage = settings?.maxLeverage ?? 5;
  const lev = Math.max(1, Math.floor(Number(leverage) || 1));
  const available = account?.available ?? 0;
  const wallet = account?.wallet ?? 0;
  const entry = Number(entryPrice);
  const short = side === "short";
  const stopPrice = short ? entry * (1 + Number(stopPct) / 100) : entry * (1 - Number(stopPct) / 100);
  const targetPrice = short ? entry * (1 - Number(targetPct) / 100) : entry * (1 + Number(targetPct) / 100);
  const margin = (available * Number(marginPercent)) / 100;
  const step = symbolInfo?.symbol === symbol ? symbolInfo.stepSize : 0;
  const rawQuantity = entry > 0 ? (margin * lev) / entry : 0;
  const quantity = step > 0 ? Math.floor(rawQuantity / step + 1e-9) * step : rawQuantity;
  const notional = quantity * entry;
  const minNotional = symbolInfo?.symbol === symbol ? symbolInfo.minNotional : 0;
  const category = symbolInfo?.symbol === symbol ? symbolInfo.category : "crypto";
  const ready = entry > 0 && stopPrice > 0 && targetPrice > 0 && Number(stopPct) > 0 && Number(targetPct) > 0 && quantity > 0;
  const belowMinimum = ready && minNotional > 0 && notional < minNotional;

  const check = risk?.state?.capitalKnown && ready
    ? checkOrder({ settings, state: risk.state, order: { entry, stop: stopPrice, target: targetPrice, quantity, feePercent: FEE_PERCENT, side, leverage: lev } })
    : null;
  const blocked = check != null && !check.allowed;
  const liquidationPrice = check?.liquidationPct != null ? (short ? entry * (1 + check.liquidationPct / 100) : entry * (1 - check.liquidationPct / 100)) : null;

  const atrPct = analysis?.latest?.atrPercent ?? null;
  const setupPrice = entry > 0 ? entry : currentPrice;
  const setup = useMemo(
    () => (risk?.state?.capitalKnown && setupPrice > 0
      ? riskSetup({ settings, state: risk.state, price: setupPrice, atrPct, availableQuote: available, feePercent: FEE_PERCENT, minNotional, category, side, leverage: lev, futures: true })
      : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [risk, setupPrice, atrPct != null ? Math.round(atrPct * 20) : null, available, minNotional, category, side, lev],
  );
  const activeOrders = orders.filter((o) => ["WAITING_ENTRY", "PROTECTED"].includes(o.status));

  useEffect(() => {
    try { window.localStorage.setItem("auto-risk-futures", autoRisk ? "1" : "0"); } catch { /* storage unavailable */ }
  }, [autoRisk]);

  // Never start above the leverage limit.
  useEffect(() => {
    if (settings && lev > maxLeverage) setLeverage(String(maxLeverage));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxLeverage]);

  // Auto mode writes the rule-based stop, target and margin into the ticket.
  useEffect(() => {
    if (!autoRisk || !setup) return;
    setStopPct(String(setup.stopPct));
    setTargetPct(String(setup.targetPct));
    if (setup.percentOfAvailable > 0) setMarginPercent(String(setup.percentOfAvailable));
  }, [autoRisk, setup?.stopPct, setup?.targetPct, setup?.percentOfAvailable]);

  // A new pair must not inherit the previous pair's price.
  useEffect(() => { setEntryPrice(""); }, [symbol, mode]);
  useEffect(() => {
    if (currentPrice != null && !entryPrice) setEntryPrice(String(currentPrice));
  }, [currentPrice, entryPrice]);

  // A plan handed over from an AMD alert, the Analysis tab or the Risk calculator.
  useEffect(() => {
    if (!plan || plan.symbol !== symbol) return;
    setSide(plan.side ?? "long");
    setEntryPrice(String(plan.entry));
    setStopPct(String(plan.stopLossPercent));
    setTargetPct(String(plan.takeProfitPercent));
    setAutoRisk(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan?.nonce]);

  // Report this ticket to the chart, so it can draw the entry/stop/target as draggable lines. Dragging one only
  // ever feeds back into these same fields (above), so it can never place an order the risk rules would refuse.
  useEffect(() => {
    if (!ready) { onDraftChange(null); return; }
    onDraftChange({ symbol, side, entry, stopLoss: stopPrice, takeProfit: targetPrice, quantity, feePercent: FEE_PERCENT, blocked });
    return () => onDraftChange(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, side, entry, stopPrice, targetPrice, ready, quantity, blocked]);

  async function submit(event) {
    event.preventDefault();
    setError(null);
    if (mode === "live") {
      const text = `LIVE futures order with real money\n\n${short ? "SHORT" : "LONG"} ${symbol} at ${price(entry)}, ${lev}× leverage, isolated margin\nMargin ${fmt(margin)} USDT, position ${fmt(notional)} USDT\nStop ${price(stopPrice)} · Target ${price(targetPrice)}\nLoss if stopped about ${fmt(check?.riskUsd)} USDT\n\nPlace it?`;
      if (!window.confirm(text)) return;
    }
    setBusy(true);
    try {
      const order = await createFuturesOrder({
        symbol,
        entry_price: entry,
        margin_usdt: round(margin, 4),
        leverage: lev,
        stop_loss_price: stopPrice,
        take_profit_price: targetPrice,
      });
      onOrdersChange((previous) => [order, ...previous]);
      onRiskRefresh();
      onAccountRefresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveBalance(event) {
    event.preventDefault();
    const amount = Number(balanceDraft);
    if (!Number.isFinite(amount) || amount < 0) {
      setError("Enter a balance of zero or more");
      return;
    }
    try {
      await setPaperBalance("futures", amount);
      setEditingBalance(false);
      onAccountRefresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function closePosition(position) {
    const text = `Close the ${position.side} ${position.symbol} position at market?\nIts stop-loss and take-profit orders are removed.${mode === "live" ? "\n\nThis is a LIVE account." : ""}`;
    if (!window.confirm(text)) return;
    setClosing(position.symbol);
    setError(null);
    try {
      await closeFuturesPosition(position.symbol);
      onAccountRefresh();
      onRiskRefresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setClosing(null);
    }
  }

  const missingKeys = accountError && /credentials/i.test(accountError);

  return (
    <>
      {limitsRow}
      {accountError && (
        <div className="futures-notice is-error">
          <strong>{missingKeys ? "Futures keys are not set up" : "Could not read your futures account"}</strong>
          <p>{accountError}</p>
          {missingKeys && (
            <p>
              Set <b>BINANCE_FUTURES_API_KEY_real</b> and <b>BINANCE_FUTURES_API_SECRET_real</b> (or enable Futures on your live key) in the server environment and restart. See the README.
            </p>
          )}
        </div>
      )}
      {account?.hedgeMode && (
        <div className="futures-notice is-error"><strong>Hedge Mode is on</strong><p>This app trades in One-way Mode. Switch it in the Binance futures settings before placing orders.</p></div>
      )}

      <div className="balance-metrics">
        <div className="balance-metric balance-primary"><span>Available margin</span><strong>{fmt(available)} USDT</strong><small>Free for new positions</small></div>
        <div className="balance-metric"><span>Futures wallet</span><strong>{fmt(wallet)} USDT</strong><small>Total balance</small></div>
        <div className="balance-metric"><span>Unrealized P/L</span><strong className={(account?.unrealized ?? 0) >= 0 ? "profit-estimate" : "loss-estimate"}>{(account?.unrealized ?? 0) >= 0 ? "+" : "−"}{fmt(Math.abs(account?.unrealized ?? 0))} USDT</strong><small>Open positions</small></div>
        <button type="button" className="refresh-balance-button" onClick={onAccountRefresh}>Refresh</button>
        {mode === "paper" && (
          editingBalance ? (
            <form className="paper-balance-edit" onSubmit={saveBalance}>
              <input type="number" min="0" step="any" autoFocus value={balanceDraft} onChange={(e) => setBalanceDraft(e.target.value)} placeholder="USDT balance" aria-label="New futures wallet balance" />
              <button type="submit" className="mini-button accent">Set</button>
              <button type="button" className="mini-button" onClick={() => setEditingBalance(false)}>Cancel</button>
            </form>
          ) : (
            <button type="button" className="refresh-balance-button" title="Set any starting capital for this simulated account" onClick={() => { setBalanceDraft(String(wallet)); setEditingBalance(true); }}>Edit balance</button>
          )
        )}
      </div>

      {account?.positions?.length > 0 && (
        <div className="fut-positions">
          <p className="panel-title">Open positions</p>
          {account.positions.map((p) => (
            <div className="fut-position" key={`${p.symbol}-${p.side}`}>
              <div>
                <strong>{p.symbol}</strong>
                <b className={`fut-side ${p.side === "LONG" ? "is-long" : "is-short"}`}>{p.side}{p.leverage ? ` ${p.leverage}×` : ""}</b>
                <span>{p.quantity} @ {price(p.entryPrice)} · mark {price(p.markPrice)}</span>
                <span>{p.liquidationPrice ? `liquidation ${price(p.liquidationPrice)}` : "no liquidation price"}{p.marginType ? ` · ${p.marginType.toLowerCase()}` : ""}</span>
              </div>
              <div className="fut-position-end">
                <strong className={p.unrealizedProfit >= 0 ? "profit-estimate" : "loss-estimate"}>{p.unrealizedProfit >= 0 ? "+" : "−"}{fmt(Math.abs(p.unrealizedProfit))}</strong>
                <button type="button" disabled={closing === p.symbol} onClick={() => closePosition(p)}>{closing === p.symbol ? "Closing…" : "Close"}</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {setup && (
        <div className={`risk-setup ${autoRisk ? "is-auto" : ""}`}>
          <div className="rs-head">
            <strong>Risk-based setup · {short ? "short" : "long"}</strong>
            <label className="switch" title="Keep margin, stop-loss and take-profit in line with your risk rules. Editing them by hand switches this off.">
              <input type="checkbox" checked={autoRisk} onChange={(event) => setAutoRisk(event.target.checked)} /> Auto
            </label>
          </div>
          <p className="rs-line">
            Stop <b>{short ? "+" : "−"}{setup.stopPct}%</b> <em>({setup.atrBased ? "1.5× recent volatility" : "default"})</em> · Target <b>{short ? "−" : "+"}{setup.targetPct}%</b> <em>({setup.netRR}:1 after fees)</em>
          </p>
          <p className="rs-line">
            Position <b>{fmt(setup.positionValue)} USDT</b> = margin <b>{fmt(setup.capitalUsd)}</b> × {lev}{setup.limitedBy ? <em> (limited by {setup.limitedBy})</em> : null} · risks <b>{fmt(setup.riskUsd)} USDT</b>{setup.riskPct != null ? <em> ({setup.riskPct.toFixed(2)}% of capital)</em> : null}
          </p>
          {setup.issues.map((issue) => <p className="rs-issue" key={issue}>{issue}</p>)}
          {!autoRisk && <button type="button" className="mini-button accent" onClick={() => setAutoRisk(true)}>Apply to ticket and keep it updated</button>}
        </div>
      )}

      <form className="order-form" onSubmit={submit}>
        <div className="fut-side-toggle" role="group" aria-label="Direction">
          <button type="button" className={!short ? "is-long is-on" : ""} aria-pressed={!short} onClick={() => setSide("long")}>Long · buy</button>
          <button type="button" className={short ? "is-short is-on" : ""} aria-pressed={short} onClick={() => setSide("short")}>Short · sell</button>
        </div>
        <label className="entry-price-field">
          <span>{short ? "Sell at or above" : "Buy at or below"}</span>
          <div className="entry-price-controls">
            <input type="number" step="any" min="0" value={entryPrice} onChange={(event) => setEntryPrice(event.target.value)} required />
            <button type="button" className="market-price-button" onClick={() => currentPrice != null && setEntryPrice(String(currentPrice))} disabled={currentPrice == null}>Market</button>
          </div>
        </label>
        <label>Leverage · max {maxLeverage}× (your risk limit)
          <input type="number" step="1" min="1" max={maxLeverage} value={leverage} onChange={(event) => { setAutoRisk(false); setLeverage(event.target.value); }} required />
        </label>
        <label>Margin from available balance
          <div className="capital-controls">
            <select className="capital-percent-select" value={marginPercent} onChange={(event) => { setAutoRisk(false); setMarginPercent(event.target.value); }}>
              {[...new Set([1, 5, 10, 25, 50, 75, 100, Number(marginPercent)])].sort((a, b) => a - b).map((percent) => <option key={percent} value={percent}>{percent}% = {fmt(available * percent / 100)} USDT</option>)}
            </select>
            <button type="button" className="market-price-button" onClick={() => { setAutoRisk(false); setMarginPercent("100"); }} disabled={!available}>Max</button>
          </div>
        </label>
        <label>Stop-loss % · {short ? "buy back at/above" : "sell at/below"}<input type="number" step="any" min="0.05" value={stopPct} onChange={(event) => { setAutoRisk(false); setStopPct(event.target.value); }} required /></label>
        <label>Take-profit % · {short ? "buy back at/below" : "sell at/above"}<input type="number" step="any" min="0.05" value={targetPct} onChange={(event) => { setAutoRisk(false); setTargetPct(event.target.value); }} required /></label>
        <button
          className={`primary-button ${short ? "is-short" : ""}`}
          type="submit"
          disabled={busy || orderLimitReached || blocked || belowMinimum || !ready || !!accountError}
        >
          {busy ? "Placing..." : orderLimitReached ? "Order limit reached" : blocked ? "Blocked by risk rules" : belowMinimum ? "Below Binance minimum" : `Place ${short ? "short" : "long"} order`}
        </button>
      </form>
      <p className="order-rule-note">
        A limit order at your price, on isolated margin. When it fills, the stop-loss and take-profit are placed on Binance (they trigger on the mark price and close the whole position). If the stop cannot be placed the position is closed at once.
      </p>
      {error && <p className="order-error">{error}</p>}
      {belowMinimum && <p className="order-error">Position is {fmt(notional)} USDT. Binance's minimum for {symbol} is {minNotional} USDT: use more margin or higher leverage.</p>}

      {check && (
        <div className={`risk-preview ${blocked ? "is-blocked" : ""}`}>
          <div className="preview-row"><span>Risk if stopped</span><b className={check.riskPct > settings.riskPerTradePct ? "loss-estimate" : ""}>−{fmt(check.riskUsd)} USDT · {check.riskPct.toFixed(2)}% <em>(limit {settings.riskPerTradePct}%)</em></b></div>
          <div className="preview-row"><span>Margin used</span><b className={check.positionPct > settings.maxPositionPct ? "loss-estimate" : ""}>{check.positionPct.toFixed(1)}% of capital <em>(limit {settings.maxPositionPct}%)</em></b></div>
          <div className="preview-row"><span>Reward : risk</span><b className={settings.minRewardRisk > 0 && check.rewardRisk < settings.minRewardRisk ? "loss-estimate" : ""}>{check.rewardRisk == null ? "—" : `1 : ${check.rewardRisk.toFixed(2)}`} <em>(min {settings.minRewardRisk})</em></b></div>
          <div className="preview-row"><span>Liquidation</span><b className={check.violations.some((v) => v.code === "liquidation") ? "loss-estimate" : ""}>{liquidationPrice == null ? "none at 1×" : `≈ ${price(liquidationPrice)} · ${check.liquidationPct.toFixed(1)}% away`} <em>(stop {Number(stopPct).toFixed(2)}%)</em></b></div>
          {blocked && <ul className="risk-violations">{check.violations.map((v) => <li key={v.code}>{v.message}</li>)}</ul>}
          {!blocked && check.warnings.map((w) => <p className="an-hint" key={w}>{w}</p>)}
        </div>
      )}
      <div className="trade-preview">
        <div className="preview-row"><span>Position value</span><b>{fmt(notional)} USDT · {quantity ? quantity.toFixed(step > 0 ? Math.max(0, Math.round(-Math.log10(step))) : 6) : "—"} units</b></div>
        <div className="preview-row"><span>Stop-loss {price(stopPrice)}</span><b className="loss-estimate">−{fmt(check?.riskUsd)} USDT</b></div>
        <div className="preview-row"><span>Take-profit {price(targetPrice)}</span><b className={(check?.rewardUsd ?? 0) >= 0 ? "profit-estimate" : "loss-estimate"}>{(check?.rewardUsd ?? 0) >= 0 ? "+" : "−"}{fmt(Math.abs(check?.rewardUsd ?? 0))} USDT</b></div>
        <div className="preview-row"><span>Fees (estimate)</span><b>{FEE_PERCENT}% per side · funding not included</b></div>
        <div className="preview-row"><span>Active futures orders</span><b>{activeOrders.length}</b></div>
      </div>
    </>
  );
}
