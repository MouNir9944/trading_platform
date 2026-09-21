import { useEffect, useMemo, useState } from "react";

import { getNews, getNewsCalendar } from "../api.js";
import { usePersistentState, oneOf, isText } from "../lib/persist.js";

const RANGES = [["1", "Today"], ["3", "3 days"], ["7", "7 days"]];
const KIND_LABEL = { "central-bank": "Official", news: "News", forex: "Forex", energy: "Energy", crypto: "Crypto" };
const IMPACTS = [["High", "High"], ["Medium", "Medium"], ["Low", "Low"]];

function dayKey(ms, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

function dayLabel(ms, timeZone, nowMs) {
  const key = dayKey(ms, timeZone);
  const date = new Intl.DateTimeFormat(undefined, { timeZone, weekday: "long", day: "numeric", month: "long" }).format(ms);
  if (key === dayKey(nowMs, timeZone)) return `Today · ${date}`;
  if (key === dayKey(nowMs - 86_400_000, timeZone)) return `Yesterday · ${date}`;
  if (key === dayKey(nowMs + 86_400_000, timeZone)) return `Tomorrow · ${date}`;
  return date;
}

const clock = (ms, timeZone) => new Intl.DateTimeFormat(undefined, { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(ms);

function ago(ms, nowMs) {
  if (!ms) return "no story";
  const minutes = Math.max(0, Math.round((nowMs - ms) / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 48) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} days ago`;
}

/**
 * Economic news of the day from public feeds (central banks and business publishers), with each story's source and
 * a link to the publisher, plus this week's calendar of scheduled releases. Headlines and short summaries only.
 */
export default function NewsPanel({ timeZone = "UTC" }) {
  const [news, setNews] = useState(null);
  const [newsError, setNewsError] = useState(null);
  const [calendar, setCalendar] = useState(null);
  const [calendarError, setCalendarError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = usePersistentState("pref:news-range", "3", oneOf(RANGES.map(([value]) => value)));
  const [topic, setTopic] = usePersistentState("pref:news-topic", "all", isText);
  const [source, setSource] = usePersistentState("pref:news-source", "all", isText);
  const [query, setQuery] = useState("");
  const [relevantOnly, setRelevantOnly] = usePersistentState("pref:news-relevant-only", true, (v) => typeof v === "boolean");
  const [impactList, setImpactList] = usePersistentState("pref:news-impacts", ["High", "Medium"], (v) => Array.isArray(v) && v.every((x) => IMPACTS.some(([value]) => value === x)));
  const impacts = useMemo(() => new Set(impactList), [impactList]);
  const [currency, setCurrency] = usePersistentState("pref:news-currency", "all", isText);
  const [tick, setTick] = useState(Date.now());

  const load = () => {
    setLoading(true);
    getNews(7).then((data) => { setNews(data); setNewsError(null); }).catch((err) => setNewsError(err.message)).finally(() => setLoading(false));
    getNewsCalendar().then((data) => { setCalendar(data); setCalendarError(null); }).catch((err) => setCalendarError(err.message));
  };

  useEffect(() => {
    load();
    const refresh = window.setInterval(load, 10 * 60_000);
    const clockTick = window.setInterval(() => setTick(Date.now()), 60_000);
    return () => { window.clearInterval(refresh); window.clearInterval(clockTick); };
  }, []);

  // A saved filter for a source, topic or currency the feeds no longer carry would hide everything: fall back to "all".
  useEffect(() => {
    if (news && source !== "all" && !news.sources.some((s) => s.id === source)) setSource("all");
    if (news && topic !== "all" && !news.topics.some((t) => t.id === topic)) setTopic("all");
  }, [news]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (calendar && currency !== "all" && !calendar.events.some((e) => e.currency === currency)) setCurrency("all");
  }, [calendar]); // eslint-disable-line react-hooks/exhaustive-deps

  const nowMs = tick;
  // "Today" is the reader's calendar day, "3 days" today and the two before it, and so on.
  const firstDay = dayKey(nowMs - (Number(range) - 1) * 86_400_000, timeZone);
  const inRange = (ms) => dayKey(ms, timeZone) >= firstDay;
  const stories = useMemo(() => {
    if (!news) return [];
    const q = query.trim().toLowerCase();
    return news.items.filter((i) => (
      inRange(i.publishedAt)
      && (!relevantOnly || i.relevant)
      && (topic === "all" || i.tags.includes(topic))
      && (source === "all" || i.sourceId === source)
      && (!q || `${i.title} ${i.summary} ${i.source}`.toLowerCase().includes(q))
    ));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [news, range, topic, source, query, relevantOnly, nowMs, timeZone]);

  const days = useMemo(() => {
    const groups = [];
    for (const item of stories) {
      const key = dayKey(item.publishedAt, timeZone);
      const last = groups[groups.length - 1];
      if (last?.key === key) last.items.push(item);
      else groups.push({ key, at: item.publishedAt, items: [item] });
    }
    return groups;
  }, [stories, timeZone]);

  const topicCounts = useMemo(() => {
    const counts = {};
    for (const i of news?.items ?? []) {
      if (!inRange(i.publishedAt) || (relevantOnly && !i.relevant)) continue;
      for (const t of i.tags) counts[t] = (counts[t] ?? 0) + 1;
    }
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [news, range, relevantOnly, nowMs, timeZone]);

  // ---- calendar: from today on, in the reader's time zone ----
  const currencies = useMemo(() => [...new Set((calendar?.events ?? []).map((e) => e.currency))].sort(), [calendar]);
  const events = useMemo(() => (calendar?.events ?? []).filter((e) => (
    dayKey(e.time, timeZone) >= dayKey(nowMs, timeZone) && impacts.has(e.impact) && (currency === "all" || e.currency === currency)
  )), [calendar, impacts, currency, nowMs, timeZone]);
  const eventDays = useMemo(() => {
    const groups = [];
    for (const e of events) {
      const key = dayKey(e.time, timeZone);
      const last = groups[groups.length - 1];
      if (last?.key === key) last.items.push(e);
      else groups.push({ key, at: e.time, items: [e] });
    }
    return groups;
  }, [events, timeZone]);

  const toggleImpact = (value) => setImpactList((prev) => (prev.includes(value) ? prev.filter((x) => x !== value) : [...prev, value]));
  const hiddenByRelevance = news ? news.items.filter((i) => inRange(i.publishedAt) && !i.relevant).length : 0;

  return (
    <div className="news-view">
      <div className="news-main">
        <section className="panel news-controls">
          <div className="panel-heading">
            <div>
              <p className="panel-title">Economic news</p>
              <p className="panel-subtitle">
                Headlines from central banks and major publishers, each with its source and a link to the original
                {news ? ` · updated ${clock(news.generatedAt, timeZone)}` : ""}
              </p>
            </div>
            <div className="stocks-head-actions">
              <button type="button" className="mini-button" onClick={load} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
              <button type="button" className="mini-button" onClick={() => window.open(`${window.location.pathname}#news`, "_blank", "noopener")} title="Open the news in its own browser tab or window">Open in new tab ↗</button>
            </div>
          </div>

          <div className="news-filters">
            <div className="segmented segmented-small" role="group" aria-label="Period">
              {RANGES.map(([value, label]) => <button key={value} type="button" className={range === value ? "is-active" : ""} onClick={() => setRange(value)}>{label}</button>)}
            </div>
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search headlines (inflation, Fed, oil…)" aria-label="Search news" />
            <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Source">
              <option value="all">All sources</option>
              {(news?.sources ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <label className="switch" title="Hide sport, lifestyle and other stories that mention no economic topic">
              <input type="checkbox" checked={relevantOnly} onChange={(e) => setRelevantOnly(e.target.checked)} /> Economy and markets only
            </label>
          </div>
          <div className="cpm-cats" role="group" aria-label="Topic">
            <button type="button" className={topic === "all" ? "is-on" : ""} onClick={() => setTopic("all")}>All topics</button>
            {(news?.topics ?? []).filter((t) => topicCounts[t.id]).map((t) => (
              <button key={t.id} type="button" className={topic === t.id ? "is-on" : ""} onClick={() => setTopic(t.id)}>{t.label}<em>{topicCounts[t.id]}</em></button>
            ))}
          </div>
        </section>

        {newsError && !news && (
          <div className="futures-notice is-error"><strong>Could not load the news</strong><p>{newsError}</p></div>
        )}
        {!news && !newsError && <p className="log-empty">Reading the news feeds…</p>}

        {news && (
          <section className="panel news-list">
            {days.length === 0 && (
              <p className="log-empty">
                No stories match{query ? ` “${query}”` : ""}.
                {relevantOnly && hiddenByRelevance > 0 ? ` ${hiddenByRelevance} other stories are hidden by "Economy and markets only".` : ""}
              </p>
            )}
            {days.map((day) => (
              <div className="news-day" key={day.key}>
                <h3>{dayLabel(day.at, timeZone, nowMs)} <span>{day.items.length} {day.items.length === 1 ? "story" : "stories"}</span></h3>
                {day.items.map((item) => (
                  <article className="news-item" key={item.id}>
                    <div className="news-meta">
                      <time dateTime={new Date(item.publishedAt).toISOString()}>{clock(item.publishedAt, timeZone)}</time>
                      <span className={`news-source kind-${item.sourceKind}`} title={`${KIND_LABEL[item.sourceKind] ?? "News"} source`}>{item.source}</span>
                      {item.tags.slice(0, 3).map((t) => <button type="button" key={t} className="news-tag" onClick={() => setTopic(t)}>{news.topics.find((x) => x.id === t)?.label ?? t}</button>)}
                    </div>
                    <a className="news-title" href={item.url} target="_blank" rel="noopener noreferrer">{item.title}</a>
                    {item.summary && <p className="news-summary">{item.summary}</p>}
                    <a className="news-read" href={item.url} target="_blank" rel="noopener noreferrer">Read on {item.source} ↗</a>
                  </article>
                ))}
              </div>
            ))}
          </section>
        )}
      </div>

      <aside className="news-side">
        <section className="panel news-calendar">
          <div className="panel-heading">
            <div>
              <p className="panel-title">Economic calendar</p>
              <p className="panel-subtitle">Scheduled releases and speeches · times in {timeZone}</p>
            </div>
          </div>
          <div className="news-cal-filters">
            <div className="segmented segmented-small" role="group" aria-label="Impact">
              {IMPACTS.map(([value, label]) => <button key={value} type="button" className={impacts.has(value) ? "is-active" : ""} onClick={() => toggleImpact(value)}>{label}</button>)}
            </div>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)} aria-label="Currency">
              <option value="all">All currencies</option>
              {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          {calendarError && !calendar && <p className="order-error">{calendarError}</p>}
          {calendar && eventDays.length === 0 && <p className="log-empty">No {[...impacts].join("/").toLowerCase()} events from today on.</p>}
          {eventDays.map((day) => (
            <div className="cal-day" key={day.key}>
              <h4>{dayLabel(day.at, timeZone, nowMs)}</h4>
              {day.items.map((e) => (
                <div className={`cal-event${e.time < nowMs && e.timed ? " is-past" : ""}`} key={`${e.time}-${e.currency}-${e.title}`}>
                  <span className="cal-time">{e.timed ? clock(e.time, timeZone) : "all day"}</span>
                  <span className={`cal-impact impact-${e.impact.toLowerCase()}`} title={`${e.impact} impact`} />
                  <span className="cal-cur" title={e.country}>{e.currency}</span>
                  <span className="cal-title">
                    {e.url ? <a href={e.url} target="_blank" rel="noopener noreferrer">{e.title}</a> : e.title}
                    {(e.forecast || e.previous) && <small>{e.forecast ? `forecast ${e.forecast}` : ""}{e.forecast && e.previous ? " · " : ""}{e.previous ? `previous ${e.previous}` : ""}</small>}
                  </span>
                </div>
              ))}
            </div>
          ))}
          {calendar && <p className="order-rule-note">Source: <a href={calendar.source.home} target="_blank" rel="noopener noreferrer">{calendar.source.name}</a>. Impact is the publisher's rating of how much the release usually moves markets.</p>}
        </section>

        <section className="panel news-sources">
          <div className="panel-heading">
            <div>
              <p className="panel-title">Sources</p>
              <p className="panel-subtitle">Where every story comes from</p>
            </div>
          </div>
          {(news?.sources ?? []).map((s) => (
            <div className="news-source-row" key={s.id}>
              <i className={s.ok ? "dot-ok" : "dot-err"} title={s.ok ? "Feed is working" : `Unavailable: ${s.error}`} />
              <a href={s.home} target="_blank" rel="noopener noreferrer">{s.name}</a>
              <span className={`news-source kind-${s.kind}`}>{KIND_LABEL[s.kind] ?? s.kind}</span>
              <em>{s.ok ? `${s.shown} · ${ago(s.latest, nowMs)}` : "unavailable"}</em>
            </div>
          ))}
          <p className="order-rule-note">
            Feeds are public RSS feeds, read at most every 10 minutes. Only headlines and short summaries are shown; each story links to its publisher, who owns it.
            Stories are tagged by topic from their wording, so a tag is a guide, not a judgement.
          </p>
        </section>
      </aside>
    </div>
  );
}
