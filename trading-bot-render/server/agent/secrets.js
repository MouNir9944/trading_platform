/**
 * Keys you paste on the Agent page: the Telegram bot token, the speech-to-text key, and one API key per agent.
 *
 * They are write-only: once saved the page can say a key is set and show its last four characters, but nothing can read
 * it back. In the database each key is encrypted (AES-256-GCM) with a key derived from the dashboard password, so a copy
 * of the database alone does not reveal them. The consequence: if you change APP_PASSWORD the saved keys can no longer
 * be opened, and you paste them again.
 *
 * An environment variable (TELEGRAM_BOT_TOKEN, STT_API_KEY, and the provider's own such as ANTHROPIC_API_KEY or
 * GEMINI_API_KEY) is still honoured as a fallback; a key saved on the page wins over it.
 *
 * Names: "telegram", "speech", "anthropic" (the first agent's key, kept from before agents existed) and "agent_<id>".
 */
import crypto from "node:crypto";

const bad = (message) => Object.assign(new Error(message), { httpStatus: 400 });

/** What each secret looks like, so a typo is caught here instead of as a confusing failure later. */
export const SECRETS = {
  telegram: { env: "TELEGRAM_BOT_TOKEN", label: "Telegram bot token", pattern: /^\d{6,12}:[A-Za-z0-9_-]{30,}$/, hint: "It looks like 123456789:AAH… and comes from @BotFather." },
  anthropic: { env: "ANTHROPIC_API_KEY", label: "Claude API key", pattern: /^sk-ant-[A-Za-z0-9_-]{20,}$/, hint: "It starts with sk-ant- and comes from console.anthropic.com." },
  speech: { env: "STT_API_KEY", label: "Speech-to-text key", pattern: /^\S{8,200}$/, hint: "The key of your speech-to-text service (OpenAI, Groq, …)." },
};

const SETTING = "agent_secrets";
const NAME = /^(telegram|anthropic|speech|agent_[a-z0-9]{4,12})$/;
export const isKeyName = (name) => NAME.test(String(name));
const derive = (passphrase, salt) => crypto.scryptSync(passphrase, salt, 32);

function seal(value, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", derive(passphrase, salt), iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { salt: salt.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64"), hint: value.slice(-4) };
}

function open(record, passphrase) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", derive(passphrase, Buffer.from(record.salt, "base64")), Buffer.from(record.iv, "base64"));
  decipher.setAuthTag(Buffer.from(record.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(record.data, "base64")), decipher.final()]).toString("utf8");
}

export class SecretVault {
  /**
   * @param store       getSetting / setSetting
   * @param passphrase  what the encryption key comes from (the dashboard password); without one nothing can be saved
   * @param env         the environment, for the fallback
   */
  constructor({ store, passphrase = "", env = process.env }) {
    this.store = store;
    this.passphrase = passphrase;
    this.env = env;
    this.records = {};
    this.values = {};
    this.unreadable = new Set();
    this.queue = Promise.resolve();
  }

  async load() {
    const saved = await this.store.getSetting(SETTING);
    this.records = saved && typeof saved === "object" ? saved : {};
    this.values = {};
    this.unreadable = new Set();
    for (const [name, record] of Object.entries(this.records)) {
      if (!isKeyName(name)) continue;
      try { this.values[name] = open(record, this.passphrase); } catch { this.unreadable.add(name); } // the password changed
    }
  }

  /** The key to use: the one saved on the page, else the environment's (`envName`), else "". */
  get(name, envName = SECRETS[name]?.env) {
    return this.values[name] || (envName ? this.env[envName] : "") || "";
  }

  /** Safe to show: never the key itself. */
  describe(name, envName = SECRETS[name]?.env) {
    if (this.values[name]) return { set: true, source: "page", hint: `…${this.records[name].hint}` };
    if (this.unreadable.has(name)) return { set: false, source: "unreadable", hint: null };
    if (envName && this.env[envName]) return { set: true, source: "environment", hint: null };
    return { set: false, source: null, hint: null };
  }

  /** Save a key (or remove it when `value` is empty or null). `spec` ({ label, pattern, hint }) says what a valid one looks like. */
  set(name, value, spec = SECRETS[name]) {
    const clear = value == null || value === "";
    if (!isKeyName(name) || (!clear && !spec)) return Promise.reject(bad(`unknown key ${name}`)); // removing a key needs no format
    const text = clear ? "" : String(value).trim();
    if (!clear) {
      if (!this.passphrase) return Promise.reject(bad("Set APP_PASSWORD on the server first: keys saved here are encrypted with it."));
      if (!spec.pattern.test(text)) return Promise.reject(bad(`That does not look like a ${spec.label}. ${spec.hint}`));
    }
    const run = this.queue.then(async () => {
      if (clear) { delete this.records[name]; delete this.values[name]; this.unreadable.delete(name); }
      else { this.records[name] = seal(text, this.passphrase); this.values[name] = text; this.unreadable.delete(name); }
      await this.store.setSetting(SETTING, this.records);
    });
    this.queue = run.catch(() => {});
    return run;
  }
}
