import { useCallback, useEffect, useMemo, useState } from "react";

import { getAgent, saveAgent, saveAgentSecrets, testAgentTelegram, tryAgent } from "../api.js";

const EFFORTS = [["low", "Quick"], ["medium", "Balanced"], ["high", "Thorough"]];
const LANGUAGES = [["", "Detect automatically"], ["en", "English"], ["fr", "Français"], ["ar", "العربية"], ["es", "Español"], ["de", "Deutsch"], ["it", "Italiano"], ["pt", "Português"], ["tr", "Türkçe"]];
const KIND_GROUPS = [
  ["read", "Look things up", "Prices, analysis, balances, orders, risk, news and company analysis. Nothing changes."],
  ["safe", "Favorites", "Add or remove favorite pairs and stocks."],
  ["trade", "Orders", "The agent can only propose these. You confirm each one with a button in Telegram."],
];
const TIME = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", day: "numeric", month: "short" });

const sameConfig = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const label = (name) => name.replace(/_/g, " ");

function Step({ done, children }) {
  return (
    <li className={`agent-step${done ? " is-done" : ""}`}>
      <span className="agent-step-mark" aria-hidden="true">{done ? "✓" : "○"}</span>
      <div>{children}</div>
    </li>
  );
}

/**
 * One key: shows whether it is set (never the key), and lets you paste, replace or remove it. Saved on its own, at once,
 * because a key is not part of the settings below it.
 */
function KeyField({ name, info, spec, canStore, busy, onSave }) {
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(false);
  const showInput = !info.set || editing;
  const submit = async () => { if (await onSave(name, value.trim())) { setValue(""); setEditing(false); } };
  return (
    <div className="agent-key">
      {info.set && !editing && (
        <div className="agent-key-set">
          <span className="agent-key-ok">{info.source === "page" ? `Saved ${info.hint}` : "Set on the server"}</span>
          <button type="button" className="link-button" onClick={() => setEditing(true)} disabled={!canStore}>Replace</button>
          {info.source === "page" && <button type="button" className="link-button" onClick={() => onSave(name, "")} disabled={busy}>Remove</button>}
        </div>
      )}
      {showInput && canStore && (
        <div className="agent-row">
          <input type="password" autoComplete="off" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && value.trim()) submit(); }} placeholder={spec.hint} aria-label={spec.label} />
          <button type="button" className="secondary-button" onClick={submit} disabled={busy || !value.trim()}>Save key</button>
          {editing && <button type="button" className="link-button" onClick={() => { setEditing(false); setValue(""); }}>Cancel</button>}
        </div>
      )}
      {showInput && !canStore && <p className="agent-bad">To save keys here, set <code>APP_PASSWORD</code> on the server (keys are encrypted with it).{spec.env ? <> Or set <code>{spec.env}</code> there instead.</> : null}</p>}
      {info.source === "unreadable" && <p className="agent-bad">A saved key could not be opened because the dashboard password changed. Paste it again.</p>}
    </div>
  );
}

/** One agent: its name, provider, model and key. Edits are part of the settings below and are saved with them. */
function AgentCard({ agent, saved, provider, providers, active, canRemove, canStore, busy, onChange, onActivate, onRemove, onSaveKey }) {
  const listId = `models-${agent.id}`;
  return (
    <div className={`agent-card${active ? " is-active" : ""}`}>
      <div className="agent-card-head">
        <label className="agent-active"><input type="radio" name="agent-active" checked={active} onChange={onActivate} /> {active ? "Active" : "Use this one"}</label>
        <input className="agent-name" value={agent.name} maxLength={40} onChange={(e) => onChange({ name: e.target.value })} aria-label="Agent name" />
        {canRemove && <button type="button" className="link-button" onClick={onRemove}>Remove</button>}
      </div>
      <div className="agent-card-grid">
        <label className="agent-field">Provider
          <select value={agent.provider} onChange={(e) => onChange({ provider: e.target.value, model: providers[e.target.value].defaultModel, baseUrl: "" })}>
            {Object.entries(providers).map(([id, p]) => <option key={id} value={id}>{p.label}</option>)}
          </select>
        </label>
        <label className="agent-field">Model
          <input value={agent.model} list={listId} onChange={(e) => onChange({ model: e.target.value })} spellCheck={false} placeholder={provider.defaultModel || "model name"} />
          <datalist id={listId}>{provider.examples.map((m) => <option key={m} value={m} />)}</datalist>
        </label>
        {provider.efforts && (
          <label className="agent-field">How much it thinks
            <select value={agent.effort} onChange={(e) => onChange({ effort: e.target.value })}>{EFFORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </label>
        )}
        {provider.customUrl && (
          <label className="agent-field agent-url">Server address{provider.urlRequired ? "" : " (optional)"}
            <input value={agent.baseUrl} onChange={(e) => onChange({ baseUrl: e.target.value })} spellCheck={false} placeholder={provider.baseUrl || "https://your-server/v1"} />
          </label>
        )}
      </div>
      {(provider.needsKey || provider.customUrl) && (
        saved ? (
          <div className="agent-card-key">
            <span className="agent-hint">API key{provider.needsKey ? "" : " (only if your server asks for one)"}:</span>
            <KeyField name={`agent:${agent.id}`} info={saved.key.source === "none" ? { set: false, source: null, hint: null } : saved.key} spec={{ label: `${agent.name} API key`, hint: provider.keyHint, env: provider.keyEnv }} canStore={canStore} busy={busy} onSave={onSaveKey} />
            {saved.key.source === "environment" && <span className="agent-hint">Using <code>{provider.keyEnv}</code> from the server.</span>}
          </div>
        ) : <p className="agent-hint">Save your changes first, then paste this agent's key here. {provider.keyHint}</p>
      )}
      {!provider.needsKey && !provider.customUrl && <p className="agent-hint">No key needed.</p>}
    </div>
  );
}

function CopyBlock({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="agent-code">
      <pre>{text}</pre>
      <button type="button" className="link-button" onClick={() => { navigator.clipboard?.writeText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }); }}>{copied ? "Copied" : "Copy"}</button>
    </div>
  );
}

/**
 * One page to set up the AI agent and its Telegram bot: what you still need to do (the secrets live on the server, not
 * here), who may talk to the bot, which model it uses, what it may do, voice messages, a place to try it, how to use the
 * same tools from Claude Desktop or Claude Code, and a log of what it did.
 */
export default function AgentPanel() {
  const [status, setStatus] = useState(null);
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null); // "save" | "test" | "try"
  const [notice, setNotice] = useState(null);
  const [idInput, setIdInput] = useState("");
  const [liveWord, setLiveWord] = useState("");
  const [question, setQuestion] = useState("");
  const [reply, setReply] = useState(null);
  const [tryId, setTryId] = useState("");

  const load = useCallback(() => getAgent().then((s) => { setStatus(s); setDraft((d) => d ?? s.config); setError(null); }).catch((err) => setError(err.message)), []);
  useEffect(() => {
    load();
    const id = window.setInterval(load, 10_000); // the bot's state and the log keep moving
    return () => window.clearInterval(id);
  }, [load]);

  const saved = status?.config;
  const dirty = draft && saved && !sameConfig(draft, saved);
  const turningOnLive = Boolean(draft?.allowLive && saved && !saved.allowLive);
  const canSave = dirty && busy == null && (!turningOnLive || liveWord === "LIVE");
  const set = (patch) => { setDraft((d) => ({ ...d, ...patch })); setNotice(null); };

  const toolOn = (name) => draft?.tools?.[name] !== false;
  const setTool = (name, on) => set({ tools: Object.fromEntries(Object.entries({ ...draft.tools, [name]: on }).filter(([, v]) => v === false)) });

  const updateAgent = (id, patch) => set({ agents: draft.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)) });
  const removeAgent = (id) => {
    const agents = draft.agents.filter((a) => a.id !== id);
    set({ agents, activeAgentId: draft.activeAgentId === id ? agents[0].id : draft.activeAgentId });
  };
  const addAgent = () => {
    const first = status.providers.gemini;
    const id = (crypto.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^a-z0-9]/g, "").slice(0, 8).padEnd(8, "x");
    set({ agents: [...draft.agents, { id, name: "Gemini", provider: "gemini", model: first.defaultModel, baseUrl: "", effort: "medium" }] });
  };

  const addId = () => {
    const id = idInput.trim();
    if (!/^\d{3,15}$/.test(id)) { setError("A Telegram user ID is a number, such as 123456789."); return; }
    setError(null);
    if (!draft.allowedUserIds.includes(id)) set({ allowedUserIds: [...draft.allowedUserIds, id] });
    setIdInput("");
  };

  const run = async (kind, work) => {
    setBusy(kind);
    setError(null);
    try { await work(); } catch (err) { setError(err.message); } finally { setBusy(null); }
  };

  const save = () => run("save", async () => {
    const next = await saveAgent({ ...draft, ...(turningOnLive ? { confirmLive: liveWord } : {}) });
    setStatus(next);
    setDraft(next.config);
    setLiveWord("");
    setNotice(next.config.enabled ? (next.bot.running ? `Saved. The bot is running as @${next.bot.username}.` : `Saved, but the bot is not running: ${next.bot.error ?? "see the checklist"}`) : "Saved. The agent is switched off.");
  });
  const saveKey = async (name, value) => {
    setBusy("key");
    setError(null);
    try {
      const agentId = name.startsWith("agent:") ? name.slice(6) : null;
      const next = await saveAgentSecrets(agentId ? { agents: { [agentId]: value } } : { [name]: value });
      setStatus(next);
      const label = agentId ? `${draft.agents.find((a) => a.id === agentId)?.name ?? "Agent"} API key` : status.secretLabels[name].label;
      setNotice(value ? `${label} saved.` : `${label} removed.`);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusy(null);
    }
  };
  const sendTest = () => run("test", async () => { const r = await testAgentTelegram(); setNotice(`Test message sent to Telegram user ${r.sentTo}. Check your phone.`); });
  const ask = () => run("try", async () => { setReply(null); setReply(await tryAgent(question, tryId || undefined)); });

  const origin = typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:8000";
  const mcpCommand = `claude mcp add trading-platform \\\n  --env PLATFORM_URL=${origin} \\\n  --env APP_USERNAME=admin \\\n  --env APP_PASSWORD=YOUR_DASHBOARD_PASSWORD \\\n  -- node /path/to/trading-bot-render/server/mcp.js`;
  const mcpJson = useMemo(() => JSON.stringify({
    mcpServers: { "trading-platform": { command: "node", args: ["/path/to/trading-bot-render/server/mcp.js"], env: { PLATFORM_URL: origin, APP_USERNAME: "admin", APP_PASSWORD: "YOUR_DASHBOARD_PASSWORD" } } },
  }, null, 2), [origin]);

  if (!status || !draft) return <div className="agent-view"><section className="panel"><p className="log-empty">{error ?? "Loading the agent settings…"}</p></section></div>;

  const { secrets, bot } = status;
  const activeSaved = status.agents.find((a) => a.id === status.config.activeAgentId);
  const tryTarget = status.agents.find((a) => a.id === (tryId || status.config.activeAgentId));
  const groups = KIND_GROUPS.map(([kind, title, note]) => ({ kind, title, note, tools: status.tools.filter((t) => t.kind === kind) }));

  return (
    <div className="agent-view">
      {error && <p className="order-error agent-error">{error}</p>}

      <section className="panel agent-wide">
        <div className="panel-heading">
          <div>
            <p className="panel-title">AI agent &amp; Telegram bot</p>
            <p className="panel-subtitle">Talk to your platform from Telegram, by text or voice. It looks things up for you and proposes orders; nothing is sent until you press Confirm.</p>
          </div>
          <span className={`agent-pill ${bot.running ? "is-on" : "is-off"}`}>{bot.running ? `Running${bot.username ? ` · @${bot.username}` : ""}` : "Not running"}</span>
        </div>
        <ol className="agent-steps">
          <Step done={secrets.telegram.set}>
            <strong>Telegram bot token.</strong> In Telegram, open <b>@BotFather</b>, send <code>/newbot</code>, and paste the token it gives you.
            <KeyField name="telegram" info={secrets.telegram} spec={status.secretLabels.telegram} canStore={status.canStoreKeys} busy={busy != null} onSave={saveKey} />
          </Step>
          <Step done={Boolean(activeSaved?.key.set)}>
            <strong>An AI agent with its API key.</strong> Under “Agents” below, choose a provider (Claude, Gemini, OpenAI, …) and paste its key.{activeSaved && !activeSaved.key.set ? <span className="agent-bad"> “{activeSaved.name}” has no key yet.</span> : null}
          </Step>
          <Step done={status.allowedCount > 0}>
            <strong>Your Telegram user ID.</strong> Send any message to your bot: it replies with your ID. Add it under “Who can talk to the bot”.
          </Step>
          <Step done={bot.running}>
            <strong>Switch it on</strong> and press Save.{bot.error ? <span className="agent-bad"> {bot.error}</span> : null}
          </Step>
          <Step done={secrets.speech.set}>
            <strong>Voice messages (optional).</strong> Paste a speech-to-text key (OpenAI by default, using <code>{status.speech.model}</code>).
            <KeyField name="speech" info={secrets.speech} spec={status.secretLabels.speech} canStore={status.canStoreKeys} busy={busy != null} onSave={saveKey} />
          </Step>
        </ol>
        <p className="agent-hint">Keys are write-only: once saved they are stored encrypted on the server and are never shown again, only the last four characters. You can also set them as environment variables on the server instead.</p>
      </section>

      <section className="panel agent-wide">
        <div className="panel-heading">
          <div><p className="panel-title">Agents</p><p className="panel-subtitle">Set up as many as you like (up to {status.maxAgents}), each with its own provider, model and key. The active one answers; in Telegram, <code>/agent</code> switches it for that chat.</p></div>
          <button type="button" className="secondary-button" onClick={addAgent} disabled={draft.agents.length >= status.maxAgents}>Add an agent</button>
        </div>
        <div className="agent-cards">
          {draft.agents.map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              saved={status.agents.find((x) => x.id === a.id && x.provider === a.provider)}
              provider={status.providers[a.provider]}
              providers={status.providers}
              active={draft.activeAgentId === a.id}
              canRemove={draft.agents.length > 1}
              canStore={status.canStoreKeys}
              busy={busy != null}
              onChange={(patch) => updateAgent(a.id, patch)}
              onActivate={() => set({ activeAgentId: a.id })}
              onRemove={() => removeAgent(a.id)}
              onSaveKey={saveKey}
            />
          ))}
        </div>
        <p className="agent-hint">Every agent follows the same rules: orders are only ever proposed and need your confirmation, nothing runs on the live account unless you allow it, and the agent cannot change the account mode, risk rules or bots. Smaller or local models follow instructions less reliably, but they cannot do more than a strong one.</p>
        <label className="agent-field">Your own instructions for every agent (optional)
          <textarea rows={3} maxLength={2000} value={draft.instructions} onChange={(e) => set({ instructions: e.target.value })} placeholder="For example: answer in French. I trade mostly BTC and ETH. Never suggest more than 2% risk per trade." />
        </label>
        <span className="agent-hint">{draft.instructions.length} / 2000. The safety rules cannot be overridden by these.</span>
      </section>

      <section className="panel">
        <div className="panel-heading"><div><p className="panel-title">Who can talk to the bot</p><p className="panel-subtitle">Only these Telegram accounts, and only in a private chat. Everyone else is ignored.</p></div></div>
        <label className="switch agent-big-switch"><input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Agent switched on</label>
        <div className="agent-ids">
          {draft.allowedUserIds.length === 0 && <span className="agent-hint">Nobody yet.</span>}
          {draft.allowedUserIds.map((id) => (
            <span className="agent-id" key={id}>{id}<button type="button" aria-label={`Remove ${id}`} onClick={() => set({ allowedUserIds: draft.allowedUserIds.filter((x) => x !== id) })}>✕</button></span>
          ))}
        </div>
        <div className="agent-row">
          <input value={idInput} onChange={(e) => setIdInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addId(); }} placeholder="Telegram user ID, e.g. 123456789" inputMode="numeric" aria-label="Telegram user ID" />
          <button type="button" className="secondary-button" onClick={addId}>Add</button>
        </div>
        <div className="agent-row">
          <button type="button" className="secondary-button" onClick={sendTest} disabled={busy != null || dirty || !secrets.telegram.set || status.allowedCount === 0} title={dirty ? "Save your changes first" : "Send a message to the first allowed user"}>{busy === "test" ? "Sending…" : "Send a test message"}</button>
          <span className="agent-hint">Open your bot in Telegram and press Start once, or Telegram will not deliver it.</span>
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading"><div><p className="panel-title">Voice messages</p><p className="panel-subtitle">Send a voice note and it is turned into text first. You see what it heard before it acts.</p></div></div>
        <label className="switch agent-big-switch"><input type="checkbox" checked={draft.voice.enabled} onChange={(e) => set({ voice: { ...draft.voice, enabled: e.target.checked } })} /> Understand voice messages</label>
        <label className="agent-field">Language you speak
          <select value={draft.voice.language} onChange={(e) => set({ voice: { ...draft.voice, language: e.target.value } })}>{LANGUAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        {!secrets.speech.set && <p className="agent-bad">No speech-to-text key yet: paste one in the checklist at the top.</p>}
      </section>

      <section className="panel agent-wide">
        <div className="panel-heading"><div><p className="panel-title">What the agent may do</p><p className="panel-subtitle">It can never change the account mode, the risk rules or the automatic bots, whatever you tick here.</p></div></div>
        <div className="agent-tool-groups">
          {groups.map((g) => (
            <div key={g.kind} className="agent-tool-group">
              <h4>{g.title}</h4>
              <p className="agent-hint">{g.note}</p>
              {g.kind === "trade" && (
                <div className="agent-trade-switches">
                  <label className="switch agent-big-switch"><input type="checkbox" checked={draft.allowTrading} onChange={(e) => set({ allowTrading: e.target.checked, ...(e.target.checked ? {} : { allowLive: false }) })} /> Let the agent propose orders</label>
                  <label className={`switch agent-big-switch${draft.allowTrading ? "" : " is-disabled"}`}><input type="checkbox" disabled={!draft.allowTrading} checked={draft.allowLive} onChange={(e) => set({ allowLive: e.target.checked })} /> Also on the LIVE account (real money)</label>
                  {turningOnLive && (
                    <label className="agent-field agent-live-confirm">Type <b>LIVE</b> to allow orders with real money from Telegram
                      <input value={liveWord} onChange={(e) => setLiveWord(e.target.value)} placeholder="LIVE" aria-label="Type LIVE to confirm" />
                    </label>
                  )}
                  {!draft.allowTrading && <p className="agent-hint">Off: the agent can look but not trade. On a paper account you can test everything safely first.</p>}
                </div>
              )}
              <ul>
                {g.tools.map((t) => (
                  <li key={t.name} title={t.description}>
                    <label className="switch"><input type="checkbox" checked={toolOn(t.name)} disabled={g.kind === "trade" && !draft.allowTrading} onChange={(e) => setTool(t.name, e.target.checked)} /> {label(t.name)}</label>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section className="panel agent-wide">
        <div className="panel-heading"><div><p className="panel-title">Try it here</p><p className="panel-subtitle">Ask the agent something without Telegram. Orders are shown, never sent. Uses your saved settings.</p></div></div>
        <div className="agent-row">
          <select value={tryId} onChange={(e) => setTryId(e.target.value)} aria-label="Which agent to ask">
            <option value="">Active agent{activeSaved ? ` (${activeSaved.name})` : ""}</option>
            {status.agents.filter((a) => !a.active).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <input value={question} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && question.trim() && busy == null) ask(); }} placeholder="e.g. What's the BTCUSDT trend on 4h?" aria-label="Ask the agent" maxLength={2000} />
          <button type="button" className="primary-button agent-ask" onClick={ask} disabled={busy != null || !question.trim() || !tryTarget?.key.set}>{busy === "try" ? "Thinking…" : "Ask"}</button>
        </div>
        {tryTarget && !tryTarget.key.set && <p className="agent-bad">“{tryTarget.name}” needs its API key first (see Agents above).</p>}
        {reply && (
          <div className="agent-reply">
            {reply.agent && <p className="agent-hint">Answer from {reply.agent}</p>}
            <p>{reply.text}</p>
            {reply.wouldAskToConfirm.length > 0 && <div className="agent-would"><b>It would ask you to confirm:</b><ul>{reply.wouldAskToConfirm.map((s) => <li key={s}>{s}</li>)}</ul></div>}
          </div>
        )}
      </section>

      <section className="panel agent-wide">
        <div className="panel-heading"><div><p className="panel-title">Use the same tools from Claude Desktop or Claude Code (MCP)</p><p className="panel-subtitle">Read-only by default. Run this on the computer where Claude is installed, with this project's folder on it.</p></div></div>
        <p className="agent-hint">Claude Code:</p>
        <CopyBlock text={mcpCommand} />
        <p className="agent-hint">Claude Desktop (add to its config file):</p>
        <CopyBlock text={mcpJson} />
        <p className="agent-hint">Replace the password and the path. To allow orders too, add <code>MCP_ALLOW_TRADING=1</code> to its environment: each order then asks you to confirm in Claude, and nothing is sent on the live account unless you also add <code>MCP_ALLOW_LIVE=1</code>.</p>
      </section>

      <section className="panel agent-wide">
        <div className="panel-heading"><div><p className="panel-title">What it has done</p><p className="panel-subtitle">The last actions: who asked what kind of thing, which tools ran, confirmed and cancelled orders. Message text is not recorded.</p></div></div>
        {status.log.length === 0 ? <p className="log-empty">Nothing yet.</p> : (
          <table className="agent-log">
            <tbody>
              {status.log.map((e, i) => (
                <tr key={`${e.at}-${i}`} className={`is-${e.type}`}>
                  <td>{TIME.format(e.at)}</td><td><b>{e.type.replace(/_/g, " ")}</b></td><td>{e.user ?? ""}</td><td>{e.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className={`agent-savebar${dirty ? " is-dirty" : ""}`}>
        <span>{dirty ? (turningOnLive && liveWord !== "LIVE" ? "Type LIVE above to allow real-money orders, then save." : "You have unsaved changes.") : (notice ?? "All changes saved.")}</span>
        {dirty && <button type="button" className="secondary-button" onClick={() => { setDraft(saved); setLiveWord(""); }} disabled={busy != null}>Undo</button>}
        <button type="button" className="primary-button" onClick={save} disabled={!canSave}>{busy === "save" ? "Saving…" : "Save changes"}</button>
      </div>
    </div>
  );
}
