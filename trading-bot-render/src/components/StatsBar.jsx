const OPEN_STATUSES = ["WAITING_ENTRY", "PROTECTED", "MODIFYING"];

/** Performance summary computed from the saved order history for the active account. */
export default function StatsBar({ orders, risk = null }) {
  const closed = orders.filter((order) => order.status === "CLOSED" && order.realized_profit_usdt != null);
  const wins = closed.filter((order) => order.realized_profit_usdt > 0).length;
  const totalPnl = closed.reduce((sum, order) => sum + order.realized_profit_usdt, 0);
  const winRate = closed.length ? (wins / closed.length) * 100 : null;
  const open = orders.filter((order) => OPEN_STATUSES.includes(order.status));
  const atWork = open.reduce((sum, order) => sum + (Number(order.capital_usdt) || 0), 0);
  const best = closed.length ? Math.max(...closed.map((order) => order.realized_profit_usdt)) : null;

  const items = [
    { label: "Realized P/L", value: signed(totalPnl, closed.length), tone: closed.length ? (totalPnl >= 0 ? "up" : "down") : "" },
    { label: "Win rate", value: winRate == null ? "—" : `${winRate.toFixed(0)}%`, hint: closed.length ? `${wins}/${closed.length} trades` : "no closed trades" },
    { label: "Best trade", value: best == null ? "—" : signed(best, 1), tone: best == null ? "" : best >= 0 ? "up" : "down" },
    { label: "Open positions", value: String(open.length), hint: open.length ? `${atWork.toFixed(2)} USDT at work` : "none" },
  ];

  const riskState = risk?.state;
  const riskTile = riskState && {
    label: "Risk",
    value: { ok: "Within limits", warning: "Near a limit", halted: "Halted", off: "Limits off" }[riskState.status],
    tone: { ok: "up", warning: "hold", halted: "down", off: "" }[riskState.status],
    hint: riskState.status === "halted" ? riskState.blockers[0]?.message.split(":")[0].split(".")[0] : riskState.dailyLossLimit != null ? `today ${riskState.todayPnl >= 0 ? "+" : "−"}${Math.abs(riskState.todayPnl).toFixed(2)} / limit −${riskState.dailyLossLimit.toFixed(2)}` : "capital unknown",
  };
  if (riskTile) items.push(riskTile);

  return (
    <section className="stats-bar" aria-label="Performance">
      {items.map((item) => (
        <div className="stat" key={item.label}>
          <span className="stat-label">{item.label}</span>
          <strong className={`stat-value ${item.tone ? `tone-${item.tone}` : ""}`}>{item.value}</strong>
          {item.hint && <small>{item.hint}</small>}
        </div>
      ))}
    </section>
  );
}

function signed(value, count) {
  if (!count) return "—";
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)} USDT`;
}
