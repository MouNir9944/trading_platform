import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SecretVault } from "./agent/secrets.js";
import { AgentService, DEFAULT_AGENT, DEFAULT_CONFIG, MAX_AGENTS, migrateConfig, normalizeConfig } from "./agent/service.js";
import { TelegramBot } from "./agent/telegram.js";
import { FileStore } from "./store.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "multi-"));
const CLAUDE = "sk-ant-api03-fakefakefakefakefakefakefake5678";
const GEMINI = "AIzaFakeFakeFakeFakeFakeFakeFakeFake9012";
const OPENAI = "sk-proj-fakefakefakefakefake3456";
const agentDef = (over = {}) => ({ name: "Gemini", provider: "gemini", model: "gemini-2.5-flash", ...over });

// ---------- configuring agents ----------

test("the default setup is one Claude agent, and a new agent gets an id of its own", () => {
  assert.deepEqual(DEFAULT_CONFIG.agents, [DEFAULT_AGENT]);
  assert.equal(DEFAULT_CONFIG.activeAgentId, "default");
  const c = normalizeConfig({ agents: [DEFAULT_AGENT, agentDef()] });
  assert.equal(c.agents.length, 2);
  assert.match(c.agents[1].id, /^[a-z0-9]{10}$/);
  assert.deepEqual(c.agents[1], { id: c.agents[1].id, name: "Gemini", provider: "gemini", model: "gemini-2.5-flash", baseUrl: "", effort: "medium" });
});

test("agents: names, models, providers, addresses and limits are checked", () => {
  const bad = (agents, message) => assert.throws(() => normalizeConfig({ agents }), (err) => err.httpStatus === 400 && message.test(err.message), JSON.stringify(agents).slice(0, 80));
  bad([], /between 1 and/);
  bad(Array.from({ length: MAX_AGENTS + 1 }, (_, i) => agentDef({ id: `agent${i}x`, name: `A${i}` })), /between 1 and/);
  bad([agentDef({ provider: "skynet" })], /unknown provider/);
  bad([agentDef({ name: "  " })], /needs a name/);
  bad([agentDef({ name: "x".repeat(41) })], /needs a name/);
  bad([agentDef({ model: "" })], /model name/);
  bad([agentDef({ model: "gemini 2.5; drop" })], /model name/);
  bad([agentDef({ id: "BAD ID" })], /agent id/);
  bad([agentDef({ id: "same1234" }), agentDef({ id: "same1234", name: "Other" })], /same id/);
  bad([agentDef({ provider: "custom", model: "m" })], /needs the address/);
  bad([agentDef({ provider: "custom", model: "m", baseUrl: "not a url" })], /not a valid web address/);
  bad([agentDef({ provider: "custom", model: "m", baseUrl: "ftp://server/v1" })], /http/);
  bad(["x"], /must be an object/);
});

test("custom servers and Ollama take an address; other providers ignore one; effort only matters for Claude", () => {
  const c = normalizeConfig({ agents: [
    agentDef({ id: "local001", name: "Local", provider: "ollama", model: "llama3.1", baseUrl: "http://192.168.1.20:11434/v1/" }),
    agentDef({ id: "mine0001", name: "Mine", provider: "custom", model: "my-model", baseUrl: "https://llm.example.com/v1" }),
    agentDef({ id: "gem00001", baseUrl: "https://evil.example.com", effort: "high" }),
    { ...DEFAULT_AGENT, effort: "high" },
  ] });
  assert.equal(c.agents[0].baseUrl, "http://192.168.1.20:11434/v1", "a trailing slash is dropped");
  assert.equal(c.agents[1].baseUrl, "https://llm.example.com/v1");
  assert.equal(c.agents[2].baseUrl, "", "a provider with its own address cannot be pointed elsewhere");
  assert.equal(c.agents[2].effort, "medium");
  assert.equal(c.agents[3].effort, "high");
});

test("the active agent must exist; removing it falls back to the first one", () => {
  const two = normalizeConfig({ agents: [DEFAULT_AGENT, agentDef({ id: "gem00001" })], activeAgentId: "gem00001" });
  assert.equal(two.activeAgentId, "gem00001");
  assert.throws(() => normalizeConfig({ activeAgentId: "ghost" }, two), /must be one of the agents/);
  const removed = normalizeConfig({ agents: [DEFAULT_AGENT] }, two);
  assert.equal(removed.activeAgentId, "default");
});

test("settings saved before there could be several agents become one agent", () => {
  assert.deepEqual(migrateConfig({ enabled: true, model: "claude-sonnet-5-5", effort: "high", allowedUserIds: ["123456"] }), {
    enabled: true, allowedUserIds: ["123456"], activeAgentId: "default",
    agents: [{ ...DEFAULT_AGENT, model: "claude-sonnet-5-5", effort: "high" }],
  });
  const already = { agents: [DEFAULT_AGENT], activeAgentId: "default" };
  assert.equal(migrateConfig(already), already);
  assert.equal(migrateConfig(null), null);
});

// ---------- the service with several agents ----------

/** A fake world: Telegram, a Gemini-style server, an OpenAI-style server and a local one, recording who was asked. */
function world() {
  const hits = [];
  const fetchFn = async (url, init = {}) => {
    const u = String(url);
    const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : {};
    hits.push({ url: u, auth: init.headers?.Authorization, model: body.model });
    if (u.includes("api.telegram.org")) return new Response(JSON.stringify({ ok: true, result: u.endsWith("getMe") ? { username: "bot" } : true }), { status: 200 });
    const who = u.includes("googleapis") ? "gemini" : u.includes("openai.com") ? "openai" : "local";
    return new Response(JSON.stringify({ choices: [{ message: { content: `answer from ${who}` }, finish_reason: "stop" }] }), { status: 200 });
  };
  const store = new FileStore({ dir: tmp() });
  const claude = { messages: { create: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "answer from claude" }] }) }, beta: { messages: { create: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "answer from claude" }] }) } } };
  const service = new AgentService({ store, env: { APP_PASSWORD: "pw" }, getApi: () => async () => ({ mode: "paper", paper: true }), fetchFn, anthropic: claude, vault: new SecretVault({ store, passphrase: "pw", env: {} }) });
  return { service, store, hits, fetchFn };
}

async function threeAgents(service) {
  await service.init();
  await service.save({ agents: [DEFAULT_AGENT, agentDef({ id: "gem00001" }), { id: "oai00001", name: "GPT", provider: "openai", model: "gpt-4.1" }, { id: "loc00001", name: "Local", provider: "ollama", model: "llama3.1" }] });
}

test("each agent has its own key, kept apart, and the status never shows one", async () => {
  const { service } = world();
  await threeAgents(service);
  await service.saveSecrets({ agents: { default: CLAUDE, gem00001: GEMINI, oai00001: OPENAI } });
  const status = service.status();
  assert.deepEqual(status.agents.map((a) => [a.name, a.key.set, a.key.hint]), [["Claude", true, "…5678"], ["Gemini", true, "…9012"], ["GPT", true, "…3456"], ["Local", true, null]]);
  assert.equal(status.agents[3].key.optional, true, "a local model needs no key");
  const text = JSON.stringify(status);
  for (const k of [CLAUDE, GEMINI, OPENAI]) assert.ok(!text.includes(k));
  assert.equal(status.providers.gemini.keyEnv, "GEMINI_API_KEY");
  assert.equal(status.providers.ollama.needsKey, false);
  assert.equal(status.maxAgents, MAX_AGENTS);
});

test("a key must suit its agent, and an unknown agent is refused", async () => {
  const { service } = world();
  await threeAgents(service);
  await assert.rejects(service.saveSecrets({ agents: { default: GEMINI } }), /does not look like a Claude API key/);
  await assert.rejects(service.saveSecrets({ agents: { gem00001: "short" } }), /Gemini API key/);
  await assert.rejects(service.saveSecrets({ agents: { ghost: GEMINI } }), /unknown agent/);
  await assert.rejects(service.saveSecrets({ claude: CLAUDE }), /unknown key/);
  await assert.rejects(service.saveSecrets({ agents: { default: CLAUDE, ghost: GEMINI } }), /unknown agent/);
  assert.equal(service.status().agents[0].key.set, false, "nothing was half-saved");
});

test("the active agent answers; a Gemini agent talks to Google with its own key; Claude uses the SDK", async () => {
  const { service, hits } = world();
  await threeAgents(service);
  await service.saveSecrets({ agents: { default: CLAUDE, gem00001: GEMINI, oai00001: OPENAI } });
  assert.deepEqual(await service.tryAgent("hi"), { text: "answer from claude", agent: "Claude", wouldAskToConfirm: [] });
  assert.equal(hits.filter((h) => h.url.includes("chat/completions")).length, 0, "Claude does not go through the other adapter");

  await service.save({ activeAgentId: "gem00001" });
  const r = await service.tryAgent("hi");
  assert.equal(r.text, "answer from gemini");
  const call = hits.find((h) => h.url.includes("googleapis"));
  assert.equal(call.url, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
  assert.equal(call.auth, `Bearer ${GEMINI}`);
  assert.equal(call.model, "gemini-2.5-flash");

  assert.equal((await service.tryAgent("hi", "oai00001")).text, "answer from openai", "any agent can be tried by id");
  assert.equal(hits.find((h) => h.url.includes("openai.com")).auth, `Bearer ${OPENAI}`);
  const local = await service.tryAgent("hi", "loc00001");
  assert.equal(local.text, "answer from local");
  assert.equal(hits.find((h) => h.url.startsWith("http://127.0.0.1:11434")).auth, undefined, "no key, no Authorization header");
  await assert.rejects(service.tryAgent("hi", "ghost"), /unknown agent/);
});

test("an agent without its key says so instead of failing strangely", async () => {
  const { service } = world();
  await threeAgents(service);
  await service.save({ activeAgentId: "gem00001" });
  await assert.rejects(service.tryAgent("hi"), /agent "Gemini" has no API key yet/);
});

test("a key from the server's environment is used for that provider's agents", async () => {
  const { store, hits, fetchFn } = world();
  const service = new AgentService({ store, env: { APP_PASSWORD: "pw", GEMINI_API_KEY: "env-gemini-key-123456" }, getApi: () => async () => ({}), fetchFn, vault: new SecretVault({ store, passphrase: "pw", env: { GEMINI_API_KEY: "env-gemini-key-123456" } }) });
  await service.init();
  await service.save({ agents: [agentDef({ id: "gem00001" })], activeAgentId: "gem00001" });
  assert.deepEqual(service.status().agents[0].key, { set: true, source: "environment", hint: null });
  assert.equal((await service.tryAgent("hi")).text, "answer from gemini");
  assert.equal(hits.at(-1).auth, "Bearer env-gemini-key-123456");
});

test("removing an agent removes its key; the first agent keeps the key it had before there were several", async () => {
  const { service, store } = world();
  await threeAgents(service);
  await service.saveSecrets({ agents: { default: CLAUDE, gem00001: GEMINI } });
  const saved = await store.getSetting("agent_secrets");
  assert.deepEqual(Object.keys(saved).sort(), ["agent_gem00001", "anthropic"]);
  await service.save({ agents: [DEFAULT_AGENT] });
  assert.deepEqual(Object.keys(await store.getSetting("agent_secrets")), ["anthropic"]);
  assert.equal(service.status().agents.length, 1);
});

test("old settings with a single model load as one agent and keep their key", async () => {
  const { service, store } = world();
  await store.setSetting("agent_config", { enabled: false, model: "claude-sonnet-5-5", effort: "high", allowedUserIds: ["424242"], instructions: "be brief" });
  await new SecretVault({ store, passphrase: "pw", env: {} }).set("anthropic", CLAUDE);
  await service.init();
  const status = service.status();
  assert.deepEqual(status.agents.map((a) => [a.id, a.model]), [["default", "claude-sonnet-5-5"]]);
  assert.equal(status.agents[0].key.set, true);
  assert.equal(status.config.instructions, "be brief");
});

test("changing the agents is written to the activity log", async () => {
  const { service } = world();
  await threeAgents(service);
  await service.save({ activeAgentId: "gem00001" });
  const log = service.status().log.map((e) => e.detail).join("\n");
  assert.match(log, /agents: Claude, Gemini, GPT, Local/);
  assert.match(log, /activeAgentId=gem00001/);
});

// ---------- switching from Telegram ----------

test("/agent lists the agents, switches one chat without touching the others, and refuses one with no key", async () => {
  const { service } = world();
  await threeAgents(service);
  await service.saveSecrets({ agents: { default: CLAUDE, gem00001: GEMINI } });
  const control = service.agentsControl();
  assert.deepEqual(control.list("chatA").map((a) => [a.name, a.active, a.ready]), [["Claude", true, true], ["Gemini", false, true], ["GPT", false, false], ["Local", false, true]]);
  assert.equal(control.select("chatA", "gemini").ok, true);
  assert.equal(control.list("chatA").find((a) => a.active).name, "Gemini");
  assert.equal(control.list("chatB").find((a) => a.active).name, "Claude", "another chat is unaffected");
  assert.match(control.select("chatA", "gpt").text, /no API key yet/);
  assert.match(control.select("chatA", "nobody").text, /no agent called/);
  assert.match(control.select("chatA", "").text, /matches several|no agent/);
  assert.equal(control.select("chatA", "default").ok, true, "an id works too");
  assert.equal(control.list("chatA").find((a) => a.active).name, "Claude");
  // and the chosen agent is the one that answers that chat
  control.select("chatA", "Gemini");
  assert.equal((await service.agent.reply("chatA", "hi")).text, "answer from gemini");
  assert.equal((await service.agent.reply("chatB", "hi")).text, "answer from claude");
});

test("the Telegram /agent command lists, switches and explains", async () => {
  const sent = [];
  const fetchFn = async (url, init = {}) => { const m = String(url).split("/").pop(); if (m === "sendMessage") sent.push(JSON.parse(init.body).text); return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }); };
  const control = { list: () => [{ id: "default", name: "Claude", provider: "Anthropic (Claude)", model: "claude-opus-5-5", active: true, ready: true }, { id: "g", name: "Gemini", provider: "Google Gemini", model: "gemini-2.5-flash", active: false, ready: false }], select: (chat, q) => ({ ok: true, text: `switched to ${q} in ${chat}` }) };
  const make = (agents) => new TelegramBot({ token: "T", agent: { reply: async () => ({ text: "x", proposals: [] }) }, stt: { configured: false }, getConfig: async () => ({ enabled: true, voice: {} }), allowedIds: () => new Set(["5"]), fetchFn, agents });
  const msg = (text) => ({ update_id: 1, message: { message_id: 1, chat: { id: 5, type: "private" }, from: { id: 5, is_bot: false }, text } });

  const bot = make(control);
  await bot.handleUpdate(msg("/agent"));
  assert.match(sent.at(-1), /▶ Claude — Anthropic \(Claude\), claude-opus-5-5/);
  assert.match(sent.at(-1), /• Gemini — Google Gemini, gemini-2\.5-flash \(no key yet\)/);
  assert.match(sent.at(-1), /\/agent Claude/);
  await bot.handleUpdate(msg("/agent gemini"));
  assert.equal(sent.at(-1), "switched to gemini in 5");
  await make(null).handleUpdate(msg("/agent"));
  assert.match(sent.at(-1), /Only one agent/);
});
