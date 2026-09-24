/**
 * The "manipulation" reversal, and a backtest that replays it.
 *
 * The idea: price rarely moves in a clean line. Before a move up it first dips below the previous candle (taking the
 * stops resting there) and is bought straight back; before a move down it first pokes above the previous candle and is
 * sold straight back. That candle is the manipulation, and it is a natural place to lean against:
 *
 *   bullish   a candle sweeps BELOW the previous candle's low, then closes back up and engulfs the previous candle.
 *             Buy, stop below the manipulation low, target a multiple of the risk (default 2R).
 *   bearish   the mirror: sweeps ABOVE the previous high, closes back down and engulfs the previous candle.
 *
 * It is meant for the 4-hour chart (the manipulation low is then often the low of the day), but nothing here depends
 * on the timeframe.
 *
 * Backtest realism (so results are not flattering):
 *  - a setup is known only when its candle has CLOSED; the trade is entered at the OPEN of the next candle;
 *  - stop and target are checked inside each candle, and when both could have hit, the STOP wins;
 *  - a gap through the stop fills at the open (worse than the stop); a gap through the target fills at the open;
 *  - fees are charged on both sides and shown in R, so a 2R target really pays a little less than 2R;
 *  - one position at a time per pair;
 *  - a trade still open at the end of the data is reported separately and left out of the statistics.
 */
import { atr, ema } from "./indicators.js";

export const MANIP_DEFAULTS = Object.freeze({
  engulf: "body", // "body": close beyond the previous candle's body. "range": beyond its whole high-low range (stricter).
  requireSweep: true, // false = any engulfing candle qualifies. Only useful to test whether the sweep itself adds anything
  minSweepAtr: 0, // the sweep must poke beyond the previous extreme by at least this many ATR (0 = any sweep)
  trend: "off", // "ema": longs only above the trend EMA, shorts only below it. "off": take every setup.
  trendPeriod: 50,
  rewardRisk: 2, // target = entry +/- this many times the risk
  stopBufferAtr: 0, // extra room beyond the manipulation wick, in ATR
  maxRiskAtr: 0, // skip setups whose stop is further than this many ATR from the entry (0 = no limit)
  longs: true,
  shorts: true,
  feePercent: 0.05, // per side. Futures taker is 0.05%; spot is 0.1%
});

export const ENGULF_MODES = ["body", "range"];
export const TREND_MODES = ["off", "ema"];

const ATR_PERIOD = 14;

/** Indicators the detector needs, computed once so a scan or a backtest can index into them. */
export function manipulationContext(candles, options = {}) {
  const o = { ...MANIP_DEFAULTS, ...options };
  return { atr: atr(candles, ATR_PERIOD), trendEma: ema(candles.map((c) => c.close), o.trendPeriod) };
}

/**
 * Is candle `i` a manipulation? Uses only candles up to and including `i`.
 * Returns { dir: "bull"|"bear", index, time, sweepLevel, stop, sweepAtr } or null.
 * `stop` is where the stop-loss belongs (beyond the manipulation wick); the entry price is decided when the trade is
 * planned, because that is the next candle's open.
 */
export function manipulationAt(candles, i, options = {}, context = null) {
  const o = { ...MANIP_DEFAULTS, ...options };
  if (i < 1 || i >= candles.length) return null;
  const ctx = context ?? manipulationContext(candles, o);
  const k = candles[i];
  const p = candles[i - 1];
  const range = ctx.atr[i];
  if (range == null || !(range > 0)) return null;

  const bodyLow = Math.min(p.open, p.close);
  const bodyHigh = Math.max(p.open, p.close);
  const bullish =
    o.longs &&
    (!o.requireSweep || k.low < p.low - o.minSweepAtr * range) && // swept the previous low...
    k.close > k.open && // ...and was bought back up
    k.close > (o.engulf === "range" ? p.high : bodyHigh); // ...engulfing the previous candle
  const bearish =
    o.shorts &&
    (!o.requireSweep || k.high > p.high + o.minSweepAtr * range) &&
    k.close < k.open &&
    k.close < (o.engulf === "range" ? p.low : bodyLow);
  if (!bullish && !bearish) return null;

  const dir = bullish ? "bull" : "bear";
  if (o.trend === "ema") {
    const trend = ctx.trendEma[i];
    if (trend == null) return null;
    if (dir === "bull" && !(k.close > trend)) return null;
    if (dir === "bear" && !(k.close < trend)) return null;
  }

  const stop = dir === "bull" ? k.low - o.stopBufferAtr * range : k.high + o.stopBufferAtr * range;
  if (o.maxRiskAtr > 0 && Math.abs(k.close - stop) > o.maxRiskAtr * range) return null;
  return {
    dir,
    index: i,
    time: k.time,
    sweepLevel: dir === "bull" ? p.low : p.high,
    stop,
    sweepAtr: Math.max(0, (dir === "bull" ? p.low - k.low : k.high - p.high) / range),
  };
}

/** Every manipulation in the series, oldest first (for marking a chart). */
export function findManipulations(candles, options = {}) {
  const o = { ...MANIP_DEFAULTS, ...options };
  const context = manipulationContext(candles, o);
  const out = [];
  for (let i = 1; i < candles.length; i++) {
    const setup = manipulationAt(candles, i, o, context);
    if (setup) out.push(setup);
  }
  return out;
}

/** The order for a setup once the entry price is known, or `{ ok: false, reason }`. */
export function planManipulationTrade(setup, entry, options = {}) {
  const o = { ...MANIP_DEFAULTS, ...options };
  const long = setup.dir === "bull";
  const risk = long ? entry - setup.stop : setup.stop - entry;
  if (!(risk > 0)) return { ok: false, reason: "price opened beyond the stop" };
  const target = long ? entry + o.rewardRisk * risk : entry - o.rewardRisk * risk;
  return { ok: true, side: long ? "long" : "short", entry, stop: setup.stop, target, risk, rewardRisk: o.rewardRisk };
}

/**
 * Replay one pair. Returns { trades, open, stats }. `trades` are closed trades only; each carries its result in R
 * after fees (`netR`), so results are comparable across pairs and price levels.
 */
export function backtestManipulation(candles, options = {}) {
  const o = { ...MANIP_DEFAULTS, ...options };
  const context = manipulationContext(candles, o);
  const fee = o.feePercent / 100;
  const warmup = Math.max(ATR_PERIOD, o.trend === "ema" ? o.trendPeriod : 0) + 1;
  const trades = [];
  let open = null;
  let position = null;

  const finish = (j, price, reason) => {
    const long = position.side === "long";
    const grossR = ((long ? price - position.entry : position.entry - price)) / position.risk;
    const costR = ((position.entry + price) * fee) / position.risk;
    const trade = {
      side: position.side,
      setupIndex: position.setupIndex,
      entryIndex: position.entryIndex,
      entryTime: candles[position.entryIndex].time,
      entry: position.entry,
      stop: position.stop,
      target: position.target,
      exitIndex: j,
      exitTime: candles[j].time,
      exit: price,
      reason,
      grossR,
      netR: grossR - costR,
      returnPct: (((long ? price - position.entry : position.entry - price)) / position.entry - 2 * fee) * 100,
      bars: j - position.entryIndex + 1,
    };
    position = null;
    return trade;
  };

  for (let i = warmup; i < candles.length; i++) {
    if (position) {
      const bar = candles[i];
      const long = position.side === "long";
      let done = null;
      // Gaps first: an open beyond a level fills there, not at the level.
      if (long ? bar.open <= position.stop : bar.open >= position.stop) done = finish(i, bar.open, "stop-loss (gap)");
      else if (long ? bar.open >= position.target : bar.open <= position.target) done = finish(i, bar.open, "take-profit (gap)");
      else if (long ? bar.low <= position.stop : bar.high >= position.stop) done = finish(i, position.stop, "stop-loss");
      else if (long ? bar.high >= position.target : bar.low <= position.target) done = finish(i, position.target, "take-profit");
      if (done) trades.push(done);
    }
    // A finished trade frees the pair on the same candle, but the next entry is always a later candle's open.
    if (!position && i < candles.length - 1) {
      const setup = manipulationAt(candles, i, o, context);
      if (setup) {
        const plan = planManipulationTrade(setup, candles[i + 1].open, o);
        if (plan.ok) {
          position = { ...plan, setupIndex: i, entryIndex: i + 1 };
          // The entry candle is checked like any other, starting at the next loop pass (i + 1).
        }
      }
    }
  }
  if (position) {
    const last = candles.length - 1;
    const long = position.side === "long";
    open = {
      side: position.side,
      entryTime: candles[position.entryIndex].time,
      entry: position.entry,
      stop: position.stop,
      target: position.target,
      markR: ((long ? candles[last].close - position.entry : position.entry - candles[last].close)) / position.risk,
    };
  }

  const first = candles[Math.min(warmup, candles.length - 1)];
  const last = candles[candles.length - 1];
  return {
    trades,
    open,
    stats: {
      ...summarizeTrades(trades, options),
      candles: Math.max(0, candles.length - warmup),
      buyHoldPct: first && last ? (last.close / first.close - 1) * 100 : null,
    },
  };
}

/**
 * Replay many pairs. `datasets` is [{ symbol, candles }]. Each pair is traded independently (one position per
 * pair) and the trades are then merged by exit time into one account curve.
 */
export function backtestManipulationMany(datasets, options = {}) {
  const perSymbol = [];
  const all = [];
  for (const { symbol, candles, error } of datasets) {
    if (!candles?.length) { perSymbol.push({ symbol, error: error ?? "no candles", stats: summarizeTrades([], options), trades: 0 }); continue; }
    const r = backtestManipulation(candles, options);
    perSymbol.push({ symbol, stats: r.stats, open: r.open, error: null });
    for (const t of r.trades) all.push({ symbol, ...t });
  }
  all.sort((a, b) => a.exitTime - b.exitTime);
  return { perSymbol, trades: all, stats: summarizeTrades(all, options) };
}

/** Numbers that say whether it worked. R is one unit of risk; equity assumes a fixed % of the account risked per trade. */
export function summarizeTrades(trades, { riskPerTradePct = 1, startEquity = 1000 } = {}) {
  const wins = trades.filter((t) => t.netR > 0);
  const losses = trades.filter((t) => t.netR <= 0);
  const sum = (list, f) => list.reduce((s, t) => s + f(t), 0);
  const grossWinR = sum(wins, (t) => t.netR);
  const grossLossR = Math.abs(sum(losses, (t) => t.netR));

  let equity = startEquity;
  let peak = equity;
  let maxDrawdownPct = 0;
  let runR = 0;
  let peakR = 0;
  let maxDrawdownR = 0;
  let streak = 0;
  let maxLosingStreak = 0;
  const curve = [];
  for (const t of trades) {
    equity *= Math.max(0, 1 + (riskPerTradePct / 100) * t.netR);
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - equity) / peak) * 100);
    runR += t.netR;
    peakR = Math.max(peakR, runR);
    maxDrawdownR = Math.max(maxDrawdownR, peakR - runR);
    streak = t.netR > 0 ? 0 : streak + 1;
    maxLosingStreak = Math.max(maxLosingStreak, streak);
    curve.push({ time: t.exitTime, equity, totalR: runR });
  }

  const longs = trades.filter((t) => t.side === "long");
  const shorts = trades.filter((t) => t.side === "short");
  const side = (list) => ({ trades: list.length, winRate: list.length ? (list.filter((t) => t.netR > 0).length / list.length) * 100 : null, expectancyR: list.length ? sum(list, (t) => t.netR) / list.length : null, totalR: sum(list, (t) => t.netR) });
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : null,
    expectancyR: trades.length ? sum(trades, (t) => t.netR) / trades.length : null,
    totalR: sum(trades, (t) => t.netR),
    profitFactor: grossLossR > 0 ? grossWinR / grossLossR : grossWinR > 0 ? Infinity : null,
    avgWinR: wins.length ? grossWinR / wins.length : null,
    avgLossR: losses.length ? -grossLossR / losses.length : null,
    maxDrawdownR,
    maxLosingStreak,
    avgBars: trades.length ? sum(trades, (t) => t.bars) / trades.length : null,
    endEquity: equity,
    totalReturnPct: (equity / startEquity - 1) * 100,
    maxDrawdownPct,
    long: side(longs),
    short: side(shorts),
    curve,
  };
}

/** Win rate needed just to break even at a given reward:risk, before fees. 2R needs 33.3%. */
export const breakEvenWinRate = (rewardRisk) => (100 * 1) / (1 + rewardRisk);
