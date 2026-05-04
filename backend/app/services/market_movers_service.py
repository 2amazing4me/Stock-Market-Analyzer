import glob
from datetime import datetime

import pandas as pd

from backend.app.schemas.market_movers import MarketMover, MarketMoversResponse

from core.control.constants import PROJECT_ROOT
from core.control.helpers import get_instrument_universe_db_conn

CURATED_1DAY_DIR = PROJECT_ROOT / "core" / "data" / "historical_market_data" / "curated" / "1day"


def _load_symbol_map() -> dict[int, str]:
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


def _load_recent_daily_frame() -> pd.DataFrame:
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


def get_market_movers(limit: int = 30) -> MarketMoversResponse:
    df = _load_recent_daily_frame()
    as_of_ts, movers_df = _prepare_movers(df)

    gainers_df = movers_df.sort_values("change_pct", ascending=False).head(limit)
    losers_df = movers_df.sort_values("change_pct", ascending=True).head(limit)

    gainers = [
        MarketMover(
            symbol=row["symbol"],
            instrument_id=int(row["instrument_id"]),
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
            close=float(row["close"]),
            change_pct=float(row["change_pct"]),
            volume=int(row["volume"]),
        )
        for _, row in losers_df.iterrows()
    ]

    return MarketMoversResponse(as_of=datetime.fromtimestamp(as_of_ts.timestamp()), gainers=gainers, losers=losers)
