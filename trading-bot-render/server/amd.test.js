import assert from "node:assert/strict";
import test from "node:test";

import { AMD_DEFAULTS, amdStages, buildContext, findAmd } from "../shared/analysis/index.js";
import { STRATEGY_BY_ID } from "../shared/analysis/strategies.js";

const bar = (i, open, high, low, close) => ({ time: 1_700_000_000 + i * 900, open, high, low, close, volume: 100 });

/** 20 candles of accumulation between 98.3 and 101.7, then the given tail. */
function accumulation() {
  const out = [];
  for (let i = 0; i < 20; i++) {
    const up = i % 2 === 0;
    let high = 100.6;
    let low = 99.4;
    if (i === 5) high = 101.7; // wick tags the top of the range
    if (i === 9) low = 98.3; // wick tags the bottom of the range
    out.push(bar(i, up ? 99.8 : 100.2, high, low, up ? 100.2 : 99.8));
  }
  return out;
}

/** Sweep of the range low (candle 20), strong reclaim (21) and the gap (22), then whatever `tail` adds. */
function bullish(tail = []) {
  const c = accumulation();
  c.push(bar(20, 98.3, 98.4, 97.9, 98.3)); // manipulation: wick 0.4 below the range low
  c.push(bar(21, 98.3, 99.4, 98.2, 99.3)); // displacement candle
  c.push(bar(22, 99.3, 99.6, 98.8, 99.4)); // its low (98.8) is above the sweep candle's high (98.4): gap
  tail.forEach(([o, h, l, cl], k) => c.push(bar(23 + k, o, h, l, cl)));
  return c;
}

const rally = [[99.4, 100.4, 99.3, 100.3], [100.3, 101.8, 100.2, 101.6]]; // reaches the far side (101.7)
const collapse = [[99.4, 99.5, 97.0, 97.2]]; // closes beyond the sweep

const flip = (candles) => candles.map((c) => ({ ...c, open: 200 - c.open, close: 200 - c.close, high: 200 - c.low, low: 200 - c.high }));

test("the full sequence is found, in order, with the FVG as the signal", () => {
  const found = findAmd(bullish(rally), null, { minRewardRisk: 0 });
  assert.equal(found.length, 1);
  const s = found[0];
  assert.equal(s.dir, "bull");
  assert.equal(s.formedAt, 22, "signalled on the third candle of the gap");
  assert.equal(s.range.startIndex, 0);
  assert.equal(s.range.endIndex, 19);
  assert.equal(s.range.low, 98.3);
  assert.equal(s.range.high, 101.7);
  assert.equal(s.manipulation.index, 20);
  assert.equal(s.manipulation.extreme, 97.9);
  assert.deepEqual([s.fvg.bottom, s.fvg.top], [98.4, 98.8]);
  assert.equal(s.status, "distributed");
  assert.equal(s.distribution.endedAt, 24);
  assert.equal(s.plan.target, 101.7);
  assert.ok(s.plan.stopLoss < 97.9);
  const stages = amdStages(s);
  assert.deepEqual(stages.map((x) => x.key), ["accumulation", "manipulation", "fvg", "distribution"]);
  assert.ok(stages[0].to < stages[1].from && stages[1].to <= stages[2].to && stages[2].to <= stages[3].from, "stages are in order");
});

test("a setup that has not reached the far side yet is active, and one that lost the sweep low has failed", () => {
  const active = findAmd(bullish([[99.4, 99.9, 99.3, 99.8]]), null, { minRewardRisk: 0 })[0];
  assert.equal(active.status, "active");
  assert.ok(active.distribution.progress > 0 && active.distribution.progress < 1);
  const failed = findAmd(bullish(collapse), null, { minRewardRisk: 0 })[0];
  assert.equal(failed.status, "failed");
  assert.equal(failed.distribution.endedAt, 23);
});

test("the mirror image is a bearish setup at the same candles", () => {
  const up = findAmd(bullish(rally), null, { minRewardRisk: 0 })[0];
  const down = findAmd(flip(bullish(rally)), null, { minRewardRisk: 0 });
  assert.equal(down.length, 1);
  assert.equal(down[0].dir, "bear");
  assert.equal(down[0].formedAt, up.formedAt);
  assert.equal(down[0].status, "distributed");
  assert.ok(down[0].plan.stopLoss > down[0].manipulation.extreme && down[0].plan.target < down[0].plan.entry);
  assert.ok(down[0].fvg.top > down[0].fvg.bottom && down[0].range.high > down[0].range.low);
});

test("nothing is reported unless accumulation, manipulation and the gap happen in that order", () => {
  const opts = { minRewardRisk: 0 };
  // a gap with no sweep: price drifts up out of the range and leaves a gap
  const noSweep = accumulation();
  noSweep.push(bar(20, 100.2, 100.5, 99.9, 100.4), bar(21, 100.4, 101.6, 100.3, 101.5), bar(22, 101.5, 102.0, 101.0, 101.9));
  assert.deepEqual(findAmd(noSweep, null, opts), []);

  // a sweep with no gap: overlapping candles crawl back
  const noGap = accumulation();
  noGap.push(bar(20, 98.3, 98.4, 97.9, 98.3), bar(21, 98.3, 98.9, 98.2, 98.7), bar(22, 98.7, 99.1, 98.5, 98.9), bar(23, 98.9, 99.3, 98.7, 99.1));
  for (let i = 24; i < 40; i++) noGap.push(bar(i, 99.1, 99.5, 98.8, 99.2));
  assert.deepEqual(findAmd(noGap, null, opts), []);

  // a real breakdown (far past the range, not a wick that comes back) followed by a gap
  const breakdown = accumulation();
  breakdown.push(bar(20, 98.3, 98.4, 94.0, 94.5), bar(21, 94.5, 96.0, 94.3, 95.9), bar(22, 95.9, 96.5, 95.5, 96.3));
  assert.deepEqual(findAmd(breakdown, null, opts), []);

  // a gap that formed INSIDE the range before the sweep does not count, and the sweep itself is not followed by one
  const gapFirst = accumulation();
  gapFirst.push(bar(20, 99.5, 99.8, 99.4, 99.6), bar(21, 99.6, 100.4, 99.6, 100.3), bar(22, 100.3, 100.6, 100.0, 100.4));
  gapFirst.push(bar(23, 100.2, 100.3, 97.9, 98.6)); // sweeps the low
  for (let i = 24; i < 34; i++) gapFirst.push(bar(i, 98.6, 99.0, 98.4, 98.7));
  assert.deepEqual(findAmd(gapFirst, null, opts), []);
});

test("the far side of the range must still be worth reaching when the gap forms", () => {
  assert.equal(findAmd(bullish(rally), null, { minRewardRisk: 0 }).length, 1);
  const s = findAmd(bullish(rally), null, { minRewardRisk: 0 })[0];
  const required = Math.ceil((s.plan.riskReward + 0.01) * 10) / 10;
  assert.equal(findAmd(bullish(rally), null, { minRewardRisk: required }).length, 0);
  assert.equal(findAmd(bullish(rally), null, { minRewardRisk: s.plan.riskReward - 0.01 }).length, 1);
});

/** Seeded noise with regular squeezes and spikes, so that setups appear now and then. */
function noisy(seed, n = 700) {
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

test("no look-ahead: what was signalled at candle i does not change when later candles arrive", () => {
  let total = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const candles = noisy(seed);
    const full = findAmd(candles, null, { minRewardRisk: 0 });
    total += full.length;
    const strip = (s) => JSON.stringify([s.id, s.range, s.manipulation, s.fvg, s.plan]);
    for (let i = 30; i < candles.length; i += 7) {
      const prefix = findAmd(candles.slice(0, i + 1), null, { minRewardRisk: 0 });
      assert.deepEqual(prefix.map(strip), full.filter((s) => s.formedAt <= i).map(strip), `seed ${seed} prefix ${i}`);
    }
  }
  assert.ok(total >= 5, `expected the noisy data to produce setups, got ${total}`);
});

test("the strategy buys when a bullish gap forms and exits on a bearish one, with the plan as its stops", () => {
  const strategy = STRATEGY_BY_ID.amd_fvg;
  assert.ok(strategy);
  const up = bullish(rally);
  const upCtx = buildContext(up);
  assert.equal(upCtx.amd.length, 1, "the default settings accept the reference sequence");
  const hit = strategy.evaluate(upCtx, 22);
  assert.equal(hit.signal, "BUY");
  const plan = upCtx.amd[0].plan;
  assert.equal(hit.stopLoss, plan.stopLoss);
  assert.equal(hit.takeProfit, plan.target);
  assert.ok(hit.stopLoss < up[22].close && hit.takeProfit > up[22].close);
  assert.equal(strategy.evaluate(upCtx, 21).signal, "HOLD", "nothing before the gap has formed");
  assert.equal(strategy.evaluate(upCtx, 23).signal, "HOLD", "and it fires once, on the signal candle");

  const downCtx = buildContext(flip(up));
  assert.equal(strategy.evaluate(downCtx, 22).signal, "SELL");
});
