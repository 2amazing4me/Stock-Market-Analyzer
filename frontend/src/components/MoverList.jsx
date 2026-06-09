import { useState } from "react";
import { logoPresentationStyle } from "../lib/logoPresentation";

const SKELETON_ROWS = Array.from({ length: 10 }, (_, index) => index);

/** Returns compact initials for logo fallbacks. */
function logoFallback(symbol) {
  return (symbol || "?").slice(0, 2).toUpperCase();
}

/** Renders a single market mover tile. */
function MoverTile({ row, onOpenTicker }) {
  const positive = row.change_pct >= 0;
  const canOpen = row.symbol && row.symbol !== "N/A";
  const [logoFailed, setLogoFailed] = useState(false);
  const [logoStyle, setLogoStyle] = useState({});
  const showLogo = row.logo_url && !logoFailed;

  return (
    <button
      className={`mover-tile ${canOpen ? "clickable" : "disabled"}`}
      key={row.symbol}
      role="listitem"
      type="button"
      onClick={() => canOpen && onOpenTicker(row.symbol)}
      disabled={!canOpen}
      title={canOpen ? `Open ${row.symbol}` : "Ticker unavailable"}
    >
      <div className="mover-logo" aria-hidden="true" style={showLogo ? logoStyle : undefined}>
        {showLogo ? (
          <img
            src={row.logo_url}
            alt=""
            loading="lazy"
            onLoad={(event) => setLogoStyle(logoPresentationStyle(event.currentTarget))}
            onError={() => setLogoFailed(true)}
          />
        ) : (
          <span>{logoFallback(row.symbol)}</span>
        )}
      </div>
      <p className="symbol">{row.symbol}</p>
      <p className="close">${row.close.toFixed(2)}</p>
      <p className={positive ? "chg up" : "chg down"}>{positive ? "+" : ""}{row.change_pct.toFixed(2)}%</p>
    </button>
  );
}

/** Renders a single skeleton market mover tile while data loads. */
function SkeletonTile({ index }) {
  return (
    <div className="mover-tile skeleton-tile" role="listitem" aria-hidden="true" key={index}>
      <div className="mover-logo skeleton-block" />
      <div className="skeleton-line short" />
      <div className="skeleton-line medium" />
      <div className="skeleton-line tiny" />
    </div>
  );
}

/** Displays a compact market movers grid for one movement direction. */
export default function MoverList({ title, rows, loading = false, onOpenTicker }) {
  return (
    <section className="mover-card">
      <div className="mover-header">
        <h2>{title}</h2>
      </div>

      <div className="mover-list" role="list">
        {loading
          ? SKELETON_ROWS.map((index) => <SkeletonTile index={index} key={index} />)
          : rows.map((row) => <MoverTile row={row} key={row.symbol} onOpenTicker={onOpenTicker} />)}
      </div>
    </section>
  );
}
