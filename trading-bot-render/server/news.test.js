import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApp } from "./app.js";
import { calendarTime, cleanText, createNews, mergeStories, parseCalendar, parseDate, parseFeed, tagsFor } from "./news.js";
import { OrderManager } from "./orders.js";
import { FileStore } from "./store.js";

const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const rssItem = ({ title, link, date, description = "" }) => `<item><title>${title}</title><link>${link}</link><pubDate>${new Date(date).toUTCString()}</pubDate><description>${description}</description></item>`;
const rss = (...items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>${items.join("")}</channel></rss>`;

test("text is cleaned: CDATA, entities, HTML tags and spacing", () => {
  assert.equal(cleanText("<![CDATA[Fed &amp; ECB <b>hold</b> rates]]>"), "Fed & ECB hold rates".replace("&", "&"));
  assert.equal(cleanText("Stocks &amp; bonds &lt;p&gt;rally&lt;/p&gt; &#8217;s &#x2014; done"), "Stocks & bonds rally ’s — done");
  assert.equal(cleanText("  a \n\n  b\t c "), "a b c");
  assert.equal(cleanText(null), "");
  assert.equal(cleanText("&#99999999999; &unknown;"), "&unknown;", "bad references do not throw");
});

test("RSS items are parsed, with the summary stripped of markup and trimmed", () => {
  const long = "word ".repeat(200);
  const items = parseFeed(rss(
    rssItem({ title: "<![CDATA[Fed holds rates &amp; signals patience]]>", link: "https://example.com/a?utm=1", date: NOW - HOUR, description: "<![CDATA[<p>The <b>Federal Reserve</b> left rates unchanged.</p><img src=x>]]>" }),
    rssItem({ title: "Long one", link: "https://example.com/b", date: NOW - 2 * HOUR, description: long }),
    rssItem({ title: "Same as summary", link: "https://example.com/c", date: NOW - 3 * HOUR, description: "Same as summary" }),
  ));
  assert.equal(items.length, 3);
  assert.equal(items[0].title, "Fed holds rates & signals patience");
  assert.equal(items[0].summary, "The Federal Reserve left rates unchanged.");
  assert.equal(items[0].publishedAt, Math.floor((NOW - HOUR) / 1000) * 1000);
  assert.ok(items[1].summary.length <= 301 && items[1].summary.endsWith("…"));
  assert.equal(items[2].summary, "", "a summary that only repeats the title is dropped");
});

test("Atom entries work, and items without a title, link or date are skipped", () => {
  const atom = `<feed><entry><title>Atom story</title><link rel="alternate" href="https://example.com/atom"/><updated>2026-09-20T10:00:00Z</updated><summary>Short</summary></entry>
    <entry><title>No link</title><updated>2026-09-20T10:00:00Z</updated></entry>
    <entry><title>No date</title><link href="https://example.com/nd"/></entry></feed>`;
  const items = parseFeed(atom);
  assert.equal(items.length, 1);
  assert.equal(items[0].url, "https://example.com/atom");
  assert.equal(items[0].publishedAt, Date.UTC(2026, 8, 20, 10));
  assert.deepEqual(parseFeed("this is not xml"), []);
  const unsafe = parseFeed(rss(rssItem({ title: "Bad link", link: "javascript:alert(1)", date: NOW })));
  assert.deepEqual(unsafe, [], "only http(s) links are kept");
});

test("dates: RFC dates, ISO dates, and zone-less dates are read as UTC", () => {
  assert.equal(parseDate("Sun, 20 Sep 2026 06:40 GMT"), Date.UTC(2026, 8, 20, 6, 40));
  assert.equal(parseDate("Fri, 18 Sep 2026 10:00:00 +0200"), Date.UTC(2026, 8, 18, 8));
  assert.equal(parseDate("2026-09-20 11:12:08"), Date.UTC(2026, 8, 20, 11, 12, 8));
  assert.equal(parseDate("nonsense"), null);
  assert.equal(parseDate(null), null);
});

test("topics come from the wording and from what kind of source published the story", () => {
  assert.deepEqual(tagsFor("Fed signals rate cut as inflation cools", "news").sort(), ["central-banks", "inflation", "rates"].sort());
  assert.ok(tagsFor("US payrolls beat forecasts as unemployment falls", "news").includes("jobs"));
  assert.ok(tagsFor("Brent crude jumps as OPEC trims output", "news").includes("energy"));
  assert.ok(tagsFor("Bitcoin slides", "news").includes("crypto"));
  assert.deepEqual(tagsFor("Man United owner in tax row", "news"), []);
  assert.ok(tagsFor("Anything at all", "central-bank").includes("central-banks"));
  assert.ok(tagsFor("Anything at all", "crypto").includes("crypto"));
  assert.ok(!tagsFor("The federal budget", "news").includes("central-banks"), "'fed' is matched as a word, not inside another");
});

test("merging: newest first, one copy of a story, stale and future dates dropped", () => {
  const mk = (title, url, at, extra = {}) => ({ title, url, publishedAt: at, summary: "", ...extra });
  const merged = mergeStories([
    [mk("Fed holds rates", "https://a.com/1?ref=x", NOW - HOUR), mk("Old news", "https://a.com/old", NOW - 20 * DAY)],
    [mk("FED HOLDS RATES!", "https://b.com/2", NOW - 2 * HOUR), mk("Other story", "https://www.a.com/1/", NOW - 3 * HOUR), mk("From the future", "https://b.com/f", NOW + 5 * HOUR), mk("Real second story", "https://b.com/3", NOW - 4 * HOUR)],
  ], { now: NOW, days: 7 });
  assert.deepEqual(merged.map((x) => x.title), ["Fed holds rates", "Real second story"], "same title and same URL (ignoring query and www) are one story");
});

test("the calendar: UTC times, holidays, all-day events and missing values", () => {
  assert.equal(calendarTime("09-20-2026", "11:00pm"), Date.UTC(2026, 8, 20, 23));
  assert.equal(calendarTime("09-21-2026", "12:30am"), Date.UTC(2026, 8, 21, 0, 30));
  assert.equal(calendarTime("09-21-2026", "12:00pm"), Date.UTC(2026, 8, 21, 12));
  assert.equal(calendarTime("09-21-2026", "All Day"), Date.UTC(2026, 8, 21));
  assert.equal(calendarTime("garbage", "1:00pm"), null);
  const xml = `<weeklyevents>
    <event><title>CPI m/m</title><country>USD</country><date><![CDATA[09-22-2026]]></date><time><![CDATA[12:30pm]]></time><impact><![CDATA[High]]></impact><forecast><![CDATA[0.3%]]></forecast><previous><![CDATA[0.2%]]></previous><url><![CDATA[https://www.forexfactory.com/calendar/1]]></url></event>
    <event><title>Bank Holiday</title><country>JPY</country><date><![CDATA[09-21-2026]]></date><time><![CDATA[All Day]]></time><impact><![CDATA[Holiday]]></impact><forecast /><previous /></event>
    <event><title>Broken</title><country>USD</country><date>x</date></event></weeklyevents>`;
  const events = parseCalendar(xml);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.title), ["Bank Holiday", "CPI m/m"], "sorted by time");
  assert.deepEqual([events[1].impact, events[1].forecast, events[1].previous, events[1].country, events[1].timed], ["High", "0.3%", "0.2%", "United States", true]);
  assert.deepEqual([events[0].impact, events[0].timed, events[0].forecast], ["Holiday", false, null]);
});

// ---- the service ----

const feeds = [
  { id: "bank", name: "Central Bank", kind: "central-bank", region: "US", url: "https://bank.test/feed", home: "https://bank.test" },
  { id: "press", name: "Business Press", kind: "news", region: "US", url: "https://press.test/feed", home: "https://press.test" },
  { id: "flaky", name: "Flaky Feed", kind: "news", region: "US", url: "https://flaky.test/feed", home: "https://flaky.test" },
];

function fakeWorld() {
  const state = { calls: [], flakyDown: false, clock: NOW };
  const bodies = {
    "https://bank.test/feed": () => rss(rssItem({ title: "Board announces rate decision", link: "https://bank.test/1", date: state.clock - 2 * HOUR })),
    "https://press.test/feed": () => rss(
      rssItem({ title: "Inflation cools more than expected", link: "https://press.test/1", date: state.clock - HOUR, description: "CPI rose 2.4%." }),
      rssItem({ title: "Celebrity chef opens restaurant", link: "https://press.test/2", date: state.clock - 3 * HOUR }),
      rssItem({ title: "Three days ago: jobs report", link: "https://press.test/3", date: state.clock - 3 * DAY }),
    ),
    "https://flaky.test/feed": () => rss(rssItem({ title: "Oil jumps on supply fears", link: "https://flaky.test/1", date: state.clock - 5 * HOUR })),
  };
  const fetchFn = async (url) => {
    state.calls.push(String(url));
    if (String(url).includes("flaky") && state.flakyDown) return new Response("nope", { status: 503 });
    if (String(url).includes("faireconomy")) {
      return new Response(`<weeklyevents><event><title>CPI y/y</title><country>USD</country><date>09-22-2026</date><time>12:30pm</time><impact>High</impact></event></weeklyevents>`, { status: 200 });
    }
    return new Response(bodies[url](), { status: 200, headers: { "content-type": "application/rss+xml" } });
  };
  return { state, fetchFn };
}

test("the service merges feeds, tags stories and marks the ones that are not about the economy", async () => {
  const { state, fetchFn } = fakeWorld();
  const news = createNews({ fetchFn, feeds, now: () => state.clock });
  const data = await news.news(7);
  assert.deepEqual(data.items.map((i) => i.title), ["Inflation cools more than expected", "Board announces rate decision", "Celebrity chef opens restaurant", "Oil jumps on supply fears", "Three days ago: jobs report"]);
  const byTitle = Object.fromEntries(data.items.map((i) => [i.title, i]));
  assert.equal(byTitle["Inflation cools more than expected"].source, "Business Press");
  assert.ok(byTitle["Inflation cools more than expected"].tags.includes("inflation"));
  assert.equal(byTitle["Inflation cools more than expected"].relevant, true);
  assert.equal(byTitle["Celebrity chef opens restaurant"].relevant, false, "no economic topic from a general news source");
  assert.equal(byTitle["Board announces rate decision"].relevant, true, "central banks are always relevant");
  assert.equal(data.sources.length, 3);
  assert.deepEqual(data.sources.find((s) => s.id === "press"), { id: "press", name: "Business Press", kind: "news", region: "US", home: "https://press.test", ok: true, error: null, shown: 3, latest: Math.floor((state.clock - HOUR) / 1000) * 1000 });
  assert.equal(data.topics.find((t) => t.id === "inflation").count, 1);

  const oneDay = await news.news(1);
  assert.ok(!oneDay.items.some((i) => /Three days ago/.test(i.title)), "the day window filters");
  assert.equal(oneDay.sources.find((s) => s.id === "press").shown, 2, "and so do the per-source counts");
});

test("one feed failing does not hide the others, and its last good stories are kept", async () => {
  const { state, fetchFn } = fakeWorld();
  const news = createNews({ fetchFn, feeds, now: () => state.clock });
  await news.news(7);
  state.flakyDown = true;
  state.clock += 11 * 60_000; // past the 10 minute cache
  const data = await news.news(7);
  const flaky = data.sources.find((s) => s.id === "flaky");
  assert.equal(flaky.ok, false);
  assert.match(flaky.error, /503/);
  assert.ok(data.items.some((i) => i.title === "Oil jumps on supply fears"), "the earlier stories are still shown");
  assert.ok(data.items.some((i) => i.title === "Board announces rate decision"), "and the other sources are unaffected");
});

test("feeds are re-read at most every ten minutes, and a request shares one download", async () => {
  const { state, fetchFn } = fakeWorld();
  const news = createNews({ fetchFn, feeds, now: () => state.clock });
  await Promise.all([news.news(7), news.news(3), news.news(1)]);
  assert.equal(state.calls.length, 3, "three feeds, once each, however many callers");
  await news.news(7);
  assert.equal(state.calls.length, 3, "served from the cache");
  state.clock += 11 * 60_000;
  await news.news(7);
  assert.equal(state.calls.length, 6);
});

test("an all-down service reports every source as failed instead of throwing", async () => {
  const news = createNews({ fetchFn: async () => { throw Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }); }, feeds, now: () => NOW });
  const data = await news.news(7);
  assert.equal(data.items.length, 0);
  assert.ok(data.sources.every((s) => !s.ok && /unreachable/.test(s.error)));
});

test("a feed in a legacy encoding is decoded with the encoding it declares", async () => {
  const xml = `<?xml version="1.0" encoding="windows-1252"?><rss><channel>${rssItem({ title: "Café prices rise", link: "https://x.test/1", date: NOW - HOUR })}</channel></rss>`;
  const bytes = Buffer.from(xml, "latin1"); // "é" is the single byte 0xE9
  const fetchFn = async () => new Response(bytes, { status: 200 });
  const news = createNews({ fetchFn, feeds: [feeds[1]], now: () => NOW });
  assert.equal((await news.news(1)).items[0].title, "Café prices rise");
});

test("the calendar is cached, keeps the last good week, and errors only when it never worked", async () => {
  const { state, fetchFn } = fakeWorld();
  const news = createNews({ fetchFn, feeds, now: () => state.clock });
  const cal = await news.calendar();
  assert.equal(cal.events[0].title, "CPI y/y");
  assert.equal(cal.source.home, "https://www.forexfactory.com/calendar");
  const before = state.calls.length;
  await news.calendar();
  assert.equal(state.calls.length, before, "cached");

  const down = createNews({ fetchFn: async () => new Response("no", { status: 500 }), feeds, now: () => NOW });
  await assert.rejects(down.calendar(), /calendar is unavailable/);

  let broken = false;
  const flapping = createNews({ fetchFn: async (u) => (broken ? new Response("no", { status: 500 }) : fetchFn(u)), feeds, now: () => state.clock });
  await flapping.calendar();
  broken = true;
  state.clock += 31 * 60_000;
  assert.equal((await flapping.calendar()).events[0].title, "CPI y/y", "the last good week survives an outage");
});

test("HTTP: /news and /news/calendar", async () => {
  const { state, fetchFn } = fakeWorld();
  const service = createNews({ fetchFn, feeds, now: () => state.clock });
  const store = new FileStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "news-")) });
  const spot = new OrderManager({ getClient: () => ({}), getMode: () => "testnet", getTradingFee: async () => ({}), store });
  await spot.init();
  const { app } = createApp({ orderManager: spot, news: service });
  const server = app.listen(0);
  const get = async (url) => { const r = await fetch(`http://127.0.0.1:${server.address().port}/api${url}`); return { status: r.status, body: await r.json() }; };
  try {
    const all = await get("/news");
    assert.equal(all.status, 200);
    assert.equal(all.body.windowDays, 7);
    assert.equal(all.body.items.length, 5);
    assert.equal((await get("/news?days=1")).body.items.length, 4);
    assert.equal((await get("/news?days=999")).body.windowDays, 14, "the window is capped");
    assert.equal((await get("/news?days=abc")).body.windowDays, 7);
    const cal = await get("/news/calendar");
    assert.equal(cal.body.events[0].currency, "USD");
  } finally {
    server.close();
  }
});
