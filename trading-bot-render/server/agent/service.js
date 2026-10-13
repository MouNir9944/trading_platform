/**
 * The agent as the rest of the server sees it: settings you can edit on the Agent page, the Telegram bot's lifecycle,
 * a status the page can show, and a log of what the agent did.
 *
 * Settings (non-secret) live in the store and are edited from the page. Secrets never do: the bot token, the Claude API
 * key and the speech-to-text key come from environment variables, and the page only ever learns whether each is set.
 *
 *   TELEGRAM_BOT_TOKEN          from @BotFather (also used for notifications)
 *   ANTHROPIC_API_KEY           the Claude API key
 *   STT_API_KEY                 speech-to-text key for voice messages (see stt.js)
 *   TELEGRAM_ALLOWED_USER_IDS   optional, comma separated: extra allowed Telegram user IDs
 */
import Anthropic from "@anthropic-ai/sdk";

import { Agent } from "./agent.js";
import { SECRETS, SecretVault } from "./secrets.js";
import { createStt } from "./stt.js";
import { TOOLS, ToolError, offeredTools } from "./tools.js";
import { TelegramBot } from "./telegram.js";

const MAX_AUDIT = 200;
const bad = (message) => Object.assign(new Error(message), { httpStatus: 400 });

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", note: "Most capable. Best judgement for trading questions. The default." },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", note: "Faster and cheaper, still strong." },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", note: "Cheapest and quickest, for simple lookups." },
];

export const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  model: "claude-opus-5-5",
  effort: "medium",
  instructions: "",
  allowedUserIds: [],
  allowTrading: false,
  allowLive: false,
  tools: {},
  voice: { enabled: true, language: "" },
});

/**
 * Merge `patch` over `current` and validate the result. `patch` may be partial. Turning on live trading from chat needs
 * the word LIVE in `patch.confirmLive`, the same deliberate step the platform asks for before arming a bot on a live account.
 */
export function normalizeConfig(patch = {}, current = DEFAULT_CONFIG) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw bad("settings must be an object");
  const next = { ...DEFAULT_CONFIG, ...current, voice: { ...DEFAULT_CONFIG.voice, ...current.voice }, tools: { ...current.tools } };
  const bool = (key, from = patch) => { if (from[key] !== undefined) { if (typeof from[key] !== "boolean") throw bad(`${key} must be true or false`); return from[key]; } return undefined; };

  for (const key of ["enabled", "allowTrading", "allowLive"]) { const v = bool(key); if (v !== undefined) next[key] = v; }
  if (patch.model !== undefined) {
    if (typeof patch.model !== "string" || !/^claude-[a-z0-9.\-]{3,40}$/.test(patch.model)) throw bad("model must be a Claude model id such as claude-opus-5-5");
    next.model = patch.model;
  }
  if (patch.effort !== undefined) {
    if (!["low", "medium", "high"].includes(patch.effort)) throw bad("effort must be low, medium or high");
    next.effort = patch.effort;
  }
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
    this.client = null;
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
      getClient: () => this.#client(),
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
      try { this.config = normalizeConfig({ ...saved, confirmLive: "LIVE" }, DEFAULT_CONFIG); } catch { this.config = { ...DEFAULT_CONFIG }; }
    }
    const log = await this.store.getSetting("agent_audit");
    this.log = Array.isArray(log) ? log.slice(-MAX_AUDIT) : [];
  }

  #client() {
    if (this.injectedClient) return this.injectedClient;
    const apiKey = this.vault.get("anthropic");
    if (!apiKey) throw new ToolError("No Claude API key yet: add it on the AI agent page.");
    if (this.client?.key !== apiKey) this.client = { key: apiKey, sdk: new Anthropic({ apiKey }) };
    return this.client.sdk;
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

  /** For each key: is it set, where from, and its last four characters. Never the key. */
  secrets() {
    const out = Object.fromEntries(Object.keys(SECRETS).map((name) => [name, this.vault.describe(name)]));
    if (!out.speech.set && this.env.OPENAI_API_KEY) out.speech = { set: true, source: "environment", hint: null };
    return out;
  }

  status() {
    return {
      config: this.config,
      secrets: this.secrets(),
      speech: { model: this.stt.model, service: this.stt.base },
      secretLabels: Object.fromEntries(Object.entries(SECRETS).map(([name, s]) => [name, { label: s.label, hint: s.hint, env: s.env }])),
      canStoreKeys: Boolean(this.env.APP_PASSWORD),
      bot: { running: Boolean(this.bot?.running), username: this.bot?.username ?? null, error: this.bot?.error ?? this.lastError, startedAt: this.bot?.startedAt ?? null },
      pendingConfirmations: this.agent.pendingCount(),
      allowedCount: this.allowedIds().size,
      offeredTools: offeredTools(this.config).map((t) => t.name),
      tools: TOOLS.map((t) => ({ name: t.name, kind: t.kind, description: t.description })),
      models: MODELS,
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
    if (!this.vault.get("anthropic") && !this.injectedClient) { this.lastError = "Add your Claude API key first."; return; }
    if (this.allowedIds().size === 0) { this.lastError = "Add your Telegram user ID first: nobody is allowed to talk to the bot yet."; return; }
    const bot = new TelegramBot({
      token, agent: this.agent, stt: this.stt, getConfig: async () => this.config,
      allowedIds: () => this.allowedIds(), audit: (e) => this.audit(e), fetchFn: this.fetchFn, now: this.now,
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
    const changes = ["allowTrading", "allowLive", "enabled", "model"].filter((k) => next[k] !== this.config[k]);
    this.config = next;
    await this.store.setSetting("agent_config", next);
    if (changes.length) this.audit({ type: "settings", detail: `changed: ${changes.map((k) => `${k}=${next[k]}`).join(", ")}` });
    await this.restart();
    return this.status();
  }

  /**
   * Save, replace or remove keys: `{ telegram?, anthropic?, speech? }`, each a string (set) or "" / null (remove).
   * The keys are never returned; the status only says whether each is set.
   */
  async saveSecrets(patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw bad("send the keys as an object");
    const names = Object.keys(patch);
    if (!names.length) throw bad("no key was given");
    for (const name of names) if (!SECRETS[name]) throw bad(`unknown key ${name}`);
    for (const name of names) await this.vault.set(name, patch[name]);
    this.audit({ type: "settings", detail: names.map((n) => `${SECRETS[n].label} ${patch[n] ? "saved" : "removed"}`).join(", ") });
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
  async tryAgent(text) {
    if (typeof text !== "string" || !text.trim()) throw bad("Write something to ask.");
    const answer = await this.agent.reply("page-test", text.slice(0, 2000), { user: null });
    for (const p of answer.proposals) this.agent.proposals.delete(p.id); // a page test never leaves an order waiting
    this.agent.clear("page-test");
    return { text: answer.text, wouldAskToConfirm: answer.proposals.map((p) => p.summary) };
  }
}
