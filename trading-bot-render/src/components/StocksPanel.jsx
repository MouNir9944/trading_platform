import { useEffect, useMemo, useState } from "react";

import StockResearch from "./StockResearch.jsx";
import { usePersistentState, oneOf, isText } from "../lib/persist.js";
import { cancelStockOrder, getStockOrders, getStockPortfolio, getStockQuote, getStockSymbols, placeStockOrder } from "../api.js";

const money = (n, digits = 2) => (n == null || !Number.isFinite(Number(n)) ? "—" : `${Number(n) < 0 ? "−" : ""}${Math.abs(Number(n)).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`);
const signed = (n, digits = 2) => (n == null ? "—" : `${n >= 0 ? "+" : "−"}${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`);
const tone = (n) => (n == null ? "" : n >= 0 ? "profit-estimate" : "loss-estimate");
const clock = (ms) => (ms ? new Date(Number(ms)).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const WIDE_SPREAD_PCT = 3; // quotes further apart than this mean the market is probably closed

/**
 * Binance Stocks: your holdings and a buy / sell ticket. This is a separate product from Spot with its own API,
 * available on the live account only, so everything here is real money and ignores the Testnet / Live switch.
 */
export default function StocksPanel() {
  const [portfolio, setPortfolio] = useState(null);
  const [portfolioError, setPortfolioError] = useState(null);
  const [orders, setOrders] = useState({ open: [], recent: [] });
  const [symbols, setSymbols] = useState([]);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // The ticket is remembered across refreshes, except quantity and limit price: those go stale as the market moves.
  const [symbol, setSymbol] = usePersistentState("pref:stocks-symbol", "", isText);
  const [researchSymbol, setResearchSymbol] = usePersistentState("pref:stocks-research-symbol", "", isText); // what the analysis shows: only set by picking, never by typing
  const [side, setSide] = usePersistentState("pref:stocks-side", "BUY", oneOf(["BUY", "SELL"]));
  const [orderType, setOrderType] = usePersistentState("pref:stocks-order-type", "MARKET", oneOf(["MARKET", "LIMIT"]));
  const [amount, setAmount] = usePersistentState("pref:stocks-amount", "10", isText); // USD for a market buy, shares otherwise
  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState("");
  const [session, setSession] = usePersistentState("pref:stocks-session", "RTH", oneOf(["RTH", "EXTENDED", "24H"]));
  const [tif, setTif] = usePersistentState("pref:stocks-tif", "DAY", oneOf(["DAY", "GTC"]));
  const [quoteAsset, setQuoteAsset] = usePersistentState("pref:stocks-quote-asset", "USDC", oneOf(["USDC", "USDT"]));
  const [wallet, setWallet] = usePersistentState("pref:stocks-wallet", "MAIN", oneOf(["MAIN", "CARD"]));
  const [tokenize, setTokenize] = usePersistentState("pref:stocks-tokenize", false, (v) => typeof v === "boolean");
  const [quote, setQuote] = useState(null);

  const loadPortfolio = () => getStockPortfolio().then((data) => { setPortfolio(data); setPortfolioError(null); }).catch((err) => setPortfolioError(err.message));
  const loadOrders = () => getStockOrders().then(setOrders).catch(() => {});

  useEffect(() => {
    loadPortfolio();
    loadOrders();
    getStockSymbols().then((data) => setSymbols(data.symbols ?? [])).catch(() => {});
    const a = window.setInterval(loadPortfolio, 60_000);
    const b = window.setInterval(loadOrders, 10_000);
    return () => { window.clearInterval(a); window.clearInterval(b); };
  }, []);

  const ticker = symbol.trim().toUpperCase();
  const info = useMemo(() => symbols.find((s) => s.symbol === ticker) ?? null, [symbols, ticker]);
  const held = portfolio?.holdings?.find((h) => h.symbol === ticker) ?? null;

  useEffect(() => {
    setQuote(null);
    if (!info) return undefined;
    let cancelled = false;
    const load = () => getStockQuote(ticker).then((q) => { if (!cancelled) setQuote(q); }).catch(() => {});
    load();
    const id = window.setInterval(load, 10_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [ticker, info]);

  const bid = Number(quote?.bidPrice) || null;
  const ask = Number(quote?.askPrice) || null;
  const spreadPct = bid && ask ? ((ask - bid) / ((ask + bid) / 2)) * 100 : null;
  const wide = spreadPct != null && spreadPct > WIDE_SPREAD_PCT;
  const marketBlocked = orderType === "MARKET" && wide;

  const marketBuy = orderType === "MARKET" && side === "BUY";
  const qtyNumber = Number(quantity);
  const priceNumber = Number(price);
  const amountNumber = Number(amount);
  const estimate = marketBuy ? amountNumber : orderType === "LIMIT" ? qtyNumber * priceNumber : qtyNumber * (bid ?? 0);
  const tradable = info && String(info.tradability ?? "").includes(side);
  const minimum = info?.minNotional ?? 0;
  const valid = tradable && (marketBuy ? amountNumber > 0 : qtyNumber > 0) && (orderType === "MARKET" || priceNumber > 0) && estimate >= minimum && !marketBlocked;

  function pick(nextSymbol, nextSide = "BUY") {
    setSymbol(nextSymbol);
    setSide(nextSide);
    setMessage(null);
    setError(null);
    if (nextSide === "SELL") { setQuantity(""); setOrderType("MARKET"); }
  }

  async function submit(event) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    const body = { symbol: ticker, side, order_type: orderType, quote_asset: quoteAsset, tokenize };
    if (side === "BUY") body.wallet_type = wallet;
    if (marketBuy) body.notional = amountNumber;
    else body.quantity = qtyNumber;
    if (orderType === "LIMIT") Object.assign(body, { price: priceNumber, trading_session: session, time_in_force: tif });
    const summary = marketBuy ? `spend about ${money(amountNumber)} ${quoteAsset}` : `${side === "BUY" ? "buy" : "sell"} ${qtyNumber} shares`;
    const text = `REAL MONEY: Binance Stocks order\n\n${side} ${ticker} · ${orderType}${orderType === "LIMIT" ? ` at ${money(priceNumber)} (${session}, ${tif})` : ""}\n${summary}\nPaid from ${side === "BUY" ? `${wallet} wallet in ${quoteAsset}` : "your stock holding"}\nEstimated value ${money(estimate)}\n\nThere is no stop-loss on Binance Stocks. Place it?`;
    if (!window.confirm(text)) return;
    setBusy(true);
    try {
      const result = await placeStockOrder(body);
      setMessage(`Order sent: ${result.status ?? "accepted"} (${String(result.orderId ?? "").slice(0, 8)}…). Holdings update in a few seconds.`);
      loadOrders();
      window.setTimeout(loadPortfolio, 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function cancel(orderId) {
    try {
      await cancelStockOrder(orderId);
      loadOrders();
    } catch (err) {
      setError(err.message);
    }
  }

  const totals = portfolio?.totals;
  return (
    <div className="stocks-view">
      <div className="stocks-left">
      <section className="panel stocks-main">
        <div className="panel-heading">
          <div>
            <p className="panel-title">My Binance Stocks</p>
            <p className="panel-subtitle">US stocks and ETFs · live account only</p>
          </div>
          <div className="stocks-head-actions">
            <button type="button" className="mini-button" onClick={() => window.open(`${window.location.pathname}#stocks`, "_blank", "noopener")} title="Open My stocks in its own browser tab or window">Open in new tab ↗</button>
            <span className="testnet-badge live-badge">LIVE</span>
          </div>
        </div>

        {portfolioError && (
          <div className="futures-notice is-error">
            <strong>Could not load your stocks</strong>
            <p>{portfolioError}</p>
            <p>This needs your <b>live</b> API key (<b>BINANCE_API_KEY_real</b>) with permission to use Binance Stocks, and this server's IP allowed on that key.</p>
          </div>
        )}
        {!portfolio && !portfolioError && <p className="log-empty">Reading your Binance Stocks history…</p>}

        {portfolio && (
          <>
            <div className="balance-metrics stocks-totals">
              <div className="balance-metric balance-primary"><span>Stocks value</span><strong>{money(totals.value)} USD</strong><small>At the current bid</small></div>
              <div className="balance-metric"><span>Cost</span><strong>{money(totals.cost)} USD</strong><small>Fees included</small></div>
              <div className="balance-metric"><span>Unrealized P/L</span><strong className={tone(totals.pnl)}>{signed(totals.pnl)} USD</strong><small>{totals.cost > 0 ? `${signed((totals.pnl / totals.cost) * 100)}%` : ""}</small></div>
              <div className="balance-metric"><span>Realized P/L</span><strong className={tone(totals.realized)}>{signed(totals.realized)} USD</strong><small>From {portfolio.tradeCount} trades</small></div>
            </div>

            {portfolio.holdings.length === 0 ? (
              <p className="log-empty">No open stock positions found in your trade history.</p>
            ) : (
              <div className="stocks-table" role="table" aria-label="Holdings">
                <div className="stocks-row stocks-head" role="row">
                  <span>Asset</span><span>Shares</span><span>Price / avg cost</span><span>Value</span><span>P/L</span><span />
                </div>
                {portfolio.holdings.map((h) => (
                  <div className="stocks-row" role="row" key={h.symbol}>
                    <span className="stocks-asset"><strong>{h.symbol}</strong><small>{h.name ?? ""}</small></span>
                    <span>{h.quantity.toFixed(6)}</span>
                    <span>{money(h.price)}<small>{money(h.avgCost)}</small></span>
                    <span>{money(h.value)}</span>
                    <span className={tone(h.pnl)}>{signed(h.pnl, 3)}<small>{h.pnlPct == null ? "" : `${signed(h.pnlPct)}%`}</small></span>
                    <span className="stocks-actions">
                      <button type="button" onClick={() => { setSymbol(h.symbol); setResearchSymbol(h.symbol); document.querySelector(".stock-research")?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>Analyze</button>
                      <button type="button" onClick={() => pick(h.symbol, "BUY")}>Buy</button>
                      <button type="button" onClick={() => pick(h.symbol, "SELL")}>Sell</button>
                    </span>
                  </div>
                ))}
              </div>
            )}
            <p className="order-rule-note">
              Binance has no holdings endpoint for stocks, so this list is rebuilt from your executed trades (fees included in the cost) and valued at the bid.
              Deposits, transfers and corporate actions are not counted. The quantities and costs match the Binance app for the trades found.
            </p>
          </>
        )}

        <div className="stocks-orders">
          <p className="panel-title">Orders</p>
          {orders.open.length === 0 && <p className="log-empty">No open stock orders.</p>}
          {orders.open.map((o) => (
            <div className="binance-order-row" key={o.orderId}>
              <strong>{o.symbol}</strong><span>{o.side} {o.orderType}{o.limitPrice ? ` @ ${money(o.limitPrice)}` : ""}</span><span>{o.qty ?? `${o.notional} ${o.quote ?? ""}`}</span><b>{o.status}</b>
              <button type="button" onClick={() => cancel(o.orderId)}>Cancel</button>
            </div>
          ))}
          {orders.recent.length > 0 && <p className="stocks-sub">Recent (30 days)</p>}
          {orders.recent.map((o) => (
            <div className="binance-order-row" key={`r-${o.orderId}`}>
              <strong>{o.symbol}</strong>
              <span className={o.side === "BUY" ? "profit-estimate" : "loss-estimate"}>{o.side}</span>
              <span>{Number(o.filledQty) > 0 ? `${Number(o.filledQty).toFixed(6)} @ ${money(o.avgFilledPrice)}` : o.orderType}</span>
              <b className={`status-pill ${o.status === "FILLED" ? "CLOSED" : o.status === "CANCELED" ? "CANCELLED" : ""}`}>{o.status}</b>
              <span className="order-note">{clock(o.createdAt)}</span>
            </div>
          ))}
        </div>
      </section>

      <StockResearch
        symbol={researchSymbol}
        holdings={portfolio?.holdings ?? []}
        onPick={(next) => { setResearchSymbol(next); setSymbol(next); setMessage(null); setError(null); }}
      />
      </div>

      <section className="panel stocks-ticket">
        <div className="panel-heading">
          <div>
            <p className="panel-title">Buy or sell</p>
            <p className="panel-subtitle">Market or limit, in fractions if the stock allows</p>
          </div>
        </div>
        <form className="order-form" onSubmit={submit}>
          <div className="fut-side-toggle" role="group" aria-label="Side">
            <button type="button" className={side === "BUY" ? "is-long is-on" : ""} aria-pressed={side === "BUY"} onClick={() => setSide("BUY")}>Buy</button>
            <button type="button" className={side === "SELL" ? "is-short is-on" : ""} aria-pressed={side === "SELL"} onClick={() => { setSide("SELL"); setOrderType("MARKET"); }}>Sell</button>
          </div>

          <label>Stock or ETF ticker
            <input list="stock-symbols" value={symbol} onChange={(e) => { setSymbol(e.target.value.toUpperCase()); setMessage(null); }} placeholder="AAPL, GLD, MAGS…" autoComplete="off" required />
            <datalist id="stock-symbols">{symbols.slice(0, 600).map((s) => <option key={s.symbol} value={s.symbol} />)}</datalist>
          </label>

          {ticker && !info && symbols.length > 0 && <p className="order-error">{ticker} is not on Binance Stocks.</p>}
          {info && !tradable && <p className="order-error">{ticker} cannot be {side === "BUY" ? "bought" : "sold"} right now ({info.tradability}).</p>}
          {info && (
            <div className="stocks-quote">
              <span>Bid <b>{bid ? money(bid) : "—"}</b></span>
              <span>Ask <b>{ask ? money(ask) : "—"}</b></span>
              <span>{info.fractionable ? "fractions ok" : "whole shares"} · min {money(minimum)}</span>
              {held && <span>You hold <b>{held.quantity.toFixed(6)}</b></span>}
            </div>
          )}
          {wide && <p className="order-error">Bid and ask are {spreadPct.toFixed(0)}% apart: the market is probably closed. A market order could fill far from the price you expect, so use a limit order.</p>}

          <div className="fut-side-toggle" role="group" aria-label="Order type">
            <button type="button" className={orderType === "MARKET" ? "is-on" : ""} onClick={() => setOrderType("MARKET")}>Market</button>
            <button type="button" className={orderType === "LIMIT" ? "is-on" : ""} onClick={() => setOrderType("LIMIT")}>Limit</button>
          </div>

          {marketBuy ? (
            <label>Amount to spend ({quoteAsset})
              <input type="number" step="any" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} required />
              <span className="stocks-chips">{[10, 25, 50, 100].map((v) => <button type="button" key={v} onClick={() => setAmount(String(v))}>{v}</button>)}</span>
            </label>
          ) : (
            <label>Shares
              <input type="number" step="any" min="0" value={quantity} onChange={(e) => setQuantity(e.target.value)} required />
              {side === "SELL" && held && <span className="stocks-chips"><button type="button" onClick={() => setQuantity(String(held.quantity))}>Sell all</button><button type="button" onClick={() => setQuantity(String(held.quantity / 2))}>Half</button></span>}
            </label>
          )}

          {orderType === "LIMIT" && (
            <>
              <label>Limit price (2 decimals)
                <input type="number" step="0.01" min="0.01" value={price} onChange={(e) => setPrice(e.target.value)} required />
                <span className="stocks-chips">
                  {bid && <button type="button" onClick={() => setPrice(bid.toFixed(2))}>Bid</button>}
                  {ask && <button type="button" onClick={() => setPrice(ask.toFixed(2))}>Ask</button>}
                </span>
              </label>
              <label>Session
                <select value={session} onChange={(e) => setSession(e.target.value)}>
                  <option value="RTH">Regular hours</option>
                  <option value="EXTENDED">Extended hours</option>
                  <option value="24H">24 hours</option>
                </select>
              </label>
              <label>Good for
                <select value={tif} onChange={(e) => setTif(e.target.value)}>
                  <option value="DAY">The day</option>
                  <option value="GTC">Until cancelled</option>
                </select>
              </label>
            </>
          )}

          {side === "BUY" && (
            <div className="stocks-funding">
              <label>Pay in
                <select value={quoteAsset} onChange={(e) => setQuoteAsset(e.target.value)}><option>USDC</option><option>USDT</option></select>
              </label>
              <label>From wallet
                <select value={wallet} onChange={(e) => setWallet(e.target.value)}><option value="MAIN">Main (spot)</option><option value="CARD">Card</option></select>
              </label>
              <label className="switch"><input type="checkbox" checked={tokenize} onChange={(e) => setTokenize(e.target.checked)} /> Tokenize on settlement (moves it to your Spot wallet as a token)</label>
            </div>
          )}

          <button className={`primary-button ${side === "SELL" ? "is-short" : ""}`} type="submit" disabled={busy || !valid}>
            {busy ? "Sending…" : marketBlocked ? "Use a limit order" : `${side === "BUY" ? "Buy" : "Sell"} ${ticker || "stock"}`}
          </button>
        </form>
        {info && estimate > 0 && estimate < minimum && <p className="order-error">Binance's minimum for {ticker} is {money(minimum)}.</p>}
        {error && <p className="order-error">{error}</p>}
        {message && <p className="order-note">{message}</p>}
        <p className="order-rule-note">
          Real money on your live account. Binance Stocks has no stop-loss or take-profit orders, and stock prices only move while the US market is open (extended sessions are thinner).
          If Binance refuses the funding, try the other currency or wallet.
        </p>
      </section>
    </div>
  );
}
