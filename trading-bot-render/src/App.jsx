import { useEffect, useMemo, useRef, useState } from "react";
import { analyze, toCandles } from "../shared/analysis/index.js";
import Header from "./components/Header.jsx";
import PriceChart from "./components/PriceChart.jsx";
import AutoOrderPanel from "./components/AutoOrderPanel.jsx";
import StatsBar from "./components/StatsBar.jsx";
import MultiChart from "./components/MultiChart.jsx";
import StrategiesPanel from "./components/StrategiesPanel.jsx";
import NewsPanel from "./components/NewsPanel.jsx";
import NotificationCenter from "./components/NotificationCenter.jsx";
import { usePersistentState, oneOf } from "./lib/persist.js";
import StocksPanel from "./components/StocksPanel.jsx";
import PerformancePanel from "./components/PerformancePanel.jsx";
import { getAccountMode, getFuturesAccount, getFuturesOrders, getMarketOverview, getPrice, getRisk, resetRiskDrawdown, updateRisk, getBalance, getBinanceOpenOrders, getCandles, getOrders, getStatus, setAccountMode } from "./api.js";

const DEFAULT_INTERVAL = "5m";
const CHART_INTERVALS = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d", "1w"]; // what the chart can show
const REFRESH_CHOICES = [10000, 15000, 30000, 60000]; // the Header dropdown
const INITIAL_CANDLES = 1000; // Binance's maximum per request
const MAX_CANDLES = 10000;
const ANALYSIS_CANDLES = 1000; // indicators only need recent history

/** Merge two kline lists by open time, oldest first. Later entries win. */
function mergeCandles(...lists) {
  const byTime = new Map();
  for (const list of lists) for (const candle of list) byTime.set(candle[0], candle);
  return [...byTime.values()].sort((a, b) => a[0] - b[0]).slice(-MAX_CANDLES);
}

const DEFAULT_SYMBOLS = { spot: "XLMUSDT", futures: "BTCUSDT" };
const SYMBOL_KEYS = { spot: "trading-symbol", futures: "trading-symbol-futures" };

function readStorage(key) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

const loadMarket = () => (readStorage("trading-market") === "futures" ? "futures" : "spot");
const loadSymbol = (market) => readStorage(SYMBOL_KEYS[market]) || DEFAULT_SYMBOLS[market];

export default function App() {
  const [price, setPrice] = useState(null);
  const [market, setMarket] = useState(loadMarket);
  const [symbol, setSymbol] = useState(() => loadSymbol(loadMarket()));
  const [selectedEntryPrice, setSelectedEntryPrice] = useState(null);
  const [interval, setChartInterval] = usePersistentState("pref:chart-interval", DEFAULT_INTERVAL, oneOf(CHART_INTERVALS));
  const [orders, setOrders] = useState([]);
  const [binanceOpenOrders, setBinanceOpenOrders] = useState([]);
  const [priceDirection, setPriceDirection] = useState(null);
  const [balances, setBalances] = useState([]);
  const [candles, setCandles] = useState([]);
  // Which mode/market/pair/timeframe `candles` belong to. It changes in the same update as the candles do, so
  // the chart can tell "a different series" apart from "older history was added".
  const [candlesKey, setCandlesKey] = useState("");
  const [alertPlan, setAlertPlan] = useState(null);
  // The order ticket currently being set up (entry/stop/target), reported by AutoOrderPanel/FuturesTicket so the
  // chart can draw it as draggable lines. Dragging one only ever writes back into the ticket's own fields below, so
  // whatever comes out of it is still checked by the same risk rules as typing the numbers in by hand.
  const [draftOrder, setDraftOrder] = useState(null);
  // strategies whose signals are drawn on the trading chart (chosen in the chart's "Strategies" menu or on the Strategies screen)
  const [chartSettings, setChartSettings] = usePersistentState("pref:chart-strategy-settings", {}, (v) => v && typeof v === "object" && !Array.isArray(v));
  const [chartStrategies, setChartStrategies] = usePersistentState("pref:chart-strategies", [], (v) => Array.isArray(v) && v.every((x) => typeof x === "string"));
  // "#charts" in the address opens the multi-chart screen directly (used to pop it out into its own browser tab).
  const [view, setView] = useState(() => {
    if (window.location.hash === "#charts") return "charts";
    if (window.location.hash === "#stocks") return "stocks";
    if (window.location.hash === "#news") return "news";
    if (window.location.hash === "#strategies" || window.location.hash === "#amd") return "strategies";
    if (window.location.hash === "#performance") return "performance";
    const saved = readStorage("app-view");
    return saved === "stocks" ? "stocks" : "trading";
  });
  const [futuresAccount, setFuturesAccount] = useState(null);
  const [futuresError, setFuturesError] = useState(null);
  const [refreshMs, setRefreshMs] = usePersistentState("pref:refresh-ms", 15000, oneOf(REFRESH_CHOICES));
  const [connectionOk, setConnectionOk] = useState(null);
  const [mode, setMode] = useState("paper");
  const [error, setError] = useState(null);
  const [storage, setStorage] = useState(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [overview, setOverview] = useState(null);
  const [risk, setRisk] = useState(null);
  const candlesRef = useRef([]);
  const seriesKeyRef = useRef(""); // which mode/pair/timeframe the candles belong to
  const exhaustedRef = useRef(false); // no older candles exist
  const loadingOlderRef = useRef(false);
  candlesRef.current = candles;

  const [tzMode, setTzMode] = useState(() => {
    try { return window.localStorage.getItem("chart-tz") === "utc" ? "utc" : "local"; } catch { return "local"; }
  });
  const timeZone = useMemo(() => (tzMode === "utc" ? "UTC" : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"), [tzMode]);
  const lastPriceRef = useRef(null);
  // Indicators, structure and strategy signals for whatever the chart is showing.
  const analysis = useMemo(() => analyze(toCandles(candles.slice(-ANALYSIS_CANDLES))), [candles]);
  const loadHourly = () => getCandles(symbol, "1h", 1000, undefined, market).then((res) => toCandles(res.candles ?? []));
  const loadHistory = () => getCandles(symbol, interval, 1000, undefined, market).then((res) => toCandles(res.candles ?? []));

  /** Called by the chart when the user scrolls to the oldest candle we have: fetch 1000 earlier ones. */
  async function loadOlder() {
    const current = candlesRef.current;
    if (loadingOlderRef.current || exhaustedRef.current || current.length === 0 || current.length >= MAX_CANDLES) return;
    const seriesKey = `${mode}:${market}:${symbol}:${interval}`;
    if (seriesKeyRef.current !== seriesKey) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const res = await getCandles(symbol, interval, INITIAL_CANDLES, current[0][0] - 1, market);
      const older = res.candles ?? [];
      if (seriesKeyRef.current !== seriesKey) return; // pair or timeframe changed meanwhile
      if (older.length < INITIAL_CANDLES) exhaustedRef.current = true; // reached the start of the pair's history
      if (older.length) setCandles((previous) => mergeCandles(older, previous));
    } catch {
      // Try again the next time the user scrolls to the edge.
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }

  /** Page back through every candle Binance has for this pair/timeframe (up to MAX_CANDLES). */
  async function loadAllHistory() {
    // If a scroll-triggered page is already in flight, let it finish first.
    for (let waited = 0; loadingOlderRef.current && waited < 100; waited += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    const seriesKey = `${mode}:${market}:${symbol}:${interval}`;
    if (loadingOlderRef.current || seriesKeyRef.current !== seriesKey || candlesRef.current.length === 0) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      let oldest = candlesRef.current[0][0];
      let total = candlesRef.current.length;
      while (!exhaustedRef.current && total < MAX_CANDLES) {
        const res = await getCandles(symbol, interval, INITIAL_CANDLES, oldest - 1, market);
        if (seriesKeyRef.current !== seriesKey) return; // pair or timeframe changed meanwhile
        const older = res.candles ?? [];
        if (older.length < INITIAL_CANDLES) exhaustedRef.current = true;
        if (!older.length) break;
        setCandles((previous) => mergeCandles(older, previous));
        oldest = older[0][0];
        total += older.length;
      }
    } catch {
      // Keep whatever was loaded so far.
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }

  // A new pair must not inherit the previous pair's price (the order ticket seeds its entry from it).
  useEffect(() => {
    setPrice(null);
    lastPriceRef.current = null;
  }, [symbol, market]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SYMBOL_KEYS[market], symbol);
      window.localStorage.setItem("trading-market", market);
    } catch { /* storage unavailable */ }
  }, [symbol, market]);

  const changeView = (next) => {
    setView(next);
    try { window.localStorage.setItem("app-view", next === "charts" || next === "news" || next === "strategies" || next === "performance" ? "trading" : next); } catch { /* storage unavailable */ }
    try { window.history.replaceState(null, "", next === "charts" || next === "stocks" || next === "news" || next === "strategies" || next === "performance" ? `#${next}` : `${window.location.pathname}${window.location.search}`); } catch { /* not critical */ }
  };

  // "Trade" on a multi-chart cell: open that pair, market and timeframe on the trading screen.
  const openFromCharts = ({ market: nextMarket, symbol: nextSymbol, interval: nextInterval }) => {
    if (nextMarket !== market) setMarket(nextMarket);
    setSymbol(nextSymbol);
    setChartInterval(nextInterval);
    setSelectedEntryPrice(null);
    changeView("trading");
  };

  // "Use in order ticket" on a bot notification: open that pair and fill the ticket with the plan's entry, stop and target.
  const useAmdPlan = (event) => {
    const { plan } = event;
    if (!plan) return;
    if (event.market && event.market !== market) setMarket(event.market);
    setSymbol(event.symbol);
    if (event.interval) setChartInterval(event.interval);
    setSelectedEntryPrice(null);
    changeView("trading");
    const pct = (delta, base) => Number(((Math.abs(delta) / base) * 100).toFixed(3));
    // Applied in the same state update as the market/symbol switch (not delayed): the ticket's own effect turns off
    // "Auto" risk sizing as soon as it sees this plan, so nothing overwrites it once the pair settles.
    setAlertPlan({
      nonce: Date.now(),
      symbol: event.symbol,
      side: plan.side ?? (event.dir === "bear" ? "short" : "long"),
      entry: plan.entry,
      stopLossPercent: pct(plan.entry - plan.stopLoss, plan.entry),
      takeProfitPercent: pct(plan.target - plan.entry, plan.entry),
    });
  };

  // Dragging the entry line, the TP zone or the SL zone on the chart: recompute the percent the ticket actually
  // uses and hand it to the SAME "apply a plan" pipeline as a notification's "Use in order ticket", so it is
  // screened by the identical risk checks (server-enforced on submit either way) before anything can be placed.
  const onDraftDrag = (kind, rawPrice) => {
    if (!draftOrder || draftOrder.symbol !== symbol || !Number.isFinite(rawPrice) || rawPrice <= 0) return;
    const { side } = draftOrder;
    let entry = draftOrder.entry;
    let stopLoss = draftOrder.stopLoss;
    let takeProfit = draftOrder.takeProfit;
    if (kind === "entry") entry = rawPrice;
    else if (kind === "stop") stopLoss = rawPrice;
    else if (kind === "target") takeProfit = rawPrice;
    if (!(entry > 0)) return;
    const pct = (delta, base) => Number(((Math.abs(delta) / base) * 100).toFixed(3));
    setAlertPlan({
      nonce: Date.now(),
      symbol,
      side,
      entry,
      stopLossPercent: Math.max(0.01, pct(entry - stopLoss, entry)),
      takeProfitPercent: Math.max(0.01, pct(takeProfit - entry, entry)),
    });
  };

  const showStrategyOnChart = (id) => {
    setChartStrategies((list) => (list.includes(id) ? list : [...list, id]));
    changeView("trading");
  };

  // Spot and futures are separate instrument lists: each remembers its own last pair.
  const changeMarket = (next) => {
    if (next === market) return;
    setMarket(next);
    setSymbol(loadSymbol(next));
    setSelectedEntryPrice(null);
  };

  // Pair comparison + ranking for the header selector. The server caches it for a minute.
  useEffect(() => {
    let cancelled = false;
    setOverview(null);
    const load = () => getMarketOverview("USDT", market).then((data) => { if (!cancelled) setOverview(data); }).catch(() => {});
    load();
    const id = window.setInterval(load, 60_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [mode, market]);

  // Risk limits and where the account stands against them. Refreshed often: it drives order approval previews.
  const refreshRisk = () => getRisk(market).then(setRisk).catch(() => {});
  useEffect(() => {
    let cancelled = false;
    const load = () => getRisk(market).then((data) => { if (!cancelled) setRisk(data); }).catch(() => {});
    setRisk(null);
    load();
    const id = window.setInterval(load, 10_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [mode, market]);

  // The futures wallet, open positions and margin mode. Only polled while the futures market is on screen.
  const refreshFutures = () => getFuturesAccount(mode).then((data) => { setFuturesAccount(data); setFuturesError(null); }).catch((err) => setFuturesError(err.message));
  useEffect(() => {
    setFuturesAccount(null);
    setFuturesError(null);
    if (market !== "futures") return undefined;
    let cancelled = false;
    const load = () => getFuturesAccount(mode)
      .then((data) => { if (!cancelled) { setFuturesAccount(data); setFuturesError(null); } })
      .catch((err) => { if (!cancelled) setFuturesError(err.message); });
    load();
    const id = window.setInterval(load, 5000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [mode, market]);

  const saveRisk = async (patch) => setRisk(await updateRisk(patch, market));
  const resetDrawdown = async () => setRisk(await resetRiskDrawdown(market));

  useEffect(() => {
    getAccountMode().then((data) => setMode(data.mode)).catch(() => {});
    getStatus().then((data) => setStorage(data.storage)).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        // Market data must not depend on the account: without API keys the balance fails but the chart still works.
        const [priceRes, balanceRes, candlesRes] = await Promise.all([
          getPrice(symbol, market),
          market === "futures" ? { balances: [] } : getBalance().catch(() => ({ balances: [] })),
          getCandles(symbol, interval, INITIAL_CANDLES, undefined, market),
        ]);

        if (cancelled) return;

        // Track price direction for the tick flash
        if (lastPriceRef.current != null) {
          if (priceRes.price > lastPriceRef.current) setPriceDirection("up");
          else if (priceRes.price < lastPriceRef.current) setPriceDirection("down");
        }
        lastPriceRef.current = priceRes.price;
        setPrice(priceRes.price);

        setBalances(balanceRes.balances ?? []);
        // Keep any older history the user already scrolled back to; only replace it when the series changes.
        const seriesKey = `${mode}:${market}:${symbol}:${interval}`;
        const sameSeries = seriesKeyRef.current === seriesKey;
        seriesKeyRef.current = seriesKey;
        if (!sameSeries) exhaustedRef.current = false;
        const fetched = candlesRes.candles ?? [];
        setCandles((previous) => (sameSeries ? mergeCandles(previous, fetched) : fetched));
        if (!sameSeries) setCandlesKey(seriesKey);
        setConnectionOk(true);
        setError(null);

      } catch (err) {
        if (cancelled) return;
        setConnectionOk(false);
        setError(err.message || "Failed to reach the backend.");
      }
    }

    poll();
    const id = window.setInterval(poll, refreshMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [refreshMs, symbol, interval, mode, market]);

  useEffect(() => {
    let stream;
    let reconnectTimer;
    let stopped = false;

    function connect() {
      // Paper mode has no exchange of its own: it streams the real live feed too, same as live trading.
      const streamHost = market === "futures" ? "fstream.binance.com" : "stream.binance.com:9443";
      stream = new WebSocket(`wss://${streamHost}/ws/${symbol.toLowerCase()}@kline_${interval}`);
      stream.onmessage = (event) => {
        const message = JSON.parse(event.data);
        const kline = message.k;
        if (!kline) return;
        const liveCandle = [kline.t, kline.o, kline.h, kline.l, kline.c, kline.v, kline.T, kline.q, kline.n, kline.V, kline.Q, "0"];
        setPrice(Number(kline.c));
        setCandles((previous) => {
          const next = [...previous];
          const index = next.findIndex((candle) => candle[0] === liveCandle[0]);
          if (index >= 0) next[index] = liveCandle;
          else next.push(liveCandle);
          return next.slice(-MAX_CANDLES);
        });
      };
      stream.onclose = () => {
        if (!stopped) reconnectTimer = window.setTimeout(connect, 3000);
      };
      stream.onerror = () => stream.close();
    }

    connect();
    return () => {
      stopped = true;
      window.clearTimeout(reconnectTimer);
      stream?.close();
    };
  }, [symbol, interval, mode, market]);

  useEffect(() => {
    let stopped = false;
    async function refreshLiveMarket() {
      try {
        const [priceRes, candlesRes] = await Promise.all([
          getPrice(symbol, market),
          getCandles(symbol, interval, 1, undefined, market),
        ]);
        if (stopped) return;
        setPrice(priceRes.price);
        if (candlesRes.candles?.length) {
          const latest = candlesRes.candles[0];
          setCandles((previous) => {
            const next = [...previous];
            const index = next.findIndex((candle) => candle[0] === latest[0]);
            if (index >= 0) next[index] = latest;
            else next.push(latest);
            return next.slice(-MAX_CANDLES);
          });
        }
      } catch {
        // The normal REST poll and WebSocket reconnect continue independently.
      }
    }

    refreshLiveMarket();
    const id = window.setInterval(refreshLiveMarket, 10000);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [symbol, interval, mode, market]);

  useEffect(() => {
    let cancelled = false;
    setOrders([]); // never show the other market's orders while this one loads
    const refreshOrders = () => (market === "futures"
      ? getFuturesOrders(mode).then((managed) => {
        if (!cancelled) {
          setMode(managed.mode ?? "paper");
          setOrders(managed.orders ?? []);
          setBinanceOpenOrders([]);
        }
      })
      : Promise.all([getOrders(mode), getBinanceOpenOrders(undefined, mode)]).then(([managed, open]) => {
        if (!cancelled) {
          setMode(managed.mode ?? "paper");
          setOrders(managed.orders ?? []);
          setBinanceOpenOrders(open.orders ?? []);
        }
      })).catch(() => {});
    refreshOrders();
    const id = window.setInterval(refreshOrders, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [mode, market]);

  async function changeMode(nextMode) {
    if (nextMode === "live" && !window.confirm("Live mode uses real Binance funds. Continue?")) return;
    try {
      const result = await setAccountMode(nextMode);
      setMode(result.mode);
      setBalances([]);
      setFuturesAccount(null);
      setOrders([]);
      setBinanceOpenOrders([]);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="app">
      <Header
        symbol={symbol}
        price={price}
        priceDirection={priceDirection}
        connectionOk={connectionOk}
        refreshMs={refreshMs}
        onRefreshChange={setRefreshMs}
        mode={mode}
        onModeChange={changeMode}
        storage={storage}
        timeZone={timeZone}
        overview={overview}
        market={market}
        onMarketChange={changeMarket}
        view={view}
        onViewChange={changeView}
        notifications={<NotificationCenter timeZone={timeZone} onUsePlan={useAmdPlan} onOpenSettings={() => changeView("strategies")} />}
        onSymbolChange={(nextSymbol) => {
          setSymbol(nextSymbol);
          setSelectedEntryPrice(null);
        }}
      />

      {view === "stocks" && <StocksPanel />}
      {view === "news" && <NewsPanel timeZone={timeZone} />}
      {view === "strategies" && <StrategiesPanel risk={risk} timeZone={timeZone} chartStrategies={chartStrategies} onShowOnChart={showStrategyOnChart} />}
      {view === "performance" && <PerformancePanel mode={mode} timeZone={timeZone} />}
      {view === "charts" && <MultiChart mode={mode} timeZone={timeZone} onOpen={openFromCharts} />}

      {/* the trading screen stays mounted (chart, indicators) while another view is open */}
      <div className="trading-screen" hidden={view !== "trading"}>
      <StatsBar orders={orders} risk={risk} />

      {error && (
        <div className="error-banner">
          Can't reach the backend right now: {error}.
        </div>
      )}

      <div className="trading-workspace">
        <PriceChart
          candles={candles}
          loading={connectionOk === null}
          onPriceSelect={setSelectedEntryPrice}
          interval={interval}
          onIntervalChange={setChartInterval}
          orders={orders}
          binanceOpenOrders={binanceOpenOrders}
          symbol={symbol}
          mode={mode}
          currentPrice={price}
          analysis={analysis}
          market={market}
          candlesKey={candlesKey}
          onLoadOlder={loadOlder}
          onLoadAll={loadAllHistory}
          strategyIds={chartStrategies}
          onStrategyIdsChange={setChartStrategies}
          strategySettings={chartSettings}
          onStrategySettingsChange={setChartSettings}
          draft={draftOrder?.symbol === symbol ? draftOrder : null}
          onDraftDrag={onDraftDrag}
          loadingOlder={loadingOlder}
          timeZone={timeZone}
          tzMode={tzMode}
          onTzModeChange={(next) => {
            setTzMode(next);
            try { window.localStorage.setItem("chart-tz", next); } catch { /* storage unavailable */ }
          }}
        />
        <AutoOrderPanel
          alertPlan={alertPlan}
          onDraftChange={setDraftOrder}
          futuresAccount={futuresAccount}
          futuresError={futuresError}
          onFuturesRefresh={refreshFutures}
          currentPrice={price}
          selectedEntryPrice={selectedEntryPrice}
          analysis={analysis}
          market={market}
          risk={risk}
          onRiskSave={saveRisk}
          onRiskReset={resetDrawdown}
          onRiskRefresh={refreshRisk}
          loadHistory={loadHistory}
          loadHourly={loadHourly}
          timeZone={timeZone}
          interval={interval}
          symbol={symbol}
          mode={mode}
          balances={balances}
          onBalancesChange={setBalances}
          orders={orders}
          onOrdersChange={setOrders}
          binanceOpenOrders={binanceOpenOrders}
          onBinanceOpenOrdersChange={setBinanceOpenOrders}
          onSymbolChange={(nextSymbol) => {
            setSymbol(nextSymbol);
            setSelectedEntryPrice(null);
          }}
        />
      </div>
      </div>

    </div>
  );
}
