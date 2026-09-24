/**
 * The strategies of the Analysis tab, offered to the strategy platform. Each one already answers BUY / SELL / HOLD
 * for a candle (shared/analysis/strategies.js); a BUY with a stop and a take-profit becomes a long signal whose limit
 * entry is the close of that candle. SELL there means "exit a long", not "open a short", so no short signals come
 * from these.
 */
import { STRATEGIES, buildContext } from "../analysis/strategies.js";

const WARMUP = 60;
const contexts = new WeakMap(); // the indicators of a candle list are computed once, however many strategies read it

export function contextFor(candles) {
  let ctx = contexts.get(candles);
  if (!ctx) {
    ctx = buildContext(candles);
    contexts.set(candles, ctx);
  }
  return ctx;
}

function adapt(legacy) {
  return {
    id: legacy.id,
    name: legacy.name,
    summary: legacy.description,
    description: `${legacy.description} A buy signal enters at the close of its candle with the stop and take-profit the strategy suggests; it never opens shorts.`,
    directions: ["long"],
    supportsRetest: false,
    params: legacy.params,
    detect(candles, params) {
      const ctx = contextFor(candles);
      const out = [];
      for (let i = WARMUP; i < candles.length; i++) {
        const r = legacy.evaluate(ctx, i, params);
        if (r.signal !== "BUY" || !Number.isFinite(r.stopLoss) || !Number.isFinite(r.takeProfit)) continue;
        const entry = candles[i].close;
        if (!(r.stopLoss < entry && r.takeProfit > entry)) continue;
        out.push({ dir: "bull", formedAt: i, entry, stop: r.stopLoss, target: r.takeProfit, reasons: r.reasons });
      }
      return out;
    },
  };
}

export const classicStrategies = STRATEGIES.filter((s) => s.id !== "amd_fvg").map(adapt);
