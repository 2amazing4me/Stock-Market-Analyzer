import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { normalizeTicker } from "../lib/tradingview";

export default function HeaderBar({ onSearch, searchDefault = "" }) {
  const [query, setQuery] = useState(searchDefault);

  useEffect(() => {
    setQuery(searchDefault);
  }, [searchDefault]);

  const submitSearch = (event) => {
    event.preventDefault();
    const ticker = normalizeTicker(query);
    if (!ticker) {
      return;
    }
    onSearch(ticker);
  };

  return (
    <header className="tv-header">
      <Link className="brand" to="/">APP NAME</Link>

      <div className="header-actions">
        <form className="search-form" onSubmit={submitSearch}>
          <input
            type="text"
            placeholder="Search ticker"
            aria-label="Search ticker"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </form>

        <div className="scanner-segment" aria-label="Navigation">
          <span className="seg-line" />
          <Link className="scanner-link" to="/scanner">Scanner</Link>
          <span className="seg-line" />
        </div>
      </div>
    </header>
  );
}
