from __future__ import annotations

import math

import pandas as pd

from backend.app.schemas.stock_indicators import (
    IndicatorLine,
    IndicatorPoint,
    IndicatorRequestItem,
    IndicatorSeriesItem,
    StockIndicatorsRequest,
    StockIndicatorsResponse,
)
from backend.app.services.stock_chart_service import get_stock_candle_dataframe

try:
    import pandas_ta as ta
except ImportError:  # pragma: no cover
    ta = None


ALLOWED_INDICATOR_TYPES = {"SMA", "EMA", "WMA", "VWAP", "RSI", "MACD", "BBANDS"}


def _find_column(columns: list[str], preferred: str, prefix: str) -> str | None:
    if preferred in columns:
        return preferred

    for column in columns:
        if column.startswith(prefix):
            return column

    return None


def _default_period(indicator_type: str) -> int:
    if indicator_type == "RSI":
        return 14
    if indicator_type == "MACD":
        return 12
    if indicator_type == "BBANDS":
        return 20
    if indicator_type == "VWAP":
        return 20
    return 20


def _resolve_period(item: IndicatorRequestItem) -> int:
    if item.period is None:
        return _default_period(item.type.upper())
    return max(2, int(item.period))


def _to_points(
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


def _series_from_single_line(
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
                points=_to_points(unix_times, line, start_time=start_time, end_time=end_time),
            )
        ],
    )


def get_stock_indicators(ticker: str, request: StockIndicatorsRequest) -> StockIndicatorsResponse:
    if ta is None:
        raise RuntimeError("pandas_ta is not installed. Install pandas-ta to enable indicator computation.")

    load_limit = request.limit + request.warmup_bars

    frame = get_stock_candle_dataframe(
        ticker=ticker,
        timeframe=request.timeframe,
        limit=load_limit,
        before=request.end_time,
    )

    raw_working = frame.copy().set_index("datetime")

    calculation_working = raw_working

    display_working = calculation_working
    if request.start_time is not None:
        display_working = display_working[display_working["unix_time"] >= request.start_time]

    if request.end_time is not None:
        display_working = display_working[display_working["unix_time"] <= request.end_time]

    unix_times = calculation_working["unix_time"]
    close = calculation_working["close"]
    high = calculation_working["high"]
    low = calculation_working["low"]
    volume = calculation_working["volume"]

    indicator_results: list[IndicatorSeriesItem] = []

    for item in request.indicators:
        indicator_type = item.type.upper().strip()
        if indicator_type not in ALLOWED_INDICATOR_TYPES:
            raise ValueError(f"Unsupported indicator type: {item.type}")

        period = _resolve_period(item)

        if indicator_type == "SMA":
            line = ta.sma(close, length=period)
            indicator_results.append(
                _series_from_single_line(
                    item,
                    f"SMA {period}",
                    unix_times,
                    line,
                    period,
                    start_time=request.start_time,
                    end_time=request.end_time,
                )
            )
            continue

        if indicator_type == "EMA":
            line = ta.ema(close, length=period)
            indicator_results.append(
                _series_from_single_line(
                    item,
                    f"EMA {period}",
                    unix_times,
                    line,
                    period,
                    start_time=request.start_time,
                    end_time=request.end_time,
                )
            )
            continue

        if indicator_type == "WMA":
            line = ta.wma(close, length=period)
            indicator_results.append(
                _series_from_single_line(
                    item,
                    f"WMA {period}",
                    unix_times,
                    line,
                    period,
                    start_time=request.start_time,
                    end_time=request.end_time,
                )
            )
            continue

        if indicator_type == "VWAP":
            line = ta.vwap(high, low, close, volume)
            stdev = (close - line).rolling(window=period, min_periods=period).std()
            upper = line + stdev
            lower = line - stdev

            indicator_results.append(
                IndicatorSeriesItem(
                    id=item.id,
                    type="VWAP",
                    period=period,
                    lines=[
                        IndicatorLine(
                            id=f"{item.id}-vwap",
                            label="VWAP",
                            points=_to_points(unix_times, line, start_time=request.start_time, end_time=request.end_time),
                        ),
                        IndicatorLine(
                            id=f"{item.id}-vwap-upper",
                            label="VWAP +1σ",
                            points=_to_points(unix_times, upper, start_time=request.start_time, end_time=request.end_time),
                        ),
                        IndicatorLine(
                            id=f"{item.id}-vwap-lower",
                            label="VWAP -1σ",
                            points=_to_points(unix_times, lower, start_time=request.start_time, end_time=request.end_time),
                        ),
                    ],
                )
            )
            continue

        if indicator_type == "RSI":
            line = ta.rsi(close, length=period)
            indicator_results.append(
                _series_from_single_line(
                    item,
                    f"RSI {period}",
                    unix_times,
                    line,
                    period,
                    start_time=request.start_time,
                    end_time=request.end_time,
                )
            )
            continue

        if indicator_type == "MACD":
            fast = period
            slow = max(fast + 1, int(round(fast * 2.2)))
            signal = 9
            macd = ta.macd(close, fast=fast, slow=slow, signal=signal)
            if macd is None or macd.empty:
                macd_lines: list[IndicatorLine] = []
            else:
                columns = [str(column) for column in macd.columns]
                macd_col = _find_column(columns, f"MACD_{fast}_{slow}_{signal}", "MACD_")
                signal_col = _find_column(columns, f"MACDs_{fast}_{slow}_{signal}", "MACDs_")
                hist_col = _find_column(columns, f"MACDh_{fast}_{slow}_{signal}", "MACDh_")

                if not macd_col or not signal_col or not hist_col:
                    macd_lines = []
                else:
                    macd_lines = [
                        IndicatorLine(
                            id=f"{item.id}-macd",
                            label=f"MACD {fast}/{slow}/{signal}",
                            points=_to_points(
                                unix_times,
                                macd[macd_col],
                                start_time=request.start_time,
                                end_time=request.end_time,
                            ),
                        ),
                        IndicatorLine(
                            id=f"{item.id}-signal",
                            label="Signal",
                            points=_to_points(
                                unix_times,
                                macd[signal_col],
                                start_time=request.start_time,
                                end_time=request.end_time,
                            ),
                        ),
                        IndicatorLine(
                            id=f"{item.id}-hist",
                            label="Histogram",
                            points=_to_points(
                                unix_times,
                                macd[hist_col],
                                start_time=request.start_time,
                                end_time=request.end_time,
                            ),
                        ),
                    ]

            indicator_results.append(
                IndicatorSeriesItem(
                    id=item.id,
                    type="MACD",
                    period=fast,
                    lines=macd_lines,
                )
            )
            continue

        if indicator_type == "BBANDS":
            bbands = ta.bbands(close, length=period, std=2)
            if bbands is None or bbands.empty:
                bb_lines: list[IndicatorLine] = []
            else:
                columns = [str(column) for column in bbands.columns]
                lower_col = _find_column(columns, f"BBL_{period}_2.0", "BBL_")
                middle_col = _find_column(columns, f"BBM_{period}_2.0", "BBM_")
                upper_col = _find_column(columns, f"BBU_{period}_2.0", "BBU_")

                if not lower_col or not middle_col or not upper_col:
                    bb_lines = []
                else:
                    bb_lines = [
                        IndicatorLine(
                            id=f"{item.id}-upper",
                            label=f"BB Upper {period}",
                            points=_to_points(
                                unix_times,
                                bbands[upper_col],
                                start_time=request.start_time,
                                end_time=request.end_time,
                            ),
                        ),
                        IndicatorLine(
                            id=f"{item.id}-middle",
                            label=f"BB Mid {period}",
                            points=_to_points(
                                unix_times,
                                bbands[middle_col],
                                start_time=request.start_time,
                                end_time=request.end_time,
                            ),
                        ),
                        IndicatorLine(
                            id=f"{item.id}-lower",
                            label=f"BB Lower {period}",
                            points=_to_points(
                                unix_times,
                                bbands[lower_col],
                                start_time=request.start_time,
                                end_time=request.end_time,
                            ),
                        ),
                    ]

            indicator_results.append(
                IndicatorSeriesItem(
                    id=item.id,
                    type="BBANDS",
                    period=period,
                    lines=bb_lines,
                )
            )

    return StockIndicatorsResponse(
        symbol=ticker.upper(),
        timeframe=request.timeframe,
        indicators=indicator_results,
    )
