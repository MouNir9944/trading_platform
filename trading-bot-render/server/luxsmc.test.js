import assert from "node:assert/strict";
import test from "node:test";

import { activeLuxFvgs, activeLuxOrderBlocks, analyzeLux, previousPeriodLevels } from "../shared/analysis/luxSmc.js";

const small = { swingLength: 3, internalLength: 2, equalLength: 2 };

function fromCloses(closes, wick = 0.05, t0 = 1_700_000_000, step = 300) {
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    return { time: t0 + i * step, open, high: Math.max(open, close) + wick, low: Math.min(open, close) - wick, close, volume: 100 };
  });
}

function zigzag(points, leg = 6) {
  const out = [points[0]];
  for (let p = 1; p < points.length; p++) for (let k = 1; k <= leg; k++) out.push(points[p - 1] + ((points[p] - points[p - 1]) * k) / leg);
  return out;
}

const candle = (time, open, high, low, close) => ({ time, open, high, low, close, volume: 1 });

test("swing pivots are confirmed exactly `size` bars later, with HH/LH/HL/LL labels", () => {
  const candles = fromCloses(zigzag([10, 20, 12, 26, 15, 30]));
  const r = analyzeLux(candles, small);
  const highs = r.swingPoints.filter((p) => p.type === "high");
  const lows = r.swingPoints.filter((p) => p.type === "low");
  assert.deepEqual(highs.map((p) => Math.round(p.price)), [20, 26]); // the third peak is too recent to be confirmed
  // like the original, the very first leg counts: a rising start makes candle 0 the first swing low
  assert.deepEqual(lows.map((p) => Math.round(p.price)), [10, 12, 15]);
  for (const p of r.swingPoints) assert.equal(p.formedAt, p.index + 3, "known only after `size` more bars");
  assert.deepEqual(highs.map((p) => p.label), ["LH", "HH"]); // first pivot has no predecessor: compared with nothing -> "LH"
  assert.deepEqual(lows.map((p) => p.label), ["HL", "HL", "HL"]);
});

test("structure: first break is a BOS, a break against the trend is a CHoCH; each pivot breaks only once", () => {
  const candles = fromCloses(zigzag([30, 25, 28, 20, 24, 15, 19, 12, 26, 20, 34]));
  const r = analyzeLux(candles, { ...small, internalOrderBlocks: false, swingOrderBlocks: false });
  const swing = r.structures.filter((s) => s.scope === "swing");
  assert.ok(swing.length >= 3, `expected several swing breaks, got ${swing.length}`);
  assert.deepEqual([swing[0].dir, swing[0].tag], ["bear", "BOS"]);
  const firstBull = swing.find((s) => s.dir === "bull");
  assert.equal(firstBull.tag, "CHoCH", "a bullish break while the trend is bearish reverses it");
  assert.ok(swing.find((s) => s.dir === "bull" && s.tag === "BOS"), "the next bullish break continues the new trend");
  for (const s of r.structures) {
    assert.ok(s.toIndex > s.fromIndex);
    assert.ok(candles[s.toIndex].close !== undefined);
    if (s.dir === "bull") assert.ok(candles[s.toIndex].close > s.level);
    else assert.ok(candles[s.toIndex].close < s.level);
  }
  // no pivot level is broken twice in the same direction
  const keys = swing.map((s) => `${s.dir}:${s.fromIndex}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(r.trend.swing, 1);
  assert.equal(r.internalBias.length, candles.length);
});

test("order block = the candle with the extreme parsed low/high between the broken pivot and the break", () => {
  const candles = fromCloses(zigzag([30, 25, 28, 20, 24, 15, 19, 12, 26, 20, 34]));
  const r = analyzeLux(candles, small);
  const bullBreak = r.structures.find((s) => s.scope === "swing" && s.dir === "bull");
  const ob = r.orderBlocks.find((b) => b.scope === "swing" && b.bias === "bull" && b.formedAt === bullBreak.toIndex);
  assert.ok(ob, "an order block is stored at the break");
  let lowest = Infinity;
  let at = -1;
  for (let j = bullBreak.fromIndex; j < bullBreak.toIndex; j++) if (candles[j].low < lowest) { lowest = candles[j].low; at = j; }
  assert.equal(ob.index, at);
  assert.equal(ob.bottom, lowest);
  assert.equal(ob.top, candles[at].high);
  assert.equal(ob.time, candles[at].time);
});

test("high-volatility candles cannot be an order block's extreme: their high and low are swapped", () => {
  // a normal zigzag with one enormous spike bar inside the down-leg
  const closes = zigzag([30, 25, 28, 20, 24, 15, 19, 12, 26, 20, 34]);
  const candles = fromCloses(closes);
  const spike = candles.findIndex((c) => c.close <= 12.5);
  candles[spike] = { ...candles[spike], low: candles[spike].low - 30, high: candles[spike].high + 0.1 }; // a 30-point wick
  const options = { ...small, obFilter: "range" };
  const r = analyzeLux(candles, options);
  const ob = r.orderBlocks.find((b) => b.scope === "swing" && b.bias === "bull");
  assert.ok(ob);
  assert.notEqual(ob.index, spike, "the wicky candle is filtered out of the choice");
  assert.ok(ob.bottom > candles[spike].low, "its 30-point wick does not define the block");
});

test("order blocks are mitigated by the low (or by the close, if configured) and stop being active", () => {
  const path = zigzag([30, 25, 28, 20, 24, 15, 19, 12, 26, 20, 34]);
  const drop = zigzag([34, 4], 8).slice(1);
  const candles = fromCloses([...path, ...drop]);
  const byLow = analyzeLux(candles, small);
  const ob = byLow.orderBlocks.find((b) => b.scope === "swing" && b.bias === "bull");
  assert.ok(ob.mitigatedAt > ob.formedAt);
  assert.ok(candles[ob.mitigatedAt].low < ob.bottom);
  assert.ok(!activeLuxOrderBlocks(byLow, "swing").includes(ob));

  const byClose = analyzeLux(candles, { ...small, obMitigation: "close" });
  const obClose = byClose.orderBlocks.find((b) => b.scope === "swing" && b.bias === "bull" && b.index === ob.index);
  assert.ok(obClose.mitigatedAt >= ob.mitigatedAt, "waiting for a close is never earlier than a wick");
  assert.ok(candles[obClose.mitigatedAt].close < obClose.bottom);

  const alive = analyzeLux(fromCloses(path), small);
  assert.ok(activeLuxOrderBlocks(alive, "swing").length >= 1);
});

test("equal highs / lows: two pivots closer than threshold x volatility", () => {
  const eqh = analyzeLux(fromCloses(zigzag([10, 20, 12, 20.03, 11, 18])), small).equalLevels.filter((e) => e.type === "EQH");
  assert.equal(eqh.length, 1);
  assert.ok(Math.abs(eqh[0].level - eqh[0].firstLevel) < 0.2);
  assert.ok(eqh[0].toIndex > eqh[0].fromIndex);
  assert.equal(analyzeLux(fromCloses(zigzag([10, 20, 12, 25, 11, 18])), small).equalLevels.filter((e) => e.type === "EQH").length, 0, "20 and 25 are not equal");
  const eql = analyzeLux(fromCloses(zigzag([20, 10, 18, 10.02, 19, 12])), small).equalLevels.filter((e) => e.type === "EQL");
  assert.equal(eql.length, 1);
  // a tighter threshold rejects the near-equal pair
  assert.equal(analyzeLux(fromCloses(zigzag([10, 20, 12, 20.03, 11, 18])), { ...small, equalThreshold: 0.0001 }).equalLevels.length, 0);
});

test("fair value gaps need a displacement candle and an auto threshold; a low below the gap retires them", () => {
  // 30 quiet candles (0.1% bodies), then: quiet-high candle, strong displacement candle, gap candle
  const quiet = [];
  let price = 100;
  for (let i = 0; i < 30; i++) { const open = price; price = open * (i % 2 ? 1.001 : 0.999); quiet.push(candle(1_700_000_000 + i * 300, open, Math.max(open, price) + 0.02, Math.min(open, price) - 0.02, price)); }
  const t = (k) => 1_700_000_000 + (30 + k) * 300;
  const anchor = candle(t(0), price, price + 0.1, price - 0.1, price + 0.05); // candle 1: high = price + 0.1
  const impulse = candle(t(1), price + 0.05, price + 3.2, price + 0.0, price + 3.0); // big green body, closes far above candle 1's high
  const gap = candle(t(2), price + 3.0, price + 3.6, price + 2.0, price + 3.4); // low 2.0 > anchor.high 0.1 -> bullish FVG
  const r = analyzeLux([...quiet, anchor, impulse, gap], small);
  const fvg = r.fvgs.find((g) => g.bias === "bull");
  assert.ok(fvg, "bullish FVG found");
  near(fvg.bottom, anchor.high);
  near(fvg.top, gap.low);
  assert.equal(fvg.fromIndex, 31);
  assert.equal(fvg.formedAt, 32);
  assert.equal(fvg.filledAt, null);
  assert.equal(activeLuxFvgs(r).length, 1);

  // the same shape but the middle candle does NOT close above the first candle's high: not a valid gap
  const weak = candle(t(1), price + 0.05, price + 3.2, price + 0.0, price + 0.08);
  assert.equal(analyzeLux([...quiet, anchor, weak, gap], small).fvgs.length, 0);
  // a displacement candle that is not larger than 2x the average body fails the auto threshold
  const mild = candle(t(1), price + 0.05, price + 0.3, price + 0.0, price + 0.11);
  const lowGap = candle(t(2), price + 0.11, price + 0.4, price + 0.105, price + 0.3);
  assert.equal(analyzeLux([...quiet, anchor, mild, lowGap], small).fvgs.length, 0);
  assert.equal(analyzeLux([...quiet, anchor, mild, lowGap], { ...small, fvgAutoThreshold: false }).fvgs.length, 1, "without the auto threshold the small gap counts");

  // price later trades below the gap bottom: filled and no longer active
  const refill = candle(t(3), price + 3.4, price + 3.5, anchor.high - 0.5, anchor.high - 0.4);
  const filled = analyzeLux([...quiet, anchor, impulse, gap, refill], small);
  assert.equal(filled.fvgs[0].filledAt, 33);
  assert.equal(activeLuxFvgs(filled).length, 0);
});

function near(a, b, eps = 1e-9) {
  assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);
}

test("trailing extremes follow price after the last swing pivot; strong/weak depends on the swing trend", () => {
  const candles = fromCloses(zigzag([10, 20, 12, 26, 15, 30, 27]));
  const r = analyzeLux(candles, small);
  const t = r.trailing;
  assert.ok(t);
  const lastHighPivot = r.swingPoints.filter((p) => p.type === "high").at(-1);
  const highsSince = candles.slice(lastHighPivot.index).map((c) => c.high);
  assert.equal(t.top, Math.max(...highsSince), "the top tracks the highest high since the last swing high");
  assert.equal(candles[t.topIndex].high, t.top);
  assert.ok(t.bottom < t.top);
  assert.equal(t.swingBias, r.trend.swing);
  assert.equal(analyzeLux(fromCloses([10, 11, 12]), small).trailing, null, "no swings yet, no zones");
});

test("previous day / week / month levels come from the last completed period, in UTC", () => {
  const day = 86400;
  const start = Date.UTC(2026, 8, 7) / 1000; // Monday 7 Sep 2026 00:00 UTC
  const candles = [];
  for (let d = 0; d < 9; d++) for (let h = 0; h < 24; h += 4) candles.push(candle(start + d * day + h * 3600, 100, 101 + d, 99 - d, 100)); // 4h candles for 9 days
  // make Sunday 13 Sep the "previous week"'s extreme
  const sunday = candles.findIndex((c) => c.time === start + 6 * day + 8 * 3600);
  candles[sunday] = { ...candles[sunday], high: 500, low: 1 };
  const levels = previousPeriodLevels(candles);
  const by = Object.fromEntries(levels.map((l) => [l.id, l]));
  assert.ok(by.D && by.W);
  // last candle is on day 8 (Tue 15 Sep); the previous day is day 7 (Mon 14 Sep)
  assert.equal(by.D.high, 101 + 7);
  assert.equal(by.D.low, 99 - 7);
  assert.equal(candles[by.D.highIndex].time >= start + 7 * day && candles[by.D.highIndex].time < start + 8 * day, true);
  // last week (Mon 7 - Sun 13 Sep) contains the spike
  assert.equal(by.W.high, 500);
  assert.equal(by.W.low, 1);
  assert.equal(candles[by.W.highIndex].time, start + 6 * day + 8 * 3600);
  // the month (September) is still in progress and there is no earlier month in the data: no monthly level
  assert.equal(by.M, undefined);

  // a daily chart cannot show a daily level, a weekly chart cannot show daily or weekly
  const daily = Array.from({ length: 20 }, (_, i) => candle(start + i * day, 100, 110, 90, 100));
  assert.equal(previousPeriodLevels(daily).some((l) => l.id === "D"), true, "same timeframe is allowed");
  const weekly = Array.from({ length: 12 }, (_, i) => candle(start + i * 7 * day, 100, 110, 90, 100));
  assert.deepEqual(previousPeriodLevels(weekly).map((l) => l.id).sort(), ["M", "W"]);
});

function walk(n, seed) {
  let s = seed;
  const rand = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const closes = [100];
  for (let i = 1; i < n; i++) closes.push(Math.max(1, closes[i - 1] + (rand() - 0.5) * 2.4 + Math.sin(i / 8) * 0.9));
  return fromCloses(closes, 0.25);
}

test("everything is causal: analysing only the first k candles gives exactly what the full run knew at k", () => {
  const options = { ...small, obFilter: "range" };
  const normalise = (list, key) => list.map((x) => ({ ...x, [key]: x[key] }));
  for (const seed of [1, 2, 3, 4]) {
    const candles = walk(260, seed);
    const full = analyzeLux(candles, options);
    for (const k of [60, 100, 140, 200, 259]) {
      const prefix = analyzeLux(candles.slice(0, k), options);
      const upTo = (list, field) => list.filter((x) => x[field] < k);
      assert.deepEqual(prefix.structures, upTo(full.structures, "toIndex"), `structures @${k} seed ${seed}`);
      assert.deepEqual(prefix.swingPoints, upTo(full.swingPoints, "formedAt"), `swing points @${k} seed ${seed}`);
      assert.deepEqual(prefix.equalLevels, upTo(full.equalLevels, "formedAt"), `equal levels @${k} seed ${seed}`);
      assert.deepEqual([...prefix.internalBias], [...full.internalBias].slice(0, k), `internal trend @${k} seed ${seed}`);
      const asOf = (list, dead) => upTo(list, "formedAt").map((x) => ({ ...x, [dead]: x[dead] != null && x[dead] < k ? x[dead] : null }));
      assert.deepEqual(prefix.orderBlocks, asOf(full.orderBlocks, "mitigatedAt"), `order blocks @${k} seed ${seed}`);
      assert.deepEqual(prefix.fvgs, asOf(full.fvgs, "filledAt"), `fvgs @${k} seed ${seed}`);
    }
    void normalise;
  }
});

test("the engine produces sane output on a long noisy series and handles tiny inputs", () => {
  const candles = walk(1200, 9);
  const r = analyzeLux(candles);
  assert.ok(r.structures.length > 0 && r.swingPoints.length > 0);
  for (const b of r.orderBlocks) assert.ok(b.top >= b.bottom && b.index < b.formedAt);
  for (const g of r.fvgs) assert.ok(g.top > g.bottom);
  assert.doesNotThrow(() => analyzeLux([]));
  assert.doesNotThrow(() => analyzeLux(candles.slice(0, 2)));
  assert.equal(analyzeLux(candles.slice(0, 2)).structures.length, 0);
  assert.equal(r.internalBias.length, candles.length);
});
