/**
 * The strategy platform. A strategy is one object; everything else (the chart, the backtest, the comparison, the
 * automatic trader, the notifications) works with any strategy that follows this contract and is registered below.
 *
 *   {
 *     id, name, summary, description,
 *     directions: ["long"] | ["long", "short"],
 *     supportsRetest: boolean,                 // gives `retest` prices, so "enter on a retest" works
 *     params: [{ key, label, type: "number", default, min, max, step, integer?, hint? }],
 *     detect(candles, params) -> Signal[]      // candles oldest first, params already resolved
 *   }
 *   Signal = { dir: "bull" | "bear", formedAt, entry, stop, target, retest?, reasons: string[], status? }
 *
 * The one rule: NO LOOK-AHEAD. A signal with `formedAt = i` may only depend on candles[0..i]. server/strategies.test.js
 * checks this for every registered strategy, so a new one is tested the moment it is added to `STRATEGIES`.
 *
 * To add a strategy: create shared/strategies/<name>.js exporting an object like the above and add it to STRATEGIES.
 */
import { amdStrategy } from "./amd.js";
import { classicStrategies } from "./classic.js";
import { rangeBounceStrategy } from "./rangeBounce.js";

export const STRATEGIES = [amdStrategy, rangeBounceStrategy, ...classicStrategies];
export const STRATEGY_BY_ID = Object.fromEntries(STRATEGIES.map((s) => [s.id, s]));

const bad = (message) => Object.assign(new Error(message), { httpStatus: 422 });

export function defaultParams(strategy) {
  return Object.fromEntries(strategy.params.map((p) => [p.key, p.default]));
}

/** Fill in defaults and validate a (possibly partial) params object. Throws a readable error on anything wrong. */
export function resolveParams(strategy, given = {}) {
  const out = defaultParams(strategy);
  const known = new Map(strategy.params.map((p) => [p.key, p]));
  for (const [key, value] of Object.entries(given ?? {})) {
    const spec = known.get(key);
    if (!spec) throw bad(`${strategy.name} has no setting called "${key}"`);
    const n = Number(value);
    if (!Number.isFinite(n) || n < spec.min || n > spec.max || (spec.integer && !Number.isInteger(n))) {
      throw bad(`${spec.label} must be ${spec.integer ? "a whole number " : ""}between ${spec.min} and ${spec.max}`);
    }
    out[key] = n;
  }
  return out;
}

/** Like `resolveParams`, but a value outside its limits is pulled back to them and an unusable one falls back to the default. */
export function clampParams(strategy, given = {}) {
  const out = defaultParams(strategy);
  for (const spec of strategy.params) {
    const n = Number(given?.[spec.key]);
    if (given?.[spec.key] == null || given[spec.key] === "" || !Number.isFinite(n)) continue;
    const v = Math.min(spec.max, Math.max(spec.min, n));
    out[spec.key] = spec.integer ? Math.round(v) : v;
  }
  return out;
}

/** Signals of a strategy over the candles, with its params resolved. Oldest first. */
export function detectSignals(strategy, candles, params = {}) {
  return strategy.detect(candles, resolveParams(strategy, params)).sort((a, b) => a.formedAt - b.formedAt);
}

/** What the app needs to know about a strategy (no functions, safe to send to the browser). */
export function strategyInfo(strategy) {
  const { detect, ...info } = strategy;
  return info;
}
