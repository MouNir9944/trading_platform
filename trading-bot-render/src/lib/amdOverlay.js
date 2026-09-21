/**
 * Turns AMD setups (shared/analysis/amd.js) into chart zones, lines and labels, and a one-line summary.
 * Only setups whose four stages happened in order ever reach this point: the engine does not report anything else.
 */
import { AMD_DEFAULTS, amdStages } from "../../shared/analysis/amd.js";

export const AMD_SETTINGS_DEFAULTS = Object.freeze({
  enabled: false,
  direction: "both", // "both" | "bull" | "bear"
  show: "all", // "all" (every signalled setup) | "completed" (only those that reached distribution)
  showFailed: false,
  showPlan: true, // entry / stop-loss / target lines of the newest live setup
  maxSetups: 4,
  // engine
  minRangeBars: AMD_DEFAULTS.minRangeBars,
  maxRangeAtr: AMD_DEFAULTS.maxRangeAtr,
  minRewardRisk: AMD_DEFAULTS.minRewardRisk,
});

export const amdEngineOptions = (s) => ({ minRangeBars: s.minRangeBars, maxRangeAtr: s.maxRangeAtr, minRewardRisk: s.minRewardRisk });

const COLORS = {
  accumulation: { fill: "rgba(120, 138, 170, 0.16)", border: "rgba(150, 168, 200, 0.7)", text: "#a9b8d6" },
  manipulation: "#f0a94a",
  bull: { fill: "rgba(38, 194, 129, 0.24)", border: "rgba(38, 194, 129, 0.9)", text: "#5fdba5" },
  bear: { fill: "rgba(240, 84, 84, 0.24)", border: "rgba(240, 84, 84, 0.9)", text: "#f58a8a" },
  distribution: { fill: "rgba(171, 120, 240, 0.10)", text: "#c7a3f7" },
  failed: "#8b93a4",
  stop: "rgba(240, 84, 84, 0.85)",
  target: "#b58cf5",
};

/** Setups that pass the user's filters, newest last. */
export function visibleAmdSetups(setups, s) {
  return setups
    .filter((x) => (s.direction === "both" || x.dir === s.direction))
    .filter((x) => (x.status === "failed" ? s.showFailed && s.show !== "completed" : s.show === "completed" ? x.status === "distributed" : true))
    .slice(-s.maxSetups);
}

/** Zones, lines and labels for the chart. */
export function buildAmdOverlays(setups, candles, s) {
  const zones = [];
  const lines = [];
  const labels = [];
  if (!setups?.length || !candles?.length) return { zones, lines, labels };
  const time = (i) => candles[Math.min(candles.length - 1, Math.max(0, i))].time;
  const lastIndex = candles.length - 1;
  const shown = visibleAmdSetups(setups, s);
  const newestLive = [...shown].reverse().find((x) => x.status === "active");

  for (const x of shown) {
    const bull = x.dir === "bull";
    const c = bull ? COLORS.bull : COLORS.bear;
    const failed = x.status === "failed";
    const distributed = x.status === "distributed";
    const endIndex = x.distribution.endedAt ?? lastIndex;

    // 1. accumulation: the range, up to the candle that broke it
    zones.push({
      top: x.range.high, bottom: x.range.low, time: time(x.range.startIndex), endTime: time(x.manipulation.breachIndex),
      fill: COLORS.accumulation.fill, border: COLORS.accumulation.border, label: "A · Accumulation", textColor: COLORS.accumulation.text,
    });

    // 2. manipulation: the swept edge, carried on to the gap, and a marker at the extreme of the wick
    const edge = bull ? x.range.low : x.range.high;
    lines.push({
      price: edge, time: time(x.manipulation.breachIndex), endTime: time(x.formedAt),
      color: COLORS.manipulation, dash: [3, 3], width: 1, label: "M · Sweep", labelAt: "start", labelSide: bull ? "below" : "above", fontSize: 10,
    });
    labels.push({ time: time(x.manipulation.index), price: x.manipulation.extreme, text: "M", color: COLORS.manipulation, side: bull ? "below" : "above", size: 11 });

    // 3. the fair value gap, the signal
    zones.push({
      top: x.fvg.top, bottom: x.fvg.bottom, time: time(x.fvg.fromIndex), endTime: time(Math.max(endIndex, x.formedAt) + 1),
      fill: failed ? "rgba(139, 147, 164, 0.18)" : c.fill, border: failed ? COLORS.failed : c.border,
      label: `F · FVG ${bull ? "▲" : "▼"}`, textColor: failed ? COLORS.failed : c.text,
    });

    // 4. distribution: from the gap to the far side of the range
    const target = x.plan.target;
    if (!failed) {
      zones.push({
        top: Math.max(target, x.plan.entry), bottom: Math.min(target, x.plan.entry), time: time(x.formedAt), endTime: time(endIndex + 1),
        fill: COLORS.distribution.fill, border: null, label: distributed ? "D · Distribution ✓" : `D · Distribution ${Math.round(x.distribution.progress * 100)}%`, textColor: COLORS.distribution.text,
      });
    }
    lines.push({
      price: target, time: time(x.formedAt), endTime: time(endIndex),
      color: failed ? COLORS.failed : COLORS.target, dash: distributed ? [] : [5, 4], width: 1, label: failed ? "✗ failed" : distributed ? "target hit" : "target", labelAt: "end", labelSide: bull ? "above" : "below", fontSize: 10,
    });
  }

  if (s.showPlan && newestLive) {
    const x = newestLive;
    lines.push({ price: x.plan.stopLoss, time: time(x.formedAt), color: COLORS.stop, dash: [4, 3], width: 1, label: "stop", labelAt: "end", labelSide: x.dir === "bull" ? "below" : "above", fontSize: 10 });
    lines.push({ price: x.plan.entry, time: time(x.formedAt), color: "rgba(200, 208, 224, 0.7)", dash: [2, 3], width: 1, label: "entry", labelAt: "end", labelSide: x.dir === "bull" ? "above" : "below", fontSize: 10 });
  }
  return { zones, lines, labels };
}

/** The newest visible setup as text and stage states, for the chart's status strip. */
export function amdSummary(setups, candles, s) {
  const shown = visibleAmdSetups(setups ?? [], s);
  const latest = shown[shown.length - 1];
  if (!latest || !candles?.length) return null;
  const stages = amdStages(latest);
  return {
    dir: latest.dir,
    status: latest.status,
    formedTime: candles[latest.formedAt].time,
    stages: stages.map((st) => ({ key: st.key, label: st.label, state: st.state })),
    progress: latest.distribution.progress,
    riskReward: latest.plan.riskReward,
    candlesAgo: candles.length - 1 - latest.formedAt,
    total: shown.length,
  };
}
