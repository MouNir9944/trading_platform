import assert from "node:assert/strict";
import test from "node:test";

import { STRATEGIES, STRATEGY_BY_ID, defaultParams, detectSignals, resolveParams, strategyInfo } from "../shared/strategies/index.js";
import { backtestStrategy } from "../shared/strategies/trade.js";

/**
 * Every registered strategy is held to the same contract, so a strategy added later is tested just by being in the
 * registry. This is where "no look-ahead" is enforced.
 */

const bar = (i, open, high, low, close) => ({ time: 1_700_000_000 + i * 900, open, high, low, close, volume: 100 + ((i * 37) % 50) });

/** Seeded random walk with squeezes, trends and spikes, so that most strategies find something. */
function series(seed, n = 1100) {
  let x = seed;
  const rand = () => { x = (x * 1664525 + 1013904223) % 4294967296; return x / 4294967296; };
  const out = [];
  let price = 100;
  let drift = 0;
  for (let i = 0; i < n; i++) {
    if (i % 90 === 0) drift = (rand() - 0.45) * 0.25;
    const squeeze = Math.floor(i / 45) % 2 === 0;
    const step = drift + (rand() - 0.5) * (squeeze ? 0.6 : 2.4);
    const open = price;
    const close = Math.max(1, price + step);
    const spike = rand() < 0.08 ? rand() * 1.6 : 0;
    out.push(bar(i, open, Math.max(open, close) + rand() * 0.4 + (rand() < 0.5 ? spike : 0), Math.min(open, close) - rand() * 0.4 - (rand() < 0.5 ? spike : 0), close));
    price = close;
  }
  return out;
}

const SEEDS = [1, 2, 3, 4];
const tradingFields = (s) => JSON.stringify([s.dir, s.formedAt, s.entry, s.stop, s.target, s.retest ?? null]);

test("the registry: unique ids and a complete, serialisable description of every strategy", () => {
  assert.ok(STRATEGIES.length >= 8, "AMD and the classic strategies are all registered");
  assert.equal(new Set(STRATEGIES.map((s) => s.id)).size, STRATEGIES.length, "ids are unique");
  for (const s of STRATEGIES) {
    assert.ok(s.id && s.name && s.summary && s.description, `${s.id}: text`);
    assert.ok(Array.isArray(s.directions) && s.directions.length && s.directions.every((d) => d === "long" || d === "short"), `${s.id}: directions`);
    assert.equal(typeof s.supportsRetest, "boolean", `${s.id}: supportsRetest`);
    assert.equal(typeof s.detect, "function", `${s.id}: detect`);
    for (const p of s.params) {
      assert.ok(p.key && p.label && p.min < p.max, `${s.id}.${p.key}: bounds`);
      assert.ok(p.default >= p.min && p.default <= p.max, `${s.id}.${p.key}: default inside the bounds`);
    }
    const info = strategyInfo(s);
    assert.ok(!("detect" in info));
    assert.deepEqual(JSON.parse(JSON.stringify(info)), info, `${s.id}: info survives JSON`);
    assert.equal(STRATEGY_BY_ID[s.id], s);
  }
});

test("params: defaults fill in, bounds and unknown names are refused", () => {
  const amd = STRATEGY_BY_ID.amd_fvg;
  assert.deepEqual(resolveParams(amd), defaultParams(amd));
  assert.equal(resolveParams(amd, { minRangeBars: 12 }).minRangeBars, 12);
  assert.equal(resolveParams(amd, { minRangeBars: "12" }).minRangeBars, 12);
  assert.throws(() => resolveParams(amd, { minRangeBars: 2 }), /between 4 and 40/);
  assert.throws(() => resolveParams(amd, { minRangeBars: 10.5 }), /whole number/);
  assert.throws(() => resolveParams(amd, { maxRangeAtr: "wide" }), /between/);
  assert.throws(() => resolveParams(amd, { nope: 1 }), /no setting called "nope"/);
  assert.throws(() => resolveParams(STRATEGY_BY_ID.supertrend, { x: 1 }), /no setting/);
});

for (const strategy of STRATEGIES) {
  test(`${strategy.id}: signals are well formed, pure, and do not modify the candles`, () => {
    let found = 0;
    for (const seed of SEEDS) {
      const candles = series(seed);
      const frozen = candles.map((c) => Object.freeze({ ...c }));
      const signals = detectSignals(strategy, frozen);
      assert.deepEqual(signals.map(tradingFields), detectSignals(strategy, frozen).map(tradingFields), "the same candles give the same signals");
      assert.ok(signals.every((s, i) => !i || signals[i - 1].formedAt <= s.formedAt), "oldest first");
      for (const s of signals) {
        found += 1;
        assert.ok(s.dir === "bull" || s.dir === "bear", "direction");
        assert.ok(Number.isInteger(s.formedAt) && s.formedAt >= 0 && s.formedAt < candles.length, "formedAt is a candle index");
        assert.ok(strategy.directions.includes(s.dir === "bull" ? "long" : "short"), `${strategy.id} produced a direction it does not declare`);
        for (const k of ["entry", "stop", "target"]) assert.ok(Number.isFinite(s[k]), `${k} is a number`);
        const sign = s.dir === "bull" ? 1 : -1;
        assert.ok(sign * (s.entry - s.stop) > 0, "the stop is beyond the entry");
        if (strategy.id !== "amd_fvg") assert.ok(sign * (s.target - s.entry) > 0, "the target is on the profit side"); // AMD lets the trade layer refuse a target already passed
        assert.ok(Array.isArray(s.reasons) && s.reasons.length > 0 && s.reasons.every((r) => typeof r === "string"), "reasons");
        if (s.retest != null) {
          assert.ok(strategy.supportsRetest, "a retest price without declaring support");
          assert.ok(sign * (s.retest - s.stop) > 0, "the retest price is on the safe side of the stop");
        }
      }
    }
    console.log(`  ${strategy.id}: ${found} signals over ${SEEDS.length} series`);
  });

  test(`${strategy.id}: NO LOOK-AHEAD, a signal on candle i is the same whether or not later candles exist`, () => {
    assert.deepEqual(lookAheadViolations(strategy), []);
  });
}

/** Where a strategy's signals change when later candles are added: an empty list means no look-ahead. */
function lookAheadViolations(strategy, params = {}) {
  const problems = [];
  for (const seed of SEEDS) {
    const candles = series(seed);
    const full = detectSignals(strategy, candles, params);
    for (const cut of [250, 420, 610, 800, 1000]) {
      const prefix = detectSignals(strategy, candles.slice(0, cut + 1), params).map(tradingFields);
      const early = full.filter((s) => s.formedAt <= cut).map(tradingFields);
      if (JSON.stringify(prefix) !== JSON.stringify(early)) problems.push(`${strategy.id} seed ${seed} cut ${cut}: signals up to candle ${cut} changed when later candles were added`);
    }
  }
  return problems;
}

test("the look-ahead check really catches a strategy that peeks at the next candle", () => {
  const cheat = {
    id: "cheat", name: "cheat", summary: "x", description: "x", directions: ["long"], supportsRetest: false, params: [],
    detect: (candles) => candles.flatMap((c, i) => (i > 60 && i < candles.length - 1 && candles[i + 1].close > c.close * 1.004
      ? [{ dir: "bull", formedAt: i, entry: c.close, stop: c.close * 0.99, target: c.close * 1.02, reasons: ["knows the next candle"] }] : [])),
  };
  assert.ok(lookAheadViolations(cheat).length > 0);
});

test("every setting of every strategy does something, stays valid at its limits, and never looks ahead", () => {
  const candles = series(3);
  for (const strategy of STRATEGIES) {
    const base = detectSignals(strategy, candles).map(tradingFields);
    let changed = 0;
    for (const spec of strategy.params) {
      for (const value of [spec.min, spec.max]) {
        const params = { [spec.key]: value };
        const signals = detectSignals(strategy, candles, params);
        for (const s of signals) {
          const sign = s.dir === "bull" ? 1 : -1;
          assert.ok(Number.isFinite(s.entry) && sign * (s.entry - s.stop) > 0, `${strategy.id} ${spec.key}=${value}: a valid stop`);
        }
        if (JSON.stringify(signals.map(tradingFields)) !== JSON.stringify(base)) changed += 1;
        assert.deepEqual(lookAheadViolations(strategy, params), [], `${strategy.id} ${spec.key}=${value}: look-ahead`);
      }
    }
    if (strategy.params.length) assert.ok(changed >= Math.ceil(strategy.params.length / 2), `${strategy.id}: most settings should change the signals (${changed} of ${strategy.params.length * 2} changed)`);
  }
});

test("a setting changes what the strategy does in the way its label says", () => {
  const candles = series(2);
  const count = (id, params) => detectSignals(STRATEGY_BY_ID[id], candles, params).length;
  // a wider stop and a bigger multiple move the levels, not the number of signals
  const a = detectSignals(STRATEGY_BY_ID.macd_momentum, candles, { stopAtr: 1 });
  const b = detectSignals(STRATEGY_BY_ID.macd_momentum, candles, { stopAtr: 3 });
  assert.equal(a.length, b.length);
  assert.ok(a.every((s, i) => s.formedAt === b[i].formedAt && s.stop > b[i].stop), "a 3 ATR stop is further away than a 1 ATR stop");
  const c = detectSignals(STRATEGY_BY_ID.supertrend, candles, { rewardR: 1 });
  const d = detectSignals(STRATEGY_BY_ID.supertrend, candles, { rewardR: 4 });
  assert.ok(c.every((s, i) => d[i].target - s.entry > s.target - s.entry), "a 4R target is further than a 1R target");
  // stricter entry rules give fewer signals
  assert.ok(count("rsi_reversal", { oversold: 15 }) <= count("rsi_reversal", { oversold: 45 }));
  assert.ok(count("amd_fvg", { minRangeBars: 30 }) <= count("amd_fvg", { minRangeBars: 6 }));
  // an impossible combination is a hold, not a crash
  assert.deepEqual(detectSignals(STRATEGY_BY_ID.ma_cross, candles, { fastPeriod: 50, slowPeriod: 10 }), []);
});

test("every strategy can be backtested end to end, with numbers that add up", () => {
  const datasets = [{ symbol: "AAA", candles: series(1) }, { symbol: "BBB", candles: series(2) }];
  for (const strategy of STRATEGIES) {
    const r = backtestStrategy(datasets, { strategy, trade: { minRewardRisk: 0 } });
    assert.equal(r.perSymbol.length, 2, strategy.id);
    assert.equal(r.combined.trades, r.perSymbol[0].stats.trades + r.perSymbol[1].stats.trades, `${strategy.id}: pooled trades`);
    assert.equal(r.trades.length, r.combined.trades);
    assert.equal(r.counts.filled, r.combined.trades);
    assert.ok(r.verdict.label, `${strategy.id}: verdict`);
    for (const t of r.trades) {
      assert.ok(Number.isFinite(t.r) && (t.reason === "target" || t.reason === "stop"), `${strategy.id}: trade result`);
      assert.ok(t.entryIndex > t.signalIndex, "an order fills after the signal candle, never on it");
      assert.ok(t.exitIndex >= t.entryIndex);
    }
    if (strategy.directions.length === 1) assert.ok(r.trades.every((t) => t.side === "long"), `${strategy.id}: only declared directions trade`);
  }
});
