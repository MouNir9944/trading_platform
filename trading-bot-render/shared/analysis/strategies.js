/**
 * Trading strategies. Each one looks at the state of the market as of candle `i` (using only data up to
 * and including that candle) and answers BUY / SELL / HOLD, with reasons and, for a BUY, suggested
 * stop-loss and take-profit prices.
 *
 * The bot trades spot, long-only: BUY means "open a long", SELL means "exit longs / stay out".
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
  return {
    candles,
    structure,
    amd,
    amdAt,
    smc: analyzeSmc(candles, structure, atrSeries),
    breakAt,
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

const RISK_REWARD = 2;

const hold = (...reasons) => ({ signal: "HOLD", reasons });
const buy = (reasons, stops) => ({ signal: "BUY", reasons, ...stops });
const sell = (...reasons) => ({ signal: "SELL", reasons });

const fmt = (n, digits = 1) => (n == null ? "—" : Number(n).toFixed(digits));
const crossedUp = (a, b, i) => a[i - 1] != null && b[i - 1] != null && a[i] != null && b[i] != null && a[i - 1] <= b[i - 1] && a[i] > b[i];
const crossedDown = (a, b, i) => a[i - 1] != null && b[i - 1] != null && a[i] != null && b[i] != null && a[i - 1] >= b[i - 1] && a[i] < b[i];

/** Stop a multiple of ATR below the entry; target at RISK_REWARD times the risk. */
function atrStops(ctx, i, slMult = 1.5) {
  const entry = ctx.candles[i].close;
  const range = ctx.ind.atr[i] ?? entry * 0.01;
  const stopLoss = entry - slMult * range;
  return { stopLoss, takeProfit: entry + RISK_REWARD * (entry - stopLoss) };
}

/** Stop just below the latest confirmed swing low when it gives a sane distance, otherwise ATR. */
function structureStops(ctx, i) {
  const entry = ctx.candles[i].close;
  const range = ctx.ind.atr[i] ?? entry * 0.01;
  const swing = [...swingsUpTo(ctx.structure.pivots, i)].reverse().find((s) => s.type === "low" && s.price < entry);
  if (swing) {
    const stopLoss = swing.price - 0.25 * range;
    const risk = entry - stopLoss;
    if (risk > 0.3 * range && risk < 5 * range) return { stopLoss, takeProfit: entry + RISK_REWARD * risk };
  }
  return atrStops(ctx, i);
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
  {
    id: "ma_cross",
    name: "MA crossover + breakout",
    description: "Fast MA (9) crosses the slow MA (21) and price closes beyond the last 20-candle range.",
    evaluate(ctx, i) {
      const { sma9, sma21 } = ctx.ind;
      if (sma21[i] == null || i < 22) return hold("Not enough candles yet");
      const { high, low } = priorExtremes(ctx.candles, i, 20);
      const close = ctx.candles[i].close;
      if (crossedUp(sma9, sma21, i)) {
        return close > high
          ? buy(["MA 9 crossed above MA 21", "Close broke the 20-candle high"], atrStops(ctx, i))
          : hold("MA 9 crossed above MA 21 but no breakout yet");
      }
      if (crossedDown(sma9, sma21, i)) {
        return close < low ? sell("MA 9 crossed below MA 21", "Close broke the 20-candle low") : hold("MA 9 crossed below MA 21 but no breakdown yet");
      }
      return hold(sma9[i] > sma21[i] ? "Fast MA above slow MA (no fresh cross)" : "Fast MA below slow MA (no fresh cross)");
    },
  },
  {
    id: "rsi_reversal",
    name: "RSI oversold reversal",
    description: "RSI climbs back above 30 on a green candle: a bounce from oversold. Exit when RSI falls back below 70.",
    evaluate(ctx, i) {
      const r = ctx.ind.rsi;
      if (r[i] == null || r[i - 1] == null) return hold("Not enough candles yet");
      const c = ctx.candles[i];
      if (r[i - 1] <= 30 && r[i] > 30 && c.close > c.open) {
        return buy([`RSI crossed back above 30 (${fmt(r[i])})`, "Green candle confirms the bounce"], atrStops(ctx, i, 1.5));
      }
      if (r[i - 1] >= 70 && r[i] < 70) return sell(`RSI fell back below 70 (${fmt(r[i])})`);
      const zone = r[i] < 30 ? "oversold" : r[i] > 70 ? "overbought" : "neutral";
      return hold(`RSI ${fmt(r[i])} (${zone})`);
    },
  },
  {
    id: "macd_momentum",
    name: "MACD momentum",
    description: "MACD line crosses above its signal line while price is above the 50 EMA.",
    evaluate(ctx, i) {
      const { line, signal } = ctx.ind.macd;
      const e50 = ctx.ind.ema50[i];
      if (signal[i] == null || e50 == null) return hold("Not enough candles yet");
      const close = ctx.candles[i].close;
      if (crossedUp(line, signal, i)) {
        return close > e50
          ? buy(["MACD crossed above its signal line", "Price is above the 50 EMA"], atrStops(ctx, i, 2))
          : hold("MACD crossed up but price is below the 50 EMA");
      }
      if (crossedDown(line, signal, i)) return sell("MACD crossed below its signal line");
      return hold(line[i] > signal[i] ? "MACD above signal (bullish momentum)" : "MACD below signal (bearish momentum)");
    },
  },
  {
    id: "bollinger_breakout",
    name: "Bollinger squeeze breakout",
    description: "After a volatility squeeze, price closes above the upper band on above-average volume.",
    evaluate(ctx, i) {
      const { bb, volSma } = ctx.ind;
      if (bb.upper[i] == null || bb.upper[i - 1] == null || i < 30) return hold("Not enough candles yet");
      const close = ctx.candles[i].close;
      const prevClose = ctx.candles[i - 1].close;
      const history = bb.bandwidth.slice(Math.max(0, i - 100), i).filter((v) => v != null).sort((a, b) => a - b);
      const threshold = history[Math.floor(history.length * 0.25)] ?? 0;
      const recentSqueeze = bb.bandwidth.slice(Math.max(0, i - 8), i).some((v) => v != null && v <= threshold);
      const volumeOk = volSma[i] != null && ctx.candles[i].volume >= volSma[i];
      if (close > bb.upper[i] && prevClose <= bb.upper[i - 1]) {
        if (recentSqueeze && volumeOk) {
          return buy(["Close broke above the upper band", "Volatility squeeze just before", "Volume above its 20-candle average"], atrStops(ctx, i, 2));
        }
        return hold(`Broke the upper band but ${recentSqueeze ? "volume is weak" : "there was no squeeze first"}`);
      }
      if (prevClose >= bb.mid[i - 1] && close < bb.mid[i]) return sell("Close fell back below the middle band");
      return hold(`Bandwidth ${fmt(bb.bandwidth[i] * 100, 2)}% (${bb.bandwidth[i] <= threshold ? "squeezed" : "normal"})`);
    },
  },
  {
    id: "supertrend",
    name: "Supertrend follower",
    description: "Buys when the Supertrend flips to up, exits when it flips down. The stop is the Supertrend line.",
    evaluate(ctx, i) {
      const { trend, line } = ctx.ind.supertrend;
      if (trend[i] == null || trend[i - 1] == null) return hold("Not enough candles yet");
      const entry = ctx.candles[i].close;
      if (trend[i - 1] === -1 && trend[i] === 1) {
        const stopLoss = line[i];
        return buy(["Supertrend flipped to up"], { stopLoss, takeProfit: entry + RISK_REWARD * (entry - stopLoss) });
      }
      if (trend[i - 1] === 1 && trend[i] === -1) return sell("Supertrend flipped to down");
      return hold(trend[i] === 1 ? "Supertrend is up (already in trend)" : "Supertrend is down");
    },
  },
  {
    id: "structure_break",
    name: "Structure break (BOS / CHoCH)",
    description: "Buys a close above the last swing high (break of structure or change of character). The stop goes below the last swing low.",
    evaluate(ctx, i) {
      if (ctx.structure.pivots.filter((p) => p.confirmedAt <= i).length < 4) return hold("Not enough structure yet");
      const brk = ctx.breakAt.get(i);
      if (brk?.direction === "bull") {
        const kind = brk.type === "BOS" ? "Bullish BOS: trend continuation" : "Bullish CHoCH: possible reversal";
        return buy([kind, "Closed above the last swing high"], structureStops(ctx, i));
      }
      if (brk?.direction === "bear") {
        return sell(brk.type === "BOS" ? "Bearish BOS: downtrend continues" : "Bearish CHoCH: uptrend may be over");
      }
      return hold(`Structure is ${ctx.structure.trend.replace("-", " ")}, no fresh break`);
    },
  },
  {
    id: "smc_zone",
    name: "Smart money: gap / order-block retest",
    description: "In a bullish structure, buys when price dips into an open fair value gap or bullish order block in the DISCOUNT half of the range and closes back up. The stop goes just below the zone. Mirror image (in premium, bearish) gives an exit signal.",
    evaluate(ctx, i) {
      if (i < 30 || ctx.ind.atr[i] == null) return hold("Not enough candles yet");
      const c = ctx.candles[i];
      const atr = ctx.ind.atr[i];
      const range = premiumDiscountAt(ctx.structure, i, c.close);
      if (!range) return hold("No swing range yet");
      const lastBreak = [...ctx.structure.breaks].reverse().find((b) => b.index <= i);
      const bias = lastBreak?.direction === "bull" ? "bullish" : lastBreak?.direction === "bear" ? "bearish" : null;
      const pct = Math.round(range.position * 100);

      const gaps = activeFvgs(ctx.smc, i);
      const blocks = activeOrderBlocks(ctx.smc, i);
      const zonesOf = (type) => [
        ...gaps.filter((g) => g.type === type).map((g) => ({ ...g, name: "fair value gap" })),
        ...blocks.filter((b) => b.type === type).map((b) => ({ ...b, name: "order block" })),
      ].filter((z) => z.formedAt < i);

      if (bias === "bullish" && range.position <= 0.5 && c.close > c.open) {
        const zone = zonesOf("bull").find((z) => c.low <= z.top && c.close >= z.bottom);
        if (zone) {
          const entry = c.close;
          const stopLoss = Math.min(zone.bottom, c.low) - 0.25 * atr;
          const risk = entry - stopLoss;
          const stops = risk > 0.3 * atr && risk < 5 * atr ? { stopLoss, takeProfit: entry + RISK_REWARD * risk } : atrStops(ctx, i);
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
  },
  {
    id: "amd_fvg",
    name: "AMD: sweep then fair value gap",
    description: "Waits for the full sequence: a tight accumulation range, a manipulation wick that sweeps one side and comes back, then a strong candle that leaves a fair value gap. Buys when the bullish gap forms (stop under the sweep, target the far side of the range). A bearish gap is an exit signal.",
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
  },
  {
    id: "trend_pullback",
    name: "Trend pullback",
    description: "In an uptrend (21 EMA above 50 EMA), buy when RSI dips below 45 and turns back up.",
    evaluate(ctx, i) {
      const { ema21, ema50, rsi: r } = ctx.ind;
      if (ema50[i] == null || r[i] == null || r[i - 1] == null) return hold("Not enough candles yet");
      const c = ctx.candles[i];
      const uptrend = ema21[i] > ema50[i] && c.close > ema50[i];
      if (uptrend && r[i - 1] < 45 && r[i] >= 45 && c.close > c.open) {
        return buy(["Uptrend: 21 EMA above 50 EMA", `RSI pulled back and turned up (${fmt(r[i])})`], structureStops(ctx, i));
      }
      if (ctx.candles[i - 1].close >= ema50[i - 1] && c.close < ema50[i]) return sell("Close fell below the 50 EMA: trend lost");
      return hold(uptrend ? `Uptrend intact, waiting for a pullback (RSI ${fmt(r[i])})` : "No uptrend (21 EMA below 50 EMA or price under the 50 EMA)");
    },
  },
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
