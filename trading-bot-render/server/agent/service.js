/**
 * The agent as the rest of the server sees it: settings you can edit on the Agent page, the Telegram bot's lifecycle,
 * a status the page can show, and a log of what the agent did.
 *
 * You can set up several agents, each with its own provider (Claude, Gemini, OpenAI, Groq, Ollama, ...), model and API key.
 * One is active; Telegram's /agent command switches it for a chat. The safety rules (what tools exist, that orders need a
 * confirmation, the live-account switch) belong to the platform, not to an agent, so they are the same for every one.
 *
 * Settings (non-secret) live in the store and are edited from the page. Keys are write-only: saved encrypted (secrets.js)
 * or taken from environment variables, and the page only ever learns whether each is set.
 *
 *   TELEGRAM_BOT_TOKEN          from @BotFather (also used for notifications)
 *   ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY, GROQ_API_KEY, ...   a provider's key, used by its agents
 *   STT_API_KEY                 speech-to-text key for voice messages (see stt.js)
 *   TELEGRAM_ALLOWED_USER_IDS   optional, comma separated: extra allowed Telegram user IDs
 */
import crypto from "node:crypto";

import Anthropic from "@anthropic-ai/sdk";

import { Agent } from "./agent.js";
import { PROVIDERS, anthropicCaller, compatCaller } from "./models.js";
import { SECRETS, SecretVault } from "./secrets.js";
import { createStt } from "./stt.js";
import { TOOLS, ToolError, offeredTools } from "./tools.js";
import { TelegramBot } from "./telegram.js";

const MAX_AUDIT = 200;
const bad = (message) => Object.assign(new Error(message), { httpStatus: 400 });

export const MAX_AGENTS = 6;
/** The first agent. Its key is stored under the name "anthropic", as it was before there could be several. */
export const DEFAULT_AGENT = Object.freeze({ id: "default", name: "Claude", provider: "anthropic", model: "claude-opus-5-5", baseUrl: "", effort: "medium" });

export const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  agents: [DEFAULT_AGENT],
  activeAgentId: "default",
  instructions: "",
  allowedUserIds: [],
  allowTrading: false,
  allowLive: false,
  tools: {},
  voice: { enabled: true, language: "" },
});

function normalizeAgent(raw, seen) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad("each agent must be an object");
  const provider = raw.provider;
  const spec = PROVIDERS[provider];
  if (!spec) throw bad(`unknown provider ${String(provider).slice(0, 30)}`);
  const id = raw.id === undefined || raw.id === "" ? crypto.randomBytes(5).toString("hex") : String(raw.id);
  if (!/^(default|[a-z0-9]{4,12})$/.test(id)) throw bad("an agent id is 4 to 12 lowercase letters or digits");
  if (seen.has(id)) throw bad("two agents have the same id");
  seen.add(id);
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name || name.length > 40) throw bad("each agent needs a name of up to 40 characters");
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@\-]{0,99}$/.test(model)) throw bad(`the model name for "${name}" is missing or has unusual characters`);
  let baseUrl = "";
  if (spec.customUrl) {
    const given = typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : "";
    if (given) {
      let url;
      try { url = new URL(given); } catch { throw bad(`the address for "${name}" is not a valid web address`); }
      if (!/^https?:$/.test(url.protocol) || given.length > 200) throw bad(`the address for "${name}" must start with http:// or https://`);
      baseUrl = given.replace(/\/+$/, "");
    } else if (spec.urlRequired) throw bad(`"${name}" needs the address of the server`);
  }
  const effort = spec.efforts && ["low", "medium", "high"].includes(raw.effort) ? raw.effort : "medium";
  return { id, name, provider, model, baseUrl, effort };
}

/** A configuration saved before there could be several agents had one `model` and `effort`: they become the first agent. */
export function migrateConfig(saved) {
  if (!saved || typeof saved !== "object" || Array.isArray(saved.agents)) return saved;
  const { model, effort, ...rest } = saved;
  return { ...rest, agents: [{ ...DEFAULT_AGENT, ...(typeof model === "string" && model ? { model } : {}), ...(effort ? { effort } : {}) }], activeAgentId: "default" };
}

/**
 * Merge `patch` over `current` and validate the result. `patch` may be partial. Turning on live trading from chat needs
 * the word LIVE in `patch.confirmLive`, the same deliberate step the platform asks for before arming a bot on a live account.
 */
export function normalizeConfig(patch = {}, current = DEFAULT_CONFIG) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw bad("settings must be an object");
  const next = { ...DEFAULT_CONFIG, ...current, agents: (current.agents ?? DEFAULT_CONFIG.agents).map((a) => ({ ...a })), voice: { ...DEFAULT_CONFIG.voice, ...current.voice }, tools: { ...current.tools } };
  const bool = (key, from = patch) => { if (from[key] !== undefined) { if (typeof from[key] !== "boolean") throw bad(`${key} must be true or false`); return from[key]; } return undefined; };

  for (const key of ["enabled", "allowTrading", "allowLive"]) { const v = bool(key); if (v !== undefined) next[key] = v; }
  if (patch.agents !== undefined) {
    if (!Array.isArray(patch.agents) || patch.agents.length < 1 || patch.agents.length > MAX_AGENTS) throw bad(`you need between 1 and ${MAX_AGENTS} agents`);
    const seen = new Set();
    next.agents = patch.agents.map((a) => normalizeAgent(a, seen));
  }
  if (patch.activeAgentId !== undefined) {
    if (!next.agents.some((a) => a.id === patch.activeAgentId)) throw bad("the active agent must be one of the agents");
    next.activeAgentId = patch.activeAgentId;
  } else if (!next.agents.some((a) => a.id === next.activeAgentId)) next.activeAgentId = next.agents[0].id;
  if (patch.instructions !== undefined) {
    if (typeof patch.instructions !== "string") throw bad("instructions must be text");
    if (patch.instructions.length > 2000) throw bad("instructions can be at most 2000 characters");
    next.instructions = patch.instructions.trim();
  }
  if (patch.allowedUserIds !== undefined) {
    if (!Array.isArray(patch.allowedUserIds) || patch.allowedUserIds.length > 10) throw bad("allowedUserIds must be a list of at most 10 Telegram user IDs");
    const ids = patch.allowedUserIds.map((x) => String(x).trim());
    if (ids.some((x) => !/^\d{3,15}$/.test(x))) throw bad("a Telegram user ID is a number such as 123456789");
    next.allowedUserIds = [...new Set(ids)];
  }
  if (patch.tools !== undefined) {
    if (!patch.tools || typeof patch.tools !== "object" || Array.isArray(patch.tools)) throw bad("tools must be an object");
    const known = new Set(TOOLS.map((t) => t.name));
    next.tools = {};
    for (const [name, on] of Object.entries(patch.tools)) {
      if (!known.has(name)) throw bad(`unknown tool ${name}`);
      if (typeof on !== "boolean") throw bad(`tools.${name} must be true or false`);
      if (on === false) next.tools[name] = false; // only the switched-off ones are stored
    }
  }
  if (patch.voice !== undefined) {
    if (!patch.voice || typeof patch.voice !== "object") throw bad("voice must be an object");
    const v = bool("enabled", patch.voice);
    if (v !== undefined) next.voice.enabled = v;
    if (patch.voice.language !== undefined) {
      if (typeof patch.voice.language !== "string" || !/^([a-z]{2,3}(-[A-Za-z]{2,4})?)?$/.test(patch.voice.language)) throw bad("voice language must be a code such as en or fr");
      next.voice.language = patch.voice.language;
    }
  }
  if (next.allowLive && !current.allowLive && patch.confirmLive !== "LIVE") throw bad('Allowing orders on the live account needs the word LIVE typed to confirm it.');
  if (next.allowLive && !next.allowTrading) next.allowLive = false; // live trading only means anything with trading on
  return next;
}

export class AgentService {
  /**
   * @param store      getSetting / setSetting
   * @param env        process.env
   * @param getApi     () => (method, path, body) => json, the platform's own API (loopback)
   * @param fetchFn    fetch, replaceable in tests
   * @param anthropic  optional ready-made client (tests)
   */
  constructor({ store, env = process.env, getApi, fetchFn = fetch, anthropic = null, vault = null, now = Date.now }) {
    const self = this;
    this.store = store;
    this.env = env;
    this.getApi = getApi;
    this.fetchFn = fetchFn;
    this.injectedClient = anthropic;
    this.now = now;
    this.config = { ...DEFAULT_CONFIG };
    this.log = [];
    this.bot = null;
    this.lastError = null;
    this.client = null; // the Claude SDK client, kept for the key it was made with
    this.fallbackState = { fallbackOff: false };
    this.chatAgent = new Map(); // chat -> the agent chosen there with /agent
    this.vault = vault ?? new SecretVault({ store, passphrase: env.APP_PASSWORD ?? "", env });
    this.sttCache = { key: null, stt: null };
    // The bot keeps this object, so it always speaks to whichever speech key is current.
    this.stt = {
      get configured() { return self.speechService().configured; },
      get model() { return self.speechService().model; },
      get base() { return self.speechService().base; },
      transcribe: (...args) => self.speechService().transcribe(...args),
    };
    this.writeTimer = null;
    this.agent = new Agent({
      getAgent: async (sessionId, agentId) => this.resolveAgent(sessionId, agentId),
      getConfig: async () => this.config,
      api: (...args) => this.getApi()(...args),
      now,
      audit: (entry) => this.audit(entry),
    });
  }

  async init() {
    await this.vault.load();
    const saved = await this.store.getSetting("agent_config");
    if (saved && typeof saved === "object") {
      // what is saved was already confirmed when it was saved (including the word LIVE), so it is not asked for again
      try { this.config = normalizeConfig({ ...migrateConfig(saved), confirmLive: "LIVE" }, DEFAULT_CONFIG); } catch { this.config = { ...DEFAULT_CONFIG }; }
    }
    const log = await this.store.getSetting("agent_audit");
    this.log = Array.isArray(log) ? log.slice(-MAX_AUDIT) : [];
  }

  /** Where an agent's API key is kept. The first agent keeps the name it had before there could be several. */
  agentKeyName(agent) {
    return agent.id === "default" ? "anthropic" : `agent_${agent.id}`;
  }

  agentKey(agent) {
    return this.vault.get(this.agentKeyName(agent), PROVIDERS[agent.provider].keyEnv);
  }

  /** Can this agent be used right now? (Some providers, like a local Ollama, need no key.) */
  agentReady(agent) {
    if (!PROVIDERS[agent.provider].needsKey) return true;
    return Boolean(this.agentKey(agent)) || (agent.provider === "anthropic" && Boolean(this.injectedClient));
  }

  /** The agent for a chat: the one chosen there with /agent, else the active one. An explicit unknown id is an error. */
  pickAgent(sessionId, agentId) {
    const agents = this.config.agents;
    if (agentId !== undefined) {
      const given = agents.find((a) => a.id === agentId);
      if (!given) throw bad("unknown agent");
      return given;
    }
    const wanted = (sessionId != null && this.chatAgent.get(sessionId)) || this.config.activeAgentId;
    return agents.find((a) => a.id === wanted) ?? agents.find((a) => a.id === this.config.activeAgentId) ?? agents[0];
  }

  /** The model to talk to for this chat, as `{ id, name, call }` (see models.js). Throws a clear error when it has no key yet. */
  resolveAgent(sessionId, agentId) {
    const agent = this.pickAgent(sessionId, agentId);
    const spec = PROVIDERS[agent.provider];
    const apiKey = this.agentKey(agent);
    if (!this.agentReady(agent)) throw new ToolError(`The agent "${agent.name}" has no API key yet: add it on the AI agent page.`);
    if (agent.provider === "anthropic") {
      if (!this.injectedClient && this.client?.key !== apiKey) this.client = { key: apiKey, sdk: new Anthropic({ apiKey }) };
      const client = this.injectedClient ?? this.client.sdk;
      return { id: agent.id, name: agent.name, call: anthropicCaller({ client, model: agent.model, effort: agent.effort, onNote: (detail) => this.audit({ type: "note", detail }), state: this.fallbackState }) };
    }
    return { id: agent.id, name: agent.name, call: compatCaller({ baseUrl: agent.baseUrl || spec.baseUrl, apiKey, model: agent.model, label: spec.label, fetchFn: this.fetchFn }) };
  }

  /** What the bot's /agent command needs: the list of agents, and a way to choose one for a chat. */
  agentsControl() {
    return {
      list: (sessionId) => {
        const current = this.pickAgent(sessionId).id;
        return this.config.agents.map((a) => ({ id: a.id, name: a.name, provider: PROVIDERS[a.provider].label, model: a.model, active: a.id === current, ready: this.agentReady(a) }));
      },
      select: (sessionId, query) => {
        const q = String(query).trim().toLowerCase();
        const agents = this.config.agents;
        const matches = agents.filter((a) => a.id === q || a.name.toLowerCase() === q);
        const found = matches.length ? matches : agents.filter((a) => a.name.toLowerCase().includes(q));
        if (found.length !== 1) return { ok: false, text: found.length ? `"${query}" matches several agents: ${found.map((a) => a.name).join(", ")}. Be more specific.` : `There is no agent called "${query}". Send /agent to see them.` };
        if (!this.agentReady(found[0])) return { ok: false, text: `${found[0].name} has no API key yet. Add it on the AI agent page.` };
        this.chatAgent.set(sessionId, found[0].id);
        return { ok: true, text: `Now talking to ${found[0].name} (${found[0].model}).` };
      },
    };
  }

  /** The speech-to-text service for the key in use now (rebuilt only when the key changes). */
  speechService() {
    const key = this.vault.get("speech") || this.env.OPENAI_API_KEY || ""; // OPENAI_API_KEY is the older fallback
    if (this.sttCache.key !== key || !this.sttCache.stt) this.sttCache = { key, stt: createStt({ env: { ...this.env, STT_API_KEY: key, OPENAI_API_KEY: "" }, fetchFn: this.fetchFn }) };
    return this.sttCache.stt;
  }

  /** Every Telegram user ID allowed to talk to the bot: the settings, plus the environment. */
  allowedIds() {
    const ids = new Set(this.config.allowedUserIds.map(String));
    for (const x of String(this.env.TELEGRAM_ALLOWED_USER_IDS ?? "").split(",")) if (/^\d{3,15}$/.test(x.trim())) ids.add(x.trim());
    return ids;
  }

  audit(entry) {
    this.log.push({ at: this.now(), ...entry });
    if (this.log.length > MAX_AUDIT) this.log.splice(0, this.log.length - MAX_AUDIT);
    if (!this.writeTimer) {
      this.writeTimer = setTimeout(() => { this.writeTimer = null; this.store.setSetting("agent_audit", this.log).catch(() => {}); }, 1500);
      this.writeTimer.unref?.();
    }
  }

  async flush() {
    if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = null; }
    await this.store.setSetting("agent_audit", this.log).catch(() => {});
  }

  /** For the Telegram and speech keys: is it set, where from, and its last four characters. Never the key. */
  secrets() {
    const out = Object.fromEntries(["telegram", "speech"].map((name) => [name, this.vault.describe(name)]));
    if (!out.speech.set && this.env.OPENAI_API_KEY) out.speech = { set: true, source: "environment", hint: null };
    return out;
  }

  status() {
    return {
      config: this.config,
      secrets: this.secrets(),
      speech: { model: this.stt.model, service: this.stt.base },
      secretLabels: Object.fromEntries(["telegram", "speech"].map((name) => [name, { label: SECRETS[name].label, hint: SECRETS[name].hint, env: SECRETS[name].env }])),
      agents: this.config.agents.map((a) => {
        const spec = PROVIDERS[a.provider];
        const key = this.vault.describe(this.agentKeyName(a), spec.keyEnv);
        return { id: a.id, name: a.name, provider: a.provider, model: a.model, active: a.id === this.config.activeAgentId, key: !spec.needsKey && !key.set ? { set: true, source: "none", hint: null, optional: true } : key };
      }),
      providers: Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => [id, { label: p.label, needsKey: p.needsKey, keyHint: p.keyHint, keyEnv: p.keyEnv, baseUrl: p.baseUrl ?? "", defaultModel: p.defaultModel, examples: p.examples, efforts: Boolean(p.efforts), customUrl: Boolean(p.customUrl), urlRequired: Boolean(p.urlRequired) }])),
      maxAgents: MAX_AGENTS,
      canStoreKeys: Boolean(this.env.APP_PASSWORD),
      bot: { running: Boolean(this.bot?.running), username: this.bot?.username ?? null, error: this.bot?.error ?? this.lastError, startedAt: this.bot?.startedAt ?? null },
      pendingConfirmations: this.agent.pendingCount(),
      allowedCount: this.allowedIds().size,
      offeredTools: offeredTools(this.config).map((t) => t.name),
      tools: TOOLS.map((t) => ({ name: t.name, kind: t.kind, description: t.description })),
      log: this.log.slice(-60).reverse(),
    };
  }

  /** Start (or restart) the bot from the current settings. Never throws: the reason it is not running goes in `status()`. */
  async restart() {
    this.bot?.stop();
    this.bot = null;
    this.lastError = null;
    const c = this.config;
    if (!c.enabled) return;
    const token = this.vault.get("telegram");
    if (!token) { this.lastError = "Add your Telegram bot token first."; return; }
    const active = this.pickAgent(null);
    if (!this.agentReady(active)) { this.lastError = `Add the API key for the agent "${active.name}" first.`; return; }
    if (this.allowedIds().size === 0) { this.lastError = "Add your Telegram user ID first: nobody is allowed to talk to the bot yet."; return; }
    const bot = new TelegramBot({
      token, agent: this.agent, stt: this.stt, getConfig: async () => this.config,
      allowedIds: () => this.allowedIds(), audit: (e) => this.audit(e), fetchFn: this.fetchFn, now: this.now, agents: this.agentsControl(),
    });
    this.bot = bot;
    try {
      await bot.start();
      this.audit({ type: "started", detail: `@${bot.username ?? "bot"}` });
    } catch (err) {
      this.lastError = err.message;
      this.audit({ type: "error", detail: `could not start: ${err.message}` });
    }
  }

  stop() {
    this.bot?.stop();
  }

  async save(patch) {
    const next = normalizeConfig(patch, this.config);
    const changes = ["allowTrading", "allowLive", "enabled", "activeAgentId"].filter((k) => next[k] !== this.config[k]).map((k) => `${k}=${next[k]}`);
    if (JSON.stringify(next.agents) !== JSON.stringify(this.config.agents)) changes.push(`agents: ${next.agents.map((a) => a.name).join(", ")}`);
    const removed = this.config.agents.filter((a) => !next.agents.some((b) => b.id === a.id));
    this.config = next;
    await this.store.setSetting("agent_config", next);
    for (const a of removed) await this.vault.set(this.agentKeyName(a), "").catch(() => {}); // a removed agent's key goes with it
    if (changes.length) this.audit({ type: "settings", detail: `changed: ${changes.join(", ")}` });
    await this.restart();
    return this.status();
  }

  /**
   * Save, replace or remove keys: `{ telegram?, speech?, agents?: { [agentId]: key } }`, each a string (set) or "" / null
   * (remove). The keys are never returned; the status only says whether each is set.
   */
  async saveSecrets(patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw bad("send the keys as an object");
    for (const name of Object.keys(patch)) if (!["telegram", "speech", "agents"].includes(name)) throw bad(`unknown key ${name}`);
    if (patch.agents !== undefined && (!patch.agents || typeof patch.agents !== "object" || Array.isArray(patch.agents))) throw bad("agents must map an agent id to its key");
    const jobs = [];
    for (const name of ["telegram", "speech"]) if (name in patch) jobs.push({ name, value: patch[name], spec: SECRETS[name], label: SECRETS[name].label });
    for (const [id, value] of Object.entries(patch.agents ?? {})) {
      const agent = this.config.agents.find((a) => a.id === id);
      if (!agent) throw bad(`unknown agent ${id}`);
      const spec = PROVIDERS[agent.provider];
      jobs.push({ name: this.agentKeyName(agent), value, spec: { label: `${agent.name} API key`, pattern: spec.keyPattern, hint: spec.keyHint }, label: `${agent.name} API key` });
    }
    if (!jobs.length) throw bad("no key was given");
    for (const job of jobs) await this.vault.set(job.name, job.value, job.spec);
    this.audit({ type: "settings", detail: jobs.map((j) => `${j.label} ${j.value ? "saved" : "removed"}`).join(", ") });
    await this.restart();
    return this.status();
  }

  /** Send a message to the first allowed user, so the owner can see the bot is wired up. */
  async testTelegram() {
    const token = this.vault.get("telegram");
    if (!token) throw bad("Add your Telegram bot token first.");
    const [id] = [...this.allowedIds()];
    if (!id) throw bad("Add your Telegram user ID first.");
    const res = await this.fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: id, text: "✅ Test message from your trading platform. The bot can reach you." }),
    }).catch((err) => { throw bad(`Could not reach Telegram (${err.cause?.code || err.message})`); });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      if (/can't initiate|blocked|not found|chat not found/i.test(data.description ?? "")) throw bad("Telegram would not deliver it. Open your bot in Telegram and press Start first, then try again.");
      throw bad(res.status === 401 ? "Telegram rejected the bot token." : data.description || `Telegram answered ${res.status}`);
    }
    return { sentTo: id };
  }

  /** Run a message through the agent without Telegram, to try it from the page. Orders are shown, never sent. */
  async tryAgent(text, agentId) {
    if (typeof text !== "string" || !text.trim()) throw bad("Write something to ask.");
    const session = `page-test-${agentId ?? "active"}`;
    const answer = await this.agent.reply(session, text.slice(0, 2000), { user: null, agentId: agentId || undefined });
    for (const p of answer.proposals) this.agent.proposals.delete(p.id); // a page test never leaves an order waiting
    this.agent.clear(session);
    return { text: answer.text, agent: answer.agent, wouldAskToConfirm: answer.proposals.map((p) => p.summary) };
  }
}
