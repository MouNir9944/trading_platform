import assert from "node:assert/strict";
import test from "node:test";

import { dailyPnl, monthlyPnl, performanceReport, summarizePnl } from "../shared/analysis/performance.js";

const at = (iso) => Date.parse(iso);
const t = (iso, pnl) => ({ time: at(iso), pnl });

test("dailyPnl: trades are pooled by calendar day, oldest first, and win/loss are counted", () => {
  const rows = dailyPnl([
    t("2026-03-01T09:00:00Z", 10),
    t("2026-03-01T14:00:00Z", -4),
    t("2026-03-03T09:00:00Z", 6),
  ]);
  assert.deepEqual(rows.map((r) => r.date), ["2026-03-01", "2026-03-03"]);
  assert.equal(rows[0].pnl, 6);
  assert.equal(rows[0].trades, 2);
  assert.equal(rows[0].wins, 1);
  assert.equal(rows[0].losses, 1);
  assert.equal(rows[1].pnl, 6);
});

test("dailyPnl: a day boundary follows the given time zone, not UTC", () => {
  // 23:30 in Tokyo (UTC+9) on March 1st is 14:30 UTC on March 1st, so both should still land on the same LOCAL day
  const utc = dailyPnl([t("2026-03-01T23:30:00Z", 1)], { timeZone: "UTC" });
  const tokyo = dailyPnl([t("2026-03-01T23:30:00Z", 1)], { timeZone: "Asia/Tokyo" });
  assert.equal(utc[0].date, "2026-03-01");
  assert.equal(tokyo[0].date, "2026-03-02", "23:30 UTC is already the 2nd in Tokyo");
});

test("dailyPnl and monthlyPnl ignore trades with a missing time or pnl", () => {
  assert.deepEqual(dailyPnl([{ time: null, pnl: 5 }, { time: at("2026-01-01T00:00:00Z"), pnl: NaN }]), []);
  assert.deepEqual(monthlyPnl([]), []);
});

test("monthlyPnl: trades are pooled by calendar month, oldest first", () => {
  const rows = monthlyPnl([
    t("2026-01-15T00:00:00Z", 100),
    t("2026-01-20T00:00:00Z", -30),
    t("2025-12-31T23:00:00Z", 5),
  ]);
  assert.deepEqual(rows.map((r) => r.key), ["2025-12", "2026-01"]);
  assert.equal(rows[1].label, "Jan 2026");
  assert.equal(rows[1].pnl, 70);
});

test("summarizePnl: totals, win rate, best/worst day and from/to span", () => {
  const s = summarizePnl([
    t("2026-01-01T00:00:00Z", 10),
    t("2026-01-01T01:00:00Z", 5),
    t("2026-01-02T00:00:00Z", -20),
    t("2026-01-03T00:00:00Z", 2),
  ]);
  assert.equal(s.trades, 4);
  assert.equal(s.wins, 3);
  assert.equal(s.losses, 1);
  assert.equal(s.winRate, 75);
  assert.equal(s.total, -3);
  assert.equal(s.tradingDays, 3);
  assert.equal(s.bestDay.date, "2026-01-01");
  assert.equal(s.bestDay.pnl, 15);
  assert.equal(s.worstDay.date, "2026-01-02");
  assert.equal(s.worstDay.pnl, -20);
  assert.equal(s.from, at("2026-01-01T00:00:00Z"));
  assert.equal(s.to, at("2026-01-03T00:00:00Z"));
  assert.deepEqual(summarizePnl([]), {
    trades: 0, wins: 0, losses: 0, winRate: null, total: 0, avgPerTrade: null, tradingDays: 0, avgPerDay: null,
    bestDay: null, worstDay: null, bestWinStreakDays: 0, bestLossStreakDays: 0, currentStreakDays: 0, from: null, to: null,
  });
});

test("summarizePnl: winning and losing streaks are counted in days, and the current streak has a sign", () => {
  const days = (pnls) => pnls.map((pnl, i) => t(`2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`, pnl));
  const win = summarizePnl(days([5, 3, -1, 4, 6, 2])); // W W L W W W -> best win streak 3, ends on a win
  assert.equal(win.bestWinStreakDays, 3);
  assert.equal(win.bestLossStreakDays, 1);
  assert.equal(win.currentStreakDays, 3);
  const lose = summarizePnl(days([5, -1, -2, -3])); // W L L L -> currently on a 3-day losing streak
  assert.equal(lose.bestLossStreakDays, 3);
  assert.equal(lose.currentStreakDays, -3);
});

test("performanceReport bundles daily, monthly and the summary from one call", () => {
  const r = performanceReport([t("2026-02-01T00:00:00Z", 10), t("2026-02-02T00:00:00Z", -4)]);
  assert.equal(r.daily.length, 2);
  assert.equal(r.monthly.length, 1);
  assert.equal(r.summary.total, 6);
});
