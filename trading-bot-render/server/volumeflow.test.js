import assert from "node:assert/strict";
import test from "node:test";

import { atr, candleFlow, cumulativeDelta, toCandles, volumeProfile } from "../shared/analysis/index.js";
import { STRATEGY_BY_ID, detectSignals } from "../shared/strategies/index.js";

const strategy = STRATEGY_BY_ID.volume_flow;
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

// ---------- order flow ----------

test("delta is exact when the candle says how much was bought aggressively", () => {
  const up = candleFlow({ open: 1, high: 2, low: 1, close: 2, volume: 100, takerBuyVolume: 80 });
  near(up.delta, 60); // 80 bought, 20 sold
  near(up.ratio, 0.6);
  assert.equal(up.measured, true);
  const down = candleFlow({ open: 2, high: 2, low: 1, close: 1, volume: 100, takerBuyVolume: 10 });
  near(down.delta, -80);
  near(down.ratio, -0.8);
  assert.equal(candleFlow({ volume: 100, takerBuyVolume: 50, high: 2, low: 1, close: 1.5 }).delta, 0);
});

test("delta is estimated from the candle shape when there is no taker volume, and says so", () => {
  const closeAtHigh = candleFlow({ open: 1, high: 2, low: 1, close: 2, volume: 100, takerBuyVolume: null });
  assert.deepEqual(closeAtHigh, { delta: 100, ratio: 1, measured: false });
  near(candleFlow({ open: 2, high: 2, low: 1, close: 1, volume: 50 }).ratio, -1);
  near(candleFlow({ open: 1.5, high: 2, low: 1, close: 1.5, volume: 50 }).ratio, 0);
  assert.equal(candleFlow({ open: 1, high: 1, low: 1, close: 1, volume: 50 }).ratio, 0, "no range, no opinion");
  // an impossible taker figure (more than the whole volume) is not believed
  assert.equal(candleFlow({ open: 1, high: 2, low: 1, close: 2, volume: 100, takerBuyVolume: 150 }).measured, false);
  assert.deepEqual(candleFlow({ open: 1, high: 2, low: 1, close: 2, volume: 0 }), { delta: 0, ratio: 0, measured: false });
});

test("cumulative delta adds the candles up", () => {
  const c = (buys) => ({ open: 1, high: 2, low: 1, close: 1.5, volume: 100, takerBuyVolume: buys });
  assert.deepEqual(cumulativeDelta([c(75), c(25), c(60)]), [50, 0, 20]);
});

test("toCandles keeps Binance's taker-buy volume (kline field 9) and leaves it null where a source has none", () => {
  const [a, b] = toCandles([
    [1_700_000_000_000, "1", "2", "0.5", "1.5", "100", 1_700_000_899_999, "150", 40, "70", "105", "0"],
    [1_700_000_900_000, "1", "2", "0.5", "1.5", "100"],
  ]);
  assert.equal(a.takerBuyVolume, 70);
  assert.equal(a.volume, 100);
  assert.equal(b.takerBuyVolume, null);
});

// ---------- the strategy, on candles built by hand ----------

const T0 = 1_700_000_000;
const candle = (i, open, high, low, close, volume = 100, buyShare = 0.5) => ({ time: T0 + i * 900, open, high, low, close, volume, takerBuyVolume: volume * buyShare, closeTime: null });

/**
 * 120 candles sweeping evenly between 102 and 108 (a triangle wave), with extra trading AT 105: a clear point of control
 * and a value area about 2.9 wide (an ATR is about 1.5), and neutral order flow (delta 0 on every candle).
 */
function base() {
  return Array.from({ length: 120 }, (_, i) => {
    if (i % 3 === 0) return candle(i, 104.9, 105.2, 104.8, 105, 150);
    const phase = (i % 24) / 24;
    const wave = phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase;
    const mid = 105 + 3 * wave;
    return candle(i, mid - 0.2, mid + 0.5, mid - 0.5, mid + 0.2);
  });
}
const PROFILE = (candles, n, lookback = 100, pct = 0.7) => volumeProfile(candles.slice(n - lookback, n), { rows: 48, valueAreaPct: pct });

/** The base, then one signal candle built from the profile of what came before it. */
function scenario(make, { prepare } = {}) {
  const candles = base();
  prepare?.(candles);
  const n = candles.length;
  const prof = PROFILE(candles, n);
  assert.ok(prof.val < prof.poc && prof.poc < prof.vah, "the base has a sensible profile");
  candles.push(make(n, prof, candles));
  return { candles, n, prof, signals: (params) => detectSignals(strategy, candles, params).filter((s) => s.formedAt === n) };
}

const longReject = (buyShare = 0.85, volume = 600) => (i, p) => candle(i, p.val - 0.3, p.val + 0.6, p.val - 0.8, p.val + 0.4, volume, buyShare);
const shortReject = (buyShare = 0.15, volume = 600) => (i, p) => candle(i, p.vah + 0.3, p.vah + 0.8, p.vah - 0.6, p.vah - 0.4, volume, buyShare);

test("rejection long: dips below the value area, closes back inside on real buying", () => {
  const { candles, n, prof, signals } = scenario(longReject());
  const [s, ...rest] = signals();
  assert.equal(rest.length, 0);
  assert.equal(s.dir, "bull");
  const a = atr(candles, 14)[n];
  near(s.entry, prof.val + 0.4);
  near(s.stop, prof.val - 0.8 - 0.3 * a);
  near(s.target, prof.poc, 1e-9);
  near(s.retest, prof.val);
  assert.match(s.reasons[0], /below the value area low/);
  assert.match(s.reasons[1], /70% net buying \(taker volume\)/);
  assert.match(s.reasons[2], /cumulative delta over 3 candles positive/);
  assert.equal(detectSignals(strategy, candles).filter((x) => x.formedAt < n).length, 0, "the quiet base produces nothing");
});

test("rejection short is the mirror image", () => {
  const { candles, n, prof, signals } = scenario(shortReject());
  const [s] = signals();
  assert.equal(s.dir, "bear");
  const a = atr(candles, 14)[n];
  near(s.entry, prof.vah - 0.4);
  near(s.stop, prof.vah + 0.8 + 0.3 * a);
  near(s.target, prof.poc);
  near(s.retest, prof.vah);
  assert.match(s.reasons[1], /net selling/);
});

test("without the order flow behind it there is no signal", () => {
  // selling pressure on a green candle: the flow disagrees with the candle
  assert.equal(scenario(longReject(0.2)).signals().length, 0);
  // too little pressure (10%) for the 20% minimum, but enough when the minimum is dropped to 0
  const weak = scenario(longReject(0.55));
  assert.equal(weak.signals().length, 0);
  assert.equal(weak.signals({ minDelta: 0 }).length, 1);
  // quiet volume: below the recent average (about 117), so it fails the default minimum of 1x but passes 0.5x
  const quiet = scenario(longReject(0.85, 80));
  assert.equal(quiet.signals().length, 0);
  assert.equal(quiet.signals({ volumeFactor: 0.5 }).length, 1);
  assert.equal(scenario(longReject(0.85, 40)).signals({ volumeFactor: 0.5 }).length, 0, "still too quiet");
});

test("the cumulative delta of the last candles has to agree", () => {
  // the candles just before were heavy selling; this candle's buying does not outweigh them
  const { signals } = scenario(longReject(0.7), { prepare: (c) => { for (let i = 117; i < 120; i++) c[i] = candle(i, 105, 105.4, 104.6, 105, 700, 0.05); } });
  assert.equal(signals().length, 0);
  assert.equal(signals({ cvdBars: 1 }).length, 1, "looking at this candle alone, the buying is enough");
});

test("a poke that never left the value area, or too small a poke, is not a rejection", () => {
  const inside = scenario((i, p) => candle(i, p.val + 0.2, p.val + 0.9, p.val + 0.1, p.val + 0.6, 600, 0.85));
  assert.equal(inside.signals({ breakouts: 0 }).length, 0);
  const tiny = scenario((i, p) => candle(i, p.val - 0.01, p.val + 0.6, p.val - 0.02, p.val + 0.4, 600, 0.85));
  assert.equal(tiny.signals({ probeAtr: 1 }).length, 0);
  assert.equal(tiny.signals({ probeAtr: 0 }).length, 1);
});

test("the reversal target: the point of control, or the far edge; never a target price has already passed", () => {
  const high = scenario((i, p) => candle(i, p.val - 0.3, p.poc + 0.9, p.val - 0.8, p.poc + 0.5, 600, 0.85));
  assert.equal(high.signals().length, 0, "closed beyond the point of control, so that target is behind it");
  const [s] = high.signals({ targetAt: 1 });
  near(s.target, high.prof.vah);
  const normal = scenario(longReject());
  near(normal.signals({ targetAt: 1 })[0].target, normal.prof.vah);
});

test("breakout: the first close outside the value area with flow behind it, projected by the value area's height", () => {
  const prepare = (c) => { c[119] = candle(119, 104.8, 105.3, 104.7, 105, 100, 0.5); };
  const up = scenario((i, p) => candle(i, p.vah - 0.1, p.vah + 1.2, p.vah - 0.2, p.vah + 1.0, 600, 0.85), { prepare });
  const [s] = up.signals();
  assert.equal(s.dir, "bull");
  near(s.entry, up.prof.vah + 1);
  near(s.target, s.entry + (up.prof.vah - up.prof.val));
  near(s.retest, up.prof.vah);
  assert.ok(s.stop < up.prof.vah);
  assert.match(s.reasons[0], /First close above the value area high/);
  assert.equal(up.signals({ breakouts: 0 }).length, 0, "switched off");

  const down = scenario((i, p) => candle(i, p.val + 0.1, p.val + 0.2, p.val - 1.2, p.val - 1.0, 600, 0.15), { prepare });
  const [d] = down.signals();
  assert.equal(d.dir, "bear");
  near(d.target, d.entry - (down.prof.vah - down.prof.val));
  assert.match(d.reasons[0], /First close below the value area low/);
});

test("a breakout is only the first close outside, not every candle that stays out", () => {
  const prepare = (c) => { c[119] = candle(119, 107.5, 109, 107.4, 108.8, 600, 0.85); }; // already closed above the value area
  assert.equal(scenario((i, p) => candle(i, 108.8, 110, 108.7, 109.8, 600, 0.85), { prepare }).signals().length, 0);
});

test("the measured taker volume outranks what the candle shape suggests", () => {
  // closes at its high (the shape says buying) but 80% of the volume was sold aggressively
  const { signals } = scenario((i, p) => candle(i, p.val - 0.3, p.val + 0.4, p.val - 0.8, p.val + 0.4, 600, 0.1));
  assert.equal(signals().length, 0);
});

test("without taker volume the pressure is estimated from the candle shape, and the signal says so", () => {
  const { signals } = scenario((i, p) => ({ ...longReject()(i, p), takerBuyVolume: null }));
  const [s] = signals();
  assert.equal(s.dir, "bull");
  assert.match(s.reasons[1], /net buying \(estimated from the candle shape, no taker volume in this data\)/);
});

test("a value area narrower than one ATR is noise and is not traded", () => {
  const flat = Array.from({ length: 120 }, (_, i) => candle(i, 100, 100.15, 99.9, 100.05));
  const n = flat.length;
  flat.push(candle(n, 99.6, 100.0, 99.5, 99.95, 600, 0.9));
  assert.equal(detectSignals(strategy, flat).filter((s) => s.formedAt === n).length, 0);
});

test("the profile is built only from what came before: a huge candle now does not change its own levels", () => {
  const a = scenario(longReject());
  const b = scenario(longReject(0.85, 5_000_000));
  near(a.signals()[0].target, b.signals()[0].target);
  near(a.signals()[0].retest, b.signals()[0].retest);
});

test("it is on the platform's list with the settings it describes", () => {
  assert.equal(strategy.directions.join(), "long,short");
  assert.equal(strategy.supportsRetest, true);
  assert.deepEqual(strategy.params.map((p) => p.key), ["lookback", "valuePct", "minDelta", "volumeFactor", "cvdBars", "probeAtr", "stopAtr", "targetAt", "breakouts"]);
  assert.throws(() => detectSignals(strategy, base(), { lookback: 5 }), /between 30 and 300/);
});
