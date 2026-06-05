import logging

import pandas as pd

from backend.app.schemas.stock_chart import Candle, StockCandlesResponse
from backend.app.data_sources.massive_stock_chart_source import (
    load_massive_rest_candle_frame,
)
from backend.app.data_sources.stock_chart_local_source import get_local_stock_candle_dataframe
from backend.app.utils.stock_chart_common import is_api_only_timeframe, resolve_timeframe_config

logger = logging.getLogger(__name__)


def get_stock_candle_dataframe(
    ticker: str,
    limit: int = 600,
    timeframe: str = "1d",
    before: int | None = None,
    after: int | None = None,
    include_extended_hours: bool = True,
    adjusted: bool = True,
) -> pd.DataFrame:
    normalized_timeframe = timeframe.strip().lower()
    resolve_timeframe_config(normalized_timeframe)

    try:
        logger.info("Loading candle snapshot for %s from Massive REST.", ticker.upper())
        df = load_massive_rest_candle_frame(
            ticker=ticker,
            timeframe=normalized_timeframe,
            limit=limit,
            before=before,
            after=after,
            include_extended_hours=include_extended_hours,
            adjusted=adjusted,
        )
        df.attrs["source_mode"] = "api_snapshot"
        df.attrs["source_provider"] = "Massive/Polygon.io"
        df.attrs["delayed"] = True
        df.attrs["delay_minutes"] = 15
        logger.info("Massive REST candle snapshot succeeded for %s with %d rows.", ticker.upper(), len(df))
        return df
    except Exception as exc:
        if is_api_only_timeframe(normalized_timeframe):
            logger.warning(
                "Massive REST candle snapshot failed for API-only timeframe %s on %s: %s; no local backup is available.",
                normalized_timeframe,
                ticker.upper(),
                exc,
            )
            raise RuntimeError(
                f"Massive API is unavailable for {normalized_timeframe}; local data starts at 5m."
            ) from exc

        logger.warning(
            "Massive REST candles failed for %s: %s; backing up to local memory.",
            ticker.upper(),
            exc,
        )

    df = get_local_stock_candle_dataframe(
        ticker=ticker,
        timeframe=normalized_timeframe,
        limit=limit,
        before=before,
        after=after,
        include_extended_hours=include_extended_hours,
    )
    df.attrs["source_mode"] = "local"
    df.attrs["source_provider"] = "TwelveData"
    df.attrs["delayed"] = False
    df.attrs["delay_minutes"] = None
    logger.info("Local memory candles succeeded for %s with %d rows.", ticker.upper(), len(df))
    return df


def get_stock_candles(
    ticker: str,
    limit: int = 600,
    timeframe: str = "1d",
    before: int | None = None,
    after: int | None = None,
    include_extended_hours: bool = True,
    adjusted: bool = True,
) -> StockCandlesResponse:
    normalized_timeframe = timeframe.strip().lower()
    df = get_stock_candle_dataframe(
        ticker=ticker,
        timeframe=normalized_timeframe,
        limit=limit,
        before=before,
        after=after,
        include_extended_hours=include_extended_hours,
        adjusted=adjusted,
    )
    price_columns = ["open", "high", "low", "close"]
    df = df[
        df[price_columns].notna().all(axis=1)
        & (df[price_columns] > 0).all(axis=1)
        & (df["high"] >= df["low"])
        & (df["high"] >= df[["open", "close"]].max(axis=1))
        & (df["low"] <= df[["open", "close"]].min(axis=1))
    ]
    if df.empty:
        raise LookupError(f"No valid candle data found for ticker: {ticker}")

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

    return StockCandlesResponse(
        symbol=ticker.upper(),
        timeframe=normalized_timeframe,
        candles=candles,
        source_mode=str(df.attrs.get("source_mode", "local")),
        source_provider=str(df.attrs.get("source_provider", "TwelveData")),
        delayed=bool(df.attrs.get("delayed", False)),
        delay_minutes=df.attrs.get("delay_minutes"),
    )
