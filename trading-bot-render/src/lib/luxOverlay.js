/**
 * Turns the LuxAlgo-style analysis (shared/analysis/luxSmc.js) into something the chart can draw.
 * Colours and defaults follow the original indicator. Original: (c) LuxAlgo, CC BY-NC-SA 4.0
 * (https://creativecommons.org/licenses/by-nc-sa/4.0/). See the licence note in luxSmc.js.
 */
import { activeLuxFvgs, activeLuxOrderBlocks } from "../../shared/analysis/luxSmc.js";

export const LUX_SETTINGS_DEFAULTS = Object.freeze({
  enabled: false,
  mode: "historical", // "historical" keeps all structure on screen, "present" only the latest
  style: "colored", // "colored" | "mono"
  showInternal: true,
  showSwing: true,
  internalBull: "all", // "all" | "BOS" | "CHoCH"
  internalBear: "all",
  swingBull: "all",
  swingBear: "all",
  internalOrderBlocks: true,
  internalOrderBlocksCount: 5,
  swingOrderBlocks: false,
  swingOrderBlocksCount: 5,
  showEqual: true,
  showFvg: false,
  showZones: false,
  showStrongWeak: true,
  showSwingPoints: false,
  levelsD: false,
  levelsW: false,
  levelsM: false,
  trendCandles: false,
  // engine parameters
  swingLength: 50,
  equalThreshold: 0.1,
  obFilter: "atr",
  obMitigation: "highlow",
  confluenceFilter: false,
});

/** The subset of settings that changes what the engine computes (used to cache the analysis). */
export const luxEngineOptions = (s) => ({
  swingLength: s.swingLength,
  equalThreshold: s.equalThreshold,
  obFilter: s.obFilter,
  obMitigation: s.obMitigation,
  confluenceFilter: s.confluenceFilter,
  internalOrderBlocks: s.internalOrderBlocks,
  swingOrderBlocks: s.swingOrderBlocks,
});

const GREEN = "#089981";
const RED = "#F23645";
const BLUE = "#2157f3";
const GRAY = "#878b94";
const MONO_BULL = "#b2b5be";
const MONO_BEAR = "#5d606b";

function palette(style) {
  const mono = style === "mono";
  return {
    bull: mono ? MONO_BULL : GREEN,
    bear: mono ? MONO_BEAR : RED,
    internalBullOb: mono ? "rgba(178, 181, 190, 0.2)" : "rgba(49, 121, 245, 0.2)",
    internalBearOb: mono ? "rgba(93, 96, 107, 0.2)" : "rgba(247, 124, 128, 0.2)",
    swingBullOb: mono ? "rgba(178, 181, 190, 0.2)" : "rgba(24, 72, 204, 0.2)",
    swingBearOb: mono ? "rgba(93, 96, 107, 0.2)" : "rgba(178, 40, 51, 0.2)",
    fvgBull: mono ? "rgba(178, 181, 190, 0.3)" : "rgba(0, 255, 104, 0.22)",
    fvgBear: mono ? "rgba(93, 96, 107, 0.3)" : "rgba(255, 0, 8, 0.22)",
    premium: mono ? MONO_BEAR : RED,
    discount: mono ? MONO_BULL : GREEN,
    level: BLUE,
    gray: GRAY,
  };
}

const withAlpha = (hex, alpha) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};

const passes = (filter, tag) => filter === "all" || filter === tag;

/** Zones, lines and labels for the chart, from a luxSmc result and the candles it was computed on. */
export function buildLuxOverlays(lux, candles, s) {
  const zones = [];
  const lines = [];
  const labels = [];
  if (!lux || candles.length < 3) return { zones, lines, labels };
  const c = palette(s.style);
  const time = (i) => candles[Math.min(candles.length - 1, Math.max(0, i))].time;
  const present = s.mode === "present";

  // ---- market structure (BOS / CHoCH) ----
  const structure = (scope, enabled, bullFilter, bearFilter, limit, dash, fontSize) => {
    if (!enabled) return;
    const items = lux.structures
      .filter((x) => x.scope === scope && passes(x.dir === "bull" ? bullFilter : bearFilter, x.tag))
      .slice(present ? -1 : -limit);
    for (const x of items) {
      lines.push({
        price: x.level, time: time(x.fromIndex), endTime: time(x.toIndex),
        color: x.dir === "bull" ? c.bull : c.bear, dash, width: 1,
        label: x.tag, labelAt: "mid", labelSide: x.dir === "bull" ? "above" : "below", fontSize,
      });
    }
  };
  structure("internal", s.showInternal, s.internalBull, s.internalBear, 40, [5, 4], 9);
  structure("swing", s.showSwing, s.swingBull, s.swingBear, 20, [], 11);

  // ---- order blocks (only the ones not yet mitigated) ----
  const blocks = (scope, enabled, count) => {
    if (!enabled) return;
    for (const b of activeLuxOrderBlocks(lux, scope).slice(0, count)) {
      const internal = scope === "internal";
      const fill = b.bias === "bull" ? (internal ? c.internalBullOb : c.swingBullOb) : (internal ? c.internalBearOb : c.swingBearOb);
      zones.push({ top: b.top, bottom: b.bottom, time: b.time, fill, border: internal ? null : fill.replace(/[\d.]+\)$/, "0.9)") });
    }
  };
  blocks("internal", s.internalOrderBlocks, s.internalOrderBlocksCount);
  blocks("swing", s.swingOrderBlocks, s.swingOrderBlocksCount);

  // ---- equal highs / lows ----
  if (s.showEqual) {
    for (const type of ["EQH", "EQL"]) {
      const items = lux.equalLevels.filter((e) => e.type === type).slice(present ? -1 : -10);
      for (const e of items) {
        lines.push({
          price: (e.level + e.firstLevel) / 2, time: time(e.fromIndex), endTime: time(e.toIndex),
          color: type === "EQH" ? c.bear : c.bull, dash: [2, 3], width: 1.2,
          label: type, labelAt: "mid", labelSide: type === "EQH" ? "above" : "below", fontSize: 9,
        });
      }
    }
  }

  // ---- fair value gaps: two boxes per gap (split at the midpoint), drawn over the gap's own candles ----
  if (s.showFvg) {
    for (const g of activeLuxFvgs(lux).slice(0, 20)) {
      const fill = g.bias === "bull" ? c.fvgBull : c.fvgBear;
      const mid = (g.top + g.bottom) / 2;
      const end = time(g.formedAt + 1);
      zones.push({ top: g.top, bottom: mid, time: time(g.fromIndex), endTime: end, fill, border: null });
      zones.push({ top: mid, bottom: g.bottom, time: time(g.fromIndex), endTime: end, fill, border: null });
    }
  }

  // ---- premium / equilibrium / discount zones and strong / weak highs and lows ----
  const t = lux.trailing;
  if (t) {
    if (s.showZones) {
      const start = time(t.index);
      zones.push({ top: t.top, bottom: 0.95 * t.top + 0.05 * t.bottom, time: start, fill: withAlpha(c.premium, 0.2), border: null, label: "Premium", textColor: c.premium });
      zones.push({ top: 0.525 * t.top + 0.475 * t.bottom, bottom: 0.525 * t.bottom + 0.475 * t.top, time: start, fill: withAlpha(c.gray, 0.2), border: null, label: "Equilibrium", textColor: c.gray });
      zones.push({ top: 0.95 * t.bottom + 0.05 * t.top, bottom: t.bottom, time: start, fill: withAlpha(c.discount, 0.2), border: null, label: "Discount", textColor: c.discount });
    }
    if (s.showStrongWeak) {
      lines.push({ price: t.top, time: time(t.topIndex), color: c.bear, dash: [], width: 1, label: t.swingBias === -1 ? "Strong High" : "Weak High", labelAt: "end", fontSize: 10 });
      lines.push({ price: t.bottom, time: time(t.bottomIndex), color: c.bull, dash: [], width: 1, label: t.swingBias === 1 ? "Strong Low" : "Weak Low", labelAt: "end", labelSide: "below", fontSize: 10 });
    }
  }

  // ---- previous day / week / month highs and lows ----
  const wanted = { D: s.levelsD, W: s.levelsW, M: s.levelsM };
  for (const level of lux.levels) {
    if (!wanted[level.id]) continue;
    lines.push({ price: level.high, time: time(level.highIndex), color: c.level, dash: [], width: 1, label: `P${level.id}H`, labelAt: "end", fontSize: 10 });
    lines.push({ price: level.low, time: time(level.lowIndex), color: c.level, dash: [], width: 1, label: `P${level.id}L`, labelAt: "end", labelSide: "below", fontSize: 10 });
  }

  // ---- swing point labels ----
  if (s.showSwingPoints) {
    for (const p of lux.swingPoints.slice(-30)) {
      labels.push({ time: time(p.index), price: p.price, text: p.label, color: p.type === "high" ? c.bear : c.bull, side: p.type === "high" ? "above" : "below", size: 10 });
    }
  }
  return { zones, lines, labels };
}

/** Candle colour per timestamp: green while the internal trend is bullish, red otherwise (the indicator's "Color Candles"). */
export function luxCandleColors(lux, candles, style) {
  const c = palette(style);
  const map = new Map();
  candles.forEach((candle, i) => map.set(candle.time, lux.internalBias[i] === 1 ? c.bull : c.bear));
  return map;
}
