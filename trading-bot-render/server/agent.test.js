import assert from "node:assert/strict";
import test from "node:test";

import { Agent, PROPOSAL_TTL_MS, SYSTEM_PROMPT } from "./agent/agent.js";
import { anthropicCaller } from "./agent/models.js";
import { ToolError } from "./agent/tools.js";

// ---------- fakes ----------

/** A fake Claude: answers from a script, and remembers what it was asked (copied, because the agent keeps editing its list). */
function fakeClaude(script) {
  const calls = [];
  let i = 0;
  const next = async (params, beta) => {
    calls.push({ beta, params: JSON.parse(JSON.stringify(params)) });
    const r = script[Math.min(i++, script.length - 1)];
    if (r instanceof Error) throw r;
    return typeof r === "function" ? r(params) : r;
  };
  return { calls, messages: { create: (p) => next(p, false) }, beta: { messages: { create: (p) => next(p, true) } } };
}
const say = (text, stop_reason = "end_turn") => ({ stop_reason, content: [{ type: "text", text }] });
const use = (name, input, id = "tu1", text) => ({ stop_reason: "tool_use", content: [...(text ? [{ type: "text", text }] : []), { type: "tool_use", id, name, input }] });

/** A fake platform. `mode` can be changed between calls. */
function fakePlatform(state = { mode: { mode: "paper", paper: true } }) {
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === "/api/account/mode") return state.mode;
    if (path.startsWith("/api/market/price")) return { symbol: "BTCUSDT", price: 61000 };
    if (path === "/api/orders/conditional") return { id: "order-1", status: "WAITING_ENTRY" };
    if (path.startsWith("/api/orders/")) return { ok: true };
    throw new ToolError(`unexpected ${method} ${path}`);
  };
  return { api, calls, state };
}

const ORDER = { symbol: "XLMUSDT", entry_price: 0.2, capital_usdt: 50, stop_loss_price: 0.19, take_profit_price: 0.23 };
const build = ({ script, config = {}, platform = fakePlatform(), now = () => 1_000_000, audit = () => {} } = {}) => {
  const client = fakeClaude(script);
  const cfg = { model: "claude-opus-5-5", effort: "medium", instructions: "", allowTrading: true, allowLive: false, tools: {}, ...config };
  const state = { fallbackOff: false };
  const getAgent = async () => ({ id: "default", name: "Claude", call: anthropicCaller({ client, model: cfg.model, effort: cfg.effort, onNote: (detail) => audit({ type: "note", detail }), state }) });
  const agent = new Agent({ getAgent, getConfig: async () => cfg, api: platform.api, now, audit });
  return { agent, client, platform, cfg };
};
const posts = (platform) => platform.calls.filter((c) => c.method === "POST" || c.method === "DELETE");

// ---------- answering ----------

test("a plain question gets a plain answer, with the safety prompt, the tools and the chosen model", async () => {
  const { agent, client } = build({ script: [say("Hello!")] });
  const r = await agent.reply("chat1", "hi");
  assert.deepEqual(r, { text: "Hello!", agent: "Claude", proposals: [] });
  const { params } = client.calls[0];
  assert.equal(params.model, "claude-opus-5-5");
  assert.equal(params.system, SYSTEM_PROMPT);
  assert.deepEqual(params.messages, [{ role: "user", content: "hi" }]);
  assert.ok(params.tools.some((t) => t.name === "get_price") && params.tools.every((t) => t.input_schema.type === "object"));
  assert.ok(params.tools.some((t) => t.name === "place_spot_order"), "trading tools are offered when trading is on");
});

test("the owner's own instructions are added under the rules, never instead of them", async () => {
  const { agent, client } = build({ script: [say("ok")], config: { instructions: "Answer in French." } });
  await agent.reply("c", "hi");
  const system = client.calls[0].params.system;
  assert.ok(system.startsWith(SYSTEM_PROMPT));
  assert.match(system, /Answer in French\./);
  assert.match(system, /unless they conflict with the rules above/);
});

test("model options: effort and the refusal fallback go only to the models that take them", async () => {
  const opus = build({ script: [say("a")], config: { model: "claude-opus-5-5", effort: "high" } });
  await opus.agent.reply("c", "x");
  assert.equal(opus.client.calls[0].beta, true);
  assert.deepEqual(opus.client.calls[0].params.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(opus.client.calls[0].params.fallbacks, "default");
  assert.deepEqual(opus.client.calls[0].params.output_config, { effort: "high" });

  const haiku = build({ script: [say("a")], config: { model: "claude-haiku-4-5", effort: "high" } });
  await haiku.agent.reply("c", "x");
  assert.equal(haiku.client.calls[0].beta, false);
  assert.equal(haiku.client.calls[0].params.output_config, undefined, "Haiku takes no effort setting");
  assert.equal(haiku.client.calls[0].params.fallbacks, undefined);

  const sonnet = build({ script: [say("a")], config: { model: "claude-sonnet-4-6" } });
  await sonnet.agent.reply("c", "x");
  assert.equal(sonnet.client.calls[0].beta, false);
  assert.deepEqual(sonnet.client.calls[0].params.output_config, { effort: "medium" });
});

test("if the API turns the fallback option down, the agent carries on without it", async () => {
  const notes = [];
  const rejected = Object.assign(new Error("fallbacks: not supported for this account"), { status: 400 });
  const { agent, client } = build({ script: [rejected, say("fine")], audit: (e) => notes.push(e) });
  assert.equal((await agent.reply("c", "x")).text, "fine");
  assert.deepEqual(client.calls.map((c) => c.beta), [true, false]);
  await agent.reply("c", "again"); // and it does not keep trying
  assert.equal(client.calls.at(-1).beta, false);
  assert.ok(notes.some((n) => /fallback/i.test(n.detail)));
  // other errors are not swallowed
  const other = build({ script: [Object.assign(new Error("overloaded"), { status: 529 })] });
  await assert.rejects(other.agent.reply("c", "x"), /overloaded/);
});

// ---------- tools ----------

test("a lookup runs the tool and feeds the result back to the model", async () => {
  const { agent, client, platform } = build({ script: [use("get_price", { symbol: "btcusdt" }, "tu1", "Let me check."), say("BTC is at 61,000.")] });
  const r = await agent.reply("c", "price of BTC?");
  assert.equal(r.text, "BTC is at 61,000.");
  assert.equal(platform.calls[0].path, "/api/market/price?symbol=BTCUSDT&market=spot");
  const second = client.calls[1].params.messages;
  assert.equal(second.length, 3);
  assert.equal(second[1].role, "assistant");
  assert.equal(second[1].content.at(-1).type, "tool_use");
  assert.equal(second[2].role, "user");
  assert.equal(second[2].content[0].type, "tool_result");
  assert.equal(second[2].content[0].tool_use_id, "tu1");
  assert.match(second[2].content[0].content, /61000/);
});

test("a failing or unknown tool tells the model what went wrong instead of crashing", async () => {
  const { agent, client } = build({ script: [use("get_price", { symbol: "BTC/USDT" }, "a"), use("delete_everything", {}, "b"), say("Sorry.")] });
  assert.equal((await agent.reply("c", "x")).text, "Sorry.");
  const first = client.calls[1].params.messages.at(-1).content[0];
  assert.equal(first.is_error, true);
  assert.match(first.content, /Invalid arguments/);
  const second = client.calls[2].params.messages.at(-1).content[0];
  assert.equal(second.is_error, true);
  assert.match(second.content, /Unknown or disabled/);
});

test("tools switched off in the settings are not offered and cannot be called", async () => {
  const { agent, client } = build({ script: [say("a"), use("get_news", {}), say("no news tool")], config: { tools: { get_news: false } } });
  await agent.reply("c", "x");
  assert.ok(!client.calls[0].params.tools.some((t) => t.name === "get_news"));
  await agent.reply("c", "news?");
  assert.match(client.calls[2].params.messages.at(-1).content[0].content, /Unknown or disabled/);
});

test("a very long tool result is cut before it reaches the model", async () => {
  const platform = fakePlatform();
  const big = async () => ({ symbol: "X", junk: "y".repeat(50_000) });
  const { agent, client } = build({ script: [use("get_price", { symbol: "BTCUSDT" }), say("ok")], platform: { ...platform, api: big } });
  await agent.reply("c", "x");
  assert.ok(client.calls[1].params.messages.at(-1).content[0].content.length < 8100);
});

// ---------- orders: the model only proposes ----------

test("an order from the model is a proposal: nothing is sent until the user confirms", async () => {
  const { agent, client, platform } = build({ script: [use("place_spot_order", ORDER, "tu1", "Here is the setup."), say("I proposed it. Waiting for your confirmation.")] });
  const r = await agent.reply("chat1", "buy some XLM", { user: 42 });
  assert.equal(r.proposals.length, 1);
  assert.match(r.proposals[0].summary, /Spot BUY XLMUSDT.*0\.2.*50 USDT/);
  assert.equal(posts(platform).length, 0, "no order reached the platform");
  assert.match(client.calls[1].params.messages.at(-1).content[0].content, /NOT been sent/);
  assert.equal(agent.pendingCount(), 1);

  const done = await agent.confirm(r.proposals[0].id, 42);
  assert.equal(done.ok, true);
  assert.match(done.text, /Sent: Spot BUY XLMUSDT/);
  assert.deepEqual(posts(platform).map((c) => c.path), ["/api/orders/conditional"]);
  assert.equal(posts(platform)[0].body.symbol, "XLMUSDT");
  assert.equal(agent.pendingCount(), 0);
});

test("a confirmation works once, and only for the user it was made for", async () => {
  const { agent, platform } = build({ script: [use("place_spot_order", ORDER), say("waiting")] });
  const { proposals } = await agent.reply("chat1", "buy", { user: 42 });
  const id = proposals[0].id;
  assert.match((await agent.confirm(id, 99)).text, /belongs to someone else/);
  assert.equal(posts(platform).length, 0);
  assert.equal((await agent.confirm(id, 42)).ok, true);
  assert.match((await agent.confirm(id, 42)).text, /expired or was already handled/);
  assert.equal(posts(platform).length, 1, "tapping twice never sends twice");
});

test("cancelling removes the proposal and sends nothing", async () => {
  const { agent, platform } = build({ script: [use("place_spot_order", ORDER), say("waiting")] });
  const { proposals } = await agent.reply("c", "buy", { user: 1 });
  assert.equal(agent.cancel(proposals[0].id, 2).ok, false);
  const r = agent.cancel(proposals[0].id, 1);
  assert.equal(r.ok, true);
  assert.match((await agent.confirm(proposals[0].id, 1)).text, /already handled/);
  assert.equal(posts(platform).length, 0);
});

test("a proposal expires after ten minutes", async () => {
  let t = 1_000_000;
  const { agent, platform } = build({ script: [use("place_spot_order", ORDER), say("waiting")], now: () => t });
  const { proposals } = await agent.reply("c", "buy", { user: 1 });
  t += PROPOSAL_TTL_MS + 1;
  assert.match((await agent.confirm(proposals[0].id, 1)).text, /expired/);
  assert.equal(posts(platform).length, 0);
  assert.equal(agent.pendingCount(), 0);
});

test("with trading switched off the order tools are not even offered, and a forced call is refused", async () => {
  const { agent, client, platform } = build({ script: [use("place_spot_order", ORDER), say("I can't trade.")], config: { allowTrading: false } });
  const r = await agent.reply("c", "buy", { user: 1 });
  assert.ok(!client.calls[0].params.tools.some((t) => t.name === "place_spot_order"));
  assert.deepEqual(r.proposals, []);
  assert.match(client.calls[1].params.messages.at(-1).content[0].content, /Unknown or disabled/);
  assert.equal(posts(platform).length, 0);
});

test("on the live account an order is refused up front, and again at confirmation if the mode changed", async () => {
  const live = fakePlatform({ mode: { mode: "live", paper: false } });
  const refused = build({ script: [use("place_spot_order", ORDER), say("not on live")], platform: live });
  const r = await refused.agent.reply("c", "buy", { user: 1 });
  assert.deepEqual(r.proposals, []);
  assert.match(refused.client.calls[1].params.messages.at(-1).content[0].content, /LIVE account/);

  // proposed on paper, then the platform is switched to live before the user taps
  const platform = fakePlatform();
  const flip = build({ script: [use("place_spot_order", ORDER), say("waiting")], platform });
  const { proposals } = await flip.agent.reply("c", "buy", { user: 1 });
  platform.state.mode = { mode: "live", paper: false };
  const tapped = await flip.agent.confirm(proposals[0].id, 1);
  assert.equal(tapped.ok, false);
  assert.match(tapped.text, /LIVE account/);
  assert.equal(posts(platform).length, 0);

  // with live trading allowed it goes through
  const allowed = build({ script: [use("place_spot_order", ORDER), say("waiting")], platform: live, config: { allowLive: true } });
  const ok = await allowed.agent.reply("c", "buy", { user: 1 });
  assert.equal((await allowed.agent.confirm(ok.proposals[0].id, 1)).ok, true);
});

test("an order with bad numbers never becomes a proposal", async () => {
  const { agent, client } = build({ script: [use("place_spot_order", { ...ORDER, capital_usdt: -5 }), say("fixed")] });
  const r = await agent.reply("c", "buy", { user: 1 });
  assert.deepEqual(r.proposals, []);
  assert.match(client.calls[1].params.messages.at(-1).content[0].content, /Invalid arguments/);
});

test("too many unanswered proposals in one chat are refused", async () => {
  // each message: the model proposes an order, then says it is waiting
  const script = Array.from({ length: 14 }, (_, i) => (i % 2 === 0 ? use("place_spot_order", ORDER, `t${i}`) : say("waiting")));
  const { agent, client } = build({ script });
  for (let i = 0; i < 5; i++) assert.equal((await agent.reply("same-chat", "buy", { user: 1 })).proposals.length, 1);
  assert.equal(agent.pendingCount(), 5);
  const sixth = await agent.reply("same-chat", "buy", { user: 1 });
  assert.deepEqual(sixth.proposals, []);
  assert.match(client.calls.at(-1).params.messages.at(-1).content[0].content, /several orders waiting/);
  assert.equal((await agent.reply("other-chat", "buy", { user: 2 })).proposals.length, 1, "another chat has its own allowance");
});

test("the model is told afterwards what the user decided", async () => {
  const { agent, client } = build({ script: [use("place_spot_order", ORDER), say("waiting"), say("noted")] });
  const { proposals } = await agent.reply("c", "buy", { user: 1 });
  await agent.confirm(proposals[0].id, 1);
  await agent.reply("c", "how did it go?", { user: 1 });
  const last = client.calls.at(-1).params.messages.at(-1);
  assert.equal(last.role, "user");
  assert.match(last.content, /\[Note: The user confirmed and this was sent to the platform: Spot BUY XLMUSDT/);
  assert.match(last.content, /how did it go\?/);
});

// ---------- conversation memory and limits ----------

test("it remembers the conversation, voice is labelled, and /clear forgets", async () => {
  const { agent, client } = build({ script: [say("one"), say("two"), say("three")] });
  await agent.reply("c", "first");
  await agent.reply("c", "second", { voice: true });
  const messages = client.calls[1].params.messages;
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(messages[2].content, "[Voice message, transcribed automatically] second");
  agent.clear("c");
  await agent.reply("c", "third");
  assert.equal(client.calls[2].params.messages.length, 1);
});

test("conversations are kept apart, and old ones are trimmed", async () => {
  const { agent, client } = build({ script: [say("ok")] });
  await agent.reply("a", "from A");
  await agent.reply("b", "from B");
  assert.equal(client.calls[1].params.messages.length, 1);
  for (let i = 0; i < 10; i++) await agent.reply("a", `message ${i}`);
  const kept = client.calls.at(-1).params.messages;
  assert.ok(kept.length <= 13, `kept ${kept.length} messages`);
  assert.equal(kept[0].role, "user");
  assert.ok(!JSON.stringify(kept).includes("from A"), "the oldest turn was dropped");
});

test("thinking blocks are not carried into later turns", async () => {
  const withThinking = { stop_reason: "end_turn", content: [{ type: "thinking", thinking: "hmm", signature: "sig" }, { type: "text", text: "answer" }] };
  const { agent, client } = build({ script: [withThinking, say("next")] });
  await agent.reply("c", "q1");
  await agent.reply("c", "q2");
  assert.ok(!JSON.stringify(client.calls[1].params.messages).includes("thinking"));
});

test("a refusal and a cut-off answer are reported plainly", async () => {
  const refused = build({ script: [{ stop_reason: "refusal", content: [] }] });
  assert.match((await refused.agent.reply("c", "x")).text, /can't help/);
  const cut = build({ script: [say("partial", "max_tokens")] });
  assert.match((await cut.agent.reply("c", "x")).text, /partial\n\(The answer was cut short\.\)/);
});

test("a model that never stops calling tools is cut off, and the history stays valid", async () => {
  const { agent, client } = build({ script: [use("get_price", { symbol: "BTCUSDT" }, "loop")] });
  const r = await agent.reply("c", "x");
  assert.match(r.text, /too many steps/);
  assert.equal(client.calls.length, 8);
  await agent.reply("c", "again");
  const roles = client.calls.at(-1).params.messages.map((m) => m.role);
  assert.equal(roles.at(-1), "user");
  assert.equal(roles.at(-2), "assistant", "the stopped turn ended with an assistant message");
});

test("when the model call fails, the half-finished turn is not remembered", async () => {
  const { agent, client } = build({ script: [new Error("network down"), say("recovered")] });
  await assert.rejects(agent.reply("c", "first"), /network down/);
  await agent.reply("c", "second");
  assert.equal(client.calls[1].params.messages.length, 1);
});

test("the agent's own actions are written to the activity log", async () => {
  const log = [];
  const { agent } = build({ script: [use("get_price", { symbol: "BTCUSDT" }, "a"), use("place_spot_order", ORDER, "b"), say("done")], audit: (e) => log.push(e) });
  const { proposals } = await agent.reply("c", "my-private-words", { user: 7 });
  await agent.confirm(proposals[0].id, 7);
  assert.deepEqual(log.map((e) => e.type), ["tool", "proposal", "confirmed"]);
  assert.ok(log.every((e) => !JSON.stringify(e).includes("my-private-words")), "the message text is not logged");
});
