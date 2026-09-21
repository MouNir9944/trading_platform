/**
 * Smart Money Concepts, following the logic of the "Smart Money Concepts [LuxAlgo]" TradingView indicator.
 *
 * This module is an ADAPTATION of that indicator's algorithm (Pine Script v5) to JavaScript.
 *   Original: (c) LuxAlgo, licensed under Attribution-NonCommercial-ShareAlike 4.0 International
 *             (CC BY-NC-SA 4.0), https://creativecommons.org/licenses/by-nc-sa/4.0/
 *   As an adaptation, THIS FILE is distributed under the same license: credit LuxAlgo, use it for non-commercial
 *   purposes only, and share any modification under CC BY-NC-SA 4.0. The rest of this project is not covered.
 *
 * What it computes (all causal, one bar at a time, exactly as the indicator runs on a live chart):
 *   - swing pivots ("legs") with a large lookback (default 50) and internal pivots with a small one (default 5)
 *   - market structure breaks: BOS (with the trend) and CHoCH (against it), for both swing and internal pivots
 *   - order blocks for each break, with a volatility filter, and mitigation by high/low or by close
 *   - equal highs / equal lows (EQH / EQL)
 *   - fair value gaps with an automatic significance threshold
 *   - trailing swing extremes: premium / equilibrium / discount zones and strong / weak highs and lows
 *   - swing point labels (HH, LH, HL, LL), previous day / week / month highs and lows, and the internal trend
 *
 * Deviations from the Pine original, all deliberate:
 *   - the volatility measure falls back to the running mean true range while fewer than 200 candles exist
 *     (TradingView charts always have thousands of bars; ours may have fewer)
 *   - the optional confluence filter uses its evident intent (upper wick longer than lower wick for bullish breaks)
 *   - fair value gaps are evaluated on the chart timeframe only (no separate higher-timeframe option)
 *   - "Historical / Present" display and colours are presentation concerns and live in the chart code
 */
import { atr, trueRange } from "./indicators.js";

const BULLISH = 1;
const BEARISH = -1;

export const LUX_DEFAULTS = Object.freeze({
  swingLength: 50,
  internalLength: 5,
  equalLength: 3,
  equalThreshold: 0.1,
  obFilter: "atr", // "atr" | "range"
  obMitigation: "highlow", // "highlow" | "close"
  confluenceFilter: false,
  internalOrderBlocks: true,
  swingOrderBlocks: true,
  fvgAutoThreshold: true,
});

const pivot = () => ({ level: null, last: null, crossed: false, index: -1 });

/** Leg tracker: is the candle `size` bars ago a new extreme of the last `size` bars? Direction changes make pivots. */
function makeLeg(size, high, low) {
  let leg = 0;
  return (i) => {
    const previous = leg;
    if (i >= size) {
      let hi = -Infinity;
      let lo = Infinity;
      for (let j = i - size + 1; j <= i; j++) {
        if (high[j] > hi) hi = high[j];
        if (low[j] < lo) lo = low[j];
      }
      if (high[i - size] > hi) leg = 0; // bearish leg: the candle `size` bars ago was a swing high
      else if (low[i - size] < lo) leg = 1; // bullish leg: it was a swing low
    }
    return leg - previous; // +1 = a pivot low was just confirmed, -1 = a pivot high
  };
}

export function analyzeLux(candles, options = {}) {
  const o = { ...LUX_DEFAULTS, ...options };
  const n = candles.length;
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const open = candles.map((c) => c.open);
  const close = candles.map((c) => c.close);
  const time = candles.map((c) => c.time);

  const tr = trueRange(candles);
  const atr200 = atr(candles, 200);
  const result = {
    options: o,
    structures: [],
    swingPoints: [],
    orderBlocks: [], // every order block ever formed; `mitigatedAt` tells when it died
    equalLevels: [],
    fvgs: [],
    internalBias: new Int8Array(n),
    trend: { swing: 0, internal: 0 },
    trailing: null,
    levels: [],
  };
  if (n < 3) return result;

  // ---- state ----
  const swingHigh = pivot(); const swingLow = pivot();
  const internalHigh = pivot(); const internalLow = pivot();
  const equalHigh = pivot(); const equalLow = pivot();
  const swingTrend = { bias: 0 };
  const internalTrend = { bias: 0 };
  const trailing = { top: null, bottom: null, index: -1, topIndex: -1, bottomIndex: -1 };
  const internalOBs = []; // newest first, active only
  const swingOBs = [];
  const activeFvgs = [];
  const parsedHighs = new Array(n);
  const parsedLows = new Array(n);

  const swingLeg = makeLeg(o.swingLength, high, low);
  const internalLeg = makeLeg(o.internalLength, high, low);
  const equalLeg = makeLeg(o.equalLength, high, low);

  let cumRange = 0;
  let cumDelta = 0;
  let bullishBar = true;
  let bearishBar = true;

  const atrMeasure = (i) => atr200[i] ?? cumRange / Math.max(1, i);

  /** Pivot handling for one leg tracker; mirrors getCurrentStructure(). */
  function currentStructure(legChange, size, i, kind) {
    if (legChange === 0) return;
    const at = i - size;
    const equal = kind === "equal";
    const internal = kind === "internal";
    if (legChange === 1) {
      const p = equal ? equalLow : internal ? internalLow : swingLow;
      if (equal && p.level != null && Math.abs(p.level - low[at]) < o.equalThreshold * atrMeasure(i)) {
        result.equalLevels.push({ type: "EQL", fromIndex: p.index, toIndex: at, level: low[at], firstLevel: p.level, formedAt: i });
      }
      p.last = p.level; p.level = low[at]; p.crossed = false; p.index = at;
      if (kind === "swing") {
        trailing.bottom = p.level; trailing.index = at; trailing.bottomIndex = at;
        result.swingPoints.push({ index: at, price: p.level, type: "low", label: p.last != null && p.level < p.last ? "LL" : "HL", formedAt: i });
      }
    } else {
      const p = equal ? equalHigh : internal ? internalHigh : swingHigh;
      if (equal && p.level != null && Math.abs(p.level - high[at]) < o.equalThreshold * atrMeasure(i)) {
        result.equalLevels.push({ type: "EQH", fromIndex: p.index, toIndex: at, level: high[at], firstLevel: p.level, formedAt: i });
      }
      p.last = p.level; p.level = high[at]; p.crossed = false; p.index = at;
      if (kind === "swing") {
        trailing.top = p.level; trailing.index = at; trailing.topIndex = at;
        result.swingPoints.push({ index: at, price: p.level, type: "high", label: p.last != null && p.level > p.last ? "HH" : "LH", formedAt: i });
      }
    }
  }

  function storeOrderBlock(p, internal, bias, i) {
    if (!(internal ? o.internalOrderBlocks : o.swingOrderBlocks)) return;
    let index = -1;
    let best = bias === BEARISH ? -Infinity : Infinity;
    for (let j = p.index; j < i; j++) {
      if (bias === BEARISH ? parsedHighs[j] > best : parsedLows[j] < best) {
        best = bias === BEARISH ? parsedHighs[j] : parsedLows[j];
        index = j;
      }
    }
    if (index < 0) return;
    const block = { scope: internal ? "internal" : "swing", bias: bias === BULLISH ? "bull" : "bear", top: parsedHighs[index], bottom: parsedLows[index], index, time: time[index], formedAt: i, mitigatedAt: null };
    const list = internal ? internalOBs : swingOBs;
    if (list.length >= 100) list.pop();
    list.unshift(block);
    result.orderBlocks.push(block);
  }

  /** Structure breaks for one pivot family; mirrors displayStructure(). `prev` holds last bar's pivot levels. */
  function displayStructure(internal, i, prev) {
    const high_ = internal ? internalHigh : swingHigh;
    const low_ = internal ? internalLow : swingLow;
    const trend = internal ? internalTrend : swingTrend;
    const prevHigh = internal ? prev.internalHigh : prev.swingHigh;
    const prevLow = internal ? prev.internalLow : prev.swingLow;

    if (internal && o.confluenceFilter) {
      const upperWick = high[i] - Math.max(close[i], open[i]);
      const lowerWick = Math.min(close[i], open[i]) - low[i];
      bullishBar = upperWick > lowerWick;
      bearishBar = upperWick < lowerWick;
    }

    const extraHigh = internal ? high_.level !== swingHigh.level && bullishBar : true;
    if (high_.level != null && prevHigh != null && close[i] > high_.level && close[i - 1] <= prevHigh && !high_.crossed && extraHigh) {
      const tag = trend.bias === BEARISH ? "CHoCH" : "BOS";
      high_.crossed = true;
      trend.bias = BULLISH;
      result.structures.push({ scope: internal ? "internal" : "swing", dir: "bull", tag, level: high_.level, fromIndex: high_.index, toIndex: i });
      storeOrderBlock(high_, internal, BULLISH, i);
    }

    const extraLow = internal ? low_.level !== swingLow.level && bearishBar : true;
    if (low_.level != null && prevLow != null && close[i] < low_.level && close[i - 1] >= prevLow && !low_.crossed && extraLow) {
      const tag = trend.bias === BULLISH ? "CHoCH" : "BOS";
      low_.crossed = true;
      trend.bias = BEARISH;
      result.structures.push({ scope: internal ? "internal" : "swing", dir: "bear", tag, level: low_.level, fromIndex: low_.index, toIndex: i });
      storeOrderBlock(low_, internal, BEARISH, i);
    }
  }

  function mitigateOrderBlocks(list, i) {
    for (let k = list.length - 1; k >= 0; k--) {
      const b = list[k];
      const bearSource = o.obMitigation === "close" ? close[i] : high[i];
      const bullSource = o.obMitigation === "close" ? close[i] : low[i];
      if ((b.bias === "bear" && bearSource > b.top) || (b.bias === "bull" && bullSource < b.bottom)) {
        b.mitigatedAt = i;
        list.splice(k, 1);
      }
    }
  }

  // ---- one bar at a time ----
  for (let i = 0; i < n; i++) {
    cumRange += tr[i];
    const measure = o.obFilter === "atr" ? atr200[i] : i > 0 ? cumRange / i : null;
    const highVolatility = measure != null && high[i] - low[i] >= 2 * measure;
    parsedHighs[i] = highVolatility ? low[i] : high[i];
    parsedLows[i] = highVolatility ? high[i] : low[i];

    const prev = { swingHigh: swingHigh.level, swingLow: swingLow.level, internalHigh: internalHigh.level, internalLow: internalLow.level };

    // trailing swing extremes follow price until the next swing pivot resets them
    if (trailing.top != null) {
      trailing.top = Math.max(high[i], trailing.top);
      if (trailing.top === high[i]) trailing.topIndex = i;
    }
    if (trailing.bottom != null) {
      trailing.bottom = Math.min(low[i], trailing.bottom);
      if (trailing.bottom === low[i]) trailing.bottomIndex = i;
    }

    // fair value gaps: retire filled ones first, then look for a new one
    for (let k = activeFvgs.length - 1; k >= 0; k--) {
      const g = activeFvgs[k];
      if ((g.bias === "bull" && low[i] < g.bottom) || (g.bias === "bear" && high[i] > g.top)) {
        g.filledAt = i;
        activeFvgs.splice(k, 1);
      }
    }

    currentStructure(swingLeg(i), o.swingLength, i, "swing");
    currentStructure(internalLeg(i), o.internalLength, i, "internal");
    currentStructure(equalLeg(i), o.equalLength, i, "equal");
    displayStructure(true, i, prev);
    displayStructure(false, i, prev);
    mitigateOrderBlocks(internalOBs, i);
    mitigateOrderBlocks(swingOBs, i);

    // The significance threshold is twice the running mean body size of the previous candles (accumulated from bar 1).
    const delta = i >= 1 ? (close[i - 1] - open[i - 1]) / (open[i - 1] * 100) : 0;
    if (i >= 1) cumDelta += Math.abs(delta);
    if (i >= 2) {
      const threshold = o.fvgAutoThreshold ? (cumDelta / i) * 2 : 0;
      let gap = null;
      if (low[i] > high[i - 2] && close[i - 1] > high[i - 2] && delta > threshold) gap = { bias: "bull", top: low[i], bottom: high[i - 2] };
      else if (high[i] < low[i - 2] && close[i - 1] < low[i - 2] && -delta > threshold) gap = { bias: "bear", top: low[i - 2], bottom: high[i] };
      if (gap) {
        const fvg = { ...gap, fromIndex: i - 1, formedAt: i, filledAt: null };
        activeFvgs.unshift(fvg);
        result.fvgs.push(fvg);
      }
    }

    result.internalBias[i] = internalTrend.bias;
  }

  result.trend = { swing: swingTrend.bias, internal: internalTrend.bias };
  result.trailing = trailing.top != null && trailing.bottom != null ? { ...trailing, swingBias: swingTrend.bias } : null;
  result.levels = previousPeriodLevels(candles);
  return result;
}

// ---- previous day / week / month highs and lows (UTC) ----
const PERIODS = [
  { id: "D", label: "D", seconds: 86400, key: (t) => Math.floor(t / 86400) },
  { id: "W", label: "W", seconds: 7 * 86400, key: (t) => Math.floor((t / 86400 + 3) / 7) }, // weeks start on Monday
  { id: "M", label: "M", seconds: 28 * 86400, key: (t) => { const d = new Date(t * 1000); return d.getUTCFullYear() * 12 + d.getUTCMonth(); } },
];

/** High and low of the previous completed day/week/month, and where in the data they happened. */
export function previousPeriodLevels(candles) {
  if (candles.length < 2) return [];
  const chartSeconds = candles[1].time - candles[0].time;
  const out = [];
  for (const period of PERIODS) {
    if (chartSeconds > period.seconds) continue; // a chart slower than the period cannot show it
    const currentKey = period.key(candles[candles.length - 1].time);
    let previousKey = null;
    for (let i = candles.length - 1; i >= 0; i--) {
      const key = period.key(candles[i].time);
      if (key < currentKey) { previousKey = key; break; }
    }
    if (previousKey == null) continue;
    let highIndex = -1;
    let lowIndex = -1;
    for (let i = 0; i < candles.length; i++) {
      if (period.key(candles[i].time) !== previousKey) continue;
      if (highIndex < 0 || candles[i].high > candles[highIndex].high) highIndex = i;
      if (lowIndex < 0 || candles[i].low < candles[lowIndex].low) lowIndex = i;
    }
    out.push({ id: period.id, label: period.label, high: candles[highIndex].high, highIndex, low: candles[lowIndex].low, lowIndex });
  }
  return out;
}

/** Order blocks that are still alive at the end of the data, newest first. */
export const activeLuxOrderBlocks = (result, scope) => result.orderBlocks.filter((b) => b.scope === scope && b.mitigatedAt == null).reverse();

/** Fair value gaps that were never filled, newest first. */
export const activeLuxFvgs = (result) => result.fvgs.filter((g) => g.filledAt == null).reverse();
