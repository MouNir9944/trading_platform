/**
 * Draws any strategy's signals on the chart, from the same signals the backtest and the automatic trader use: a marker
 * on the signal candle, the entry -> stop zone (risk) and entry -> target zone (reward), and what happened next
 * (target reached, stopped out, still open, never filled). Colours identify the strategy.
 */
import { STRATEGY_BY_ID, clampParams, detectSignals } from "../../shared/strategies/index.js";
import { TRADE_DEFAULTS, planTrade, simulate } from "../../shared/strategies/trade.js";

export const STRATEGY_COLORS = ["#5b9cff", "#e0aa48", "#b58cf5", "#35c48c", "#ee6a58", "#4fd1c5", "#f083c0", "#9bc655", "#c9a06b"];
export const strategyColor = (index) => STRATEGY_COLORS[index % STRATEGY_COLORS.length];

const withAlpha = (hex, alpha) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};
/** A short tag for the chart: the name's own acronym when it has one ("AMD: ..." -> "AMD"), else its initials. */
function initials(name) {
  const head = name.split(":")[0].trim();
  if (/^[A-Z0-9]{2,6}$/.test(head)) return head;
  return name.replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
}
const rText = (r) => `${r >= 0 ? "+" : "−"}${Math.abs(r).toFixed(1)}R`;

/**
 * What became of one signal, played on its own: "target", "stop", "open" (filled, not finished), "waiting" (order not
 * filled yet), "missed" (price ran to the target first, or the order lapsed) or "skipped" (no valid plan).
 */
export function signalOutcome(candles, signal, options) {
  const plan = planTrade(signal, options);
  if (!plan.ok) return { state: "skipped", plan };
  const run = simulate(candles, [signal], options);
  const t = run.trades[0];
  if (t) return { state: t.reason, plan, trade: t, endIndex: t.exitIndex };
  if (run.openTrade) return { state: "open", plan, trade: run.openTrade };
  const waiting = candles.length - 1 - signal.formedAt < (options.expiryCandles ?? TRADE_DEFAULTS.expiryCandles);
  return { state: run.missed.targetFirst || run.missed.expired || !waiting ? "missed" : "waiting", plan };
}

/** How a strategy is traded on the chart: what the user chose, kept inside sensible limits. */
export const DEFAULT_TRADE_SETTINGS = Object.freeze({ entryMode: "limit-close", targetMode: "own", targetR: 2, minRewardRisk: TRADE_DEFAULTS.minRewardRisk });

export function tradeSettingsOf(strategy, settings) {
  const t = { ...DEFAULT_TRADE_SETTINGS, ...(settings?.trade ?? {}) };
  const num = (v, d, lo, hi) => (Number.isFinite(Number(v)) && v !== "" && v != null ? Math.min(hi, Math.max(lo, Number(v))) : d);
  return {
    entryMode: strategy.supportsRetest && t.entryMode === "retest" ? "retest" : "limit-close",
    targetMode: t.targetMode === "r" ? "r" : "own",
    targetR: num(t.targetR, 2, 1, 5),
    minRewardRisk: num(t.minRewardRisk, TRADE_DEFAULTS.minRewardRisk, 0, 5),
  };
}

/**
 * Overlays (zones, lines, labels) for the selected strategies on `candles`.
 * @param {string[]} ids           strategy ids, in the order they were chosen (the order picks the colour)
 * @param {object[]} candles       oldest first, objects with time/open/high/low/close
 * @param {{market: string, perStrategy?: number, settings?: Object<string, {params?: object, trade?: object}>}} options
 */
export function buildStrategyOverlays(ids, candles, { market = "futures", perStrategy = 5, hideSkipped = true, settings = {} } = {}) {
  const zones = [];
  const lines = [];
  const labels = [];
  const summary = [];
  if (!candles?.length || candles.length < 60) return { zones, lines, labels, summary };
  const baseTrade = { ...TRADE_DEFAULTS, shorts: market === "futures", feePercent: market === "spot" ? 0.1 : 0.05 };
  const time = (i) => candles[Math.min(candles.length - 1, Math.max(0, i))].time;
  const step = candles.length > 1 ? candles[candles.length - 1].time - candles[candles.length - 2].time : 900;

  ids.forEach((id, order) => {
    const strategy = STRATEGY_BY_ID[id];
    if (!strategy) return;
    const color = strategyColor(order);
    const trade = { ...baseTrade, ...tradeSettingsOf(strategy, settings[id]) };
    const tag = initials(strategy.name);
    let signals;
    try {
      signals = detectSignals(strategy, candles, clampParams(strategy, settings[id]?.params));
    } catch {
      return;
    }
    const shown = signals
      .map((s) => ({ s, out: signalOutcome(candles, s, trade) }))
      .filter((x) => !(hideSkipped && x.out.state === "skipped"))
      .slice(-perStrategy);
    const newest = shown[shown.length - 1];
    const latest = newest && (() => {
      const dirWord = newest.s.dir === "bull" ? "long" : "short";
      const state = newest.out.state;
      const outcome = state === "target" ? `won ${rText(newest.out.trade.r)}` : state === "stop" ? `lost ${rText(newest.out.trade.r)}`
        : state === "open" ? "still open" : state === "waiting" ? "waiting for the entry to fill" : "the order lapsed unfilled";
      return `${dirWord} — ${outcome}`;
    })();
    summary.push({ id, name: strategy.name, color, tag, signals: signals.length, shown: shown.length, latest });

    for (const { s, out } of shown) {
      const long = s.dir === "bull";
      const plan = out.plan;
      const end = out.endIndex != null ? out.endIndex : candles.length - 1;
      const endTime = Math.max(time(end), time(s.formedAt)) + step;
      const dead = out.state === "missed" || out.state === "skipped";
      const r = out.trade ? rText(out.trade.r) : null;
      const verdict = out.state === "target" ? `✓ ${r}` : out.state === "stop" ? `✗ ${r}` : out.state === "open" ? "open" : out.state === "waiting" ? "waiting for fill" : "not filled";

      labels.push({ time: time(s.formedAt), price: long ? candles[s.formedAt].low : candles[s.formedAt].high, text: `${tag} ${long ? "▲" : "▼"}`, color, side: long ? "below" : "above", size: 11 });
      if (!plan.ok) continue;
      // risk (entry -> stop) and reward (entry -> target), drawn until the trade ended
      zones.push({
        top: Math.max(plan.entry, plan.stop), bottom: Math.min(plan.entry, plan.stop), time: time(s.formedAt), endTime,
        fill: withAlpha("#ee6a58", dead ? 0.06 : 0.14), border: dead ? null : withAlpha("#ee6a58", 0.5), label: null, textColor: "#f58a8a",
      });
      zones.push({
        top: Math.max(plan.entry, plan.target), bottom: Math.min(plan.entry, plan.target), time: time(s.formedAt), endTime,
        fill: withAlpha("#35c48c", dead ? 0.06 : 0.14), border: dead ? null : withAlpha("#35c48c", 0.5), label: `${tag} · ${verdict}`, textColor: withAlpha(color, 1),
      });
      lines.push({ price: plan.entry, time: time(s.formedAt), endTime, color: withAlpha(color, dead ? 0.35 : 0.9), dash: [3, 3], width: 1, label: null });
    }
  });
  return { zones, lines, labels, summary };
}
