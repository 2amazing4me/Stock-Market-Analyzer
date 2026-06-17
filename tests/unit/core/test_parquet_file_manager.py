import os

import pandas as pd

from core.data.market_data_ingestor import parquet_file_manager as manager


def market_frame(rows):
    """Build a market-data DataFrame indexed by datetime for parquet tests."""
    frame = pd.DataFrame(rows)
    frame["datetime"] = pd.to_datetime(frame["datetime"])
    return frame.set_index("datetime")


def test_deduplicate_by_key_keeps_latest_occurrence():
    """Verify duplicate market rows are collapsed by timestamp and instrument."""
    frame = market_frame(
        [
            {"datetime": "2026-01-01", "instrument_id": 1, "close": 10},
            {"datetime": "2026-01-01", "instrument_id": 1, "close": 12},
            {"datetime": "2026-01-01", "instrument_id": 2, "close": 20},
        ]
    )

    result = manager._deduplicate_by_key(frame)

    assert len(result) == 2
    assert result[result["instrument_id"] == 1]["close"].iloc[0] == 12


def test_read_parquet_or_empty_handles_missing_empty_and_invalid_files(tmp_path):
    """Verify parquet reads fail closed for curation workflows."""
    missing = tmp_path / "missing.parquet"
    empty = tmp_path / "empty.parquet"
    invalid = tmp_path / "invalid.parquet"
    valid = tmp_path / "valid.parquet"
    empty.touch()
    invalid.write_text("not parquet")
    expected = market_frame([{"datetime": "2026-01-01", "instrument_id": 1, "close": 10}])
    expected.to_parquet(valid, index=True)

    assert manager._read_parquet_or_empty(missing).empty
    assert manager._read_parquet_or_empty(empty).empty
    assert manager._read_parquet_or_empty(invalid).empty
    pd.testing.assert_frame_equal(manager._read_parquet_or_empty(valid), expected)


def test_patch_missing_rows_appends_only_absent_keys(tmp_path):
    """Verify staged rows patch curated partitions without duplicating keys."""
    curated_dir = tmp_path / "curated" / "1day" / "2026"
    curated_dir.mkdir(parents=True)
    market_frame(
        [
            {"datetime": "2026-01-01", "instrument_id": 1, "close": 10},
        ]
    ).to_parquet(curated_dir / "part-000.parquet", index=True)
    staged = market_frame(
        [
            {"datetime": "2026-01-01", "instrument_id": 1, "close": 99},
            {"datetime": "2026-01-02", "instrument_id": 1, "close": 11},
        ]
    )

    result = manager._patch_missing_rows(staged, str(curated_dir))

    assert len(result) == 2
    assert set(result["close"]) == {10, 11}


def test_merge_staged_parquet_files_moves_new_rows_and_deletes_verified_staged_files(tmp_path, monkeypatch):
    """Verify staged market data is curated and cleaned up end-to-end."""
    monkeypatch.setattr(manager, "PROJECT_ROOT", str(tmp_path))
    staging_dir = tmp_path / "core" / "data" / "historical_market_data" / "staging" / "1day" / "2026"
    curated_dir = tmp_path / "core" / "data" / "historical_market_data" / "curated" / "1day" / "2026"
    staging_dir.mkdir(parents=True)
    curated_dir.mkdir(parents=True)
    market_frame(
        [
            {"datetime": "2026-01-01", "instrument_id": 1, "close": 10},
        ]
    ).to_parquet(curated_dir / "part-000.parquet", index=True)
    staged_file = staging_dir / "req-001.parquet"
    market_frame(
        [
            {"datetime": "2026-01-01", "instrument_id": 1, "close": 99},
            {"datetime": "2026-01-02", "instrument_id": 1, "close": 11},
        ]
    ).to_parquet(staged_file, index=True)

    manager.merge_staged_parquet_files()

    curated = manager._concat_parquet_or_empty([str(path) for path in sorted(curated_dir.glob("part-*.parquet"))])
    assert not os.path.exists(staged_file)
    assert len(manager._deduplicate_by_key(curated)) == 2
    assert set(curated["close"]) == {10, 11}
