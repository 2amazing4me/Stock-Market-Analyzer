import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import HeaderBar from "../components/HeaderBar";
import MoverList from "../components/MoverList";
import { normalizeTicker } from "../lib/tradingview";

const DEFAULT_SOURCE_INFO = {
  source_mode: "local",
  source_provider: "Twelve Data",
  delayed: false,
  delay_minutes: null,
  source_error: "",
};

const EMPTY_OVERVIEW = {
  indices: [],
  commodities: [],
  as_of: null,
  source_provider: "Yahoo Finance",
};
const MARKET_REFRESH_MS = 10_000;

/** Returns a readable label for a market movers data-source mode. */
function sourceModeLabel(mode) {
  if (mode === "api_snapshot") {
    return "API snapshot";
  }
  return "Local data";
}

/** Normalizes market movers attribution fields from the API payload. */
function sourceInfoFromPayload(payload) {
  return {
    source_mode: payload.source_mode || DEFAULT_SOURCE_INFO.source_mode,
    source_provider: payload.source_provider || DEFAULT_SOURCE_INFO.source_provider,
    delayed: Boolean(payload.delayed),
    delay_minutes: payload.delay_minutes ?? null,
    source_error: payload.source_error || "",
  };
}

/** Formats large market overview prices with compact precision. */
function formatOverviewPrice(value) {
  if (!Number.isFinite(value)) {
    return "--";
  }
  return value >= 100 ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : value.toFixed(2);
}

/** Formats short date labels for market overview chart axes. */
function formatAxisDate(unixSeconds) {
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Maps an overview chart point to normalized plot coordinates. */
function overviewPointPosition(point, index, points, min, range) {
  const x = points.length === 1 ? 100 : (index / (points.length - 1)) * 100;
  const y = 100 - ((point.price - min) / range) * 100;
  return { x, y };
}

/** Returns reusable chart dimensions and price range for an overview asset. */
function overviewChartModel(points) {
  const prices = points.map((point) => point.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return {
    min,
    max,
    range: max - min || 1,
  };
}

/** Builds an SVG path for a compact market overview line chart. */
function overviewLinePath(points, model) {
  if (!points.length) {
    return "";
  }

  return points.map((point, index) => {
    const { x, y } = overviewPointPosition(point, index, points, model.min, model.range);
    return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(" ");
}

/** Finds the nearest overview chart point for a pointer x-coordinate. */
function nearestOverviewPoint(clientX, rect, points, model) {
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const index = Math.round(ratio * (points.length - 1));
  const point = points[index];
  const position = overviewPointPosition(point, index, points, model.min, model.range);
  return { point, position };
}

/** Renders a compact chart with price and date axes for overview cards. */
function OverviewChart({ asset, positive }) {
  const [hovered, setHovered] = useState(null);

  if (!asset.chart.length) {
    return <div className="overview-chart" aria-hidden="true" />;
  }

  const model = overviewChartModel(asset.chart);
  const midPrice = (model.min + model.max) / 2;
  const firstPoint = asset.chart[0];
  const lastPoint = asset.chart[asset.chart.length - 1];
  const hoverCardTransform = hovered?.position.x > 72 ? "translate(calc(-100% - 8px), -50%)" : "translate(8px, -50%)";

  /** Updates the overview hover marker from pointer position. */
  const updateHover = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setHovered(nearestOverviewPoint(event.clientX, rect, asset.chart, model));
  };

  return (
    <div className="overview-chart">
      <div className="overview-y-labels" aria-hidden="true">
        <span>{formatOverviewPrice(model.max)}</span>
        <span>{formatOverviewPrice(midPrice)}</span>
        <span>{formatOverviewPrice(model.min)}</span>
      </div>
      <div className="overview-plot" onMouseMove={updateHover} onMouseLeave={() => setHovered(null)}>
        <svg className="overview-plot-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <line className="overview-axis" x1="0" y1="0" x2="0" y2="100" />
          <line className="overview-axis" x1="0" y1="100" x2="100" y2="100" />
          <line className="overview-grid-line" x1="0" y1="0" x2="100" y2="0" />
          <line className="overview-grid-line" x1="0" y1="50" x2="100" y2="50" />
          {hovered && <line className="overview-hover-line" x1={hovered.position.x} y1="0" x2={hovered.position.x} y2="100" />}
          <path className={positive ? "up" : "down"} d={overviewLinePath(asset.chart, model)} />
        </svg>
        {hovered && (
          <>
            <span
              className="overview-hover-dot"
              style={{ left: `${hovered.position.x}%`, top: `${hovered.position.y}%` }}
            />
            <span
              className="overview-hover-card"
              style={{ left: `${hovered.position.x}%`, top: `${hovered.position.y}%`, transform: hoverCardTransform }}
            >
              <small>{formatAxisDate(hovered.point.time)}</small>
              <strong>{formatOverviewPrice(hovered.point.price)}</strong>
            </span>
          </>
        )}
      </div>
      <div className="overview-x-labels" aria-hidden="true">
        <span>{formatAxisDate(firstPoint.time)}</span>
        <span>{formatAxisDate(lastPoint.time)}</span>
      </div>
    </div>
  );
}

/** Renders one non-clickable market overview card. */
function OverviewCard({ asset, large = false }) {
  const positive = asset.change_pct >= 0;
  return (
    <article className={`overview-card ${large ? "large" : ""}`}>
      <div className="overview-card-header">
        <span>{asset.label}</span>
      </div>
      <strong>{formatOverviewPrice(asset.price)}</strong>
      <span className={positive ? "overview-change up" : "overview-change down"}>
        {positive ? "+" : ""}{asset.change_pct.toFixed(2)}%
      </span>
      <OverviewChart asset={asset} positive={positive} />
    </article>
  );
}

/** Renders a ghosted overview card while Yahoo Finance data loads. */
function OverviewSkeletonCard({ large = false }) {
  return (
    <article className={`overview-card skeleton-overview ${large ? "large" : ""}`} aria-hidden="true">
      <div className="skeleton-line medium" />
      <div className="skeleton-line overview-price-line" />
      <div className="skeleton-line tiny" />
      <div className="overview-chart skeleton-block" />
    </article>
  );
}

/** Displays read-only Yahoo Finance index and macro overview cards. */
function MarketOverview({ data, loading, error }) {
  return (
    <section className="market-overview">
      {error && <p className="overview-error">{error}</p>}

      <div className="overview-grid overview-grid-indices">
        {loading
          ? [0, 1].map((index) => <OverviewSkeletonCard large key={index} />)
          : data.indices.map((asset) => <OverviewCard asset={asset} large key={asset.key} />)}
      </div>

      <div className="overview-grid overview-grid-macro">
        {loading
          ? [0, 1, 2].map((index) => <OverviewSkeletonCard key={index} />)
          : data.commodities.map((asset) => <OverviewCard asset={asset} key={asset.key} />)}
      </div>
    </section>
  );
}

/** Renders the data-source information icon. */
function InfoIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="7" />
      <path d="M10 9v5" />
      <path d="M10 6.2h.01" />
    </svg>
  );
}

/** Shows market movers and opens stock charts from selected tickers. */
export default function HomePage() {
  const navigate = useNavigate();
  const [data, setData] = useState({ gainers: [], losers: [], as_of: null, ...DEFAULT_SOURCE_INFO });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [overview, setOverview] = useState(EMPTY_OVERVIEW);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState("");
  const [sourceInfoOpen, setSourceInfoOpen] = useState(false);
  const moversRequestRef = useRef(null);
  const overviewRequestRef = useRef(null);

  /** Navigates to the stock chart for a valid ticker. */
  const openTicker = (ticker) => {
    const normalized = normalizeTicker(ticker);
    if (!normalized) {
      return;
    }
    navigate(`/stock/${encodeURIComponent(normalized)}`);
  };

  useEffect(() => {
    let mounted = true;

    /** Fetches market movers and their source attribution. */
    async function loadMovers(showLoading = false) {
      if (moversRequestRef.current) {
        return;
      }

      const controller = new AbortController();
      moversRequestRef.current = controller;
      if (showLoading) {
        setLoading(true);
      }
      setError("");
      try {
        const response = await fetch("/api/market-movers", { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`API request failed with status ${response.status}`);
        }

        const payload = await response.json();
        if (mounted) {
          setData({ ...payload, ...sourceInfoFromPayload(payload) });
        }
      } catch (err) {
        if (mounted) {
          if (!(err instanceof DOMException && err.name === "AbortError")) {
            setError(err instanceof Error ? err.message : "Unknown error");
          }
        }
      } finally {
        if (moversRequestRef.current === controller) {
          moversRequestRef.current = null;
        }
        if (mounted) {
          setLoading(false);
        }
      }
    }

    loadMovers(true);
    const intervalId = window.setInterval(() => loadMovers(false), MARKET_REFRESH_MS);
    return () => {
      mounted = false;
      moversRequestRef.current?.abort();
      moversRequestRef.current = null;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    let mounted = true;

    /** Fetches read-only market overview data from Yahoo Finance. */
    async function loadOverview(showLoading = false) {
      if (overviewRequestRef.current) {
        return;
      }

      const controller = new AbortController();
      overviewRequestRef.current = controller;
      if (showLoading) {
        setOverviewLoading(true);
      }
      setOverviewError("");
      try {
        const response = await fetch("/api/market-overview", { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Overview request failed with status ${response.status}`);
        }

        const payload = await response.json();
        if (mounted) {
          setOverview(payload);
        }
      } catch (err) {
        if (mounted) {
          if (!(err instanceof DOMException && err.name === "AbortError")) {
            setOverviewError(err instanceof Error ? err.message : "Overview unavailable");
          }
        }
      } finally {
        if (overviewRequestRef.current === controller) {
          overviewRequestRef.current = null;
        }
        if (mounted) {
          setOverviewLoading(false);
        }
      }
    }

    loadOverview(true);
    const intervalId = window.setInterval(() => loadOverview(false), MARKET_REFRESH_MS);
    return () => {
      mounted = false;
      overviewRequestRef.current?.abort();
      overviewRequestRef.current = null;
      window.clearInterval(intervalId);
    };
  }, []);

  const asOfLabel = useMemo(() => {
    if (!data.as_of) {
      return "No timestamp";
    }
    return new Date(data.as_of).toLocaleString();
  }, [data.as_of]);

  return (
    <main className="tv-page">
      <HeaderBar onSearch={openTicker} />

      <section className="status-line">
        {!loading && error && <span className="error">{error}</span>}
        {!loading && !error && (
          <div className="market-source">
            <span>As of {asOfLabel}</span>
            <div className="menu-popover">
              <button
                className="tv-tool-button source-info-button"
                type="button"
                title="Data source"
                onClick={() => setSourceInfoOpen((open) => !open)}
                aria-expanded={sourceInfoOpen}
              >
                <InfoIcon />
              </button>
              {sourceInfoOpen && (
                <div className="tv-dropdown source-info-popover">
                  <strong>{sourceModeLabel(data.source_mode)}</strong>
                  <span>Movers: {data.source_provider}</span>
                  <span>Market overview: Yahoo Finance</span>
                  {data.delayed && (
                    <span>{data.delay_minutes || 15}-minute delayed</span>
                  )}
                  {data.source_mode === "local" && (
                    <small>Local data courtesy of Twelve Data.</small>
                  )}
                  {data.source_error && (
                    <small>Massive unavailable: {data.source_error}</small>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      <MarketOverview data={overview} loading={overviewLoading} error={overviewError} />

      <section className="grid">
        <MoverList title="Today's Top Gainers" rows={data.gainers} loading={loading} onOpenTicker={openTicker} />
        <MoverList title="Today's Top Losers" rows={data.losers} loading={loading} onOpenTicker={openTicker} />
      </section>
    </main>
  );
}
