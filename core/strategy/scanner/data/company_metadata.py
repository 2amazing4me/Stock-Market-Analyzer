import logging
from pathlib import Path

import pandas as pd

from core.control.constants import PROJECT_ROOT
from core.strategy.scanner.preprocessing.historical_metrics import optional_float

LOCAL_SYMBOLS_CSV = PROJECT_ROOT / "core" / "control" / "data_layer" / "all.csv"
COMPANY_METADATA_CACHE_PATH = PROJECT_ROOT / "core" / "resources" / "company_metadata.csv"

logger = logging.getLogger(__name__)


def get_company_metadata(
    tickers: list[str],
    metadata_cache_path: Path = COMPANY_METADATA_CACHE_PATH,
    symbols_csv_path: Path = LOCAL_SYMBOLS_CSV,
) -> dict[str, dict[str, float | str | None]]:
    """Loads cached company metadata and local industry classifications."""
    metadata = _cached_company_metadata(tickers, metadata_cache_path)
    industries = local_company_industries(tickers, symbols_csv_path)
    for ticker, industry in industries.items():
        metadata.setdefault(ticker, {})["industry"] = industry
    average_volumes = local_company_average_volumes(tickers, symbols_csv_path)
    for ticker, avg_volume in average_volumes.items():
        metadata.setdefault(ticker, {}).setdefault("avg_volume", avg_volume)
    return metadata


def local_industries(symbols_csv_path: Path = LOCAL_SYMBOLS_CSV) -> list[str]:
    """Returns the local industry names available for scanner filters."""
    if not symbols_csv_path.exists():
        return []

    try:
        frame = pd.read_csv(symbols_csv_path, usecols=["industry"])
    except (OSError, ValueError) as exc:
        logger.warning("Could not load scanner industries: %s", exc)
        return []

    industries = frame["industry"].dropna().astype(str).str.strip()
    return sorted({industry for industry in industries if industry})


def local_company_industries(tickers: list[str], symbols_csv_path: Path = LOCAL_SYMBOLS_CSV) -> dict[str, str | None]:
    """Loads local company industry classifications from all.csv."""
    if not symbols_csv_path.exists():
        return {}

    try:
        frame = pd.read_csv(symbols_csv_path, usecols=["symbol", "industry"])
    except (OSError, ValueError) as exc:
        logger.warning("Could not load scanner company industries: %s", exc)
        return {}

    ticker_set = {_canonical_ticker(ticker) for ticker in tickers}
    frame["symbol"] = frame["symbol"].astype(str).str.upper().map(_canonical_ticker)
    frame["industry"] = frame["industry"].astype(str)
    filtered = frame[frame["symbol"].isin(ticker_set)]
    industries: dict[str, str | None] = {}
    for item in filtered.to_dict("records"):
        ticker = str(item["symbol"]).upper()
        industries[ticker] = str(item.get("industry") or "").strip() or None

    return industries


def local_company_average_volumes(tickers: list[str], symbols_csv_path: Path = LOCAL_SYMBOLS_CSV) -> dict[str, float | None]:
    """Loads local company volume values as an average-volume fallback."""
    if not symbols_csv_path.exists():
        return {}

    try:
        frame = pd.read_csv(symbols_csv_path, usecols=["symbol", "volume"])
    except (OSError, ValueError) as exc:
        logger.warning("Could not load scanner company volumes: %s", exc)
        return {}

    ticker_set = {_canonical_ticker(ticker) for ticker in tickers}
    frame["symbol"] = frame["symbol"].astype(str).str.upper().map(_canonical_ticker)
    frame["volume"] = pd.to_numeric(frame["volume"], errors="coerce")
    filtered = frame[frame["symbol"].isin(ticker_set)]
    volumes: dict[str, float | None] = {}
    for item in filtered.to_dict("records"):
        ticker = str(item["symbol"]).upper()
        volumes[ticker] = optional_float(item.get("volume"))

    return volumes


def _cached_company_metadata(
    tickers: list[str],
    metadata_cache_path: Path = COMPANY_METADATA_CACHE_PATH,
) -> dict[str, dict[str, float | str | None]]:
    """Loads cached company names, stable market caps, and weighted shares."""
    if not metadata_cache_path.exists():
        return {}

    try:
        frame = pd.read_csv(
            metadata_cache_path,
            usecols=["symbol", "name", "market_cap", "weighted_shares_outstanding"],
        )
    except (OSError, ValueError) as exc:
        logger.warning("Could not load cached scanner company metadata: %s", exc)
        return {}

    ticker_set = {_canonical_ticker(ticker) for ticker in tickers}
    frame["symbol"] = frame["symbol"].astype(str).str.upper().map(_canonical_ticker)
    frame["name"] = frame["name"].astype(str)
    frame["market_cap"] = pd.to_numeric(frame["market_cap"], errors="coerce")
    frame["weighted_shares_outstanding"] = pd.to_numeric(frame["weighted_shares_outstanding"], errors="coerce")
    filtered = frame[frame["symbol"].isin(ticker_set)]

    metadata: dict[str, dict[str, float | str | None]] = {}
    for item in filtered.to_dict("records"):
        ticker = str(item["symbol"]).upper()
        market_cap = optional_float(item.get("market_cap"))
        weighted_shares = optional_float(item.get("weighted_shares_outstanding"))

        metadata[ticker] = {
            "market_cap": market_cap,
            "name": str(item.get("name") or "").strip() or None,
            "weighted_shares_outstanding": weighted_shares,
        }

    return metadata


def _canonical_ticker(ticker: str) -> str:
    """Converts provider-specific share-class separators to Massive format."""
    return str(ticker).upper().replace("/", ".")
