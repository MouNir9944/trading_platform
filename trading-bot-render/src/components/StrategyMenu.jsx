import { useEffect, useRef, useState } from "react";

import { STRATEGIES, clampParams } from "../../shared/strategies/index.js";
import { DEFAULT_TRADE_SETTINGS, strategyColor, tradeSettingsOf } from "../lib/strategyOverlay.js";
import { useKeepOnScreen } from "../lib/useKeepOnScreen.js";

/** A number box that commits on blur or Enter (so typing "1." or clearing the box never breaks the chart). */
function NumberField({ label, hint, value, min, max, step, onCommit }) {
  const commit = (el) => {
    const n = Number(el.value);
    if (el.value === "" || !Number.isFinite(n)) { el.value = value; return; } // unusable: keep what was there
    const clamped = Math.min(max, Math.max(min, n));
    el.value = clamped;
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <label title={hint}>
      {label}
      <input
        type="number" key={value} defaultValue={value} min={min} max={max} step={step ?? "any"}
        onBlur={(e) => commit(e.target)}
        onKeyDown={(e) => { if (e.key === "Enter") commit(e.currentTarget); }}
      />
    </label>
  );
}

function StrategySettings({ strategy, settings, onChange }) {
  const params = clampParams(strategy, settings?.params);
  const trade = tradeSettingsOf(strategy, settings);
  const setParam = (key, raw) => onChange({ ...settings, params: { ...(settings?.params ?? {}), [key]: raw } });
  const setTrade = (patch) => onChange({ ...settings, trade: { ...DEFAULT_TRADE_SETTINGS, ...(settings?.trade ?? {}), ...patch } });
  return (
    <div className="strat-settings">
      {strategy.params.length > 0 && (
        <>
          <h6>Strategy</h6>
          <div className="strat-fields">
            {strategy.params.map((p) => (
              <NumberField key={p.key} label={p.label} hint={p.hint} value={params[p.key]} min={p.min} max={p.max} step={p.step} onCommit={(raw) => setParam(p.key, raw)} />
            ))}
          </div>
        </>
      )}
      <h6>Trade</h6>
      <div className="strat-fields">
        {strategy.supportsRetest && (
          <label>Entry<select value={trade.entryMode} onChange={(e) => setTrade({ entryMode: e.target.value })}><option value="limit-close">At the signal close</option><option value="retest">On a retest</option></select></label>
        )}
        <label>Target<select value={trade.targetMode} onChange={(e) => setTrade({ targetMode: e.target.value })}><option value="own">The strategy's own</option><option value="r">Multiple of the risk</option></select></label>
        {trade.targetMode === "r" && <NumberField label="Target (× risk)" value={trade.targetR} min={1} max={5} step={0.5} onCommit={(raw) => setTrade({ targetR: raw })} />}
        <NumberField label="Min reward:risk" hint="Signals below this are not drawn" value={trade.minRewardRisk} min={0} max={5} step={0.5} onCommit={(raw) => setTrade({ minRewardRisk: raw })} />
      </div>
      <button type="button" className="link-button" onClick={() => onChange(undefined)}>Reset to defaults</button>
    </div>
  );
}

/**
 * "Strategies" in the chart toolbar: the list of strategies. Tick one to draw its signals (entry, stop, target and the
 * result); a ticked strategy has a ⚙ with its own settings. Colours follow the order in which they were ticked.
 */
export default function StrategyMenu({ selected, onChange, settings = {}, onSettingsChange, summary = [] }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const ref = useRef(null);
  const menuRef = useRef(null);
  useKeepOnScreen(menuRef, open);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => { if (event.type === "keydown" ? event.key === "Escape" : !ref.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [open]);

  const toggle = (id) => {
    if (selected.includes(id)) {
      onChange(selected.filter((x) => x !== id));
      if (editing === id) setEditing(null);
    } else {
      onChange([...selected, id]);
      setEditing(id); // a newly ticked strategy opens its settings
    }
  };
  const setFor = (id) => (next) => {
    const copy = { ...settings };
    if (next === undefined) delete copy[id]; else copy[id] = next;
    onSettingsChange(copy);
  };
  const info = new Map(summary.map((s) => [s.id, s]));

  return (
    <div className="ind-menu-wrap" ref={ref}>
      <button type="button" className={`ind-button${selected.length ? " is-on" : ""}`} aria-expanded={open} onClick={() => setOpen((v) => !v)} title="Show the signals of any strategy on the chart">
        Strategies{selected.length ? ` · ${selected.length}` : ""} <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="ind-menu strat-menu" role="group" aria-label="Strategies on the chart" ref={menuRef}>
          {STRATEGIES.map((s) => {
            const on = selected.includes(s.id);
            const found = info.get(s.id);
            return (
              <div key={s.id} className="strat-menu-row">
                <div className="strat-menu-line">
                  <label className="ind-item strat-menu-item" title={s.summary}>
                    <input type="checkbox" checked={on} onChange={() => toggle(s.id)} />
                    <i className="strat-dot" style={{ background: on ? strategyColor(selected.indexOf(s.id)) : "transparent" }} aria-hidden="true" />
                    <span>{s.name}</span>
                    {on && found && <small>{found.shown ? `${found.shown} shown` : "no signal in view"}</small>}
                  </label>
                  {on && (
                    <button type="button" className={`strat-gear${editing === s.id ? " is-on" : ""}`} aria-label={`${s.name} settings`} aria-expanded={editing === s.id} onClick={() => setEditing(editing === s.id ? null : s.id)} title="Settings">⚙</button>
                  )}
                </div>
                {on && editing === s.id && <StrategySettings strategy={s} settings={settings[s.id]} onChange={setFor(s.id)} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
