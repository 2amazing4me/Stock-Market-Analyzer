from pathlib import Path

import pandas as pd

from core.control.constants import PROJECT_ROOT
from core.control.market_time import (
    EXCHANGE_TIMEZONE,
    REGULAR_MARKET_CLOSE_MINUTES,
    REGULAR_MARKET_OPEN_MINUTES,
)

CURATED_BASE_DIR = PROJECT_ROOT / "core" / "data" / "historical_market_data" / "curated"

TIMEFRAME_DIR_MAP = {
    "1d": "1day",
    "1h": "1h",
    "5m": "5min",
}

TIMEFRAME_CONFIG = {
    "1s": {"base": "1s", "rule": None, "base_multiplier": 1, "api_only": True},
    "5s": {"base": "5s", "rule": None, "base_multiplier": 1, "api_only": True},
    "10s": {"base": "10s", "rule": None, "base_multiplier": 1, "api_only": True},
    "15s": {"base": "15s", "rule": None, "base_multiplier": 1, "api_only": True},
    "30s": {"base": "30s", "rule": None, "base_multiplier": 1, "api_only": True},
    "45s": {"base": "45s", "rule": None, "base_multiplier": 1, "api_only": True},
    "1m": {"base": "1m", "rule": None, "base_multiplier": 1, "api_only": True},
    "2m": {"base": "2m", "rule": None, "base_multiplier": 1, "api_only": True},
    "3m": {"base": "3m", "rule": None, "base_multiplier": 1, "api_only": True},
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


def is_api_only_timeframe(timeframe: str) -> bool:
    return bool(resolve_timeframe_config(timeframe).get("api_only"))


def resolve_timeframe_dir(timeframe: str) -> Path:
    normalized = timeframe.strip().lower()
    if normalized not in TIMEFRAME_DIR_MAP:
        raise ValueError("Unsupported base timeframe. Allowed values: 5m, 1h, 1d")
    return CURATED_BASE_DIR / TIMEFRAME_DIR_MAP[normalized]


def resolve_timeframe_config(timeframe: str) -> dict:
    normalized = timeframe.strip().lower()
    if normalized not in TIMEFRAME_CONFIG:
        allowed = ", ".join(TIMEFRAME_CONFIG.keys())
        raise ValueError(f"Unsupported timeframe. Allowed values: {allowed}")
    return TIMEFRAME_CONFIG[normalized]


def to_unix_seconds(value: pd.Timestamp) -> int:
    ts = pd.Timestamp(value)
    if ts.tzinfo is None:
        ts = ts.tz_localize("UTC")
    else:
        ts = ts.tz_convert("UTC")
    return int(ts.timestamp())


def aggregate_candle_frame(df: pd.DataFrame, rule: str) -> pd.DataFrame:
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
    aggregated["unix_time"] = aggregated["datetime"].apply(to_unix_seconds)
    return aggregated


def filter_regular_market_hours(
    df: pd.DataFrame | None,
    timeframe: str,
    include_extended_hours: bool,
) -> pd.DataFrame | None:
    if df is None or include_extended_hours or df.empty:
        return df

    normalized_timeframe = timeframe.strip().lower()
    if normalized_timeframe.endswith(("d", "w", "mo")):
        return df

    session_times = pd.to_datetime(df["datetime"], utc=True).dt.tz_convert(EXCHANGE_TIMEZONE)
    market_minutes = session_times.dt.hour * 60 + session_times.dt.minute
    return df[(market_minutes >= REGULAR_MARKET_OPEN_MINUTES) & (market_minutes < REGULAR_MARKET_CLOSE_MINUTES)]
