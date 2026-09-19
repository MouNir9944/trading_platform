export default function SignalLog({ entries }) {
  return (
    <div className="panel log-panel">
      <p className="panel-title">Signal log</p>
      {entries.length === 0 ? (
        <div className="log-empty">
          No signal changes recorded yet. Entries appear here whenever the strategy moves between
          HOLD, BUY, and SELL.
        </div>
      ) : (
        <table className="log-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Signal</th>
              <th>Price</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, i) => (
              <tr key={i}>
                <td>{entry.time}</td>
                <td className={`signal-cell ${entry.signal}`}>{entry.signal}</td>
                <td>{entry.price.toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
