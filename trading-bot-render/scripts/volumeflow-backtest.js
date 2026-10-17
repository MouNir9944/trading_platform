/**
 * Backtest "Volume profile + order flow" on real Binance history (public data, no keys), with the platform's own
 * backtest engine (orders placed after the signal candle closes, fees both ways, stop wins if both are in one candle).
 *
 *   node scripts/volumeflow-backtest.js
 *   node scripts/volumeflow-backtest.js --interval 1h --candles 5000 --market spot --entry retest
 *
 * Options: --symbols A,B  --interval 15m  --candles 5000  --market futures|spot  --fee 0.05  --entry limit-close|retest
 */
import { fetchHistory } from "../server/candles.js";
import { toCandles } from "../shared/analysis/index.js";
import { STRATEGY_BY_ID } from "../shared/strategies/index.js";
import { backtestStrategy, summarizeTrades } from "../shared/strategies/trade.js";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const market = args.market === "spot" ? "spot" : "futures";
const interval = args.interval ?? "15m";
const total = Number(args.candles ?? 5000);
const fee = Number(args.fee ?? (market === "spot" ? 0.1 : 0.05));
const entryMode = args.entry === "retest" ? "retest" : "limit-close";
const symbols = (args.symbols ?? "BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,ADAUSDT,DOGEUSDT,LINKUSDT,AVAXUSDT,LTCUSDT,TRXUSDT,DOTUSDT").split(",").map((s) => s.trim().toUpperCase());
const strategy = STRATEGY_BY_ID.volume_flow;

const BASE = market === "spot" ? "https://api.binance.com/api/v3/klines" : "https://fapi.binance.com/fapi/v1/klines";
async function getKlines(symbol, tf, limit, endTime) {
  const res = await fetch(`${BASE}?symbol=${symbol}&interval=${tf}&limit=${limit}${endTime ? `&endTime=${endTime}` : ""}`);
  if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
  return res.json();
}

const pad = (v, n) => String(v).padStart(n);
const num = (v, d = 2) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(d));
const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const HEADER = `${"".padEnd(36)} ${pad("signals", 7)} ${pad("trades", 6)} ${pad("win %", 6)} ${pad("exp (R)", 8)} ${pad("total R", 8)} ${pad("PF", 5)} ${pad("DD (R)", 7)} ${pad("1st half", 8)} ${pad("2nd half", 8)}`;
const row = (label, r) => {
  const s = r.combined;
  return `${label.padEnd(36)} ${pad(r.counts.signals, 7)} ${pad(s.trades, 6)} ${pad(num(s.winRate, 1), 6)} ${pad(num(s.expectancyR, 3), 8)} ${pad(num(s.totalR, 1), 8)} ${pad(num(s.profitFactor, 2), 5)} ${pad(num(s.maxDrawdownR, 1), 7)} ${pad(num(s.halves?.first, 3), 8)} ${pad(num(s.halves?.second, 3), 8)}`;
};

console.log(`\nVolume profile + order flow: ${market} ${interval}, up to ${total} candles per pair, fee ${fee}%/side, entry ${entryMode}`);
const now = Date.now();
const real = [];
for (const symbol of symbols) {
  try {
    const candles = toCandles(await fetchHistory(getKlines, symbol, interval, total)).filter((c) => c.closeTime == null || c.closeTime <= now);
    real.push({ symbol, candles });
    const measured = candles.filter((c) => c.takerBuyVolume != null).length;
    console.log(`  loaded ${symbol.padEnd(9)} ${pad(candles.length, 5)} candles ${day(candles[0].time)} -> ${day(candles.at(-1).time)}  (taker volume on ${Math.round((100 * measured) / candles.length)}%)`);
  } catch (err) {
    console.log(`  FAILED ${symbol}: ${err.message}`);
  }
}
// the same candles with the taker volume removed: order flow then has to be guessed from the candle shape
const shapeOnly = real.map(({ symbol, candles }) => ({ symbol, candles: candles.map((c) => ({ ...c, takerBuyVolume: null })) }));

const trade = { feePercent: fee, entryMode };
const run = (data, params = {}, extra = {}) => backtestStrategy(data, { strategy, params, trade: { ...trade, ...extra } });
const base = run(real);

console.log(`\n=== Default settings, real order flow ===\n${HEADER}`);
for (const p of base.perSymbol) console.log(p.error ? `${p.symbol.padEnd(36)} ${p.error}` : `${p.symbol.padEnd(36)} ${pad(p.signals, 7)} ${pad(p.stats.trades, 6)} ${pad(num(p.stats.winRate, 1), 6)} ${pad(num(p.stats.expectancyR, 3), 8)} ${pad(num(p.stats.totalR, 1), 8)} ${pad(num(p.stats.profitFactor, 2), 5)}`);
console.log(row("ALL PAIRS", base));
const longs = base.trades.filter((t) => t.side === "long");
const shorts = base.trades.filter((t) => t.side === "short");
const line = (label, list) => { const s = summarizeTrades(list); console.log(`  ${label}: ${s.trades} trades, ${num(s.winRate, 1)}% win, ${num(s.expectancyR, 3)}R each`); };
line("longs ", longs);
line("shorts", shorts);
console.log(`  planned reward:risk averages ${num(base.counts.avgPlannedRewardRisk, 2)}; orders that never filled: ${base.counts.missed.expired + base.counts.missed.targetFirst}`);
const positive = base.perSymbol.filter((p) => !p.error && p.stats.totalR > 0).length;
console.log(`  pairs with a positive total: ${positive} of ${base.perSymbol.filter((p) => !p.error).length}`);

const variants = [
  ["baseline (real order flow)", real, {}, {}],
  ["control: delta ESTIMATED from candle shape", shapeOnly, {}, {}],
  ["control: weak flow (0% min, 1 candle, 0.5x vol)", real, { minDelta: 0, cvdBars: 1, volumeFactor: 0.5 }, {}],
  ["stronger flow (40% min)", real, { minDelta: 40 }, {}],
  ["strong flow and volume (40%, 1.5x)", real, { minDelta: 40, volumeFactor: 1.5 }, {}],
  ["reversals only (no breakouts)", real, { breakouts: 0 }, {}],
  ["target the far edge of value", real, { targetAt: 1 }, {}],
  ["wider stop (1 ATR beyond)", real, { stopAtr: 1 }, {}],
  ["wider stop (2 ATR beyond)", real, { stopAtr: 2 }, {}],
  ["longer profile (200 candles)", real, { lookback: 200 }, {}],
  ["shorter profile (50 candles)", real, { lookback: 50 }, {}],
  ["enter on a retest of the edge", real, {}, { entryMode: "retest" }],
  ["fixed 2R target", real, {}, { targetMode: "r", targetR: 2 }],
  ["no fees", real, {}, { feePercent: 0 }],
];
console.log(`\n=== Variants (all pairs together) ===\n${HEADER}`);
for (const [label, data, params, extra] of variants) console.log(row(label, run(data, params, extra)));

const ordered = [...base.trades].sort((a, b) => a.entryTime - b.entryTime);
if (ordered.length >= 40) {
  const q = Math.floor(ordered.length / 4);
  console.log("\n=== Stability: the trades in four time slices ===");
  for (let k = 0; k < 4; k++) {
    const slice = ordered.slice(k * q, k === 3 ? undefined : (k + 1) * q);
    const s = summarizeTrades(slice);
    console.log(`  slice ${k + 1} (from ${day(slice[0].entryTime)}): ${s.trades} trades, ${num(s.winRate, 1)}% win, ${num(s.expectancyR, 3)}R each`);
  }
  let seed = 4242;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const rs = ordered.map((t) => t.r);
  const means = [];
  for (let b = 0; b < 2000; b++) { let sum = 0; for (let k = 0; k < rs.length; k++) sum += rs[Math.floor(rand() * rs.length)]; means.push(sum / rs.length); }
  means.sort((a, b) => a - b);
  console.log(`  expectancy ${num(rs.reduce((a, b) => a + b, 0) / rs.length, 3)}R; 95% range from resampling the trades: ${num(means[Math.floor(0.025 * means.length)], 3)}R to ${num(means[Math.floor(0.975 * means.length)], 3)}R`);
}
console.log("");
