export default function SignalPanel({ signalData, capital, onCapitalChange }) {
  const signal = signalData?.signal ?? "HOLD";
  const sizing = signalData?.position_sizing;

  return (
    <div className="panel">
      <p className="panel-title">Strategy guidance</p>
      <p className="panel-subtitle">Read-only MA 9/21 breakout signal. It does not place orders.</p>
      <div className={`signal-word ${signal}`}>{signal}</div>

      <div className="field-row">
        <span className="field-label">Pair</span>
        <span className="field-value">{signalData?.symbol ?? "—"}</span>
      </div>
      <div className="field-row">
        <span className="field-label">Interval</span>
        <span className="field-value">{signalData?.interval ?? "—"}</span>
      </div>
      <div className="field-row">
        <span className="field-label">Rule</span>
        <span className="field-value">MA 9/21 + breakout</span>
      </div>

      {sizing && (
        <>
          <div className="field-row">
            <span className="field-label">Entry</span>
            <span className="field-value">{sizing.entry_price}</span>
          </div>
          <div className="field-row">
            <span className="field-label">Stop-loss</span>
            <span className="field-value">{sizing.stop_loss_price}</span>
          </div>
          <div className="field-row">
            <span className="field-label">Take-profit</span>
            <span className="field-value">{sizing.take_profit_price}</span>
          </div>
          <div className="field-row">
            <span className="field-label">Quantity</span>
            <span className="field-value">{sizing.quantity}</span>
          </div>
        </>
      )}

      <div className="capital-input-row">
        <label className="capital-input-label" htmlFor="capital">
          Strategy simulation capital (USDT)
        </label>
        <input
          id="capital"
          className="capital-input"
          type="number"
          value={capital}
          min={0}
          onChange={(e) => onCapitalChange(Number(e.target.value))}
        />
      </div>
    </div>
  );
}
