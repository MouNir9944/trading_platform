/**
 * Technical indicators. Pure functions shared by the browser (chart overlays, analysis panel)
 * and the server tests. Every function returns an array the same length as its input, with
 * `null` wherever the indicator is not defined yet, so results index-align with the candles.
 *
 * Candles are `{ time, open, high, low, close, volume }` objects, oldest first.
 * All indicators are causal: value[i] only depends on data up to and including candle i.
 */

const nulls = (n) => new Array(n).fill(null);

export function sma(values, period) {
  const out = nulls(values.length);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Exponential moving average, seeded with the SMA of the first `period` values. */
export function ema(values, period) {
  const out = nulls(values.length);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** EMA over a series that may start with nulls (e.g. the MACD line). */
function emaSparse(values, period) {
  const first = values.findIndex((v) => v !== null);
  const out = nulls(values.length);
  if (first < 0) return out;
  const tail = ema(values.slice(first), period);
  tail.forEach((v, i) => { out[first + i] = v; });
  return out;
}

/** Wilder's RSI. */
export function rsi(closes, period = 14) {
  const out = nulls(closes.length);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gain += change; else loss -= change;
  }
  gain /= period;
  loss /= period;
  const toRsi = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
  out[period] = toRsi();
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(change, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
    out[i] = toRsi();
  }
  return out;
}

export function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const line = closes.map((_, i) => (fastEma[i] !== null && slowEma[i] !== null ? fastEma[i] - slowEma[i] : null));
  const signal = emaSparse(line, signalPeriod);
  const histogram = line.map((v, i) => (v !== null && signal[i] !== null ? v - signal[i] : null));
  return { line, signal, histogram };
}

/** Bollinger Bands (population standard deviation, as TradingView does). */
export function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper = nulls(closes.length);
  const lower = nulls(closes.length);
  const bandwidth = nulls(closes.length);
  const percentB = nulls(closes.length);
  for (let i = period - 1; i < closes.length; i++) {
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (closes[j] - mid[i]) ** 2;
    const dev = Math.sqrt(variance / period) * mult;
    upper[i] = mid[i] + dev;
    lower[i] = mid[i] - dev;
    bandwidth[i] = mid[i] === 0 ? null : (upper[i] - lower[i]) / mid[i];
    percentB[i] = upper[i] === lower[i] ? 0.5 : (closes[i] - lower[i]) / (upper[i] - lower[i]);
  }
  return { mid, upper, lower, bandwidth, percentB };
}

export function trueRange(candles) {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
}

/** Wilder's Average True Range. */
export function atr(candles, period = 14) {
  const out = nulls(candles.length);
  if (candles.length < period) return out;
  const tr = trueRange(candles);
  let prev = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function stochastic(candles, kPeriod = 14, dPeriod = 3) {
  const k = nulls(candles.length);
  for (let i = kPeriod - 1; i < candles.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      hi = Math.max(hi, candles[j].high);
      lo = Math.min(lo, candles[j].low);
    }
    k[i] = hi === lo ? 50 : ((candles[i].close - lo) / (hi - lo)) * 100;
  }
  const kDense = k.map((v) => v ?? 0);
  const dRaw = sma(kDense, dPeriod);
  const d = dRaw.map((v, i) => (k[i - dPeriod + 1] === null || k[i - dPeriod + 1] === undefined ? null : v));
  return { k, d };
}

/** Average Directional Index with +DI / -DI (Wilder smoothing). */
export function adx(candles, period = 14) {
  const n = candles.length;
  const out = { adx: nulls(n), plusDi: nulls(n), minusDi: nulls(n) };
  if (n < period * 2) return out;
  const tr = trueRange(candles);
  const plusDm = [0];
  const minusDm = [0];
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
  }
  let smTr = 0;
  let smPlus = 0;
  let smMinus = 0;
  for (let i = 1; i <= period; i++) { smTr += tr[i]; smPlus += plusDm[i]; smMinus += minusDm[i]; }
  const dx = nulls(n);
  const record = (i) => {
    const plus = smTr === 0 ? 0 : (100 * smPlus) / smTr;
    const minus = smTr === 0 ? 0 : (100 * smMinus) / smTr;
    out.plusDi[i] = plus;
    out.minusDi[i] = minus;
    dx[i] = plus + minus === 0 ? 0 : (100 * Math.abs(plus - minus)) / (plus + minus);
  };
  record(period);
  for (let i = period + 1; i < n; i++) {
    smTr = smTr - smTr / period + tr[i];
    smPlus = smPlus - smPlus / period + plusDm[i];
    smMinus = smMinus - smMinus / period + minusDm[i];
    record(i);
  }
  let prev = 0;
  for (let i = period; i < period * 2; i++) prev += dx[i];
  prev /= period;
  out.adx[period * 2 - 1] = prev;
  for (let i = period * 2; i < n; i++) {
    prev = (prev * (period - 1) + dx[i]) / period;
    out.adx[i] = prev;
  }
  return out;
}

/** Supertrend: trailing ATR band. `trend` is +1 (up, line below price) or -1 (down, line above). */
export function supertrend(candles, period = 10, mult = 3) {
  const n = candles.length;
  const line = nulls(n);
  const trend = nulls(n);
  const range = atr(candles, period);
  let finalUpper = null;
  let finalLower = null;
  let dir = 1;
  for (let i = 0; i < n; i++) {
    if (range[i] === null) continue;
    const mid = (candles[i].high + candles[i].low) / 2;
    const basicUpper = mid + mult * range[i];
    const basicLower = mid - mult * range[i];
    const prevClose = i > 0 ? candles[i - 1].close : candles[i].close;
    finalUpper = finalUpper === null || basicUpper < finalUpper || prevClose > finalUpper ? basicUpper : finalUpper;
    finalLower = finalLower === null || basicLower > finalLower || prevClose < finalLower ? basicLower : finalLower;
    if (trend[i - 1] === null || trend[i - 1] === undefined) dir = candles[i].close >= mid ? 1 : -1;
    else if (dir === 1 && candles[i].close < finalLower) dir = -1;
    else if (dir === -1 && candles[i].close > finalUpper) dir = 1;
    trend[i] = dir;
    line[i] = dir === 1 ? finalLower : finalUpper;
  }
  return { line, trend };
}
