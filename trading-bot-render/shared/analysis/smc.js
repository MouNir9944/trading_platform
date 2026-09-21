/**
 * "Smart money" price-action concepts, computed without look-ahead:
 *
 *  - Fair value gap (FVG): a three-candle imbalance. Bullish when candle 3's low is above candle 1's high
 *    (the market moved up so fast it left a gap); bearish is the mirror. Price often returns to fill it.
 *  - Order block (OB): the last opposite-colour candle before the move that broke market structure. A bullish OB
 *    is the last down candle before an up-move that broke a swing high; it is a zone where buyers stepped in.
 *  - Liquidity: equal highs / equal lows (stops cluster above and below them) and sweeps, where price wicks past
 *    the level and closes back inside (a "liquidity grab").
 *  - Premium / discount: whether price sits in the upper or lower half of the current swing range.
 *
 * Every zone records when it became KNOWABLE (`formedAt`) and when it was touched/filled/invalidated, so a strategy
 * standing at candle i can ask for exactly what was visible at i (see activeFvgs / activeOrderBlocks).
 */
import { swingsUpTo } from "./structure.js";

const tolerance = (price, atr) => Math.max((atr ?? 0) * 0.2, price * 0.0003);

/** Fair value gaps. A gap must be at least 0.15 ATR (and 0.02% of price) tall to count: smaller ones are noise. */
export function findFvgs(candles, atrSeries, { minAtr = 0.15 } = {}) {
  const gaps = [];
  for (let i = 2; i < candles.length; i++) {
    const first = candles[i - 2];
    const last = candles[i];
    const atr = atrSeries[i] ?? atrSeries[i - 1] ?? last.close * 0.005;
    const minGap = Math.max(atr * minAtr, last.close * 0.0002);

    let type = null;
    let bottom;
    let top;
    if (last.low - first.high > minGap) { type = "bull"; bottom = first.high; top = last.low; }
    else if (first.low - last.high > minGap) { type = "bear"; bottom = last.high; top = first.low; }
    if (!type) continue;

    const gap = { type, top, bottom, size: top - bottom, index: i - 1, time: candles[i - 1].time, formedAt: i, touchedAt: null, filledAt: null, fillPct: 0 };
    let extreme = type === "bull" ? Infinity : -Infinity;
    for (let j = i + 1; j < candles.length; j++) {
      const k = candles[j];
      if (type === "bull") {
        if (k.low <= top && gap.touchedAt == null) gap.touchedAt = j;
        extreme = Math.min(extreme, k.low);
        if (k.low <= bottom) { gap.filledAt = j; break; }
      } else {
        if (k.high >= bottom && gap.touchedAt == null) gap.touchedAt = j;
        extreme = Math.max(extreme, k.high);
        if (k.high >= top) { gap.filledAt = j; break; }
      }
    }
    if (gap.filledAt != null) gap.fillPct = 1;
    else if (gap.touchedAt != null) gap.fillPct = Math.min(1, Math.max(0, (type === "bull" ? top - extreme : extreme - bottom) / gap.size));
    gaps.push(gap);
  }
  return gaps;
}

/** Order blocks, one per structure break: the last opposite candle at the start of the impulse that caused it. */
export function findOrderBlocks(candles, structure) {
  const blocks = [];
  const seen = new Set();
  for (const brk of structure.breaks) {
    const bull = brk.direction === "bull";
    // The impulse starts at the extreme between the broken swing and the break candle.
    let origin = -1;
    let best = bull ? Infinity : -Infinity;
    for (let j = brk.swingIndex; j <= brk.index; j++) {
      const v = bull ? candles[j].low : candles[j].high;
      if (bull ? v < best : v > best) { best = v; origin = j; }
    }
    if (origin < 0) continue;
    let ob = -1;
    for (let j = origin; j >= Math.max(0, origin - 5); j--) {
      if (bull ? candles[j].close < candles[j].open : candles[j].close > candles[j].open) { ob = j; break; }
    }
    const key = `${bull}:${ob}`;
    if (ob < 0 || seen.has(key)) continue;
    seen.add(key);

    const block = {
      type: bull ? "bull" : "bear",
      top: candles[ob].high, bottom: candles[ob].low, index: ob, time: candles[ob].time,
      formedAt: brk.index, breakType: brk.type, touchedAt: null, mitigatedAt: null,
    };
    for (let j = brk.index + 1; j < candles.length; j++) {
      const k = candles[j];
      if (bull) {
        if (k.low <= block.top && block.touchedAt == null) block.touchedAt = j;
        if (k.close < block.bottom) { block.mitigatedAt = j; break; }
      } else {
        if (k.high >= block.bottom && block.touchedAt == null) block.touchedAt = j;
        if (k.close > block.top) { block.mitigatedAt = j; break; }
      }
    }
    blocks.push(block);
  }
  return blocks;
}

/**
 * Equal highs / equal lows (two or more swing points at nearly the same price) and what happened to them:
 * `sweptAt` = a wick took the level out but the candle closed back inside (a liquidity grab);
 * `brokenAt` = a candle closed beyond it (a real break).
 */
export function findLiquidity(candles, structure, atrSeries) {
  const pools = [];
  for (const p of structure.pivots) {
    const tol = tolerance(p.price, atrSeries[p.confirmedAt]);
    const pool = pools.find((q) => q.type === p.type && Math.abs(q.price - p.price) <= tol && p.index - q.lastIndex <= 150);
    if (pool) {
      pool.touches += 1;
      pool.lastIndex = p.index;
      pool.price = p.type === "high" ? Math.max(pool.price, p.price) : Math.min(pool.price, p.price);
      if (pool.touches === 2) pool.formedAt = p.confirmedAt;
    } else {
      pools.push({ type: p.type, price: p.price, touches: 1, firstIndex: p.index, lastIndex: p.index, time: p.time, formedAt: null, sweptAt: null, brokenAt: null });
    }
  }
  const equal = pools.filter((q) => q.touches >= 2);
  for (const pool of equal) {
    for (let j = pool.formedAt + 1; j < candles.length; j++) {
      const k = candles[j];
      if (pool.type === "high" && k.high > pool.price) {
        if (k.close < pool.price) pool.sweptAt = j; else pool.brokenAt = j;
        break;
      }
      if (pool.type === "low" && k.low < pool.price) {
        if (k.close > pool.price) pool.sweptAt = j; else pool.brokenAt = j;
        break;
      }
    }
  }
  return equal;
}

/**
 * Where `price` sits in the current dealing range: the latest swing high to the latest swing low. If price has
 * broken out of that range the range stretches to include it, so the position always stays between 0 and 1
 * (a breakout above is the extreme premium, below is the extreme discount).
 */
export function premiumDiscount(swings, price) {
  const high = [...swings].reverse().find((s) => s.type === "high");
  const low = [...swings].reverse().find((s) => s.type === "low");
  if (!high || !low || high.price <= low.price) return null;
  const top = Math.max(high.price, price);
  const bottom = Math.min(low.price, price);
  const position = (price - bottom) / (top - bottom);
  return {
    high: top, low: bottom, highTime: high.time, lowTime: low.time,
    equilibrium: (top + bottom) / 2,
    position,
    brokeOut: price > high.price ? "above" : price < low.price ? "below" : null,
    zone: position > 0.55 ? "premium" : position < 0.45 ? "discount" : "equilibrium",
  };
}

export function analyzeSmc(candles, structure, atrSeries) {
  const last = candles[candles.length - 1];
  return {
    fvgs: findFvgs(candles, atrSeries),
    orderBlocks: findOrderBlocks(candles, structure),
    liquidity: findLiquidity(candles, structure, atrSeries),
    premiumDiscount: last ? premiumDiscount(structure.swings, last.close) : null,
  };
}

/** Gaps that were open (not fully filled) as of candle i, and already formed by then. */
export const activeFvgs = (smc, i) => smc.fvgs.filter((g) => g.formedAt <= i && (g.filledAt == null || g.filledAt > i));

/** Order blocks that existed and were not yet mitigated as of candle i. */
export const activeOrderBlocks = (smc, i) => smc.orderBlocks.filter((b) => b.formedAt <= i && (b.mitigatedAt == null || b.mitigatedAt > i));

/** The premium/discount reading using only swings confirmed by candle i. */
export const premiumDiscountAt = (structure, i, price) => premiumDiscount(swingsUpTo(structure.pivots, i), price);
