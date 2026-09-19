import { useEffect, useState } from "react";
import { cancelBinanceOpenOrder, cancelOrder, clearOrderHistory, createConditionalOrder, deleteOrderHistory, getBalance, getOrderLimits, getSymbols, getTradingFee, modifyEntryPrice, setOrderLimits } from "../api.js";

export default function AutoOrderPanel({
  currentPrice,
  selectedEntryPrice,
  symbol,
  mode,
  balances,
  onBalancesChange,
  orders,
  onOrdersChange,
  onSymbolChange,
  binanceOpenOrders = [],
  onBinanceOpenOrdersChange,
}) {
  const [feePercent, setFeePercent] = useState(0.1);
  const [symbols, setSymbols] = useState([]);
  const [entryPrice, setEntryPrice] = useState("");
  const [capitalPercent, setCapitalPercent] = useState("100");
  const [stopLossPercent, setStopLossPercent] = useState("0.5");
  const [takeProfitPercent, setTakeProfitPercent] = useState("1.5");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [refreshingBalance, setRefreshingBalance] = useState(false);
  const [maxOpenOrders, setMaxOpenOrders] = useState(1);
  const [maxDailyOrders, setMaxDailyOrders] = useState(5);
  const [adjustingOrderId, setAdjustingOrderId] = useState(null);
  const [editPrices, setEditPrices] = useState({});
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
  const breakEvenPercent = ((1 / (1 - feePercent / 100) ** 2) - 1) * 100;

  useEffect(() => {
    getSymbols().then((data) => setSymbols(data.symbols ?? [])).catch((err) => setError(err.message));
    getOrderLimits().then((data) => { setMaxOpenOrders(data.max_open_orders); setMaxDailyOrders(data.max_daily_orders); }).catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    getTradingFee(symbol)
      .then((data) => setFeePercent(Math.max(data.maker_percent ?? 0.1, data.taker_percent ?? 0.1)))
      .catch(() => setFeePercent(0.1));
  }, [symbol, mode]);

  useEffect(() => {
    if (selectedEntryPrice == null) return;
    setEntryPrice(selectedEntryPrice.toFixed(8));
  }, [selectedEntryPrice]);

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

  async function cancel(orderId) {
    try {
      const updated = await cancelOrder(orderId);
      onOrdersChange((prev) => prev.map((order) => (order.id === updated.id ? updated : order)));
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
      await deleteOrderHistory(orderId);
      onOrdersChange((prev) => prev.filter((order) => order.id !== orderId));
    } catch (err) {
      setError(err.message);
    }
  }

  async function clearHistory() {
    try {
      await clearOrderHistory();
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

  return (
    <section className="panel automation-panel">
      <div className="panel-heading">
        <div>
          <p className="panel-title">Automatic entry</p>
          <p className="panel-subtitle">Limit buy, then Binance OCO for SL / TP</p>
        </div>
        <span className={`testnet-badge ${mode === "live" ? "live-badge" : ""}`}>{mode === "live" ? "LIVE" : "TESTNET"}</span>
      </div>
      <div className="order-limits">
        <span>Order limits</span>
        <label>Open<select value={maxOpenOrders} onChange={(event) => updateLimits(event.target.value, maxDailyOrders)}>{[1, 3, 5, 10, 20].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>Today<select value={maxDailyOrders} onChange={(event) => updateLimits(maxOpenOrders, event.target.value)}>{[5, 10, 20, 50, 100].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <span className={orderLimitReached ? "limit-warning" : "limit-remaining"}>{openSlots} open · {dailySlots} today left</span>
      </div>
      <div className="balance-metrics">
        <div className="balance-metric balance-primary"><span>Available {quoteAsset}</span><strong>{formatAmount(availableQuote, 2)} {quoteAsset}</strong><small>Free for new orders</small></div>
        <div className="balance-metric"><span>Held {baseAsset}</span><strong>{formatAmount(baseTotal, 8)} {baseAsset}</strong><small>{formatAmount(baseFree, 8)} free · {formatAmount(baseLocked, 8)} locked</small></div>
        <div className="balance-metric"><span>{baseAsset} value</span><strong>{formatAmount(baseValueUsdt, 2)} USDT</strong><small>At {currentPrice ? formatAmount(currentPrice, 6) : "—"} {quoteAsset}</small></div>
        <button type="button" className="refresh-balance-button" onClick={refreshBalance} disabled={refreshingBalance}>{refreshingBalance ? "Refreshing..." : "Refresh balance"}</button>
      </div>
      <form className="order-form" onSubmit={submit}>
        <label>Pair<select value={symbol} onChange={(event) => onSymbolChange(event.target.value)}>{symbols.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label className="entry-price-field">
          <span>Buy at or below</span>
          <div className="entry-price-controls">
            <input type="number" step="any" min="0" value={entryPrice} onChange={(event) => setEntryPrice(event.target.value)} required />
            <button type="button" className="market-price-button" onClick={() => currentPrice != null && setEntryPrice(currentPrice.toFixed(8))} disabled={currentPrice == null}>
              Market
            </button>
          </div>
        </label>
        <label>Order capital from balance<div className="capital-controls"><select className="capital-percent-select" value={capitalPercent} onChange={(event) => setCapitalPercent(event.target.value)}>{[1, 5, 10, 25, 50, 75, 100].map((percent) => <option key={percent} value={percent}>{percent}% = {formatAmount(availableQuote * percent / 100, 2)} {quoteAsset}</option>)}</select><button type="button" className="market-price-button" onClick={() => setCapitalPercent("100")} disabled={!availableQuote}>Max</button></div></label>
        <label>Stop-loss % · sell at/below<input type="number" step="0.1" min="0.1" value={stopLossPercent} onChange={(event) => setStopLossPercent(event.target.value)} required /></label>
        <label>Take-profit % · sell at/above<input type="number" step="0.1" min="0.1" value={takeProfitPercent} onChange={(event) => setTakeProfitPercent(event.target.value)} required /></label>
        <button className="primary-button" type="submit" disabled={busy || orderLimitReached}>{busy ? "Placing..." : orderLimitReached ? "Order limit reached" : "Place automatic order"}</button>
      </form>
      <p className="order-rule-note">The limit BUY fills when the market reaches this price or a lower price. Binance may fill it immediately if the market is already below it.</p>
      <div className="trade-preview">
        <span>Available {quoteAsset}: {availableQuote.toFixed(2)}</span>
        <span className={capital > availableQuote ? "loss-estimate" : ""}>Order capital: {capital.toFixed(2)} {quoteAsset}{capital > availableQuote ? " · insufficient" : ""}</span>
        <span>Binance fee: {feePercent.toFixed(3)}% per side</span>
        <span>Estimated quantity: {Number.isFinite(estimatedQuantity) ? estimatedQuantity.toFixed(6) : "—"}</span>
        <span>SL price: {formatAmount(stopPrice, 8)} · fees: -{formatAmount(stopFees, 6)} USDT</span>
        <span className="loss-estimate">SL net: -{formatAmount(estimatedLoss, 6)} USDT</span>
        <span>TP price: {formatAmount(targetPrice, 8)} · fees: -{formatAmount(targetFees, 6)} USDT</span>
        <span className={estimatedProfit >= 0 ? "profit-estimate" : "loss-estimate"}>TP net: {estimatedProfit >= 0 ? "+" : ""}{formatAmount(estimatedProfit, 6)} USDT</span>
        <span>Fee break-even: {breakEvenPercent.toFixed(2)}%+</span>
      </div>
      {error && <p className="order-error">{error}</p>}
      <div className="order-list">
        {orders.length === 0 && <p className="log-empty">No automatic orders yet.</p>}
        {orders.map((order) => (
          <div className="order-row" key={order.id}>
            <div>
              <strong>{order.symbol}</strong>
              <span>{order.entry_price} entry · SL {order.stop_loss_price} · TP {order.take_profit_price}</span>
              <span>Fees {order.fee_percent}% · SL -{order.estimated_loss_usdt} USDT · TP +{order.estimated_profit_usdt} USDT</span>
              {order.message && <span className={order.status === "ERROR" ? "order-error-text" : "order-note"}>{order.message}</span>}
            </div>
            <div className="order-status">
              <b className={order.status}>{order.status}</b>
              {order.status === "WAITING_ENTRY" && (
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
              {order.status === "PROTECTED" && <button type="button" onClick={() => cancel(order.id)}>Cancel + sell market</button>}
              {["CLOSED", "CANCELLED", "ERROR"].includes(order.status) && <button type="button" onClick={() => removeHistory(order.id)}>Delete</button>}
            </div>
          </div>
        ))}
      </div>
      <div className="binance-open-section">
        <div className="history-heading"><p className="panel-title">Open orders on Binance</p><span className="order-note">{mode === "live" ? "Live account view" : "Testnet account view"}</span></div>
        {binanceOpenOrders.length === 0 && <p className="log-empty">No other open Binance orders.</p>}
        {binanceOpenOrders.map((order) => (
          <div className="binance-order-row" key={`${order.symbol}-${order.orderId}`}>
            <strong>{order.symbol}</strong><span>{order.side} {order.type}</span><span>{order.origQty} @ {order.price || "market"}</span><b>{order.status}</b><button type="button" onClick={() => cancelExternalOrder(order)}>Cancel</button>
          </div>
        ))}
      </div>
      <div className="history-section">
        <div className="history-heading"><p className="panel-title">Order history</p><button type="button" className="history-clear-button" onClick={clearHistory}>Clear history</button></div>
        {orders.filter((order) => ["CLOSED", "CANCELLED", "ERROR"].includes(order.status)).length === 0 && <p className="log-empty">No completed orders yet.</p>}
        {orders.filter((order) => ["CLOSED", "CANCELLED", "ERROR"].includes(order.status)).map((order) => (
          <div className="history-row" key={`history-${order.id}`}>
            <span>{order.symbol}</span><span>{order.status}</span><span>{order.exit_price ?? "—"}</span>
            <strong className={(order.realized_profit_usdt ?? 0) >= 0 ? "profit-estimate" : "loss-estimate"}>{order.realized_profit_usdt == null ? "—" : `${order.realized_profit_usdt >= 0 ? "+" : ""}${order.realized_profit_usdt.toFixed(2)} USDT`}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function formatAmount(value, maximumFractionDigits) {
  const minimumFractionDigits = maximumFractionDigits > 2 ? Math.min(maximumFractionDigits, 6) : 2;
  return Number(value).toLocaleString(undefined, { minimumFractionDigits, maximumFractionDigits });
}