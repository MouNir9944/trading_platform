export default function BalancePanel({ balances, symbol = "XLMUSDT" }) {
  const quoteAsset = symbol.endsWith("USDT") ? "USDT" : symbol.slice(-4);
  const baseAsset = symbol.endsWith("USDT") ? symbol.slice(0, -4) : symbol;
  const tracked = [quoteAsset, baseAsset].filter((asset, index, list) => list.indexOf(asset) === index).map((asset) => {
    const found = balances.find((b) => b.asset === asset);
    return { asset, free: found ? parseFloat(found.free) : 0 };
  });

  const otherCount = Math.max(balances.length - tracked.length, 0);

  return (
    <div className="panel">
      <p className="panel-title">Available funds · Paper</p>
      <p className="panel-subtitle">The quote balance limits automatic order size.</p>
      {tracked.map((b) => (
        <div className="balance-row" key={b.asset}>
          <span className={`balance-asset ${b.asset === "USDT" ? "highlight" : ""}`}>{b.asset}</span>
          <span className="balance-amount">{formatAmount(b.free)}</span>
        </div>
      ))}
      {balances.length === 0 && <div className="log-empty">Waiting for balance data…</div>}
      {otherCount > 0 && (
        <p className="balance-note">
          {otherCount} other paper assets are hidden.
        </p>
      )}
    </div>
  );
}

function formatAmount(value) {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
