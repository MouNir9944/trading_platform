import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  createChart,
  createSeriesMarkers,
} from "lightweight-charts";

import { SESSIONS, dailyProfiles, dailySummary, dayInfo, hourlyProfile, peakHourSegments, sessionSegments, toCandles, tzLabel, zonedParts } from "../../shared/analysis/index.js";
import { TimeBandsPrimitive } from "../lib/timeBands.js";
import { ZonesPrimitive, buildZoneOverlays } from "../lib/zones.js";
import { DailyProfilePrimitive } from "../lib/dailyProfile.js";
import { analyzeLux } from "../../shared/analysis/luxSmc.js";
import { LUX_SETTINGS_DEFAULTS, buildLuxOverlays, luxCandleColors, luxEngineOptions } from "../lib/luxOverlay.js";
import LuxSettings from "./LuxSettings.jsx";
import StrategyMenu from "./StrategyMenu.jsx";
import { buildStrategyOverlays } from "../lib/strategyOverlay.js";
import { buildLegend } from "../lib/legend.js";
import { useKeepOnScreen } from "../lib/useKeepOnScreen.js";

const COLORS = {
  background: "#0f141d",
  grid: "#1a2231",
  text: "#7c8aa3",
  border: "#34415a",
  up: "#35c48c",
  down: "#e8604c",
  maFast: "#4c8dff",
  maSlow: "#d9a441",
  tpFill: "rgba(38, 166, 154, 0.28)",
  tpBorder: "rgba(38, 166, 154, 0.85)",
  slFill: "rgba(239, 83, 80, 0.28)",
  slBorder: "rgba(239, 83, 80, 0.85)",
  entryLine: "rgba(255, 255, 255, 0.75)",
};

const OVERLAY_DEFS = [
  ["days", "Days"],
  ["sessions", "Sessions"],
  ["peak", "Best hours"],
  ["structure", "Structure"],
  ["fvg", "FVG"],
  ["ob", "Order blocks"],
  ["liq", "Liquidity"],
  ["pd", "Prem/Disc"],
  ["levels", "S/R"],
  ["dvp", "Daily profile"],
  ["dvpPrev", "Prior-day POC/VA"],
  ["bb", "BB"],
  ["ema50", "EMA 50"],
  ["rsi", "RSI"],
  ["macd", "MACD"],
];
const OVERLAY_LABELS = Object.fromEntries(OVERLAY_DEFS);
const INDICATOR_GROUPS = [
  ["Time", ["days", "sessions", "peak"]],
  ["Structure and zones", ["structure", "levels", "fvg", "ob", "liq", "pd"]],
  ["Volume profile", ["dvp", "dvpPrev"]],
  ["Indicators", ["ema50", "bb", "rsi", "macd"]],
];
const DEFAULT_OVERLAYS = { days: true, sessions: false, peak: false, fvg: true, ob: false, liq: false, pd: false, structure: true, levels: true, bb: false, ema50: false, rsi: false, macd: false, dvp: false, dvpPrev: false };
const OVERLAY_STORAGE_KEY = "chart-overlays";

function loadOverlays() {
  try {
    return { ...DEFAULT_OVERLAYS, ...JSON.parse(window.localStorage.getItem(OVERLAY_STORAGE_KEY) ?? "{}") };
  } catch {
    return DEFAULT_OVERLAYS;
  }
}

// ---- Time axis in the viewer's timezone (lightweight-charts shows UTC unless told otherwise) ----
const fmtCache = new Map();
function timeFmt(timeZone, key, options) {
  const id = `${timeZone}|${key}`;
  if (!fmtCache.has(id)) fmtCache.set(id, new Intl.DateTimeFormat("en-GB", { timeZone, hourCycle: "h23", ...options }));
  return fmtCache.get(id);
}

/** Label for one tick on the time axis. Decided from the *local* clock, not the library's UTC guess. */
export function formatTick(time, tickMarkType, timeZone) {
  const date = new Date(time * 1000);
  const p = zonedParts(time, timeZone);
  const isDateTick = tickMarkType < 3 || (p.hour === 0 && p.minute === 0);
  if (!isDateTick) return timeFmt(timeZone, "hm", { hour: "2-digit", minute: "2-digit" }).format(date);
  if (tickMarkType === 0 && p.month === 1 && p.day === 1) return String(p.year);
  if (tickMarkType <= 1 || p.day === 1) return timeFmt(timeZone, "mon", { month: "short" }).format(date);
  return timeFmt(timeZone, "wd", { weekday: "short", day: "numeric" }).format(date);
}

/** Label shown on the crosshair: "Sat 19 Sep, 14:35". */
export function formatCrosshairTime(time, timeZone) {
  return timeFmt(timeZone, "full", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(time * 1000));
}

const QUICK_INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"];
const MORE_INTERVALS = ["3m", "30m", "2h", "6h", "12h", "1w"];

export default function PriceChart({
  candles,
  loading,
  onPriceSelect,
  interval,
  onIntervalChange,
  orders,
  binanceOpenOrders = [],
  symbol,
  mode = "paper",
  currentPrice = null,
  analysis = null,
  market = "spot",
  candlesKey = "",
  onLoadOlder = () => {},
  onLoadAll = async () => {},
  strategyIds = [],
  strategySettings = {},
  onStrategySettingsChange = () => {},
  onStrategyIdsChange = () => {},
  draft = null,
  onDraftDrag = () => {},
  loadingOlder = false,
  timeZone = "UTC",
  tzMode = "local",
  onTzModeChange = () => {},
}) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const candleSeriesRef = useRef(null);
  const fastSeriesRef = useRef(null);
  const slowSeriesRef = useRef(null);
  const volumeSeriesRef = useRef(null);
  const orderLinesRef = useRef([]);
  const fittedKeyRef = useRef(null);
  const onPriceSelectRef = useRef(onPriceSelect);
  const onLoadOlderRef = useRef(onLoadOlder);
  const orderLevelsRef = useRef([]);
  const levelsKeyRef = useRef("");
  const autoRef = useRef(true);
  const fitPendingRef = useRef(false);
  const [auto, setAuto] = useState(() => {
    try { return window.localStorage.getItem("chart-auto") !== "0"; } catch { return true; }
  });
  const [fullscreen, setFullscreen] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  const firstTimeRef = useRef(null);
  const markersRef = useRef(null);
  const bandsRef = useRef(null);
  const zonesRef = useRef(null);
  const dvpRef = useRef(null);
  const bbRef = useRef(null);
  const ema50Ref = useRef(null);
  const rsiRef = useRef(null);
  const macdRef = useRef(null);
  const breakLinesRef = useRef({ key: "", series: [] });
  const levelLinesRef = useRef({ key: "", lines: [] });
  const [overlays, setOverlays] = useState(loadOverlays);
  const [peakHours, setPeakHours] = useState([]);
  const [lux, setLux] = useState(() => {
    try { return { ...LUX_SETTINGS_DEFAULTS, ...JSON.parse(window.localStorage.getItem("lux-smc") ?? "{}") }; } catch { return { ...LUX_SETTINGS_DEFAULTS }; }
  });
  const [luxOpen, setLuxOpen] = useState(false);
  const [indOpen, setIndOpen] = useState(false);
  const indRef = useRef(null);
  const indMenuRef = useRef(null);
  useKeepOnScreen(indMenuRef, indOpen);
  const activeIndicators = OVERLAY_DEFS.filter(([key]) => overlays[key]).length + (lux.enabled ? 1 : 0);

  // The indicators menu closes on an outside click or Escape.
  useEffect(() => {
    if (!indOpen) return undefined;
    const close = (event) => { if (event.type === "keydown" ? event.key === "Escape" : !indRef.current?.contains(event.target)) setIndOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [indOpen]);

  // Signals of the strategies ticked in the "Strategies" menu (any strategy of the platform), on the last 2000 candles.
  const stratCandles = useMemo(() => (strategyIds.length ? toCandles(candles.slice(-2000)) : null), [candles, strategyIds.length]);
  const strategyKey = `${strategyIds.join(",")}|${JSON.stringify(strategyIds.map((id) => strategySettings[id] ?? null))}`;
  const stratOverlay = useMemo(
    () => (stratCandles ? buildStrategyOverlays(strategyIds, stratCandles, { market, settings: strategySettings }) : { zones: [], lines: [], labels: [], summary: [] }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stratCandles, strategyKey, market],
  );
  // Daily volume profile. Rebuilt on every candle update so the live day keeps filling in.
  const dvpOn = overlays.dvp || overlays.dvpPrev;
  const dvp = useMemo(() => (dvpOn ? dailyProfiles(toCandles(candles), timeZone) : null), [dvpOn, candles, timeZone]);
  const dvpSummary = useMemo(() => (dvp?.supported ? dailySummary(dvp.days, currentPrice ?? Number(candles[candles.length - 1]?.[4])) : null), [dvp, currentPrice, candles]);

  // LuxAlgo-style smart money analysis on (up to) the last 2000 candles. Recomputed as candles arrive, but only
  // while the overlay is on, and re-derived from scratch when an engine setting changes.
  const luxEngineKey = JSON.stringify(luxEngineOptions(lux));
  const luxCandles = useMemo(() => (lux.enabled ? toCandles(candles.slice(-2000)) : null), [candles, lux.enabled]);
  const luxResult = useMemo(
    () => (luxCandles && luxCandles.length >= 10 ? analyzeLux(luxCandles, luxEngineOptions(lux)) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [luxCandles, luxEngineKey],
  );

  // The "Legend" panel below the chart: abbreviations and a live read, for whatever is currently switched on.
  const [legendOpen, setLegendOpen] = useState(() => {
    try { return JSON.parse(window.localStorage.getItem("chart-legend-open") ?? "true"); } catch { return true; }
  });
  useEffect(() => {
    try { window.localStorage.setItem("chart-legend-open", JSON.stringify(legendOpen)); } catch { /* storage unavailable */ }
  }, [legendOpen]);
  const legend = useMemo(
    () => buildLegend({ overlays, lux, analysis, luxResult, strategyIds, stratOverlay, dvpSummary, timeZone, formatPrice }),
    [overlays, lux, analysis, luxResult, strategyIds, stratOverlay, dvpSummary, timeZone],
  );

  const [positionBoxes, setPositionBoxes] = useState([]);
  const [accountMarkers, setAccountMarkers] = useState([]);
  const [livePnlMarkers, setLivePnlMarkers] = useState([]);
  const dragKindRef = useRef(null);
  const dragRafRef = useRef(null);
  const dragPriceRef = useRef(null);
  onPriceSelectRef.current = onPriceSelect;
  onLoadOlderRef.current = onLoadOlder;

  const positions = useMemo(() => {
    const real = buildPositions(orders, symbol, mode);
    const draftPosition = buildDraftPosition(draft, symbol, candles);
    return draftPosition ? [...real, draftPosition] : real;
  }, [orders, symbol, mode, draft, candles]);
  const accountOrders = useMemo(
    () => (binanceOpenOrders ?? []).filter((order) => order.symbol === symbol),
    [binanceOpenOrders, symbol],
  );
  const accountOrderLevels = useMemo(
    () => accountOrders.flatMap((order) => extractOrderLevels(order, positions)),
    [accountOrders, positions],
  );

  useEffect(() => {
  }, [mode]);

  useEffect(() => {
    if (!containerRef.current) return undefined;
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: COLORS.background },
        textColor: COLORS.text,
        fontFamily: "JetBrains Mono",
        fontSize: 12,
      },
      // 5 decimals on the price (Y) axis, the crosshair and price lines: enough for a low-priced pair like XRP,
      // where the default 2 decimals hide the difference between price levels.
      localization: { priceFormatter: (price) => price.toFixed(5) },
      grid: {
        vertLines: { color: COLORS.grid },
        horzLines: { color: COLORS.grid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#a8b3c7", width: 1, style: 2, labelBackgroundColor: "#4c8dff" },
        horzLine: { color: "#a8b3c7", width: 1, style: 2, labelBackgroundColor: "#4c8dff" },
      },
      rightPriceScale: { borderColor: COLORS.border, scaleMargins: { top: 0.08, bottom: 0.2 } },
      timeScale: { borderColor: COLORS.border, timeVisible: true, secondsVisible: false, rightOffset: 5, barSpacing: 8, minBarSpacing: 2 },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: COLORS.up,
      downColor: COLORS.down,
      borderUpColor: COLORS.up,
      borderDownColor: COLORS.down,
      wickUpColor: COLORS.up,
      wickDownColor: COLORS.down,
      priceLineColor: COLORS.maFast,
      priceLineVisible: true,
      lastValueVisible: true,
      priceFormat: { type: "price", precision: 5, minMove: 0.00001 },
      // Auto-scale to the visible candles AND any order levels (entry / stop-loss / take-profit).
      autoscaleInfoProvider: (baseImplementation) => {
        const base = baseImplementation();
        const levels = orderLevelsRef.current;
        if (!levels.length) return base;
        const low = Math.min(...levels);
        const high = Math.max(...levels);
        if (!base) return { priceRange: { minValue: low, maxValue: high } };
        return { ...base, priceRange: { minValue: Math.min(base.priceRange.minValue, low), maxValue: Math.max(base.priceRange.maxValue, high) } };
      },
    });
    const fastSeries = chart.addSeries(LineSeries, { color: COLORS.maFast, lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
    const slowSeries = chart.addSeries(LineSeries, { color: COLORS.maSlow, lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    // Scrolled to the oldest candle we have: ask for earlier history.
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (range && range.from < 15) onLoadOlderRef.current?.();
    });

    chart.subscribeClick((param) => {
      if (!param.point || (param.paneIndex != null && param.paneIndex !== 0)) return;
      const price = candleSeries.coordinateToPrice(param.point.y);
      if (price != null && Number.isFinite(price)) onPriceSelectRef.current(Number(price));
    });

    markersRef.current = createSeriesMarkers(candleSeries, []);
    bandsRef.current = new TimeBandsPrimitive();
    // Pane-level primitive: drawn behind the grid and candles.
    chart.panes()[0].attachPrimitive(bandsRef.current);
    // Smart-money zones (FVG, order blocks, premium/discount, liquidity) are drawn behind the candles too.
    zonesRef.current = new ZonesPrimitive(candleSeries);
    chart.panes()[0].attachPrimitive(zonesRef.current);
    // Daily volume profile: histogram, POC / value area, and the previous day's levels.
    dvpRef.current = new DailyProfilePrimitive(candleSeries);
    chart.panes()[0].attachPrimitive(dvpRef.current);
    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    fastSeriesRef.current = fastSeries;
    slowSeriesRef.current = slowSeries;
    volumeSeriesRef.current = volumeSeries;

    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!candleSeriesRef.current || candles.length === 0) return;
    const parsed = parseCandles(candles);
    if (lux.enabled && lux.trendCandles && luxResult) {
      // "Color candles": green while the internal structure is bullish, red otherwise
      const colors = luxCandleColors(luxResult, luxCandles, lux.style);
      parsed.candles = parsed.candles.map((c) => {
        const color = colors.get(c.time);
        return color ? { ...c, color, borderColor: color, wickColor: color } : c;
      });
    }
    const timeScale = chartRef.current?.timeScale();
    const fitKey = candlesKey || `${symbol}:${interval}`;
    const visibleBefore = fittedKeyRef.current === fitKey ? timeScale?.getVisibleLogicalRange() : null;
    candleSeriesRef.current.setData(parsed.candles);
    fastSeriesRef.current.setData(parsed.fastMa);
    slowSeriesRef.current.setData(parsed.slowMa);
    volumeSeriesRef.current.setData(parsed.volume);
    // Older candles were prepended: positions are counted from the oldest bar, so shift the view
    // by the same amount or the chart would jump back in time.
    const previousFirst = firstTimeRef.current;
    if (visibleBefore && previousFirst?.key === fitKey && parsed.candles[0].time < previousFirst.time) {
      const added = parsed.candles.findIndex((candle) => candle.time >= previousFirst.time);
      if (added > 0) timeScale.setVisibleLogicalRange({ from: visibleBefore.from + added, to: visibleBefore.to + added });
    }
    firstTimeRef.current = { key: fitKey, time: parsed.candles[0].time };
    // Wait for real history: a lone live candle can arrive first and must not lock the zoom level.
    if (fittedKeyRef.current !== fitKey && parsed.candles.length >= 30) {
      const visibleBars = 120;
      chartRef.current?.timeScale().setVisibleLogicalRange({
        from: Math.max(0, parsed.candles.length - visibleBars),
        to: parsed.candles.length + 5,
      });
      fittedKeyRef.current = fitKey;
    }
  }, [candles, candlesKey, interval, symbol, luxResult, lux.trendCandles, lux.style, lux.enabled]);

  // Auto mode: the price axis fits the visible candles and order levels by itself, so manual price
  // stretching is switched off. Turn Auto off to drag the price axis freely.
  useEffect(() => {
    autoRef.current = auto;
    try {
      window.localStorage.setItem("chart-auto", auto ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
    const chart = chartRef.current;
    if (!chart) return;
    chart.applyOptions({
      handleScale: { axisPressedMouseMove: { time: true, price: !auto } },
      ...(auto ? { rightPriceScale: { autoScale: true } } : {}),
    });
  }, [auto]);

  // Full screen: Esc leaves, and the page behind stops scrolling.
  useEffect(() => {
    if (!fullscreen) return undefined;
    const onKey = (event) => { if (event.key === "Escape") setFullscreen(false); };
    window.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [fullscreen]);

  // After "All history" finishes loading, zoom out so every candle is visible.
  useEffect(() => {
    if (fitPendingRef.current && !loadingAll && !loadingOlder) {
      fitPendingRef.current = false;
      chartRef.current?.timeScale().fitContent();
    }
  }, [loadingAll, loadingOlder, candles]);

  async function showAllHistory() {
    fitPendingRef.current = true;
    setLoadingAll(true);
    try {
      await onLoadAll();
    } finally {
      setLoadingAll(false);
    }
  }

  useEffect(() => {
    try { window.localStorage.setItem("lux-smc", JSON.stringify(lux)); } catch { /* storage unavailable */ }
  }, [lux]);

  // Smart-money zones follow the analysis and the overlay toggles (our own FVG / OB / liquidity / premium-discount
  // plus, when switched on, the LuxAlgo-style overlay).
  useEffect(() => {
    if (!zonesRef.current) return;
    const base = buildZoneOverlays(analysis, overlays);
    const extra = lux.enabled && luxResult ? buildLuxOverlays(luxResult, luxCandles, lux) : { zones: [], lines: [], labels: [] };
    zonesRef.current.set({
      zones: [...base.zones, ...extra.zones, ...stratOverlay.zones],
      lines: [...base.lines, ...extra.lines, ...stratOverlay.lines],
      labels: [...extra.labels, ...stratOverlay.labels],
    });
  }, [analysis, overlays.fvg, overlays.ob, overlays.liq, overlays.pd, luxResult, luxCandles, lux, stratOverlay]);

  useEffect(() => {
    dvpRef.current?.set({ days: dvp?.supported ? dvp.days : [], showProfile: overlays.dvp, showPrev: overlays.dvpPrev });
  }, [dvp, overlays.dvp, overlays.dvpPrev]);

  // Show chart times in the chosen timezone instead of UTC.
  useEffect(() => {
    chartRef.current?.applyOptions({
      localization: { timeFormatter: (time) => formatCrosshairTime(time, timeZone) },
      timeScale: { tickMarkFormatter: (time, type) => formatTick(time, type, timeZone) },
    });
  }, [timeZone]);

  // Day bands and session strip. Only recomputed when the set of candles changes, not on every tick.
  const timesKey = `${candles[0]?.[0]}:${candles[candles.length - 1]?.[0]}:${candles.length}`;
  useEffect(() => {
    if (!bandsRef.current) return;
    const list = toCandles(candles);
    const top = overlays.peak && list.length >= 48 ? hourlyProfile(list, timeZone).top : [];
    setPeakHours(top);
    bandsRef.current.set({
      days: dayInfo(list, timeZone),
      times: list.map((c) => c.time),
      sessions: overlays.sessions ? sessionSegments(list) : [],
      peak: top.length ? peakHourSegments(list, timeZone, top) : [],
      showDays: overlays.days,
      showSessions: overlays.sessions,
      showPeak: overlays.peak,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timesKey, timeZone, overlays.days, overlays.sessions, overlays.peak]);


  useEffect(() => {
    try {
      window.localStorage.setItem(OVERLAY_STORAGE_KEY, JSON.stringify(overlays));
    } catch {
      /* storage unavailable */
    }
  }, [overlays]);

  // Indicator series: (re)built only when a toggle changes, so sub-panes keep a stable order.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    for (const ref of [bbRef, ema50Ref, rsiRef, macdRef]) {
      Object.values(ref.current ?? {}).forEach((series) => {
        try { chart.removeSeries(series); } catch { /* already gone */ }
      });
      ref.current = null;
    }
    const line = (color, width = 1, pane = 0, extra = {}) =>
      chart.addSeries(LineSeries, { color, lineWidth: width, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...extra }, pane);

    if (overlays.bb) {
      bbRef.current = { upper: line("rgba(168,139,250,0.75)"), mid: line("rgba(168,139,250,0.4)", 1, 0, { lineStyle: 2 }), lower: line("rgba(168,139,250,0.75)") };
    }
    if (overlays.ema50) ema50Ref.current = { line: line("#e879f9", 2) };

    let pane = 1;
    if (overlays.rsi) {
      const rsiLine = line("#a78bfa", 2, pane, {
        lastValueVisible: true,
        autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
      });
      for (const [price, color] of [[70, "rgba(238,106,88,0.55)"], [50, "rgba(132,147,171,0.3)"], [30, "rgba(53,196,140,0.55)"]]) {
        rsiLine.createPriceLine({ price, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: price !== 50, title: "" });
      }
      rsiRef.current = { line: rsiLine };
      pane += 1;
    }
    if (overlays.macd) {
      macdRef.current = {
        hist: chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, pane),
        line: line("#5b9cff", 1, pane),
        signal: line("#e0aa48", 1, pane),
      };
    }
    chart.panes().forEach((p, index) => p.setStretchFactor(index === 0 ? 3.4 : 1));
  }, [overlays.bb, overlays.ema50, overlays.rsi, overlays.macd]);

  // Indicator data, refreshed on every new tick.
  useEffect(() => {
    if (!analysis) return;
    const { candles: cs, ind } = analysis.ctx;
    const points = (values) => cs.flatMap((c, i) => (values[i] == null ? [] : [{ time: c.time, value: values[i] }]));
    if (bbRef.current) {
      bbRef.current.upper.setData(points(ind.bb.upper));
      bbRef.current.mid.setData(points(ind.bb.mid));
      bbRef.current.lower.setData(points(ind.bb.lower));
    }
    ema50Ref.current?.line.setData(points(ind.ema50));
    rsiRef.current?.line.setData(points(ind.rsi));
    if (macdRef.current) {
      macdRef.current.line.setData(points(ind.macd.line));
      macdRef.current.signal.setData(points(ind.macd.signal));
      macdRef.current.hist.setData(cs.flatMap((c, i) => {
        const v = ind.macd.histogram[i];
        if (v == null) return [];
        const rising = i > 0 && ind.macd.histogram[i - 1] != null && v > ind.macd.histogram[i - 1];
        const color = v >= 0 ? (rising ? "rgba(53,196,140,0.75)" : "rgba(53,196,140,0.4)") : (rising ? "rgba(238,106,88,0.4)" : "rgba(238,106,88,0.75)");
        return [{ time: c.time, value: v, color }];
      }));
    }
  }, [analysis, overlays.bb, overlays.ema50, overlays.rsi, overlays.macd]);

  // Market structure: swing labels + BOS/CHoCH markers, broken-level lines, support/resistance.
  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    if (!chart || !candleSeries || !markersRef.current) return;

    if (!overlays.structure || !analysis) {
      markersRef.current.setMarkers([]);
    } else {
      const { swings, breaks } = analysis.structure;
      const markers = [
        ...swings.filter((s) => s.label).slice(-14).map((s) => ({
          time: s.time,
          position: s.type === "high" ? "aboveBar" : "belowBar",
          color: s.label === "HH" || s.label === "HL" ? COLORS.up : COLORS.down,
          shape: "circle",
          size: 0.6,
          text: s.label,
        })),
        ...breaks.slice(-4).map((b) => ({
          time: b.time,
          position: b.direction === "bull" ? "belowBar" : "aboveBar",
          color: b.type === "BOS" ? COLORS.maFast : COLORS.maSlow,
          shape: b.direction === "bull" ? "arrowUp" : "arrowDown",
          text: b.type,
        })),
      ].sort((a, b) => a.time - b.time);
      markersRef.current.setMarkers(markers);
    }

    // Broken-level segments, rebuilt only when the set of breaks changes.
    const wantedBreaks = overlays.structure && analysis ? analysis.structure.breaks.slice(-3) : [];
    const breakKey = wantedBreaks.map((b) => `${b.swingTime}:${b.time}:${b.level}`).join("|");
    if (breakLinesRef.current.key !== breakKey) {
      breakLinesRef.current.series.forEach((series) => { try { chart.removeSeries(series); } catch { /* gone */ } });
      breakLinesRef.current = {
        key: breakKey,
        series: wantedBreaks.map((b) => {
          const series = chart.addSeries(LineSeries, {
            color: b.type === "BOS" ? COLORS.maFast : COLORS.maSlow,
            lineWidth: 1,
            lineStyle: 2,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          });
          series.setData([{ time: b.swingTime, value: b.level }, { time: b.time, value: b.level }]);
          return series;
        }),
      };
    }

    // Support / resistance: nearest three either side.
    const levels = overlays.levels && analysis
      ? [
          ...analysis.structure.resistances.slice(0, 3).map((l) => ({ ...l, kind: "R" })),
          ...analysis.structure.supports.slice(0, 3).map((l) => ({ ...l, kind: "S" })),
        ]
      : [];
    const levelKey = levels.map((l) => `${l.kind}${l.price.toFixed(8)}x${l.touches}`).join("|");
    if (levelLinesRef.current.key !== levelKey) {
      levelLinesRef.current.lines.forEach((l) => { try { candleSeries.removePriceLine(l); } catch { /* gone */ } });
      levelLinesRef.current = {
        key: levelKey,
        lines: levels.map((l) => candleSeries.createPriceLine({
          price: l.price,
          color: l.kind === "R" ? "rgba(238,106,88,0.6)" : "rgba(53,196,140,0.6)",
          lineWidth: l.touches >= 3 ? 2 : 1,
          lineStyle: 3,
          axisLabelVisible: false,
          title: `${l.kind} ×${l.touches}`,
        })),
      };
    }
  }, [analysis, overlays.structure, overlays.levels]);

  useEffect(() => {
    if (!candleSeriesRef.current) return;
    orderLinesRef.current.forEach(({ series, line }) => series.removePriceLine(line));
    orderLinesRef.current = [];

    positions.forEach((position) => {
      // The draggable draft already shows its own entry/stop/target on its box (with drag handles); a second,
      // separately-updating native price line for the same levels only doubles up and ghosts while dragging.
      if (position.draggable) return;
      const color = position.preview ? "#8aa0bf" : COLORS.up;
      [
        [position.entry, "Entry", color],
        [position.stopLoss, "Stop Loss", COLORS.down],
        [position.takeProfit, "Take Profit", COLORS.up],
      ].forEach(([price, title, lineColor]) => {
        if (!Number.isFinite(price) || price <= 0) return;
        const line = candleSeriesRef.current.createPriceLine({
          price,
          color: lineColor,
          lineWidth: position.preview ? 1 : 2,
          lineStyle: 2,
          axisLabelVisible: true,
          title,
        });
        orderLinesRef.current.push({ series: candleSeriesRef.current, line });
      });
    });

    accountOrderLevels.forEach(({ price, title, color }) => {
      const line = candleSeriesRef.current.createPriceLine({
        price,
        color,
        lineWidth: 2,
        lineStyle: 0,
        axisLabelVisible: true,
        title,
      });
      orderLinesRef.current.push({ series: candleSeriesRef.current, line });
    });

    // Tell the price axis about these levels so it keeps them in view, then re-fit it when they change.
    const levels = [
      ...positions.flatMap((p) => [p.entry, p.stopLoss, p.takeProfit]),
      ...accountOrderLevels.map((level) => level.price),
    ].filter((price) => Number.isFinite(price) && price > 0);
    orderLevelsRef.current = levels;
    const levelsKey = `${mode}:${symbol}:${levels.map((price) => price.toFixed(8)).join("|")}`;
    if (levelsKeyRef.current !== levelsKey) {
      levelsKeyRef.current = levelsKey;
      if (autoRef.current) candleSeriesRef.current.priceScale().applyOptions({ autoScale: true });
    }
  }, [positions, accountOrderLevels, symbol, mode, candles]);

  useEffect(() => {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    const container = containerRef.current;
    if (!chart || !series || !container) return undefined;

    function syncBoxes() {
      const width = container.clientWidth;
      const height = container.clientHeight;
      const timeScale = chart.timeScale();
      const lastCandleTime = getLastCandleTime(candles);
      const next = positions.map((position) => {
        const entryY = series.priceToCoordinate(position.entry);
        const stopY = series.priceToCoordinate(position.stopLoss);
        const takeY = series.priceToCoordinate(position.takeProfit);
        if ([entryY, stopY, takeY].some((value) => value == null || !Number.isFinite(value))) return null;

        const orderTime = snapToCandleTime(candles, toChartTime(position.createdAt)) ?? lastCandleTime;
        const range = positionBoxRange(timeScale, orderTime, lastCandleTime, width);
        if (!range) return null;

        const risk = Math.abs(position.entry - position.stopLoss);
        const reward = Math.abs(position.takeProfit - position.entry);
        const rr = risk > 0 ? reward / risk : 0;
        const markPrice = Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice : position.entry;
        const livePnlRaw = position.status === "PROTECTED" || position.status === "MODIFYING"
          ? netPnlUsdt(position.entry, markPrice, position.quantity, position.feePercent, position.side)
          : null;
        const stopPnl = roundPnl(netPnlUsdt(position.entry, position.stopLoss, position.quantity, position.feePercent, position.side));
        const targetPnl = roundPnl(netPnlUsdt(position.entry, position.takeProfit, position.quantity, position.feePercent, position.side));
        const livePnl = livePnlRaw == null ? null : roundPnl(livePnlRaw);
        const liveY = series.priceToCoordinate(markPrice);
        return {
          id: position.id,
          preview: position.preview,
          draggable: Boolean(position.draggable),
          blocked: Boolean(position.blocked),
          side: position.side,
          status: position.status,
          left: range.left,
          width: range.width,
          entryY,
          stopY,
          takeY,
          liveY,
          chartHeight: height,
          rr,
          entry: position.entry,
          stopLoss: position.stopLoss,
          takeProfit: position.takeProfit,
          livePnl,
          stopPnl,
          targetPnl,
          markPrice,
        };
      }).filter(Boolean);
      setPositionBoxes((previous) => (boxesEqual(previous, next) ? previous : next));

      const nextLive = next
        .filter((box) => box.livePnl != null && box.liveY != null && Number.isFinite(box.liveY))
        .map((box) => ({
          id: `live-${box.id}`,
          y: box.liveY,
          pnl: box.livePnl,
          left: box.left + box.width + 8,
        }));
      setLivePnlMarkers((previous) => (liveMarkersEqual(previous, nextLive) ? previous : nextLive));

      const nextMarkers = accountOrderLevels.map((level) => {
        const y = series.priceToCoordinate(level.price);
        if (y == null || !Number.isFinite(y) || y < 0 || y > height) return null;
        return { ...level, y };
      }).filter(Boolean);
      setAccountMarkers((previous) => (markersEqual(previous, nextMarkers) ? previous : nextMarkers));
    }

    syncBoxes();
    const frame = window.requestAnimationFrame(syncBoxes);
    chart.timeScale().subscribeVisibleLogicalRangeChange(syncBoxes);
    const observer = new ResizeObserver(syncBoxes);
    observer.observe(container);
    window.addEventListener("resize", syncBoxes);
    const pollId = window.setInterval(syncBoxes, 250);

    return () => {
      window.cancelAnimationFrame(frame);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(syncBoxes);
      observer.disconnect();
      window.removeEventListener("resize", syncBoxes);
      window.clearInterval(pollId);
    };
  }, [positions, candles, interval, symbol, accountOrderLevels, currentPrice]);

  const accountLabel = mode === "live" ? "Live" : "Paper";
  const futures = market === "futures";

  // Dragging the draft box's entry line, TP zone or SL zone: convert the pointer's Y position to a price and hand it
  // to the ticket (which turns "Auto" off and re-checks the risk rules, exactly like typing the number in by hand).
  function priceAtClientY(clientY) {
    const series = candleSeriesRef.current;
    const container = containerRef.current;
    if (!series || !container) return null;
    const price = series.coordinateToPrice(clientY - container.getBoundingClientRect().top);
    return price != null && Number.isFinite(price) && price > 0 ? Number(price) : null;
  }
  function beginDrag(kind) {
    return (event) => {
      if (event.button != null && event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      dragKindRef.current = kind;
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* not supported */ }
    };
  }
  function onDragMove(event) {
    if (!dragKindRef.current) return;
    const price = priceAtClientY(event.clientY);
    if (price == null) return;
    dragPriceRef.current = price;
    if (dragRafRef.current != null) return;
    dragRafRef.current = window.requestAnimationFrame(() => {
      dragRafRef.current = null;
      if (dragKindRef.current && dragPriceRef.current != null) onDraftDrag(dragKindRef.current, dragPriceRef.current);
    });
  }
  function endDrag(event) {
    if (!dragKindRef.current) return;
    // Apply the last position even if the throttled frame for it hasn't painted yet, so a fast release never loses it.
    if (dragRafRef.current != null) {
      window.cancelAnimationFrame(dragRafRef.current);
      dragRafRef.current = null;
    }
    if (dragPriceRef.current != null) onDraftDrag(dragKindRef.current, dragPriceRef.current);
    dragKindRef.current = null;
    dragPriceRef.current = null;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* already released */ }
  }

  return (
    <div className={`panel chart-panel${fullscreen ? " is-fullscreen" : ""}`}>
      <div className="chart-toolbar">
        <p className="panel-title">
          {loading && candles.length === 0 ? "Loading" : futures ? `${accountLabel} futures` : `${accountLabel} orders`} — {interval} · {candles.length.toLocaleString()} candles{loadingOlder ? " · loading older…" : ""}
          {futures ? (positions.length > 0 ? ` · ${positions.length} order${positions.length === 1 ? "" : "s"} on chart` : " · no open futures orders") : accountOrders.length > 0 ? ` · ${accountOrders.length} open on chart` : " · no open account orders"}
        </p>
        <span className="toolbar-break" aria-hidden="true" />
        <div className="ind-menu-wrap" ref={indRef}>
          <button type="button" className={`ind-button${activeIndicators ? " is-on" : ""}`} aria-expanded={indOpen} onClick={() => setIndOpen((v) => !v)}>
            Indicators{activeIndicators ? ` · ${activeIndicators}` : ""} <span aria-hidden="true">▾</span>
          </button>
          {indOpen && (
            <div className="ind-menu" role="group" aria-label="Chart overlays" ref={indMenuRef}>
              <div className="ind-group">
                <h5>Smart money (LuxAlgo)</h5>
                <div className="ind-item-row">
                  <label className="ind-item" title="Smart Money Concepts in the style of the LuxAlgo indicator: structure, order blocks, EQH/EQL, gaps, zones">
                    <input type="checkbox" checked={lux.enabled} onChange={() => setLux((v) => ({ ...v, enabled: !v.enabled }))} />
                    <span>SMC (LuxAlgo)</span>
                  </label>
                  <button type="button" className={`strat-gear${luxOpen ? " is-on" : ""}`} aria-label="SMC (LuxAlgo) settings" aria-expanded={luxOpen} onClick={() => { setLuxOpen((v) => !v); setIndOpen(false); }} title="Settings">⚙</button>
                </div>
              </div>
              {INDICATOR_GROUPS.map(([title, keys]) => (
                <div key={title} className="ind-group">
                  <h5>{title}</h5>
                  {keys.map((key) => (
                    <label key={key} className="ind-item">
                      <input type="checkbox" checked={overlays[key]} onChange={() => setOverlays((previous) => ({ ...previous, [key]: !previous[key] }))} />
                      <span>{OVERLAY_LABELS[key]}</span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
        {luxOpen && <LuxSettings settings={lux} onChange={setLux} onClose={() => setLuxOpen(false)} />}
        <StrategyMenu selected={strategyIds} onChange={onStrategyIdsChange} settings={strategySettings} onSettingsChange={onStrategySettingsChange} summary={stratOverlay.summary} />
        {dvpOn && (
          <div className="vp-status" title="Daily volume profile: where volume traded today and yesterday. POC = busiest price, VA = the range holding 70% of volume">
            {!dvp?.supported ? <span>Daily profile needs a 4h or faster timeframe</span> : !dvpSummary?.today && !dvpSummary?.prev ? <span>Daily profile: not enough candles loaded</span> : (
              <>
                {dvpSummary.today && <span>Today POC <b>{formatPrice(dvpSummary.today.poc)}</b> · VA {formatPrice(dvpSummary.today.val)}–{formatPrice(dvpSummary.today.vah)}</span>}
                {dvpSummary.prev && dvpSummary.today && <span>Prev POC <b>{formatPrice(dvpSummary.prev.poc)}</b> · VA {formatPrice(dvpSummary.prev.val)}–{formatPrice(dvpSummary.prev.vah)}</span>}
                {dvpSummary.prev && <em className={`is-${dvpSummary.vsPrev}`}>{dvpSummary.vsPrev === "inside" ? "inside" : dvpSummary.vsPrev} prior value</em>}
              </>
            )}
          </div>
        )}
        {overlays.sessions && (
          <div className="session-legend">
            {SESSIONS.map((s) => <span key={s.id}><i style={{ background: s.color }} />{s.name}</span>)}
          </div>
        )}
        {overlays.peak && (
          <div className="session-legend peak-legend" title="Hours with the highest average volume over the candles currently loaded">
            <span><i className="peak-swatch" />
              {peakHours.length ? `Best hours (${tzLabel(timeZone)}): ${peakHours.map((h) => `${String(h).padStart(2, "0")}:00`).join(", ")}` : "Load more history to find the busiest hours"}
            </span>
          </div>
        )}
        <div className="chart-legend">
          <span><i className="legend-fast" />MA 9</span>
          <span><i className="legend-slow" />MA 21</span>
          <span className="legend-tp">TP zone</span>
          <span className="legend-sl">SL zone</span>
        </div>
        <div className="chart-controls">
          <div className="segmented segmented-small" role="group" aria-label="Chart timeframe">
            {QUICK_INTERVALS.map((value) => (
              <button key={value} type="button" className={interval === value ? "is-active" : ""} onClick={() => onIntervalChange(value)}>{value}</button>
            ))}
          </div>
          <select
            value={QUICK_INTERVALS.includes(interval) ? "" : interval}
            onChange={(event) => event.target.value && onIntervalChange(event.target.value)}
            aria-label="More timeframes"
          >
            <option value="">More</option>
            {MORE_INTERVALS.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <button type="button" className="latest-button" onClick={() => chartRef.current?.timeScale().scrollToRealTime()}>Latest</button>
          <div className="chart-tools" role="group" aria-label="Chart view">
            <button type="button" onClick={() => chartRef.current?.timeScale().fitContent()} title="Zoom out to show every candle loaded so far">Fit</button>
            <button type="button" onClick={showAllHistory} disabled={loadingAll || loadingOlder} title="Load every available candle for this pair and timeframe, then show them all">
              {loadingAll ? "Loading…" : "All history"}
            </button>
            <button type="button" className={auto ? "is-on" : ""} aria-pressed={auto} onClick={() => setAuto((value) => !value)} title="Auto: the price axis keeps the visible candles and your order levels in view">Auto</button>
            <button type="button" onClick={() => setFullscreen((value) => !value)} title={fullscreen ? "Exit full screen (Esc)" : "Full screen chart"}>{fullscreen ? "Exit full" : "Full screen"}</button>
          </div>
          <div className="segmented segmented-small" role="group" aria-label="Chart time zone" title={`Chart times are shown in ${timeZone}`}>
            <button type="button" className={tzMode === "local" ? "is-active" : ""} onClick={() => onTzModeChange("local")}>Local</button>
            <button type="button" className={tzMode === "utc" ? "is-active" : ""} onClick={() => onTzModeChange("utc")}>UTC</button>
          </div>
          <span className="tz-label">{tzLabel(timeZone)}</span>
        </div>
      </div>
      <div className="candle-chart-shell">
        <div ref={containerRef} className="candle-chart-wrap" />
        <div className="long-position-layer" aria-hidden="true">
          {positionBoxes.map((box) => (
            <div key={box.id} className={`long-position-box${box.preview ? " is-preview" : ""}${box.draggable ? " is-draggable" : ""}${box.blocked ? " is-blocked" : ""}`} style={{ left: box.left, width: box.width }}>
              <div
                className={`long-position-tp${box.draggable ? " is-draggable" : ""}`}
                style={{ top: Math.min(box.takeY, box.entryY), height: Math.abs(box.entryY - box.takeY) }}
                {...(box.draggable ? { onPointerDown: beginDrag("target"), onPointerMove: onDragMove, onPointerUp: endDrag, onPointerCancel: endDrag, title: "Drag to move the take-profit" } : {})}
              >
                <span>{box.draggable ? "⋮⋮ " : ""}Take Profit</span>
                <strong>{formatPrice(box.takeProfit)}</strong>
                <em className="pnl-positive">{formatPnl(box.targetPnl)}</em>
              </div>
              <div
                className={`long-position-entry${box.draggable ? " is-draggable" : ""}`}
                style={{ top: box.entryY }}
                {...(box.draggable ? { onPointerDown: beginDrag("entry"), onPointerMove: onDragMove, onPointerUp: endDrag, onPointerCancel: endDrag, title: "Drag to move the entry" } : {})}
              >
                <span>{box.draggable ? "⋮⋮ " : ""}Entry</span>
                <strong>{formatPrice(box.entry)}</strong>
                {box.rr > 0 && <em>1 : {box.rr.toFixed(1)}</em>}
              </div>
              <div
                className={`long-position-sl${box.draggable ? " is-draggable" : ""}`}
                style={{ top: Math.min(box.entryY, box.stopY), height: Math.abs(box.stopY - box.entryY) }}
                {...(box.draggable ? { onPointerDown: beginDrag("stop"), onPointerMove: onDragMove, onPointerUp: endDrag, onPointerCancel: endDrag, title: "Drag to move the stop-loss" } : {})}
              >
                <span>{box.draggable ? "⋮⋮ " : ""}Stop Loss</span>
                <strong>{formatPrice(box.stopLoss)}</strong>
                <em className="pnl-negative">{formatPnl(box.stopPnl)}</em>
              </div>
              {box.blocked && <div className="long-position-blocked">Blocked by risk rules</div>}
            </div>
          ))}
          {livePnlMarkers.map((marker) => (
            <div
              key={marker.id}
              className={`live-pnl-marker ${marker.pnl >= 0 ? "is-profit" : "is-loss"}`}
              style={{ top: marker.y, left: Math.min(marker.left, (containerRef.current?.clientWidth ?? 0) - 120) }}
            >
              <span>Live P/L</span>
              <strong>{formatPnl(marker.pnl)}</strong>
            </div>
          ))}
          {accountMarkers.map((level) => (
            <div key={level.id} className={`account-order-marker ${level.side === "BUY" ? "is-buy" : "is-sell"}`} style={{ top: level.y }}>
              <span>{level.title}</span>
              <strong>{formatPrice(level.price)}</strong>
            </div>
          ))}
        </div>
      </div>
      {candles.length === 0 && !loading && <div className="chart-empty">No candle data for this pair and timeframe.</div>}
      <div className="chart-key">
        <button type="button" className="chart-key-head" aria-expanded={legendOpen} onClick={() => setLegendOpen((v) => !v)}>
          <span>Legend{legend.length ? ` · ${legend.length}` : ""}</span>
          <span aria-hidden="true">{legendOpen ? "▾" : "▸"}</span>
        </button>
        {legendOpen && (
          legend.length === 0 ? (
            <p className="chart-key-empty">Turn on an indicator or tick a strategy to see what its abbreviations mean and a live read of the chart here.</p>
          ) : (
            <div className="chart-key-list">
              {legend.map((section) => (
                <div className="chart-key-section" key={section.key}>
                  <div className="chart-key-title">
                    {section.color && <i style={{ background: section.color }} aria-hidden="true" />}
                    <b>{section.title}</b>
                  </div>
                  <p className="chart-key-abbrevs">
                    {section.abbrevs.map(([code, meaning]) => <span key={code}><b>{code}</b> {meaning}</span>)}
                  </p>
                  <p className="chart-key-text">{section.text}</p>
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
}

function buildPositions(orders, symbol, mode) {
  return (orders ?? [])
    .filter((order) => order.symbol === symbol && (!order.account_mode || order.account_mode === mode) && ["WAITING_ENTRY", "PROTECTED", "MODIFYING"].includes(order.status))
    .map((order) => ({
      id: order.id,
      symbol: order.symbol,
      entry: Number(order.entry_price),
      stopLoss: Number(order.stop_loss_price),
      takeProfit: Number(order.take_profit_price),
      quantity: Number(order.quantity) || 0,
      feePercent: Number(order.fee_percent) || 0.1,
      side: order.side === "SHORT" ? "short" : "long",
      status: order.status,
      createdAt: order.created_at || null,
      preview: false,
    }))
    .filter((order) => order.entry > 0 && order.stopLoss > 0 && order.takeProfit > 0 && (order.side === "short" ? order.takeProfit < order.entry && order.entry < order.stopLoss : order.stopLoss < order.entry && order.entry < order.takeProfit));
}

/**
 * The order ticket being set up right now, as a draggable "position" the existing box-drawing code already knows
 * how to draw. Anchored to the LAST candle (not some span of candles further back), so `positionBoxRange` draws it
 * entirely in the empty space to the right of price action — it never sits over, or hides, any actual candle.
 */
function buildDraftPosition(draft, symbol, candles) {
  if (!draft || draft.symbol !== symbol) return null;
  const entry = Number(draft.entry);
  const stopLoss = Number(draft.stopLoss);
  const takeProfit = Number(draft.takeProfit);
  const side = draft.side === "short" ? "short" : "long";
  const ok = entry > 0 && stopLoss > 0 && takeProfit > 0
    && (side === "short" ? takeProfit < entry && entry < stopLoss : stopLoss < entry && entry < takeProfit);
  if (!ok || !candles?.length) return null;
  const createdAtMs = Number(candles[candles.length - 1]?.[0]);
  if (!Number.isFinite(createdAtMs)) return null;
  return {
    id: "draft", symbol, entry, stopLoss, takeProfit,
    quantity: Number(draft.quantity) || 0,
    feePercent: Number(draft.feePercent) || 0.1,
    side, status: "DRAFT", createdAt: new Date(createdAtMs).toISOString(),
    preview: true, draggable: true, blocked: Boolean(draft.blocked),
  };
}

function extractOrderLevels(order, positions) {
  const activeManaged = positions;
  const side = order.side;
  const type = String(order.type || "");
  const levels = [];

  if (side === "BUY") {
    const price = Number(order.price);
    if (Number.isFinite(price) && price > 0) levels.push({ price, title: `BUY ${shortType(type)}`, color: COLORS.up, side: "BUY" });
  } else if (type.includes("STOP")) {
    const price = Number(order.stopPrice || order.price);
    if (Number.isFinite(price) && price > 0) levels.push({ price, title: `SELL SL`, color: COLORS.down, side: "SELL" });
  } else {
    const price = Number(order.price);
    if (Number.isFinite(price) && price > 0) levels.push({ price, title: `SELL ${shortType(type)}`, color: COLORS.down, side: "SELL" });
  }

  return levels
    .filter((level) => !activeManaged.some((position) => nearPrice(level.price, position.entry) || nearPrice(level.price, position.stopLoss) || nearPrice(level.price, position.takeProfit)))
    .map((level, index) => ({
      ...level,
      id: `${order.orderId}-${index}`,
    }));
}

function shortType(type) {
  if (type.includes("LIMIT_MAKER")) return "TP";
  if (type.includes("STOP")) return "SL";
  if (type.includes("LIMIT")) return "LIMIT";
  return type || "ORDER";
}

function nearPrice(left, right) {
  if (!Number.isFinite(left) || !Number.isFinite(right) || right === 0) return false;
  return Math.abs(left - right) / Math.abs(right) < 0.0005;
}

function formatPrice(value) {
  if (!Number.isFinite(value)) return "—";
  if (value >= 100) return value.toFixed(2);
  if (value >= 1) return value.toFixed(4);
  return value.toFixed(6);
}

function netPnlUsdt(entry, exitPrice, quantity, feePercent, side = "long") {
  if (![entry, exitPrice, quantity].every((value) => Number.isFinite(value) && value > 0)) return 0;
  const fee = Number.isFinite(feePercent) ? feePercent : 0.1;
  if (side === "short") return entry * quantity * (1 - fee / 100) - exitPrice * quantity * (1 + fee / 100);
  const proceeds = exitPrice * quantity * (1 - fee / 100);
  const cost = entry * quantity * (1 + fee / 100);
  return proceeds - cost;
}

function roundPnl(value) {
  return Math.round(value * 10000) / 10000;
}

function formatPnl(value) {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const digits = abs >= 10 ? 2 : abs >= 1 ? 3 : 4;
  const formatted = abs.toFixed(digits);
  return `${value >= 0 ? "+" : "-"}${formatted} USDT`;
}

function toChartTime(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

function getLastCandleTime(candles) {
  if (!candles?.length) return null;
  const last = candles[candles.length - 1];
  const ms = Number(last?.[0]);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function snapToCandleTime(candles, orderTime) {
  if (orderTime == null || !candles?.length) return orderTime;
  let best = null;
  for (const candle of candles) {
    const time = Math.floor(Number(candle[0]) / 1000);
    if (!Number.isFinite(time)) continue;
    if (time <= orderTime && (best == null || time > best)) best = time;
  }
  if (best != null) return best;
  return Math.floor(Number(candles[0][0]) / 1000);
}

function positionBoxRange(timeScale, orderTime, lastCandleTime, chartWidth) {
  if (orderTime == null) return null;

  let left = timeScale.timeToCoordinate(orderTime);
  const visible = timeScale.getVisibleRange();

  if (left == null) {
    if (visible && orderTime < visible.from) left = 0;
    else return null;
  }

  let right = lastCandleTime != null ? timeScale.timeToCoordinate(lastCandleTime) : null;
  if (right == null) right = chartWidth - 48;
  else right += 36;

  // Keep a readable minimum width while staying anchored at order time.
  right = Math.max(right, left + 96);
  right = Math.min(right, chartWidth - 8);
  if (right <= left) return null;

  return { left, width: right - left };
}

function boxesEqual(left, right) {
  if (left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index];
    return item.id === other.id
      && item.preview === other.preview
      && item.draggable === other.draggable
      && item.blocked === other.blocked
      && item.left === other.left
      && item.width === other.width
      && item.entryY === other.entryY
      && item.stopY === other.stopY
      && item.takeY === other.takeY
      && item.liveY === other.liveY
      && item.rr === other.rr
      && item.livePnl === other.livePnl
      && item.stopPnl === other.stopPnl
      && item.targetPnl === other.targetPnl;
  });
}

function markersEqual(left, right) {
  if (left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index];
    return item.id === other.id && item.y === other.y && item.price === other.price && item.title === other.title;
  });
}

function liveMarkersEqual(left, right) {
  if (left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index];
    return item.id === other.id && item.y === other.y && item.pnl === other.pnl && item.left === other.left;
  });
}

function parseCandles(candles) {
  const unique = new Map(candles.map((candle) => [Number(candle[0]), candle]));
  const parsed = [...unique.values()].sort((left, right) => Number(left[0]) - Number(right[0])).map((candle) => ({
    time: Math.floor(Number(candle[0]) / 1000),
    open: Number(candle[1]),
    high: Number(candle[2]),
    low: Number(candle[3]),
    close: Number(candle[4]),
    volume: Number(candle[5]),
  }));
  const closes = parsed.map((candle) => candle.close);
  const fastMa = [];
  const slowMa = [];
  parsed.forEach((candle, index) => {
    const fast = average(closes, index, 9);
    const slow = average(closes, index, 21);
    if (fast != null) fastMa.push({ time: candle.time, value: fast });
    if (slow != null) slowMa.push({ time: candle.time, value: slow });
  });
  return {
    candles: parsed,
    fastMa,
    slowMa,
    volume: parsed.map((candle) => ({ time: candle.time, value: candle.volume, color: candle.close >= candle.open ? "rgba(53,196,140,0.35)" : "rgba(232,96,76,0.35)" })),
  };
}

function average(values, index, period) {
  if (index + 1 < period) return null;
  return values.slice(index + 1 - period, index + 1).reduce((sum, value) => sum + value, 0) / period;
}
