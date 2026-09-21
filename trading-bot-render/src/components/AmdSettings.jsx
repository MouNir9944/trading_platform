import { AMD_SETTINGS_DEFAULTS } from "../lib/amdOverlay.js";

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

/** Settings for the AMD indicator: Accumulation, Manipulation, FVG (the signal), Distribution. */
export default function AmdSettings({ settings, onChange, onClose }) {
  const set = (patch) => onChange({ ...settings, ...patch });
  const p = { settings, set };
  return (
    <div className="lux-panel amd-panel" role="dialog" aria-label="AMD settings">
      <div className="lx-head">
        <strong>AMD · Accumulation, Manipulation, FVG, Distribution</strong>
        <button type="button" className="lx-close" onClick={onClose} aria-label="Close">×</button>
      </div>
      <p className="lx-note">
        Shown only when the stages happen in this order: a tight range, a sweep of one side that comes back, then a
        strong candle leaving a fair value gap. The gap is the signal. Distribution is the move to the far side of the range.
      </p>

      <h4>Display</h4>
      <div className="lx-grid">
        <Pick {...p} field="direction" label="Direction" options={[["both", "Both"], ["bull", "Bullish only"], ["bear", "Bearish only"]]} />
        <Pick {...p} field="show" label="Show" options={[["all", "As soon as the FVG forms"], ["completed", "Only completed"]]} hint="Completed = distribution reached. That is only known after the fact." />
        <Num {...p} field="maxSetups" label="How many" min={1} max={20} hint="Most recent setups on screen" />
        <Check {...p} field="showFailed" label="Also show failed setups" hint="Price closed beyond the sweep before reaching the target" />
        <Check {...p} field="showPlan" label="Entry / stop lines for the live setup" />
      </div>

      <p className="lx-note">Alerts and automatic orders for this indicator now run on the server, with every tab closed: open the <b>AMD Bot</b> screen from the header.</p>

      <h4>Sensitivity</h4>
      <div className="lx-grid">
        <Num {...p} field="minRangeBars" label="Min range candles" min={4} max={40} hint="How long the accumulation must last" />
        <Num {...p} field="maxRangeAtr" label="Max range height (ATR)" min={1.5} max={6} step={0.5} hint="Taller ranges are not accumulation" />
        <Num {...p} field="minRewardRisk" label="Min reward : risk" min={0} max={5} step={0.5} hint="The far side of the range must still be this many R away when the gap forms (0 = off)" />
      </div>

      <div className="lx-foot">
        <button type="button" className="mini-button" onClick={() => onChange({ ...AMD_SETTINGS_DEFAULTS, enabled: settings.enabled })}>Reset to defaults</button>
        <p>An interpretation of price action, not advice. Roughly half of the setups fail: run the "AMD: sweep then fair value gap" backtest before trusting it.</p>
      </div>
    </div>
  );
}
