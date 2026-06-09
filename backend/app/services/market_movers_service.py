import csv
import glob
import json
import logging
import os
import time
from functools import lru_cache
from datetime import datetime, timezone
from threading import Lock
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import pandas as pd

from backend.app.schemas.market_movers import MarketMover, MarketMoversResponse
from backend.app.services.logo_service import local_logo_url
from backend.app.data_sources.massive_stock_chart_source import MASSIVE_REST_BASE_URL

from core.control.constants import PROJECT_ROOT
from core.control.helpers import get_instrument_universe_db_conn

CURATED_1DAY_DIR = PROJECT_ROOT / "core" / "data" / "historical_market_data" / "curated" / "1day"
LOCAL_SYMBOLS_CSV = PROJECT_ROOT / "core" / "control" / "data_layer" / "all.csv"
COMPANY_METADATA_CACHE = PROJECT_ROOT / "core" / "resources" / "company_metadata.csv"
MARKET_MOVERS_LIMIT = 10
MARKET_MOVERS_CACHE_SECONDS = 10
MASSIVE_COMMON_STOCK_CACHE_SECONDS = 60 * 60
MASSIVE_SOURCE_PROVIDER = "Massive/Polygon.io"
LOCAL_SOURCE_PROVIDER = "Twelve Data"
COMMON_STOCK_TYPES = {"CS"}
NON_COMMON_NAME_PARTS = (
    "warrant",
    "unit",
    "preferred",
    "depositary",
    "note",
    "debenture",
    "etf",
    "fund",
    "right",
)

logger = logging.getLogger(__name__)
_market_movers_cache_lock = Lock()
_market_movers_cache: dict[str, object] = {"expires_at": 0.0, "payload": None}
_massive_common_stock_cache_lock = Lock()
_massive_common_stock_cache: dict[str, object] = {"expires_at": 0.0, "symbols": set()}


def _load_symbol_map() -> dict[int, str]:
    """Loads instrument id to ticker mappings for local market mover rows."""
    conn = get_instrument_universe_db_conn()
    if not conn:
        return {}
    
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT instrument_id, ticker FROM instruments")
            rows = cursor.fetchall()
        return {int(instrument_id): str(ticker) for instrument_id, ticker in rows}
    except Exception:
        return {}
    finally:
        conn.close()


@lru_cache(maxsize=1)
def _load_local_company_names() -> dict[str, str]:
    """Loads local ticker to company name mappings for display labels."""
    if COMPANY_METADATA_CACHE.exists():
        with COMPANY_METADATA_CACHE.open(newline="", encoding="utf-8") as csv_file:
            names = {
                str(row.get("symbol") or "").upper(): str(row.get("name") or "")
                for row in csv.DictReader(csv_file)
                if row.get("symbol")
            }
        if names:
            return names

    if not LOCAL_SYMBOLS_CSV.exists():
        return {}

    with LOCAL_SYMBOLS_CSV.open(newline="", encoding="utf-8") as csv_file:
        return {
            str(row.get("symbol") or "").upper(): str(row.get("name") or "")
            for row in csv.DictReader(csv_file)
            if row.get("symbol")
        }


def _load_recent_daily_frame() -> pd.DataFrame:
    """Loads the latest local daily parquet rows needed to rank market movers."""
    year_dirs = sorted([p for p in CURATED_1DAY_DIR.iterdir() if p.is_dir() and p.name.isdigit()], key=lambda p: int(p.name))
    if not year_dirs:
        raise FileNotFoundError(f"No curated daily parquet directories found in {CURATED_1DAY_DIR}")

    target_years = {year_dirs[-1].name}
    if len(year_dirs) > 1:
        target_years.add(year_dirs[-2].name)

    files: list[str] = []
    for year in sorted(target_years):
        files.extend(sorted(glob.glob(str(CURATED_1DAY_DIR / year / "part-*.parquet"))))

    if not files:
        raise FileNotFoundError("No curated daily parquet files found for latest years")

    frames: list[pd.DataFrame] = []
    for path in files:
        frame = pd.read_parquet(path, columns=["open", "close", "volume", "instrument_id"])
        frame = frame.reset_index()
        frames.append(frame)

    df = pd.concat(frames, ignore_index=True)
    df["datetime"] = pd.to_datetime(df["datetime"])
    return df


def _prepare_movers(df: pd.DataFrame) -> tuple[pd.Timestamp, pd.DataFrame]:
    """Calculates local daily move percentages from the latest and prior closes."""
    latest_ts = df["datetime"].max()
    latest_day = latest_ts.normalize()

    latest_rows = df[df["datetime"].dt.normalize() == latest_day].copy()
    previous_rows = df[df["datetime"] < latest_day].sort_values("datetime")

    prev_close = (
        previous_rows.groupby("instrument_id", as_index=False)
        .tail(1)[["instrument_id", "close"]]
        .rename(columns={"close": "prev_close"})
    )

    merged = latest_rows.merge(prev_close, on="instrument_id", how="left")
    merged["change_pct"] = ((merged["close"] - merged["prev_close"]) / merged["prev_close"]) * 100

    # If there is no prior close for a symbol, fallback to intraday open-close move.
    fallback_change = ((merged["close"] - merged["open"]) / merged["open"]) * 100
    merged["change_pct"] = merged["change_pct"].fillna(fallback_change).fillna(0.0)

    symbol_map = _load_symbol_map()
    merged["symbol"] = merged["instrument_id"].map(
        lambda instrument_id: symbol_map.get(int(instrument_id), "N/A")
    )
    merged["volume"] = merged["volume"].fillna(0).astype(int)

    return latest_ts, merged


def _massive_api_key() -> str | None:
    """Returns the configured Massive REST API key, if available."""
    return os.getenv("MASSIVE_KEY")


def _request_massive_broad_snapshot() -> dict:
    """Fetches a broad Massive market snapshot for all US stock tickers."""
    query = urlencode({"apiKey": _massive_api_key()})
    request = Request(
        f"{MASSIVE_REST_BASE_URL}/v2/snapshot/locale/us/markets/stocks/tickers?{query}",
        headers={"Accept": "application/json"},
    )
    with urlopen(request, timeout=8) as response:
        return json.loads(response.read().decode("utf-8"))


def _massive_url_with_api_key(url: str) -> str:
    """Appends the Massive API key to a URL when the provider omits it."""
    separator = "&" if "?" in url else "?"
    return f"{url}{separator}{urlencode({'apiKey': _massive_api_key()})}"


def _request_massive_reference_tickers(url: str | None = None) -> dict:
    """Fetches one Massive reference tickers page for active common stocks."""
    if url is None:
        query = urlencode({
            "market": "stocks",
            "active": "true",
            "type": "CS",
            "limit": 1000,
            "apiKey": _massive_api_key(),
        })
        url = f"{MASSIVE_REST_BASE_URL}/v3/reference/tickers?{query}"
    else:
        url = _massive_url_with_api_key(url)

    request = Request(url, headers={"Accept": "application/json"})
    with urlopen(request, timeout=8) as response:
        return json.loads(response.read().decode("utf-8"))


def _request_massive_ticker_details(symbol: str) -> dict:
    """Fetches Massive reference details for one ticker."""
    api_key = _massive_api_key()
    if not api_key:
        raise RuntimeError("MASSIVE_KEY is not configured")

    query = urlencode({"apiKey": api_key})
    request = Request(
        f"{MASSIVE_REST_BASE_URL}/v3/reference/tickers/{symbol}?{query}",
        headers={"Accept": "application/json"},
    )
    with urlopen(request, timeout=8) as response:
        return json.loads(response.read().decode("utf-8"))


def _timestamp_from_massive_value(value: object) -> datetime | None:
    """Converts Massive timestamp values with varying precision to UTC datetimes."""
    if value is None:
        return None

    try:
        numeric = int(value)
    except (TypeError, ValueError):
        return None

    divisor = 1
    if numeric > 10**16:
        divisor = 1_000_000_000
    elif numeric > 10**13:
        divisor = 1_000_000
    elif numeric > 10**10:
        divisor = 1_000

    return datetime.fromtimestamp(numeric / divisor, tz=timezone.utc)


def _massive_close_price(item: dict) -> float:
    """Extracts the best available close or last trade price from a Massive mover."""
    day = item.get("day") or {}
    last_trade = item.get("lastTrade") or {}
    previous_day = item.get("prevDay") or {}
    return float(day.get("c") or last_trade.get("p") or previous_day.get("c") or 0)


def _massive_volume(item: dict) -> int:
    """Extracts accumulated volume, including premarket minute aggregates."""
    day = item.get("day") or {}
    minute = item.get("min") or {}
    return int(float(minute.get("av") or day.get("v") or minute.get("v") or 0))


def _massive_change_pct(item: dict, close: float) -> float:
    """Extracts or calculates the Massive snapshot percentage move."""
    try:
        return float(item.get("todaysChangePerc"))
    except (TypeError, ValueError):
        previous_day = item.get("prevDay") or {}
        previous_close = previous_day.get("c")
        try:
            previous_close = float(previous_close)
        except (TypeError, ValueError):
            return 0.0
        if previous_close <= 0:
            return 0.0
        return ((close - previous_close) / previous_close) * 100


def _local_company_name(symbol: str) -> str:
    """Returns a locally cached company name for a symbol."""
    return _load_local_company_names().get(symbol.upper(), symbol.upper())


def _market_mover_logo_url(symbol: str) -> str:
    """Returns a local market mover logo URL when cached."""
    return local_logo_url(symbol)


def _is_local_common_stock(symbol: str) -> bool:
    """Checks local symbol metadata for common-stock-like instruments."""
    name = _local_company_name(symbol).lower()
    if any(part in name for part in NON_COMMON_NAME_PARTS):
        return False
    return "common stock" in name or "ordinary shares" in name


def _fresh_massive_common_stock_symbols() -> set[str]:
    """Returns cached Massive common-stock symbols when available."""
    now = time.monotonic()
    with _massive_common_stock_cache_lock:
        cached_symbols = _massive_common_stock_cache["symbols"]
        if now < float(_massive_common_stock_cache["expires_at"]) and isinstance(cached_symbols, set) and cached_symbols:
            return cached_symbols

        symbols: set[str] = set()
        payload = _request_massive_reference_tickers()
        while True:
            for row in payload.get("results") or []:
                if not isinstance(row, dict) or str(row.get("type", "")).upper() not in COMMON_STOCK_TYPES:
                    continue
                symbol = str(row.get("ticker") or "").upper()
                if symbol:
                    symbols.add(symbol)

            next_url = payload.get("next_url")
            if not next_url:
                break
            payload = _request_massive_reference_tickers(str(next_url))

        if not symbols:
            raise LookupError("Massive reference tickers returned no common stocks")

        _massive_common_stock_cache["symbols"] = symbols
        _massive_common_stock_cache["expires_at"] = time.monotonic() + MASSIVE_COMMON_STOCK_CACHE_SECONDS
        return symbols


def _mover_from_massive_item(item: dict, common_stock_symbols: set[str]) -> MarketMover | None:
    """Normalizes a Massive snapshot item into the public market mover schema."""
    symbol = str(item.get("ticker") or "").upper()
    if not symbol or symbol not in common_stock_symbols:
        return None

    close = _massive_close_price(item)
    if close <= 0:
        return None

    change_pct = _massive_change_pct(item, close)
    return MarketMover(
        symbol=symbol,
        instrument_id=0,
        logo_url=_market_mover_logo_url(symbol),
        close=close,
        change_pct=change_pct,
        volume=_massive_volume(item),
    )


def _massive_snapshot_as_of(items: list[dict]) -> datetime:
    """Returns the newest Massive snapshot timestamp, falling back to current UTC time."""
    timestamps = [
        ts
        for ts in (_timestamp_from_massive_value(item.get("updated")) for item in items)
        if ts is not None
    ]
    if timestamps:
        return max(timestamps)
    return datetime.now(tz=timezone.utc)


def _movers_from_massive_items(items: list[dict], common_stock_symbols: set[str]) -> list[MarketMover]:
    """Builds validated market movers from broad Massive snapshot items."""
    rows: list[MarketMover] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        mover = _mover_from_massive_item(item, common_stock_symbols)
        if mover is not None:
            rows.append(mover)
    return rows


def _get_massive_market_movers(limit: int) -> MarketMoversResponse:
    """Loads market movers from a broad Massive snapshot, then filters and ranks."""
    limit = min(max(int(limit), 1), MARKET_MOVERS_LIMIT)
    if not _massive_api_key():
        raise RuntimeError("MASSIVE_KEY is not configured")

    common_stock_symbols = _fresh_massive_common_stock_symbols()
    payload = _request_massive_broad_snapshot()
    snapshot_items = [item for item in payload.get("tickers") or [] if isinstance(item, dict)]
    movers = _movers_from_massive_items(snapshot_items, common_stock_symbols)
    gainers = sorted(movers, key=lambda mover: mover.change_pct, reverse=True)[:limit]
    losers = sorted(movers, key=lambda mover: mover.change_pct)[:limit]

    if not gainers and not losers:
        raise LookupError("Massive broad snapshot returned no common-stock market movers")

    return MarketMoversResponse(
        as_of=_massive_snapshot_as_of(snapshot_items),
        source_mode="api_snapshot",
        source_provider=MASSIVE_SOURCE_PROVIDER,
        delayed=True,
        delay_minutes=15,
        gainers=gainers,
        losers=losers,
    )


def _get_local_market_movers(limit: int, source_error: str = "") -> MarketMoversResponse:
    """Loads market movers from local curated daily data."""
    limit = min(max(int(limit), 1), MARKET_MOVERS_LIMIT)
    df = _load_recent_daily_frame()
    as_of_ts, movers_df = _prepare_movers(df)
    movers_df = movers_df[movers_df["symbol"].map(_is_local_common_stock)]

    gainers_df = movers_df.sort_values("change_pct", ascending=False).head(limit)
    losers_df = movers_df.sort_values("change_pct", ascending=True).head(limit)

    gainers = [
        MarketMover(
            symbol=row["symbol"],
            instrument_id=int(row["instrument_id"]),
            logo_url=_market_mover_logo_url(row["symbol"]),
            close=float(row["close"]),
            change_pct=float(row["change_pct"]),
            volume=int(row["volume"]),
        )
        for _, row in gainers_df.iterrows()
    ]

    losers = [
        MarketMover(
            symbol=row["symbol"],
            instrument_id=int(row["instrument_id"]),
            logo_url=_market_mover_logo_url(row["symbol"]),
            close=float(row["close"]),
            change_pct=float(row["change_pct"]),
            volume=int(row["volume"]),
        )
        for _, row in losers_df.iterrows()
    ]

    return MarketMoversResponse(
        as_of=datetime.fromtimestamp(as_of_ts.timestamp()),
        source_mode="local",
        source_provider=LOCAL_SOURCE_PROVIDER,
        source_error=source_error,
        gainers=gainers,
        losers=losers,
    )


def _cached_market_movers(limit: int) -> MarketMoversResponse | None:
    """Returns a fresh cached movers response when available."""
    now = time.monotonic()
    with _market_movers_cache_lock:
        payload = _market_movers_cache["payload"]
        if (
            now < float(_market_movers_cache["expires_at"])
            and isinstance(payload, MarketMoversResponse)
            and len(payload.gainers) == limit
            and len(payload.losers) == limit
        ):
            return payload
    return None


def _store_market_movers_cache(payload: MarketMoversResponse) -> None:
    """Stores a movers response for short shared polling reuse."""
    with _market_movers_cache_lock:
        _market_movers_cache["payload"] = payload
        _market_movers_cache["expires_at"] = time.monotonic() + MARKET_MOVERS_CACHE_SECONDS


def _load_market_movers(limit: int) -> MarketMoversResponse:
    """Loads market movers from Massive REST, falling back to local data."""
    limit = min(max(int(limit), 1), MARKET_MOVERS_LIMIT)
    try:
        return _get_massive_market_movers(limit)
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError, RuntimeError, LookupError) as exc:
        logger.info("Massive market movers unavailable: %s; using local data.", exc)
        return _get_local_market_movers(limit, source_error=str(exc))


def get_market_movers(limit: int = MARKET_MOVERS_LIMIT) -> MarketMoversResponse:
    """Returns cached market movers suitable for 10-second polling."""
    limit = min(max(int(limit), 1), MARKET_MOVERS_LIMIT)
    cached = _cached_market_movers(limit)
    if cached is not None:
        return cached

    payload = _load_market_movers(limit)
    _store_market_movers_cache(payload)
    return payload
