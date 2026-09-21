/**
 * Trading the AMD signal: how a setup becomes an order (entry, stop, target), and a backtest that replays exactly
 * those orders over history. The automatic trader and the backtest both use `planTrade`, so what is tested is what
 * is traded.
 *
 * Entry modes (both are LIMIT orders placed once the gap has closed):
 *   limit-close  at the close of the gap's third candle (the signal candle)
 *   fvg-retest   at the near edge of the gap itself: a better price and a tighter risk, but price has to come back
 * Target modes:  range = the far side of the accumulation range;  r = a fixed multiple of the risk.
 *
 * Backtest realism (so results are not flattering):
 *  - the order only exists from the candle AFTER the signal, and lapses after `expiryCandles` candles unfilled;
 *  - a buy limit fills at its price, or at the open when price gaps through it; the mirror for a sell;
 *  - if price reaches the target before the entry fills, the trade is missed (never chased);
 *  - stop and target are checked inside each candle; when both could have hit, the STOP wins; gaps fill at the open;
 *  - on the candle that fills the order only the stop can end the trade (the order of events inside a candle is unknown);
 *  - fees are charged on both sides; one position per pair at a time, as the live trader does.
 *  - a trade still open at the end of the data is reported separately and left out of the statistics.
 */
import { findAmd } from "./amd.js";

export const AMD_TRADE_DEFAULTS = Object.freeze({
  entryMode: "limit-close",
  targetMode: "range",
  targetR: 2,
  expiryCandles: 3,
  feePercent: 0.05, // per side (futures: 0.02% maker in, 0.05% taker out; spot: 0.1%)
  minRewardRisk: 1, // reward:risk of the ACTUAL entry, stop and target, before fees
  longs: true,
  shorts: true,
});

export const ENTRY_MODES = ["limit-close", "fvg-retest"];
export const TARGET_MODES = ["range", "r"];

/**
 * The order for a setup, or `{ ok: false, reason }`. Prices are in real terms (a short has its stop above and its
 * target below the entry).
 */
export function planTrade(setup, options = {}) {
  const o = { ...AMD_TRADE_DEFAULTS, ...options };
  const long = setup.dir === "bull";
  if (long && !o.longs) return { ok: false, reason: "long trades are switched off" };
  if (!long && !o.shorts) return { ok: false, reason: "short trades are switched off" };
  const entry = o.entryMode === "fvg-retest" ? (long ? setup.fvg.top : setup.fvg.bottom) : setup.plan.entry;
  const stop = setup.plan.stopLoss;
  const risk = long ? entry - stop : stop - entry;
  if (!(risk > 0)) return { ok: false, reason: "the stop is not beyond the entry" };
  let target;
  if (o.targetMode === "r") target = long ? entry + o.targetR * risk : entry - o.targetR * risk;
  else target = setup.plan.target;
  const reward = long ? target - entry : entry - target;
  if (!(reward > 0)) return { ok: false, reason: "the far side of the range is already behind the entry" };
  const rewardRisk = reward / risk;
  if (o.minRewardRisk > 0 && rewardRisk < o.minRewardRisk - 1e-9) return { ok: false, reason: `reward:risk ${rewardRisk.toFixed(2)} is below ${o.minRewardRisk}` };
  return { ok: true, side: long ? "long" : "short", entry, stop, target, risk, reward, rewardRisk, entryMode: o.entryMode, targetMode: o.targetMode };
}

const costPct = (o) => 2 * o.feePercent;

function tradeResult(plan, exit, o) {
  const dir = plan.side === "long" ? 1 : -1;
  const grossPct = (dir * (exit - plan.entry) / plan.entry) * 100;
  const riskPct = (plan.risk / plan.entry) * 100 + costPct(o);
  const returnPct = grossPct - costPct(o);
  return { returnPct, r: returnPct / riskPct, riskPct };
}

/**
 * Replay the signals of one series. `setups` come from `findAmd(candles)`. Only the candles AFTER a signal are
 * used to fill and manage its order.
 */
export function simulateAmd(candles, setups, options = {}) {
  const o = { ...AMD_TRADE_DEFAULTS, ...options };
  const n = candles.length;
  const trades = [];
  const missed = { expired: 0, targetFirst: 0, busy: 0, rejected: 0, offDirection: 0 };
  let free = -1; // index from which a new order may be placed (after the previous trade closed)
  let openTrade = null;

  for (const setup of [...setups].sort((a, b) => a.formedAt - b.formedAt)) {
    const plan = planTrade(setup, o);
    if (!plan.ok) {
      if (/switched off/.test(plan.reason)) missed.offDirection += 1; else missed.rejected += 1;
      continue;
    }
    if (setup.formedAt <= free) { missed.busy += 1; continue; }
    const long = plan.side === "long";

    // ---- fill ----
    let fillIndex = -1;
    let fillPrice = null;
    const last = Math.min(n - 1, setup.formedAt + o.expiryCandles);
    let targetFirst = false;
    for (let i = setup.formedAt + 1; i <= last; i++) {
      const c = candles[i];
      const gapsThrough = long ? c.open <= plan.entry : c.open >= plan.entry;
      const touches = long ? c.low <= plan.entry : c.high >= plan.entry;
      if (gapsThrough || touches) { fillIndex = i; fillPrice = gapsThrough ? c.open : plan.entry; break; }
      if (long ? c.high >= plan.target : c.low <= plan.target) { targetFirst = true; break; }
    }
    if (fillIndex < 0) {
      if (targetFirst) missed.targetFirst += 1; else if (last - setup.formedAt >= o.expiryCandles) missed.expired += 1;
      continue; // (an order still waiting at the end of the data is neither filled nor expired)
    }

    // ---- manage ----
    const live = { ...plan, entry: fillPrice, risk: long ? fillPrice - plan.stop : plan.stop - fillPrice };
    let exitIndex = -1;
    let exitPrice = null;
    let reason = null;
    const fillCandle = candles[fillIndex];
    if (long ? fillCandle.low <= plan.stop : fillCandle.high >= plan.stop) { exitIndex = fillIndex; exitPrice = plan.stop; reason = "stop"; }
    for (let i = fillIndex + 1; exitIndex < 0 && i < n; i++) {
      const c = candles[i];
      if (long) {
        if (c.open <= plan.stop) { exitIndex = i; exitPrice = c.open; reason = "stop"; }
        else if (c.low <= plan.stop) { exitIndex = i; exitPrice = plan.stop; reason = "stop"; }
        else if (c.open >= plan.target) { exitIndex = i; exitPrice = c.open; reason = "target"; }
        else if (c.high >= plan.target) { exitIndex = i; exitPrice = plan.target; reason = "target"; }
      } else if (c.open >= plan.stop) { exitIndex = i; exitPrice = c.open; reason = "stop"; }
      else if (c.high >= plan.stop) { exitIndex = i; exitPrice = plan.stop; reason = "stop"; }
      else if (c.open <= plan.target) { exitIndex = i; exitPrice = c.open; reason = "target"; }
      else if (c.low <= plan.target) { exitIndex = i; exitPrice = plan.target; reason = "target"; }
    }

    const base = {
      id: `${setup.dir}:${candles[setup.formedAt].time}`,
      dir: setup.dir,
      side: plan.side,
      signalIndex: setup.formedAt,
      signalTime: candles[setup.formedAt].time,
      entryIndex: fillIndex,
      entryTime: fillCandle.time,
      entry: fillPrice,
      stop: plan.stop,
      target: plan.target,
      plannedRewardRisk: plan.rewardRisk,
    };
    if (exitIndex < 0) {
      const lastClose = candles[n - 1].close;
      openTrade = { ...base, exitPrice: lastClose, ...tradeResult(live, lastClose, o), reason: "open", barsHeld: n - 1 - fillIndex };
      break; // nothing after an open trade can be tested
    }
    trades.push({ ...base, exitIndex, exitTime: candles[exitIndex].time, exitPrice, reason, barsHeld: exitIndex - fillIndex, ...tradeResult(live, exitPrice, o) });
    free = exitIndex;
  }
  return { trades, openTrade, missed, signals: setups.length };
}

const round = (n, d = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);

/** Performance of a list of closed trades (oldest first). `riskPerTradePct` drives the compounding equity curve. */
export function summarizeTrades(trades, { startEquity = 1000, riskPerTradePct = 1 } = {}) {
  const ordered = [...trades].sort((a, b) => a.entryTime - b.entryTime || a.exitTime - b.exitTime);
  const n = ordered.length;
  const wins = ordered.filter((t) => t.r > 0);
  const losses = ordered.filter((t) => t.r <= 0);
  const sum = (list, f) => list.reduce((s, t) => s + f(t), 0);
  const grossWin = sum(wins, (t) => t.r);
  const grossLoss = Math.abs(sum(losses, (t) => t.r));

  let equity = startEquity;
  let peak = startEquity;
  let maxDrawdownPct = 0;
  let cumR = 0;
  let peakR = 0;
  let maxDrawdownR = 0;
  let streak = 0;
  let maxLossStreak = 0;
  const curve = [{ time: ordered[0]?.entryTime ?? null, equity, r: 0 }];
  for (const t of ordered) {
    equity *= 1 + (riskPerTradePct / 100) * t.r;
    cumR += t.r;
    peak = Math.max(peak, equity);
    peakR = Math.max(peakR, cumR);
    maxDrawdownPct = Math.max(maxDrawdownPct, (1 - equity / peak) * 100);
    maxDrawdownR = Math.max(maxDrawdownR, peakR - cumR);
    streak = t.r <= 0 ? streak + 1 : 0;
    maxLossStreak = Math.max(maxLossStreak, streak);
    curve.push({ time: t.exitTime, equity, r: cumR });
  }

  const half = Math.floor(n / 2);
  const expectancy = (list) => (list.length ? sum(list, (t) => t.r) / list.length : null);
  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    winRate: n ? (wins.length / n) * 100 : null,
    avgWinR: wins.length ? grossWin / wins.length : null,
    avgLossR: losses.length ? -grossLoss / losses.length : null,
    expectancyR: expectancy(ordered),
    totalR: cumR,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
    avgReturnPct: n ? sum(ordered, (t) => t.returnPct) / n : null,
    maxDrawdownR,
    maxLossStreak,
    avgBarsHeld: n ? sum(ordered, (t) => t.barsHeld) / n : null,
    best: n ? Math.max(...ordered.map((t) => t.r)) : null,
    worst: n ? Math.min(...ordered.map((t) => t.r)) : null,
    equity: { start: startEquity, end: equity, returnPct: (equity / startEquity - 1) * 100, maxDrawdownPct, riskPerTradePct },
    halves: n >= 8 ? { first: expectancy(ordered.slice(0, half)), second: expectancy(ordered.slice(half)) } : null,
    byTarget: { target: ordered.filter((t) => t.reason === "target").length, stop: ordered.filter((t) => t.reason === "stop").length },
    curve,
  };
}

/** A plain-language read of the numbers, with the caveats that matter. */
export function judgeBacktest(stats) {
  if (!stats || stats.trades === 0) return { tone: "mixed", label: "No trades", text: "The signal never produced a filled trade in this data. Try more history, another timeframe or looser sensitivity." };
  const notes = [];
  if (stats.trades < 30) notes.push(`only ${stats.trades} trades: too few to trust either way`);
  if (stats.halves && Math.sign(stats.halves.first) !== Math.sign(stats.halves.second)) notes.push("the first and second half of the trades disagree, so the result is not stable");
  if (stats.equity.maxDrawdownPct >= 25) notes.push(`a ${stats.equity.maxDrawdownPct.toFixed(0)}% drawdown at ${stats.equity.riskPerTradePct}% risk per trade`);
  const e = stats.expectancyR;
  const pf = stats.profitFactor;
  let tone;
  let label;
  if (e <= 0) { tone = "bad"; label = "Loses money after fees"; }
  else if (e >= 0.15 && pf >= 1.3 && stats.trades >= 30 && !notes.some((x) => /disagree/.test(x))) { tone = "good"; label = "Positive and steady"; }
  else { tone = "mixed"; label = "Marginal"; }
  const head = e > 0
    ? `On average each trade earned ${e.toFixed(2)}R after fees (profit factor ${pf === Infinity ? "∞" : pf.toFixed(2)}).`
    : `On average each trade lost ${Math.abs(e).toFixed(2)}R after fees (profit factor ${pf == null ? "n/a" : pf.toFixed(2)}).`;
  return { tone, label, text: `${head}${notes.length ? ` Caution: ${notes.join("; ")}.` : ""} A backtest shows what would have happened, not what will.` };
}

/**
 * Run the whole thing over several instruments. `datasets` is `[{symbol, candles}]` (oldest first).
 * Trades of every instrument are pooled for the combined result; instruments are treated as independent.
 */
export function backtestAmd(datasets, { engine = {}, trade = {}, summary = {} } = {}) {
  const perSymbol = [];
  const all = [];
  let opens = 0;
  const missed = { expired: 0, targetFirst: 0, busy: 0, rejected: 0, offDirection: 0 };
  let signals = 0;
  for (const { symbol, candles } of datasets) {
    if (candles.length < 60) { perSymbol.push({ symbol, candles: candles.length, error: "not enough candles", stats: summarizeTrades([], summary) }); continue; }
    const setups = findAmd(candles, null, engine);
    const run = simulateAmd(candles, setups, trade);
    const tagged = run.trades.map((t) => ({ ...t, symbol }));
    all.push(...tagged);
    if (run.openTrade) opens += 1;
    signals += run.signals;
    for (const k of Object.keys(missed)) missed[k] += run.missed[k];
    const first = candles[0];
    const lastCandle = candles[candles.length - 1];
    perSymbol.push({
      symbol,
      candles: candles.length,
      from: first.time,
      to: lastCandle.time,
      buyAndHoldPct: (lastCandle.close / first.close - 1) * 100,
      signals: run.signals,
      open: run.openTrade ? { ...run.openTrade, symbol } : null,
      stats: summarizeTrades(tagged, summary),
    });
  }
  const combined = summarizeTrades(all, summary);
  return {
    perSymbol,
    combined,
    verdict: judgeBacktest(combined),
    trades: [...all].sort((a, b) => b.entryTime - a.entryTime),
    counts: { signals, filled: all.length, open: opens, missed, avgPlannedRewardRisk: all.length ? all.reduce((sum, t) => sum + t.plannedRewardRisk, 0) / all.length : null },
    options: { engine, trade: { ...AMD_TRADE_DEFAULTS, ...trade }, summary },
  };
}

/** The same data under several ways of trading the signal, to see which choices matter (in-sample: do not over-trust the best row). */
export function sweepAmd(datasets, { engine = {}, trade = {}, summary = {} } = {}) {
  const variants = [];
  for (const entryMode of ENTRY_MODES) {
    variants.push({ entryMode, targetMode: "range", label: `${entryMode === "limit-close" ? "Enter at the signal close" : "Enter on a retest of the gap"}, target the far side of the range` });
    for (const targetR of [1.5, 2, 3]) variants.push({ entryMode, targetMode: "r", targetR, label: `${entryMode === "limit-close" ? "Enter at the signal close" : "Enter on a retest of the gap"}, target ${targetR}R` });
  }
  return variants.map((v) => {
    const { label, ...rest } = v;
    const result = backtestAmd(datasets, { engine, trade: { ...trade, ...rest }, summary });
    return { label, trade: rest, stats: result.combined, verdict: result.verdict };
  });
}
