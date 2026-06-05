import glob
import re
from pathlib import Path

import pandas as pd

from backend.app.utils.stock_chart_common import (
    aggregate_candle_frame,
    filter_regular_market_hours,
    resolve_timeframe_config,
    resolve_timeframe_dir,
    to_unix_seconds,
)
from core.control.helpers import get_instrument_universe_db_conn


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
    timeframe_dir = resolve_timeframe_dir(timeframe)
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
        frame["unix_time"] = frame["datetime"].apply(to_unix_seconds)

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


def get_local_stock_candle_dataframe(
    ticker: str,
    limit: int = 600,
    timeframe: str = "1d",
    before: int | None = None,
    after: int | None = None,
    include_extended_hours: bool = True,
) -> pd.DataFrame:
    normalized_timeframe = timeframe.strip().lower()
    timeframe_config = resolve_timeframe_config(normalized_timeframe)
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
        df = aggregate_candle_frame(df, str(aggregation_rule))

    if "unix_time" not in df.columns:
        df["unix_time"] = df["datetime"].apply(to_unix_seconds)

    if before is not None:
        df = df[df["unix_time"] < before]

    if after is not None:
        df = df[df["unix_time"] > after]

    df = filter_regular_market_hours(df, normalized_timeframe, include_extended_hours)
    df = df.sort_values("datetime", ascending=True).drop_duplicates(subset=["datetime"], keep="last")

    if limit > 0:
        if after is not None and before is None:
            df = df.head(limit)
        else:
            df = df.tail(limit)

    if df.empty:
        raise LookupError("No candle data found for ticker")

    return df
