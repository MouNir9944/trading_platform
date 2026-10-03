import { useEffect, useMemo, useRef, useState } from "react";
import { CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries, createChart } from "lightweight-charts";

import { getCandles, getMarketOverview } from "../api.js";
import { compactMoney, formatPrice } from "../lib/format.js";
import { formatCrosshairTime, formatTick } from "./PriceChart.jsx";
import { usePersistentState, oneOf } from "../lib/persist.js";
import { bollinger, ema as emaSeries, macd as macdSeries, rsi as rsiSeries } from "../../shared/analysis/indicators.js";
import { STRATEGIES } from "../../shared/strategies/index.js";
import { buildStrategyOverlays, strategyColor } from "../lib/strategyOverlay.js";
import { ZonesPrimitive } from "../lib/zones.js";
import { DrawingsPrimitive, drawingLabel } from "../lib/drawings.js";
import { useKeepOnScreen } from "../lib/useKeepOnScreen.js";

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
const DEFAULT_MINI_OVERLAYS = { ema50: false, bb: false, rsi: false, macd: false };
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

/** One live candlestick chart with its own pair, timeframe, indicators, strategies and drawings. */
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
  const overlays = cell.overlays ?? DEFAULT_MINI_OVERLAYS;
  const strategyIds = cell.strategyIds ?? [];
  const setOverlays = (next) => onChange({ ...cell, overlays: typeof next === "function" ? next(overlays) : next });
  const setStrategyIds = (next) => onChange({ ...cell, strategyIds: typeof next === "function" ? next(strategyIds) : next });
  // `paint`/the websocket handler are set up once per [market,symbol,interval] and must never read a stale
  // `overlays`/`strategyIds` from that render, so they read these refs (kept current every render) instead.
  const overlaysRef = useRef(overlays);
  const strategyIdsRef = useRef(strategyIds);
  overlaysRef.current = overlays;
  strategyIdsRef.current = strategyIds;

  const bbRef = useRef(null);
  const ema50Ref = useRef(null);
  const rsiRef = useRef(null);
  const macdRef = useRef(null);
  const zonesRef = useRef(null);
  const drawingsRef = useRef(null);

  const [indOpen, setIndOpen] = useState(false);
  const indWrapRef = useRef(null);
  const indMenuRef = useRef(null);
  useKeepOnScreen(indMenuRef, indOpen);

  const [stratOpen, setStratOpen] = useState(false);
  const stratWrapRef = useRef(null);
  const stratMenuRef = useRef(null);
  useKeepOnScreen(stratMenuRef, stratOpen);

  const [drawTool, setDrawTool] = useState("cursor"); // "cursor" | "trendline" | "horizontal" | "rectangle"
  const [drawings, setDrawings] = useState([]);
  const [drawDraft, setDrawDraft] = useState(null);
  const [drawMenuOpen, setDrawMenuOpen] = useState(false);
  const drawMenuWrapRef = useRef(null);
  const drawMenuRef = useRef(null);
  const drawStartRef = useRef(null);
  useKeepOnScreen(drawMenuRef, drawMenuOpen);
  const drawingsKey = `chart-drawings:${market}:${symbol}`;

  // a chart in the right half opens its menu towards the left so it stays on screen
  useEffect(() => {
    if (menuOpen && pickRef.current) setAlignRight(pickRef.current.getBoundingClientRect().left > window.innerWidth / 2);
  }, [menuOpen]);

  // Drawings are per pair (shared with the main Trading chart's own drawings on the same pair).
  useEffect(() => {
    let loaded = [];
    try {
      const raw = window.localStorage.getItem(drawingsKey);
      if (raw) loaded = JSON.parse(raw);
    } catch { /* storage unavailable or corrupted */ }
    setDrawings(Array.isArray(loaded) ? loaded : []);
    setDrawDraft(null);
    setDrawTool("cursor");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawingsKey]);
  useEffect(() => {
    try { window.localStorage.setItem(drawingsKey, JSON.stringify(drawings)); } catch { /* storage unavailable */ }
  }, [drawingsKey, drawings]);

  // Each dropdown closes on an outside click or Escape.
  useEffect(() => {
    if (!indOpen) return undefined;
    const close = (e) => { if (e.type === "keydown" ? e.key === "Escape" : !indWrapRef.current?.contains(e.target)) setIndOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [indOpen]);
  useEffect(() => {
    if (!stratOpen) return undefined;
    const close = (e) => { if (e.type === "keydown" ? e.key === "Escape" : !stratWrapRef.current?.contains(e.target)) setStratOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [stratOpen]);
  useEffect(() => {
    if (!drawMenuOpen) return undefined;
    const close = (e) => { if (e.type === "keydown" ? e.key === "Escape" : !drawMenuWrapRef.current?.contains(e.target)) setDrawMenuOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [drawMenuOpen]);

  // chart once
  useEffect(() => {
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: COLORS.background }, textColor: COLORS.text, fontFamily: "JetBrains Mono", fontSize: 11 },
      grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: COLORS.border, scaleMargins: { top: 0.08, bottom: 0.22 } },
      timeScale: { borderColor: COLORS.border, timeVisible: true, secondsVisible: false, rightOffset: 4, barSpacing: 7, minBarSpacing: 2 },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    });
    const candles = chart.addSeries(CandlestickSeries, { upColor: COLORS.up, downColor: COLORS.down, borderUpColor: COLORS.up, borderDownColor: COLORS.down, wickUpColor: COLORS.up, wickDownColor: COLORS.down });
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    const line = chart.addSeries(LineSeries, { color: COLORS.ema, lineWidth: 1, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
    zonesRef.current = new ZonesPrimitive(candles);
    chart.panes()[0].attachPrimitive(zonesRef.current);
    drawingsRef.current = new DrawingsPrimitive(candles);
    chart.panes()[0].attachPrimitive(drawingsRef.current);
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

  // A tool other than the cursor takes over the mouse (so a drag draws a shape instead of panning the chart).
  useEffect(() => {
    chartRef.current?.applyOptions({ handleScroll: drawTool === "cursor", handleScale: drawTool === "cursor" });
  }, [drawTool]);

  useEffect(() => {
    drawingsRef.current?.set({ drawings, draft: drawDraft, currentPrice: status.price });
  }, [drawings, drawDraft, status.price]);

  // Indicator series: (re)built only when a toggle changes, so sub-panes keep a stable order.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    for (const ref of [bbRef, ema50Ref, rsiRef, macdRef]) {
      Object.values(ref.current ?? {}).forEach((series) => { try { chart.removeSeries(series); } catch { /* already gone */ } });
      ref.current = null;
    }
    const ln = (color, width = 1, pane = 0, extra = {}) =>
      chart.addSeries(LineSeries, { color, lineWidth: width, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...extra }, pane);
    if (overlays.bb) bbRef.current = { upper: ln("rgba(168,139,250,0.75)"), mid: ln("rgba(168,139,250,0.4)", 1, 0, { lineStyle: 2 }), lower: ln("rgba(168,139,250,0.75)") };
    if (overlays.ema50) ema50Ref.current = { line: ln("#e879f9", 2) };
    let pane = 1;
    if (overlays.rsi) {
      const rsiLine = ln("#a78bfa", 2, pane, { lastValueVisible: true, autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) });
      for (const [price, color] of [[70, "rgba(238,106,88,0.55)"], [30, "rgba(53,196,140,0.55)"]]) {
        rsiLine.createPriceLine({ price, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: "" });
      }
      rsiRef.current = { line: rsiLine };
      pane += 1;
    }
    if (overlays.macd) {
      macdRef.current = { hist: chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, pane), line: ln("#5b9cff", 1, pane), signal: ln("#e0aa48", 1, pane) };
    }
    chart.panes().forEach((p, index) => p.setStretchFactor(index === 0 ? 3 : 1));
    refreshOverlays();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlays.bb, overlays.ema50, overlays.rsi, overlays.macd]);

  // Strategy signal overlays (zones/lines/labels), recomputed whenever the chosen strategies change.
  useEffect(() => {
    refreshOverlays();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategyIds.join(","), market]);

  const closes = () => barsRef.current.map((b) => b.close);
  const points = (values) => barsRef.current.flatMap((b, i) => (values[i] == null ? [] : [{ time: b.time, value: values[i] }]));

  /** Recompute the EMA50/BB/RSI/MACD series and the strategy zones from whatever bars are loaded right now. */
  function refreshOverlays() {
    const bars = barsRef.current;
    if (!bars.length) return;
    if (bbRef.current) {
      const bb = bollinger(closes());
      bbRef.current.upper.setData(points(bb.upper));
      bbRef.current.mid.setData(points(bb.mid));
      bbRef.current.lower.setData(points(bb.lower));
    }
    if (ema50Ref.current) ema50Ref.current.line.setData(points(emaSeries(closes(), 50)));
    if (rsiRef.current) rsiRef.current.line.setData(points(rsiSeries(closes())));
    if (macdRef.current) {
      const m = macdSeries(closes());
      macdRef.current.line.setData(points(m.line));
      macdRef.current.signal.setData(points(m.signal));
      macdRef.current.hist.setData(bars.flatMap((b, i) => {
        const v = m.histogram[i];
        if (v == null) return [];
        const rising = i > 0 && m.histogram[i - 1] != null && v > m.histogram[i - 1];
        const color = v >= 0 ? (rising ? "rgba(53,196,140,0.75)" : "rgba(53,196,140,0.4)") : (rising ? "rgba(238,106,88,0.4)" : "rgba(238,106,88,0.75)");
        return [{ time: b.time, value: v, color }];
      }));
    }
    const ids = strategyIdsRef.current;
    if (zonesRef.current) {
      const overlay = ids.length ? buildStrategyOverlays(ids, bars, { market }) : { zones: [], lines: [], labels: [] };
      zonesRef.current.set(overlay);
    }
  }

  function pointAtClient(clientX, clientY) {
    const chart = chartRef.current;
    const candles = seriesRef.current.candles;
    const container = containerRef.current;
    if (!chart || !candles || !container) return null;
    const rect = container.getBoundingClientRect();
    const time = chart.timeScale().coordinateToTime(clientX - rect.left);
    const price = candles.coordinateToPrice(clientY - rect.top);
    if (time == null || price == null || !Number.isFinite(price)) return null;
    return { time, price: Number(price) };
  }
  function addDrawing(shape) {
    setDrawings((previous) => [...previous, { ...shape, id: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` }]);
  }
  function removeDrawing(id) {
    setDrawings((previous) => previous.filter((d) => d.id !== id));
  }
  function beginDraw(event) {
    if (drawTool === "cursor" || event.button !== 0) return;
    event.preventDefault();
    const point = pointAtClient(event.clientX, event.clientY);
    if (!point) return;
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* not supported */ }
    if (drawTool === "horizontal") { addDrawing({ type: "horizontal", p: point.price }); return; }
    drawStartRef.current = point;
    setDrawDraft({ type: drawTool, t1: point.time, p1: point.price, t2: point.time, p2: point.price });
  }
  function onDrawMove(event) {
    if (!drawStartRef.current) return;
    const point = pointAtClient(event.clientX, event.clientY);
    if (!point) return;
    setDrawDraft({ type: drawTool, t1: drawStartRef.current.time, p1: drawStartRef.current.price, t2: point.time, p2: point.price });
  }
  function endDraw(event) {
    if (!drawStartRef.current) return;
    const point = pointAtClient(event.clientX, event.clientY) ?? drawStartRef.current;
    const start = drawStartRef.current;
    drawStartRef.current = null;
    setDrawDraft(null);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    if (start.time === point.time && start.price === point.price) return;
    addDrawing({ type: drawTool, t1: start.time, p1: start.price, t2: point.time, p2: point.price });
  }

  function paint(fit) {
    const { candles, volume, line } = seriesRef.current;
    const bars = barsRef.current;
    if (!candles || !bars.length) return;
    candles.setData(bars);
    volume.setData(bars.map((b) => ({ time: b.time, value: b.volume, color: b.close >= b.open ? "rgba(53,196,140,0.3)" : "rgba(232,96,76,0.3)" })));
    const values = ema(bars.map((b) => b.close), 21);
    line.setData(bars.map((b, i) => (values[i] == null ? null : { time: b.time, value: values[i] })).filter(Boolean));
    if (fit) chartRef.current?.timeScale().fitContent();
    refreshOverlays();
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
        refreshOverlays();
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
  const activeIndicators = Object.values(overlays).filter(Boolean).length;

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
      <div className="mini-toolbar-row">
        <div className="mini-ind-wrap" ref={indWrapRef}>
          <button type="button" className={`ind-button${activeIndicators ? " is-on" : ""}`} aria-expanded={indOpen} onClick={() => setIndOpen((v) => !v)}>
            Ind{activeIndicators ? ` · ${activeIndicators}` : ""}
          </button>
          {indOpen && (
            <div className="ind-menu" role="group" aria-label="Indicators" ref={indMenuRef}>
              <div className="ind-group">
                {[["ema50", "EMA 50"], ["bb", "Bollinger"], ["rsi", "RSI"], ["macd", "MACD"]].map(([key, label]) => (
                  <label key={key} className="ind-item">
                    <input type="checkbox" checked={overlays[key]} onChange={() => setOverlays((prev) => ({ ...prev, [key]: !prev[key] }))} />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="mini-strat-wrap" ref={stratWrapRef}>
          <button type="button" className={`ind-button${strategyIds.length ? " is-on" : ""}`} aria-expanded={stratOpen} onClick={() => setStratOpen((v) => !v)}>
            Strategies{strategyIds.length ? ` · ${strategyIds.length}` : ""}
          </button>
          {stratOpen && (
            <div className="ind-menu strat-menu" role="group" aria-label="Strategies" ref={stratMenuRef}>
              <div className="ind-group">
                {STRATEGIES.map((s, i) => (
                  <label key={s.id} className="ind-item" title={s.description}>
                    <input
                      type="checkbox"
                      checked={strategyIds.includes(s.id)}
                      onChange={() => setStrategyIds((prev) => (prev.includes(s.id) ? prev.filter((id) => id !== s.id) : [...prev, s.id]))}
                    />
                    <i className="strat-dot" style={{ background: strategyColor(i) }} aria-hidden="true" />
                    <span>{s.name}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="segmented segmented-small mini-draw-tools" role="group" aria-label="Draw on the chart">
          <button type="button" className={drawTool === "cursor" ? "is-active" : ""} onClick={() => setDrawTool("cursor")} title="Cursor">⌖</button>
          <button type="button" className={drawTool === "trendline" ? "is-active" : ""} onClick={() => setDrawTool("trendline")} title="Trendline: drag from one point to another">⟋</button>
          <button type="button" className={drawTool === "horizontal" ? "is-active" : ""} onClick={() => setDrawTool("horizontal")} title="Horizontal line: click a price to mark a level">—</button>
          <button type="button" className={drawTool === "rectangle" ? "is-active" : ""} onClick={() => setDrawTool("rectangle")} title="Rectangle: drag to mark a zone">▭</button>
        </div>
        <div className="mini-draw-menu-wrap" ref={drawMenuWrapRef}>
          <button type="button" className={`ind-button${drawings.length ? " is-on" : ""}`} aria-expanded={drawMenuOpen} onClick={() => setDrawMenuOpen((v) => !v)} disabled={!drawings.length} title="Your drawings on this pair">
            {drawings.length ? `Drawings · ${drawings.length}` : "Drawings"}
          </button>
          {drawMenuOpen && drawings.length > 0 && (
            <div className="ind-menu draw-menu" role="group" aria-label="Your drawings" ref={drawMenuRef}>
              <ul className="draw-list">
                {drawings.map((shape) => (
                  <li key={shape.id}>
                    <span>{drawingLabel(shape)}</span>
                    <button type="button" className="draw-remove" aria-label={`Delete ${drawingLabel(shape)}`} onClick={() => removeDrawing(shape.id)}>×</button>
                  </li>
                ))}
              </ul>
              <button type="button" className="mini-button danger" onClick={() => { setDrawings([]); setDrawMenuOpen(false); }}>Clear all</button>
            </div>
          )}
        </div>
      </div>
      <div className="mini-body">
        <div ref={containerRef} className="mini-canvas" />
        <div
          className={`draw-overlay${drawTool !== "cursor" ? " is-active" : ""}`}
          onPointerDown={beginDraw}
          onPointerMove={onDrawMove}
          onPointerUp={endDraw}
          onPointerCancel={endDraw}
        />
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
