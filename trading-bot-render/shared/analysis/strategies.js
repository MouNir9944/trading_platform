/**
 * Trading strategies. Each one looks at the state of the market as of candle `i` (using only data up to
 * and including that candle) and answers BUY / SELL / HOLD, with reasons and, for a BUY, suggested
 * stop-loss and take-profit prices.
 *
 * The bot trades spot, long-only: BUY means "open a long", SELL means "exit longs / stay out".
 *
 * Every strategy has settings (`params`: periods, thresholds, stop distance, reward multiple). `evaluate(ctx, i, params)`
 * takes them as a third argument; without it the defaults apply, which is what the Analysis tab uses. Indicator series
 * that depend on a setting are computed through `ctx.memo`, so a strategy tested with several settings reuses the rest.
 */
import { findAmd } from "./amd.js";
import { adx, atr, bollinger, ema, macd, rsi, sma, stochastic, supertrend } from "./indicators.js";
import { activeFvgs, activeOrderBlocks, analyzeSmc, premiumDiscountAt } from "./smc.js";
import { analyzeStructure, swingsUpTo } from "./structure.js";

/** Compute every indicator and the structure once, so strategies and backtests can index into them. */
export function buildContext(candles) {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const structure = analyzeStructure(candles);
  const breakAt = new Map(structure.breaks.map((b) => [b.index, b]));
  const atrSeries = atr(candles, 14);
  const amd = findAmd(candles, atrSeries);
  const amdAt = new Map();
  for (const setup of amd) amdAt.set(setup.formedAt, [...(amdAt.get(setup.formedAt) ?? []), setup]);
  const cache = new Map();
  return {
    candles,
    closes,
    structure,
    amd,
    amdAt,
    smc: analyzeSmc(candles, structure, atrSeries),
    breakAt,
    /** A series that depends on a setting, computed once per distinct key. */
    memo(key, compute) {
      if (!cache.has(key)) cache.set(key, compute());
      return cache.get(key);
    },
    ind: {
      sma9: sma(closes, 9),
      sma21: sma(closes, 21),
      ema21: ema(closes, 21),
      ema50: ema(closes, 50),
      rsi: rsi(closes, 14),
      macd: macd(closes),
      bb: bollinger(closes, 20, 2),
      atr: atrSeries,
      stoch: stochastic(candles, 14, 3),
      adx: adx(candles, 14),
      supertrend: supertrend(candles, 10, 3),
      volSma: sma(volumes, 20),
    },
  };
}

const hold = (...reasons) => ({ signal: "HOLD", reasons });
const buy = (reasons, stops) => ({ signal: "BUY", reasons, ...stops });
const sell = (...reasons) => ({ signal: "SELL", reasons });

const fmt = (n, digits = 1) => (n == null ? "—" : Number(n).toFixed(digits));
const crossedUp = (a, b, i) => a[i - 1] != null && b[i - 1] != null && a[i] != null && b[i] != null && a[i - 1] <= b[i - 1] && a[i] > b[i];
const crossedDown = (a, b, i) => a[i - 1] != null && b[i - 1] != null && a[i] != null && b[i] != null && a[i - 1] >= b[i - 1] && a[i] < b[i];

// ---- settings ----

const spec = (key, label, def, min, max, step = 1, hint) => ({ key, label, type: "number", default: def, min, max, step, integer: Number.isInteger(step) && Number.isInteger(def), ...(hint ? { hint } : {}) });
const STOP_ATR = (def) => spec("stopAtr", "Stop distance (ATR ×)", def, 0.5, 5, 0.5, "How far below the entry the stop goes, in units of the average candle range");
const REWARD_R = spec("rewardR", "Target (× risk)", 2, 0.5, 6, 0.5, "The take-profit is this many times the distance to the stop");

/** Wrap a strategy so `evaluate(ctx, i)` works without settings (defaults) and `evaluate(ctx, i, params)` with them. */
function define({ params, evaluate, ...rest }) {
  const defaults = Object.fromEntries(params.map((p) => [p.key, p.default]));
  return { ...rest, params, defaults, evaluate: (ctx, i, given) => evaluate(ctx, i, given ? { ...defaults, ...given } : defaults) };
}

/** Stop a multiple of ATR below the entry; target at `rewardR` times the risk. */
function atrStops(ctx, i, p) {
  const entry = ctx.candles[i].close;
  const range = ctx.ind.atr[i] ?? entry * 0.01;
  const stopLoss = entry - p.stopAtr * range;
  return { stopLoss, takeProfit: entry + p.rewardR * (entry - stopLoss) };
}

/** Stop just below the latest confirmed swing low when it gives a sane distance, otherwise ATR. */
function structureStops(ctx, i, p, structure = ctx.structure) {
  const entry = ctx.candles[i].close;
  const range = ctx.ind.atr[i] ?? entry * 0.01;
  const swing = [...swingsUpTo(structure.pivots, i)].reverse().find((s) => s.type === "low" && s.price < entry);
  if (swing) {
    const stopLoss = swing.price - 0.25 * range;
    const risk = entry - stopLoss;
    if (risk > 0.3 * range && risk < 5 * range) return { stopLoss, takeProfit: entry + p.rewardR * risk };
  }
  return atrStops(ctx, i, p);
}

/** Structure and smart-money zones for another swing length than the default one (3 candles each side). */
function structureFor(ctx, bars) {
  if (bars === 3) return { structure: ctx.structure, breakAt: ctx.breakAt, smc: ctx.smc };
  return ctx.memo(`structure${bars}`, () => {
    const structure = analyzeStructure(ctx.candles, { left: bars, right: bars });
    return { structure, breakAt: new Map(structure.breaks.map((b) => [b.index, b])), smc: analyzeSmc(ctx.candles, structure, ctx.ind.atr) };
  });
}

function priorExtremes(candles, i, lookback) {
  let high = -Infinity;
  let low = Infinity;
  for (let j = Math.max(0, i - lookback); j < i; j++) {
    high = Math.max(high, candles[j].high);
    low = Math.min(low, candles[j].low);
  }
  return { high, low };
}

export const STRATEGIES = [
  define({
    id: "ma_cross",
    name: "MA crossover + breakout",
    description: "Fast MA (9) crosses the slow MA (21) and price closes beyond the last 20-candle range.",
    params: [spec("fastPeriod", "Fast MA (candles)", 9, 2, 50), spec("slowPeriod", "Slow MA (candles)", 21, 5, 200), spec("breakoutLookback", "Breakout range (candles)", 20, 5, 100), STOP_ATR(1.5), REWARD_R],
    evaluate(ctx, i, p) {
      if (p.fastPeriod >= p.slowPeriod) return hold("The fast MA must be shorter than the slow MA");
      const fast = ctx.memo(`sma${p.fastPeriod}`, () => sma(ctx.closes, p.fastPeriod));
      const slow = ctx.memo(`sma${p.slowPeriod}`, () => sma(ctx.closes, p.slowPeriod));
      if (slow[i] == null || i < p.slowPeriod + 1) return hold("Not enough candles yet");
      const { high, low } = priorExtremes(ctx.candles, i, p.breakoutLookback);
      const close = ctx.candles[i].close;
      const name = `MA ${p.fastPeriod} / MA ${p.slowPeriod}`;
      if (crossedUp(fast, slow, i)) {
        return close > high
          ? buy([`MA ${p.fastPeriod} crossed above MA ${p.slowPeriod}`, `Close broke the ${p.breakoutLookback}-candle high`], atrStops(ctx, i, p))
          : hold(`${name}: crossed up but no breakout yet`);
      }
      if (crossedDown(fast, slow, i)) {
        return close < low ? sell(`MA ${p.fastPeriod} crossed below MA ${p.slowPeriod}`, `Close broke the ${p.breakoutLookback}-candle low`) : hold(`${name}: crossed down but no breakdown yet`);
      }
      return hold(fast[i] > slow[i] ? "Fast MA above slow MA (no fresh cross)" : "Fast MA below slow MA (no fresh cross)");
    },
  }),
  define({
    id: "rsi_reversal",
    name: "RSI oversold reversal",
    description: "RSI climbs back above 30 on a green candle: a bounce from oversold. Exit when RSI falls back below 70.",
    params: [spec("rsiPeriod", "RSI period", 14, 2, 50), spec("oversold", "Oversold level", 30, 5, 50), spec("overbought", "Overbought level (exit)", 70, 50, 95), STOP_ATR(1.5), REWARD_R],
    evaluate(ctx, i, p) {
      const r = ctx.memo(`rsi${p.rsiPeriod}`, () => rsi(ctx.closes, p.rsiPeriod));
      if (r[i] == null || r[i - 1] == null) return hold("Not enough candles yet");
      const c = ctx.candles[i];
      if (r[i - 1] <= p.oversold && r[i] > p.oversold && c.close > c.open) {
        return buy([`RSI crossed back above ${p.oversold} (${fmt(r[i])})`, "Green candle confirms the bounce"], atrStops(ctx, i, p));
      }
      if (r[i - 1] >= p.overbought && r[i] < p.overbought) return sell(`RSI fell back below ${p.overbought} (${fmt(r[i])})`);
      const zone = r[i] < p.oversold ? "oversold" : r[i] > p.overbought ? "overbought" : "neutral";
      return hold(`RSI ${fmt(r[i])} (${zone})`);
    },
  }),
  define({
    id: "macd_momentum",
    name: "MACD momentum",
    description: "MACD line crosses above its signal line while price is above the 50 EMA.",
    params: [spec("macdFast", "MACD fast", 12, 2, 50), spec("macdSlow", "MACD slow", 26, 5, 100), spec("macdSignal", "MACD signal", 9, 2, 50), spec("trendEma", "Trend filter EMA", 50, 10, 200), STOP_ATR(2), REWARD_R],
    evaluate(ctx, i, p) {
      if (p.macdFast >= p.macdSlow) return hold("MACD fast must be shorter than slow");
      const { line, signal } = ctx.memo(`macd${p.macdFast}/${p.macdSlow}/${p.macdSignal}`, () => macd(ctx.closes, p.macdFast, p.macdSlow, p.macdSignal));
      const trend = ctx.memo(`ema${p.trendEma}`, () => ema(ctx.closes, p.trendEma));
      if (signal[i] == null || trend[i] == null) return hold("Not enough candles yet");
      const close = ctx.candles[i].close;
      if (crossedUp(line, signal, i)) {
        return close > trend[i]
          ? buy(["MACD crossed above its signal line", `Price is above the ${p.trendEma} EMA`], atrStops(ctx, i, p))
          : hold(`MACD crossed up but price is below the ${p.trendEma} EMA`);
      }
      if (crossedDown(line, signal, i)) return sell("MACD crossed below its signal line");
      return hold(line[i] > signal[i] ? "MACD above signal (bullish momentum)" : "MACD below signal (bearish momentum)");
    },
  }),
  define({
    id: "bollinger_breakout",
    name: "Bollinger squeeze breakout",
    description: "After a volatility squeeze, price closes above the upper band on above-average volume.",
    params: [spec("bbPeriod", "Band period", 20, 5, 100), spec("bbMult", "Band width (std devs)", 2, 1, 4, 0.5), spec("squeezePct", "Squeeze: bottom % of widths", 25, 5, 50, 5, "A squeeze is a band width in the narrowest part of the last 100 candles"), STOP_ATR(2), REWARD_R],
    evaluate(ctx, i, p) {
      const bb = ctx.memo(`bb${p.bbPeriod}/${p.bbMult}`, () => bollinger(ctx.closes, p.bbPeriod, p.bbMult));
      const { volSma } = ctx.ind;
      if (bb.upper[i] == null || bb.upper[i - 1] == null || i < Math.max(30, p.bbPeriod + 10)) return hold("Not enough candles yet");
      const close = ctx.candles[i].close;
      const prevClose = ctx.candles[i - 1].close;
      const history = bb.bandwidth.slice(Math.max(0, i - 100), i).filter((v) => v != null).sort((a, b) => a - b);
      const threshold = history[Math.floor(history.length * (p.squeezePct / 100))] ?? 0;
      const recentSqueeze = bb.bandwidth.slice(Math.max(0, i - 8), i).some((v) => v != null && v <= threshold);
      const volumeOk = volSma[i] != null && ctx.candles[i].volume >= volSma[i];
      if (close > bb.upper[i] && prevClose <= bb.upper[i - 1]) {
        if (recentSqueeze && volumeOk) {
          return buy(["Close broke above the upper band", "Volatility squeeze just before", "Volume above its 20-candle average"], atrStops(ctx, i, p));
        }
        return hold(`Broke the upper band but ${recentSqueeze ? "volume is weak" : "there was no squeeze first"}`);
      }
      if (prevClose >= bb.mid[i - 1] && close < bb.mid[i]) return sell("Close fell back below the middle band");
      return hold(`Bandwidth ${fmt(bb.bandwidth[i] * 100, 2)}% (${bb.bandwidth[i] <= threshold ? "squeezed" : "normal"})`);
    },
  }),
  define({
    id: "supertrend",
    name: "Supertrend follower",
    description: "Buys when the Supertrend flips to up, exits when it flips down. The stop is the Supertrend line.",
    params: [spec("atrPeriod", "ATR period", 10, 2, 50), spec("multiplier", "ATR multiplier", 3, 1, 6, 0.5), REWARD_R],
    evaluate(ctx, i, p) {
      const { trend, line } = ctx.memo(`supertrend${p.atrPeriod}/${p.multiplier}`, () => supertrend(ctx.candles, p.atrPeriod, p.multiplier));
      if (trend[i] == null || trend[i - 1] == null) return hold("Not enough candles yet");
      const entry = ctx.candles[i].close;
      if (trend[i - 1] === -1 && trend[i] === 1) {
        const stopLoss = line[i];
        return buy(["Supertrend flipped to up"], { stopLoss, takeProfit: entry + p.rewardR * (entry - stopLoss) });
      }
      if (trend[i - 1] === 1 && trend[i] === -1) return sell("Supertrend flipped to down");
      return hold(trend[i] === 1 ? "Supertrend is up (already in trend)" : "Supertrend is down");
    },
  }),
  define({
    id: "structure_break",
    name: "Structure break (BOS / CHoCH)",
    description: "Buys a close above the last swing high (break of structure or change of character). The stop goes below the last swing low.",
    params: [spec("swingBars", "Swing size (candles each side)", 3, 2, 10, 1, "A swing high/low must beat this many candles on each side"), STOP_ATR(1.5), REWARD_R],
    evaluate(ctx, i, p) {
      const { structure, breakAt } = structureFor(ctx, p.swingBars);
      if (structure.pivots.filter((x) => x.confirmedAt <= i).length < 4) return hold("Not enough structure yet");
      const brk = breakAt.get(i);
      if (brk?.direction === "bull") {
        const kind = brk.type === "BOS" ? "Bullish BOS: trend continuation" : "Bullish CHoCH: possible reversal";
        return buy([kind, "Closed above the last swing high"], structureStops(ctx, i, p, structure));
      }
      if (brk?.direction === "bear") {
        return sell(brk.type === "BOS" ? "Bearish BOS: downtrend continues" : "Bearish CHoCH: uptrend may be over");
      }
      return hold(`Structure is ${structure.trend.replace("-", " ")}, no fresh break`);
    },
  }),
  define({
    id: "smc_zone",
    name: "Smart money: gap / order-block retest",
    description: "In a bullish structure, buys when price dips into an open fair value gap or bullish order block in the DISCOUNT half of the range and closes back up. The stop goes just below the zone. Mirror image (in premium, bearish) gives an exit signal.",
    params: [spec("swingBars", "Swing size (candles each side)", 3, 2, 10), spec("maxDiscount", "Buy only below this part of the range", 0.5, 0.2, 0.7, 0.05, "0.5 = the lower half (discount) of the swing range"), STOP_ATR(1.5), REWARD_R],
    evaluate(ctx, i, p) {
      if (i < 30 || ctx.ind.atr[i] == null) return hold("Not enough candles yet");
      const { structure, smc } = structureFor(ctx, p.swingBars);
      const c = ctx.candles[i];
      const atr = ctx.ind.atr[i];
      const range = premiumDiscountAt(structure, i, c.close);
      if (!range) return hold("No swing range yet");
      const lastBreak = [...structure.breaks].reverse().find((b) => b.index <= i);
      const bias = lastBreak?.direction === "bull" ? "bullish" : lastBreak?.direction === "bear" ? "bearish" : null;
      const pct = Math.round(range.position * 100);

      const gaps = activeFvgs(smc, i);
      const blocks = activeOrderBlocks(smc, i);
      const zonesOf = (type) => [
        ...gaps.filter((g) => g.type === type).map((g) => ({ ...g, name: "fair value gap" })),
        ...blocks.filter((b) => b.type === type).map((b) => ({ ...b, name: "order block" })),
      ].filter((z) => z.formedAt < i);

      if (bias === "bullish" && range.position <= p.maxDiscount && c.close > c.open) {
        const zone = zonesOf("bull").find((z) => c.low <= z.top && c.close >= z.bottom);
        if (zone) {
          const entry = c.close;
          const stopLoss = Math.min(zone.bottom, c.low) - 0.25 * atr;
          const risk = entry - stopLoss;
          const stops = risk > 0.3 * atr && risk < 5 * atr ? { stopLoss, takeProfit: entry + p.rewardR * risk } : atrStops(ctx, i, p);
          return buy([`Bullish structure, price in discount (${pct}% of the range)`, `Dipped into a bullish ${zone.name} and closed back up`], stops);
        }
      }
      if (bias === "bearish" && range.position >= 0.5 && c.close < c.open) {
        const zone = zonesOf("bear").find((z) => c.high >= z.bottom && c.close <= z.top);
        if (zone) return sell(`Bearish structure, price in premium (${pct}%)`, `Rejected from a bearish ${zone.name}`);
      }
      const open = zonesOf("bull").length;
      return hold(`Structure ${bias ?? "unclear"}, price in ${range.zone} (${pct}% of range), ${open} open bullish zone${open === 1 ? "" : "s"}`);
    },
  }),
  define({
    id: "amd_fvg",
    name: "AMD: sweep then fair value gap",
    description: "Waits for the full sequence: a tight accumulation range, a manipulation wick that sweeps one side and comes back, then a strong candle that leaves a fair value gap. Buys when the bullish gap forms (stop under the sweep, target the far side of the range). A bearish gap is an exit signal.",
    params: [],
    evaluate(ctx, i) {
      const here = ctx.amdAt.get(i) ?? [];
      const up = here.find((s) => s.dir === "bull");
      const down = here.find((s) => s.dir === "bear");
      if (up) {
        const { entry, stopLoss, target, riskReward } = up.plan;
        if (riskReward != null && riskReward >= 1.2 && entry > stopLoss && target > entry) {
          return buy(
            [`Accumulation range of ${up.range.endIndex - up.range.startIndex + 1} candles`, "Manipulation: the range low was swept and reclaimed", `Bullish fair value gap formed (${fmt(riskReward)}R to the far side of the range)`],
            { stopLoss, takeProfit: target },
          );
        }
        return hold("Bullish AMD gap formed but the far side of the range is too close for a worthwhile target");
      }
      if (down) return sell("Range high swept and rejected, bearish fair value gap: distribution downward");
      return hold("No AMD sequence completing on this candle");
    },
  }),
  define({
    id: "trend_pullback",
    name: "Trend pullback",
    description: "In an uptrend (21 EMA above 50 EMA), buy when RSI dips below 45 and turns back up.",
    params: [spec("fastEma", "Fast EMA", 21, 5, 100), spec("slowEma", "Slow EMA (trend)", 50, 10, 200), spec("rsiPeriod", "RSI period", 14, 2, 50), spec("rsiLevel", "Buy when RSI turns up through", 45, 20, 60), STOP_ATR(1.5), REWARD_R],
    evaluate(ctx, i, p) {
      if (p.fastEma >= p.slowEma) return hold("The fast EMA must be shorter than the slow EMA");
      const fast = ctx.memo(`ema${p.fastEma}`, () => ema(ctx.closes, p.fastEma));
      const slow = ctx.memo(`ema${p.slowEma}`, () => ema(ctx.closes, p.slowEma));
      const r = ctx.memo(`rsi${p.rsiPeriod}`, () => rsi(ctx.closes, p.rsiPeriod));
      if (slow[i] == null || r[i] == null || r[i - 1] == null) return hold("Not enough candles yet");
      const c = ctx.candles[i];
      const uptrend = fast[i] > slow[i] && c.close > slow[i];
      if (uptrend && r[i - 1] < p.rsiLevel && r[i] >= p.rsiLevel && c.close > c.open) {
        return buy([`Uptrend: ${p.fastEma} EMA above ${p.slowEma} EMA`, `RSI pulled back and turned up (${fmt(r[i])})`], structureStops(ctx, i, p));
      }
      if (ctx.candles[i - 1].close >= slow[i - 1] && c.close < slow[i]) return sell(`Close fell below the ${p.slowEma} EMA: trend lost`);
      return hold(uptrend ? `Uptrend intact, waiting for a pullback (RSI ${fmt(r[i])})` : `No uptrend (${p.fastEma} EMA below ${p.slowEma} EMA or price under it)`);
    },
  }),
];

export const STRATEGY_BY_ID = Object.fromEntries(STRATEGIES.map((s) => [s.id, s]));

export function evaluateAll(ctx, i) {
  return STRATEGIES.map((strategy) => ({ id: strategy.id, name: strategy.name, ...strategy.evaluate(ctx, i) }));
}

/** Overall lean: how many strategies want to buy vs. exit. */
export function summarize(results) {
  const buys = results.filter((r) => r.signal === "BUY").length;
  const sells = results.filter((r) => r.signal === "SELL").length;
  const score = buys - sells;
  return { buys, sells, holds: results.length - buys - sells, bias: score >= 2 ? "bullish" : score <= -2 ? "bearish" : "neutral" };
}
