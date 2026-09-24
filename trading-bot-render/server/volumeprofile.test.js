import assert from "node:assert/strict";
import test from "node:test";

import { MAX_STEP_SECONDS, dailyProfiles, dailySummary, valueAreaPosition, volumeProfile } from "../shared/analysis/index.js";

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);
const bar = (time, low, high, volume) => ({ time, open: low, high, low, close: high, volume, closeTime: null });

test("volume profile: the POC is the busiest price and total volume is conserved", () => {
  // 10 rows over 100..110. Most of the volume trades in 104-105.
  const candles = [bar(0, 100, 110, 100), bar(1, 104, 105, 900)];
  const p = volumeProfile(candles, { rows: 10 });
  near(p.total, 1000);
  near(p.rows.reduce((s, r) => s + r.volume, 0), 1000, 1e-6);
  assert.equal(p.pocIndex, 4);
  near(p.poc, 104.5);
});

test("volume profile: value area holds at least 70% and grows around the POC", () => {
  const candles = [bar(0, 100, 110, 100), bar(1, 104, 105, 900)];
  const p = volumeProfile(candles, { rows: 10 });
  assert.ok(p.valueAreaPct >= 0.7, `value area only ${p.valueAreaPct}`);
  assert.ok(p.val <= p.poc && p.poc <= p.vah);
  assert.ok(p.val >= 100 && p.vah <= 110);
  // The POC row sits inside the value area.
  assert.ok(p.vaLow <= p.pocIndex && p.pocIndex <= p.vaHigh);
});

test("volume profile: a candle's volume is spread over the rows its range touched", () => {
  const p = volumeProfile([bar(0, 100, 110, 1000)], { rows: 10 });
  for (const row of p.rows) near(row.volume, 100, 1e-6);
});

test("volume profile: one price, no candles and zero volume are handled", () => {
  assert.equal(volumeProfile([], {}), null);
  const flat = volumeProfile([bar(0, 5, 5, 40), bar(1, 5, 5, 60)]);
  assert.equal(flat.rows.length, 1);
  near(flat.poc, 5);
  near(flat.total, 100);
  const quiet = volumeProfile([bar(0, 1, 2, 0)], { rows: 4 });
  assert.equal(quiet.total, 0);
  assert.ok(Number.isFinite(quiet.poc));
});

test("volume profile: a value area that must reach the edge of the range still terminates", () => {
  const p = volumeProfile([bar(0, 1, 2, 10), bar(1, 1, 1.1, 10)], { rows: 5, valueAreaPct: 1 });
  near(p.val, 1);
  near(p.vah, 2);
});

// ---- daily profiles ----
const DAY = 86400;
const day0 = Date.UTC(2026, 0, 5) / 1000; // a Monday, midnight UTC
const hourly = (dayIndex, hours, price, volume = 10) =>
  Array.from({ length: hours }, (_, h) => bar(day0 + dayIndex * DAY + h * 3600, price - 1, price + 1, volume));

test("daily profiles: one profile per calendar day, the newest is developing", () => {
  const candles = [...hourly(0, 24, 100), ...hourly(1, 24, 110), ...hourly(2, 5, 120)];
  const r = dailyProfiles(candles, "UTC");
  assert.equal(r.supported, true);
  assert.equal(r.days.length, 3);
  assert.deepEqual(r.days.map((d) => d.developing), [false, false, true]);
  near(r.days[0].poc, 100, 0.5);
  near(r.days[1].poc, 110, 0.5);
  assert.equal(r.days[0].endTime, r.days[1].startTime);
  assert.equal(r.days[2].candleCount, 5);
});

test("daily profiles: a thin partial day at the start of the history is dropped, the live day is kept", () => {
  const candles = [...hourly(0, 3, 100), ...hourly(1, 24, 110), ...hourly(2, 1, 120)];
  const r = dailyProfiles(candles, "UTC");
  assert.equal(r.days.length, 2);
  assert.equal(r.days[0].key, "2026-01-06");
  assert.equal(r.days[1].developing, true);
});

test("daily profiles: day boundaries follow the chosen timezone", () => {
  const candles = hourly(0, 24, 100);
  assert.equal(dailyProfiles(candles, "UTC").days.length, 1);
  // 24 hourly candles cross local midnight in UTC+5, so they split into two days.
  assert.equal(dailyProfiles(candles, "Asia/Karachi").days.length, 2);
});

test("daily profiles: timeframes slower than 4h are unsupported", () => {
  const daily = Array.from({ length: 10 }, (_, i) => bar(day0 + i * DAY, 1, 2, 5));
  const r = dailyProfiles(daily, "UTC");
  assert.equal(r.supported, false);
  assert.deepEqual(r.days, []);
  const fourHour = Array.from({ length: 12 }, (_, i) => bar(day0 + i * MAX_STEP_SECONDS, 1, 2, 5));
  assert.equal(dailyProfiles(fourHour, "UTC").supported, true);
  // No candles yet: still a valid timeframe, just nothing to show.
  assert.deepEqual(dailyProfiles([], "UTC"), { supported: true, step: 0, days: [] });
});

test("value area position and the summary against the prior day", () => {
  const candles = [...hourly(0, 24, 100), ...hourly(1, 6, 110)];
  const { days } = dailyProfiles(candles, "UTC");
  const prev = days[0];
  assert.equal(valueAreaPosition(prev.vah + 1, prev), "above");
  assert.equal(valueAreaPosition(prev.val - 1, prev), "below");
  assert.equal(valueAreaPosition(prev.poc, prev), "inside");
  assert.equal(valueAreaPosition(100, null), null);

  const s = dailySummary(days, 110);
  assert.equal(s.today.developing, true);
  assert.equal(s.prev.key, prev.key);
  assert.equal(s.vsPrev, "above");
  assert.ok(s.pocGapPct > 8 && s.pocGapPct < 10);
  // No developing day (all history ended): "prev" is simply the newest day.
  const done = dailySummary([{ ...prev, developing: false }], 100);
  assert.equal(done.today, null);
  assert.equal(done.prev.key, prev.key);
});
