import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApp } from "./app.js";
import { SECRETS, SecretVault } from "./agent/secrets.js";
import { AgentService, DEFAULT_CONFIG, normalizeConfig } from "./agent/service.js";
import { OrderManager } from "./orders.js";
import { FileStore } from "./store.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agent-"));
const TG = "123456789:AAH_fakefakefakefakefakefakefakefake-1234";
const CLAUDE = "sk-ant-api03-fakefakefakefakefakefakefake5678";
const STT = "stt-key-abcdefgh9012";

// ---------- the key vault ----------

test("a saved key is encrypted in the store, shown only by its last four characters, and survives a restart", async () => {
  const store = new FileStore({ dir: tmp() });
  const vault = new SecretVault({ store, passphrase: "dashboard-pw", env: {} });
  await vault.load();
  assert.deepEqual(vault.describe("anthropic"), { set: false, source: null, hint: null });
  await vault.set("anthropic", `  ${CLAUDE}  `);
  assert.deepEqual(vault.describe("anthropic"), { set: true, source: "page", hint: "…5678" });
  assert.equal(vault.get("anthropic"), CLAUDE);

  const stored = JSON.stringify(await store.getSetting("agent_secrets"));
  assert.ok(!stored.includes(CLAUDE) && !stored.includes("sk-ant"), "the key is not in the database in the clear");
  assert.ok(!stored.includes("dashboard-pw"));

  const again = new SecretVault({ store, passphrase: "dashboard-pw", env: {} });
  await again.load();
  assert.equal(again.get("anthropic"), CLAUDE);
});

test("with a different dashboard password the saved keys cannot be opened, and say so", async () => {
  const store = new FileStore({ dir: tmp() });
  const a = new SecretVault({ store, passphrase: "old", env: {} });
  await a.set("telegram", TG);
  const b = new SecretVault({ store, passphrase: "new", env: {} });
  await b.load();
  assert.equal(b.get("telegram"), "");
  assert.deepEqual(b.describe("telegram"), { set: false, source: "unreadable", hint: null });
});

test("a key saved on the page wins over the environment's, and removing it falls back to the environment", async () => {
  const vault = new SecretVault({ store: new FileStore({ dir: tmp() }), passphrase: "pw", env: { ANTHROPIC_API_KEY: "sk-ant-from-environment-1234567890" } });
  assert.deepEqual(vault.describe("anthropic"), { set: true, source: "environment", hint: null });
  assert.equal(vault.get("anthropic"), "sk-ant-from-environment-1234567890");
  await vault.set("anthropic", CLAUDE);
  assert.equal(vault.get("anthropic"), CLAUDE);
  await vault.set("anthropic", "");
  assert.equal(vault.get("anthropic"), "sk-ant-from-environment-1234567890");
});

test("keys that do not look right, or cannot be encrypted, are refused with a helpful message", async () => {
  const vault = new SecretVault({ store: new FileStore({ dir: tmp() }), passphrase: "pw", env: {} });
  await assert.rejects(vault.set("anthropic", "not-a-key"), /does not look like a Claude API key.*sk-ant-/);
  await assert.rejects(vault.set("telegram", "hello"), /Telegram bot token.*@BotFather/);
  await assert.rejects(vault.set("speech", "short"), /Speech-to-text key/);
  await assert.rejects(vault.set("nope", "x"), /unknown key/);
  const noPassword = new SecretVault({ store: new FileStore({ dir: tmp() }), passphrase: "", env: {} });
  await assert.rejects(noPassword.set("telegram", TG), /Set APP_PASSWORD/);
  assert.deepEqual(Object.keys(SECRETS), ["telegram", "anthropic", "speech"]);
});

test("keys saved at the same moment do not overwrite each other", async () => {
  const store = new FileStore({ dir: tmp() });
  const vault = new SecretVault({ store, passphrase: "pw", env: {} });
  await Promise.all([vault.set("telegram", TG), vault.set("anthropic", CLAUDE), vault.set("speech", STT)]);
  const again = new SecretVault({ store, passphrase: "pw", env: {} });
  await again.load();
  assert.deepEqual([again.get("telegram"), again.get("anthropic"), again.get("speech")], [TG, CLAUDE, STT]);
});

// ---------- the settings ----------

test("settings: defaults are safe, partial changes merge, and bad values are refused", () => {
  assert.equal(DEFAULT_CONFIG.enabled, false);
  assert.equal(DEFAULT_CONFIG.allowTrading, false);
  assert.equal(DEFAULT_CONFIG.allowLive, false);
  const c = normalizeConfig({ enabled: true, allowedUserIds: [" 123456 ", 123456, "777888"], instructions: "  Answer in French.  ", voice: { language: "fr" } });
  assert.equal(c.enabled, true);
  assert.deepEqual(c.allowedUserIds, ["123456", "777888"]);
  assert.equal(c.instructions, "Answer in French.");
  assert.deepEqual(c.voice, { enabled: true, language: "fr" });
  assert.equal(c.agents[0].model, "claude-opus-5-5", "what was not mentioned is kept");
  for (const bad of [{ enabled: "yes" }, { instructions: "x".repeat(2001) }, { allowedUserIds: ["abc"] }, { allowedUserIds: Array(11).fill("123456") }, { tools: { made_up: false } }, { tools: { get_price: "no" } }, { voice: { language: "klingon!" } }, []]) {
    assert.throws(() => normalizeConfig(bad), (err) => err.httpStatus === 400, JSON.stringify(bad));
  }
});

test("settings: only switched-off tools are stored, and live trading needs trading on and the word LIVE", () => {
  const c = normalizeConfig({ tools: { get_price: true, get_news: false } });
  assert.deepEqual(c.tools, { get_news: false });
  assert.throws(() => normalizeConfig({ allowTrading: true, allowLive: true }), /word LIVE/);
  assert.throws(() => normalizeConfig({ allowTrading: true, allowLive: true, confirmLive: "live" }), /word LIVE/);
  const on = normalizeConfig({ allowTrading: true, allowLive: true, confirmLive: "LIVE" });
  assert.equal(on.allowLive, true);
  assert.equal(normalizeConfig({ allowTrading: false }, on).allowLive, false, "turning trading off turns live off too");
  assert.equal(normalizeConfig({ allowLive: true, confirmLive: "LIVE" }, DEFAULT_CONFIG).allowLive, false, "live without trading means nothing");
  assert.equal(normalizeConfig({ instructions: "hi" }, on).allowLive, true, "an unrelated change does not ask for LIVE again");
});

// ---------- the service ----------

/** A fake Telegram and a fake Claude for the service. */
function rig({ env = {}, passphrase = "pw", sendMessageAnswer, injectClient = true } = {}) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const method = String(url).split("/").pop();
    const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : {};
    calls.push({ method, ...body });
    if (method === "getUpdates") await new Promise((r) => setTimeout(r, 5));
    if (method === "sendMessage" && sendMessageAnswer) return sendMessageAnswer;
    const result = method === "getMe" ? { username: "my_bot" } : true;
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  };
  const store = new FileStore({ dir: tmp() });
  const say = (text) => ({ stop_reason: "end_turn", content: [{ type: "text", text }] });
  const anthropic = { messages: { create: async () => say("pong") }, beta: { messages: { create: async () => say("pong") } } };
  const vault = new SecretVault({ store, passphrase, env });
  const service = new AgentService({ store, env: { APP_PASSWORD: passphrase, ...env }, getApi: () => async () => ({ mode: "paper", paper: true }), fetchFn, anthropic: injectClient ? anthropic : null, vault });
  return { service, store, calls };
}

test("the status never contains a key, only whether each is set", async () => {
  const { service } = rig();
  await service.init();
  await service.saveSecrets({ telegram: TG, speech: STT, agents: { default: CLAUDE } });
  const status = service.status();
  const text = JSON.stringify(status);
  for (const key of [TG, CLAUDE, STT]) assert.ok(!text.includes(key), "a key leaked into the status");
  assert.deepEqual(status.secrets.telegram, { set: true, source: "page", hint: "…1234" });
  assert.equal(status.canStoreKeys, true);
  assert.equal(status.secretLabels.telegram.env, "TELEGRAM_BOT_TOKEN");
  assert.deepEqual(status.agents[0].key, { set: true, source: "page", hint: "…5678" });
});

test("the bot starts only when it is switched on and everything it needs is there, and says what is missing", async () => {
  const { service, calls } = rig({ injectClient: false });
  await service.init();
  await service.save({ enabled: true });
  assert.match(service.status().bot.error, /Telegram bot token/);
  await service.saveSecrets({ telegram: TG });
  assert.match(service.status().bot.error, /API key for the agent "Claude"/);
  await service.saveSecrets({ agents: { default: CLAUDE } });
  assert.match(service.status().bot.error, /Telegram user ID/);
  assert.equal(service.status().bot.running, false);
  await service.save({ allowedUserIds: ["424242"] });
  const bot = service.status().bot;
  assert.equal(bot.running, true);
  assert.equal(bot.username, "my_bot");
  assert.equal(bot.error, null);
  assert.ok(calls.some((c) => c.method === "deleteWebhook"));
  await service.save({ enabled: false });
  assert.equal(service.status().bot.running, false);
  service.stop();
});

test("a rejected Telegram token is explained on the page instead of failing silently", async () => {
  const store = new FileStore({ dir: tmp() });
  const fetchFn = async () => new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 });
  const vault = new SecretVault({ store, passphrase: "pw", env: {} });
  const service = new AgentService({ store, env: { APP_PASSWORD: "pw" }, getApi: () => async () => ({}), fetchFn, anthropic: {}, vault });
  await service.init();
  await service.saveSecrets({ telegram: TG });
  await service.save({ enabled: true, allowedUserIds: ["424242"] });
  assert.equal(service.status().bot.running, false);
  assert.match(service.status().bot.error, /Telegram rejected the bot token/);
});

test("settings and keys survive a restart of the server, including live permission that was confirmed", async () => {
  const first = rig();
  await first.service.init();
  await first.service.saveSecrets({ agents: { default: CLAUDE } });
  await first.service.save({ allowedUserIds: ["424242"], allowTrading: true, allowLive: true, confirmLive: "LIVE", instructions: "be brief" });
  const second = new AgentService({ store: first.store, env: { APP_PASSWORD: "pw" }, getApi: () => async () => ({}), vault: new SecretVault({ store: first.store, passphrase: "pw", env: {} }) });
  await second.init();
  const c = second.status().config;
  assert.deepEqual([c.allowTrading, c.allowLive, c.instructions, c.allowedUserIds], [true, true, "be brief", ["424242"]]);
  assert.equal(second.status().agents[0].key.set, true);
});

test("allowed users come from the settings and the environment together", async () => {
  const { service } = rig({ env: { TELEGRAM_ALLOWED_USER_IDS: "555666, bad ,777888" } });
  await service.init();
  await service.save({ allowedUserIds: ["424242"] });
  assert.deepEqual([...service.allowedIds()].sort(), ["424242", "555666", "777888"]);
});

test("changes to trading and live permission are written to the activity log", async () => {
  const { service } = rig();
  await service.init();
  await service.save({ allowTrading: true });
  assert.ok(service.status().log.some((e) => e.type === "settings" && /allowTrading=true/.test(e.detail)));
  await service.saveSecrets({ agents: { default: CLAUDE } });
  const entry = service.status().log.find((e) => /Claude API key saved/.test(e.detail));
  assert.ok(entry && !JSON.stringify(entry).includes(CLAUDE));
});

test("the test message reaches the first allowed user, or explains why not", async () => {
  const ok = rig();
  await ok.service.init();
  await ok.service.saveSecrets({ telegram: TG });
  await assert.rejects(ok.service.testTelegram(), /Telegram user ID/);
  await ok.service.save({ allowedUserIds: ["424242"] });
  assert.deepEqual(await ok.service.testTelegram(), { sentTo: "424242" });
  assert.equal(ok.calls.find((c) => c.method === "sendMessage").chat_id, "424242");

  const refusing = rig({ sendMessageAnswer: new Response(JSON.stringify({ ok: false, description: "Forbidden: bot can't initiate conversation with a user" }), { status: 403 }) });
  await refusing.service.init();
  await refusing.service.saveSecrets({ telegram: TG });
  await refusing.service.save({ allowedUserIds: ["424242"] });
  await assert.rejects(refusing.service.testTelegram(), /press Start first/);
});

test("trying the agent on the page answers, and never leaves an order waiting", async () => {
  const { service } = rig();
  await service.init();
  await service.saveSecrets({ agents: { default: CLAUDE } });
  assert.deepEqual(await service.tryAgent("ping"), { text: "pong", agent: "Claude", wouldAskToConfirm: [] });
  await assert.rejects(service.tryAgent("   "), /Write something/);
  assert.equal(service.agent.pendingCount(), 0);
});

// ---------- the HTTP API ----------

test("HTTP: read the status, change settings, save a key, and get clear errors", async () => {
  const { service } = rig();
  await service.init();
  const store = new FileStore({ dir: tmp() });
  const spot = new OrderManager({ getClient: () => ({}), getMode: () => "paper", getTradingFee: async () => ({}), store });
  await spot.init();
  const { app } = createApp({ orderManager: spot, agent: service });
  const server = app.listen(0);
  const call = async (method, url, body) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${url}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  try {
    const status = await call("GET", "/agent");
    assert.equal(status.status, 200);
    assert.equal(status.body.config.enabled, false);
    assert.ok(status.body.tools.some((t) => t.name === "place_spot_order" && t.kind === "trade"));
    assert.equal((await call("PUT", "/agent", { instructions: "be brief" })).body.config.instructions, "be brief");
    assert.equal((await call("PUT", "/agent", { allowTrading: true, allowLive: true })).status, 400);
    assert.match((await call("PUT", "/agent", { agents: [{ name: "X", provider: "nope", model: "m" }] })).body.detail, /unknown provider/);
    const saved = await call("PUT", "/agent/secrets", { agents: { default: CLAUDE } });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.agents[0].key.set, true);
    assert.ok(!JSON.stringify(saved.body).includes(CLAUDE));
    assert.equal((await call("PUT", "/agent/secrets", { agents: { default: "nope" } })).status, 400);
    assert.equal((await call("PUT", "/agent/secrets", { agents: { ghost: CLAUDE } })).status, 400);
    assert.equal((await call("PUT", "/agent/secrets", { made_up: "x" })).status, 400);
    assert.equal((await call("PUT", "/agent/secrets", {})).status, 400);
    const removed = await call("PUT", "/agent/secrets", { agents: { default: "" } });
    assert.equal(removed.body.agents[0].key.set, false);
    assert.equal((await call("POST", "/agent/try", { text: "" })).status, 400);
  } finally {
    server.close();
  }
});

test("HTTP: without the agent service the routes answer 503", async () => {
  const store = new FileStore({ dir: tmp() });
  const spot = new OrderManager({ getClient: () => ({}), getMode: () => "paper", getTradingFee: async () => ({}), store });
  await spot.init();
  const { app } = createApp({ orderManager: spot });
  const server = app.listen(0);
  try {
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/agent`)).status, 503);
  } finally {
    server.close();
  }
});
