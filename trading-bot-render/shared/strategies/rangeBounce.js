/**
 * Support and resistance bounce: marks a recent trading range and gives a literal "buy here, sell here" signal —
 * long when price dips to the support of the range and closes back above it, short (futures) when price pushes into
 * the resistance and closes back below it. The stop goes just beyond the level that was touched; the target is the
 * opposite side of the range.
 */
import { atr } from "../analysis/indicators.js";

const spec = (key, label, def, min, max, step, hint) => ({ key, label, type: "number", default: def, min, max, step, integer: Number.isInteger(step) && Number.isInteger(def), ...(hint ? { hint } : {}) });

/** The support (low) and resistance (high) of the `lookback` candles BEFORE candle i (never including i itself). */
function rangeBefore(candles, i, lookback) {
  const start = Math.max(0, i - lookback);
  let high = -Infinity;
  let low = Infinity;
  for (let j = start; j < i; j++) {
    high = Math.max(high, candles[j].high);
    low = Math.min(low, candles[j].low);
  }
  return { high, low, bars: i - start };
}

export const rangeBounceStrategy = {
  id: "range_bounce",
  name: "Support & resistance bounce",
  summary: "Marks the floor and ceiling of the recent range: buy at the floor, sell (short) at the ceiling.",
  description:
    "Draws the support and resistance of the last N candles. Buys when price dips into support and closes back above it (stop just below support, target the resistance); shorts the mirror at resistance (stop just above, target the support). A range that is too tight or too wide is skipped, since it is then not a clean floor and ceiling to trade.",
  directions: ["long", "short"],
  supportsRetest: true, // the level itself is a better (and tighter) entry than the close that confirmed the bounce
  params: [
    spec("lookback", "Range length (candles)", 20, 8, 100, 1, "How far back the support/resistance is measured, up to but not including the signal candle"),
    spec("touchAtr", "Touch tolerance (ATR)", 0.3, 0, 1.5, 0.05, "How close the wick must get to the level to count as touching it"),
    spec("stopAtr", "Stop beyond the level (ATR)", 0.4, 0.1, 2, 0.1),
    spec("minRangeAtr", "Min range height (ATR)", 3, 1, 10, 0.5, "A tighter range is noise, not a tradable floor and ceiling"),
    spec("maxRangeAtr", "Max range height (ATR)", 15, 3, 40, 1, "A wider range is too big to trade edge to edge"),
  ],
  detect(candles, params) {
    const p = params;
    const range = atr(candles, 14);
    const out = [];
    for (let i = p.lookback; i < candles.length; i++) {
      const a = range[i];
      if (!(a > 0)) continue;
      const { high, low, bars } = rangeBefore(candles, i, p.lookback);
      if (bars < p.lookback || !Number.isFinite(high) || !Number.isFinite(low)) continue;
      const height = (high - low) / a;
      if (height < p.minRangeAtr || height > p.maxRangeAtr) continue;
      const c = candles[i];

      // long: the wick dipped to (or through) support, the close reclaimed it, and the candle is green
      if (c.low <= low + p.touchAtr * a && c.close > low && c.close > c.open) {
        const entry = c.close;
        const stop = low - p.stopAtr * a;
        const target = high - p.touchAtr * a;
        if (target > entry && stop < entry && low > stop) {
          out.push({
            dir: "bull", formedAt: i, entry, stop, target, retest: low,
            reasons: [`Price dipped into the support of a ${p.lookback}-candle range and closed back above it`, "Green candle confirms the bounce"],
          });
          continue;
        }
      }
      // short: the wick pushed to (or through) resistance, the close was rejected back under it, red candle
      if (c.high >= high - p.touchAtr * a && c.close < high && c.close < c.open) {
        const entry = c.close;
        const stop = high + p.stopAtr * a;
        const target = low + p.touchAtr * a;
        if (target < entry && stop > entry && high < stop) {
          out.push({
            dir: "bear", formedAt: i, entry, stop, target, retest: high,
            reasons: [`Price pushed into the resistance of a ${p.lookback}-candle range and closed back below it`, "Red candle confirms the rejection"],
          });
        }
      }
    }
    return out;
  },
};
