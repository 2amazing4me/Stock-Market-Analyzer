import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import HeaderBar from "../components/HeaderBar";
import MoverList from "../components/MoverList";
import { normalizeTicker } from "../lib/tradingview";

export default function HomePage() {
  const navigate = useNavigate();
  const [data, setData] = useState({ gainers: [], losers: [], as_of: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const openTicker = (ticker) => {
    const normalized = normalizeTicker(ticker);
    if (!normalized) {
      return;
    }
    navigate(`/stock/${encodeURIComponent(normalized)}`);
  };

  useEffect(() => {
    let mounted = true;

    async function loadMovers() {
      setLoading(true);
      setError("");
      try {
        const response = await fetch("/api/market-movers");
        if (!response.ok) {
          throw new Error(`API request failed with status ${response.status}`);
        }

        const payload = await response.json();
        if (mounted) {
          setData(payload);
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : "Unknown error");
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    }

    loadMovers();
    return () => {
      mounted = false;
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
        {loading && <span>Loading market movers...</span>}
        {!loading && error && <span className="error">{error}</span>}
        {!loading && !error && <span>As of: {asOfLabel}</span>}
      </section>

      <section className="grid">
        <MoverList title="Today's Top Gainers" rows={data.gainers} direction="up" onOpenTicker={openTicker} />
        <MoverList title="Today's Top Losers" rows={data.losers} direction="down" onOpenTicker={openTicker} />
      </section>
    </main>
  );
}
