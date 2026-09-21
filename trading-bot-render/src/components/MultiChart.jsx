import { useEffect, useMemo, useRef, useState } from "react";
import { CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries, createChart } from "lightweight-charts";

import { getCandles, getMarketOverview } from "../api.js";
import { compactMoney, formatPrice } from "../lib/format.js";
import { formatCrosshairTime, formatTick } from "./PriceChart.jsx";
import { usePersistentState, oneOf } from "../lib/persist.js";

const STORAGE_KEY = "multi-charts";
const INTERVALS = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"];
const LAYOUTS = [
  { id: "1", label: "1", cols: 1, rows: 1 },
  { id: "2", label: "2", cols: 2, rows: 1 },
  { id: "4", label: "4", cols: 2, rows: 2 },
  { id: "6", label: "6", cols: 3, rows: 2 },
  { id: "9", label: "9", cols: 3, rows: 3 },
];
const DEFAULT_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "LINKUSDT", "AVAXUSDT"];
const INTERVAL_SECONDS = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1d": 86400 };
const COLORS = { background: "#0f141d", grid: "#1a2231", text: "#7c8aa3", border: "#34415a", up: "#35c48c", down: "#e8604c", ema: "#d9a441" };

const defaultState = () => ({
  layout: "4",
  cells: DEFAULT_SYMBOLS.map((symbol) => ({ market: "futures", symbol, interval: "15m" })),
});

function loadState() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    if (saved && LAYOUTS.some((l) => l.id === saved.layout) && Array.isArray(saved.cells) && saved.cells.length >= 9) return saved;
  } catch { /* fall through to defaults */ }
  return defaultState();
}

const toBar = (k) => ({ time: Math.floor(Number(k[0]) / 1000), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]) });

function ema(values, period) {
  const k = 2 / (period + 1);
  let prev = null;
  return values.map((v, i) => {
    prev = prev == null ? v : v * k + prev * (1 - k);
    return i + 1 >= period ? prev : null;
  });
}

function streamUrl(market, symbol, interval) {
  // charts always use live public data, whatever the account mode is
  const host = market === "futures" ? "fstream.binance.com" : "stream.binance.com:9443";
  return `wss://${host}/ws/${symbol.toLowerCase()}@kline_${interval}`;
}

/** 24h change from the loaded bars (or over what is loaded, when it covers less than a day). */
function changeOver(bars, interval) {
  if (bars.length < 2) return null;
  const perDay = 86400 / (INTERVAL_SECONDS[interval] ?? 900);
  const from = bars[Math.max(0, bars.length - 1 - Math.round(perDay))];
  const last = bars[bars.length - 1];
  const hours = Math.round(((last.time - from.time) / 3600) * 10) / 10;
  return { pct: (last.close / from.close - 1) * 100, hours };
}

const fmtPrice = (n) => {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(4);
  return n.toPrecision(4);
};


const CATEGORY_CHIPS = [["all", "All"], ["crypto", "Crypto"], ["stock", "Stocks"], ["commodity", "Commodities"], ["forex", "Forex"], ["other", "Other"]];
const QUOTES = { spot: ["USDT", "USDC", "FDUSD", "BTC", "ETH", "BNB", "EUR", "TRY", "BRL", "GBP"], futures: ["USDT", "USDC"] };
const SORTS = { quoteVolume: (a, b) => b.quoteVolume - a.quoteVolume, change24h: (a, b) => b.change24h - a.change24h, marketCap: (a, b) => (b.marketCap ?? -1) - (a.marketCap ?? -1), symbol: (a, b) => a.symbol.localeCompare(b.symbol) };
const SORT_LABELS = [["quoteVolume", "Volume"], ["change24h", "24h move"], ["marketCap", "Market cap"], ["symbol", "A to Z"]];
const listCache = new Map(); // "market:quote" -> { at, pairs }

function loadList(market, quote) {
  const key = `${market}:${quote}`;
  const hit = listCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return Promise.resolve(hit.pairs);
  return getMarketOverview(quote, market, "live").then((data) => {
    const pairs = data.pairs ?? [];
    listCache.set(key, { at: Date.now(), pairs });
    return pairs;
  });
}

/** Choose ANY chart: spot or futures, any quote currency, any asset class, with search. Unlisted symbols can be typed. */
function ChartPairMenu({ market: initialMarket, symbol, alignRight, onPick, onClose }) {
  const [market, setMarket] = useState(initialMarket);
  const [quote, setQuote] = usePersistentState("pref:chart-menu-quote", "USDT", (v) => QUOTES[initialMarket].includes(v));
  const [category, setCategory] = useState("all"); // reset whenever the list reloads, so nothing to remember
  const [sort, setSort] = usePersistentState("pref:chart-menu-sort", "quoteVolume", oneOf(Object.keys(SORTS)));
  const [query, setQuery] = useState("");
  const [state, setState] = useState({ pairs: [], loading: true, error: null });
  const rootRef = useRef(null);
  const searchRef = useRef(null);

  useEffect(() => {
    searchRef.current?.focus();
    const down = (e) => { if (!rootRef.current?.contains(e.target)) onClose(); };
    const key = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); window.removeEventListener("keydown", key); };
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setState({ pairs: [], loading: true, error: null });
    setCategory("all");
    loadList(market, quote)
      .then((pairs) => { if (!cancelled) setState({ pairs, loading: false, error: null }); })
      .catch((err) => { if (!cancelled) setState({ pairs: [], loading: false, error: err.message }); });
    return () => { cancelled = true; };
  }, [market, quote]);

  const counts = useMemo(() => state.pairs.reduce((m, p) => ((m[p.category] = (m[p.category] ?? 0) + 1), m), {}), [state.pairs]);
  const q = query.trim().toUpperCase();
  const rows = useMemo(
    () => state.pairs.filter((p) => (category === "all" || p.category === category) && (!q || p.symbol.includes(q))).sort(SORTS[sort]),
    [state.pairs, category, q, sort],
  );
  const typedOk = /^[A-Z0-9]{4,20}$/.test(q) && !state.pairs.some((p) => p.symbol === q);
  const usd = quote === "USDT" || quote === "USDC" || quote === "FDUSD";

  const choose = (next) => onPick({ market, symbol: next });
  const submit = () => {
    if (rows.length === 1 || (rows.length && rows[0].symbol === q)) choose(rows[0].symbol);
    else if (typedOk) choose(q);
    else if (rows.length) choose(rows[0].symbol);
  };

  return (
    <div className={`chart-pair-menu${alignRight ? " is-right" : ""}`} ref={rootRef} role="dialog" aria-label="Choose a chart">
      <div className="cpm-row">
        <div className="segmented segmented-small" role="tablist" aria-label="Market">
          <button type="button" role="tab" aria-selected={market === "spot"} className={market === "spot" ? "is-active" : ""} onClick={() => { setMarket("spot"); if (!QUOTES.spot.includes(quote)) setQuote("USDT"); }}>Spot</button>
          <button type="button" role="tab" aria-selected={market === "futures"} className={market === "futures" ? "is-active" : ""} onClick={() => { setMarket("futures"); if (!QUOTES.futures.includes(quote)) setQuote("USDT"); }}>Futures</button>
        </div>
        <label className="cpm-quote">Quote
          <select value={quote} onChange={(e) => setQuote(e.target.value)}>{QUOTES[market].map((v) => <option key={v} value={v}>{v}</option>)}</select>
        </label>
        <label className="cpm-quote">Sort
          <select value={sort} onChange={(e) => setSort(e.target.value)}>{SORT_LABELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
      </div>
      <div className="cpm-cats" role="group" aria-label="Asset class">
        {CATEGORY_CHIPS.filter(([key]) => key === "all" || counts[key]).map(([key, label]) => (
          <button key={key} type="button" className={category === key ? "is-on" : ""} onClick={() => setCategory(key)}>{label}<em>{key === "all" ? state.pairs.length : counts[key]}</em></button>
        ))}
      </div>
      <input
        ref={searchRef}
        className="cpm-search"
        type="search"
        placeholder={`Search ${market === "futures" ? "futures" : "spot"} pairs (BTC, TSLA, EUR, GOLD…)`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
        autoComplete="off"
        spellCheck={false}
      />
      <div className="cpm-list" role="listbox">
        {state.loading && <p className="cpm-note">Loading the list…</p>}
        {state.error && <p className="cpm-note is-error">Could not load the list ({state.error}). You can still type a symbol and press Enter.</p>}
        {!state.loading && !state.error && rows.length === 0 && <p className="cpm-note">No {quote} pair matches{q ? ` “${q}”` : ""}.</p>}
        {rows.slice(0, 300).map((p) => (
          <button type="button" role="option" aria-selected={p.symbol === symbol && market === initialMarket} key={p.symbol} className={`cpm-row-item${p.symbol === symbol && market === initialMarket ? " is-current" : ""}`} onClick={() => choose(p.symbol)}>
            <span className="cpm-sym">{p.symbol}{p.category !== "crypto" && <i className={`cat-badge cat-${p.category}`}>{p.category === "stock" ? "Stock" : p.category === "commodity" ? "Comm." : p.category === "forex" ? "FX" : "Other"}</i>}</span>
            <span className="cpm-price">{formatPrice(Number(p.price))}</span>
            <span className={`cpm-change ${p.change24h >= 0 ? "up" : "down"}`}>{p.change24h >= 0 ? "+" : ""}{Number(p.change24h).toFixed(2)}%</span>
            <span className="cpm-vol">{usd ? compactMoney(p.quoteVolume) : `${Math.round(p.quoteVolume).toLocaleString()} ${quote}`}</span>
          </button>
        ))}
      </div>
      <div className="cpm-foot">
        {typedOk
          ? <button type="button" className="mini-button accent" onClick={() => choose(q)}>Use “{q}” ({market})</button>
          : <span>Not in the list? Type its symbol and press Enter.</span>}
        <span>{rows.length} shown · live data</span>
      </div>
    </div>
  );
}

/** One live candlestick chart with its own pair and timeframe. */
function MiniChart({ cell, onChange, timeZone, onOpen }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef({});
  const barsRef = useRef([]);
  const [status, setStatus] = useState({ price: null, change: null, error: null });
  const [menuOpen, setMenuOpen] = useState(false);
  const [alignRight, setAlignRight] = useState(false);
  const pickRef = useRef(null);
  const { market, symbol, interval } = cell;

  // a chart in the right half opens its menu towards the left so it stays on screen
  useEffect(() => {
    if (menuOpen && pickRef.current) setAlignRight(pickRef.current.getBoundingClientRect().left > window.innerWidth / 2);
  }, [menuOpen]);

  // chart once
  useEffect(() => {
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: COLORS.background }, textColor: COLORS.text, fontFamily: "JetBrains Mono", fontSize: 11 },
      grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: COLORS.border, scaleMargins: { top: 0.08, bottom: 0.22 } },
      timeScale: { borderColor: COLORS.border, timeVisible: true, secondsVisible: false, rightOffset: 4, barSpacing: 7, minBarSpacing: 2 },
    });
    const candles = chart.addSeries(CandlestickSeries, { upColor: COLORS.up, downColor: COLORS.down, borderUpColor: COLORS.up, borderDownColor: COLORS.down, wickUpColor: COLORS.up, wickDownColor: COLORS.down });
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    const line = chart.addSeries(LineSeries, { color: COLORS.ema, lineWidth: 1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
    chartRef.current = chart;
    seriesRef.current = { candles, volume, line };
    return () => { chart.remove(); chartRef.current = null; };
  }, []);

  useEffect(() => {
    chartRef.current?.applyOptions({
      localization: { timeFormatter: (t) => formatCrosshairTime(t, timeZone) },
      timeScale: { tickMarkFormatter: (t, type) => formatTick(t, type, timeZone) },
    });
  }, [timeZone]);

  function paint(fit) {
    const { candles, volume, line } = seriesRef.current;
    const bars = barsRef.current;
    if (!candles || !bars.length) return;
    candles.setData(bars);
    volume.setData(bars.map((b) => ({ time: b.time, value: b.volume, color: b.close >= b.open ? "rgba(53,196,140,0.3)" : "rgba(232,96,76,0.3)" })));
    const values = ema(bars.map((b) => b.close), 21);
    line.setData(bars.map((b, i) => (values[i] == null ? null : { time: b.time, value: values[i] })).filter(Boolean));
    if (fit) chartRef.current?.timeScale().fitContent();
    setStatus({ price: bars[bars.length - 1].close, change: changeOver(bars, interval), error: null });
  }

  // history + live stream for this cell
  useEffect(() => {
    let cancelled = false;
    let socket = null;
    let retry = null;
    barsRef.current = [];
    setStatus({ price: null, change: null, error: null });

    const load = (fit) => getCandles(symbol, interval, 300, undefined, market, "live")
      .then((res) => {
        if (cancelled) return;
        const fresh = (res.candles ?? []).map(toBar);
        const byTime = new Map(barsRef.current.map((b) => [b.time, b]));
        for (const bar of fresh) byTime.set(bar.time, bar);
        barsRef.current = [...byTime.values()].sort((a, b) => a.time - b.time).slice(-1000);
        paint(fit);
      })
      .catch((err) => { if (!cancelled) setStatus((s) => ({ ...s, error: err.message })); });

    function connect() {
      socket = new WebSocket(streamUrl(market, symbol, interval));
      socket.onmessage = (event) => {
        const k = JSON.parse(event.data).k;
        if (!k || !barsRef.current.length) return;
        const bar = { time: Math.floor(k.t / 1000), open: Number(k.o), high: Number(k.h), low: Number(k.l), close: Number(k.c), volume: Number(k.v) };
        const bars = barsRef.current;
        const last = bars[bars.length - 1];
        if (bar.time === last.time) bars[bars.length - 1] = bar;
        else if (bar.time > last.time) bars.push(bar);
        else return;
        const { candles, volume } = seriesRef.current;
        candles.update(bar);
        volume.update({ time: bar.time, value: bar.volume, color: bar.close >= bar.open ? "rgba(53,196,140,0.3)" : "rgba(232,96,76,0.3)" });
        setStatus((s) => ({ ...s, price: bar.close, change: changeOver(bars, interval) }));
      };
      socket.onclose = () => { if (!cancelled) retry = window.setTimeout(connect, 3000); };
      socket.onerror = () => socket.close();
    }

    load(true);
    connect();
    const heal = window.setInterval(() => load(false), 60_000); // fills any gap the stream missed
    return () => { cancelled = true; window.clearTimeout(retry); window.clearInterval(heal); socket?.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market, symbol, interval]);

  const up = (status.change?.pct ?? 0) >= 0;

  return (
    <div className="mini-chart">
      <div className="mini-head">
        <div className="segmented segmented-small" role="group" aria-label="Market">
          <button type="button" className={market === "spot" ? "is-active" : ""} onClick={() => onChange({ ...cell, market: "spot" })} title="Spot">S</button>
          <button type="button" className={market === "futures" ? "is-active" : ""} onClick={() => onChange({ ...cell, market: "futures" })} title="USD-M futures (live data)">F</button>
        </div>
        <div className="mini-pick" ref={pickRef}>
          <button type="button" className="mini-symbol" aria-haspopup="dialog" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)} title="Choose any pair: crypto, stocks, commodities, forex, futures">
            {symbol}<span aria-hidden="true"> ▾</span>
          </button>
          {menuOpen && (
            <ChartPairMenu
              market={market}
              symbol={symbol}
              alignRight={alignRight}
              onClose={() => setMenuOpen(false)}
              onPick={(next) => { setMenuOpen(false); onChange({ ...cell, ...next }); }}
            />
          )}
        </div>
        <strong className="mini-price">{status.price == null ? "…" : fmtPrice(status.price)}</strong>
        {status.change && <span className={`mini-change ${up ? "up" : "down"}`} title={`Change over the last ${status.change.hours} h`}>{up ? "+" : ""}{status.change.pct.toFixed(2)}%</span>}
        <select className="mini-interval" value={interval} onChange={(e) => onChange({ ...cell, interval: e.target.value })} aria-label="Timeframe">
          {INTERVALS.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <button type="button" className="mini-open" onClick={() => onOpen(cell)} title="Open this pair in the trading screen">Trade ↗</button>
      </div>
      <div className="mini-body">
        <div ref={containerRef} className="mini-canvas" />
        {status.error && <p className="mini-error">{status.error}</p>}
      </div>
    </div>
  );
}

/**
 * A grid of live charts to follow several pairs at once. Each chart has its own market, pair and timeframe;
 * everything is remembered. Open it in its own browser tab with the button, or with #charts in the address.
 */
export default function MultiChart({ timeZone, onOpen }) {
  const [state, setState] = useState(loadState);
  const layout = LAYOUTS.find((l) => l.id === state.layout) ?? LAYOUTS[2];
  const count = layout.cols * layout.rows;

  useEffect(() => {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* storage unavailable */ }
  }, [state]);

  const setCell = (index, next) => setState((s) => ({ ...s, cells: s.cells.map((c, i) => (i === index ? next : c)) }));
  const setAllIntervals = (interval) => setState((s) => ({ ...s, cells: s.cells.map((c) => ({ ...c, interval })) }));
  const cells = useMemo(() => state.cells.slice(0, count), [state.cells, count]);

  return (
    <div className="multi-view">
      <div className="multi-toolbar">
        <div>
          <strong>Charts</strong>
          <span className="multi-sub">Follow several pairs at once. Each chart is live and has its own pair and timeframe.</span>
        </div>
        <div className="multi-controls">
          <span className="multi-label">Layout</span>
          <div className="segmented segmented-small" role="group" aria-label="Number of charts">
            {LAYOUTS.map((l) => <button key={l.id} type="button" className={state.layout === l.id ? "is-active" : ""} onClick={() => setState((s) => ({ ...s, layout: l.id }))}>{l.label}</button>)}
          </div>
          <span className="multi-label">All timeframes</span>
          <select onChange={(e) => e.target.value && setAllIntervals(e.target.value)} value="" aria-label="Set every timeframe">
            <option value="">Set…</option>
            {INTERVALS.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
          <button type="button" className="mini-button" onClick={() => window.open(`${window.location.pathname}#charts`, "_blank", "noopener")} title="Open this screen in its own browser tab or window">Open in new tab ↗</button>
          <button type="button" className="mini-button" onClick={() => setState(defaultState())} title="Back to the default pairs">Reset</button>
        </div>
      </div>
      <div className="multi-grid" style={{ gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${layout.rows}, minmax(0, 1fr))` }}>
        {cells.map((cell, index) => (
          <MiniChart
            key={index}
            cell={cell}
            timeZone={timeZone}
            onChange={(next) => setCell(index, next)}
            onOpen={onOpen}
          />
        ))}
      </div>
    </div>
  );
}
