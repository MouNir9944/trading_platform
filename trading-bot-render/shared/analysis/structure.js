/**
 * Market structure analysis: swing points, trend classification (HH/HL/LH/LL),
 * break of structure (BOS) / change of character (CHoCH), and support/resistance levels.
 *
 * Swings are fractal pivots: a swing high is a candle whose high is above the `right` candles after it
 * and the `left` before it. A pivot is only *confirmed* `right` candles later, so everything here is
 * causal: `confirmedAt` records the first candle at which a swing could have been known.
 */
import { atr } from "./indicators.js";

const DEFAULTS = { left: 3, right: 3 };

/** Raw fractal pivots, oldest first. Each carries `confirmedAt`, the first candle where it is knowable. */
export function findPivots(candles, { left, right } = DEFAULTS) {
  const pivots = [];
  for (let i = left; i < candles.length - right; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j].high > candles[i].high || (j > i && candles[j].high === candles[i].high)) isHigh = false;
      if (candles[j].low < candles[i].low || (j > i && candles[j].low === candles[i].low)) isLow = false;
    }
    if (isHigh) pivots.push({ index: i, time: candles[i].time, price: candles[i].high, type: "high", confirmedAt: i + right });
    if (isLow) pivots.push({ index: i, time: candles[i].time, price: candles[i].low, type: "low", confirmedAt: i + right });
  }
  return pivots;
}

/** Add a pivot to a swing list so highs and lows alternate; a same-type neighbour keeps the more extreme. */
function pushSwing(swings, swing) {
  const last = swings[swings.length - 1];
  if (!last || last.type !== swing.type) {
    swings.push(swing);
  } else if (swing.type === "high" ? swing.price > last.price : swing.price < last.price) {
    swings[swings.length - 1] = swing;
  }
}

/** Alternating swings from pivots. Applying this to only the pivots confirmed by candle i is causal. */
export function reduceSwings(pivots) {
  const swings = [];
  for (const pivot of pivots) pushSwing(swings, pivot);
  return swings;
}

/** The swings a trader could have known at candle i (no look-ahead). */
export const swingsUpTo = (pivots, i) => reduceSwings(pivots.filter((p) => p.confirmedAt <= i));

/** Tag each swing HH/LH (highs) or HL/LL (lows) against the previous swing of the same kind. */
export function labelSwings(swings) {
  let prevHigh = null;
  let prevLow = null;
  return swings.map((swing) => {
    let label = null;
    if (swing.type === "high") {
      if (prevHigh) label = swing.price > prevHigh.price ? "HH" : "LH";
      prevHigh = swing;
    } else {
      if (prevLow) label = swing.price > prevLow.price ? "HL" : "LL";
      prevLow = swing;
    }
    return { ...swing, label };
  });
}

/** Trend from the two most recent highs and lows. */
export function classifyTrend(labeled) {
  const highs = labeled.filter((s) => s.type === "high" && s.label);
  const lows = labeled.filter((s) => s.type === "low" && s.label);
  const lastHigh = highs[highs.length - 1]?.label;
  const lastLow = lows[lows.length - 1]?.label;
  if (lastHigh === "HH" && lastLow === "HL") return "uptrend";
  if (lastHigh === "LH" && lastLow === "LL") return "downtrend";
  if (!lastHigh || !lastLow) return "range";
  // Mixed: one leg made a higher high but the last low broke lower (or the reverse).
  return lastHigh === "HH" || lastLow === "HL" ? "weak-uptrend" : "weak-downtrend";
}

/**
 * Structure breaks, detected candle by candle without look-ahead.
 * A close above the latest unbroken swing high is a bullish break; below the latest swing low, bearish.
 * With the prevailing bias it is a BOS (continuation); against it, a CHoCH (possible reversal).
 */
export function findBreaks(candles, pivots) {
  const byConfirmation = new Map();
  for (const pivot of pivots) {
    if (!byConfirmation.has(pivot.confirmedAt)) byConfirmation.set(pivot.confirmedAt, []);
    byConfirmation.get(pivot.confirmedAt).push(pivot);
  }

  const breaks = [];
  const swings = [];
  let bias = null;
  for (let i = 0; i < candles.length; i++) {
    for (const pivot of byConfirmation.get(i) ?? []) pushSwing(swings, { ...pivot, broken: false });
    const high = [...swings].reverse().find((s) => s.type === "high");
    const low = [...swings].reverse().find((s) => s.type === "low");
    const close = candles[i].close;
    if (high && !high.broken && close > high.price) {
      breaks.push({
        type: bias === "bearish" ? "CHoCH" : "BOS", direction: "bull", level: high.price,
        swingIndex: high.index, swingTime: high.time, index: i, time: candles[i].time,
      });
      high.broken = true;
      bias = "bullish";
    } else if (low && !low.broken && close < low.price) {
      breaks.push({
        type: bias === "bullish" ? "CHoCH" : "BOS", direction: "bear", level: low.price,
        swingIndex: low.index, swingTime: low.time, index: i, time: candles[i].time,
      });
      low.broken = true;
      bias = "bearish";
    }
  }
  return breaks;
}

/**
 * Support/resistance from clustered swing prices. Swings within `tolerance` of each other merge into
 * one level; more touches means a stronger level. Levels below the price are support, above resistance.
 */
export function findLevels(swings, price, tolerance) {
  const clusters = [];
  for (const swing of [...swings].sort((a, b) => a.price - b.price)) {
    const last = clusters[clusters.length - 1];
    if (last && swing.price - last.max <= tolerance) {
      last.prices.push(swing.price);
      last.max = swing.price;
      last.lastIndex = Math.max(last.lastIndex, swing.index);
    } else {
      clusters.push({ prices: [swing.price], max: swing.price, lastIndex: swing.index });
    }
  }
  const levels = clusters.map((c) => ({
    price: c.prices.reduce((a, b) => a + b, 0) / c.prices.length,
    touches: c.prices.length,
    lastIndex: c.lastIndex,
  }));
  const supports = levels.filter((l) => l.price < price).sort((a, b) => b.price - a.price);
  const resistances = levels.filter((l) => l.price >= price).sort((a, b) => a.price - b.price);
  return { supports, resistances };
}

export function analyzeStructure(candles, options = DEFAULTS) {
  if (candles.length < options.left + options.right + 5) {
    return { pivots: [], swings: [], trend: "range", breaks: [], supports: [], resistances: [], lastHigh: null, lastLow: null };
  }
  const pivots = findPivots(candles, options);
  const swings = labelSwings(reduceSwings(pivots));
  const breaks = findBreaks(candles, pivots);
  const last = candles[candles.length - 1];
  const range = atr(candles, 14)[candles.length - 1] ?? last.close * 0.005;
  const { supports, resistances } = findLevels(swings, last.close, Math.max(range * 0.5, last.close * 0.001));
  return {
    pivots,
    swings,
    trend: classifyTrend(swings),
    breaks,
    supports,
    resistances,
    lastHigh: [...swings].reverse().find((s) => s.type === "high") ?? null,
    lastLow: [...swings].reverse().find((s) => s.type === "low") ?? null,
  };
}
