/**
 * AMD: sweep of a range, then a fair value gap. See shared/analysis/amd.js for the four stages.
 * Bullish and bearish setups both give signals (a bearish one is a short on futures).
 */
import { AMD_DEFAULTS, findAmd } from "../analysis/amd.js";

export const amdStrategy = {
  id: "amd_fvg",
  name: "AMD: sweep then fair value gap",
  summary: "Accumulation range, a wick sweeps one side, a strong candle leaves a fair value gap: that gap is the signal.",
  description:
    "Waits for the full sequence: a tight accumulation range, a manipulation wick that sweeps one side and comes back, then a strong candle that leaves a fair value gap. The signal is the close of that gap. The stop goes beyond the sweep and the target is the far side of the range. Bullish setups buy; bearish ones sell short (futures).",
  directions: ["long", "short"],
  supportsRetest: true, // it can wait for price to come back into the gap
  params: [
    { key: "minRangeBars", label: "Min range candles", type: "number", default: AMD_DEFAULTS.minRangeBars, min: 4, max: 40, step: 1, integer: true, hint: "How long the accumulation must last" },
    { key: "maxRangeAtr", label: "Max range height (ATR)", type: "number", default: AMD_DEFAULTS.maxRangeAtr, min: 1.5, max: 6, step: 0.5, hint: "Taller ranges are not accumulation" },
    { key: "minRangeAtr", label: "Min range height (ATR)", type: "number", default: AMD_DEFAULTS.minRangeAtr, min: 0, max: 3, step: 0.25, hint: "A flatter range is dead, not accumulating" },
    { key: "minSweepAtr", label: "Min sweep beyond the edge (ATR)", type: "number", default: AMD_DEFAULTS.minSweepAtr, min: 0, max: 1, step: 0.05, hint: "The wick must clearly take the edge" },
    { key: "maxSweepAtr", label: "Max sweep beyond the edge (ATR)", type: "number", default: AMD_DEFAULTS.maxSweepAtr, min: 0.5, max: 3, step: 0.1, hint: "Further than this is a real breakout, not a sweep" },
    { key: "maxFvgBars", label: "Gap within (candles of the sweep)", type: "number", default: AMD_DEFAULTS.maxFvgBars, min: 2, max: 20, step: 1, integer: true },
    { key: "minFvgAtr", label: "Min gap size (ATR)", type: "number", default: AMD_DEFAULTS.minFvgAtr, min: 0, max: 1, step: 0.05 },
    { key: "minBodyAtr", label: "Min body of the gap candle (ATR)", type: "number", default: AMD_DEFAULTS.minBodyAtr, min: 0, max: 2, step: 0.1 },
  ],
  detect(candles, params) {
    // reward:risk is judged by the trade layer on the ACTUAL entry, so the engine lets every setup through
    const setups = findAmd(candles, null, { ...params, minRewardRisk: 0 });
    return setups.map((s) => {
      const bull = s.dir === "bull";
      return {
        dir: s.dir,
        formedAt: s.formedAt,
        entry: s.plan.entry,
        stop: s.plan.stopLoss,
        target: s.plan.target,
        retest: bull ? s.fvg.top : s.fvg.bottom,
        status: s.status,
        reasons: [
          `Accumulation range of ${s.range.endIndex - s.range.startIndex + 1} candles`,
          bull ? "Manipulation: the range low was swept and reclaimed" : "Manipulation: the range high was swept and rejected",
          `${bull ? "Bullish" : "Bearish"} fair value gap formed`,
        ],
      };
    });
  },
};
