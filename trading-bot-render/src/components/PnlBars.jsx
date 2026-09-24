/**
 * A plain profit/loss bar chart: one bar per row, growing up from a zero baseline for a gain and down for a loss.
 * No charting library — these are static historical totals (daily or monthly), not a live series, so plain SVG is
 * simpler and avoids calendar-gap edge cases.
 */
const H = 120; // half-height above and below the baseline
const BAR = 16;
const GAP = 6;

export default function PnlBars({ rows, labelOf, formatValue, formatTitle }) {
  if (!rows.length) return <p className="log-empty">No closed trades in this range.</p>;
  const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.pnl)));
  const width = rows.length * (BAR + GAP) + GAP;
  const step = rows.length > 40 ? Math.ceil(rows.length / 20) : rows.length > 14 ? 2 : 1; // thin out x-axis labels when crowded

  return (
    <div className="pnl-bars">
      <svg viewBox={`0 0 ${width} ${H * 2 + 22}`} width={width} height={H * 2 + 22} preserveAspectRatio="xMinYMid meet">
        <line x1={0} y1={H} x2={width} y2={H} className="pnl-bars-zero" />
        {rows.map((r, i) => {
          const x = GAP + i * (BAR + GAP);
          const h = Math.max(1, (Math.abs(r.pnl) / maxAbs) * (H - 6));
          const up = r.pnl >= 0;
          return (
            <g key={r.key ?? i}>
              <title>{formatTitle ? formatTitle(r) : `${labelOf(r)}: ${formatValue(r.pnl)}`}</title>
              <rect x={x} y={up ? H - h : H} width={BAR} height={h} rx={2} className={up ? "pnl-bar-up" : "pnl-bar-down"} />
              {i % step === 0 && <text x={x + BAR / 2} y={H * 2 + 14} className="pnl-bars-label" textAnchor="middle">{labelOf(r)}</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
