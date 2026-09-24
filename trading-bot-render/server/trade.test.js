import assert from "node:assert/strict";
import test from "node:test";

import { amdStrategy } from "../shared/strategies/amd.js";
import { defaultParams } from "../shared/strategies/index.js";
import { TRADE_DEFAULTS, backtestStrategy, judgeBacktest, planTrade, simulate, summarizeTrades, sweepTrades } from "../shared/strategies/trade.js";

const bar = (i, open, high, low, close) => ({ time: 1_700_000_000 + i * 900, open, high, low, close, volume: 100 });

/** 20 candles between 98.3 and 101.7, a sweep of the low (20), a strong reclaim (21) and the gap (22), then the tail. */
function scenario(tail = []) {
  const c = [];
  for (let i = 0; i < 20; i++) {
    const up = i % 2 === 0;
    c.push(bar(i, up ? 99.8 : 100.2, i === 5 ? 101.7 : 100.6, i === 9 ? 98.3 : 99.4, up ? 100.2 : 99.8));
  }
  c.push(bar(20, 98.3, 98.4, 97.9, 98.3), bar(21, 98.3, 99.4, 98.2, 99.3), bar(22, 99.3, 99.6, 98.8, 99.4));
  tail.forEach(([o, h, l, cl], k) => c.push(bar(23 + k, o, h, l, cl)));
  return c;
}
const flip = (candles) => candles.map((c) => ({ ...c, open: 200 - c.open, close: 200 - c.close, high: 200 - c.low, low: 200 - c.high }));
const signals = (candles, params = {}) => amdStrategy.detect(candles, { ...defaultParams(amdStrategy), ...params });
const setupOf = (candles) => signals(candles)[0];
const run = (tail, options) => { const c = scenario(tail); return simulate(c, signals(c), options); };

const RALLY = [[99.4, 100.4, 99.3, 100.3], [100.3, 101.8, 100.2, 101.6]];

test("planTrade: entry, stop and target for each mode, and why a plan is refused", () => {
  const s = setupOf(scenario(RALLY));
  const close = planTrade(s);
  assert.equal(close.ok, true);
  assert.deepEqual([close.side, close.entry, close.target], ["long", 99.4, 101.7]);
  assert.ok(close.stop < 97.9 && close.rewardRisk > 1.2);

  const retest = planTrade(s, { entryMode: "retest" });
  assert.equal(retest.entry, 98.8, "the top of the gap");
  assert.ok(retest.risk < close.risk && retest.rewardRisk > close.rewardRisk, "a retest entry has less risk and more reward");

  const r2 = planTrade(s, { targetMode: "r", targetR: 2 });
  assert.ok(Math.abs(r2.target - (r2.entry + 2 * r2.risk)) < 1e-9);

  assert.match(planTrade(s, { minRewardRisk: 5 }).reason, /below 5/);
  assert.match(planTrade(s, { longs: false }).reason, /switched off/);
  const behind = { ...s, target: 99 };
  assert.match(planTrade(behind).reason, /already behind/);

  const short = planTrade(setupOf(flip(scenario(RALLY))));
  assert.equal(short.side, "short");
  assert.ok(short.stop > short.entry && short.target < short.entry, "a short has its stop above and its target below");
  assert.match(planTrade(setupOf(flip(scenario(RALLY))), { shorts: false }).reason, /switched off/);
});

test("a filled limit that reaches the far side of the range is a winner, and fees reduce the result", () => {
  const { trades, missed } = run(RALLY);
  assert.equal(trades.length, 1);
  const t = trades[0];
  assert.deepEqual([t.side, t.reason, t.entry, t.exit ?? t.exitPrice, t.entryIndex, t.exitIndex], ["long", "target", 99.4, 101.7, 23, 24]);
  assert.ok(t.r > 1.1 && t.returnPct > 0);
  assert.equal(missed.expired + missed.targetFirst + missed.busy, 0);
  const free = run(RALLY, { feePercent: 0 }).trades[0];
  assert.ok(free.r > t.r, "the same trade without fees earns more");
});

test("a stop hit on the fill candle is a loss of about one R, and a gap through the stop loses more", () => {
  const stopped = run([[99.4, 99.5, 97.0, 97.2]]).trades[0];
  assert.equal(stopped.reason, "stop");
  assert.ok(Math.abs(stopped.r + 1) < 1e-9, `r ${stopped.r}`);
  assert.equal(stopped.exitIndex, stopped.entryIndex);

  const gapped = run([[99.4, 99.9, 99.3, 99.6], [96.0, 96.5, 95.5, 96.2]]).trades[0];
  assert.equal(gapped.reason, "stop");
  assert.equal(gapped.exitPrice, 96.0, "filled at the open, not at the stop");
  assert.ok(gapped.r < -1.5);
});

test("if both the stop and the target were inside one candle, the stop wins", () => {
  const t = run([[99.4, 99.9, 99.3, 99.6], [99.6, 102.0, 97.0, 100.0]]).trades[0];
  assert.equal(t.reason, "stop");
});

test("only the stop can end a trade on the candle that fills it", () => {
  // the fill candle also trades through the target: the order of events is unknown, so it is not counted
  const t = run([[99.4, 102.0, 99.3, 101.9], [101.9, 102.1, 101.0, 101.5]]).trades[0];
  assert.equal(t.entryIndex, 23);
  assert.equal(t.exitIndex, 24, "the target is taken on the next candle");
});

test("price that runs to the target without coming back is a missed trade, never chased", () => {
  const r = run([[100.5, 101.0, 100.4, 100.9], [101.0, 102.0, 100.9, 101.9]]);
  assert.equal(r.trades.length, 0);
  assert.equal(r.missed.targetFirst, 1);
});

test("an order that is never touched lapses after the expiry", () => {
  const drift = [[100.5, 100.9, 100.4, 100.8], [100.8, 101.0, 100.5, 100.7], [100.7, 101.1, 100.5, 100.9], [100.9, 101.2, 100.6, 101.0]];
  const r = run(drift);
  assert.equal(r.trades.length, 0);
  assert.equal(r.missed.expired, 1);
  assert.equal(run(drift, { expiryCandles: 1 }).missed.expired, 1);
});

test("a retest entry waits for the gap to be tested", () => {
  const miss = run([[99.4, 99.9, 99.3, 99.6], [99.6, 101.8, 99.5, 101.7]], { entryMode: "retest" });
  assert.equal(miss.trades.length, 0, "price never came back to 98.8");
  assert.equal(miss.missed.targetFirst, 1);
  const hit = run([[99.4, 99.6, 98.7, 99.3], [99.3, 101.9, 99.2, 101.8]], { entryMode: "retest" });
  assert.equal(hit.trades.length, 1);
  assert.equal(hit.trades[0].entry, 98.8);
  assert.equal(hit.trades[0].reason, "target");
  assert.ok(hit.trades[0].r > 1.5, "the better price gives a better R");
});

test("a trade still open at the end of the data is reported apart and not counted", () => {
  const r = run([[99.4, 99.9, 99.3, 99.6], [99.6, 100.0, 99.4, 99.9]]);
  assert.equal(r.trades.length, 0);
  assert.equal(r.openTrade.reason, "open");
  assert.ok(Number.isFinite(r.openTrade.r));
});

test("the mirror image behaves the same as a short", () => {
  const long = run(RALLY).trades[0];
  const c = flip(scenario(RALLY));
  const short = simulate(c, signals(c)).trades[0];
  assert.equal(short.side, "short");
  assert.equal(short.reason, "target");
  assert.ok(Math.abs(short.r - long.r) < 0.05, `long ${long.r} short ${short.r}`); // percentage fees differ a little at mirrored price levels
});

/** Seeded noise with squeezes and spikes, like the AMD tests use. */
function noisy(seed, n = 900) {
  let x = seed;
  const rand = () => { x = (x * 1664525 + 1013904223) % 4294967296; return x / 4294967296; };
  const out = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const squeeze = Math.floor(i / 45) % 2 === 0;
    const step = (rand() - 0.5) * (squeeze ? 0.6 : 2.4);
    const open = price;
    const close = price + step;
    const spike = rand() < 0.08 ? rand() * 1.6 : 0;
    out.push(bar(i, open, Math.max(open, close) + rand() * 0.4 + (rand() < 0.5 ? spike : 0), Math.min(open, close) - rand() * 0.4 - (rand() < 0.5 ? spike : 0), close));
    price = close;
  }
  return out;
}

test("one position at a time, and no look-ahead: trades closed on a prefix are the same trades in the full run", () => {
  let total = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const candles = noisy(seed);
    const options = { minRewardRisk: 0, entryMode: seed % 2 ? "limit-close" : "retest" };
    const full = simulate(candles, signals(candles), options).trades;
    total += full.length;
    full.forEach((t, i) => { if (i) assert.ok(t.entryIndex > full[i - 1].exitIndex, `seed ${seed}: trades overlap`); });
    const key = (t) => JSON.stringify([t.id, t.entryIndex, t.exitIndex, t.entry, t.exitPrice, t.reason]);
    for (let cut = 100; cut < candles.length; cut += 37) {
      const part = candles.slice(0, cut);
      const prefix = simulate(part, signals(part), options).trades;
      const fullKeys = new Set(full.map(key));
      for (const t of prefix) assert.ok(fullKeys.has(key(t)), `seed ${seed} cut ${cut}: a trade that closed early changed`);
    }
  }
  assert.ok(total >= 5, `expected trades from the noisy data, got ${total}`);
});

// ---- statistics ----

const fake = (r, i) => ({ r, returnPct: r, entryTime: i * 100, exitTime: i * 100 + 50, barsHeld: 4, reason: r > 0 ? "target" : "stop" });

test("statistics: win rate, expectancy, profit factor, streaks, drawdown and the compounding equity curve", () => {
  const s = summarizeTrades([2, -1, -1, 2, -1].map(fake), { startEquity: 1000, riskPerTradePct: 1 });
  assert.equal(s.trades, 5);
  assert.equal(s.winRate, 40);
  assert.ok(Math.abs(s.expectancyR - 0.2) < 1e-9);
  assert.ok(Math.abs(s.profitFactor - 4 / 3) < 1e-9);
  assert.equal(s.maxLossStreak, 2);
  assert.equal(s.maxDrawdownR, 2);
  assert.equal(s.totalR, 1);
  const expected = 1000 * 1.02 * 0.99 * 0.99 * 1.02 * 0.99;
  assert.ok(Math.abs(s.equity.end - expected) < 1e-9);
  assert.ok(s.equity.maxDrawdownPct > 1.9 && s.equity.maxDrawdownPct < 2.1);
  assert.equal(s.curve.length, 6);
  assert.equal(s.halves, null, "too few trades to split");
  assert.deepEqual(summarizeTrades([]).trades, 0);
  assert.equal(summarizeTrades([]).expectancyR, null);
  assert.equal(summarizeTrades([1, 1].map(fake)).profitFactor, Infinity);
});

test("the verdict says what the numbers mean, including the caveats", () => {
  const many = (r, n) => Array.from({ length: n }, (_, i) => fake(i % 3 === 2 ? -1 : r, i));
  assert.equal(judgeBacktest(summarizeTrades([])).label, "No trades");
  const bad = judgeBacktest(summarizeTrades(many(0.4, 40)));
  assert.equal(bad.tone, "bad", "two wins of 0.4R for every 1R loss loses money");
  assert.match(bad.text, /lost/);
  const good = judgeBacktest(summarizeTrades(many(2, 60)));
  assert.equal(good.tone, "good");
  const few = judgeBacktest(summarizeTrades([2, 2, -1].map(fake)));
  assert.match(few.text, /only 3 trades/);
  assert.equal(few.tone, "mixed");
  const unstable = judgeBacktest(summarizeTrades([...Array(20).fill(0).map((_, i) => fake(1.5, i)), ...Array(20).fill(0).map((_, i) => fake(-1, 20 + i))]));
  assert.match(unstable.text, /disagree/);
});

test("the backtest pools trades across pairs, reports each pair, and flags short data", () => {
  const datasets = [{ symbol: "AAA", candles: noisy(2) }, { symbol: "BBB", candles: noisy(5) }, { symbol: "TINY", candles: noisy(1).slice(0, 30) }];
  const result = backtestStrategy(datasets, { strategy: amdStrategy, trade: { minRewardRisk: 0 } });
  assert.equal(result.perSymbol.length, 3);
  assert.equal(result.perSymbol[2].error, "not enough candles");
  const pooled = result.perSymbol[0].stats.trades + result.perSymbol[1].stats.trades;
  assert.equal(result.combined.trades, pooled);
  assert.equal(result.trades.length, pooled);
  assert.ok(result.trades.every((t) => t.symbol === "AAA" || t.symbol === "BBB"));
  assert.ok(result.trades.every((t, i, a) => !i || a[i - 1].entryTime >= t.entryTime), "newest first");
  assert.ok(Number.isFinite(result.perSymbol[0].buyAndHoldPct));
  assert.equal(result.counts.filled, pooled);
  assert.ok(result.counts.signals >= pooled);
  assert.equal(result.options.trade.entryMode, TRADE_DEFAULTS.entryMode);
});

test("the sweep compares ways of trading the same signals", () => {
  const rows = sweepTrades([{ symbol: "AAA", candles: noisy(2) }, { symbol: "BBB", candles: noisy(5) }], { strategy: amdStrategy, trade: { minRewardRisk: 0 } });
  assert.equal(rows.length, 8);
  assert.ok(rows.every((r) => r.label && r.stats && r.verdict));
  assert.deepEqual([...new Set(rows.map((r) => r.trade.entryMode))].sort(), ["limit-close", "retest"]);
  assert.ok(rows.some((r) => r.trade.targetMode === "own") && rows.some((r) => r.trade.targetR === 3));
});

test("a strategy without a retest price is refused a retest entry, one without a target must use a multiple of the risk", () => {
  const plain = { dir: "bull", formedAt: 10, entry: 100, stop: 98 };
  assert.match(planTrade(plain, { entryMode: "retest" }).reason, /no retest price/);
  assert.match(planTrade(plain).reason, /gives no target/);
  const r = planTrade(plain, { targetMode: "r", targetR: 3 });
  assert.equal(r.ok, true);
  assert.equal(r.target, 106);
  const rows = sweepTrades([{ symbol: "AAA", candles: noisy(2) }], { strategy: { ...amdStrategy, supportsRetest: false }, trade: { minRewardRisk: 0 } });
  assert.equal(rows.length, 4, "no retest variants for a strategy that cannot retest");
});
