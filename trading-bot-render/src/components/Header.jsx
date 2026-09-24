import { useEffect, useState } from "react";

import { tzLabel } from "../../shared/analysis/index.js";
import PairPicker from "./PairPicker.jsx";

const STORAGE_LABELS = { mongodb: "MongoDB", file: "Local files" };

export default function Header({
  symbol,
  price,
  priceDirection,
  connectionOk,
  refreshMs,
  onRefreshChange,
  mode,
  onModeChange,
  storage,
  timeZone = "UTC",
  overview = null,
  market = "spot",
  onMarketChange = () => {},
  onSymbolChange = () => {},
  view = "trading",
  onViewChange = () => {},
  notifications = null,
}) {
  const live = mode === "live";
  const connection = connectionOk === false ? "error" : connectionOk ? "ok" : "pending";
  return (
    <header className={`header ${live ? "live-header" : ""}`}>
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 17l5-6 4 3 8-9" />
            <path d="M15 5h5v5" />
          </svg>
        </span>
        <div className="brand-text">
          <strong>Trading Terminal</strong>
          <span>{market === "futures" ? "Futures · limit entry + stop-loss / take-profit" : "Spot · limit entry + OCO exit"}</span>
        </div>
      </div>

      <div className="segmented view-switch" role="group" aria-label="View">
        <button type="button" className={view === "trading" ? "is-active" : ""} onClick={() => onViewChange("trading")}>Trading</button>
        <button type="button" className={view === "charts" ? "is-active" : ""} onClick={() => onViewChange("charts")}>Charts</button>
        <button type="button" className={view === "stocks" ? "is-active" : ""} onClick={() => onViewChange("stocks")}>My stocks</button>
        <button type="button" className={view === "performance" ? "is-active" : ""} onClick={() => onViewChange("performance")}>Performance</button>
        <button type="button" className={view === "news" ? "is-active" : ""} onClick={() => onViewChange("news")}>News</button>
        <button type="button" className={view === "strategies" ? "is-active" : ""} onClick={() => onViewChange("strategies")}>Strategies</button>
      </div>

      {view === "trading" && <PairPicker symbol={symbol} price={price} priceDirection={priceDirection} overview={overview} market={market} onMarketChange={onMarketChange} onSelect={onSymbolChange} />}

      <div className="status-row">
        <Clock timeZone={timeZone} />
        {notifications}
        {storage && (
          <span className={`pill pill-db ${storage === "mongodb" ? "is-ok" : "is-warn"}`} title={storage === "mongodb" ? "Orders are saved in MongoDB" : "Orders are saved in local files and may be lost on redeploy"}>
            <i /> {STORAGE_LABELS[storage] ?? storage}
          </span>
        )}
        <span className={`pill is-${connection}`}>
          <i /> {connection === "error" ? "Connection lost" : connection === "ok" ? "Connected" : "Connecting…"}
        </span>
        <div className="segmented" role="group" aria-label="Account mode">
          <button type="button" className={!live ? "is-active" : ""} onClick={() => live && onModeChange("paper")} title="Practice with simulated capital against real prices">Paper</button>
          <button type="button" className={live ? "is-active is-live" : ""} onClick={() => !live && onModeChange("live")}>Live</button>
        </div>
        <select className="refresh-select" value={refreshMs} onChange={(e) => onRefreshChange(Number(e.target.value))} aria-label="Refresh interval">
          <option value={10000}>Refresh 10s</option>
          <option value={15000}>Refresh 15s</option>
          <option value={30000}>Refresh 30s</option>
          <option value={60000}>Refresh 60s</option>
        </select>
      </div>
    </header>
  );
}

/** Wall clock in the chart's timezone, plus UTC so it is always clear which one you are looking at. */
function Clock({ timeZone }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const at = (zone) => now.toLocaleTimeString("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  return (
    <span className="pill pill-clock" title={`Chart time zone: ${timeZone}`}>
      <b>{at(timeZone)}</b> <em>{tzLabel(timeZone, now)}</em>
      {timeZone !== "UTC" && <small>· UTC {at("UTC").slice(0, 5)}</small>}
    </span>
  );
}


