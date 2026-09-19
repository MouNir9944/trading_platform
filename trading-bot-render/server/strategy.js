/**
 * Strategy engine: Moving Average crossover + Breakout.
 * Pure logic, no I/O. Port of strategy.py and risk_manager.py.
 */

export const Signal = { BUY: "BUY", SELL: "SELL", HOLD: "HOLD" };

export const defaultStrategyConfig = { fastMaPeriod: 9, slowMaPeriod: 21, breakoutLookback: 20 };

export const defaultRiskConfig = {
  riskPerTradePct: 0.01,
  stopLossPct: 0.02,
  takeProfitPct: 0.04,
  trailingStopPct: 0.015,
};

/** Binance klines are [openTime, open, high, low, close, volume, ...] with numeric strings. */
export function klinesToCandles(klines) {
  return klines.map((k) => ({
    openTime: k[0],
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
}

/** Simple moving average of `key` ending at index `end` (inclusive); null until the window fills. */
function sma(candles, end, period, key = "close") {
  if (end + 1 < period) return null;
  let sum = 0;
  for (let i = end - period + 1; i <= end; i++) sum += candles[i][key];
  return sum / period;
}

export function generateSignal(candles, config = defaultStrategyConfig) {
  const { fastMaPeriod, slowMaPeriod, breakoutLookback } = config;
  if (candles.length < slowMaPeriod + 2) return Signal.HOLD;

  const last = candles.length - 1;
  const prevFast = sma(candles, last - 1, fastMaPeriod);
  const prevSlow = sma(candles, last - 1, slowMaPeriod);
  const currFast = sma(candles, last, fastMaPeriod);
  const currSlow = sma(candles, last, slowMaPeriod);
  if ([prevFast, prevSlow, currFast, currSlow].some((v) => v === null)) return Signal.HOLD;

  const crossedUp = prevFast <= prevSlow && currFast > currSlow;
  const crossedDown = prevFast >= prevSlow && currFast < currSlow;

  // The breakout range excludes the current candle.
  const prior = candles.slice(-(breakoutLookback + 1), -1);
  const priorHigh = Math.max(...prior.map((c) => c.high));
  const priorLow = Math.min(...prior.map((c) => c.low));
  const close = candles[last].close;

  if (crossedUp && close > priorHigh) return Signal.BUY;
  if (crossedDown && close < priorLow) return Signal.SELL;
  return Signal.HOLD;
}

/** Size the position so hitting the stop-loss loses exactly `riskPerTradePct` of capital. */
export function calculatePositionSizeByRisk(capitalUsdt, entryPrice, config = defaultRiskConfig) {
  const maxLoss = capitalUsdt * config.riskPerTradePct;
  const lossPerUnit = entryPrice - entryPrice * (1 - config.stopLossPct);
  return maxLoss / lossPerUnit;
}

export function calculateExitPrices(entryPrice, config = defaultRiskConfig) {
  return {
    entry_price: entryPrice,
    stop_loss_price: Number((entryPrice * (1 - config.stopLossPct)).toFixed(6)),
    take_profit_price: Number((entryPrice * (1 + config.takeProfitPct)).toFixed(6)),
  };
}
