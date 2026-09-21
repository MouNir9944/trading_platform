import assert from "node:assert/strict";
import test from "node:test";

import {
  STRATEGIES, activeFvgs, activeOrderBlocks, analyze, analyzeSmc, analyzeStructure, backtest, buildContext, findFvgs, findLiquidity, findOrderBlocks, premiumDiscount,
} from "../shared/analysis/index.js";

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);
let t = 1_700_000_000;
const bar = (open, high, low, close) => ({ time: (t += 300), open, high, low, close, volume: 100, closeTime: null });
const flatAtr = (n, value = 1) => new Array(n).fill(value);

function fromCloses(closes, wick = 0.05) {
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    return { time: 1_700_000_000 + i * 300, open, high: Math.max(open, close) + wick, low: Math.min(open, close) - wick, close, volume: 100, closeTime: null };
  });
}

function zigzag(points, leg = 6) {
  const out = [points[0]];
  for (let p = 1; p < points.length; p++) for (let k = 1; k <= leg; k++) out.push(points[p - 1] + ((points[p] - points[p - 1]) * k) / leg);
  return out;
}

test("bullish FVG: detected, then touched, then filled, with the state visible at each candle", () => {
  const candles = [
    bar(9.5, 10, 9, 9.8), // 0: high 10
    bar(10, 13, 9.9, 12.8), // 1: the impulse
    bar(12.8, 13.5, 11, 13.2), // 2: low 11 > candle 0 high 10 -> gap [10, 11]
    bar(13.2, 13.3, 10.8, 11.5), // 3: dips into the gap (low 10.8 <= top 11)
    bar(11.5, 11.6, 9.9, 10.1), // 4: trades through the bottom -> filled
  ];
  const gaps = findFvgs(candles, flatAtr(5));
  assert.equal(gaps.length, 1);
  const g = gaps[0];
  assert.deepEqual([g.type, g.bottom, g.top, g.size], ["bull", 10, 11, 1]);
  assert.deepEqual([g.index, g.formedAt, g.touchedAt, g.filledAt], [1, 2, 3, 4]);
  assert.equal(g.fillPct, 1);
  assert.equal(g.time, candles[1].time); // drawn from the middle candle

  const smc = { fvgs: gaps, orderBlocks: [] };
  assert.equal(activeFvgs(smc, 1).length, 0, "not known before candle 2 closed");
  assert.equal(activeFvgs(smc, 2).length, 1);
  assert.equal(activeFvgs(smc, 3).length, 1, "touched but still open");
  assert.equal(activeFvgs(smc, 4).length, 0, "filled at candle 4");

  const partial = findFvgs(candles.slice(0, 4), flatAtr(4))[0];
  assert.equal(partial.filledAt, null);
  near(partial.fillPct, 0.2); // (11 - 10.8) / 1
});

test("bearish FVG mirrors the bullish one; overlapping wicks and tiny gaps are ignored", () => {
  const candles = [
    bar(20, 21, 19, 19.5),
    bar(19.5, 19.6, 15, 15.4),
    bar(15.4, 18, 14.5, 14.8), // high 18 < candle 0 low 19 -> gap [18, 19]
    bar(14.8, 18.4, 14.7, 17.9), // pokes into it, does not fill
  ];
  const [g] = findFvgs(candles, flatAtr(4));
  assert.deepEqual([g.type, g.bottom, g.top, g.touchedAt, g.filledAt], ["bear", 18, 19, 3, null]);

  assert.equal(findFvgs([bar(9, 10, 8.5, 9.5), bar(9.5, 12, 9.2, 11.5), bar(11.5, 12.5, 9.9, 12)], flatAtr(3)).length, 0, "wicks overlap: no gap");
  assert.equal(findFvgs([bar(9, 10, 8.5, 9.5), bar(9.5, 12, 9.2, 11.5), bar(11.5, 12.5, 10.1, 12)], flatAtr(3)).length, 0, "a 0.1 gap is below 0.15 ATR");
  assert.equal(findFvgs([bar(9, 10, 8.5, 9.5), bar(9.5, 12, 9.2, 11.5), bar(11.5, 12.5, 10.1, 12)], flatAtr(3, 0.1)).length, 1, "the same gap counts when the market is quiet");
});

test("order block: last down candle before the up-move that broke structure, mitigated when price closes through it", () => {
  const path = zigzag([30, 25, 28, 20, 24, 15, 19, 12, 26, 20, 34]);
  const candles = fromCloses(path);
  const structure = analyzeStructure(candles);
  const blocks = findOrderBlocks(candles, structure);
  const bull = blocks.filter((b) => b.type === "bull");
  assert.ok(bull.length >= 1);
  const ob = bull[0];
  assert.equal(candles[ob.index].close < candles[ob.index].open, true, "it is a down candle");
  assert.equal(ob.bottom, candles[ob.index].low);
  assert.equal(ob.top, candles[ob.index].high);
  assert.ok(ob.formedAt > ob.index, "it becomes known at the break, after the block itself");
  assert.equal(ob.breakType, "CHoCH");
  assert.equal(ob.mitigatedAt, null);
  for (const b of blocks) assert.ok(b.top >= b.bottom);

  // price later collapses through the block: mitigated
  const longer = fromCloses([...path, ...zigzag([34, 5], 8).slice(1)]);
  const mitigated = findOrderBlocks(longer, analyzeStructure(longer)).find((b) => b.index === ob.index && b.type === "bull");
  assert.ok(mitigated.mitigatedAt > mitigated.formedAt);
  const smc = { fvgs: [], orderBlocks: [mitigated] };
  assert.equal(activeOrderBlocks(smc, mitigated.formedAt).length, 1);
  assert.equal(activeOrderBlocks(smc, mitigated.mitigatedAt).length, 0);
  assert.equal(activeOrderBlocks(smc, mitigated.formedAt - 1).length, 0, "not known before the break");
});

test("liquidity: equal highs form a pool; a wick-and-close-back is a sweep, a close beyond is a break", () => {
  const base = fromCloses(zigzag([10, 20, 12, 20.02, 11, 18]));
  const pools = (candles) => findLiquidity(candles, analyzeStructure(candles), flatAtr(candles.length));
  const [pool] = pools(base).filter((p) => p.type === "high");
  assert.equal(pool.touches, 2);
  near(pool.price, 20.07, 0.06); // the two highs including their wicks
  assert.equal(pool.sweptAt, null);
  assert.equal(pool.brokenAt, null);

  const swept = [...base, bar(18, 21.5, 17.8, 19.0)]; // wicks above the level, closes back below
  const s = pools(swept).find((p) => p.type === "high");
  assert.equal(s.sweptAt, swept.length - 1);
  assert.equal(s.brokenAt, null);

  const broken = [...base, bar(18, 22, 17.8, 21.6)]; // closes above: a genuine break
  const b = pools(broken).find((p) => p.type === "high");
  assert.equal(b.brokenAt, broken.length - 1);
  assert.equal(b.sweptAt, null);

  assert.equal(pools(fromCloses(zigzag([10, 20, 12, 25, 11, 18]))).filter((p) => p.type === "high").length, 0, "highs 20 and 25 are not equal");
});

test("premium / discount uses the swing range and stays within 0..100% after a breakout", () => {
  const swings = [{ type: "low", price: 10, time: 1 }, { type: "high", price: 20, time: 2 }];
  assert.deepEqual([12, 15, 18].map((p) => premiumDiscount(swings, p).zone), ["discount", "equilibrium", "premium"]);
  near(premiumDiscount(swings, 12).position, 0.2);
  near(premiumDiscount(swings, 15).equilibrium, 15);
  const up = premiumDiscount(swings, 25);
  assert.equal(up.brokeOut, "above");
  assert.equal(up.position, 1);
  assert.equal(up.high, 25);
  assert.equal(premiumDiscount(swings, 4).position, 0);
  assert.equal(premiumDiscount([{ type: "high", price: 20 }], 15), null);
});

function walk(n, seed) {
  let s = seed;
  const rand = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const closes = [100];
  for (let i = 1; i < n; i++) closes.push(Math.max(1, closes[i - 1] + (rand() - 0.5) * 2 + Math.sin(i / 9) * 0.6));
  return fromCloses(closes, 0.3);
}

test("the smart-money strategy is registered, never looks ahead, and produces sane stops", () => {
  const strategy = STRATEGIES.find((s) => s.id === "smc_zone");
  assert.ok(strategy);
  let buys = 0;
  let sells = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    const candles = walk(260, seed);
    const full = buildContext(candles);
    for (let i = 40; i < candles.length; i++) {
      const r = strategy.evaluate(full, i);
      if (r.signal === "BUY") {
        buys++;
        assert.ok(r.stopLoss < candles[i].close && r.takeProfit > candles[i].close, `seed ${seed} @${i}`);
      }
      if (r.signal === "SELL") sells++;
      if (i % 9 === 0) {
        // the answer must not depend on candles that do not exist yet
        const prefix = strategy.evaluate(buildContext(candles.slice(0, i + 1)), i);
        assert.equal(prefix.signal, r.signal, `seed ${seed} @${i}: full=${r.signal} prefix=${prefix.signal}`);
        assert.equal(prefix.stopLoss ?? null, r.stopLoss ?? null);
      }
    }
  }
  assert.ok(buys + sells >= 5, `expected some signals in the sample, got ${buys} buys / ${sells} sells`);
});

test("analyze() exposes the smart-money zones and backtests run on them", () => {
  const candles = fromCloses(zigzag([100, 120, 108, 130, 115, 150, 130, 160], 12), 0.4);
  const a = analyze(candles);
  assert.ok(a.smc && Array.isArray(a.smc.fvgs) && Array.isArray(a.smc.orderBlocks) && Array.isArray(a.smc.liquidity));
  assert.ok(a.smc.premiumDiscount === null || typeof a.smc.premiumDiscount.position === "number");
  assert.equal(a.signals.some((s) => s.id === "smc_zone"), true);
  const result = backtest(candles, "smc_zone");
  assert.equal(result.stats.trades, result.trades.length);
  assert.ok(analyzeSmc(candles, analyzeStructure(candles), flatAtr(candles.length)).fvgs.length >= 0);
});
