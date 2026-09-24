import { dayInfo } from "./sessions.js";

/**
 * Volume profile: how much traded at each price, rather than at each moment.
 *
 *  - POC (point of control): the price with the most volume. Price tends to be pulled back to it.
 *  - Value area: the band around the POC holding `valueAreaPct` (70%) of the volume. VAL is its floor, VAH its ceiling.
 *    Outside it, price is moving through "unaccepted" territory quickly; inside it, price is balanced.
 *
 * Candle data has no tick detail, so each candle's volume is spread evenly over the price rows its range touched.
 * That is coarse on wide candles, which is why the daily profile needs an intraday timeframe (see MAX_STEP_SECONDS).
 */

export const VP_DEFAULTS = { rows: 48, valueAreaPct: 0.7 };
/** Slowest candle the daily profile accepts: 4h gives six candles a day, anything slower is not a profile. */
export const MAX_STEP_SECONDS = 4 * 3600;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Profile of a run of candles. Returns null for no candles. Rows go from the lowest price up. */
export function volumeProfile(candles, { rows = VP_DEFAULTS.rows, valueAreaPct = VP_DEFAULTS.valueAreaPct } = {}) {
  if (!candles.length) return null;
  let low = Infinity;
  let high = -Infinity;
  let total = 0;
  for (const c of candles) {
    if (c.low < low) low = c.low;
    if (c.high > high) high = c.high;
    total += c.volume;
  }

  // Every candle at one price: a single row holding everything.
  if (!(high > low)) {
    return { low, high, step: 0, rows: [{ low, high, price: low, volume: total }], pocIndex: 0, poc: low, vah: high, val: low, total, valueAreaPct: 1 };
  }

  const step = (high - low) / rows;
  const volume = new Array(rows).fill(0);
  for (const c of candles) {
    const first = clamp(Math.floor((c.low - low) / step), 0, rows - 1);
    const last = clamp(Math.floor((c.high - low) / step), 0, rows - 1);
    const share = c.volume / (last - first + 1);
    for (let i = first; i <= last; i++) volume[i] += share;
  }

  // POC: the busiest row. On a tie take the one nearest the middle of the range.
  const middle = (rows - 1) / 2;
  let pocIndex = 0;
  for (let i = 1; i < rows; i++) {
    if (volume[i] > volume[pocIndex] || (volume[i] === volume[pocIndex] && Math.abs(i - middle) < Math.abs(pocIndex - middle))) pocIndex = i;
  }

  // Value area: grow outward from the POC, each time adding the two rows on whichever side holds more volume.
  let lo = pocIndex;
  let hi = pocIndex;
  let inside = volume[pocIndex];
  const target = total * valueAreaPct;
  while (inside < target && (lo > 0 || hi < rows - 1)) {
    const up = (hi + 1 < rows ? volume[hi + 1] : 0) + (hi + 2 < rows ? volume[hi + 2] : 0);
    const down = (lo - 1 >= 0 ? volume[lo - 1] : 0) + (lo - 2 >= 0 ? volume[lo - 2] : 0);
    const goUp = hi === rows - 1 ? false : lo === 0 ? true : up >= down;
    if (goUp) {
      for (let k = 0; k < 2 && hi + 1 < rows; k++) { hi += 1; inside += volume[hi]; }
    } else {
      for (let k = 0; k < 2 && lo - 1 >= 0; k++) { lo -= 1; inside += volume[lo]; }
    }
  }

  return {
    low,
    high,
    step,
    rows: volume.map((v, i) => ({ low: low + i * step, high: low + (i + 1) * step, price: low + (i + 0.5) * step, volume: v })),
    pocIndex,
    poc: low + (pocIndex + 0.5) * step,
    vah: low + (hi + 1) * step,
    val: low + lo * step,
    vaLow: lo,
    vaHigh: hi,
    total,
    valueAreaPct: total ? inside / total : 0,
  };
}

/**
 * One profile per calendar day in `timeZone` (the same day boundaries as the chart's day bands).
 * `supported` is false when the candles are too slow to build a daily profile from; `days` is then empty.
 * The newest day is flagged `developing`: its profile is still filling in.
 */
export function dailyProfiles(candles, timeZone, options = {}) {
  if (candles.length < 2) return { supported: true, step: 0, days: [] }; // nothing loaded yet is not the same as a bad timeframe
  const step = candles[1].time - candles[0].time;
  if (step > MAX_STEP_SECONDS) return { supported: false, step, days: [] };

  const minCandles = options.minCandles ?? Math.min(6, Math.floor(86400 / step / 4));
  const runs = dayInfo(candles, timeZone);
  const days = [];
  runs.forEach((run, i) => {
    const developing = i === runs.length - 1;
    const slice = candles.slice(run.startIndex, run.endIndex);
    // A partial day at the start of the history is too thin to trust; the live day is always shown.
    if (!developing && slice.length < minCandles) return;
    const profile = volumeProfile(slice, options);
    if (!profile) return;
    days.push({
      key: run.key,
      label: run.label,
      startTime: run.startTime,
      endTime: developing ? slice[slice.length - 1].time + step : runs[i + 1].startTime,
      developing,
      candleCount: slice.length,
      ...profile,
    });
  });
  return { supported: true, step, days };
}

/** Where a price sits against a day's value area. */
export function valueAreaPosition(price, day) {
  if (!day || price == null) return null;
  if (price > day.vah) return "above";
  if (price < day.val) return "below";
  return "inside";
}

/**
 * The headline read for the status chip: today's developing levels, yesterday's finished ones, and where price is
 * against each. `days` comes from dailyProfiles().
 */
export function dailySummary(days, price) {
  const today = days.length && days[days.length - 1].developing ? days[days.length - 1] : null;
  const prev = today ? days[days.length - 2] ?? null : days[days.length - 1] ?? null;
  return {
    today,
    prev,
    vsToday: valueAreaPosition(price, today),
    vsPrev: valueAreaPosition(price, prev),
    // Distance from the prior day's POC, in percent of price. Positive = price is above it.
    pocGapPct: prev && price ? ((price - prev.poc) / price) * 100 : null,
  };
}
