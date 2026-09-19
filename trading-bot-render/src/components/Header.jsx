export default function Header({ symbol, price, priceDirection, connectionOk, refreshMs, onRefreshChange, mode, onModeChange }) {
  return (
    <div className={`header ${mode === "live" ? "live-header" : ""}`}>
      <div className="pair-block">
        <span className="pair-name">{formatSymbol(symbol)}</span>
        <span className={`pair-price ${priceDirection ? `tick-${priceDirection}` : ""}`}>
          {price != null ? price.toFixed(4) : "—"}
        </span>
      </div>
      <div className="status-row">
        <span className={`status-dot ${connectionOk === false ? "error" : connectionOk ? "live" : ""}`} />
        <span>{connectionOk === false ? "Connection lost" : connectionOk ? `${mode === "live" ? "Live" : "Testnet"} connected` : "Connecting…"}</span>
        <button className={`mode-button ${mode === "live" ? "live-mode" : ""}`} type="button" onClick={() => onModeChange(mode === "live" ? "testnet" : "live")}>
          {mode === "live" ? "Switch to Testnet" : "Switch to Live"}
        </button>
        <select
          className="refresh-select"
          value={refreshMs}
          onChange={(e) => onRefreshChange(Number(e.target.value))}
        >
          <option value={10000}>Refresh: 10s</option>
          <option value={15000}>Refresh: 15s</option>
          <option value={30000}>Refresh: 30s</option>
          <option value={60000}>Refresh: 60s</option>
        </select>
      </div>
    </div>
  );
}

function formatSymbol(symbol) {
  // XLMUSDT -> XLM/USDT
  if (symbol.endsWith("USDT")) {
    return `${symbol.slice(0, -4)}/USDT`;
  }
  return symbol;
}
