/**
 * Daily economic news: public RSS/Atom feeds of central banks and major business publishers, merged, de-duplicated
 * and tagged by topic, plus this week's economic calendar (scheduled releases such as CPI, jobs and rate decisions).
 *
 * Only the headline, a short plain-text summary and the link are kept, and every story carries its source, so the
 * page sends readers to the publisher. Feeds fail independently: one being down never hides the others, and its last
 * good stories are kept while it is down.
 */

const TIMEOUT_MS = 12_000;
const CACHE_MS = 10 * 60_000;
const CALENDAR_CACHE_MS = 30 * 60_000;
const MAX_SUMMARY = 300;
const MAX_ITEMS = 600;
const MAX_DAYS = 14;
const UA = "Mozilla/5.0 (compatible; TradingTerminal/1.0)";

/**
 * kind: "central-bank" (official), "news" (business press), "forex", "energy" or "crypto".
 * `home` is where a reader can go to the publisher itself.
 */
export const FEEDS = [
  { id: "fed", name: "Federal Reserve", kind: "central-bank", region: "US", url: "https://www.federalreserve.gov/feeds/press_all.xml", home: "https://www.federalreserve.gov/newsevents.htm" },
  { id: "ecb", name: "European Central Bank", kind: "central-bank", region: "Euro area", url: "https://www.ecb.europa.eu/rss/press.html", home: "https://www.ecb.europa.eu/press/html/index.en.html" },
  { id: "cnbc-economy", name: "CNBC Economy", kind: "news", region: "US", url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258", home: "https://www.cnbc.com/economy/" },
  { id: "cnbc-finance", name: "CNBC Finance", kind: "news", region: "US", url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664", home: "https://www.cnbc.com/finance/" },
  { id: "marketwatch", name: "MarketWatch", kind: "news", region: "US", url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", home: "https://www.marketwatch.com/" },
  { id: "wsj-markets", name: "WSJ Markets", kind: "news", region: "US", url: "https://feeds.content.dowjones.io/public/rss/RSSMarketsMain", home: "https://www.wsj.com/finance" },
  { id: "yahoo-finance", name: "Yahoo Finance", kind: "news", region: "US", url: "https://finance.yahoo.com/news/rssindex", home: "https://finance.yahoo.com/news/" },
  { id: "nyt-economy", name: "New York Times Economy", kind: "news", region: "US", url: "https://rss.nytimes.com/services/xml/rss/nyt/Economy.xml", home: "https://www.nytimes.com/section/business/economy" },
  { id: "nyt-business", name: "New York Times Business", kind: "news", region: "US", url: "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml", home: "https://www.nytimes.com/section/business" },
  { id: "bbc-business", name: "BBC Business", kind: "news", region: "UK", url: "https://feeds.bbci.co.uk/news/business/rss.xml", home: "https://www.bbc.com/news/business" },
  { id: "guardian-economics", name: "The Guardian Economics", kind: "news", region: "UK", url: "https://www.theguardian.com/business/economics/rss", home: "https://www.theguardian.com/business/economics" },
  { id: "investing", name: "Investing.com", kind: "news", region: "Global", url: "https://www.investing.com/rss/news_14.rss", home: "https://www.investing.com/news/economy" },
  { id: "fxstreet", name: "FXStreet", kind: "forex", region: "Global", url: "https://www.fxstreet.com/rss/news", home: "https://www.fxstreet.com/news" },
  { id: "oilprice", name: "OilPrice.com", kind: "energy", region: "Global", url: "https://oilprice.com/rss/main", home: "https://oilprice.com/" },
  { id: "coindesk", name: "CoinDesk", kind: "crypto", region: "Global", url: "https://www.coindesk.com/arc/outboundfeeds/rss/", home: "https://www.coindesk.com/" },
  { id: "cointelegraph", name: "Cointelegraph", kind: "crypto", region: "Global", url: "https://cointelegraph.com/rss", home: "https://cointelegraph.com/" },
];

export const CALENDAR_SOURCE = { name: "Forex Factory calendar (FairEconomy feed)", home: "https://www.forexfactory.com/calendar" };
const CALENDAR_URLS = ["https://nfs.faireconomy.media/ff_calendar_thisweek.xml", "https://nfs.faireconomy.media/ff_calendar_nextweek.xml"];

// ---- topics ----

export const TOPICS = [
  { id: "central-banks", label: "Central banks", test: /\b(fed|federal reserve|fomc|ecb|european central bank|bank of england|boe|bank of japan|boj|central bank|monetary policy|powell|lagarde|bailey|ueda|rate decision)\b/i },
  { id: "rates", label: "Interest rates", test: /\b(interest rates?|rate cuts?|rate hikes?|rate rise|borrowing costs?|yields?|treasur(y|ies)|bond market|mortgage rates?)\b/i },
  { id: "inflation", label: "Inflation", test: /\b(inflation|cpi|pce|ppi|consumer prices?|producer prices?|price index|cost of living|deflation)\b/i },
  { id: "jobs", label: "Jobs", test: /\b(jobs?|payrolls?|unemployment|labou?r market|employment|jobless|hiring|layoffs?|wages?|workers?)\b/i },
  { id: "growth", label: "Growth", test: /\b(gdp|recession|economic growth|economy|slowdown|pmi|manufacturing|retail sales|consumer spending|consumer confidence|productivity)\b/i },
  { id: "trade", label: "Trade", test: /\b(tariffs?|trade war|trade deal|trade talks|sanctions?|exports?|imports?|supply chains?|trade deficit)\b/i },
  { id: "energy", label: "Energy", test: /\b(oil|crude|opec|natural gas|gasoline|energy prices?|brent|wti|lng)\b/i },
  { id: "markets", label: "Markets", test: /\b(stocks?|wall street|s&p 500|nasdaq|dow|equities|shares|sell-?off|rally|earnings|ipo|investors?)\b/i },
  { id: "currencies", label: "Currencies", test: /\b(dollar|euro|yen|sterling|pound|yuan|currency|currencies|forex|exchange rates?)\b/i },
  { id: "housing", label: "Housing", test: /\b(housing|home sales|home prices?|real estate|mortgages?|property market)\b/i },
  { id: "crypto", label: "Crypto", test: /\b(bitcoin|btc|ether(eum)?|crypto(currency|currencies)?|stablecoins?|blockchain|solana|xrp|defi)\b/i },
];

/** Topic ids for a story, from its text and the kind of source it came from. */
export function tagsFor(text, kind) {
  const tags = new Set(TOPICS.filter((t) => t.test.test(text)).map((t) => t.id));
  if (kind === "central-bank") tags.add("central-banks");
  if (kind === "crypto") tags.add("crypto");
  if (kind === "energy") tags.add("energy");
  if (kind === "forex") tags.add("currencies");
  return [...tags];
}

// ---- parsing ----

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…" };
const decodeEntities = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === "#") {
    const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
  }
  return ENTITIES[e.toLowerCase()] ?? m;
});

/** Plain text from feed markup: unwrap CDATA, decode entities, drop tags, tidy spaces. */
export function cleanText(value) {
  if (value == null) return "";
  let s = String(value);
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s);
  if (cdata) s = cdata[1];
  else s = decodeEntities(s);
  s = s.replace(/<[^>]*>/g, " ");
  return decodeEntities(s).replace(/\s+/g, " ").trim();
}

const tagContent = (block, tag) => {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  return m ? m[1] : null;
};

const firstUrl = (...candidates) => {
  for (const c of candidates) {
    const url = cleanText(c);
    if (/^https?:\/\/\S+$/i.test(url)) return url;
  }
  return null;
};

/** A date in ms, or null. Dates without a zone are read as UTC (not the server's local time). */
export function parseDate(value) {
  if (!value) return null;
  const s = cleanText(value);
  const iso = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(:\d\d)?$/.test(s) ? `${s.replace(" ", "T")}Z` : s;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** RSS 2.0 or Atom -> `[{title, url, summary, publishedAt}]`. Items without a title, link or date are dropped. */
export function parseFeed(xml) {
  const items = [];
  const blocks = String(xml).match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) ?? [];
  for (const block of blocks) {
    const title = cleanText(tagContent(block, "title"));
    const atomLink = /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i.exec(block);
    const url = firstUrl(tagContent(block, "link"), atomLink?.[1], /<guid[^>]*isPermaLink=["']true["'][^>]*>([\s\S]*?)<\/guid>/i.exec(block)?.[1], tagContent(block, "guid"));
    const publishedAt = parseDate(tagContent(block, "pubDate") ?? tagContent(block, "published") ?? tagContent(block, "updated") ?? tagContent(block, "dc:date"));
    if (!title || !url || publishedAt == null) continue;
    let summary = cleanText(tagContent(block, "description") ?? tagContent(block, "summary") ?? tagContent(block, "content:encoded") ?? tagContent(block, "content"));
    if (summary.toLowerCase() === title.toLowerCase() || summary.startsWith(title)) summary = summary.slice(title.length).trim();
    if (summary.length > MAX_SUMMARY) summary = `${summary.slice(0, MAX_SUMMARY).replace(/\s+\S*$/, "")}…`;
    items.push({ title, url, summary, publishedAt });
  }
  return items;
}

const normalizeTitle = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const normalizeUrl = (u) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/[?#].*$/, "").replace(/\/$/, "");

/** Merge stories from every source: newest first, one copy of each story, capped. */
export function mergeStories(lists, { now = Date.now(), days = 7 } = {}) {
  const cutoff = now - days * 86_400_000;
  const seenTitle = new Set();
  const seenUrl = new Set();
  const out = [];
  for (const item of lists.flat().sort((a, b) => b.publishedAt - a.publishedAt)) {
    if (item.publishedAt < cutoff || item.publishedAt > now + 3_600_000) continue; // stale, or a date from the future
    const t = normalizeTitle(item.title);
    const u = normalizeUrl(item.url);
    if (seenTitle.has(t) || seenUrl.has(u)) continue;
    seenTitle.add(t);
    seenUrl.add(u);
    out.push(item);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

// ---- calendar ----

const COUNTRY_OF = { USD: "United States", EUR: "Euro area", GBP: "United Kingdom", JPY: "Japan", AUD: "Australia", NZD: "New Zealand", CAD: "Canada", CHF: "Switzerland", CNY: "China" };

/** "09-20-2026" + "11:00pm" (UTC) -> ms. All-day / tentative events have no time and sit at 00:00. */
export function calendarTime(date, time) {
  const d = /^(\d\d)-(\d\d)-(\d{4})$/.exec(String(date).trim());
  if (!d) return null;
  let hours = 0;
  let minutes = 0;
  const t = /^(\d{1,2}):(\d\d)\s*(am|pm)$/i.exec(String(time ?? "").trim());
  if (t) {
    hours = Number(t[1]) % 12 + (t[3].toLowerCase() === "pm" ? 12 : 0);
    minutes = Number(t[2]);
  }
  return Date.UTC(Number(d[3]), Number(d[1]) - 1, Number(d[2]), hours, minutes);
}

export function parseCalendar(xml) {
  const events = [];
  for (const block of String(xml).match(/<event>[\s\S]*?<\/event>/gi) ?? []) {
    const title = cleanText(tagContent(block, "title"));
    const currency = cleanText(tagContent(block, "country")).toUpperCase();
    const time = calendarTime(cleanText(tagContent(block, "date")), cleanText(tagContent(block, "time")));
    if (!title || !currency || time == null) continue;
    const impact = cleanText(tagContent(block, "impact")) || "Low";
    events.push({
      title,
      currency,
      country: COUNTRY_OF[currency] ?? currency,
      time,
      timed: /\d/.test(cleanText(tagContent(block, "time"))),
      impact: /high|medium|low|holiday/i.test(impact) ? impact[0].toUpperCase() + impact.slice(1).toLowerCase() : "Low",
      forecast: cleanText(tagContent(block, "forecast")) || null,
      previous: cleanText(tagContent(block, "previous")) || null,
      url: firstUrl(tagContent(block, "url")),
    });
  }
  return events.sort((a, b) => a.time - b.time);
}

// ---- fetching ----

function decodeBody(buffer, contentType = "") {
  const head = Buffer.from(buffer.slice(0, 200)).toString("latin1");
  const declared = /encoding=["']([^"']+)["']/i.exec(head)?.[1] ?? /charset=([^;\s]+)/i.exec(contentType)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(declared).decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}

export function createNews({ fetchFn = fetch, now = Date.now, feeds = FEEDS } = {}) {
  const last = new Map(); // feed id -> { items, at, error }
  let cache = null;
  let inflight = null;
  let calendarCache = null;

  async function download(url) {
    let response;
    try {
      response = await fetchFn(url, { headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml, */*" }, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new Error(err.name === "TimeoutError" ? "timed out" : `unreachable (${err.cause?.code || err.message})`);
    }
    if (!response.ok) throw new Error(`answered ${response.status}`);
    return decodeBody(await response.arrayBuffer(), response.headers.get("content-type") ?? "");
  }

  async function refreshFeed(feed) {
    try {
      const items = parseFeed(await download(feed.url));
      if (!items.length) throw new Error("no readable stories in the feed");
      last.set(feed.id, { items, at: now(), error: null });
    } catch (err) {
      const previous = last.get(feed.id);
      last.set(feed.id, { items: previous?.items ?? [], at: previous?.at ?? null, error: err.message }); // keep the last good stories
    }
  }

  async function build() {
    await Promise.all(feeds.map(refreshFeed));
    const at = now();
    const tagged = feeds.map((feed) => (last.get(feed.id)?.items ?? []).map((item) => ({
      ...item,
      sourceId: feed.id,
      source: feed.name,
      sourceKind: feed.kind,
      tags: tagsFor(`${item.title} ${item.summary}`, feed.kind),
    })).map((item) => ({ ...item, relevant: item.tags.length > 0 || feed.kind !== "news" }))); // general press also runs sport, celebrity and lifestyle stories
    return { generatedAt: at, items: mergeStories(tagged, { now: at, days: MAX_DAYS }).map((item) => ({ id: normalizeUrl(item.url), ...item })) };
  }

  /** The stories of the last `days` days, with topic counts and per-source health for exactly that window. */
  function view(data, days) {
    const cutoff = now() - days * 86_400_000;
    const items = data.items.filter((i) => i.publishedAt >= cutoff);
    const topicCounts = new Map();
    const sourceCounts = new Map();
    for (const item of items) {
      sourceCounts.set(item.sourceId, (sourceCounts.get(item.sourceId) ?? 0) + 1);
      for (const t of item.tags) topicCounts.set(t, (topicCounts.get(t) ?? 0) + 1);
    }
    return {
      generatedAt: data.generatedAt,
      windowDays: days,
      items,
      topics: TOPICS.map((t) => ({ id: t.id, label: t.label, count: topicCounts.get(t.id) ?? 0 })),
      sources: feeds.map((feed) => {
        const state = last.get(feed.id);
        const newest = (state?.items ?? []).reduce((m, x) => Math.max(m, x.publishedAt), 0);
        return { id: feed.id, name: feed.name, kind: feed.kind, region: feed.region, home: feed.home, ok: !state?.error, error: state?.error ?? null, shown: sourceCounts.get(feed.id) ?? 0, latest: newest || null };
      }),
    };
  }

  return {
    /** Stories from the last `days` days (1-14). Feeds are re-read at most every 10 minutes. */
    async news(days = 7) {
      const d = Math.min(MAX_DAYS, Math.max(1, Math.floor(days) || 7));
      if (!cache || now() - cache.at >= CACHE_MS) {
        inflight ??= build().finally(() => { inflight = null; });
        const data = await inflight;
        cache = { at: now(), data };
      }
      return view(cache.data, d);
    },

    /** This week's (and next week's, when published) scheduled releases. */
    async calendar() {
      if (calendarCache && now() - calendarCache.at < CALENDAR_CACHE_MS) return calendarCache.data;
      const events = [];
      const errors = [];
      await Promise.all(CALENDAR_URLS.map(async (url) => {
        try {
          events.push(...parseCalendar(await download(url)));
        } catch (err) {
          errors.push(err.message);
        }
      }));
      if (!events.length) {
        if (calendarCache) return calendarCache.data; // keep the last good week
        throw new Error(`The economic calendar is unavailable (${errors[0] ?? "no events"})`);
      }
      const data = { generatedAt: now(), source: CALENDAR_SOURCE, events: events.sort((a, b) => a.time - b.time) };
      calendarCache = { at: now(), data };
      return data;
    },
  };
}
