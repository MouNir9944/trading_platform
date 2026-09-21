import { LUX_SETTINGS_DEFAULTS } from "../lib/luxOverlay.js";

// Field components live at module level so React keeps the same element while you type.
function Check({ settings, set, field, label, hint }) {
  return (
    <label className="lx-check" title={hint}>
      <input type="checkbox" checked={settings[field]} onChange={(e) => set({ [field]: e.target.checked })} />
      <span>{label}</span>
    </label>
  );
}

function Pick({ settings, set, field, label, options, hint }) {
  return (
    <label className="lx-field" title={hint}>
      <span>{label}</span>
      <select value={settings[field]} onChange={(e) => set({ [field]: e.target.value })}>
        {options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
      </select>
    </label>
  );
}

function Num({ settings, set, field, label, min, max, step = 1, hint }) {
  return (
    <label className="lx-field" title={hint}>
      <span>{label}</span>
      <input
        type="number" min={min} max={max} step={step} defaultValue={settings[field]} key={`${field}:${settings[field]}`}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (e.target.value !== "" && Number.isFinite(n) && n >= min && n <= max) set({ [field]: n });
        }}
      />
    </label>
  );
}

const STRUCTURE = [["all", "All"], ["BOS", "BOS"], ["CHoCH", "CHoCH"]];

/**
 * Settings for the LuxAlgo-style Smart Money Concepts overlay. Options mirror the original indicator's inputs.
 * Original indicator: (c) LuxAlgo, CC BY-NC-SA 4.0.
 */
export default function LuxSettings({ settings, onChange, onClose }) {
  const set = (patch) => onChange({ ...settings, ...patch });
  const p = { settings, set };

  return (
    <div className="lux-panel" role="dialog" aria-label="Smart Money Concepts settings">
      <div className="lx-head">
        <strong>Smart Money Concepts</strong>
        <button type="button" className="lx-close" onClick={onClose} aria-label="Close">×</button>
      </div>

      <h4>Display</h4>
      <div className="lx-grid">
        <Pick {...p} field="mode" label="Mode" options={[["historical", "Historical"], ["present", "Present"]]} hint="Show all structure on screen, or only the most recent." />
        <Pick {...p} field="style" label="Style" options={[["colored", "Colored"], ["mono", "Monochrome"]]} />
        <Check {...p} field="trendCandles" label="Color candles by internal trend" />
      </div>

      <h4>Market structure</h4>
      <div className="lx-grid">
        <Check {...p} field="showInternal" label="Internal structure" hint="Short-range structure (5-bar pivots), dashed lines" />
        <Pick {...p} field="internalBull" label="Bullish" options={STRUCTURE} />
        <Pick {...p} field="internalBear" label="Bearish" options={STRUCTURE} />
        <Check {...p} field="showSwing" label="Swing structure" hint="Large-range structure, solid lines" />
        <Pick {...p} field="swingBull" label="Bullish" options={STRUCTURE} />
        <Pick {...p} field="swingBear" label="Bearish" options={STRUCTURE} />
        <Num {...p} field="swingLength" label="Swing length" min={10} max={100} hint="Bars either side needed to confirm a swing pivot (original default 50)" />
        <Check {...p} field="showSwingPoints" label="Swing points (HH, LH, HL, LL)" />
        <Check {...p} field="showStrongWeak" label="Strong / weak high & low" />
        <Check {...p} field="confluenceFilter" label="Confluence filter" hint="Ignore internal breaks whose candle wick points the wrong way" />
      </div>

      <h4>Order blocks</h4>
      <div className="lx-grid">
        <Check {...p} field="internalOrderBlocks" label="Internal order blocks" />
        <Num {...p} field="internalOrderBlocksCount" label="How many" min={1} max={20} />
        <Check {...p} field="swingOrderBlocks" label="Swing order blocks" />
        <Num {...p} field="swingOrderBlocksCount" label="How many" min={1} max={20} />
        <Pick {...p} field="obFilter" label="Filter" options={[["atr", "ATR"], ["range", "Cumulative mean range"]]} hint="How volatile candles are recognised so they cannot define a block" />
        <Pick {...p} field="obMitigation" label="Mitigation" options={[["highlow", "High/Low"], ["close", "Close"]]} hint="What counts as price breaking through a block" />
      </div>

      <h4>Other</h4>
      <div className="lx-grid">
        <Check {...p} field="showEqual" label="Equal highs / lows (EQH, EQL)" />
        <Num {...p} field="equalThreshold" label="EQH/EQL threshold" min={0} max={0.5} step={0.1} hint="Lower = fewer, more exact equal levels" />
        <Check {...p} field="showFvg" label="Fair value gaps" hint="Only significant gaps: the middle candle must be large and close beyond the first candle" />
        <Check {...p} field="showZones" label="Premium / Discount zones" />
        <Check {...p} field="levelsD" label="Previous day high / low" />
        <Check {...p} field="levelsW" label="Previous week high / low" />
        <Check {...p} field="levelsM" label="Previous month high / low" />
      </div>

      <div className="lx-foot">
        <button type="button" className="mini-button" onClick={() => onChange({ ...LUX_SETTINGS_DEFAULTS, enabled: settings.enabled })}>Reset to defaults</button>
        <p>
          Based on <b>Smart Money Concepts [LuxAlgo]</b> © LuxAlgo, licensed <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noreferrer">CC BY-NC-SA 4.0</a>:
          credit required, non-commercial use only, share-alike. An interpretation of price action, not advice.
        </p>
      </div>
    </div>
  );
}
