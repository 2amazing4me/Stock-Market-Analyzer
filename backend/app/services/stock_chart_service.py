import glob
import re
from pathlib import Path

import pandas as pd

from backend.app.schemas.stock_chart import Candle, StockCandlesResponse

from core.control.constants import PROJECT_ROOT
from core.control.helpers import get_instrument_universe_db_conn

CURATED_BASE_DIR = PROJECT_ROOT / "core" / "data" / "historical_market_data" / "curated"
TIMEFRAME_DIR_MAP = {
    "1d": "1day",
    "1h": "1h",
    "5m": "5min",
}
TIMEFRAME_CONFIG = {
    "5m": {"base": "5m", "rule": None, "base_multiplier": 1},
    "10m": {"base": "5m", "rule": "10min", "base_multiplier": 2},
    "15m": {"base": "5m", "rule": "15min", "base_multiplier": 3},
    "30m": {"base": "5m", "rule": "30min", "base_multiplier": 6},
    "45m": {"base": "5m", "rule": "45min", "base_multiplier": 9},
    "1h": {"base": "1h", "rule": None, "base_multiplier": 1},
    "2h": {"base": "1h", "rule": "2h", "base_multiplier": 2},
    "3h": {"base": "1h", "rule": "3h", "base_multiplier": 3},
    "4h": {"base": "1h", "rule": "4h", "base_multiplier": 4},
    "1d": {"base": "1d", "rule": None, "base_multiplier": 1},
    "1w": {"base": "1d", "rule": "W-FRI", "base_multiplier": 5},
    "1mo": {"base": "1d", "rule": "MS", "base_multiplier": 23},
    "3mo": {"base": "1d", "rule": "3MS", "base_multiplier": 69},
    "6mo": {"base": "1d", "rule": "6MS", "base_multiplier": 138},
    "12mo": {"base": "1d", "rule": "12MS", "base_multiplier": 276},
}


def _resolve_instrument_id(ticker: str) -> int:
    conn = get_instrument_universe_db_conn()
    if not conn:
        raise RuntimeError("Instrument DB connection unavailable")

    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT instrument_id FROM instruments WHERE UPPER(ticker) = %s",
                (ticker.upper(),),
            )
            row = cursor.fetchone()
    finally:
        conn.close()

    if row is None:
        raise LookupError(f"Ticker not found: {ticker}")

    return int(row[0])


def _parse_part_number(file_name: str) -> int:
    match = re.search(r"part-(\d+)\.parquet$", file_name)
    if match:
        return int(match.group(1))
    return 0


def _resolve_timeframe_dir(timeframe: str) -> Path:
    normalized = timeframe.strip().lower()
    if normalized not in TIMEFRAME_DIR_MAP:
        raise ValueError("Unsupported base timeframe. Allowed values: 5m, 1h, 1d")
    return CURATED_BASE_DIR / TIMEFRAME_DIR_MAP[normalized]


def _resolve_timeframe_config(timeframe: str) -> dict:
    normalized = timeframe.strip().lower()
    if normalized not in TIMEFRAME_CONFIG:
        allowed = ", ".join(TIMEFRAME_CONFIG.keys())
        raise ValueError(f"Unsupported timeframe. Allowed values: {allowed}")
    return TIMEFRAME_CONFIG[normalized]


def _part_files_desc(curated_dir: Path) -> list[Path]:
    part_paths = [Path(path) for path in glob.glob(str(curated_dir / "**" / "part-*.parquet"), recursive=True)]

    def sort_key(path: Path) -> tuple[int, int, int]:
        rel = path.relative_to(curated_dir)
        partition_parts = rel.parts[:-1]
        nums = [int(part) for part in partition_parts if part.isdigit()]
        year = nums[0] if len(nums) > 0 else 0
        month = nums[1] if len(nums) > 1 else 0
        part_num = _parse_part_number(path.name)
        return year, month, part_num

    return sorted(part_paths, key=sort_key, reverse=True)


def _load_candle_frame(
    instrument_id: int,
    limit: int,
    timeframe: str,
    before: int | None = None,
    after: int | None = None,
) -> pd.DataFrame:
    timeframe_dir = _resolve_timeframe_dir(timeframe)
    matched_frames: list[pd.DataFrame] = []
    loaded_rows = 0

    for path in _part_files_desc(timeframe_dir):
        frame = pd.read_parquet(path, columns=["open", "high", "low", "close", "volume", "instrument_id"])
        frame = frame[frame["instrument_id"] == instrument_id]
        if frame.empty:
            continue

        frame = frame.reset_index()
        if "datetime" not in frame.columns and "index" in frame.columns:
            frame = frame.rename(columns={"index": "datetime"})

        frame["datetime"] = pd.to_datetime(frame["datetime"])
        frame["unix_time"] = frame["datetime"].apply(_to_unix_seconds)

        if before is not None:
            frame = frame[frame["unix_time"] < before]

        if after is not None:
            frame = frame[frame["unix_time"] > after]

        if frame.empty:
            continue

        matched_frames.append(frame)
        loaded_rows += len(frame)

        if limit > 0 and loaded_rows >= limit:
            break

    if not matched_frames:
        raise LookupError("No candle data found for ticker")

    df = pd.concat(matched_frames, ignore_index=True)
    df["datetime"] = pd.to_datetime(df["datetime"])
    df = df.sort_values("datetime", ascending=True).drop_duplicates(subset=["datetime"], keep="last")

    if limit > 0:
        if after is not None and before is None:
            df = df.head(limit)
        else:
            df = df.tail(limit)

    return df


def _aggregate_candle_frame(df: pd.DataFrame, rule: str) -> pd.DataFrame:
    if df.empty:
        return df

    working = df.copy()
    working["datetime"] = pd.to_datetime(working["datetime"])
    working = working.sort_values("datetime", ascending=True).drop_duplicates(subset=["datetime"], keep="last")
    working = working.set_index("datetime")

    aggregated = working.resample(rule, label="left", closed="left").agg(
        {
            "open": "first",
            "high": "max",
            "low": "min",
            "close": "last",
            "volume": "sum",
            "instrument_id": "last",
        }
    )

    aggregated = aggregated.dropna(subset=["open", "high", "low", "close"]).reset_index()
    aggregated["volume"] = aggregated["volume"].fillna(0)
    aggregated["unix_time"] = aggregated["datetime"].apply(_to_unix_seconds)
    return aggregated


def _to_unix_seconds(value: pd.Timestamp) -> int:
    ts = pd.Timestamp(value)
    if ts.tzinfo is None:
        ts = ts.tz_localize("UTC")
    else:
        ts = ts.tz_convert("UTC")
    return int(ts.timestamp())


def get_stock_candle_dataframe(
    ticker: str,
    limit: int = 600,
    timeframe: str = "1d",
    before: int | None = None,
    after: int | None = None,
) -> pd.DataFrame:
    normalized_timeframe = timeframe.strip().lower()
    timeframe_config = _resolve_timeframe_config(normalized_timeframe)
    base_timeframe = str(timeframe_config["base"])
    aggregation_rule = timeframe_config["rule"]
    base_multiplier = int(timeframe_config["base_multiplier"])

    instrument_id = _resolve_instrument_id(ticker)
    base_limit = limit
    if aggregation_rule is not None and limit > 0:
        base_limit = min(5000, max(limit * base_multiplier + base_multiplier * 4, limit))

    df = _load_candle_frame(
        instrument_id=instrument_id,
        limit=base_limit,
        timeframe=base_timeframe,
        before=before,
        after=after,
    ).copy()

    if aggregation_rule is not None:
        df = _aggregate_candle_frame(df, str(aggregation_rule))

    if "unix_time" not in df.columns:
        df["unix_time"] = df["datetime"].apply(_to_unix_seconds)

    if before is not None:
        df = df[df["unix_time"] < before]

    if after is not None:
        df = df[df["unix_time"] > after]

    df = df.sort_values("datetime", ascending=True).drop_duplicates(subset=["datetime"], keep="last")

    if limit > 0:
        if after is not None and before is None:
            df = df.head(limit)
        else:
            df = df.tail(limit)

    if df.empty:
        raise LookupError("No candle data found for ticker")

    return df


def get_stock_candles(
    ticker: str,
    limit: int = 600,
    timeframe: str = "1d",
    before: int | None = None,
    after: int | None = None,
) -> StockCandlesResponse:
    normalized_timeframe = timeframe.strip().lower()
    df = get_stock_candle_dataframe(
        ticker=ticker,
        timeframe=normalized_timeframe,
        limit=limit,
        before=before,
        after=after,
    )

    candles = [
        Candle(
            time=int(row["unix_time"]),
            open=float(row["open"]),
            high=float(row["high"]),
            low=float(row["low"]),
            close=float(row["close"]),
            volume=int(row["volume"]),
        )
        for _, row in df.iterrows()
    ]

    return StockCandlesResponse(symbol=ticker.upper(), timeframe=normalized_timeframe, candles=candles)
