import assert from "node:assert/strict";
import test from "node:test";

import {
  STRATEGIES, adx, analyze, atr, backtest, bollinger, buildContext, ema, findPivots, labelSwings, reduceSwings,
  macd, rsi, sma, stochastic, supertrend, toCandles,
} from "../shared/analysis/index.js";
import { STRATEGY_BY_ID } from "../shared/analysis/strategies.js";

const near = (actual, expected, eps = 1e-9) => assert.ok(Math.abs(actual - expected) <= eps, `${actual} !~ ${expected}`);

/** Candles whose close follows `closes`, with a fixed wick either side. */
function fromCloses(closes, wick = 0.1, volume = 100) {
  return closes.map((close, i) => ({
    time: 1_700_000_000 + i * 300,
    open: i === 0 ? close : closes[i - 1],
    high: Math.max(close, i === 0 ? close : closes[i - 1]) + wick,
    low: Math.min(close, i === 0 ? close : closes[i - 1]) - wick,
    close,
    volume,
    closeTime: null,
  }));
}

/** Piecewise-linear path through turning points, `leg` candles per leg. */
function zigzag(points, leg = 6) {
  const out = [points[0]];
  for (let p = 1; p < points.length; p++) {
    for (let k = 1; k <= leg; k++) out.push(points[p - 1] + ((points[p] - points[p - 1]) * k) / leg);
  }
  return out;
}

/** Deterministic pseudo-random walk (no Math.random so failures reproduce). */
function walk(n, seed = 7) {
  let s = seed;
  const rand = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const closes = [100];
  for (let i = 1; i < n; i++) closes.push(Math.max(1, closes[i - 1] + (rand() - 0.5) * 2 + Math.sin(i / 11) * 0.4));
  return fromCloses(closes, 0.3, 100);
}

test("sma / ema basics", () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  const flat = ema(new Array(30).fill(5), 10);
  assert.equal(flat[8], null);
  near(flat[29], 5);
  // EMA(3) of 1..5: seed 2, k=0.5 -> 3, 4
  assert.deepEqual(ema([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test("rsi: bounds and extremes", () => {
  const up = rsi(Array.from({ length: 40 }, (_, i) => 100 + i), 14);
  const down = rsi(Array.from({ length: 40 }, (_, i) => 100 - i), 14);
  const flat = rsi(new Array(40).fill(100), 14);
  assert.equal(up[13], null);
  assert.equal(up[39], 100);
  assert.equal(down[39], 0);
  assert.equal(flat[39], 50);
  for (const v of rsi(walk(200).map((c) => c.close), 14).filter((x) => x !== null)) assert.ok(v >= 0 && v <= 100);
  // Wilder's textbook example: first RSI(14) is about 70.5
  const textbook = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
  const first = rsi(textbook, 14)[14];
  assert.ok(first > 70 && first < 71, `textbook RSI was ${first}`);
});

test("macd is zero on a flat series and positive in an uptrend", () => {
  const flat = macd(new Array(80).fill(10));
  near(flat.line[79], 0);
  near(flat.histogram[79], 0);
  const up = macd(Array.from({ length: 80 }, (_, i) => 10 + i * 0.5));
  assert.ok(up.line[79] > 0);
  assert.equal(up.line[24], null);
  assert.notEqual(up.line[25], null);
});

test("bollinger matches a hand calculation and collapses on a flat series", () => {
  const b = bollinger([1, 2, 3, 4, 5], 5, 2);
  near(b.mid[4], 3);
  near(b.upper[4], 3 + 2 * Math.sqrt(2));
  near(b.lower[4], 3 - 2 * Math.sqrt(2));
  const flat = bollinger(new Array(25).fill(7), 20, 2);
  near(flat.bandwidth[24], 0);
  near(flat.percentB[24], 0.5);
});

test("atr, stochastic, supertrend and adx behave on clear trends", () => {
  const wide = fromCloses(new Array(30).fill(50), 1);
  near(atr(wide, 14)[29], 2);

  const up = fromCloses(Array.from({ length: 80 }, (_, i) => 100 + i * 1.5), 0.3);
  const down = fromCloses(Array.from({ length: 80 }, (_, i) => 200 - i * 1.5), 0.3);
  assert.equal(stochastic(up, 14, 3).k[79] > 90, true);
  assert.equal(stochastic(down, 14, 3).k[79] < 10, true);

  const stUp = supertrend(up, 10, 3);
  assert.equal(stUp.trend[79], 1);
  assert.ok(stUp.line[79] < up[79].close);
  const stDown = supertrend(down, 10, 3);
  assert.equal(stDown.trend[79], -1);
  assert.ok(stDown.line[79] > down[79].close);

  const trending = adx(up, 14);
  assert.ok(trending.adx[79] > 25, `adx ${trending.adx[79]}`);
  assert.ok(trending.plusDi[79] > trending.minusDi[79]);
  // Sideways noise around a constant level: no directional strength
  const noise = walk(300, 3).map((c, i, all) => c.close - (all[i - 1]?.close ?? c.close));
  let level = 100;
  const sideways = fromCloses(noise.map((d, i) => { level += (100 - level) * 0.5 + d * 0.8; return level + (i % 3) * 0.05; }), 0.3);
  const chop = adx(sideways, 14);
  assert.ok(chop.adx[299] < trending.adx[79] * 0.6, `sideways adx ${chop.adx[299]} vs trending ${trending.adx[79]}`);
});

test("swings alternate and are labelled HH / HL in an uptrend", () => {
  const candles = fromCloses(zigzag([10, 15, 12, 18, 14, 22, 17, 25]), 0.05);
  const swings = labelSwings(reduceSwings(findPivots(candles)));
  for (let i = 1; i < swings.length; i++) assert.notEqual(swings[i].type, swings[i - 1].type);
  const labels = swings.map((s) => s.label).filter(Boolean);
  assert.ok(labels.includes("HH") && labels.includes("HL"));
  assert.ok(!labels.includes("LH") && !labels.includes("LL"));
  const ctx = buildContext(candles);
  assert.equal(ctx.structure.trend, "uptrend");
  // Peaks at 15, 18, 22 are found at the right candles
  const highs = swings.filter((s) => s.type === "high").map((s) => Math.round(s.price));
  assert.deepEqual(highs.slice(0, 3), [15, 18, 22]);
});

test("downtrend then a rally through the last swing high is a bullish CHoCH; a further break is a BOS", () => {
  const candles = fromCloses(zigzag([30, 25, 28, 20, 24, 15, 19, 12, 26, 20, 34]), 0.05);
  const { breaks } = buildContext(candles).structure;
  const bull = breaks.filter((b) => b.direction === "bull");
  assert.ok(breaks.some((b) => b.direction === "bear" && b.type === "BOS"), "downtrend continuation is a bearish BOS");
  assert.equal(bull[0].type, "CHoCH");
  assert.ok(bull.length >= 2);
  assert.equal(bull[bull.length - 1].type, "BOS");
  for (const b of breaks) assert.ok(b.index > b.swingIndex);
});

test("support and resistance cluster repeated pivots", () => {
  // Price bounces between ~10 and ~20 several times
  const candles = fromCloses(zigzag([15, 20, 10, 20.1, 10.1, 19.9, 9.9, 20, 15], 6), 0.05);
  const { supports, resistances } = buildContext(candles).structure;
  assert.ok(supports.length && resistances.length);
  const best = (levels) => [...levels].sort((a, b) => b.touches - a.touches)[0];
  assert.ok(best(resistances).touches >= 3);
  near(best(resistances).price, 20, 0.5);
  near(best(supports).price, 10, 0.5);
});

test("strategies never look into the future", () => {
  // The signal and stop at candle i must be identical whether or not later candles exist.
  for (const seed of [1, 4, 5]) {
    const candles = walk(200, seed);
    const full = buildContext(candles);
    for (let i = 60; i < candles.length; i += 2) {
      const partial = buildContext(candles.slice(0, i + 1));
      for (const strategy of STRATEGIES) {
        const a = strategy.evaluate(full, i);
        const b = strategy.evaluate(partial, i);
        assert.equal(a.signal, b.signal, `${strategy.id} seed ${seed} @${i}: full=${a.signal} prefix=${b.signal}`);
        assert.equal(a.stopLoss ?? null, b.stopLoss ?? null, `${strategy.id} seed ${seed} @${i}: stop differs`);
      }
    }
  }
});

test("every BUY comes with a sane stop and target", () => {
  let buys = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const candles = walk(300, seed);
    const ctx = buildContext(candles);
    for (const strategy of STRATEGIES) {
      for (let i = 60; i < candles.length; i++) {
        const r = strategy.evaluate(ctx, i);
        if (r.signal !== "BUY") continue;
        buys++;
        const close = candles[i].close;
        assert.ok(r.stopLoss < close && r.takeProfit > close, `${strategy.id}@${i}: sl ${r.stopLoss} tp ${r.takeProfit} close ${close}`);
        assert.ok(r.reasons.length > 0);
      }
    }
  }
  assert.ok(buys > 10, `expected the sample to produce BUY signals, got ${buys}`);
});

test("toCandles sorts, de-duplicates and analyze skips the still-forming candle", () => {
  const klines = [[2000, "2", "3", "1", "2.5", "10", 2999], [1000, "1", "2", "0.5", "1.5", "5", 1999], [2000, "2", "3", "1", "2.6", "11", 2999]];
  const candles = toCandles(klines);
  assert.deepEqual(candles.map((c) => c.time), [1, 2]);
  assert.equal(candles[1].close, 2.6); // the later duplicate wins

  const long = walk(120).map((c, i) => ({ ...c, closeTime: 1_000_000 + i * 1000 }));
  const closed = analyze(long, { now: 2_000_000 });
  const forming = analyze(long, { now: 1_000_000 + 119 * 1000 - 1 });
  assert.equal(closed.evalIndex, 119);
  assert.equal(forming.evalIndex, 118);
  assert.equal(closed.signals.length, STRATEGIES.length);
  assert.equal(analyze(walk(10)), null);
});

test("backtest: entry at next open, take-profit fill, fees, and stop-first on ambiguous candles", () => {
  const n = 80;
  const base = fromCloses(new Array(n).fill(100), 0.2);
  const bar = (i, o, h, l, c) => { base[i] = { ...base[i], open: o, high: h, low: l, close: c }; };
  STRATEGY_BY_ID.scripted = {
    evaluate: (_ctx, i) => (i === 60
      ? { signal: "BUY", reasons: ["test"], stopLoss: 95, takeProfit: 110 }
      : { signal: "HOLD", reasons: [] }),
  };
  try {
    // Scenario 1: enters at 61's open (101), TP hit on bar 63
    bar(61, 101, 102, 100, 101);
    bar(62, 101, 105, 100, 104);
    bar(63, 104, 111, 103, 110);
    let result = backtest(base, "scripted", { feePercent: 0.1 });
    assert.equal(result.trades.length, 1);
    let t = result.trades[0];
    assert.equal(t.entry, 101);
    assert.equal(t.exit, 110);
    assert.equal(t.reason, "take-profit");
    near(t.returnPct, ((110 * 0.999) / (101 * 1.001) - 1) * 100, 1e-9);
    assert.equal(result.stats.wins, 1);

    // Scenario 2: one candle touches both levels -> the stop is assumed to fill first
    bar(62, 101, 111, 94, 104);
    result = backtest(base, "scripted", { feePercent: 0 });
    t = result.trades[0];
    assert.equal(t.reason, "stop-loss");
    assert.equal(t.exit, 95);
    assert.ok(t.returnPct < 0);

    // Scenario 3: gap below the stop fills at the open, not at the stop price
    bar(62, 101, 102, 100, 101);
    bar(63, 90, 92, 88, 91);
    result = backtest(base, "scripted", { feePercent: 0 });
    t = result.trades[0];
    assert.equal(t.reason, "stop-loss (gap)");
    assert.equal(t.exit, 90);
    near(result.stats.maxDrawdownPct, (1 - 90 / 101) * 100, 1e-9);
  } finally {
    delete STRATEGY_BY_ID.scripted;
  }
});

test("backtest runs every real strategy on noisy data without blowing up", () => {
  const candles = walk(600, 11);
  for (const strategy of STRATEGIES) {
    const { stats, trades, equity } = backtest(candles, strategy.id);
    assert.equal(stats.trades, trades.length);
    assert.equal(equity.length, trades.length);
    assert.ok(stats.maxDrawdownPct >= 0 && stats.maxDrawdownPct <= 100);
    for (const t of trades) assert.ok(t.exitIndex >= t.entryIndex);
  }
  assert.throws(() => backtest(candles, "nope"), /Unknown strategy/);
});

// ---- time, days and sessions ----
import { currentSession, dayInfo, hourlyProfile, offsetMinutes, sessionLocalRange, sessionSegments, tzLabel, zonedParts } from "../shared/analysis/index.js";

/** Hourly candles starting at a UTC instant. */
function hourly(startIso, count, volume = () => 100) {
  const start = Date.parse(startIso) / 1000;
  return Array.from({ length: count }, (_, i) => ({
    time: start + i * 3600, open: 100, high: 101, low: 99, close: 100, volume: volume(new Date((start + i * 3600) * 1000).getUTCHours(), i), closeTime: null,
  }));
}

test("zonedParts / tzLabel convert UTC to the viewer's timezone", () => {
  const t = Date.parse("2023-11-14T23:30:00Z") / 1000; // Tuesday evening in UTC
  const utc = zonedParts(t, "UTC");
  assert.deepEqual([utc.day, utc.hour, utc.weekday], [14, 23, 1]);
  const tunis = zonedParts(t, "Africa/Tunis"); // UTC+1, no DST
  assert.deepEqual([tunis.day, tunis.hour, tunis.minute, tunis.weekday], [15, 0, 30, 2]); // already Wednesday
  assert.equal(tzLabel("UTC"), "UTC");
  assert.equal(tzLabel("Africa/Tunis", new Date("2026-06-01T12:00:00Z")), "UTC+1");
  assert.equal(tzLabel("Asia/Kolkata"), "UTC+5:30");
  assert.equal(offsetMinutes("America/New_York", new Date("2026-01-15T12:00:00Z")), -300);
  assert.equal(offsetMinutes("America/New_York", new Date("2026-07-15T12:00:00Z")), -240); // daylight saving
});

test("dayInfo splits candles at local midnight, so the boundary moves with the timezone", () => {
  const candles = hourly("2023-11-14T00:00:00Z", 72); // Tue, Wed, Thu in UTC
  const utc = dayInfo(candles, "UTC");
  assert.deepEqual(utc.map((d) => [d.label, d.startIndex, d.endIndex]), [["Tue 14", 0, 24], ["Wed 15", 24, 48], ["Thu 16", 48, 72]]);
  const tunis = dayInfo(candles, "Africa/Tunis"); // midnight there = 23:00 UTC
  assert.deepEqual(tunis.map((d) => [d.label, d.startIndex, d.endIndex]), [["Tue 14", 0, 23], ["Wed 15", 23, 47], ["Thu 16", 47, 71], ["Fri 17", 71, 72]]);
  assert.equal(utc[0].weekday, 1);
  assert.equal(dayInfo([], "UTC").length, 0);
});

test("sessions: segments are contiguous and the current session is right", () => {
  const candles = hourly("2023-11-14T00:00:00Z", 24);
  const segs = sessionSegments(candles);
  assert.deepEqual(segs.map((s) => [s.session.id, s.startIndex, s.endIndex]), [
    ["asia", 0, 8], ["london", 8, 13], ["overlap", 13, 16], ["newyork", 16, 21], ["late", 21, 24],
  ]);
  const now = currentSession(new Date("2023-11-14T14:20:00Z"));
  assert.equal(now.session.id, "overlap");
  assert.equal(now.next.id, "newyork");
  assert.equal(now.minutesLeft, 100);
  assert.equal(currentSession(new Date("2023-11-14T23:00:00Z")).next.id, "asia");
  assert.equal(sessionLocalRange(segs[1].session, "Africa/Tunis", new Date("2026-01-10T12:00:00Z")), "09:00–14:00");
  assert.equal(sessionLocalRange(segs[1].session, "UTC", new Date("2026-01-10T12:00:00Z")), "08:00–13:00");
});

test("hourlyProfile finds the busiest hours in the requested timezone", () => {
  const candles = hourly("2023-10-01T00:00:00Z", 24 * 10, (hour) => (hour === 14 ? 500 : hour === 15 ? 400 : hour === 13 ? 300 : hour === 3 ? 10 : 100));
  const utc = hourlyProfile(candles, "UTC");
  assert.deepEqual(utc.top, [13, 14, 15]);
  assert.equal(utc.hours[14].activity, 1);
  assert.ok(utc.quiet.includes(3));
  assert.equal(utc.hours[14].samples, 10);
  const tunis = hourlyProfile(candles, "Africa/Tunis"); // everything shifts one hour later
  assert.deepEqual(tunis.top, [14, 15, 16]);
  assert.equal(utc.days, 10);
});
