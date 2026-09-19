import { useEffect, useRef, useState } from "react";
import Header from "./components/Header.jsx";
import PriceChart from "./components/PriceChart.jsx";
import AutoOrderPanel from "./components/AutoOrderPanel.jsx";
import { getAccountMode, getPrice, getBalance, getBinanceOpenOrders, getCandles, getOrders, setAccountMode } from "./api.js";

const DEFAULT_INTERVAL = "5m";

export default function App() {
  const [price, setPrice] = useState(null);
  const [symbol, setSymbol] = useState(() => window.localStorage.getItem("trading-symbol") || "XLMUSDT");
  const [selectedEntryPrice, setSelectedEntryPrice] = useState(null);
  const [interval, setChartInterval] = useState(DEFAULT_INTERVAL);
  const [orders, setOrders] = useState([]);
  const [binanceOpenOrders, setBinanceOpenOrders] = useState([]);
  const [priceDirection, setPriceDirection] = useState(null);
  const [balances, setBalances] = useState([]);
  const [candles, setCandles] = useState([]);
  const [refreshMs, setRefreshMs] = useState(15000);
  const [connectionOk, setConnectionOk] = useState(null);
  const [mode, setMode] = useState("testnet");
  const [error, setError] = useState(null);

  const lastPriceRef = useRef(null);

  useEffect(() => {
    window.localStorage.setItem("trading-symbol", symbol);
  }, [symbol]);

  useEffect(() => {
    getAccountMode().then((data) => setMode(data.mode)).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const [priceRes, balanceRes, candlesRes] = await Promise.all([
          getPrice(symbol),
          getBalance(),
          getCandles(symbol, interval, 200),
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
        setCandles(candlesRes.candles ?? []);
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
  }, [refreshMs, symbol, interval, mode]);

  useEffect(() => {
    let stream;
    let reconnectTimer;
    let stopped = false;

    function connect() {
      const streamHost = mode === "live" ? "stream.binance.com:9443" : "stream.testnet.binance.vision";
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
          return next.slice(-200);
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
  }, [symbol, interval, mode]);

  useEffect(() => {
    let stopped = false;
    async function refreshLiveMarket() {
      try {
        const [priceRes, candlesRes] = await Promise.all([
          getPrice(symbol),
          getCandles(symbol, interval, 1),
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
            return next.slice(-200);
          });
        }
      } catch {
        // The normal REST poll and WebSocket reconnect continue independently.
      }
    }

    refreshLiveMarket();
    const id = window.setInterval(refreshLiveMarket, 2000);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [symbol, interval, mode]);

  useEffect(() => {
    let cancelled = false;
    const refreshOrders = () => Promise.all([getOrders(mode), getBinanceOpenOrders(undefined, mode)]).then(([managed, open]) => {
      if (!cancelled) {
        setMode(managed.mode ?? "testnet");
        setOrders(managed.orders ?? []);
        setBinanceOpenOrders(open.orders ?? []);
      }
    }).catch(() => {});
    refreshOrders();
    const id = window.setInterval(refreshOrders, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [mode]);

  async function changeMode(nextMode) {
    if (nextMode === "live" && !window.confirm("Live mode uses real Binance funds. Continue?")) return;
    try {
      const result = await setAccountMode(nextMode);
      setMode(result.mode);
      setBalances([]);
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
      />

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
        />
        <AutoOrderPanel
          currentPrice={price}
          selectedEntryPrice={selectedEntryPrice}
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
  );
}
