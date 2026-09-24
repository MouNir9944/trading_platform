/**
 * Backtest the manipulation reversal on real Binance history (public data, no keys needed).
 *
 *   node scripts/manipulation-backtest.js
 *   node scripts/manipulation-backtest.js --interval 1h --candles 8000 --symbols BTCUSDT,ETHUSDT --market spot
 *
 * Options: --symbols A,B,C  --interval 4h  --candles 5000  --market futures|spot  --fee 0.05  --rr 2
 */
import { fetchHistory } from "../server/candles.js";
import { backtestManipulationMany, breakEvenWinRate, findManipulations, summarizeTrades, toCandles } from "../shared/analysis/index.js";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const market = args.market === "spot" ? "spot" : "futures";
const interval = args.interval ?? "4h";
const total = Number(args.candles ?? 5000);
const fee = Number(args.fee ?? (market === "spot" ? 0.1 : 0.05));
const rewardRisk = Number(args.rr ?? 2);
const symbols = (args.symbols ?? "BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,ADAUSDT,DOGEUSDT,LINKUSDT,AVAXUSDT,LTCUSDT,TRXUSDT,DOTUSDT").split(",").map((s) => s.trim().toUpperCase());

const BASE = market === "spot" ? "https://api.binance.com/api/v3/klines" : "https://fapi.binance.com/fapi/v1/klines";
async function getKlines(symbol, tf, limit, endTime) {
  const url = `${BASE}?symbol=${symbol}&interval=${tf}&limit=${limit}${endTime ? `&endTime=${endTime}` : ""}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
  return res.json();
}

const pad = (v, n) => String(v).padStart(n);
const num = (v, d = 2) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(d));
const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);

function row(label, s) {
  return `${label.padEnd(34)} ${pad(s.trades, 6)} ${pad(num(s.winRate, 1), 7)} ${pad(num(s.expectancyR, 3), 8)} ${pad(num(s.totalR, 1), 8)} ${pad(num(s.profitFactor, 2), 6)} ${pad(num(s.maxDrawdownR, 1), 7)} ${pad(num(s.maxDrawdownPct, 1), 7)} ${pad(num(s.totalReturnPct, 0), 9)}`;
}
const HEADER = `${"".padEnd(34)} ${pad("trades", 6)} ${pad("win %", 7)} ${pad("exp (R)", 8)} ${pad("total R", 8)} ${pad("PF", 6)} ${pad("DD (R)", 7)} ${pad("DD %", 7)} ${pad("return %", 9)}`;

console.log(`\nManipulation reversal backtest: ${market} ${interval}, up to ${total} candles per pair, fee ${fee}%/side, ${rewardRisk}R target`);
console.log(`Break-even win rate at ${rewardRisk}R before fees: ${num(breakEvenWinRate(rewardRisk), 1)}%\n`);

const now = Date.now();
const datasets = [];
for (const symbol of symbols) {
  try {
    const candles = toCandles(await fetchHistory(getKlines, symbol, interval, total)).filter((c) => c.closeTime == null || c.closeTime <= now);
    datasets.push({ symbol, candles });
    console.log(`  loaded ${symbol.padEnd(10)} ${pad(candles.length, 5)} candles  ${day(candles[0].time)} -> ${day(candles[candles.length - 1].time)}`);
  } catch (err) {
    datasets.push({ symbol, candles: [], error: err.message });
    console.log(`  FAILED ${symbol}: ${err.message}`);
  }
}

const base = { feePercent: fee, rewardRisk, riskPerTradePct: 1 };
const run = (options) => backtestManipulationMany(datasets, { ...base, ...options });

// ---- the strategy as described ----
const baseline = run({});
console.log(`\n=== As described: sweep + engulf the previous body, stop beyond the wick, ${rewardRisk}R target ===\n${HEADER}`);
for (const p of baseline.perSymbol) console.log(p.error ? `${p.symbol.padEnd(34)} ${p.error}` : row(p.symbol, p.stats));
console.log(row("ALL PAIRS", baseline.stats));
console.log(`  longs:  ${baseline.stats.long.trades} trades, ${num(baseline.stats.long.winRate, 1)}% win, ${num(baseline.stats.long.expectancyR, 3)}R each`);
console.log(`  shorts: ${baseline.stats.short.trades} trades, ${num(baseline.stats.short.winRate, 1)}% win, ${num(baseline.stats.short.expectancyR, 3)}R each`);
console.log(`  longest losing streak: ${baseline.stats.maxLosingStreak}, average trade lasts ${num(baseline.stats.avgBars, 1)} candles`);
const buyHold = datasets.filter((d) => d.candles.length).map((d) => (d.candles[d.candles.length - 1].close / d.candles[0].close - 1) * 100);
console.log(`  for reference, buy-and-hold over the same data: ${num(buyHold.reduce((a, b) => a + b, 0) / buyHold.length, 0)}% on average per pair (not risk-matched)`);

// ---- does each ingredient matter? ----
const variants = [
  ["baseline", {}],
  ["control: engulf, NO sweep needed", { requireSweep: false }],
  ["engulf whole range (stricter)", { engulf: "range" }],
  ["only trade with the 50 EMA trend", { trend: "ema" }],
  ["sweep at least 0.25 ATR", { minSweepAtr: 0.25 }],
  ["sweep at least 0.5 ATR", { minSweepAtr: 0.5 }],
  ["skip stops wider than 3 ATR", { maxRiskAtr: 3 }],
  ["longs only", { shorts: false }],
  ["shorts only", { longs: false }],
  ["1.5R target", { rewardRisk: 1.5 }],
  ["1R target", { rewardRisk: 1 }],
  ["3R target", { rewardRisk: 3 }],
];
console.log(`\n=== Variants (all pairs together) ===\n${HEADER}`);
for (const [label, options] of variants) console.log(row(label, run(options).stats));

// ---- stable across time and across pairs? ----
const times = baseline.trades.map((t) => t.exitTime);
const mid = times.length ? times[Math.floor(times.length / 2)] : 0;
console.log(`\n=== Stability of the baseline (split at ${mid ? day(mid) : "—"}) ===\n${HEADER}`);
console.log(row("first half", summarizeTrades(baseline.trades.filter((t) => t.exitTime < mid), base)));
console.log(row("second half", summarizeTrades(baseline.trades.filter((t) => t.exitTime >= mid), base)));
const quarters = 4;
const sorted = [...baseline.trades];
for (let q = 0; q < quarters; q++) {
  const slice = sorted.slice(Math.floor((q * sorted.length) / quarters), Math.floor(((q + 1) * sorted.length) / quarters));
  if (slice.length) console.log(row(`quarter ${q + 1} of the trades (${day(slice[0].exitTime)} ->)`, summarizeTrades(slice, base)));
}
const profitable = baseline.perSymbol.filter((p) => !p.error && p.stats.totalR > 0).length;
console.log(`\n  pairs with a positive total: ${profitable} of ${baseline.perSymbol.filter((p) => !p.error).length}`);

// ---- how lucky is the result? Bootstrap the trades. ----
const rs = baseline.trades.map((t) => t.netR);
if (rs.length >= 30) {
  let seed = 12345;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const means = [];
  for (let b = 0; b < 2000; b++) {
    let s = 0;
    for (let k = 0; k < rs.length; k++) s += rs[Math.floor(rand() * rs.length)];
    means.push(s / rs.length);
  }
  means.sort((a, b) => a - b);
  console.log(`  expectancy ${num(rs.reduce((a, b) => a + b, 0) / rs.length, 3)}R per trade, 95% range from resampling the trades: ${num(means[Math.floor(0.025 * means.length)], 3)}R to ${num(means[Math.floor(0.975 * means.length)], 3)}R`);
}

// ---- the claim: "the manipulation low is likely the low of the day" ----
// For each setup, is its extreme also the extreme of that UTC day (using the whole day, so this is a check of the claim,
// not something you could trade)? Compared with how often ANY candle at the same slot of the day does that.
if (interval === "4h") {
  const slotOf = (c) => Math.floor((c.time % 86400) / 14400);
  const dayOf = (c) => Math.floor(c.time / 86400);
  const claim = { bull: { n: 0, hits: 0, expected: 0 }, bear: { n: 0, hits: 0, expected: 0 } };
  for (const { candles } of datasets) {
    if (!candles.length) continue;
    const dayLow = new Map();
    const dayHigh = new Map();
    for (const c of candles) {
      const d = dayOf(c);
      dayLow.set(d, Math.min(dayLow.get(d) ?? Infinity, c.low));
      dayHigh.set(d, Math.max(dayHigh.get(d) ?? -Infinity, c.high));
    }
    const slotStats = Array.from({ length: 6 }, () => ({ n: 0, low: 0, high: 0 }));
    for (const c of candles) {
      const s = slotStats[slotOf(c)];
      s.n += 1;
      if (c.low <= dayLow.get(dayOf(c))) s.low += 1;
      if (c.high >= dayHigh.get(dayOf(c))) s.high += 1;
    }
    for (const setup of findManipulations(candles, {})) {
      const c = candles[setup.index];
      const bull = setup.dir === "bull";
      const bucket = claim[setup.dir];
      const s = slotStats[slotOf(c)];
      bucket.n += 1;
      bucket.hits += (bull ? c.low <= dayLow.get(dayOf(c)) : c.high >= dayHigh.get(dayOf(c))) ? 1 : 0;
      bucket.expected += (bull ? s.low : s.high) / s.n;
    }
  }
  console.log("\n=== Claim check: is the manipulation's low (high) the low (high) of that UTC day? ===");
  for (const [k, label] of [["bull", "bullish, low of the day "], ["bear", "bearish, high of the day"]]) {
    const b = claim[k];
    console.log(`  ${label}: ${num((100 * b.hits) / b.n, 1)}% of ${b.n} setups; ${num((100 * b.expected) / b.n, 1)}% expected for ANY candle in the same slot of the day`);
  }
}

// ---- how much do fees cost? ----
console.log(`\n=== Fees ===\n${HEADER}`);
console.log(row("baseline with no fees", run({ feePercent: 0 }).stats));
console.log(row(`baseline with ${fee}% per side`, baseline.stats));
console.log("");
