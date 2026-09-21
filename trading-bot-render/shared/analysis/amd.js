/**
 * AMD: Accumulation -> Manipulation -> fair value gap -> Distribution.
 *
 * A setup is only reported when the four stages happen in this order, and the fair value gap is the signal:
 *
 *  1. Accumulation  a tight, sideways range (at least `minRangeBars` candles, no taller than `maxRangeAtr` x ATR).
 *  2. Manipulation  price breaks one side of that range with a wick that is not a real breakout (at most
 *                   `maxSweepAtr` x ATR beyond the edge): the liquidity grab that traps traders on the wrong side.
 *  3. FVG           within `maxFvgBars` candles a strong candle in the OPPOSITE direction leaves a three-candle gap
 *                   (fair value gap) and closes back inside the range. The setup is *signalled* on the close of the
 *                   third candle of that gap. Nothing is shown before this moment.
 *  4. Distribution  price travels through the range to its far side (the target). The setup is then "distributed";
 *                   if a candle closes beyond the manipulation extreme first, it has "failed".
 *
 * A bullish setup sweeps the range low and distributes upward; a bearish one sweeps the range high and distributes
 * downward. Bearish setups are handled by mirroring the prices, so both directions share one code path.
 *
 * No look-ahead: every decision about stages 1-3 uses candles up to and including the FVG's third candle (`formedAt`).
 * Stage 4 (`status`, `endedAt`, ...) is filled in from the candles that follow and is only for display; strategies
 * must only use setups whose `formedAt` is the candle they are looking at.
 */
import { atr as atrSeriesOf } from "./indicators.js";

export const AMD_DEFAULTS = Object.freeze({
  minRangeBars: 10,
  maxRangeBars: 40,
  maxRangeAtr: 3.5, // accumulation range height limit, in ATRs
  minRangeAtr: 1, // ...and a range flatter than this is dead, not accumulating
  minSweepAtr: 0.1, // the wick must clearly take the edge, not just tick it
  maxSweepAtr: 1.5, // how far past the range edge the manipulation may go before it counts as a real breakout
  maxFvgBars: 8, // candles allowed between the sweep and the gap
  minFvgAtr: 0.1, // smallest gap, in ATRs
  minBodyAtr: 0.5, // the candle that makes the gap must have a body of at least this many ATRs
  minRewardRisk: 1, // the far side of the range must still be at least this many R away when the gap forms
});

const mirror = (c) => ({ ...c, open: -c.open, close: -c.close, high: -c.low, low: -c.high });

/**
 * Find every AMD setup in the candles (oldest first). `atrSeries` is optional (computed if omitted).
 * Setups are returned in the order their gap formed.
 */
export function findAmd(candles, atrSeries = null, options = {}) {
  const o = { ...AMD_DEFAULTS, ...options };
  const n = candles.length;
  const atr = atrSeries ?? atrSeriesOf(candles, 14);
  const found = [];
  for (const dir of ["bull", "bear"]) {
    const sign = dir === "bull" ? 1 : -1;
    const v = dir === "bull" ? candles : candles.map(mirror);
    let blockedUntil = -1;
    for (let j = o.minRangeBars; j < n; j++) {
      const a = atr[j - 1];
      if (j <= blockedUntil || a == null || !(a > 0)) continue;

      // Candidate accumulation ranges ending on candle j-1, longest first.
      const windows = [];
      let hi = -Infinity;
      let lo = Infinity;
      for (let k = j - 1; k >= Math.max(0, j - o.maxRangeBars); k--) {
        hi = Math.max(hi, v[k].high);
        lo = Math.min(lo, v[k].low);
        if (hi - lo > o.maxRangeAtr * a) break;
        if (j - k >= o.minRangeBars && hi - lo >= o.minRangeAtr * a) windows.push({ start: k, hi, lo });
      }
      // Candle j must be the first to break this range, downward only (in mirrored terms).
      const range = windows.reverse().find((w) => v[j].low < w.lo - o.minSweepAtr * a && v[j].high <= w.hi);
      if (!range) continue;

      const setup = scan(v, atr, j, range, o);
      if (!setup) continue;
      blockedUntil = setup.formedAt;
      found.push(finish(setup, candles, v, sign, dir));
    }
  }
  return found.sort((x, y) => x.formedAt - y.formedAt || (x.dir === "bull" ? -1 : 1));
}

const rewardRisk = (target, entry, stop) => (entry > stop ? (target - entry) / (entry - stop) : -Infinity);

/** Stages 2 and 3 in bullish (mirrored when needed) terms: from the breach candle, wait for the gap. */
function scan(v, atr, j, range, o) {
  const n = v.length;
  const a = atr[j - 1];
  let extreme = v[j].low;
  let extremeIndex = j;
  for (let t = j; t < n && t <= j + o.maxFvgBars; t++) {
    if (v[t].low < extreme) {
      extreme = v[t].low;
      extremeIndex = t;
    }
    if (extreme < range.lo - o.maxSweepAtr * a) return null; // a real breakout, not a sweep
    if (t - 2 >= extremeIndex) {
      const first = v[t - 2];
      const middle = v[t - 1];
      const last = v[t];
      const gap = last.low - first.high;
      const unit = atr[t - 1] ?? a;
      if (
        gap > 0 && gap >= o.minFvgAtr * unit &&
        middle.close - middle.open >= o.minBodyAtr * unit &&
        middle.close >= range.lo && last.close >= range.lo &&
        (o.minRewardRisk <= 0 || rewardRisk(range.hi, last.close, extreme - 0.25 * unit) >= o.minRewardRisk)
      ) {
        return { range, breachIndex: j, extreme, extremeIndex, formedAt: t, gapBottom: first.high, gapTop: last.low, gapFrom: t - 2, atrAtFormation: unit };
      }
    }
    if (v[t].close > range.hi) return null; // it left the range without leaving a gap: not this pattern
  }
  return null;
}

/** Stage 4 and the trade plan, then convert back to real prices. */
function finish(s, candles, v, sign, dir) {
  const n = v.length;
  const entry = v[s.formedAt].close;
  const target = s.range.hi;
  const stop = s.extreme - 0.25 * s.atrAtFormation;
  let status = "active";
  let endedAt = null;
  let retestedAt = null;
  let peak = entry;
  if (v[s.formedAt].high >= target) {
    // The gap candle itself already reached the far side of the range: distribution is under way.
    status = "distributed";
    endedAt = s.formedAt;
  }
  for (let u = s.formedAt + 1; status === "active" && u < n; u++) {
    if (v[u].close < s.extreme) { status = "failed"; endedAt = u; break; }
    if (retestedAt == null && v[u].low <= s.gapTop) retestedAt = u;
    peak = Math.max(peak, v[u].high);
    if (v[u].high >= target) { status = "distributed"; endedAt = u; break; }
  }
  const risk = entry - stop;
  const real = (p) => sign * p;
  const pair = (x, y) => (sign === 1 ? { top: y, bottom: x } : { top: real(x), bottom: real(y) });
  const gap = pair(s.gapBottom, s.gapTop);
  const rangeEdges = pair(s.range.lo, s.range.hi);
  return {
    id: `${dir}:${s.formedAt}`,
    dir,
    formedAt: s.formedAt,
    range: { startIndex: s.range.start, endIndex: s.breachIndex - 1, high: rangeEdges.top, low: rangeEdges.bottom },
    manipulation: { breachIndex: s.breachIndex, index: s.extremeIndex, extreme: real(s.extreme) },
    fvg: { top: gap.top, bottom: gap.bottom, fromIndex: s.gapFrom, formedAt: s.formedAt },
    distribution: { status, endedAt, retestedAt, progress: target > entry ? Math.max(0, Math.min(1, (peak - entry) / (target - entry))) : 1 },
    status,
    plan: {
      entry: real(entry),
      stopLoss: real(stop),
      target: real(target),
      riskReward: risk > 0 ? (target - entry) / risk : null,
    },
  };
}

/** The four stages of a setup as an ordered list, for display: what happened, and where. */
export function amdStages(setup) {
  const d = setup.distribution;
  return [
    { key: "accumulation", label: "Accumulation", state: "done", from: setup.range.startIndex, to: setup.range.endIndex },
    { key: "manipulation", label: "Manipulation", state: "done", from: setup.manipulation.breachIndex, to: setup.manipulation.index },
    { key: "fvg", label: "FVG", state: "done", from: setup.fvg.fromIndex, to: setup.fvg.formedAt },
    {
      key: "distribution",
      label: "Distribution",
      state: d.status === "distributed" ? "done" : d.status === "failed" ? "failed" : "waiting",
      from: setup.formedAt,
      to: d.endedAt,
    },
  ];
}
