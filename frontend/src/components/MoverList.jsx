export default function MoverList({ title, rows, direction, onOpenTicker }) {
  return (
    <section className="mover-card">
      <div className="mover-header">
        <h2>{title}</h2>
        <span className={`pill ${direction}`}>{rows.length} symbols</span>
      </div>

      <div className="mover-list" role="list">
        {rows.map((row, idx) => {
          const positive = row.change_pct >= 0;
          const canOpen = row.symbol && row.symbol !== "N/A";

          return (
            <button
              className={`mover-row ${canOpen ? "clickable" : "disabled"}`}
              key={`${row.instrument_id}-${idx}`}
              role="listitem"
              type="button"
              onClick={() => canOpen && onOpenTicker(row.symbol)}
              disabled={!canOpen}
              title={canOpen ? `Open ${row.symbol}` : "Ticker unavailable"}
            >
              <div>
                <p className="symbol">{row.symbol}</p>
                <p className="meta">Vol {row.volume.toLocaleString()}</p>
              </div>
              <div className="prices">
                <p className="close">${row.close.toFixed(2)}</p>
                <p className={positive ? "chg up" : "chg down"}>{positive ? "+" : ""}{row.change_pct.toFixed(2)}%</p>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
