/**
 * Backtest a strategy over historical candles, long-only, one position at a time.
 *
 * Realism rules (so results are not flattering):
 *  - A signal on candle i is acted on at the OPEN of candle i+1 (no trading on a close you had not seen).
 *  - Stop-loss and take-profit are checked inside each candle; if both could have hit, the stop wins.
 *  - Gaps through a level fill at the open, not at the level.
 *  - A SELL signal exits at that candle's close.
 *  - Exchange fees are charged on both sides.
 */
import { STRATEGY_BY_ID, buildContext } from "./strategies.js";

const WARMUP = 60;

export function backtest(candles, strategyId, { feePercent = 0.1, context } = {}) {
  const strategy = STRATEGY_BY_ID[strategyId];
  if (!strategy) throw new Error(`Unknown strategy: ${strategyId}`);
  const ctx = context ?? buildContext(candles);
  const fee = feePercent / 100;
  const trades = [];
  let position = null;

  const close = (exitIndex, price, reason, open = false) => {
    const net = (price * (1 - fee)) / (position.entry * (1 + fee)) - 1;
    trades.push({
      entryIndex: position.entryIndex,
      entryTime: candles[position.entryIndex].time,
      entry: position.entry,
      exitIndex,
      exitTime: candles[exitIndex].time,
      exit: price,
      returnPct: net * 100,
      reason,
      open,
    });
    position = null;
  };

  for (let i = WARMUP; i < candles.length; i++) {
    const bar = candles[i];
    if (position && i >= position.entryIndex) {
      if (bar.open <= position.stopLoss) close(i, bar.open, "stop-loss (gap)");
      else if (bar.low <= position.stopLoss) close(i, position.stopLoss, "stop-loss");
      else if (bar.open >= position.takeProfit) close(i, bar.open, "take-profit (gap)");
      else if (bar.high >= position.takeProfit) close(i, position.takeProfit, "take-profit");
      else if (strategy.evaluate(ctx, i).signal === "SELL") close(i, bar.close, "exit signal");
    }
    if (!position && i < candles.length - 1) {
      const result = strategy.evaluate(ctx, i);
      if (result.signal === "BUY" && result.stopLoss != null && result.takeProfit != null) {
        const entry = candles[i + 1].open;
        if (entry > result.stopLoss && entry < result.takeProfit) {
          position = { entryIndex: i + 1, entry, stopLoss: result.stopLoss, takeProfit: result.takeProfit };
        }
      }
    }
  }
  if (position && position.entryIndex <= candles.length - 1) {
    close(candles.length - 1, candles[candles.length - 1].close, "still open", true);
  }

  return { strategyId, trades, stats: summarizeTrades(trades, candles), equity: equityCurve(trades) };
}

function equityCurve(trades) {
  let equity = 1;
  return trades.map((trade) => {
    equity *= 1 + trade.returnPct / 100;
    return { time: trade.exitTime, equity };
  });
}

function summarizeTrades(trades, candles) {
  const wins = trades.filter((t) => t.returnPct > 0);
  const losses = trades.filter((t) => t.returnPct <= 0);
  const grossWin = wins.reduce((s, t) => s + t.returnPct, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.returnPct, 0));

  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const trade of trades) {
    equity *= 1 + trade.returnPct / 100;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }

  const first = candles[Math.min(WARMUP, candles.length - 1)];
  const last = candles[candles.length - 1];
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : null,
    avgWinPct: wins.length ? grossWin / wins.length : null,
    avgLossPct: losses.length ? -grossLoss / losses.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
    expectancyPct: trades.length ? trades.reduce((s, t) => s + t.returnPct, 0) / trades.length : null,
    totalReturnPct: (equity - 1) * 100,
    maxDrawdownPct: maxDrawdown * 100,
    buyHoldPct: first && last ? (last.close / first.close - 1) * 100 : null,
    candles: candles.length - WARMUP,
  };
}
