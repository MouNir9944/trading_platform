import assert from "node:assert/strict";
import test from "node:test";

import { backtestManipulation, backtestManipulationMany, breakEvenWinRate, findManipulations, manipulationAt, planManipulationTrade } from "../shared/analysis/index.js";

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);
const T0 = 1_700_000_000;
const candle = (i, open, high, low, close) => ({ time: T0 + i * 14400, open, high, low, close, volume: 100, closeTime: null });

/** A quiet, gently oscillating warm-up so ATR is stable (about 1.0) and nothing looks like a manipulation. */
function warmup(n = 40, base = 100, start = 0) {
  return Array.from({ length: n }, (_, i) => {
    const mid = base + (i % 2 ? 0.2 : -0.2);
    return candle(start + i, mid - 0.15, mid + 0.5, mid - 0.5, mid + 0.15);
  });
}

/** Warm-up, then a red "previous" candle (low 99, body 99.2..100), then whatever `manip` builds. */
function withBull(manip, base = 100, start = 0) {
  const c = warmup(40, base, start);
  const n = start + c.length;
  c.push(candle(n, 100, 100.5, 99, 99.2));
  c.push(manip(n + 1));
  return c;
}
const BULL = (i) => candle(i, 99.3, 101, 98.2, 100.6); // low 98.2 < 99, closes 100.6 above the previous body high (100)

test("bullish manipulation: sweeps the previous low, closes back up and engulfs it", () => {
  const c = withBull(BULL);
  const s = manipulationAt(c, c.length - 1);
  assert.equal(s.dir, "bull");
  near(s.stop, 98.2);
  near(s.sweepLevel, 99);
  assert.ok(s.sweepAtr > 0.5);
});

test("no setup without the sweep, without the engulf, or when the candle closes red", () => {
  let c = withBull((i) => candle(i, 99.3, 101, 99.1, 100.6)); // low stays above the previous low
  assert.equal(manipulationAt(c, c.length - 1), null);
  c = withBull((i) => candle(i, 99.3, 100.2, 98.2, 99.8)); // swept, but closed inside the previous body
  assert.equal(manipulationAt(c, c.length - 1), null);
  c = withBull((i) => candle(i, 101, 101.2, 98.2, 100.4)); // swept and closed above, but the candle is red
  assert.equal(manipulationAt(c, c.length - 1), null);
});

test("bearish manipulation is the mirror image", () => {
  const c = warmup();
  const n = c.length;
  c.push(candle(n, 100, 101, 99.6, 100.8)); // previous candle (green): body 100..100.8, high 101
  c.push(candle(n + 1, 100.7, 101.9, 99.7, 99.9)); // high 101.9 > 101, close 99.9 < previous body low 100
  const s = manipulationAt(c, n + 1);
  assert.equal(s.dir, "bear");
  near(s.stop, 101.9);
  near(s.sweepLevel, 101);
});

test("engulf 'range' is stricter than 'body'", () => {
  // Previous candle body is 99.2..100 and its high is 100.5. This one closes at 100.3: past the body, not past the high.
  const c = withBull((i) => candle(i, 99.3, 100.6, 98.2, 100.3));
  assert.equal(manipulationAt(c, c.length - 1, { engulf: "body" }).dir, "bull");
  assert.equal(manipulationAt(c, c.length - 1, { engulf: "range" }), null);
});

test("minimum sweep, risk cap and long/short switches", () => {
  const c = withBull(BULL);
  const i = c.length - 1;
  assert.ok(manipulationAt(c, i, { minSweepAtr: 0.5 }));
  assert.equal(manipulationAt(c, i, { minSweepAtr: 50 }), null);
  assert.equal(manipulationAt(c, i, { longs: false }), null);
  assert.equal(manipulationAt(c, i, { maxRiskAtr: 1 }), null); // the stop is about 2.4 away with ATR about 1
  assert.ok(manipulationAt(c, i, { maxRiskAtr: 10 }));
});

test("requireSweep off: an engulfing candle that did not sweep qualifies, and the default still rejects it", () => {
  const c = withBull((i) => candle(i, 99.3, 101, 99.1, 100.6));
  const last = c.length - 1;
  assert.equal(manipulationAt(c, last), null);
  const s = manipulationAt(c, last, { requireSweep: false });
  assert.equal(s.dir, "bull");
  assert.equal(s.sweepAtr, 0);
});

test("trend filter: a long below the trend EMA is refused, above it is allowed", () => {
  // 60 candles around 150, then the setup near 100: price is far below the 50 EMA.
  const c = [...warmup(60, 150), ...withBull(BULL, 100, 60)];
  const i = c.length - 1;
  assert.equal(c[i].time, T0 + i * 14400);
  assert.equal(manipulationAt(c, i, { trend: "ema", trendPeriod: 50 }), null);
  assert.ok(manipulationAt(c, i, { trend: "off" }));
});

test("findManipulations lists them oldest first and is unchanged by later candles", () => {
  const c = withBull(BULL);
  const all = findManipulations(c);
  assert.equal(all.length, 1);
  const longer = [...c, candle(c.length, 100.6, 100.7, 100.5, 100.6)];
  assert.equal(findManipulations(longer)[0].index, all[0].index);
});

test("trade plan: stop at the wick, target at reward:risk, refused when price opens beyond the stop", () => {
  const setup = { dir: "bull", stop: 98.2 };
  const p = planManipulationTrade(setup, 100.6, { rewardRisk: 2 });
  assert.equal(p.side, "long");
  near(p.risk, 2.4);
  near(p.target, 105.4);
  near(planManipulationTrade({ dir: "bear", stop: 101.9 }, 99.9, { rewardRisk: 2 }).target, 95.9);
  assert.equal(planManipulationTrade(setup, 98, {}).ok, false);
});

// ---- backtest: entry 100.2 (the open after the setup), stop 98.2, so risk 2.0 and target 104.2 ----
function scenario(after) {
  const c = withBull(BULL);
  const n = c.length;
  after.forEach((bar, k) => c.push(candle(n + k, ...bar)));
  return c;
}
const noFee = { feePercent: 0 };
const ENTRY_BAR = [100.2, 100.5, 100.0, 100.4]; // opens at 100.2, stays between the stop and the target
const WIN_BAR = [100.4, 104.5, 100.3, 104.3];
const LOSS_BAR = [100.4, 100.5, 98.0, 98.4];

test("backtest: the trade is entered at the NEXT candle's open, never at the signal close", () => {
  const r = backtestManipulation(scenario([ENTRY_BAR, [100.4, 100.6, 100.1, 100.3]]), noFee);
  assert.equal(r.trades.length, 0);
  assert.equal(r.open.side, "long");
  near(r.open.entry, 100.2); // not 100.6, the close of the setup candle
});

test("backtest: target hit pays +2R, stop hit costs -1R", () => {
  let r = backtestManipulation(scenario([ENTRY_BAR, WIN_BAR]), noFee);
  assert.equal(r.trades.length, 1);
  near(r.trades[0].netR, 2);
  assert.equal(r.trades[0].reason, "take-profit");
  near(r.trades[0].exit, 104.2);

  r = backtestManipulation(scenario([ENTRY_BAR, LOSS_BAR]), noFee);
  near(r.trades[0].netR, -1);
  assert.equal(r.trades[0].reason, "stop-loss");
});

test("backtest: when the stop and the target are both inside one candle, the stop wins", () => {
  const r = backtestManipulation(scenario([[100.2, 105, 98, 101]]), noFee);
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].reason, "stop-loss");
  near(r.trades[0].netR, -1);
});

test("backtest: a gap through the stop fills at the open, worse than -1R", () => {
  const r = backtestManipulation(scenario([ENTRY_BAR, [97.0, 97.5, 96.5, 97.2]]), noFee);
  assert.equal(r.trades[0].reason, "stop-loss (gap)");
  near(r.trades[0].exit, 97);
  assert.ok(r.trades[0].netR < -1.5);
});

test("backtest: fees are charged on both sides and shown in R", () => {
  const c = scenario([ENTRY_BAR, WIN_BAR]);
  const free = backtestManipulation(c, { feePercent: 0 }).trades[0];
  const paid = backtestManipulation(c, { feePercent: 0.1 }).trades[0];
  near(free.netR, 2);
  near(paid.netR, 2 - ((100.2 + 104.2) * 0.001) / 2, 1e-9);
});

test("backtest: a short mirrors the long", () => {
  const c = warmup();
  const n = c.length;
  c.push(candle(n, 100, 101, 99.6, 100.8));
  c.push(candle(n + 1, 100.7, 101.9, 99.7, 99.9)); // bearish setup, stop 101.9
  c.push(candle(n + 2, 99.9, 100.0, 99.5, 99.7)); // entry at the open 99.9, risk 2.0, target 95.9
  c.push(candle(n + 3, 99.7, 99.8, 95.5, 96.0));
  // The previous candle above is itself a valid bullish setup, so switch longs off to look at the short alone.
  const r = backtestManipulation(c, { ...noFee, longs: false });
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].side, "short");
  near(r.trades[0].netR, 2);
});

test("backtest: statistics add up (win rate, expectancy, drawdown in R, profit factor)", () => {
  const first = scenario([ENTRY_BAR, WIN_BAR]); // a winner
  const c = [...first, ...warmup(20, 100, first.length)];
  const n = c.length;
  c.push(candle(n, 100, 100.5, 99, 99.2));
  c.push(candle(n + 1, 99.3, 101, 98.2, 100.6)); // a second setup...
  c.push(candle(n + 2, ...ENTRY_BAR));
  c.push(candle(n + 3, ...LOSS_BAR)); // ...that stops out
  const r = backtestManipulation(c, noFee);
  assert.equal(r.trades.length, 2);
  assert.equal(r.stats.wins, 1);
  near(r.stats.winRate, 50);
  near(r.stats.totalR, 1);
  near(r.stats.expectancyR, 0.5);
  near(r.stats.profitFactor, 2);
  near(r.stats.maxDrawdownR, 1);
  assert.equal(r.stats.maxLosingStreak, 1);
  assert.equal(r.stats.long.trades, 2);
  assert.equal(r.stats.short.trades, 0);
});

test("backtest: many pairs merge by exit time, and a pair with no data is reported, not fatal", () => {
  const good = scenario([ENTRY_BAR, WIN_BAR]);
  const r = backtestManipulationMany([{ symbol: "AAA", candles: good }, { symbol: "BBB", candles: [], error: "no such pair" }], noFee);
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].symbol, "AAA");
  assert.equal(r.perSymbol.find((p) => p.symbol === "BBB").error, "no such pair");
  near(r.stats.totalR, 2);
});

test("break-even win rate at 2R is one in three", () => {
  near(breakEvenWinRate(2), 100 / 3, 1e-9);
  near(breakEvenWinRate(1), 50);
});
