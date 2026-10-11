/**
 * Speech to text for Telegram voice messages. Works with any service that offers the OpenAI-style
 * `POST {base}/audio/transcriptions`: OpenAI, Groq, or a Whisper server you run yourself.
 *
 *   STT_API_KEY   (or OPENAI_API_KEY)   the key; without one, voice messages are politely declined
 *   STT_BASE_URL  default https://api.openai.com/v1      (Groq: https://api.groq.com/openai/v1)
 *   STT_MODEL     default whisper-1                      (Groq: whisper-large-v3-turbo)
 */
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024; // Telegram's own limit for bots downloading a file

export function createStt({ env = process.env, fetchFn = fetch, timeoutMs = 60_000 } = {}) {
  const key = env.STT_API_KEY || env.OPENAI_API_KEY || "";
  const base = (env.STT_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = env.STT_MODEL || "whisper-1";

  return {
    configured: Boolean(key),
    model,
    base,
    /** Audio bytes -> the words spoken. Throws an Error whose message is safe to show the user. */
    async transcribe(audio, { filename = "voice.ogg", mime = "audio/ogg", language = "" } = {}) {
      if (!key) throw new Error("Voice messages need a speech-to-text key (STT_API_KEY) on the server.");
      if (!audio?.byteLength) throw new Error("The voice message was empty.");
      const form = new FormData();
      form.append("file", new Blob([audio], { type: mime }), filename);
      form.append("model", model);
      form.append("response_format", "json");
      if (/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(language)) form.append("language", language.slice(0, 2).toLowerCase());
      let res;
      try {
        res = await fetchFn(`${base}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        throw new Error(err.name === "TimeoutError" ? "The speech-to-text service took too long." : `Could not reach the speech-to-text service (${err.cause?.code || err.message}).`);
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) throw new Error("The speech-to-text key was refused.");
        if (res.status === 429) throw new Error("The speech-to-text service is rate limiting: try again in a minute.");
        throw new Error(`The speech-to-text service answered ${res.status}${data?.error?.message ? `: ${String(data.error.message).slice(0, 120)}` : ""}.`);
      }
      const text = String(data.text ?? "").trim();
      if (!text) throw new Error("I could not make out any words in that voice message.");
      return text;
    },
  };
}
