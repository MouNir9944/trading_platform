import { backtest } from "./backtest.js";
import { STRATEGIES, buildContext, evaluateAll, summarize } from "./strategies.js";

export { STRATEGIES, backtest, buildContext };
export * from "./indicators.js";
export * from "./structure.js";
export * from "./sessions.js";
export * from "./smc.js";
export * from "./amd.js";
export * from "./volumeProfile.js";
export * from "./manipulation.js";
export * from "./performance.js";

/**
 * Raw Binance klines (arrays) -> candle objects, oldest first, duplicates removed.
 * `closeTime` (ms) lets `analyze` know whether the last candle is still forming.
 */
export function toCandles(klines) {
  const unique = new Map(klines.map((k) => [Number(k[0]), k]));
  return [...unique.values()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map((k) => ({
      time: Math.floor(Number(k[0]) / 1000),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
      closeTime: Number(k[6]) || null,
    }));
}

/**
 * Full analysis of a candle series. Signals are judged on the last *closed* candle, because the
 * still-forming one flickers between BUY and HOLD with every tick.
 */
export function analyze(candles, { now = Date.now() } = {}) {
  if (candles.length < 30) return null;
  const ctx = buildContext(candles);
  const n = candles.length;
  const forming = candles[n - 1].closeTime != null && candles[n - 1].closeTime > now;
  const evalIndex = forming ? n - 2 : n - 1;
  const results = evaluateAll(ctx, evalIndex);
  return {
    ctx,
    structure: ctx.structure,
    smc: ctx.smc,
    evalIndex,
    evalTime: candles[evalIndex].time,
    signals: results,
    summary: summarize(results),
    latest: snapshot(ctx, n - 1),
  };
}

/** Current value of every indicator, for the analysis panel. */
export function snapshot(ctx, i) {
  const { ind, candles } = ctx;
  const close = candles[i].close;
  const bandwidthHistory = ind.bb.bandwidth.slice(Math.max(0, i - 100), i).filter((v) => v != null).sort((a, b) => a - b);
  const squeezeThreshold = bandwidthHistory[Math.floor(bandwidthHistory.length * 0.25)] ?? null;
  return {
    close,
    rsi: ind.rsi[i],
    macd: { line: ind.macd.line[i], signal: ind.macd.signal[i], histogram: ind.macd.histogram[i] },
    bollinger: {
      upper: ind.bb.upper[i], mid: ind.bb.mid[i], lower: ind.bb.lower[i],
      percentB: ind.bb.percentB[i], bandwidth: ind.bb.bandwidth[i],
      squeeze: squeezeThreshold != null && ind.bb.bandwidth[i] != null && ind.bb.bandwidth[i] <= squeezeThreshold,
    },
    atr: ind.atr[i],
    atrPercent: ind.atr[i] != null ? (ind.atr[i] / close) * 100 : null,
    stochastic: { k: ind.stoch.k[i], d: ind.stoch.d[i] },
    adx: { value: ind.adx.adx[i], plusDi: ind.adx.plusDi[i], minusDi: ind.adx.minusDi[i] },
    supertrend: { direction: ind.supertrend.trend[i], line: ind.supertrend.line[i] },
    ema21: ind.ema21[i],
    ema50: ind.ema50[i],
    volumeRatio: ind.volSma[i] ? candles[i].volume / ind.volSma[i] : null,
  };
}
