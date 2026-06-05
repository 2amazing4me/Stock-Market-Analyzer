import math

import pandas as pd

from backend.app.schemas.stock_indicators import (
    IndicatorLine,
    IndicatorPoint,
    IndicatorRequestItem,
    IndicatorSeriesItem,
)


def find_column(columns: list[str], preferred: str, prefix: str) -> str | None:
    if preferred in columns:
        return preferred

    for column in columns:
        if column.startswith(prefix):
            return column

    return None


def default_period(indicator_type: str) -> int:
    if indicator_type == "RSI":
        return 14
    if indicator_type == "MACD":
        return 12
    if indicator_type == "BBANDS":
        return 20
    if indicator_type == "VWAP":
        return 20
    return 20


def resolve_period(item: IndicatorRequestItem) -> int:
    if item.period is None:
        return default_period(item.type.upper())
    return max(2, int(item.period))


def resolve_positive_int(value: int | None, default: int, minimum: int = 1) -> int:
    if value is None:
        return default
    return max(minimum, int(value))


def resolve_float(value: float | None, default: float, minimum: float = 0.1) -> float:
    if value is None:
        return default
    return max(minimum, float(value))


def to_points(
    unix_times: pd.Series,
    values: pd.Series,
    start_time: int | None = None,
    end_time: int | None = None,
) -> list[IndicatorPoint]:
    aligned = pd.concat([unix_times, values], axis=1).dropna()
    if aligned.empty:
        return []

    if start_time is not None:
        aligned = aligned[aligned.iloc[:, 0] >= start_time]

    if end_time is not None:
        aligned = aligned[aligned.iloc[:, 0] <= end_time]

    points: list[IndicatorPoint] = []
    for _, row in aligned.iterrows():
        value = float(row.iloc[1])
        if not math.isfinite(value):
            continue
        points.append(IndicatorPoint(time=int(row.iloc[0]), value=value))

    return points


def series_from_single_line(
    item: IndicatorRequestItem,
    label: str,
    unix_times: pd.Series,
    line: pd.Series,
    period: int | None,
    start_time: int | None = None,
    end_time: int | None = None,
) -> IndicatorSeriesItem:
    return IndicatorSeriesItem(
        id=item.id,
        type=item.type.upper(),
        period=period,
        lines=[
            IndicatorLine(
                id=f"{item.id}-line",
                label=label,
                points=to_points(unix_times, line, start_time=start_time, end_time=end_time),
            )
        ],
    )
