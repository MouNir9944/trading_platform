/**
 * Time helpers: which calendar day a candle belongs to in a given timezone, the classic trading
 * sessions, and how activity (volume, range) is spread over the hours of the day.
 *
 * Binance candle times are UTC. Everything shown to the user goes through these helpers so the chart,
 * the day bands and the session strip all agree on "what time is it".
 */

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const formatters = new Map();

function formatterFor(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(
      timeZone,
      new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        weekday: "short",
      }),
    );
  }
  return formatters.get(timeZone);
}

/** Calendar fields of a UTC timestamp (seconds) as seen in `timeZone`. weekday: 0 = Monday. */
export function zonedParts(timeSec, timeZone) {
  const parts = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(timeSec * 1000))) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAYS.indexOf(parts.weekday),
    key: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/** Offset of `timeZone` from UTC in minutes at the given instant (positive = ahead of UTC). */
export function offsetMinutes(timeZone, date = new Date()) {
  const p = zonedParts(Math.floor(date.getTime() / 1000), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(date.getTime() / 60000) * 60000) / 60000);
}

/** "UTC", "UTC+1", "UTC-5", "UTC+5:30" */
export function tzLabel(timeZone, date = new Date()) {
  const minutes = offsetMinutes(timeZone, date);
  if (minutes === 0) return "UTC";
  const sign = minutes > 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const mm = abs % 60;
  return `UTC${sign}${Math.floor(abs / 60)}${mm ? `:${String(mm).padStart(2, "0")}` : ""}`;
}

/** Runs of consecutive candles that fall on the same calendar day in `timeZone`. */
export function dayInfo(candles, timeZone) {
  const days = [];
  candles.forEach((candle, index) => {
    const p = zonedParts(candle.time, timeZone);
    const last = days[days.length - 1];
    if (last && last.key === p.key) {
      last.endIndex = index + 1;
    } else {
      days.push({
        key: p.key,
        weekday: p.weekday,
        label: `${WEEKDAYS[p.weekday]} ${p.day}`,
        startIndex: index,
        endIndex: index + 1,
        startTime: candle.time,
      });
    }
  });
  return days;
}

/** Classic sessions in UTC hours. Real session times drift an hour with daylight saving; these are approximations. */
export const SESSIONS = [
  { id: "asia", name: "Asia", startUtc: 0, endUtc: 8, color: "#a78bfa" },
  { id: "london", name: "London", startUtc: 8, endUtc: 13, color: "#5b9cff" },
  { id: "overlap", name: "London + New York", startUtc: 13, endUtc: 16, color: "#35c48c" },
  { id: "newyork", name: "New York", startUtc: 16, endUtc: 21, color: "#e0aa48" },
  { id: "late", name: "Late US, quiet", startUtc: 21, endUtc: 24, color: "#56627a" },
];

export const sessionAtUtcHour = (hour) => SESSIONS.find((s) => hour >= s.startUtc && hour < s.endUtc) ?? SESSIONS[0];

/** Runs of consecutive candles inside the same session (by UTC hour). */
export function sessionSegments(candles) {
  const segments = [];
  candles.forEach((candle, index) => {
    const session = sessionAtUtcHour(new Date(candle.time * 1000).getUTCHours());
    const last = segments[segments.length - 1];
    if (last && last.session.id === session.id) last.endIndex = index + 1;
    else segments.push({ session, startIndex: index, endIndex: index + 1 });
  });
  return segments;
}

/** Local clock range of a session, e.g. "09:00–14:00". */
export function sessionLocalRange(session, timeZone, date = new Date()) {
  const at = (utcHour) => {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), utcHour % 24));
    const p = zonedParts(Math.floor(d.getTime() / 1000), timeZone);
    return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  };
  return `${at(session.startUtc)}–${at(session.endUtc)}`;
}

/** Session right now and the one after it. */
export function currentSession(now = new Date()) {
  const hour = now.getUTCHours();
  const session = sessionAtUtcHour(hour);
  const next = SESSIONS[(SESSIONS.indexOf(session) + 1) % SESSIONS.length];
  const minutesLeft = (session.endUtc - hour) * 60 - now.getUTCMinutes();
  return { session, next, minutesLeft };
}

/**
 * Average activity for each hour of the day in `timeZone`. Feed it 1-hour candles (about 40 days is
 * plenty). `activity` is 0..1 relative to the busiest hour; `top` lists the three busiest hours.
 */
export function hourlyProfile(candles, timeZone) {
  const buckets = Array.from({ length: 24 }, (_, hour) => ({ hour, volume: 0, range: 0, samples: 0 }));
  for (const candle of candles) {
    const b = buckets[zonedParts(candle.time, timeZone).hour];
    b.volume += candle.volume;
    b.range += candle.close ? ((candle.high - candle.low) / candle.close) * 100 : 0;
    b.samples += 1;
  }
  const hours = buckets.map((b) => ({
    hour: b.hour,
    avgVolume: b.samples ? b.volume / b.samples : 0,
    avgRangePct: b.samples ? b.range / b.samples : 0,
    samples: b.samples,
  }));
  const maxVolume = Math.max(...hours.map((h) => h.avgVolume), 0) || 1;
  const maxRange = Math.max(...hours.map((h) => h.avgRangePct), 0) || 1;
  const scored = hours.map((h) => ({ ...h, activity: h.avgVolume / maxVolume, volatility: h.avgRangePct / maxRange }));
  const top = [...scored].sort((a, b) => b.avgVolume - a.avgVolume).slice(0, 3).map((h) => h.hour).sort((a, b) => a - b);
  const quiet = [...scored].filter((h) => h.samples).sort((a, b) => a.avgVolume - b.avgVolume).slice(0, 3).map((h) => h.hour).sort((a, b) => a - b);
  return { hours: scored, top, quiet, days: Math.round(candles.length / 24) };
}
