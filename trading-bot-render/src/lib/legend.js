/**
 * Builds the chart's "Legend" panel: for every indicator or strategy that is currently switched on, what its
 * abbreviations mean and a one-line, live read of what it is currently saying. Nothing here recomputes anything —
 * it only reads the analysis, LuxAlgo result, daily-profile summary and strategy overlay summary the chart already
 * built for drawing.
 */
import { SESSIONS, sessionAtUtcHour, zonedParts } from "../../shared/analysis/sessions.js";

const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const utcRange = (s) => `${String(s.startUtc).padStart(2, "0")}:00–${String(s.endUtc).padStart(2, "0")}:00 UTC`;

const TREND_TEXT = {
  uptrend: "Uptrend: higher highs and higher lows",
  downtrend: "Downtrend: lower highs and lower lows",
  "weak-uptrend": "Weak uptrend: only half confirmed",
  "weak-downtrend": "Weak downtrend: only half confirmed",
  range: "No clear trend",
};

const biasWord = (b) => (b > 0 ? "bullish" : b < 0 ? "bearish" : "undetermined");

/**
 * @param {object} args
 * @param {object} args.overlays        the chart's own overlay toggles (structure, levels, fvg, ob, liq, pd)
 * @param {object} args.lux             the LuxAlgo SMC settings ({ enabled, ... })
 * @param {object|null} args.analysis   `analyze(candles)` — structure, smc, latest indicator values
 * @param {object|null} args.luxResult  `analyzeLux(candles, lux)`
 * @param {string[]} args.strategyIds   strategy ids ticked on the chart
 * @param {{summary: object[]}} args.stratOverlay   the result of `buildStrategyOverlays`
 * @param {object|null} args.dvpSummary  today's/prior day's POC and value area, as shown in the volume-profile status pill
 * @param {string} args.timeZone        the chart's time zone, for the days/sessions read
 * @param {(n:number) => string} args.formatPrice
 */
export function buildLegend({ overlays, lux, analysis, luxResult, strategyIds, stratOverlay, dvpSummary, timeZone, formatPrice }) {
  const sections = [];
  const fmt = formatPrice ?? ((n) => (n == null ? "—" : n.toFixed(2)));
  const lastCandle = analysis?.ctx.candles[analysis.ctx.candles.length - 1];

  if (overlays.days && lastCandle) {
    const weekday = zonedParts(lastCandle.time, timeZone).weekday;
    sections.push({
      key: "days", title: "Days",
      abbrevs: [["color band", "One calendar day; weekends get a different color so quiet days stand out at a glance"]],
      text: `The latest candle falls on a ${WEEKDAY_NAMES[weekday] ?? "day"}.`,
    });
  }
  if (overlays.sessions && lastCandle) {
    const session = sessionAtUtcHour(new Date(lastCandle.time * 1000).getUTCHours());
    sections.push({
      key: "sessions", title: "Sessions",
      abbrevs: SESSIONS.map((s) => [s.name, utcRange(s)]),
      text: `The latest candle is in the ${session.name} session.`,
    });
  }
  if (overlays.structure && analysis) {
    const { structure } = analysis;
    const last = structure.breaks[structure.breaks.length - 1];
    sections.push({
      key: "structure", title: "Structure",
      abbrevs: [
        ["HH", "Higher high"], ["HL", "Higher low"], ["LH", "Lower high"], ["LL", "Lower low"],
        ["BOS", "Break of structure — the trend continues"], ["CHoCH", "Change of character — the trend may be turning"],
      ],
      text: `${TREND_TEXT[structure.trend] ?? structure.trend}.${last ? ` Last break: ${last.direction === "bull" ? "bullish" : "bearish"} ${last.type} at ${fmt(last.level)}.` : " No break yet."}`,
    });
  }
  if (overlays.levels && analysis) {
    // the chart only ever draws the nearest 3 either side (PriceChart.jsx), so the count here matches what is drawn
    const resistances = analysis.structure.resistances.slice(0, 3);
    const supports = analysis.structure.supports.slice(0, 3);
    sections.push({
      key: "levels", title: "S/R",
      abbrevs: [["S ×N", "Support, touched N times before"], ["R ×N", "Resistance, touched N times before"]],
      text: `${resistances.length} resistance and ${supports.length} support level${supports.length === 1 ? "" : "s"} drawn.${resistances[0] ? ` Nearest resistance ${fmt(resistances[0].price)}.` : ""}${supports[0] ? ` Nearest support ${fmt(supports[0].price)}.` : ""}`,
    });
  }
  if (overlays.fvg && analysis) {
    const all = analysis.smc.fvgs.filter((g) => g.filledAt == null);
    const shown = all.slice(-12); // the chart draws at most the newest 12 (PriceChart.jsx)
    const bull = shown.filter((g) => g.type === "bull").length;
    sections.push({
      key: "fvg", title: "FVG",
      abbrevs: [["FVG ▲", "Bullish fair value gap — an up move that left an imbalance below, often revisited"], ["FVG ▼", "Bearish fair value gap, often revisited from above"], ["%", "How much of the gap price has already filled"]],
      text: shown.length ? `${shown.length}${all.length > shown.length ? ` of ${all.length}` : ""} open gap${shown.length === 1 ? "" : "s"} drawn (${bull} bullish, ${shown.length - bull} bearish).` : "No open gap in view.",
    });
  }
  if (overlays.ob && analysis) {
    const all = analysis.smc.orderBlocks.filter((b) => b.mitigatedAt == null);
    const shown = all.slice(-8); // the chart draws at most the newest 8
    sections.push({
      key: "ob", title: "Order blocks",
      abbrevs: [["OB ▲", "Bullish order block — the last down candle before a break up"], ["OB ▼", "Bearish order block — the last up candle before a break down"]],
      text: `${shown.length}${all.length > shown.length ? ` of ${all.length}` : ""} still active${shown.length ? ", drawn" : ""}.`,
    });
  }
  if (overlays.liq && analysis) {
    const all = analysis.smc.liquidity.filter((p) => p.brokenAt == null);
    const shown = all.slice(-10); // the chart draws at most the newest 10
    sections.push({
      key: "liq", title: "Liquidity",
      abbrevs: [["EQH", "Equal highs — stop-loss orders cluster just above"], ["EQL", "Equal lows — stop-loss orders cluster just below"], ["×N", "Touched N times"], ["swept", "Price already ran the stops through it and reversed"]],
      text: `${shown.length}${all.length > shown.length ? ` of ${all.length}` : ""} unswept pool${shown.length === 1 ? "" : "s"} drawn.`,
    });
  }
  if (overlays.pd && analysis?.smc.premiumDiscount) {
    const pd = analysis.smc.premiumDiscount;
    sections.push({
      key: "pd", title: "Premium / Discount",
      abbrevs: [["Premium", "Upper half of the swing range — where shorts look to sell"], ["Discount", "Lower half — where longs look to buy"], ["EQ 50%", "Midpoint of the range"]],
      text: `Price is in the ${pd.zone} half of the range (${Math.round(pd.position * 100)}%).`,
    });
  }
  if (overlays.dvp && dvpSummary?.today) {
    const t = dvpSummary.today;
    sections.push({
      key: "dvp", title: "Daily profile",
      abbrevs: [["POC", "Point of Control — the price that traded the most volume today"], ["VA", "Value Area — the range holding 70% of today's volume"]],
      text: `Today's POC ${fmt(t.poc)}, value area ${fmt(t.val)}–${fmt(t.vah)}.`,
    });
  }
  if (overlays.dvpPrev && dvpSummary?.prev) {
    const p = dvpSummary.prev;
    sections.push({
      key: "dvpPrev", title: "Prior-day POC/VA",
      abbrevs: [["pPOC", "Yesterday's Point of Control, projected across today"], ["pVAH / pVAL", "Yesterday's Value Area High/Low, projected across today"]],
      text: `Yesterday's POC ${fmt(p.poc)}, value area ${fmt(p.val)}–${fmt(p.vah)}. Often acts as support/resistance today.`,
    });
  }
  if (overlays.bb && analysis?.latest.bollinger) {
    const bb = analysis.latest.bollinger;
    const pct = bb.percentB != null ? Math.round(bb.percentB * 100) : null;
    sections.push({
      key: "bb", title: "BB (Bollinger Bands)",
      abbrevs: [["Upper / Lower", "2 standard deviations above/below the 20-candle average"], ["%B", "Where price sits inside the bands, 0–100%"], ["squeeze", "The bands are unusually narrow — often just before a bigger move"]],
      text: pct == null ? "Not enough candles yet." : `Price is at ${pct}% of the band width${bb.squeeze ? " — currently squeezed" : ""}.`,
    });
  }
  if (overlays.ema50 && analysis?.latest) {
    const { close, ema50 } = analysis.latest;
    sections.push({
      key: "ema50", title: "EMA 50",
      abbrevs: [["EMA 50", "Exponential moving average of the last 50 candles — a common trend line"]],
      text: ema50 == null ? "Not enough candles yet." : `Price is ${close >= ema50 ? "above" : "below"} the 50 EMA (${fmt(ema50)}).`,
    });
  }
  if (overlays.rsi && analysis?.latest) {
    const r = analysis.latest.rsi;
    const zone = r == null ? null : r < 30 ? "oversold" : r > 70 ? "overbought" : "neutral";
    sections.push({
      key: "rsi", title: "RSI",
      abbrevs: [["RSI", "Relative Strength Index, 0–100 — how far recent gains outpace recent losses"], ["< 30", "Oversold: a bounce is more likely"], ["> 70", "Overbought: a pullback is more likely"]],
      text: r == null ? "Not enough candles yet." : `RSI ${r.toFixed(1)} (${zone}).`,
    });
  }
  if (overlays.macd && analysis?.latest.macd) {
    const m = analysis.latest.macd;
    sections.push({
      key: "macd", title: "MACD",
      abbrevs: [["MACD line", "Fast EMA minus slow EMA — trend momentum"], ["Signal", "A smoothed average of the MACD line"], ["Histogram", "The gap between the two — momentum speeding up or slowing down"]],
      text: m.line == null || m.signal == null ? "Not enough candles yet." : `MACD is ${m.line > m.signal ? "above" : "below"} its signal line (${m.line > m.signal ? "bullish" : "bearish"} momentum).`,
    });
  }
  if (lux.enabled && luxResult) {
    const lastSwingBreak = [...luxResult.structures].reverse().find((s) => s.scope === "swing");
    sections.push({
      key: "lux", title: "SMC (LuxAlgo)",
      abbrevs: [
        ["HH / HL / LH / LL", "Swing labels — same meaning as Structure"],
        ["BOS", "Break of structure"], ["CHoCH", "Change of character"],
        ["EQH / EQL", "Equal highs/lows (liquidity)"],
        ["Strong High/Low", "A swing that broke the opposite trend"], ["Weak High/Low", "A swing that did not"],
        ["OB", "Order block"], ["FVG", "Fair value gap"], ["Premium / Discount", "Upper / lower half of the range"],
        ["PDH/PDL, PWH/PWL, PMH/PML", "Previous day / week / month high and low"],
      ],
      text: `Internal trend ${biasWord(luxResult.trend.internal)}, swing trend ${biasWord(luxResult.trend.swing)}.${lastSwingBreak ? ` Last swing break: ${lastSwingBreak.dir === "bull" ? "bullish" : "bearish"} ${lastSwingBreak.tag}.` : ""}`,
    });
  }
  for (const id of strategyIds) {
    const found = stratOverlay.summary.find((s) => s.id === id);
    if (!found) continue;
    sections.push({
      key: `strategy:${id}`, title: found.name, color: found.color,
      abbrevs: [
        [`${found.tag} ▲ / ▼`, "This strategy's tag, long / short"],
        ["green zone", "Reward: from the entry to the target"], ["red zone", "Risk: from the entry to the stop"],
        ["✓", "Target reached"], ["✗", "Stopped out"],
      ],
      text: found.shown ? `${found.shown} of ${found.signals} signal${found.signals === 1 ? "" : "s"} shown.${found.latest ? ` Latest: ${found.latest}.` : ""}` : `No signal in view (${found.signals} total on this history).`,
    });
  }
  return sections;
}
