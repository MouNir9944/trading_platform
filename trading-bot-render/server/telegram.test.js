import assert from "node:assert/strict";
import test from "node:test";

import { createStt } from "./agent/stt.js";
import { TelegramBot, splitMessage } from "./agent/telegram.js";

// ---------- a fake Telegram ----------

/** Records every Bot API call. `answers` maps a method to a function returning its result. */
function fakeTelegram(answers = {}) {
  const calls = [];
  const downloads = [];
  const fetchFn = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("/file/bot")) { downloads.push(u); return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }); }
    const method = u.split("/").pop();
    const body = init.body ? JSON.parse(init.body) : {};
    if (method === "getUpdates") await new Promise((r) => setTimeout(r, 5)); // real Telegram waits; an instant answer would spin the loop
    calls.push({ method, ...body });
    const answer = answers[method] ?? (() => (method === "getMe" ? { username: "my_trading_bot" } : method === "getFile" ? { file_path: "voice/file_1.oga" } : true));
    const result = answer(body);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  };
  return { fetchFn, calls, downloads, sent: () => calls.filter((c) => c.method === "sendMessage") };
}

function fakeAgent() {
  const log = { replies: [], confirms: [], cancels: [], clears: [] };
  return {
    log,
    reply: async (chat, text, opts) => { log.replies.push({ chat, text, opts }); return { text: `echo: ${text}`, proposals: [] }; },
    confirm: async (id, user) => { log.confirms.push({ id, user }); return { ok: true, text: `✅ Sent: ${id}` }; },
    cancel: (id, user) => { log.cancels.push({ id, user }); return { ok: true, text: `Cancelled: ${id}` }; },
    clear: (chat) => log.clears.push(chat),
  };
}

const OWNER = 111111;
const msg = (text, extra = {}, user = OWNER) => ({ update_id: 1, message: { message_id: 5, chat: { id: user, type: "private" }, from: { id: user, is_bot: false }, text, ...extra } });
const press = (data, user = OWNER, chatType = "private") => ({ update_id: 2, callback_query: { id: "cb1", from: { id: user }, data, message: { message_id: 9, chat: { id: user, type: chatType } } } });

function build({ config = {}, stt, env = {}, answers, agent = fakeAgent(), now } = {}) {
  const tg = fakeTelegram(answers);
  const cfg = { enabled: true, voice: { enabled: true, language: "" }, ...config };
  const sttImpl = stt ?? { configured: true, transcribe: async () => "buy bitcoin" };
  const bot = new TelegramBot({ token: "TOKEN", agent, stt: sttImpl, getConfig: async () => cfg, allowedIds: () => new Set([String(OWNER)]), audit: () => {}, fetchFn: tg.fetchFn, now });
  return { bot, tg, agent, cfg, env };
}

// ---------- who is allowed ----------

test("a stranger gets their own ID and nothing else, once in a while, and the agent is never reached", async () => {
  let t = 1_000_000;
  const { bot, tg, agent } = build({ now: () => t });
  await bot.handleUpdate(msg("show my balance", {}, 999));
  assert.equal(tg.sent().length, 1);
  assert.match(tg.sent()[0].text, /Your Telegram ID is 999/);
  assert.doesNotMatch(tg.sent()[0].text, /balance|BTC|order/i);
  await bot.handleUpdate(msg("hello?", {}, 999));
  assert.equal(tg.sent().length, 1, "no second reply within ten minutes");
  t += 11 * 60_000;
  await bot.handleUpdate(msg("hello?", {}, 999));
  assert.equal(tg.sent().length, 2);
  assert.equal(agent.log.replies.length, 0);
});

test("a group chat is ignored, even for an allowed user", async () => {
  const { bot, tg, agent } = build();
  await bot.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: -100123, type: "group" }, from: { id: OWNER, is_bot: false }, text: "price?" } });
  assert.equal(tg.calls.length, 0);
  assert.equal(agent.log.replies.length, 0);
});

test("when the agent is switched off the bot stays silent", async () => {
  const { bot, tg, agent } = build({ config: { enabled: false } });
  await bot.handleUpdate(msg("price?"));
  assert.equal(tg.calls.length, 0);
  assert.equal(agent.log.replies.length, 0);
});

test("messages from other bots are ignored", async () => {
  const { bot, tg } = build();
  const update = msg("hi");
  update.message.from.is_bot = true;
  await bot.handleUpdate(update);
  assert.equal(tg.calls.length, 0);
});

// ---------- text ----------

test("a text message goes to the agent and the answer comes back", async () => {
  const { bot, tg, agent } = build();
  await bot.handleUpdate(msg("what is BTC at?"));
  assert.deepEqual(agent.log.replies[0], { chat: String(OWNER), text: "what is BTC at?", opts: { user: OWNER, voice: false } });
  assert.equal(tg.sent().at(-1).text, "echo: what is BTC at?");
  assert.ok(tg.calls.some((c) => c.method === "sendChatAction" && c.action === "typing"));
});

test("commands: help, id and clear are answered without the agent", async () => {
  const { bot, tg, agent } = build();
  await bot.handleUpdate(msg("/start"));
  assert.match(tg.sent().at(-1).text, /Confirm/);
  await bot.handleUpdate(msg("/id@my_trading_bot"));
  assert.match(tg.sent().at(-1).text, /111111/);
  await bot.handleUpdate(msg("/clear"));
  assert.deepEqual(agent.log.clears, [String(OWNER)]);
  assert.equal(agent.log.replies.length, 0);
});

test("a failure in the agent is reported kindly, not silently and not as a crash", async () => {
  const agent = fakeAgent();
  agent.reply = async () => { throw new Error("The server has no ANTHROPIC_API_KEY"); };
  const { bot, tg } = build({ agent });
  await bot.handleUpdate(msg("hello"));
  assert.match(tg.sent().at(-1).text, /something went wrong: The server has no ANTHROPIC_API_KEY/);
});

test("long answers are split into several messages", async () => {
  const agent = fakeAgent();
  agent.reply = async () => ({ text: Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n"), proposals: [] });
  const { bot, tg } = build({ agent });
  await bot.handleUpdate(msg("long"));
  assert.ok(tg.sent().length >= 3);
  assert.ok(tg.sent().every((s) => s.text.length <= 4000));
  const parts = splitMessage("a\n".repeat(5000), 100);
  assert.ok(parts.every((p) => p.length <= 100));
  assert.equal(parts.join("\n").replace(/\n/g, ""), "a".repeat(5000));
});

test("sending far too many messages is slowed down", async () => {
  const { bot, tg, agent } = build();
  for (let i = 0; i < 32; i++) await bot.handleUpdate(msg(`q${i}`));
  assert.equal(agent.log.replies.length, 30);
  assert.match(tg.sent().at(-1).text, /very fast/);
});

test("messages from one user are handled in order, even when the agent is slow", async () => {
  const order = [];
  const agent = fakeAgent();
  agent.reply = async (_c, text) => { order.push(`start ${text}`); await new Promise((r) => setTimeout(r, text === "first" ? 40 : 1)); order.push(`end ${text}`); return { text: "ok", proposals: [] }; };
  const { bot } = build({ agent });
  await Promise.all([bot.handleUpdate(msg("first")), bot.handleUpdate(msg("second"))]);
  assert.deepEqual(order, ["start first", "end first", "start second", "end second"]);
});

// ---------- orders ----------

test("a proposed order is shown with Confirm and Cancel buttons", async () => {
  const agent = fakeAgent();
  agent.reply = async () => ({ text: "Here is the setup.", proposals: [{ id: "abc123", summary: "Spot BUY XLMUSDT: limit at 0.2" }] });
  const { bot, tg } = build({ agent });
  await bot.handleUpdate(msg("buy xlm"));
  const card = tg.sent().at(-1);
  assert.match(card.text, /Confirm this order\?[\s\S]*Spot BUY XLMUSDT: limit at 0\.2[\s\S]*Nothing is sent until you press Confirm/);
  assert.deepEqual(card.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ["ok:abc123", "no:abc123"]);
});

test("pressing Confirm runs it and replaces the buttons with the result", async () => {
  const { bot, tg, agent } = build();
  await bot.handleUpdate(press("ok:abc123"));
  assert.deepEqual(agent.log.confirms, [{ id: "abc123", user: OWNER }]);
  const edit = tg.calls.find((c) => c.method === "editMessageText");
  assert.equal(edit.message_id, 9);
  assert.match(edit.text, /Sent: abc123/);
  assert.ok(tg.calls.some((c) => c.method === "answerCallbackQuery"));
});

test("pressing Cancel cancels", async () => {
  const { bot, agent } = build();
  await bot.handleUpdate(press("no:abc123"));
  assert.deepEqual(agent.log.cancels, [{ id: "abc123", user: OWNER }]);
  assert.equal(agent.log.confirms.length, 0);
});

test("a button pressed by someone else, in a group, or with odd data does nothing", async () => {
  const { bot, tg, agent } = build();
  await bot.handleUpdate(press("ok:abc123", 999));
  await bot.handleUpdate(press("ok:abc123", OWNER, "group"));
  await bot.handleUpdate(press("steal:abc123"));
  await bot.handleUpdate(press("ok:"));
  await bot.handleUpdate(press(undefined));
  assert.equal(agent.log.confirms.length, 0);
  assert.equal(agent.log.cancels.length, 0);
  assert.equal(tg.calls.filter((c) => c.method === "editMessageText").length, 0);
});

// ---------- voice ----------

const voice = (extra = {}) => msg(undefined, { voice: { file_id: "F1", duration: 5, file_size: 20000, mime_type: "audio/ogg", ...extra } });

test("a voice message is downloaded, transcribed, shown back, and then answered like text", async () => {
  const heard = [];
  const stt = { configured: true, transcribe: async (bytes, opts) => { heard.push({ bytes: bytes.byteLength, opts }); return "buy a little bitcoin"; } };
  const { bot, tg, agent } = build({ stt, config: { voice: { enabled: true, language: "fr" } } });
  await bot.handleUpdate(voice());
  assert.equal(tg.downloads.length, 1);
  assert.match(tg.downloads[0], /file\/botTOKEN\/voice\/file_1\.oga/);
  assert.equal(heard[0].bytes, 4);
  assert.equal(heard[0].opts.filename, "file_1.ogg", "Telegram's .oga is sent as .ogg");
  assert.equal(heard[0].opts.language, "fr");
  assert.match(tg.sent()[0].text, /I heard: “buy a little bitcoin”/, "what was heard is shown before anything happens");
  assert.deepEqual(agent.log.replies[0], { chat: String(OWNER), text: "buy a little bitcoin", opts: { user: OWNER, voice: true } });
});

test("voice messages are declined politely when they are off, unconfigured, too long or unreadable", async () => {
  const off = build({ config: { voice: { enabled: false } } });
  await off.bot.handleUpdate(voice());
  assert.match(off.tg.sent().at(-1).text, /switched off/);

  const none = build({ stt: { configured: false } });
  await none.bot.handleUpdate(voice());
  assert.match(none.tg.sent().at(-1).text, /STT_API_KEY/);

  const long = build();
  await long.bot.handleUpdate(voice({ duration: 900 }));
  assert.match(long.tg.sent().at(-1).text, /too long/);

  const bad = build({ stt: { configured: true, transcribe: async () => { throw new Error("I could not make out any words in that voice message."); } } });
  await bad.bot.handleUpdate(voice());
  assert.match(bad.tg.sent().at(-1).text, /could not make out any words/);
  for (const t of [off, none, long, bad]) assert.equal(t.agent.log.replies.length, 0, "the agent never saw it");
});

test("a voice message from a stranger is not downloaded or transcribed", async () => {
  let transcribed = false;
  const { bot, tg } = build({ stt: { configured: true, transcribe: async () => { transcribed = true; return "x"; } } });
  await bot.handleUpdate(msg(undefined, { voice: { file_id: "F1", duration: 3 } }, 999));
  assert.equal(transcribed, false);
  assert.equal(tg.downloads.length, 0);
});

// ---------- speech to text service ----------

test("speech-to-text: sends the audio, the key and the model, and reads the words back", async () => {
  const seen = [];
  const fetchFn = async (url, init) => { seen.push({ url: String(url), init }); return new Response(JSON.stringify({ text: "  hello world " }), { status: 200 }); };
  const stt = createStt({ env: { STT_API_KEY: "k", STT_MODEL: "whisper-large-v3-turbo", STT_BASE_URL: "https://api.groq.com/openai/v1/" }, fetchFn });
  assert.equal(stt.configured, true);
  assert.equal(await stt.transcribe(new Uint8Array([1, 2, 3]), { language: "fr-FR" }), "hello world");
  assert.equal(seen[0].url, "https://api.groq.com/openai/v1/audio/transcriptions");
  assert.equal(seen[0].init.headers.Authorization, "Bearer k");
  const form = seen[0].init.body;
  assert.equal(form.get("model"), "whisper-large-v3-turbo");
  assert.equal(form.get("language"), "fr");
  assert.equal(form.get("file").name, "voice.ogg");
});

test("speech-to-text: clear messages for no key, empty audio, refused key, rate limits and silence", async () => {
  assert.equal(createStt({ env: {} }).configured, false);
  await assert.rejects(createStt({ env: {} }).transcribe(new Uint8Array([1])), /STT_API_KEY/);
  const reply = (status, body) => createStt({ env: { OPENAI_API_KEY: "k" }, fetchFn: async () => new Response(JSON.stringify(body), { status }) });
  await assert.rejects(reply(200, { text: "x" }).transcribe(new Uint8Array()), /empty/);
  await assert.rejects(reply(401, {}).transcribe(new Uint8Array([1])), /key was refused/);
  await assert.rejects(reply(429, {}).transcribe(new Uint8Array([1])), /rate limiting/);
  await assert.rejects(reply(200, { text: "  " }).transcribe(new Uint8Array([1])), /could not make out/);
  await assert.rejects(reply(500, { error: { message: "boom" } }).transcribe(new Uint8Array([1])), /answered 500: boom/);
  const down = createStt({ env: { STT_API_KEY: "k" }, fetchFn: async () => { throw Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }); } });
  await assert.rejects(down.transcribe(new Uint8Array([1])), /Could not reach.*ENOTFOUND/);
});

// ---------- starting and stopping ----------

test("start() checks the token, clears any webhook, polls for updates and handles them; stop() ends it", async () => {
  let delivered = false;
  const { bot, tg, agent } = build({
    answers: {
      getUpdates: () => (delivered ? [] : ((delivered = true), [msg("hello from polling")])),
    },
  });
  await bot.start();
  assert.equal(bot.running, true);
  assert.equal(bot.username, "my_trading_bot");
  assert.ok(tg.calls.some((c) => c.method === "deleteWebhook"));
  for (let i = 0; i < 50 && agent.log.replies.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(agent.log.replies[0].text, "hello from polling");
  const poll = tg.calls.find((c) => c.method === "getUpdates");
  assert.deepEqual(poll.allowed_updates, ["message", "callback_query"]);
  bot.stop();
  assert.equal(bot.running, false);
});

test("a bad token is reported with a clear reason and the bot does not start", async () => {
  const { bot } = build({ answers: { getMe: () => new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 }) } });
  await assert.rejects(bot.start(), /Telegram rejected the bot token/);
  assert.equal(bot.running, false);
  assert.match(bot.error, /rejected the bot token/);
});
