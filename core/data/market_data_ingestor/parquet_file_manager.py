import os
import glob
import logging
import pandas as pd

from core.control.constants import PROJECT_ROOT
from core.control.logging_config import configure_file_logging

MAX_CURATED_SIZE_BYTES = 50 * 1024 * 1024  # 50 MB
UNIQUE_KEY_COLUMNS = ["datetime", "instrument_id"]
logger = logging.getLogger(__name__)


def _normalize_key_columns(df):
    """Return a copy with merge keys coerced to stable dtypes."""
    if not all(col in df.columns for col in UNIQUE_KEY_COLUMNS):
        return df

    normalized = df.copy()
    normalized["datetime"] = pd.to_datetime(normalized["datetime"], errors="coerce").astype("datetime64[ns]")
    normalized["instrument_id"] = pd.to_numeric(
        normalized["instrument_id"], errors="coerce"
    ).astype("Int64")
    return normalized


def _read_parquet_or_empty(file_path):
    """Return an empty DataFrame when parquet file is missing, empty, or unreadable."""
    if not file_path or not os.path.exists(file_path):
        return pd.DataFrame()

    if os.path.getsize(file_path) == 0:
        return pd.DataFrame()

    try:
        return pd.read_parquet(file_path)
    except Exception as exc:
        logger.warning("[SKIP INVALID PARQUET] %s: %s", file_path, exc)
        return pd.DataFrame()


def _concat_parquet_or_empty(paths):
    """Concatenate readable parquet files, skipping empty ones."""
    frames = []
    for path in paths:
        df = _read_parquet_or_empty(path)
        if not df.empty:
            frames.append(df)

    return pd.concat(frames) if frames else pd.DataFrame()


def _deduplicate_by_key(df, context_label=""):
    """Drop duplicate rows by (datetime, instrument_id), keeping the latest occurrence."""
    if df.empty:
        return df

    reset = _normalize_key_columns(df.reset_index())
    if not all(col in reset.columns for col in UNIQUE_KEY_COLUMNS):
        return df

    before = len(reset)
    deduped = reset.drop_duplicates(subset=UNIQUE_KEY_COLUMNS, keep="last")
    removed = before - len(deduped)
    if removed > 0:
        prefix = f"[{context_label}] " if context_label else ""
        logger.info("%s[DEDUPED] removed %d duplicate row(s).", prefix, removed)

    return deduped.set_index("datetime")


def _extract_unique_keys(df):
    """Return a DataFrame with unique (datetime, instrument_id) keys."""
    if df.empty:
        return _normalize_key_columns(pd.DataFrame(columns=UNIQUE_KEY_COLUMNS))

    reset = _normalize_key_columns(df.reset_index())
    if not all(col in reset.columns for col in UNIQUE_KEY_COLUMNS):
        return pd.DataFrame(columns=UNIQUE_KEY_COLUMNS)

    return reset[UNIQUE_KEY_COLUMNS].drop_duplicates()

def _next_part_path(curated_dir):
    """Return a path for the next part-NNN.parquet in curated_dir."""
    existing = glob.glob(f"{curated_dir}/part-*.parquet")
    next_index = len(existing)
    return f"{curated_dir}/part-{next_index:03d}.parquet"

def _latest_part_path(curated_dir):
    """Return the most recently modified part-NNN.parquet in curated_dir, or None."""
    existing = sorted(glob.glob(f"{curated_dir}/part-*.parquet"))
    return existing[-1] if existing else None

def merge_staged_parquet_files():
    """
    Merge the staged parquet files into parquet files (max 50MB) for each interval.
    Output structure:
    historical_market_data/
        curated/
            1day/
                year/
                    part-000.parquet
            1h/
                year/
                    month/
                        part-000.parquet
                        part-001.parquet
                        ...
            5min/
                year/
                    month/
                        part-000.parquet
                        part-001.parquet
                        ...
    """
    for interval in ["1day", "1h", "5min"]:
        staging_path = f"{PROJECT_ROOT}/core/data/historical_market_data/staging/{interval}"
        curated_path = f"{PROJECT_ROOT}/core/data/historical_market_data/curated/{interval}"

        # Collect all staged files grouped by their relative subpath (year/ or year/month/)
        staged_files = sorted(glob.glob(f"{staging_path}/**/*.parquet", recursive=True))

        # Group staged files by their partition directory (year or year/month)
        partitions = {}
        for f in staged_files:
            rel = os.path.relpath(f, staging_path)          # e.g. 2025/9/req-368.parquet
            partition_dir = os.path.dirname(rel)             # e.g. 2025/9
            partitions.setdefault(partition_dir, []).append(f)

        for partition_dir, files in partitions.items():
            curated_dir = f"{curated_path}/{partition_dir}"
            os.makedirs(curated_dir, exist_ok=True)

            curated_parts = sorted(glob.glob(f"{curated_dir}/part-*.parquet"))
            curated_df = _deduplicate_by_key(
                _concat_parquet_or_empty(curated_parts),
                context_label=f"{interval}/{partition_dir}",
            )
            curated_keys = _extract_unique_keys(curated_df)

            latest = _latest_part_path(curated_dir)
            if latest:
                current_df = _deduplicate_by_key(
                    _read_parquet_or_empty(latest),
                    context_label=f"{interval}/{partition_dir}",
                )
                current_path = latest
            else:
                current_df = pd.DataFrame()
                current_path = _next_part_path(curated_dir)

            for staged_file in files:
                incoming = _read_parquet_or_empty(staged_file)
                if incoming.empty:
                    continue

                incoming = _deduplicate_by_key(incoming, context_label=f"{interval}/{partition_dir}")
                incoming_reset = _normalize_key_columns(incoming.reset_index())

                incoming_with_flag = incoming_reset.merge(
                    curated_keys, on=UNIQUE_KEY_COLUMNS, how="left", indicator=True
                )
                new_rows = incoming_reset[incoming_with_flag["_merge"] == "left_only"]
                if new_rows.empty:
                    os.remove(staged_file)
                    rel = os.path.relpath(staged_file, staging_path)
                    logger.info("[VERIFIED & DELETED] %s", rel)
                    continue

                incoming = new_rows.set_index("datetime")

                current_df = pd.concat([current_df, incoming])
                current_df = _deduplicate_by_key(current_df, context_label=f"{interval}/{partition_dir}")
                current_df.to_parquet(current_path, index=True)

                curated_keys = pd.concat(
                    [curated_keys, _normalize_key_columns(incoming.reset_index())[UNIQUE_KEY_COLUMNS]]
                ).drop_duplicates()

                if os.path.getsize(current_path) >= MAX_CURATED_SIZE_BYTES:
                    # Current part is full — start a new one
                    current_path = _next_part_path(curated_dir)
                    current_df = pd.DataFrame()

            logger.info("[%s/%s] processed %d staged files.", interval, partition_dir, len(files))

    check_staged_file_curation()


def _patch_missing_rows(staged_df, curated_dir):
    """
    Append any rows from staged_df that are missing in the curated partition to
    the latest part file (or a new one if the latest is at the size limit).
    Returns the refreshed concatenated curated DataFrame.
    """
    curated_parts = sorted(glob.glob(f"{curated_dir}/part-*.parquet"))
    curated_df = _deduplicate_by_key(_concat_parquet_or_empty(curated_parts), context_label="patch")

    staged_df = _deduplicate_by_key(staged_df, context_label="patch")
    staged_reset = _normalize_key_columns(staged_df.reset_index())
    curated_reset = (
        _normalize_key_columns(curated_df.reset_index())
        if not curated_df.empty
        else pd.DataFrame(columns=staged_reset.columns)
    )

    # Anti-join: keep only staged rows whose (datetime, instrument_id) key is absent in curated
    keys_in_curated = _normalize_key_columns(curated_reset[["datetime", "instrument_id"]]).drop_duplicates()
    staged_with_flag = staged_reset.merge(keys_in_curated, on=["datetime", "instrument_id"], how="left", indicator=True)
    missing_rows = staged_reset[staged_with_flag["_merge"] == "left_only"].set_index("datetime")

    if missing_rows.empty:
        return curated_df

    current_path = _latest_part_path(curated_dir) or _next_part_path(curated_dir)
    if os.path.exists(current_path) and os.path.getsize(current_path) >= MAX_CURATED_SIZE_BYTES:
        current_path = _next_part_path(curated_dir)
        current_base = pd.DataFrame()
    else:
        current_base = _deduplicate_by_key(_read_parquet_or_empty(current_path), context_label="patch")

    patched = pd.concat([current_base, missing_rows])
    patched = _deduplicate_by_key(patched, context_label="patch")
    os.makedirs(curated_dir, exist_ok=True)
    patched.to_parquet(current_path, index=True)
    logger.info("[PATCHED] wrote %d missing row(s) to %s", len(missing_rows), os.path.basename(current_path))

    # Return the full refreshed curated DataFrame for re-verification
    curated_parts = sorted(glob.glob(f"{curated_dir}/part-*.parquet"))
    return _deduplicate_by_key(_concat_parquet_or_empty(curated_parts), context_label="patch")


def check_staged_file_curation():
    """
    For every remaining staged parquet file, verify that all of its rows are
    present in the corresponding curated partition. If fully found, delete the
    staged file. Otherwise, leave it in place for the next merge run.
    """
    for interval in ["1day", "1h", "5min"]:
        staging_path = f"{PROJECT_ROOT}/core/data/historical_market_data/staging/{interval}"
        curated_path = f"{PROJECT_ROOT}/core/data/historical_market_data/curated/{interval}"

        staged_files = sorted(glob.glob(f"{staging_path}/**/*.parquet", recursive=True))

        for staged_file in staged_files:
            rel = os.path.relpath(staged_file, staging_path)   # e.g. 2025/9/req-368.parquet
            partition_dir = os.path.dirname(rel)               # e.g. 2025/9

            curated_dir = f"{curated_path}/{partition_dir}"
            curated_parts = sorted(glob.glob(f"{curated_dir}/part-*.parquet"))

            if not curated_parts:
                logger.warning("[MISSING CURATED] %s - no curated partition found, skipping.", rel)
                continue

            staged_df = _read_parquet_or_empty(staged_file)
            if staged_df.empty:
                os.remove(staged_file)
                logger.info("[EMPTY STAGED & DELETED] %s", rel)
                continue

            staged_df = _deduplicate_by_key(staged_df, context_label="verify")
            curated_df = _deduplicate_by_key(_concat_parquet_or_empty(curated_parts), context_label="verify")

            staged_reset = _normalize_key_columns(staged_df.reset_index())
            curated_reset = (
                _normalize_key_columns(curated_df.reset_index())
                if not curated_df.empty
                else pd.DataFrame(columns=staged_reset.columns)
            )

            # Use an anti-join on the composite key to find truly missing rows.
            # A plain left-merge row-count check is unreliable when either side
            # has duplicate (datetime, instrument_id) keys.
            keys_in_curated = _normalize_key_columns(curated_reset[["datetime", "instrument_id"]]).drop_duplicates()
            staged_with_flag = staged_reset.merge(
                keys_in_curated, on=["datetime", "instrument_id"], how="left", indicator=True
            )
            all_found = (staged_with_flag["_merge"] == "both").all()

            if all_found:
                os.remove(staged_file)
                logger.info("[VERIFIED & DELETED] %s", rel)
            else:
                missing = (~(staged_with_flag["_merge"] == "both")).sum()
                logger.warning("[INCOMPLETE] %s - %d row(s) not found in curated, patching...", rel, missing)

                while not all_found:
                    curated_df = _patch_missing_rows(staged_df, curated_dir)
                    curated_reset = _normalize_key_columns(curated_df.reset_index())
                    keys_in_curated = _normalize_key_columns(curated_reset[["datetime", "instrument_id"]]).drop_duplicates()
                    staged_with_flag = staged_reset.merge(
                        keys_in_curated, on=["datetime", "instrument_id"], how="left", indicator=True
                    )
                    all_found = (staged_with_flag["_merge"] == "both").all()

                os.remove(staged_file)
                logger.info("[VERIFIED & DELETED] %s", rel)

def main():
    configure_file_logging("core/data_ingestion/parquet_file_manager.log")
    merge_staged_parquet_files()


if __name__ == "__main__":
    main()
