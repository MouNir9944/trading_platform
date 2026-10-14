import assert from "node:assert/strict";
import test from "node:test";

import { Agent } from "./agent/agent.js";
import { PROVIDERS, compatCaller, fromChatResponse, simplifySchema, toChatMessages } from "./agent/models.js";

const chat = (message, finish_reason = "stop") => ({ choices: [{ message, finish_reason }] });

// ---------- the providers on offer ----------

test("every provider is described well enough to be configured from the page", () => {
  for (const [id, p] of Object.entries(PROVIDERS)) {
    assert.ok(p.label, id);
    assert.equal(typeof p.needsKey, "boolean", id);
    assert.ok(p.keyPattern instanceof RegExp, id);
    if (id === "anthropic") { assert.equal(p.baseUrl, undefined, "Claude goes through its own SDK, not a web address"); continue; }
    assert.ok(p.baseUrl || p.urlRequired, `${id} needs an address or must ask for one`);
    if (p.baseUrl) assert.match(p.baseUrl, /^https?:\/\//, id);
  }
  for (const wanted of ["anthropic", "gemini", "openai", "groq", "ollama", "custom"]) assert.ok(PROVIDERS[wanted], wanted);
  assert.equal(PROVIDERS.gemini.keyEnv, "GEMINI_API_KEY");
  assert.equal(PROVIDERS.ollama.needsKey, false);
});

// ---------- converting between formats ----------

test("messages: system first, text as text, tool calls and their results in the chat-completions shape", () => {
  const out = toChatMessages("RULES", [
    { role: "user", content: "price of btc?" },
    { role: "assistant", content: [{ type: "text", text: "Checking." }, { type: "tool_use", id: "t1", name: "get_price", input: { symbol: "BTCUSDT" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{\"price\":61000}" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "get_news", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "boom", is_error: true }] },
    { role: "assistant", content: [{ type: "text", text: "" }] },
  ]);
  assert.deepEqual(out[0], { role: "system", content: "RULES" });
  assert.deepEqual(out[1], { role: "user", content: "price of btc?" });
  assert.deepEqual(out[2], { role: "assistant", content: "Checking.", tool_calls: [{ id: "t1", type: "function", function: { name: "get_price", arguments: "{\"symbol\":\"BTCUSDT\"}" } }] });
  assert.deepEqual(out[3], { role: "tool", tool_call_id: "t1", content: "{\"price\":61000}" });
  assert.equal(out[4].content, null, "an assistant turn with only a tool call has no text");
  assert.deepEqual(out[5], { role: "tool", tool_call_id: "t2", content: "Error: boom" });
  assert.equal(out.length, 6, "an empty assistant message is left out");
});

test("answers: text, tool calls, and the reasons a turn stopped", () => {
  assert.deepEqual(fromChatResponse(chat({ content: "Hello" })), { content: [{ type: "text", text: "Hello" }], stop_reason: "end_turn" });
  const withCall = fromChatResponse(chat({ content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_price", arguments: "{\"symbol\":\"BTCUSDT\"}" } }] }, "tool_calls"));
  assert.deepEqual(withCall, { content: [{ type: "tool_use", id: "c1", name: "get_price", input: { symbol: "BTCUSDT" } }], stop_reason: "tool_use" });
  assert.equal(fromChatResponse(chat({ content: "x", tool_calls: [{ function: { name: "get_news", arguments: "{}" } }] }, "stop")).stop_reason, "tool_use", "a call counts even if the server says stop");
  assert.equal(fromChatResponse(chat({ content: "x" }, "length")).stop_reason, "max_tokens");
  assert.equal(fromChatResponse(chat({ content: "" }, "content_filter")).stop_reason, "refusal");
  assert.equal(fromChatResponse(chat({ content: [{ text: "a" }, { text: "b" }] })).content[0].text, "ab");
  assert.deepEqual(fromChatResponse(chat({ tool_calls: [{ id: "c", function: { name: "x", arguments: "not json" } }] })).content[0].input, {}, "unreadable arguments become empty ones, which the tool then rejects");
  assert.deepEqual(fromChatResponse(chat({ tool_calls: [{ function: { name: "x", arguments: "[1]" } }] })).content[0].input, {});
  assert.throws(() => fromChatResponse({ choices: [] }), /empty answer/);
});

test("tool schemas lose the keywords some providers reject, and keep the rest", () => {
  const simple = simplifySchema({
    type: "object", additionalProperties: false, required: ["a"],
    properties: { a: { type: "number", exclusiveMinimum: 0, description: "d" }, b: { type: "string", pattern: "^x$", maxLength: 5, enum: ["x"] }, c: { type: "array", items: { type: "object", additionalProperties: false, properties: {} } } },
  });
  assert.deepEqual(simple, { type: "object", required: ["a"], properties: { a: { type: "number", description: "d" }, b: { type: "string", enum: ["x"] }, c: { type: "array", items: { type: "object", properties: {} } } } });
});

// ---------- the caller ----------

const TOOLS = [{ name: "get_price", description: "price", input_schema: { type: "object", additionalProperties: false, properties: { symbol: { type: "string", pattern: "^[A-Z]+$" } }, required: ["symbol"] } }];

test("a request goes to the provider's address with the key, the model, the tools and the messages", async () => {
  const seen = [];
  const fetchFn = async (url, init) => { seen.push({ url: String(url), init }); return new Response(JSON.stringify(chat({ content: "hi" })), { status: 200 }); };
  const call = compatCaller({ baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/", apiKey: "AIza-secret-key", model: "gemini-2.5-flash", label: "Google Gemini", fetchFn });
  const answer = await call({ system: "S", tools: TOOLS, messages: [{ role: "user", content: "hello" }] });
  assert.deepEqual(answer, { content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" });
  assert.equal(seen[0].url, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
  assert.equal(seen[0].init.headers.Authorization, "Bearer AIza-secret-key");
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.model, "gemini-2.5-flash");
  assert.deepEqual(body.messages.map((m) => m.role), ["system", "user"]);
  assert.deepEqual(body.tools[0], { type: "function", function: { name: "get_price", description: "price", parameters: { type: "object", required: ["symbol"], properties: { symbol: { type: "string" } } } } });
});

test("a server that needs no key is sent none, and no tools are sent when there are none", async () => {
  let init;
  const fetchFn = async (_u, i) => { init = i; return new Response(JSON.stringify(chat({ content: "ok" })), { status: 200 }); };
  await compatCaller({ baseUrl: "http://127.0.0.1:11434/v1", model: "llama3.1", fetchFn })({ system: "S", tools: [], messages: [{ role: "user", content: "x" }] });
  assert.equal(init.headers.Authorization, undefined);
  assert.equal(JSON.parse(init.body).tools, undefined);
});

test("failures are explained in plain words, naming the provider", async () => {
  const reply = (status, body) => compatCaller({ baseUrl: "https://x/v1", apiKey: "k", model: "m1", label: "Groq", fetchFn: async () => new Response(JSON.stringify(body), { status }) });
  const run = (c) => c({ system: "S", tools: [], messages: [{ role: "user", content: "x" }] });
  await assert.rejects(run(reply(401, {})), /Groq refused the API key/);
  await assert.rejects(run(reply(404, {})), /Groq does not know the model "m1"/);
  await assert.rejects(run(reply(429, {})), /rate limiting or out of credit/);
  await assert.rejects(run(reply(500, { error: { message: "upstream broke" } })), /Groq answered 500: upstream broke/);
  await assert.rejects(run(reply(400, [{ error: { message: "bad schema" } }])), /answered 400: bad schema/);
  const down = compatCaller({ baseUrl: "https://x/v1", model: "m", label: "Ollama", fetchFn: async () => { throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }); } });
  await assert.rejects(run(down), /Could not reach Ollama \(ECONNREFUSED\)/);
});

// ---------- the safety rules do not depend on the model ----------

test("whichever model is behind it, an order is only ever a proposal until the user confirms", async () => {
  const toolCall = chat({ content: "Setting it up.", tool_calls: [{ id: "c1", type: "function", function: { name: "place_spot_order", arguments: JSON.stringify({ symbol: "XLMUSDT", entry_price: 0.2, capital_usdt: 50, stop_loss_price: 0.19, take_profit_price: 0.23 }) } }] }, "tool_calls");
  const answers = [toolCall, chat({ content: "It is waiting for your confirmation." })];
  const sent = [];
  const fetchFn = async () => new Response(JSON.stringify(answers.shift()), { status: 200 });
  const platform = async (method, path, body) => {
    sent.push({ method, path, body });
    if (path === "/api/account/mode") return { mode: "paper", paper: true };
    if (path === "/api/orders/conditional") return { id: "o1" };
    throw new Error(`unexpected ${path}`);
  };
  const call = compatCaller({ baseUrl: "https://api.openai.com/v1", apiKey: "k", model: "gpt-4.1", label: "OpenAI", fetchFn });
  const agent = new Agent({ getAgent: async () => ({ id: "a", name: "GPT", call }), getConfig: async () => ({ allowTrading: true, tools: {} }), api: platform });

  const r = await agent.reply("chat", "buy some xlm", { user: 1 });
  assert.equal(r.agent, "GPT");
  assert.equal(r.proposals.length, 1);
  assert.match(r.proposals[0].summary, /Spot BUY XLMUSDT/);
  assert.equal(sent.filter((c) => c.method === "POST").length, 0, "nothing was sent by the model");
  assert.equal((await agent.confirm(r.proposals[0].id, 1)).ok, true);
  assert.deepEqual(sent.filter((c) => c.method === "POST").map((c) => c.path), ["/api/orders/conditional"]);
});
