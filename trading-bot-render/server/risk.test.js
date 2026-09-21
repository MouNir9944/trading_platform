import assert from "node:assert/strict";
import test from "node:test";

import {
  RISK_DEFAULTS, checkOrder, computeCapital, computeRiskState, estimateTrade, lossAfterStreak, normalizeSettings, sizeByRisk, tradeStats,
} from "../shared/risk.js";

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);
const NOW = Date.parse("2026-09-19T15:00:00Z");
const minutesAgo = (m) => new Date(NOW - m * 60_000).toISOString();
const S = (patch = {}) => normalizeSettings(patch);

let n = 0;
const closed = (pnl, closedAt) => ({ id: `c${n++}`, status: "CLOSED", realized_profit_usdt: pnl, closed_at: closedAt, created_at: closedAt });
const open = (risk, capital = 100, status = "WAITING_ENTRY") => ({ id: `o${n++}`, status, estimated_loss_usdt: risk, capital_usdt: capital, created_at: minutesAgo(5) });

const state = (orders, settings = S(), capital = 1000) => computeRiskState({ orders, settings, capital, now: NOW });

test("settings are validated and merged", () => {
  assert.deepEqual(normalizeSettings({}), { ...RISK_DEFAULTS });
  const next = normalizeSettings({ riskPerTradePct: 0.5, paused: true }, S({ maxLossStreak: 5 }));
  assert.equal(next.riskPerTradePct, 0.5);
  assert.equal(next.paused, true);
  assert.equal(next.maxLossStreak, 5);
  for (const bad of [{ riskPerTradePct: 0 }, { riskPerTradePct: 50 }, { maxLossStreak: 2.5 }, { enabled: "yes" }, { capitalMode: "sometimes" }, { nope: 1 }, { drawdownResetAt: "yesterday-ish" }, { fixedCapital: -5 }, { maxPositionPct: "abc" }]) {
    assert.throws(() => normalizeSettings(bad), Error, JSON.stringify(bad));
  }
  assert.equal(normalizeSettings({ drawdownResetAt: null }).drawdownResetAt, null);
});

test("capital: account equity includes money sitting in filled positions; fixed mode ignores the account", () => {
  const orders = [{ status: "PROTECTED", capital_usdt: 200 }, { status: "WAITING_ENTRY", capital_usdt: 100 }, { status: "CLOSED", capital_usdt: 50 }];
  assert.equal(computeCapital(S(), { quoteTotal: 800, orders }), 1000); // 800 + the 200 already in a position
  assert.equal(computeCapital(S(), { quoteTotal: null, orders }), null);
  assert.equal(computeCapital(S({ capitalMode: "fixed", fixedCapital: 2500 }), { quoteTotal: 1, orders }), 2500);
});

test("daily loss limit halts trading for the rest of the UTC day only", () => {
  const settings = S(); // 3% of 1000 = 30 USDT
  assert.equal(state([closed(-25, minutesAgo(30))]).status, "warning"); // 83% used, still allowed
  assert.equal(state([closed(-25, minutesAgo(30))]).blockers.length, 0);

  const halted = state([closed(-20, minutesAgo(90)), closed(-12, minutesAgo(30))], settings);
  assert.equal(halted.status, "halted");
  assert.equal(halted.blockers[0].code, "daily_loss");
  assert.equal(halted.todayPnl, -32);
  assert.equal(halted.dailyLossLimit, 30);

  // A win earlier the same day offsets losses (the limit is on NET p&l)
  assert.equal(state([closed(+20, minutesAgo(120)), closed(-32, minutesAgo(30))]).blockers.length, 0);
  // Yesterday's loss does not count
  assert.equal(state([closed(-100, "2026-09-18T20:00:00Z")]).todayPnl, 0);
});

test("loss streak triggers a cooldown that expires", () => {
  const streak = [closed(-1, minutesAgo(200)), closed(-1, minutesAgo(150)), closed(-1, minutesAgo(20))];
  const cooling = state(streak);
  assert.equal(cooling.lossStreak, 3);
  assert.equal(cooling.blockers.find((b) => b.code === "loss_streak") !== undefined, true);
  assert.equal(cooling.cooldownUntil, NOW - 20 * 60_000 + 60 * 60_000);

  const expired = state([closed(-1, minutesAgo(400)), closed(-1, minutesAgo(300)), closed(-1, minutesAgo(200))]);
  assert.equal(expired.blockers.length, 0); // 200 min ago + 60 min cooldown is over
  assert.equal(expired.lossStreak, 3);

  assert.equal(state([closed(-1, minutesAgo(200)), closed(+1, minutesAgo(100)), closed(-1, minutesAgo(20))]).lossStreak, 1); // a win resets it
});

test("drawdown halts until the baseline is reset", () => {
  const trades = [closed(+80, "2026-09-10T10:00:00Z"), closed(-60, "2026-09-11T10:00:00Z"), closed(-50, "2026-09-12T10:00:00Z")];
  const s = state(trades, S({ maxDailyLossPct: 50 }));
  assert.equal(s.drawdownUsd, 110); // peak 80 -> current -30
  near(s.drawdownPct, 11);
  assert.equal(s.blockers.find((b) => b.code === "drawdown") !== undefined, true);

  const reset = state(trades, S({ maxDailyLossPct: 50, drawdownResetAt: "2026-09-13T00:00:00Z" }));
  assert.equal(reset.drawdownUsd, 0);
  assert.equal(reset.blockers.length, 0);
});

test("open risk, pause switch, disabled mode and unknown capital", () => {
  const s = state([open(10), open(15, 100, "PROTECTED"), closed(-5, "2026-09-01T00:00:00Z")]);
  assert.equal(s.openRisk, 25);
  assert.equal(s.openCount, 2);
  near(s.openRiskPct, 2.5);

  const paused = state([], S({ paused: true }));
  assert.equal(paused.status, "halted");
  assert.equal(paused.blockers[0].code, "paused");

  const off = state([closed(-500, minutesAgo(10))], S({ enabled: false }));
  assert.equal(off.status, "off");
  assert.equal(off.blockers.length, 0); // limits are not enforced when disabled...
  assert.equal(state([], S({ enabled: false, paused: true })).blockers.length, 1); // ...but the kill switch always is

  const unknown = state([closed(-500, minutesAgo(10))], S(), null);
  assert.equal(unknown.capitalKnown, false);
  assert.equal(unknown.blockers.length, 0);
});

const ORDER = { entry: 100, stop: 98, target: 106, feePercent: 0.1 };

test("estimateTrade is fee-aware", () => {
  const t = estimateTrade({ ...ORDER, quantity: 1 });
  near(t.riskUsd, 100 * 1.001 - 98 * 0.999);
  near(t.rewardUsd, 106 * 0.999 - 100 * 1.001);
  assert.equal(t.positionValue, 100);
});

test("checkOrder approves a sane trade and explains each broken rule", () => {
  const st = state([]);
  const ok = checkOrder({ settings: S(), state: st, order: { ...ORDER, quantity: 1 } }); // 100 USDT position, ~2.2 USDT risk
  assert.equal(ok.allowed, true);
  near(ok.riskPct, 0.2198, 1e-3);
  near(ok.rewardRisk, 2.7, 0.1);

  const codes = (order, settings = S(), s = st) => checkOrder({ settings, state: s, order }).violations.map((v) => v.code);
  assert.deepEqual(codes({ ...ORDER, quantity: 6 }), ["risk_per_trade", "position_size"]); // 600 USDT: 1.3% risk, 60% of capital
  assert.deepEqual(codes({ ...ORDER, quantity: 1, target: 101 }), ["reward_risk"]);
  assert.deepEqual(codes({ ...ORDER, quantity: 1 }, S(), state([open(29)])), ["open_risk"]); // 29 + 2.2 > 30
  assert.deepEqual(codes({ ...ORDER, quantity: 1 }, S({ paused: true }), state([], S({ paused: true }))), ["paused"]);
  assert.deepEqual(codes({ ...ORDER, quantity: 6 }, S({ enabled: false }), state([], S({ enabled: false }))), []);

  const halted = state([closed(-40, minutesAgo(10))]);
  assert.equal(checkOrder({ settings: S(), state: halted, order: { ...ORDER, quantity: 1 } }).allowed, false);
});

test("suggestedPositionValue is the largest size that passes every limit", () => {
  const settings = S({ riskPerTradePct: 1, maxPositionPct: 25, maxOpenRiskPct: 3 });
  for (const openRisk of [0, 20, 28]) {
    const st = state(openRisk ? [open(openRisk)] : [], settings);
    const first = checkOrder({ settings, state: st, order: { ...ORDER, quantity: 1 } });
    const value = first.suggestedPositionValue;
    assert.ok(value >= 0);
    if (value > 0) {
      const passes = checkOrder({ settings, state: st, order: { ...ORDER, quantity: value / ORDER.entry } });
      assert.equal(passes.violations.filter((v) => ["risk_per_trade", "position_size", "open_risk"].includes(v.code)).length, 0, `open risk ${openRisk}: ${JSON.stringify(passes.violations)}`);
      const bigger = checkOrder({ settings, state: st, order: { ...ORDER, quantity: (value + 1) / ORDER.entry } });
      assert.ok(bigger.violations.some((v) => ["risk_per_trade", "position_size", "open_risk"].includes(v.code)), "one dollar more must break a limit");
    }
  }
  // Risk-limited: 1% of 1000 = 10 USDT, per $ of position (1.001 - .98*.999) = 0.02198 -> ~455 USDT, but the 25% cap (250) binds first
  assert.equal(checkOrder({ settings, state: state([], settings), order: { ...ORDER, quantity: 1 } }).suggestedPositionValue, 250);
  const tightStop = checkOrder({ settings, state: state([], settings), order: { entry: 100, stop: 90, target: 130, feePercent: 0.1, quantity: 1 } });
  near(tightStop.suggestedPositionValue, 10 / (1.001 - 0.9 * 0.999), 0.01); // risk-limited
});

test("sizeByRisk risks exactly the requested share of capital", () => {
  const value = sizeByRisk({ capital: 2000, riskPct: 1, stopPct: 2, feePercent: 0.1 });
  const t = estimateTrade({ entry: 100, stop: 98, target: 110, quantity: value / 100, feePercent: 0.1 });
  near(t.riskUsd, 20, 1e-6);
  assert.ok(value > 0 && value < 2000);
});

test("loss streak arithmetic and trade statistics", () => {
  near(lossAfterStreak(1, 10), 0.0956, 1e-4);
  const stats = tradeStats([closed(10, "2026-09-01T00:00:00Z"), closed(-5, "2026-09-02T00:00:00Z"), closed(-5, "2026-09-03T00:00:00Z"), closed(20, "2026-09-04T00:00:00Z")]);
  assert.equal(stats.trades, 4);
  assert.equal(stats.winRate, 50);
  assert.equal(stats.avgWin, 15);
  assert.equal(stats.avgLoss, -5);
  assert.equal(stats.profitFactor, 3);
  assert.equal(stats.expectancy, 5);
  assert.equal(stats.totalPnl, 20);
  assert.equal(stats.maxDrawdownUsd, 10);
  assert.equal(stats.maxLossStreak, 2);
  assert.equal(tradeStats([]).winRate, null);
});

// ---- risk-based ticket setup ----
import { riskSetup } from "../shared/risk.js";

const setupState = (over = {}) => ({ ...state([]), ...over });
const setup = (o = {}) => riskSetup({ settings: S(), state: state([]), price: 100, atrPct: 0.6, availableQuote: 1000, feePercent: 0.1, minNotional: 5, ...o });

test("riskSetup: stop follows volatility within sane bounds", () => {
  assert.equal(setup({ atrPct: 0.6 }).stopPct, 0.9); // 1.5 x ATR
  assert.equal(setup({ atrPct: 0.1 }).stopPct, 0.4); // never tighter than 0.4%
  assert.equal(setup({ atrPct: 9 }).stopPct, 6); // never wider than 6%
  assert.equal(setup({ atrPct: null }).stopPct, 1);
  assert.equal(setup({ atrPct: null }).atrBased, false);
});

test("riskSetup: the target earns at least 2x the risk after fees, and the size passes every rule", () => {
  for (const atrPct of [0.2, 0.6, 1.5, 4]) {
    const s = setup({ atrPct });
    const t = estimateTrade({ entry: 100, stop: 100 * (1 - s.stopPct / 100), target: 100 * (1 + s.targetPct / 100), quantity: s.positionValue / 100, feePercent: 0.1 });
    assert.ok(t.rewardUsd / t.riskUsd >= 2 - 1e-9, `atr ${atrPct}: R:R ${t.rewardUsd / t.riskUsd}`);
    const verdict = checkOrder({ settings: S(), state: state([]), order: { entry: 100, stop: 100 * (1 - s.stopPct / 100), target: 100 * (1 + s.targetPct / 100), quantity: s.positionValue / 100, feePercent: 0.1 } });
    assert.equal(verdict.allowed, true, JSON.stringify(verdict.violations));
    assert.ok(s.riskPct <= 1 + 1e-9);
    assert.equal(s.tradable, true);
  }
  // a higher minimum R:R raises the target
  assert.ok(setup({ atrPct: 0.6 }).targetPct < riskSetup({ settings: S({ minRewardRisk: 3 }), state: state([]), price: 100, atrPct: 0.6, availableQuote: 1000, feePercent: 0.1 }).targetPct);
});

test("riskSetup reports which limit binds", () => {
  // 1000 capital, 0.9% stop: risk limit = 10/0.0102 = 980, position cap = 250 -> the position cap binds
  assert.equal(setup().limitedBy, "max position size");
  assert.equal(setup().positionValue, 250);
  // wide stop shrinks the risk-based size below the cap
  const wide = setup({ atrPct: 4 }); // 6% stop -> ~10 / 0.0612 = 163
  assert.equal(wide.limitedBy, "risk per trade");
  assert.ok(wide.positionValue > 150 && wide.positionValue < 175);
  // not enough money to spend
  const poor = setup({ availableQuote: 40 });
  assert.equal(poor.limitedBy, "available balance");
  near(poor.positionValue, 39.96, 0.01);
  assert.equal(poor.percentOfAvailable, 100);
  // open risk budget nearly used up
  assert.equal(setup({ state: state([open(29)]) }).limitedBy, "open risk budget");
});

test("riskSetup flags setups that cannot be traded", () => {
  const tiny = setup({ availableQuote: 2.71, minNotional: 5 }); // the real-world case: 2.71 USDT to trade
  assert.equal(tiny.tradable, false);
  assert.match(tiny.issues[0], /below Binance's minimum order of 5 USDT/);
  assert.match(setup({ availableQuote: 0 }).issues[0], /no free balance/);
  assert.match(setup({ state: state([open(30)]) }).issues[0], /open risk budget limit leaves no room/);
  assert.match(riskSetup({ settings: S(), state: state([], S(), null), price: 100, atrPct: 0.6, availableQuote: 1000, feePercent: 0.1 }).issues[0], /capital is not known/);
  assert.equal(setup({ minNotional: 0, availableQuote: 2.71 }).tradable, true); // no exchange minimum known
});

test("riskSetup adapts the stop bounds to the asset class", () => {
  const forex = setup({ atrPct: 0.02, category: "forex" }); // EUR/USDT: tiny ATR
  assert.equal(forex.stopPct, 0.1);
  assert.ok(forex.targetPct < 1, `forex target ${forex.targetPct}% must be inside a currency's daily range`);
  assert.equal(setup({ atrPct: 0.02 }).stopPct, 0.4, "crypto keeps its 0.4% floor");
  assert.equal(setup({ atrPct: 0.05, category: "stock" }).stopPct, 0.3);
  assert.equal(setup({ atrPct: 9, category: "forex" }).stopPct, 1.5);
  assert.equal(setup({ atrPct: 9, category: "stock" }).stopPct, 4);
  assert.equal(setup({ atrPct: null, category: "forex" }).stopPct, 1); // no volatility data: a modest default, capped by the class
  assert.equal(setup({ atrPct: 0.6, category: "made-up" }).stopPct, 0.9, "unknown classes fall back to crypto bounds");
});
