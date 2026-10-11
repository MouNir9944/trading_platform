import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApp } from "./app.js";
import { Favorites, MAX_FAVORITES, normalizePairs, normalizeStocks, pairKey } from "./favorites.js";
import { OrderManager } from "./orders.js";
import { FileStore } from "./store.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fav-"));
const NOW = 1_700_000_000_000;

test("pairs: the key is rebuilt from the entry, symbols are upper-cased, junk is dropped", () => {
  const out = normalizePairs({
    anything: { market: "spot", symbol: " btcusdt ", note: "  watch the 60k level  ", addedAt: 123 },
    other: { market: "futures", symbol: "ETHUSDT" },
    badMarket: { market: "options", symbol: "BTCUSDT" },
    badSymbol: { market: "spot", symbol: "BT/C" },
    notAnObject: "x",
  }, NOW);
  assert.deepEqual(Object.keys(out).sort(), ["futures:ETHUSDT", "spot:BTCUSDT"]);
  assert.deepEqual(out["spot:BTCUSDT"], { market: "spot", symbol: "BTCUSDT", note: "watch the 60k level", addedAt: 123 });
  assert.equal(out["futures:ETHUSDT"].addedAt, NOW, "a missing time defaults to now");
  assert.equal(out["futures:ETHUSDT"].note, "");
});

test("stocks: tickers like BRK.B are allowed, notes are capped, junk is dropped", () => {
  const out = normalizeStocks({ a: { symbol: "brk.b" }, b: { symbol: "AAPL", note: "x".repeat(500) }, c: { symbol: "has space" }, d: { symbol: "" } }, NOW);
  assert.deepEqual(Object.keys(out).sort(), ["AAPL", "BRK.B"]);
  assert.equal(out.AAPL.note.length, 200);
});

test("a list that is not an object, or is too long, is refused", () => {
  assert.throws(() => normalizePairs([]), /must be an object/);
  assert.throws(() => normalizeStocks(null), /must be an object/);
  const many = Object.fromEntries(Array.from({ length: MAX_FAVORITES + 1 }, (_, i) => [i, { symbol: `S${i}` }]));
  assert.throws(() => normalizeStocks(many), /at most/);
});

test("add, annotate, remove and replace, with the lists surviving a restart", async () => {
  const dir = tmp();
  const favs = new Favorites({ store: new FileStore({ dir }), now: () => NOW });
  assert.deepEqual(await favs.get(), { pairs: {}, stocks: {} });

  await favs.add("pairs", { market: "spot", symbol: "BTCUSDT" });
  await favs.add("stocks", { symbol: "aapl", note: "core holding" });
  let all = await favs.get();
  assert.equal(all.pairs[pairKey("spot", "BTCUSDT")].addedAt, NOW);
  assert.equal(all.stocks.AAPL.note, "core holding");

  // adding again keeps the original time and updates the note only when a new one is given
  await favs.add("stocks", { symbol: "AAPL" });
  assert.equal((await favs.get()).stocks.AAPL.note, "core holding");
  await favs.add("stocks", { symbol: "AAPL", note: "trim above 250" });
  assert.equal((await favs.get()).stocks.AAPL.note, "trim above 250");

  // a second instance on the same files sees the same data
  all = await new Favorites({ store: new FileStore({ dir }) }).get();
  assert.ok(all.pairs["spot:BTCUSDT"] && all.stocks.AAPL);

  await favs.remove("pairs", "spot:BTCUSDT");
  await favs.remove("stocks", "aapl"); // a ticker is matched in any case
  await favs.remove("stocks", "NOPE"); // removing something absent is fine
  assert.deepEqual(await favs.get(), { pairs: {}, stocks: {} });

  await favs.set("pairs", { x: { market: "futures", symbol: "SOLUSDT" } });
  assert.deepEqual(Object.keys((await favs.get()).pairs), ["futures:SOLUSDT"]);
});

test("bad input is rejected with a message, and unknown lists too", async () => {
  const favs = new Favorites({ store: new FileStore({ dir: tmp() }) });
  await assert.rejects(favs.add("pairs", { symbol: "BTCUSDT" }), /market "spot" or "futures"/);
  await assert.rejects(favs.add("stocks", { symbol: "not valid!" }), /ticker/);
  await assert.rejects(favs.add("coins", { symbol: "X" }), /pairs" or "stocks/);
  await assert.rejects(favs.set("coins", {}), /pairs" or "stocks/);
  await assert.rejects(favs.remove("coins", "X"), /pairs" or "stocks/);
});

test("writers that act at the same moment never overwrite each other", async () => {
  const favs = new Favorites({ store: new FileStore({ dir: tmp() }) });
  const tickers = ["AAPL", "MSFT", "NVDA", "TSLA", "AMD", "INTC", "KO", "PEP"];
  await Promise.all(tickers.map((symbol) => favs.add("stocks", { symbol })));
  assert.deepEqual(Object.keys((await favs.get()).stocks).sort(), [...tickers].sort());
});

test("the list is capped", async () => {
  const store = new FileStore({ dir: tmp() });
  await store.setSetting("favorites", { pairs: {}, stocks: Object.fromEntries(Array.from({ length: MAX_FAVORITES }, (_, i) => [`S${i}`, { symbol: `S${i}`, note: "", addedAt: 1 }])) });
  const favs = new Favorites({ store });
  await assert.rejects(favs.add("stocks", { symbol: "EXTRA" }), /at most/);
  await favs.add("stocks", { symbol: "S3", note: "already there" }); // updating an existing one is still fine
});

test("HTTP: read, add, replace and remove through the API", async () => {
  const store = new FileStore({ dir: tmp() });
  const spot = new OrderManager({ getClient: () => ({}), getMode: () => "paper", getTradingFee: async () => ({}), store });
  await spot.init();
  const { app } = createApp({ orderManager: spot, favorites: new Favorites({ store }) });
  const server = app.listen(0);
  const call = async (method, url, body) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${url}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  try {
    assert.deepEqual((await call("GET", "/favorites")).body, { pairs: {}, stocks: {} });
    const added = await call("POST", "/favorites/stocks", { symbol: "NVDA" });
    assert.equal(added.status, 200);
    assert.ok(added.body.stocks.NVDA);
    assert.equal((await call("POST", "/favorites/pairs", { market: "spot" })).status, 400);
    assert.equal((await call("POST", "/favorites/coins", { symbol: "X" })).status, 400);
    const put = await call("PUT", "/favorites/pairs", { "spot:BTCUSDT": { market: "spot", symbol: "BTCUSDT", note: "", addedAt: 5 } });
    assert.equal(put.status, 200);
    assert.deepEqual(Object.keys(put.body.pairs), ["spot:BTCUSDT"]);
    assert.ok(put.body.stocks.NVDA, "replacing one list leaves the other alone");
    assert.equal((await call("PUT", "/favorites/pairs", [1, 2])).status, 400);
    const removed = await call("DELETE", "/favorites/stocks/nvda");
    assert.deepEqual(removed.body.stocks, {});
    assert.equal((await call("GET", "/favorites")).body.pairs["spot:BTCUSDT"].addedAt, 5);
  } finally {
    server.close();
  }
});

test("HTTP: without the service the routes answer 503 rather than crashing", async () => {
  const store = new FileStore({ dir: tmp() });
  const spot = new OrderManager({ getClient: () => ({}), getMode: () => "paper", getTradingFee: async () => ({}), store });
  await spot.init();
  const { app } = createApp({ orderManager: spot });
  const server = app.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/favorites`);
    assert.equal(r.status, 503);
  } finally {
    server.close();
  }
});
