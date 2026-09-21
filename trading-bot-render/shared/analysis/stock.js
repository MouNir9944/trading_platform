/**
 * Stock analyzer: a plain-language technical read of a stock or ETF from its DAILY candles, answering
 * "does this look like a good time to buy?". Pure functions, shared by the browser and the tests.
 *
 * It scores six things out of 100 and explains every point it gave or withheld:
 *   trend (30)          price vs the 50 and 200 day averages, their order, and the slope of the 200
 *   momentum (25)       RSI, MACD, and the last 3 and 6 months
 *   relative strength (10)  the last 3 months against a benchmark (the S&P 500 ETF), when one is given
 *   position (15)       distance from the 52-week high and how stretched price is above its 50-day average
 *   risk (15)           volatility and the worst fall of the last year
 *   structure (5)       whether swing highs and lows are rising
 * Anything that cannot be measured (too little history, no benchmark) is left out and the score is scaled.
 *
 * It only sees prices. It knows nothing about earnings, news, valuation or the company itself.
 */
import { atr, macd, rsi, sma } from "./indicators.js";
import { analyzeStructure } from "./structure.js";

const TRADING_DAYS = 252;
const pct = (a, b) => (b > 0 ? (a / b - 1) * 100 : null);
const last = (arr) => arr[arr.length - 1];
const round = (n, d = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);

/** Percentage return over the last `bars` candles, or null when there is not enough history. */
export function returnOver(closes, bars) {
  return closes.length > bars ? pct(last(closes), closes[closes.length - 1 - bars]) : null;
}

function stdev(values) {
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
}

/** Largest peak-to-trough fall (in %, positive) within the given closes. */
export function maxDrawdown(closes) {
  let peak = -Infinity;
  let worst = 0;
  for (const c of closes) {
    peak = Math.max(peak, c);
    worst = Math.max(worst, (1 - c / peak) * 100);
  }
  return worst;
}

const factor = (group, label, points, max, note, tone) => ({ group, label, points, max, note, tone: tone ?? (points >= max * 0.66 ? "good" : points >= max * 0.33 ? "mixed" : "bad") });

/**
 * @param candles   daily candles `{time, open, high, low, close, volume}`, oldest first
 * @param benchmark optional daily candles of a market benchmark (e.g. SPY) for relative strength
 */
export function analyzeStock(candles, { benchmark = null } = {}) {
  const n = candles.length;
  if (n < 60) {
    return { ok: false, reason: `Only ${n} daily candles are available: at least 60 are needed for a meaningful read.` };
  }
  const closes = candles.map((c) => c.close);
  const price = last(closes);
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const rsiSeries = rsi(closes, 14);
  const macdSeries = macd(closes);
  const atrSeries = atr(candles, 14);
  const has200 = sma200[n - 1] != null;
  const has50 = sma50[n - 1] != null;

  const hist = macdSeries.histogram;
  const rsiNow = last(rsiSeries);
  const atrNow = last(atrSeries);
  const yearCloses = closes.slice(-TRADING_DAYS);
  const high52 = Math.max(...candles.slice(-TRADING_DAYS).map((c) => c.high));
  const low52 = Math.min(...candles.slice(-TRADING_DAYS).map((c) => c.low));
  const fromHigh = pct(price, high52); // negative or zero
  const aboveSma50 = has50 ? pct(price, sma50[n - 1]) : null;
  const dailyReturns = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  const volatility = dailyReturns.length >= 20 ? stdev(dailyReturns.slice(-TRADING_DAYS)) * Math.sqrt(TRADING_DAYS) * 100 : null;
  const drawdown = maxDrawdown(yearCloses);
  const ret1m = returnOver(closes, 21);
  const ret3m = returnOver(closes, 63);
  const ret6m = returnOver(closes, 126);
  const ret1y = returnOver(closes, TRADING_DAYS);
  const benchmarkCloses = benchmark?.length > 63 ? benchmark.map((c) => c.close) : null;
  const benchmark3m = benchmarkCloses ? returnOver(benchmarkCloses, 63) : null;
  const dollarVolume = candles.slice(-20).reduce((s, c) => s + c.close * c.volume, 0) / Math.min(20, n);

  const f = [];

  // ---- trend (30) ----
  const trendNotes = [];
  if (has200) {
    const above200 = price > sma200[n - 1];
    f.push(factor("Trend", "Price vs 200-day average", above200 ? 10 : 0, 10, above200 ? `Above the 200-day average (${round(pct(price, sma200[n - 1]), 1)}% over it): the long-term trend is up.` : `Below the 200-day average (${round(pct(price, sma200[n - 1]), 1)}%): the long-term trend is down.`));
    const slope = sma200[n - 1] > sma200[n - 21];
    f.push(factor("Trend", "200-day average direction", slope ? 4 : 0, 4, slope ? "The 200-day average is rising." : "The 200-day average is flat or falling."));
  } else trendNotes.push("Less than 200 days of history: the 200-day average is not used.");
  if (has50) {
    const above50 = price > sma50[n - 1];
    f.push(factor("Trend", "Price vs 50-day average", above50 ? 7 : 0, 7, above50 ? "Above the 50-day average: the medium-term trend is up." : "Below the 50-day average: the medium-term trend is weak."));
    if (has200) {
      const golden = sma50[n - 1] > sma200[n - 1];
      f.push(factor("Trend", "50-day above 200-day", golden ? 6 : 0, 6, golden ? "The 50-day average is above the 200-day average (bullish alignment)." : "The 50-day average is below the 200-day average (bearish alignment)."));
    }
  }
  const short = sma20[n - 1] != null && sma50[n - 1] != null && sma20[n - 1] > sma50[n - 1];
  if (has50) f.push(factor("Trend", "20-day above 50-day", short ? 3 : 0, 3, short ? "Short-term average is above the medium-term one." : "Short-term average is below the medium-term one."));

  // ---- momentum (25) ----
  let rsiPoints = 2;
  let rsiNote = `RSI ${round(rsiNow, 0)}: oversold territory, a bounce is possible but the trend is not helping.`;
  if (rsiNow >= 50 && rsiNow <= 68) { rsiPoints = 10; rsiNote = `RSI ${round(rsiNow, 0)}: healthy momentum without being stretched.`; }
  else if (rsiNow >= 40 && rsiNow < 50) { rsiPoints = 5; rsiNote = `RSI ${round(rsiNow, 0)}: a pause or pullback.`; }
  else if (rsiNow > 68 && rsiNow <= 75) { rsiPoints = 4; rsiNote = `RSI ${round(rsiNow, 0)}: strong but getting hot.`; }
  else if (rsiNow > 75) { rsiPoints = 0; rsiNote = `RSI ${round(rsiNow, 0)}: overbought, prone to a pullback.`; }
  f.push(factor("Momentum", "RSI (14)", rsiPoints, 10, rsiNote));
  const histNow = last(hist);
  if (histNow != null) {
    const positive = histNow > 0;
    f.push(factor("Momentum", "MACD", positive ? 5 : 0, 5, positive ? "MACD is above its signal line." : "MACD is below its signal line."));
    const rising = hist[n - 1] > hist[n - 4];
    f.push(factor("Momentum", "MACD direction", rising ? 3 : 0, 3, rising ? "MACD momentum has improved over the last 3 days." : "MACD momentum has faded over the last 3 days."));
  }
  if (ret3m != null) f.push(factor("Momentum", "Last 3 months", ret3m > 0 ? 4 : 0, 4, `${ret3m >= 0 ? "+" : ""}${round(ret3m, 1)}% over 3 months.`));
  if (ret6m != null) f.push(factor("Momentum", "Last 6 months", ret6m > 0 ? 3 : 0, 3, `${ret6m >= 0 ? "+" : ""}${round(ret6m, 1)}% over 6 months.`));

  // ---- relative strength (10) ----
  if (benchmark3m != null && ret3m != null) {
    const diff = ret3m - benchmark3m;
    const points = diff > 5 ? 10 : diff >= 0 ? 6 : diff >= -5 ? 3 : 0;
    f.push(factor("Relative strength", "3 months vs the market", points, 10, `${diff >= 0 ? "Ahead of" : "Behind"} the S&P 500 ETF by ${round(Math.abs(diff), 1)} points over 3 months (${round(ret3m, 1)}% vs ${round(benchmark3m, 1)}%).`));
  }

  // ---- position (15) ----
  {
    const off = -fromHigh;
    const points = off <= 10 ? 8 : off <= 25 ? 6 : off <= 40 ? 3 : 0;
    f.push(factor("Position", "Distance from 52-week high", points, 8, off < 0.5 ? "At its 52-week high." : `${round(off, 1)}% below its 52-week high.`));
  }
  if (aboveSma50 != null) {
    const stretch = aboveSma50;
    const points = stretch <= 8 ? 7 : stretch <= 15 ? 4 : stretch <= 25 ? 1 : 0;
    f.push(factor("Position", "Stretch above 50-day average", points, 7, stretch > 15 ? `${round(stretch, 1)}% above its 50-day average: stretched, a pullback is common after moves like this.` : stretch > 8 ? `${round(stretch, 1)}% above its 50-day average: somewhat extended.` : stretch >= 0 ? `${round(stretch, 1)}% above its 50-day average: close to it, not stretched.` : `${round(-stretch, 1)}% below its 50-day average.`));
  }

  // ---- risk (15) ----
  if (volatility != null) {
    const points = volatility < 25 ? 8 : volatility < 40 ? 6 : volatility < 60 ? 3 : 0;
    f.push(factor("Risk", "Volatility", points, 8, `Annualised volatility ${round(volatility, 0)}%${volatility >= 60 ? ": very volatile, size positions small." : volatility < 25 ? ": calm." : "."}`));
  }
  {
    const points = drawdown < 15 ? 7 : drawdown < 25 ? 5 : drawdown < 40 ? 2 : 0;
    f.push(factor("Risk", "Worst fall in the last year", points, 7, `Fell as much as ${round(drawdown, 0)}% from a peak within the year.`));
  }

  // ---- structure (5) ----
  try {
    const trend = analyzeStructure(candles.slice(-180)).trend;
    const up = /up/.test(trend);
    const down = /down/.test(trend);
    f.push(factor("Structure", "Highs and lows", up ? 5 : down ? 0 : 2, 5, up ? "Swing highs and lows are rising." : down ? "Swing highs and lows are falling." : "No clear pattern of higher highs or lower lows."));
  } catch { /* structure is optional */ }

  const total = f.reduce((s, x) => s + x.points, 0);
  const max = f.reduce((s, x) => s + x.max, 0);
  const score = Math.round((total / max) * 100);

  // ---- flags ----
  const downtrend = (has200 && price < sma200[n - 1] && has50 && sma50[n - 1] < sma200[n - 1]) || (!has200 && has50 && price < sma50[n - 1] && ret3m != null && ret3m < 0);
  const stretched = (rsiNow != null && rsiNow > 72) || (aboveSma50 != null && aboveSma50 > 15);
  const warnings = [];
  if (!has200) warnings.push(`Only ${n} days of history: long-term trend measures are missing.`);
  if (!benchmarkCloses) warnings.push("No market benchmark was available, so relative strength is not included.");
  if (dollarVolume < 1_000_000) warnings.push(`Thin trading (about ${Math.round(dollarVolume / 1000).toLocaleString()}K USD a day): spreads can be wide and prices jumpy.`);
  const bigMove = candles.slice(-5).some((c, i, a) => i > 0 && Math.abs(pct(c.close, a[i - 1].close)) > 8);
  if (bigMove) warnings.push("A single-day move above 8% in the last 5 days: check the news (earnings?) before trading.");
  if (price < 5) warnings.push("Low-priced stock: these move erratically.");
  if (volatility != null && volatility >= 60) warnings.push("Very volatile: expect large swings against you as well as for you.");

  // ---- verdict ----
  let verdict;
  if (downtrend) {
    verdict = { label: "Downtrend: avoid for now", tone: "bad", summary: "Price is below its long-term average and the averages point down. Buying a falling stock is a bet on a turn, not on the trend. Wait for it to reclaim the 50-day average." };
  } else if (score >= 70 && stretched) {
    verdict = { label: "Strong, but stretched: wait for a pullback", tone: "caution", summary: "The trend and momentum are good, but price has run far above its average or is overbought. Entries after moves like this often get a pullback first." };
  } else if (score >= 70) {
    verdict = { label: "Favourable setup", tone: "good", summary: "Trend and momentum are supportive and price is not stretched: the kind of chart trend-followers look for. That says nothing about the company itself, so use a stop and check the news." };
  } else if (score >= 50) {
    verdict = { label: "Mixed: no clear edge", tone: "mixed", summary: "Some measures are supportive and some are not. There is no strong technical reason to buy now; watching for a better setup is reasonable." };
  } else {
    verdict = { label: "Unfavourable", tone: "bad", summary: "Most measures are weak. Technically this is not a good time to buy." };
  }

  // ---- levels and a plan ----
  const low20 = Math.min(...candles.slice(-20).map((c) => c.low));
  let stop = Math.max(price - 3 * atrNow, low20 - 0.25 * atrNow);
  if (stop > price - atrNow) stop = price - 1.5 * atrNow; // never tighter than normal daily noise
  const risk = price - stop;
  const target2R = price + 2 * risk;
  const plan = {
    entry: price,
    stop,
    stopPct: round(pct(stop, price), 1),
    target: target2R,
    targetPct: round(pct(target2R, price), 1),
    riskReward: 2,
    resistance: high52 > price * 1.01 ? high52 : null,
    note: "The stop sits below the 20-day low and at least 1.5 daily ranges away. Binance Stocks has no stop orders: you would have to watch the price and sell yourself.",
  };

  if (Math.abs(plan.stopPct) > 10) warnings.push(`The suggested stop is ${Math.abs(plan.stopPct)}% away because this stock swings a lot: keep the position small so a stop-out costs an amount you can accept.`);

  return {
    ok: true,
    score,
    verdict,
    factors: f,
    warnings,
    plan,
    levels: { sma20: round(last(sma20), 2), sma50: round(last(sma50), 2), sma200: round(last(sma200), 2), high52: round(high52, 2), low52: round(low52, 2) },
    stats: {
      price,
      rsi: round(rsiNow, 0),
      atrPct: round((atrNow / price) * 100, 2),
      volatility: round(volatility, 0),
      drawdown: round(drawdown, 0),
      fromHigh: round(fromHigh, 1),
      ret1m: round(ret1m, 1), ret3m: round(ret3m, 1), ret6m: round(ret6m, 1), ret1y: round(ret1y, 1),
      benchmark3m: round(benchmark3m, 1),
      dollarVolume: Math.round(dollarVolume),
    },
    bars: n,
    downtrend,
    stretched,
  };
}
