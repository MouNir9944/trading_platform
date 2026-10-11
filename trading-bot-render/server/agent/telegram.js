/**
 * Telegram front end for the agent. Long polling, so it needs no public address or webhook and works behind any proxy.
 *
 * Who may talk to it: only the Telegram user IDs on the allowlist, and only in a private chat (never a group, where
 * anyone could read or answer). Anyone else gets one short reply with their own ID, which is how you find the number to
 * put on the list, and nothing else: no tools, no data.
 *
 * Orders: the agent only proposes. The bot shows the proposal with Confirm / Cancel buttons and runs it when the
 * allowlisted user taps Confirm.
 */
import { MAX_AUDIO_BYTES } from "./stt.js";

const POLL_SECONDS = 25;
const MAX_VOICE_SECONDS = 180;
const CHUNK = 3800; // Telegram allows 4096 characters per message
const RATE_LIMIT = { count: 30, windowMs: 10 * 60_000 };
const STRANGER_REPLY_EVERY_MS = 10 * 60_000;

const HELP = `I'm the assistant of your trading platform. Ask me in plain words, by text or voice:
• "what's the BTC price?"  • "analyze ETHUSDT on 4h"
• "what's my balance?"  • "show my open orders"
• "is NVDA worth a look? which phase is it in?"
• "add SOLUSDT to my favorites"

If you ask me to place an order I only propose it: nothing is sent until you press Confirm.

/clear forgets this conversation   /id shows your Telegram ID   /help shows this`;

/** Split a long answer on line breaks so each part fits in one Telegram message. */
export function splitMessage(text, size = CHUNK) {
  const out = [];
  let rest = String(text);
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}

export class TelegramBot {
  /**
   * @param token      the bot token (from @BotFather)
   * @param agent      an Agent
   * @param stt        { configured, transcribe }
   * @param getConfig  async () => agent settings
   * @param allowedIds () => Set<string> of every user ID allowed (settings plus environment)
   * @param audit      (entry) => void
   */
  constructor({ token, agent, stt, getConfig, allowedIds, audit = () => {}, fetchFn = fetch, now = Date.now }) {
    this.token = token;
    this.agent = agent;
    this.stt = stt;
    this.getConfig = getConfig;
    this.allowedIds = allowedIds;
    this.audit = audit;
    this.fetchFn = fetchFn;
    this.now = now;
    this.running = false;
    this.username = null;
    this.error = null;
    this.startedAt = null;
    this.offset = 0;
    this.abort = null;
    this.chains = new Map(); // one message at a time per user, in order
    this.recent = new Map(); // user -> timestamps, for the rate limit
    this.strangers = new Map(); // user -> when we last answered them
  }

  async #tg(method, body = {}, { signal } = {}) {
    let res;
    try {
      res = await this.fetchFn(`https://api.telegram.org/bot${this.token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new Error(`Could not reach Telegram (${err.cause?.code || err.message})`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      const reason = res.status === 401 ? "Telegram rejected the bot token" : data.description || `Telegram answered ${res.status}`;
      throw Object.assign(new Error(reason), { status: res.status, description: data.description });
    }
    return data.result;
  }

  async start() {
    if (this.running) return;
    try {
      const me = await this.#tg("getMe");
      this.username = me.username ?? null;
      await this.#tg("deleteWebhook", { drop_pending_updates: false }); // polling and a webhook cannot coexist
    } catch (err) {
      this.error = err.message;
      throw err;
    }
    this.error = null;
    this.running = true;
    this.startedAt = this.now();
    this.abort = new AbortController();
    this.#loop(this.abort.signal);
  }

  stop() {
    this.running = false;
    this.abort?.abort();
  }

  async #loop(signal) {
    let wait = 1000;
    while (this.running && !signal.aborted) {
      try {
        const updates = await this.#tg("getUpdates", { offset: this.offset, timeout: POLL_SECONDS, allowed_updates: ["message", "callback_query"] }, { signal });
        wait = 1000;
        this.error = null;
        for (const update of updates) {
          this.offset = update.update_id + 1;
          this.handleUpdate(update).catch((err) => this.audit({ type: "error", detail: String(err.message).slice(0, 200) }));
        }
      } catch (err) {
        if (signal.aborted || !this.running) return;
        this.error = err.message;
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 30_000);
      }
    }
  }

  /** Handle one update; updates from the same user run one after another. */
  handleUpdate(update) {
    const from = update.message?.from ?? update.callback_query?.from;
    const key = String(from?.id ?? "none");
    const run = (this.chains.get(key) ?? Promise.resolve()).then(() => this.#dispatch(update));
    const tail = run.catch(() => {});
    this.chains.set(key, tail);
    tail.then(() => { if (this.chains.get(key) === tail) this.chains.delete(key); });
    return run;
  }

  async #dispatch(update) {
    if (update.callback_query) return this.#onButton(update.callback_query);
    if (update.message) return this.#onMessage(update.message);
  }

  #allowed(userId) {
    return userId != null && this.allowedIds().has(String(userId));
  }

  #limited(userId) {
    const t = this.now();
    const list = (this.recent.get(userId) ?? []).filter((x) => t - x < RATE_LIMIT.windowMs);
    list.push(t);
    this.recent.set(userId, list);
    return list.length > RATE_LIMIT.count;
  }

  async #send(chatId, text, extra = {}) {
    const parts = splitMessage(text);
    for (let i = 0; i < parts.length; i++) {
      await this.#tg("sendMessage", { chat_id: chatId, text: parts[i], ...(i === parts.length - 1 ? extra : {}) });
    }
  }

  async #onMessage(msg) {
    const chatId = msg.chat?.id;
    const user = msg.from?.id;
    if (chatId == null || user == null || msg.from?.is_bot) return;

    if (msg.chat.type !== "private" || !this.#allowed(user)) {
      // A stranger, or a group chat: say who they are (so the owner can add them) at most once in a while, nothing more.
      const last = this.strangers.get(user) ?? 0;
      if (msg.chat.type === "private" && this.now() - last > STRANGER_REPLY_EVERY_MS) {
        this.strangers.set(user, this.now());
        this.audit({ type: "denied", user, detail: "message from a user who is not on the allowlist" });
        await this.#send(chatId, `This assistant is private. Your Telegram ID is ${user}. If this is your own bot, add that number on the Agent page of your dashboard.`);
      }
      return;
    }

    const config = await this.getConfig();
    if (!config.enabled) return;
    if (this.#limited(user)) { await this.#send(chatId, "You're sending messages very fast. Give me a few minutes."); return; }

    const command = msg.text?.startsWith("/") ? msg.text.split(/[\s@]/)[0].toLowerCase() : null;
    if (command === "/start" || command === "/help") return this.#send(chatId, HELP);
    if (command === "/id") return this.#send(chatId, `Your Telegram ID is ${user}.`);
    if (command === "/clear") { this.agent.clear(String(chatId)); return this.#send(chatId, "Done: I've forgotten our conversation."); }

    let text = msg.text;
    let voice = false;
    const clip = msg.voice ?? msg.audio;
    if (clip) {
      if (!config.voice?.enabled) return this.#send(chatId, "Voice messages are switched off in the agent settings. Please type it.");
      if (!this.stt.configured) return this.#send(chatId, "I can't listen to voice messages yet: the server has no speech-to-text key (STT_API_KEY). Please type it.");
      if ((clip.duration ?? 0) > MAX_VOICE_SECONDS) return this.#send(chatId, `That voice message is too long (the limit is ${MAX_VOICE_SECONDS / 60} minutes).`);
      if ((clip.file_size ?? 0) > MAX_AUDIO_BYTES) return this.#send(chatId, "That voice message is too big for me to download.");
      try {
        text = await this.#transcribe(clip, config);
      } catch (err) {
        this.audit({ type: "voice_error", user, detail: err.message });
        return this.#send(chatId, `🎙 ${err.message}`);
      }
      voice = true;
      this.audit({ type: "voice", user, detail: `${clip.duration ?? "?"}s` });
      await this.#send(chatId, `🎙 I heard: “${text}”`); // shown first, so a mishearing is visible before anything happens
    }
    if (!text?.trim()) return;
    this.audit({ type: "message", user, detail: voice ? "voice" : "text" });

    const typing = setInterval(() => this.#tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {}), 4000);
    this.#tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
    try {
      const answer = await this.agent.reply(String(chatId), text.slice(0, 4000), { user, voice });
      if (answer.text) await this.#send(chatId, answer.text);
      for (const p of answer.proposals) {
        await this.#send(chatId, `⚠️ Confirm this order?\n\n${p.summary}\n\nNothing is sent until you press Confirm. It expires in 10 minutes.`, {
          reply_markup: { inline_keyboard: [[{ text: "✅ Confirm", callback_data: `ok:${p.id}` }, { text: "❌ Cancel", callback_data: `no:${p.id}` }]] },
        });
      }
    } catch (err) {
      this.audit({ type: "error", user, detail: String(err.message).slice(0, 200) });
      await this.#send(chatId, `Sorry, something went wrong: ${String(err.message).slice(0, 300)}`);
    } finally {
      clearInterval(typing);
    }
  }

  async #transcribe(clip, config) {
    const file = await this.#tg("getFile", { file_id: clip.file_id });
    let res;
    try {
      res = await this.fetchFn(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`);
    } catch (err) {
      throw new Error(`Could not download the voice message (${err.cause?.code || err.message}).`);
    }
    if (!res.ok) throw new Error("Could not download the voice message from Telegram.");
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_AUDIO_BYTES) throw new Error("That voice message is too big.");
    const name = file.file_path?.split("/").pop() || "voice.ogg";
    return this.stt.transcribe(bytes, { filename: name.endsWith(".oga") ? name.replace(/\.oga$/, ".ogg") : name, mime: clip.mime_type || "audio/ogg", language: config.voice?.language ?? "" });
  }

  async #onButton(query) {
    const user = query.from?.id;
    const chatId = query.message?.chat?.id;
    const done = (text) => this.#tg("answerCallbackQuery", { callback_query_id: query.id, text: text.slice(0, 190) }).catch(() => {});
    if (!this.#allowed(user) || query.message?.chat?.type !== "private") return done("Not allowed.");
    const [action, id] = String(query.data ?? "").split(":");
    if (!id || (action !== "ok" && action !== "no")) return done("Unknown action.");

    const result = action === "ok" ? await this.agent.confirm(id, user) : this.agent.cancel(id, user);
    await done(result.ok ? (action === "ok" ? "Sent" : "Cancelled") : "Not done");
    // replace the buttons with the outcome so the same order cannot be tapped twice
    await this.#tg("editMessageText", { chat_id: chatId, message_id: query.message.message_id, text: `${result.text}`.slice(0, 3900) }).catch(() => this.#send(chatId, result.text));
  }
}
