import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  createChart,
} from "lightweight-charts";

const COLORS = {
  background: "#10151f",
  grid: "#202838",
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

export default function PriceChart({
  candles,
  loading,
  onPriceSelect,
  interval,
  onIntervalChange,
  orders,
  binanceOpenOrders = [],
  symbol,
  mode = "testnet",
  currentPrice = null,
}) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const candleSeriesRef = useRef(null);
  const fastSeriesRef = useRef(null);
  const slowSeriesRef = useRef(null);
  const volumeSeriesRef = useRef(null);
  const orderLinesRef = useRef([]);
  const fittedKeyRef = useRef(null);
  const priceFitKeyRef = useRef(null);
  const onPriceSelectRef = useRef(onPriceSelect);
  const [positionBoxes, setPositionBoxes] = useState([]);
  const [accountMarkers, setAccountMarkers] = useState([]);
  const [livePnlMarkers, setLivePnlMarkers] = useState([]);
  onPriceSelectRef.current = onPriceSelect;

  const positions = useMemo(() => buildPositions(orders, symbol, mode), [orders, symbol, mode]);
  const accountOrders = useMemo(
    () => (binanceOpenOrders ?? []).filter((order) => order.symbol === symbol),
    [binanceOpenOrders, symbol],
  );
  const accountOrderLevels = useMemo(
    () => accountOrders.flatMap((order) => extractOrderLevels(order, positions)),
    [accountOrders, positions],
  );

  useEffect(() => {
    priceFitKeyRef.current = null;
  }, [mode]);

  useEffect(() => {
    if (!containerRef.current) return undefined;
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: COLORS.background },
        textColor: COLORS.text,
        fontFamily: "IBM Plex Mono",
        fontSize: 11,
      },
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

    chart.subscribeClick((param) => {
      if (!param.point) return;
      const price = candleSeries.coordinateToPrice(param.point.y);
      if (price != null && Number.isFinite(price)) onPriceSelectRef.current(Number(price));
    });

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
    candleSeriesRef.current.setData(parsed.candles);
    fastSeriesRef.current.setData(parsed.fastMa);
    slowSeriesRef.current.setData(parsed.slowMa);
    volumeSeriesRef.current.setData(parsed.volume);
    const fitKey = `${symbol}:${interval}`;
    if (fittedKeyRef.current !== fitKey) {
      const visibleBars = ["1m", "3m", "5m", "15m"].includes(interval) ? 80 : 100;
      chartRef.current?.timeScale().setVisibleLogicalRange({
        from: Math.max(0, parsed.candles.length - visibleBars),
        to: parsed.candles.length + 5,
      });
      fittedKeyRef.current = fitKey;
      priceFitKeyRef.current = null;
    }
  }, [candles, interval, symbol]);

  useEffect(() => {
    if (!candleSeriesRef.current) return;
    orderLinesRef.current.forEach(({ series, line }) => series.removePriceLine(line));
    orderLinesRef.current = [];

    positions.forEach((position) => {
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

    const fitPrices = accountOrderLevels.map((level) => level.price);
    const fitKey = `${mode}:${symbol}:${fitPrices.map((price) => price.toFixed(8)).join("|")}`;
    if (fitPrices.length > 0 && priceFitKeyRef.current !== fitKey && candles.length > 0) {
      const parsed = parseCandles(candles).candles;
      const lows = parsed.map((candle) => candle.low);
      const highs = parsed.map((candle) => candle.high);
      const min = Math.min(...lows, ...fitPrices);
      const max = Math.max(...highs, ...fitPrices);
      const pad = Math.max((max - min) * 0.08, max * 0.002);
      try {
        candleSeriesRef.current.priceScale().setVisibleRange({ from: min - pad, to: max + pad });
        priceFitKeyRef.current = fitKey;
      } catch {
        // Scale may not be ready yet on first paint.
      }
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
          ? netPnlUsdt(position.entry, markPrice, position.quantity, position.feePercent)
          : null;
        const stopPnl = roundPnl(netPnlUsdt(position.entry, position.stopLoss, position.quantity, position.feePercent));
        const targetPnl = roundPnl(netPnlUsdt(position.entry, position.takeProfit, position.quantity, position.feePercent));
        const livePnl = livePnlRaw == null ? null : roundPnl(livePnlRaw);
        const liveY = series.priceToCoordinate(markPrice);
        return {
          id: position.id,
          preview: position.preview,
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

  const accountLabel = mode === "live" ? "Live" : "Testnet";

  return (
    <div className="panel chart-panel">
      <div className="chart-toolbar">
        <p className="panel-title">
          {loading && candles.length === 0 ? "Loading" : `${accountLabel} orders`} — {interval}
          {accountOrders.length > 0 ? ` · ${accountOrders.length} open on chart` : " · no open account orders"}
        </p>
        <div className="chart-legend">
          <span><i className="legend-fast" />MA 9</span>
          <span><i className="legend-slow" />MA 21</span>
          <span className="legend-tp">TP zone</span>
          <span className="legend-sl">SL zone</span>
        </div>
        <div className="chart-controls">
          <select value={interval} onChange={(event) => onIntervalChange(event.target.value)} aria-label="Chart timeframe">
            {["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d", "1w"].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <button type="button" className="latest-button" onClick={() => chartRef.current?.timeScale().scrollToRealTime()}>Latest</button>
        </div>
      </div>
      <div className="candle-chart-shell">
        <div ref={containerRef} className="candle-chart-wrap" />
        <div className="long-position-layer" aria-hidden="true">
          {positionBoxes.map((box) => (
            <div key={box.id} className={`long-position-box${box.preview ? " is-preview" : ""}`} style={{ left: box.left, width: box.width }}>
              <div
                className="long-position-tp"
                style={{ top: Math.min(box.takeY, box.entryY), height: Math.abs(box.entryY - box.takeY) }}
              >
                <span>Take Profit</span>
                <strong>{formatPrice(box.takeProfit)}</strong>
                <em className="pnl-positive">{formatPnl(box.targetPnl)}</em>
              </div>
              <div className="long-position-entry" style={{ top: box.entryY }}>
                <span>Entry</span>
                <strong>{formatPrice(box.entry)}</strong>
                {box.rr > 0 && <em>1 : {box.rr.toFixed(1)}</em>}
              </div>
              <div
                className="long-position-sl"
                style={{ top: Math.min(box.entryY, box.stopY), height: Math.abs(box.stopY - box.entryY) }}
              >
                <span>Stop Loss</span>
                <strong>{formatPrice(box.stopLoss)}</strong>
                <em className="pnl-negative">{formatPnl(box.stopPnl)}</em>
              </div>
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
      status: order.status,
      createdAt: order.created_at || null,
      preview: false,
    }))
    .filter((order) => order.entry > 0 && order.stopLoss > 0 && order.takeProfit > 0 && order.stopLoss < order.entry && order.entry < order.takeProfit);
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

function netPnlUsdt(entry, exitPrice, quantity, feePercent) {
  if (![entry, exitPrice, quantity].every((value) => Number.isFinite(value) && value > 0)) return 0;
  const fee = Number.isFinite(feePercent) ? feePercent : 0.1;
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
