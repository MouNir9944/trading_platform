/**
 * Turns a list of closed trades into daily and monthly totals and an overall summary, for the Performance tab. Both
 * the crypto trading account (closed spot/futures orders) and the Binance Stocks account (executed sells) reduce to
 * the same shape, so this one module drives both.
 *
 * A trade is `{ time: <ms epoch>, pnl: <number>, symbol?: string, market?: string }`. Everything here is pure.
 */
import { zonedParts } from "./sessions.js";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const clean = (trades) => trades.filter((t) => Number.isFinite(t.time) && Number.isFinite(t.pnl));
const dayKeyOf = (t, timeZone) => zonedParts(Math.floor(t.time / 1000), timeZone);

/** One row per calendar day that had at least one closed trade, oldest first. */
export function dailyPnl(trades, { timeZone = "UTC" } = {}) {
  const byDay = new Map();
  for (const t of clean(trades)) {
    const p = dayKeyOf(t, timeZone);
    const row = byDay.get(p.key) ?? { key: p.key, date: `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`, pnl: 0, trades: 0, wins: 0, losses: 0 };
    row.pnl += t.pnl;
    row.trades += 1;
    if (t.pnl > 0) row.wins += 1; else if (t.pnl < 0) row.losses += 1;
    byDay.set(p.key, row);
  }
  return [...byDay.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** One row per calendar month that had at least one closed trade, oldest first. */
export function monthlyPnl(trades, { timeZone = "UTC" } = {}) {
  const byMonth = new Map();
  for (const t of clean(trades)) {
    const p = dayKeyOf(t, timeZone);
    const key = `${p.year}-${String(p.month).padStart(2, "0")}`;
    const row = byMonth.get(key) ?? { key, label: `${MONTH_NAMES[p.month - 1]} ${p.year}`, pnl: 0, trades: 0, wins: 0, losses: 0 };
    row.pnl += t.pnl;
    row.trades += 1;
    if (t.pnl > 0) row.wins += 1; else if (t.pnl < 0) row.losses += 1;
    byMonth.set(key, row);
  }
  return [...byMonth.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** The longest run of consecutive winning/losing DAYS, and the streak the account is currently on. */
function streaks(days) {
  let run = 0;
  let dir = 0;
  let bestWin = 0;
  let bestLoss = 0;
  for (const d of days) {
    const sign = d.pnl > 0 ? 1 : d.pnl < 0 ? -1 : 0;
    run = sign !== 0 && sign === dir ? run + 1 : sign === 0 ? 0 : 1;
    dir = sign;
    if (dir === 1) bestWin = Math.max(bestWin, run);
    if (dir === -1) bestLoss = Math.max(bestLoss, run);
  }
  return { bestWinStreakDays: bestWin, bestLossStreakDays: bestLoss, currentStreakDays: dir >= 0 ? run : -run };
}

/** Overall read of the trades: total, win rate, best/worst day, and streaks — the summary cards of the Performance tab. */
export function summarizePnl(trades, { timeZone = "UTC" } = {}) {
  const rows = clean(trades).sort((a, b) => a.time - b.time);
  const days = dailyPnl(rows, { timeZone });
  const wins = rows.filter((t) => t.pnl > 0).length;
  const losses = rows.filter((t) => t.pnl < 0).length;
  const total = rows.reduce((s, t) => s + t.pnl, 0);
  const bestDay = days.length ? days.reduce((a, b) => (b.pnl > a.pnl ? b : a)) : null;
  const worstDay = days.length ? days.reduce((a, b) => (b.pnl < a.pnl ? b : a)) : null;
  return {
    trades: rows.length,
    wins,
    losses,
    winRate: rows.length ? (wins / rows.length) * 100 : null,
    total,
    avgPerTrade: rows.length ? total / rows.length : null,
    tradingDays: days.length,
    avgPerDay: days.length ? total / days.length : null,
    bestDay: bestDay ? { date: bestDay.date, pnl: bestDay.pnl } : null,
    worstDay: worstDay ? { date: worstDay.date, pnl: worstDay.pnl } : null,
    ...streaks(days),
    from: rows[0]?.time ?? null,
    to: rows[rows.length - 1]?.time ?? null,
  };
}

/** The daily/monthly rows and the summary, in one call. */
export function performanceReport(trades, { timeZone = "UTC" } = {}) {
  return { daily: dailyPnl(trades, { timeZone }), monthly: monthlyPnl(trades, { timeZone }), summary: summarizePnl(trades, { timeZone }) };
}
