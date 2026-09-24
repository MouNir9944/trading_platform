import { useEffect, useMemo, useState } from "react";
import AnalysisPanel from "./AnalysisPanel.jsx";
import FuturesTicket from "./FuturesTicket.jsx";
import RiskPanel from "./RiskPanel.jsx";
import { usePersistentState, oneOf, isText } from "../lib/persist.js";
import { checkOrder, riskSetup } from "../../shared/risk.js";
import { cancelBinanceOpenOrder, cancelFuturesOrder, cancelOrder, clearFuturesOrderHistory, clearOrderHistory, deleteFuturesOrderHistory, createConditionalOrder, deleteOrderHistory, getBalance, getOrderLimits, getSymbolInfo, getTradingFee, modifyEntryPrice, setOrderLimits, setPaperBalance } from "../api.js";

export default function AutoOrderPanel({
  currentPrice,
  selectedEntryPrice,
  alertPlan = null,
  futuresAccount = null,
  futuresError = null,
  onFuturesRefresh = () => {},
  symbol,
  mode,
  balances,
  onBalancesChange,
  orders,
  onOrdersChange,
  onSymbolChange,
  binanceOpenOrders = [],
  onBinanceOpenOrdersChange,
  analysis = null,
  market = "spot",
  risk = null,
  onRiskSave = async () => {},
  onRiskReset = async () => {},
  onRiskRefresh = () => {},
  loadHistory,
  loadHourly,
  timeZone = "UTC",
  interval,
  onDraftChange = () => {},
}) {
  const [feePercent, setFeePercent] = useState(0.1);
  const [entryPrice, setEntryPrice] = useState("");
  const [capitalPercent, setCapitalPercent] = usePersistentState("pref:spot-capital-percent", "10", isText);
  const [stopLossPercent, setStopLossPercent] = usePersistentState("pref:spot-stop-percent", "0.5", isText);
  const [takeProfitPercent, setTakeProfitPercent] = usePersistentState("pref:spot-target-percent", "1.5", isText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [refreshingBalance, setRefreshingBalance] = useState(false);
  const [editingBalance, setEditingBalance] = useState(false);
  const [balanceDraft, setBalanceDraft] = useState("");
  const [maxOpenOrders, setMaxOpenOrders] = useState(1);
  const [maxDailyOrders, setMaxDailyOrders] = useState(5);
  const [adjustingOrderId, setAdjustingOrderId] = useState(null);
  const [editPrices, setEditPrices] = useState({});
  const [tab, setTab] = usePersistentState("pref:order-panel-tab", "trade", oneOf(["trade", "analysis", "risk", "orders", "history"]));
  const [ticketPlan, setTicketPlan] = useState(null); // plan handed to the futures ticket (alert, analysis, calculator)
  const futuresMarket = market === "futures";
  const [symbolInfo, setSymbolInfo] = useState(null);
  // Auto: keep size, stop-loss and take-profit in line with the risk rules. Editing any of them by hand turns it off.
  const [autoRisk, setAutoRisk] = useState(() => {
    try { return window.localStorage.getItem("auto-risk") !== "0"; } catch { return true; }
  });
  const entry = Number(entryPrice);
  const quoteAsset = symbol.endsWith("USDT") ? "USDT" : symbol.slice(-4);
  const availableQuote = Number(balances.find((balance) => balance.asset === quoteAsset)?.free ?? 0);
  const capital = availableQuote * Number(capitalPercent) / 100;
  const baseAsset = symbol.endsWith("USDT") ? symbol.slice(0, -4) : symbol;
  const baseBalance = balances.find((balance) => balance.asset === baseAsset);
  const baseFree = Number(baseBalance?.free ?? 0);
  const baseLocked = Number(baseBalance?.locked ?? 0);
  const baseTotal = baseFree + baseLocked;
  const baseValueUsdt = baseTotal * (currentPrice ?? 0);
  const today = new Date().toISOString().slice(0, 10);
  const openOrderCount = orders.filter((order) => ["WAITING_ENTRY", "PROTECTED", "MODIFYING"].includes(order.status)).length;
  const dailyOrderCount = orders.filter((order) => order.created_at?.slice(0, 10) === today).length;
  const openSlots = Math.max(0, maxOpenOrders - openOrderCount);
  const dailySlots = Math.max(0, maxDailyOrders - dailyOrderCount);
  const orderLimitReached = openSlots === 0 || dailySlots === 0;
  const estimatedQuantity = entry > 0 ? (capital * (1 - feePercent / 100)) / entry : 0;
  const stopPrice = entry * (1 - Number(stopLossPercent) / 100);
  const targetPrice = entry * (1 + Number(takeProfitPercent) / 100);
  const buyValue = entry * estimatedQuantity;
  const buyFee = buyValue * feePercent / 100;
  const estimatedLoss = Math.max(0, buyValue + buyFee - stopPrice * estimatedQuantity * (1 - feePercent / 100));
  const estimatedProfit = targetPrice * estimatedQuantity * (1 - feePercent / 100) - buyValue - buyFee;
  const grossLoss = Math.max(0, buyValue - stopPrice * estimatedQuantity);
  const grossProfit = Math.max(0, targetPrice * estimatedQuantity - buyValue);
  const stopFees = buyFee + stopPrice * estimatedQuantity * feePercent / 100;
  const targetFees = buyFee + targetPrice * estimatedQuantity * feePercent / 100;
  const tradeReady = entry > 0 && stopPrice > 0 && stopPrice < entry && entry < targetPrice && estimatedQuantity > 0;
  const riskCheck = risk?.state?.capitalKnown && tradeReady
    ? checkOrder({ settings: risk.settings, state: risk.state, order: { entry, stop: stopPrice, target: targetPrice, quantity: estimatedQuantity, feePercent } })
    : null;
  const blockedByRisk = riskCheck != null && !riskCheck.allowed;
  const fitPercent = riskCheck?.suggestedPositionValue > 0 && availableQuote > 0
    ? Math.min(100, Math.floor((riskCheck.suggestedPositionValue / (1 - feePercent / 100) / availableQuote) * 10000) / 100)
    : null;
  const minNotional = symbolInfo?.symbol === symbol ? symbolInfo.minNotional : 0;
  const belowMinNotional = tradeReady && minNotional > 0 && buyValue < minNotional;
  const atrPct = analysis?.latest?.atrPercent ?? null;
  const setupPrice = entry > 0 ? entry : currentPrice;
  const setup = useMemo(
    () => (risk?.state?.capitalKnown && setupPrice > 0 && availableQuote >= 0
      ? riskSetup({ settings: risk.settings, state: risk.state, price: setupPrice, atrPct, availableQuote, feePercent, minNotional, category: symbolInfo?.symbol === symbol ? symbolInfo.category : "crypto" })
      : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [risk, setupPrice, atrPct != null ? Math.round(atrPct * 20) : null, availableQuote, feePercent, minNotional, symbolInfo?.category],
  );
  const activeOrders = orders.filter((order) => ["WAITING_ENTRY", "PROTECTED", "MODIFYING"].includes(order.status));
  const finishedOrders = orders.filter((order) => ["CLOSED", "CANCELLED"].includes(order.status));
  const listedOrders = orders.filter((order) => ["WAITING_ENTRY", "PROTECTED", "MODIFYING", "ERROR"].includes(order.status));
  const breakEvenPercent = ((1 / (1 - feePercent / 100) ** 2) - 1) * 100;

  useEffect(() => {
    getOrderLimits().then((data) => { setMaxOpenOrders(data.max_open_orders); setMaxDailyOrders(data.max_daily_orders); }).catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    // The fee endpoint is spot-only; futures pairs use the default rate.
    if (market !== "spot") { setFeePercent(0.1); return; }
    getTradingFee(symbol)
      .then((data) => setFeePercent(Math.max(data.maker_percent ?? 0.1, data.taker_percent ?? 0.1)))
      .catch(() => setFeePercent(0.1));
  }, [symbol, mode, market]);

  // Switching pair: forget the old pair's entry price so the new pair's market price is used.
  useEffect(() => {
    setEntryPrice("");
    setSymbolInfo(null);
    getSymbolInfo(symbol, market).then(setSymbolInfo).catch(() => setSymbolInfo(null));
  }, [symbol, mode, market]);

  useEffect(() => {
    try { window.localStorage.setItem("auto-risk", autoRisk ? "1" : "0"); } catch { /* storage unavailable */ }
  }, [autoRisk]);

  // Auto mode: write the rule-based stop, target and size into the ticket whenever the inputs change.
  useEffect(() => {
    if (!autoRisk || !setup) return;
    setStopLossPercent(String(setup.stopPct));
    setTakeProfitPercent(String(setup.targetPct));
    if (setup.percentOfAvailable > 0) setCapitalPercent(String(setup.percentOfAvailable));
  }, [autoRisk, setup?.stopPct, setup?.targetPct, setup?.percentOfAvailable]);

  // "Use in order ticket" on an AMD alert: entry, stop and target from the setup (turns auto sizing off, like other manual edits).
  useEffect(() => {
    if (!alertPlan || alertPlan.symbol !== symbol || futuresMarket) return;
    setEntryPrice(String(alertPlan.entry));
    setStopLossPercent(String(alertPlan.stopLossPercent));
    setTakeProfitPercent(String(alertPlan.takeProfitPercent));
    setAutoRisk(false);
    setTab("trade");
  }, [alertPlan?.nonce]);

  // The same alert on the futures market goes to the futures ticket, long or short.
  useEffect(() => {
    if (!alertPlan || alertPlan.symbol !== symbol || !futuresMarket) return;
    setTicketPlan(alertPlan);
    setTab("trade");
  }, [alertPlan?.nonce]);

  useEffect(() => {
    if (selectedEntryPrice == null) return;
    setEntryPrice(selectedEntryPrice.toFixed(8));
  }, [selectedEntryPrice]);

  // Report the ticket being set up, so the chart can draw its entry/stop/target as draggable lines. Dragging one
  // only ever feeds back into these same fields (below), so it can never place an order the risk rules would refuse.
  useEffect(() => {
    if (tab !== "trade" || futuresMarket || !tradeReady) { onDraftChange(null); return; }
    onDraftChange({ symbol, side: "long", entry, stopLoss: stopPrice, takeProfit: targetPrice, quantity: estimatedQuantity, feePercent, blocked: blockedByRisk });
    return () => onDraftChange(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, futuresMarket, symbol, entry, stopPrice, targetPrice, tradeReady, estimatedQuantity, feePercent, blockedByRisk]);

  useEffect(() => {
    if (currentPrice == null || entryPrice) return;
    setEntryPrice(currentPrice.toFixed(6));
  }, [currentPrice, entryPrice]);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (capital <= 0 || capital > availableQuote) {
        throw new Error(`Order capital must be between 0 and ${availableQuote.toFixed(2)} ${quoteAsset}`);
      }
      const order = await createConditionalOrder({
        symbol,
        entry_price: entry,
        capital_usdt: capital,
        stop_loss_price: stopPrice,
        take_profit_price: targetPrice,
      });
      onOrdersChange((prev) => [order, ...prev]);
      onRiskRefresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function refreshBalance() {
    setRefreshingBalance(true);
    try {
      const result = await getBalance();
      onBalancesChange(result.balances ?? []);
    } catch (err) {
      setError(err.message);
    } finally {
      setRefreshingBalance(false);
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
      await setPaperBalance("spot", amount, quoteAsset);
      setEditingBalance(false);
      await refreshBalance();
    } catch (err) {
      setError(err.message);
    }
  }

  async function cancel(orderId) {
    try {
      const updated = await (futuresMarket ? cancelFuturesOrder : cancelOrder)(orderId);
      onOrdersChange((prev) => prev.map((order) => (order.id === updated.id ? updated : order)));
      if (futuresMarket) { onFuturesRefresh(); onRiskRefresh(); }
    } catch (err) {
      setError(err.message);
    }
  }

  async function adjustEntry(orderId, payload) {
    setAdjustingOrderId(orderId);
    setError(null);
    try {
      const updated = await modifyEntryPrice(orderId, payload);
      onOrdersChange((prev) => prev.map((order) => (order.id === updated.id ? updated : order)));
      setEditPrices((prev) => ({ ...prev, [orderId]: String(updated.entry_price) }));
    } catch (err) {
      setError(err.message);
    } finally {
      setAdjustingOrderId(null);
    }
  }

  function editPriceValue(order) {
    return editPrices[order.id] ?? String(order.entry_price);
  }

  async function cancelExternalOrder(order) {
    try {
      await cancelBinanceOpenOrder(order.symbol, order.orderId, mode);
      onBinanceOpenOrdersChange?.((previous) => previous.filter((item) => item.orderId !== order.orderId));
    } catch (err) {
      setError(err.message);
    }
  }

  async function removeHistory(orderId) {
    try {
      await (futuresMarket ? deleteFuturesOrderHistory : deleteOrderHistory)(orderId);
      onOrdersChange((prev) => prev.filter((order) => order.id !== orderId));
    } catch (err) {
      setError(err.message);
    }
  }

  async function clearHistory() {
    try {
      await (futuresMarket ? clearFuturesOrderHistory : clearOrderHistory)();
      onOrdersChange((prev) => prev.filter((order) => ["WAITING_ENTRY", "PROTECTED", "MODIFYING"].includes(order.status)));
    } catch (err) {
      setError(err.message);
    }
  }

  async function updateLimits(nextOpen, nextDaily) {
    try {
      const result = await setOrderLimits(Number(nextOpen), Number(nextDaily));
      setMaxOpenOrders(result.max_open_orders);
      setMaxDailyOrders(result.max_daily_orders);
    } catch (err) {
      setError(err.message);
    }
  }

  const limitsRow = (
    <div className="order-limits">
      <span>Order limits</span>
      <label>Open<select value={maxOpenOrders} onChange={(event) => updateLimits(event.target.value, maxDailyOrders)}>{[1, 3, 5, 10, 20].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      <label>Today<select value={maxDailyOrders} onChange={(event) => updateLimits(maxOpenOrders, event.target.value)}>{[5, 10, 20, 50, 100].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
      <span className={orderLimitReached ? "limit-warning" : "limit-remaining"}>{openSlots} open · {dailySlots} today left</span>
    </div>
  );

  return (
    <section className="panel automation-panel">
      <div className="panel-heading">
        <div>
          <p className="panel-title">Automatic entry</p>
          <p className="panel-subtitle">{futuresMarket ? "Futures: limit entry, then Binance stop-loss / take-profit" : "Limit buy, then Binance OCO for SL / TP"}</p>
        </div>
        <span className={`mode-badge ${mode === "live" ? "live-badge" : ""}`}>{mode === "live" ? "LIVE" : "PAPER"}</span>
      </div>
      <nav className="tabs" role="tablist">
        {[["trade", "Trade"], ["analysis", "Analysis"], ["risk", risk?.state?.status === "halted" ? "Risk !" : "Risk"], ["orders", `Orders${activeOrders.length ? ` · ${activeOrders.length}` : ""}`], ["history", `History${finishedOrders.length ? ` · ${finishedOrders.length}` : ""}`]].map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "is-active" : ""} onClick={() => setTab(id)}>{label}</button>
        ))}
      </nav>
      {error && <p className="order-error">{error}</p>}
      {tab === "trade" && futuresMarket && (
        <FuturesTicket
          symbol={symbol}
          currentPrice={currentPrice}
          mode={mode}
          account={futuresAccount}
          accountError={futuresError}
          risk={risk}
          analysis={analysis}
          symbolInfo={symbolInfo}
          orders={orders}
          plan={ticketPlan}
          limitsRow={limitsRow}
          orderLimitReached={orderLimitReached}
          onOrdersChange={onOrdersChange}
          onRiskRefresh={onRiskRefresh}
          onDraftChange={onDraftChange}
          onAccountRefresh={onFuturesRefresh}
        />
      )}
      {tab === "trade" && market !== "futures" && (<>
      {limitsRow}
      <div className="balance-metrics">
        <div className="balance-metric balance-primary"><span>Available {quoteAsset}</span><strong>{formatAmount(availableQuote, 2)} {quoteAsset}</strong><small>Free for new orders</small></div>
        <div className="balance-metric"><span>Held {baseAsset}</span><strong>{formatAmount(baseTotal, 8)} {baseAsset}</strong><small>{formatAmount(baseFree, 8)} free · {formatAmount(baseLocked, 8)} locked</small></div>
        <div className="balance-metric"><span>{baseAsset} value</span><strong>{formatAmount(baseValueUsdt, 2)} USDT</strong><small>At {currentPrice ? formatAmount(currentPrice, 6) : "—"} {quoteAsset}</small></div>
        <button type="button" className="refresh-balance-button" onClick={refreshBalance} disabled={refreshingBalance}>{refreshingBalance ? "Refreshing..." : "Refresh balance"}</button>
        {mode === "paper" && (
          editingBalance ? (
            <form className="paper-balance-edit" onSubmit={saveBalance}>
              <input type="number" min="0" step="any" autoFocus value={balanceDraft} onChange={(e) => setBalanceDraft(e.target.value)} placeholder={`${quoteAsset} balance`} aria-label={`New ${quoteAsset} balance`} />
              <button type="submit" className="mini-button accent">Set</button>
              <button type="button" className="mini-button" onClick={() => setEditingBalance(false)}>Cancel</button>
            </form>
          ) : (
            <button type="button" className="refresh-balance-button" title="Set any starting capital for this simulated account" onClick={() => { setBalanceDraft(String(availableQuote)); setEditingBalance(true); }}>Edit balance</button>
          )
        )}
      </div>
      {setup && (
        <div className={`risk-setup ${autoRisk ? "is-auto" : ""}`}>
          <div className="rs-head">
            <strong>Risk-based setup</strong>
            <label className="switch" title="Keep size, stop-loss and take-profit in line with your risk rules. Editing them by hand switches this off.">
              <input type="checkbox" checked={autoRisk} onChange={(event) => setAutoRisk(event.target.checked)} /> Auto
            </label>
          </div>
          <p className="rs-line">
            Stop <b>−{setup.stopPct}%</b> <em>({setup.atrBased ? "1.5× recent volatility" : "default"})</em> · Target <b>+{setup.targetPct}%</b> <em>({setup.netRR}:1 after fees)</em>
          </p>
          <p className="rs-line">
            Size <b>{setup.positionValue.toFixed(2)} USDT</b>{setup.limitedBy ? <em> (limited by {setup.limitedBy})</em> : null} · risks <b>{setup.riskUsd.toFixed(2)} USDT</b>{setup.riskPct != null ? <em> ({setup.riskPct.toFixed(2)}% of capital)</em> : null}
          </p>
          {setup.issues.map((issue) => <p className="rs-issue" key={issue}>{issue}</p>)}
          {!autoRisk && (
            <button
              type="button"
              className="mini-button accent"
              onClick={() => {
                setAutoRisk(true);
                if (entry <= 0 && currentPrice != null) setEntryPrice(currentPrice.toFixed(6));
              }}
            >
              Apply to ticket and keep it updated
            </button>
          )}
        </div>
      )}
      <form className="order-form" onSubmit={submit}>
        <label className="entry-price-field">
          <span>Buy at or below</span>
          <div className="entry-price-controls">
            <input type="number" step="any" min="0" value={entryPrice} onChange={(event) => setEntryPrice(event.target.value)} required />
            <button type="button" className="market-price-button" onClick={() => currentPrice != null && setEntryPrice(currentPrice.toFixed(8))} disabled={currentPrice == null}>
              Market
            </button>
          </div>
        </label>
        <label>Order capital from balance<div className="capital-controls"><select className="capital-percent-select" value={capitalPercent} onChange={(event) => { setAutoRisk(false); setCapitalPercent(event.target.value); }}>{[...new Set([1, 5, 10, 25, 50, 75, 100, Number(capitalPercent)])].sort((a, b) => a - b).map((percent) => <option key={percent} value={percent}>{percent}% = {formatAmount(availableQuote * percent / 100, 2)} {quoteAsset}</option>)}</select><button type="button" className="market-price-button" onClick={() => { setAutoRisk(false); setCapitalPercent("100"); }} disabled={!availableQuote}>Max</button></div></label>
        <label>Stop-loss % · sell at/below<input type="number" step="any" min="0.1" value={stopLossPercent} onChange={(event) => { setAutoRisk(false); setStopLossPercent(event.target.value); }} required /></label>
        <label>Take-profit % · sell at/above<input type="number" step="any" min="0.1" value={takeProfitPercent} onChange={(event) => { setAutoRisk(false); setTakeProfitPercent(event.target.value); }} required /></label>
        <button className="primary-button" type="submit" disabled={busy || orderLimitReached || blockedByRisk || belowMinNotional}>{busy ? "Placing..." : orderLimitReached ? "Order limit reached" : blockedByRisk ? "Blocked by risk rules" : belowMinNotional ? "Below Binance minimum" : "Place automatic order"}</button>
      </form>
      <p className="order-rule-note">The limit BUY fills when the market reaches this price or a lower price. Binance may fill it immediately if the market is already below it.</p>
      {belowMinNotional && (
        <p className="order-error">Order value is {buyValue.toFixed(2)} {quoteAsset}. Binance's minimum for {symbol} is {minNotional} {quoteAsset}, so this order would be rejected. You have {availableQuote.toFixed(2)} {quoteAsset} available.</p>
      )}
      {riskCheck && (
        <div className={`risk-preview ${blockedByRisk ? "is-blocked" : ""}`}>
          <div className="preview-row"><span>Risk if stopped</span><b className={riskCheck.riskPct > risk.settings.riskPerTradePct ? "loss-estimate" : ""}>−{riskCheck.riskUsd.toFixed(2)} USDT · {riskCheck.riskPct.toFixed(2)}% <em>(limit {risk.settings.riskPerTradePct}%)</em></b></div>
          <div className="preview-row"><span>Position size</span><b className={riskCheck.positionPct > risk.settings.maxPositionPct ? "loss-estimate" : ""}>{riskCheck.positionPct.toFixed(1)}% of capital <em>(limit {risk.settings.maxPositionPct}%)</em></b></div>
          <div className="preview-row"><span>Reward : risk</span><b className={risk.settings.minRewardRisk > 0 && riskCheck.rewardRisk < risk.settings.minRewardRisk ? "loss-estimate" : ""}>{riskCheck.rewardRisk == null ? "—" : `1 : ${riskCheck.rewardRisk.toFixed(2)}`} <em>(min {risk.settings.minRewardRisk})</em></b></div>
          {blockedByRisk && (
            <ul className="risk-violations">
              {riskCheck.violations.map((v) => <li key={v.code}>{v.message}</li>)}
            </ul>
          )}
          {blockedByRisk && fitPercent != null && riskCheck.violations.every((v) => ["risk_per_trade", "position_size", "open_risk"].includes(v.code)) && (
            <button type="button" className="mini-button accent" onClick={() => setCapitalPercent(String(fitPercent))}>Fit size to my limits ({fitPercent}% of balance)</button>
          )}
          {!blockedByRisk && riskCheck.warnings.map((w) => <p className="an-hint" key={w}>{w}</p>)}
        </div>
      )}
      <div className="trade-preview">
        <div className="preview-row"><span>Order capital</span><b className={capital > availableQuote ? "loss-estimate" : ""}>{capital.toFixed(2)} {quoteAsset}{capital > availableQuote ? " · insufficient" : ""}</b></div>
        <div className="preview-row"><span>Binance fee</span><b>{feePercent.toFixed(3)}% per side</b></div>
        <div className="preview-row"><span>Estimated quantity</span><b>{Number.isFinite(estimatedQuantity) ? estimatedQuantity.toFixed(6) : "—"}</b></div>
        <div className="preview-row"><span>Stop-loss {formatAmount(stopPrice, 8)}</span><b className="loss-estimate">−{formatAmount(estimatedLoss, 4)} USDT</b></div>
        <div className="preview-row"><span>Take-profit {formatAmount(targetPrice, 8)}</span><b className={estimatedProfit >= 0 ? "profit-estimate" : "loss-estimate"}>{estimatedProfit >= 0 ? "+" : "−"}{formatAmount(Math.abs(estimatedProfit), 4)} USDT</b></div>
        <div className="preview-row"><span>Fee break-even</span><b>{breakEvenPercent.toFixed(2)}%+</b></div>
      </div>
      </>)}
      {tab === "orders" && (<>
      <div className="order-list">
        {listedOrders.length === 0 && <p className="log-empty">No active orders. Place one from the Trade tab.</p>}
        {listedOrders.map((order) => (
          <div className="order-row" key={order.id}>
            <div>
              <strong>{order.symbol}{order.side ? <b className={`fut-side ${order.side === "LONG" ? "is-long" : "is-short"}`}>{order.side} {order.leverage}×</b> : null}</strong>
              <span>{order.entry_price} entry · SL {order.stop_loss_price} · TP {order.take_profit_price}</span>
              <span>Fees {order.fee_percent}% · SL -{order.estimated_loss_usdt} USDT · TP +{order.estimated_profit_usdt} USDT</span>
              {order.message && <span className={order.status === "ERROR" ? "order-error-text" : "order-note"}>{order.message}</span>}
            </div>
            <div className="order-status">
              <b className={`status-pill ${order.status}`}>{order.status}</b>
              {order.status === "WAITING_ENTRY" && futuresMarket && <button type="button" onClick={() => cancel(order.id)}>Cancel entry</button>}
              {order.status === "WAITING_ENTRY" && !futuresMarket && (
                <div className="entry-adjust">
                  <button type="button" className="entry-step-button" disabled={adjustingOrderId === order.id} onClick={() => adjustEntry(order.id, { direction: "down" })} title="Lower entry by 1 tick">↓</button>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    className="entry-adjust-input"
                    value={editPriceValue(order)}
                    disabled={adjustingOrderId === order.id}
                    onChange={(event) => setEditPrices((prev) => ({ ...prev, [order.id]: event.target.value }))}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        const next = Number(editPriceValue(order));
                        if (Number.isFinite(next) && next > 0) adjustEntry(order.id, { entry_price: next });
                      }
                    }}
                  />
                  <button type="button" className="entry-step-button" disabled={adjustingOrderId === order.id} onClick={() => adjustEntry(order.id, { direction: "up" })} title="Raise entry by 1 tick">↑</button>
                  <button
                    type="button"
                    disabled={adjustingOrderId === order.id || Number(editPriceValue(order)) === Number(order.entry_price)}
                    onClick={() => {
                      const next = Number(editPriceValue(order));
                      if (Number.isFinite(next) && next > 0) adjustEntry(order.id, { entry_price: next });
                    }}
                  >
                    {adjustingOrderId === order.id ? "…" : "Set"}
                  </button>
                  <button type="button" onClick={() => cancel(order.id)}>Cancel entry</button>
                </div>
              )}
              {order.status === "MODIFYING" && <span className="order-note">Updating…</span>}
              {order.status === "PROTECTED" && <button type="button" onClick={() => cancel(order.id)}>{futuresMarket ? "Close at market" : "Cancel + sell market"}</button>}
              {["CLOSED", "CANCELLED", "ERROR"].includes(order.status) && <button type="button" onClick={() => removeHistory(order.id)}>Delete</button>}
            </div>
          </div>
        ))}
      </div>
      {!futuresMarket && <div className="binance-open-section">
        <div className="history-heading"><p className="panel-title">{mode === "live" ? "Open orders on Binance" : "Open paper orders"}</p><span className="order-note">{mode === "live" ? "Live account view" : "Simulated account view"}</span></div>
        {binanceOpenOrders.length === 0 && <p className="log-empty">{mode === "live" ? "No other open Binance orders." : "No other open paper orders."}</p>}
        {binanceOpenOrders.map((order) => (
          <div className="binance-order-row" key={`${order.symbol}-${order.orderId}`}>
            <strong>{order.symbol}</strong><span>{order.side} {order.type}</span><span>{order.origQty} @ {order.price || "market"}</span><b>{order.status}</b><button type="button" onClick={() => cancelExternalOrder(order)}>Cancel</button>
          </div>
        ))}
      </div>}
      </>)}
      {tab === "analysis" && (
        <AnalysisPanel
          canApply
          analysis={analysis}
          symbol={symbol}
          interval={interval}
          currentPrice={currentPrice}
          feePercent={feePercent}
          loadHistory={loadHistory}
          loadHourly={loadHourly}
          timeZone={timeZone}
          onApply={({ entry, stopLossPercent, takeProfitPercent }) => {
            if (futuresMarket) {
              setTicketPlan({ nonce: Date.now(), symbol, side: "long", entry, stopLossPercent, takeProfitPercent });
              setTab("trade");
              return;
            }
            setEntryPrice(String(entry));
            setStopLossPercent(String(stopLossPercent));
            setTakeProfitPercent(String(takeProfitPercent));
            setAutoRisk(false);
            setTab("trade");
          }}
        />
      )}
      {tab === "risk" && (
        <RiskPanel
          risk={risk}
          currentPrice={currentPrice}
          feePercent={feePercent}
          availableQuote={futuresMarket ? (futuresAccount?.available ?? 0) : availableQuote}
          onSave={onRiskSave}
          onResetDrawdown={onRiskReset}
          onUseSetup={({ entry, stopLossPercent, takeProfitPercent, capitalPercent: nextCapital }) => {
            if (futuresMarket) {
              setTicketPlan({ nonce: Date.now(), symbol, side: "long", entry, stopLossPercent, takeProfitPercent });
              setTab("trade");
              return;
            }
            setEntryPrice(String(entry));
            setStopLossPercent(String(stopLossPercent));
            setTakeProfitPercent(String(takeProfitPercent));
            setCapitalPercent(String(nextCapital));
            setAutoRisk(false);
            setTab("trade");
          }}
        />
      )}
      {tab === "history" && (
      <div className="history-section">
        <div className="history-heading"><p className="panel-title">Order history</p><button type="button" className="history-clear-button" onClick={clearHistory}>Clear history</button></div>
        {finishedOrders.length === 0 && <p className="log-empty">No completed orders yet.</p>}
        {finishedOrders.map((order) => (
          <div className="history-row" key={`history-${order.id}`}>
            <span className="history-symbol">{order.symbol}<small>{order.created_at ? new Date(order.created_at).toLocaleString() : ""}</small></span>
            <b className={`status-pill ${order.status}`}>{order.status}</b>
            <span>{order.exit_price != null ? formatAmount(order.exit_price, 6) : "—"}</span>
            <strong className={(order.realized_profit_usdt ?? 0) >= 0 ? "profit-estimate" : "loss-estimate"}>{order.realized_profit_usdt == null ? "—" : `${order.realized_profit_usdt >= 0 ? "+" : "−"}${Math.abs(order.realized_profit_usdt).toFixed(2)}`}</strong>
            <button type="button" className="row-delete" onClick={() => removeHistory(order.id)} title="Delete from history" aria-label="Delete from history">×</button>
          </div>
        ))}
      </div>
      )}
    </section>
  );
}

function formatAmount(value, maximumFractionDigits) {
  const minimumFractionDigits = maximumFractionDigits > 2 ? Math.min(maximumFractionDigits, 6) : 2;
  return Number(value).toLocaleString(undefined, { minimumFractionDigits, maximumFractionDigits });
}