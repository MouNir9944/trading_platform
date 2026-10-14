/**
 * Talking to a language model, whichever company's it is.
 *
 * The agent works with one internal format (Claude-style messages: text blocks, tool_use, tool_result). This file turns
 * that into a call to the chosen provider and the answer back into the same format, so the agent loop, the safety rules
 * and the tools are identical for every model.
 *
 *   anthropic   Claude, through Anthropic's own SDK.
 *   the rest    anything that speaks the "chat completions" protocol (OpenAI, Google Gemini's compatible endpoint, Groq,
 *               Mistral, DeepSeek, xAI, OpenRouter, a local Ollama, or any server you point it at).
 *
 * Model names change often, so the model is a free text field; the examples below are only suggestions.
 * A weaker or smaller model follows instructions less reliably, but it cannot do more than a strong one: the tools, the
 * confirmation step and the live-account switch are enforced by this server, not by the model.
 */

const SECRET_ANY = /^\S{8,300}$/;

export const PROVIDERS = {
  anthropic: {
    label: "Anthropic (Claude)", keyEnv: "ANTHROPIC_API_KEY", needsKey: true, keyPattern: /^sk-ant-[A-Za-z0-9_-]{20,}$/,
    keyHint: "Starts with sk-ant-. Get it at console.anthropic.com.", defaultModel: "claude-opus-5-5",
    examples: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"], efforts: true,
  },
  gemini: {
    label: "Google Gemini", keyEnv: "GEMINI_API_KEY", needsKey: true, keyPattern: SECRET_ANY, keyHint: "Get it at aistudio.google.com/apikey.",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", defaultModel: "gemini-2.5-flash", examples: ["gemini-2.5-pro", "gemini-2.5-flash"],
  },
  openai: {
    label: "OpenAI", keyEnv: "OPENAI_API_KEY", needsKey: true, keyPattern: SECRET_ANY, keyHint: "Get it at platform.openai.com/api-keys.",
    baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4.1", examples: ["gpt-4.1", "gpt-4o", "gpt-4o-mini"],
  },
  groq: {
    label: "Groq", keyEnv: "GROQ_API_KEY", needsKey: true, keyPattern: SECRET_ANY, keyHint: "Get it at console.groq.com/keys.",
    baseUrl: "https://api.groq.com/openai/v1", defaultModel: "llama-3.3-70b-versatile", examples: ["llama-3.3-70b-versatile"],
  },
  mistral: {
    label: "Mistral", keyEnv: "MISTRAL_API_KEY", needsKey: true, keyPattern: SECRET_ANY, keyHint: "Get it at console.mistral.ai.",
    baseUrl: "https://api.mistral.ai/v1", defaultModel: "mistral-large-latest", examples: ["mistral-large-latest", "mistral-small-latest"],
  },
  deepseek: {
    label: "DeepSeek", keyEnv: "DEEPSEEK_API_KEY", needsKey: true, keyPattern: SECRET_ANY, keyHint: "Get it at platform.deepseek.com.",
    baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat", examples: ["deepseek-chat"],
  },
  xai: {
    label: "xAI (Grok)", keyEnv: "XAI_API_KEY", needsKey: true, keyPattern: SECRET_ANY, keyHint: "Get it at console.x.ai.",
    baseUrl: "https://api.x.ai/v1", defaultModel: "grok-4", examples: ["grok-4"],
  },
  openrouter: {
    label: "OpenRouter", keyEnv: "OPENROUTER_API_KEY", needsKey: true, keyPattern: SECRET_ANY, keyHint: "Get it at openrouter.ai/keys. One key, many models.",
    baseUrl: "https://openrouter.ai/api/v1", defaultModel: "openai/gpt-4o", examples: ["openai/gpt-4o", "google/gemini-2.5-flash"],
  },
  ollama: {
    label: "Ollama (on your own machine)", keyEnv: null, needsKey: false, keyPattern: SECRET_ANY, keyHint: "Usually no key.",
    baseUrl: "http://127.0.0.1:11434/v1", defaultModel: "llama3.1", examples: ["llama3.1", "qwen2.5"], customUrl: true,
  },
  custom: {
    label: "Other (any compatible server)", keyEnv: null, needsKey: false, keyPattern: SECRET_ANY, keyHint: "Only if your server asks for one.",
    baseUrl: "", defaultModel: "", examples: [], customUrl: true, urlRequired: true,
  },
};

// ---------- Claude ----------

// Models that accept the refusal-fallback option and the effort setting.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
const EFFORT_MODELS = /^claude-(opus|sonnet|fable|mythos)-/;

/**
 * A function `({ system, tools, messages }) => Message` that calls Claude through the SDK `client`.
 * `state.fallbackOff` is shared so that, once the API turns the fallback option down, it is not tried again.
 */
export function anthropicCaller({ client, model, effort, onNote = () => {}, state = { fallbackOff: false } }) {
  return async ({ system, tools, messages }) => {
    const params = { model, max_tokens: 16000, system, tools, messages };
    if (EFFORT_MODELS.test(model) && effort) params.output_config = { effort };
    if (FALLBACK_MODELS.has(model) && !state.fallbackOff) {
      try {
        return await client.beta.messages.create({ ...params, betas: [FALLBACK_BETA], fallbacks: "default" });
      } catch (err) {
        // If the API does not accept the fallback option for this account or model, carry on without it.
        if (err?.status === 400 && /fallback/i.test(String(err.message))) {
          state.fallbackOff = true;
          onNote("Refusal fallback is not available for this model or account; continuing without it.");
        } else throw err;
      }
    }
    return client.messages.create(params);
  };
}

// ---------- everything else: the chat-completions protocol ----------

/** Drop the schema keywords some providers reject. The server validates the arguments itself, so nothing is lost. */
export function simplifySchema(schema) {
  if (Array.isArray(schema)) return schema.map(simplifySchema);
  if (!schema || typeof schema !== "object") return schema;
  const DROP = new Set(["additionalProperties", "pattern", "maxLength", "exclusiveMinimum"]);
  return Object.fromEntries(Object.entries(schema).filter(([k]) => !DROP.has(k)).map(([k, v]) => [k, simplifySchema(v)]));
}

/** Claude-style system + messages -> chat-completions messages. */
export function toChatMessages(system, messages) {
  const out = [{ role: "system", content: system }];
  for (const m of messages) {
    if (typeof m.content === "string") { out.push({ role: m.role, content: m.content }); continue; }
    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const calls = m.content.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      if (text || calls.length) out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    for (const b of m.content) {
      if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id, content: `${b.is_error ? "Error: " : ""}${typeof b.content === "string" ? b.content : JSON.stringify(b.content)}` });
      else if (b.type === "text") out.push({ role: "user", content: b.text });
    }
  }
  return out;
}

const parseArguments = (raw) => {
  try { const v = typeof raw === "string" ? JSON.parse(raw || "{}") : raw; return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
};

/** A chat-completions answer -> a Claude-style message (content blocks and a stop_reason). */
export function fromChatResponse(data) {
  const choice = data?.choices?.[0];
  if (!choice?.message) throw new Error("The model service sent an empty answer.");
  const msg = choice.message;
  const text = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.map((p) => p?.text ?? "").join("") : "";
  const content = [];
  if (text.trim()) content.push({ type: "text", text });
  (msg.tool_calls ?? []).forEach((c, i) => {
    if (c?.function?.name) content.push({ type: "tool_use", id: c.id || `call_${i}`, name: c.function.name, input: parseArguments(c.function.arguments) });
  });
  const calls = content.some((b) => b.type === "tool_use");
  const finish = choice.finish_reason;
  return { content, stop_reason: calls ? "tool_use" : finish === "length" ? "max_tokens" : finish === "content_filter" ? "refusal" : "end_turn" };
}

function explain(label, model, status, data) {
  const detail = String(data?.error?.message ?? data?.[0]?.error?.message ?? data?.message ?? "").slice(0, 200);
  if (status === 401 || status === 403) return `${label} refused the API key.`;
  if (status === 404) return `${label} does not know the model "${model}" (or the address is wrong).`;
  if (status === 429) return `${label} is rate limiting or out of credit: try again in a minute.`;
  return `${label} answered ${status}${detail ? `: ${detail}` : ""}.`;
}

/** A function `({ system, tools, messages }) => Message` for any chat-completions server. */
export function compatCaller({ baseUrl, apiKey = "", model, label = "The model service", fetchFn = fetch, timeoutMs = 120_000 }) {
  const url = `${String(baseUrl).replace(/\/+$/, "")}/chat/completions`;
  return async ({ system, tools, messages }) => {
    const body = { model, messages: toChatMessages(system, messages) };
    if (tools?.length) body.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: simplifySchema(t.input_schema) } }));
    let res;
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Error(err.name === "TimeoutError" ? `${label} took too long to answer.` : `Could not reach ${label} (${err.cause?.code || err.message}).`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(explain(label, model, res.status, data)), { status: res.status });
    return fromChatResponse(data);
  };
}
