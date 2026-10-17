/**
 * Volume profile + order flow.
 *
 * The volume profile shows where trading actually happened over the last N candles: the point of control (POC, the
 * price with the most volume) and the value area (the band holding most of the volume, between VAL and VAH). Price
 * inside the value area is "fair"; outside it is not yet accepted. Order flow (delta, see analysis/orderFlow.js) says
 * who was aggressive. The two together give two setups:
 *
 *   Value-area rejection   price pokes beyond the edge of the value area and CLOSES BACK INSIDE, on aggressive
 *                          buying (at the low edge) or selling (at the high edge). The poke was rejected. Stop beyond
 *                          the extreme of the poke; target the point of control (or the far edge).
 *   Acceptance breakout    price CLOSES OUTSIDE the value area for the first time with aggressive flow in that direction and
 *                          above-average volume: new value is being accepted. Stop back inside the value area; target the
 *                          value area's height projected from the entry. (Optional.)
 *
 * Both need the candle's delta to agree with its direction, the cumulative delta of the last few candles to agree
 * too, and volume at least average. The profile is built from the candles BEFORE the signal candle only, so nothing
 * here looks ahead. Where the data carries no taker volume the delta is estimated from the candle shape and the signal's
 * reasons say so.
 */
import { atr } from "../analysis/indicators.js";
import { candleFlow } from "../analysis/orderFlow.js";
import { volumeProfile } from "../analysis/volumeProfile.js";

const spec = (key, label, def, min, max, step, hint) => ({ key, label, type: "number", default: def, min, max, step, integer: Number.isInteger(step) && Number.isInteger(def), ...(hint ? { hint } : {}) });

const PROFILE_ROWS = 48;
const VOLUME_AVERAGE = 20; // candles that make up "the recent average volume"
const MIN_VALUE_ATR = 1; // a value area narrower than this is noise, not a level worth trading

const price = (x) => Number(x.toPrecision(5));

export const volumeFlowStrategy = {
  id: "volume_flow",
  name: "Volume profile + order flow",
  summary: "Trades the edges of the value area when real buying or selling pressure confirms it.",
  description:
    "Builds the volume profile of the last N candles (point of control and value area) and reads the order flow of each new candle: how much of its volume was bought or sold aggressively. Buys when price dips below the value area and closes back inside on aggressive buying (shorts the mirror above it), with the stop beyond the poke and the target at the point of control. Optionally also trades a first close outside the value area when the flow and the volume push the same way. Uses Binance's taker-buy volume; on data without it the pressure is estimated from the candle shape.",
  directions: ["long", "short"],
  supportsRetest: true, // the edge of the value area is a better, tighter entry than the close that confirmed it
  params: [
    spec("lookback", "Profile length (candles)", 100, 30, 300, 5, "How many candles before the signal build the volume profile"),
    spec("valuePct", "Value area (% of volume)", 70, 50, 90, 5, "How much of the volume the value area holds; 70 is the usual choice"),
    spec("minDelta", "Min buying/selling pressure (%)", 20, 0, 80, 5, "Net aggressive volume as a share of the candle's volume. 0 only needs the right direction"),
    spec("volumeFactor", "Min volume (× recent average)", 1, 0.5, 3, 0.1, "The signal candle must trade at least this much of the average of the previous 20 candles"),
    spec("cvdBars", "Cumulative delta window (candles)", 3, 1, 10, 1, "The summed delta of this many candles, ending with the signal, must point the same way"),
    spec("probeAtr", "Min poke beyond the edge (ATR)", 0.05, 0, 1, 0.05, "How far price must have gone past the value area edge before coming back"),
    spec("stopAtr", "Stop beyond the extreme (ATR)", 0.3, 0.1, 2, 0.1),
    spec("targetAt", "Reversal target: 0 = point of control, 1 = far edge", 0, 0, 1, 1),
    spec("breakouts", "Also trade breakouts (0 = no, 1 = yes)", 1, 0, 1, 1, "A first close outside the value area with flow and volume behind it"),
  ],
  detect(candles, params) {
    const p = params;
    const range = atr(candles, 14);
    const flow = candles.map(candleFlow);
    const out = [];

    for (let i = p.lookback; i < candles.length; i++) {
      const a = range[i];
      if (!(a > 0)) continue;
      const c = candles[i];
      const f = flow[i];

      // Cheap checks first (this candle only), the volume profile last: most candles fail here.
      if (Math.abs(f.ratio) < p.minDelta / 100 || f.ratio === 0) continue;
      const bull = f.ratio > 0;
      if (bull ? !(c.close > c.open) : !(c.close < c.open)) continue; // the candle must close in the direction of the flow
      let volumeSum = 0;
      for (let j = i - VOLUME_AVERAGE; j < i; j++) volumeSum += candles[j].volume;
      const average = volumeSum / VOLUME_AVERAGE;
      if (!(c.volume >= p.volumeFactor * average)) continue;
      let cvd = 0;
      for (let j = i - p.cvdBars + 1; j <= i; j++) cvd += flow[j].delta;
      if (bull ? !(cvd > 0) : !(cvd < 0)) continue;

      // The profile of what traded BEFORE this candle.
      const profile = volumeProfile(candles.slice(i - p.lookback, i), { rows: PROFILE_ROWS, valueAreaPct: p.valuePct / 100 });
      if (!profile || !(profile.step > 0)) continue;
      const { vah, val, poc } = profile;
      if (vah - val < MIN_VALUE_ATR * a) continue;

      const source = f.measured ? "taker volume" : "estimated from the candle shape, no taker volume in this data";
      const pressure = `${Math.round(Math.abs(f.ratio) * 100)}% net ${bull ? "buying" : "selling"} (${source})`;
      const backing = `Volume ${(c.volume / average).toFixed(1)}× the recent average, cumulative delta over ${p.cvdBars} candle${p.cvdBars === 1 ? "" : "s"} ${bull ? "positive" : "negative"}`;

      if (bull) {
        // Poked below the value area and closed back inside it.
        if (c.low <= val - p.probeAtr * a && c.close > val) {
          const entry = c.close;
          const stop = c.low - p.stopAtr * a;
          const target = p.targetAt === 0 ? poc : vah;
          if (target > entry) {
            out.push({ dir: "bull", formedAt: i, entry, stop, target, retest: val, reasons: [`Price dipped below the value area low (${price(val)}) and closed back inside it`, `Order flow: ${pressure}`, backing] });
            continue;
          }
        }
        // First close above the value area.
        if (p.breakouts && c.close > vah && candles[i - 1].close <= vah) {
          const entry = c.close;
          const stop = vah - p.stopAtr * a;
          if (stop < entry) {
            out.push({ dir: "bull", formedAt: i, entry, stop, target: entry + (vah - val), retest: vah, reasons: [`First close above the value area high (${price(vah)}): price is being accepted higher`, `Order flow: ${pressure}`, backing] });
          }
        }
      } else {
        if (c.high >= vah + p.probeAtr * a && c.close < vah) {
          const entry = c.close;
          const stop = c.high + p.stopAtr * a;
          const target = p.targetAt === 0 ? poc : val;
          if (target < entry) {
            out.push({ dir: "bear", formedAt: i, entry, stop, target, retest: vah, reasons: [`Price pushed above the value area high (${price(vah)}) and closed back inside it`, `Order flow: ${pressure}`, backing] });
            continue;
          }
        }
        if (p.breakouts && c.close < val && candles[i - 1].close >= val) {
          const entry = c.close;
          const stop = val + p.stopAtr * a;
          if (stop > entry) {
            out.push({ dir: "bear", formedAt: i, entry, stop, target: entry - (vah - val), retest: val, reasons: [`First close below the value area low (${price(val)}): price is being accepted lower`, `Order flow: ${pressure}`, backing] });
          }
        }
      }
    }
    return out;
  },
};
