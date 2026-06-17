from __future__ import annotations

import pandas as pd

from backend.app.schemas.stock_indicators import (
    IndicatorLine,
    IndicatorSeriesItem,
    StockIndicatorsRequest,
    StockIndicatorsResponse,
)
from backend.app.services.stock_chart_service import get_stock_candle_dataframe
from backend.app.utils.stock_indicator_utils import (
    find_column,
    resolve_float,
    resolve_period,
    resolve_positive_int,
    series_from_single_line,
    to_points,
)

try:
    import pandas_ta as ta
except Exception:  # pragma: no cover
    ta = None


ALLOWED_INDICATOR_TYPES = {"SMA", "EMA", "WMA", "VWAP", "RSI", "MACD", "BBANDS"}


def _sma(values: pd.Series, period: int) -> pd.Series:
    """Calculate a simple moving average over closing values."""
    return values.rolling(window=period, min_periods=period).mean()


def _ema(values: pd.Series, period: int) -> pd.Series:
    """Calculate an exponential moving average over closing values."""
    return values.ewm(span=period, adjust=False, min_periods=period).mean()


def _wma(values: pd.Series, period: int) -> pd.Series:
    """Calculate a weighted moving average over closing values."""
    weights = pd.Series(range(1, period + 1), dtype="float64")
    divisor = float(weights.sum())
    return values.rolling(window=period, min_periods=period).apply(
        lambda window: float((window * weights).sum() / divisor),
        raw=True,
    )


def _vwap(high: pd.Series, low: pd.Series, close: pd.Series, volume: pd.Series) -> pd.Series:
    """Calculate volume-weighted average price from OHLCV series."""
    typical_price = (high + low + close) / 3
    cumulative_volume = volume.cumsum()
    return (typical_price * volume).cumsum() / cumulative_volume.replace(0, pd.NA)


def _rsi(close: pd.Series, period: int) -> pd.Series:
    """Calculate relative strength index from closing prices."""
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    average_gain = gain.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    average_loss = loss.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    relative_strength = average_gain / average_loss.replace(0, pd.NA)
    return 100 - (100 / (1 + relative_strength))


def _macd(close: pd.Series, fast: int, slow: int, signal: int) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Calculate MACD, signal, and histogram series."""
    macd_line = _ema(close, fast) - _ema(close, slow)
    signal_line = _ema(macd_line, signal)
    histogram = macd_line - signal_line
    return macd_line, signal_line, histogram


def _bbands(close: pd.Series, period: int, std_dev: float) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Calculate Bollinger Band upper, middle, and lower series."""
    middle = _sma(close, period)
    deviation = close.rolling(window=period, min_periods=period).std()
    upper = middle + deviation * std_dev
    lower = middle - deviation * std_dev
    return upper, middle, lower


def _frame_from_request_candles(request: StockIndicatorsRequest) -> pd.DataFrame | None:
    """Build an indicator input frame from request-supplied candles."""
    if not request.candles:
        return None

    rows = [
        {
            "datetime": pd.to_datetime(candle.time, unit="s", utc=True),
            "open": candle.open,
            "high": candle.high,
            "low": candle.low,
            "close": candle.close,
            "volume": candle.volume,
            "instrument_id": 0,
            "unix_time": candle.time,
        }
        for candle in request.candles
    ]
    frame = pd.DataFrame(rows)
    frame = frame.sort_values("datetime", ascending=True).drop_duplicates(subset=["datetime"], keep="last")
    return frame


def get_stock_indicators(ticker: str, request: StockIndicatorsRequest) -> StockIndicatorsResponse:
    """Calculate requested technical indicators for a ticker."""
    load_limit = request.limit + request.warmup_bars

    frame = _frame_from_request_candles(request)
    if frame is None:
        frame = get_stock_candle_dataframe(
            ticker=ticker,
            timeframe=request.timeframe,
            limit=load_limit,
            before=request.end_time + 1 if request.end_time is not None else None,
            include_extended_hours=request.include_extended_hours,
            adjusted=request.adjusted,
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

        period = resolve_period(item)

        if indicator_type == "SMA":
            line = ta.sma(close, length=period) if ta is not None else _sma(close, period)
            indicator_results.append(
                series_from_single_line(
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
            line = ta.ema(close, length=period) if ta is not None else _ema(close, period)
            indicator_results.append(
                series_from_single_line(
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
            line = ta.wma(close, length=period) if ta is not None else _wma(close, period)
            indicator_results.append(
                series_from_single_line(
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
            line = ta.vwap(high, low, close, volume) if ta is not None else _vwap(high, low, close, volume)
            band_period = resolve_positive_int(item.band_period, period, minimum=2)
            stdev = (close - line).rolling(window=band_period, min_periods=band_period).std()
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
                            points=to_points(unix_times, line, start_time=request.start_time, end_time=request.end_time),
                        ),
                        IndicatorLine(
                            id=f"{item.id}-vwap-upper",
                            label="VWAP +1σ",
                            points=to_points(unix_times, upper, start_time=request.start_time, end_time=request.end_time),
                        ),
                        IndicatorLine(
                            id=f"{item.id}-vwap-lower",
                            label="VWAP -1σ",
                            points=to_points(unix_times, lower, start_time=request.start_time, end_time=request.end_time),
                        ),
                    ],
                )
            )
            continue

        if indicator_type == "RSI":
            ma_period = resolve_positive_int(item.ma_period, period, minimum=2)
            line = ta.rsi(close, length=period) if ta is not None else _rsi(close, period)
            ma_line = ta.sma(line, length=ma_period) if ta is not None else _sma(line, ma_period)
            indicator_results.append(
                IndicatorSeriesItem(
                    id=item.id,
                    type="RSI",
                    period=period,
                    lines=[
                        IndicatorLine(
                            id=f"{item.id}-rsi",
                            label=f"RSI {period}",
                            points=to_points(
                                unix_times,
                                line,
                                start_time=request.start_time,
                                end_time=request.end_time,
                            ),
                        ),
                        IndicatorLine(
                            id=f"{item.id}-rsi-ma",
                            label=f"RSI MA {ma_period}",
                            points=to_points(
                                unix_times,
                                ma_line,
                                start_time=request.start_time,
                                end_time=request.end_time,
                            ),
                        ),
                    ],
                )
            )
            continue

        if indicator_type == "MACD":
            fast = period
            slow = max(fast + 1, resolve_positive_int(item.slow_period, int(round(fast * 2.2)), minimum=2))
            signal = resolve_positive_int(item.signal_period, 9, minimum=1)
            if ta is not None:
                macd = ta.macd(close, fast=fast, slow=slow, signal=signal)
                if macd is None or macd.empty:
                    macd_lines: list[IndicatorLine] = []
                else:
                    columns = [str(column) for column in macd.columns]
                    macd_col = find_column(columns, f"MACD_{fast}_{slow}_{signal}", "MACD_")
                    signal_col = find_column(columns, f"MACDs_{fast}_{slow}_{signal}", "MACDs_")
                    hist_col = find_column(columns, f"MACDh_{fast}_{slow}_{signal}", "MACDh_")

                    if not macd_col or not signal_col or not hist_col:
                        macd_lines = []
                    else:
                        macd_lines = [
                            IndicatorLine(
                                id=f"{item.id}-macd",
                                label=f"MACD {fast}/{slow}/{signal}",
                                points=to_points(
                                    unix_times,
                                    macd[macd_col],
                                    start_time=request.start_time,
                                    end_time=request.end_time,
                                ),
                            ),
                            IndicatorLine(
                                id=f"{item.id}-signal",
                                label="Signal",
                                points=to_points(
                                    unix_times,
                                    macd[signal_col],
                                    start_time=request.start_time,
                                    end_time=request.end_time,
                                ),
                            ),
                            IndicatorLine(
                                id=f"{item.id}-hist",
                                label="Histogram",
                                points=to_points(
                                    unix_times,
                                    macd[hist_col],
                                    start_time=request.start_time,
                                    end_time=request.end_time,
                                ),
                            ),
                        ]
            else:
                macd_line, signal_line, histogram = _macd(close, fast, slow, signal)
                macd_lines = [
                    IndicatorLine(
                        id=f"{item.id}-macd",
                        label=f"MACD {fast}/{slow}/{signal}",
                        points=to_points(
                            unix_times,
                            macd_line,
                            start_time=request.start_time,
                            end_time=request.end_time,
                        ),
                    ),
                    IndicatorLine(
                        id=f"{item.id}-signal",
                        label="Signal",
                        points=to_points(
                            unix_times,
                            signal_line,
                            start_time=request.start_time,
                            end_time=request.end_time,
                        ),
                    ),
                    IndicatorLine(
                        id=f"{item.id}-hist",
                        label="Histogram",
                        points=to_points(
                            unix_times,
                            histogram,
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
            std_dev = resolve_float(item.std_dev, 2.0)
            if ta is not None:
                bbands = ta.bbands(close, length=period, std=std_dev)
                if bbands is None or bbands.empty:
                    bb_lines: list[IndicatorLine] = []
                else:
                    columns = [str(column) for column in bbands.columns]
                    lower_col = find_column(columns, f"BBL_{period}_{std_dev}", "BBL_")
                    middle_col = find_column(columns, f"BBM_{period}_{std_dev}", "BBM_")
                    upper_col = find_column(columns, f"BBU_{period}_{std_dev}", "BBU_")

                    if not lower_col or not middle_col or not upper_col:
                        bb_lines = []
                    else:
                        bb_lines = [
                            IndicatorLine(
                                id=f"{item.id}-upper",
                                label=f"BB Upper {period}",
                                points=to_points(
                                    unix_times,
                                    bbands[upper_col],
                                    start_time=request.start_time,
                                    end_time=request.end_time,
                                ),
                            ),
                            IndicatorLine(
                                id=f"{item.id}-middle",
                                label=f"BB Mid {period}",
                                points=to_points(
                                    unix_times,
                                    bbands[middle_col],
                                    start_time=request.start_time,
                                    end_time=request.end_time,
                                ),
                            ),
                            IndicatorLine(
                                id=f"{item.id}-lower",
                                label=f"BB Lower {period}",
                                points=to_points(
                                    unix_times,
                                    bbands[lower_col],
                                    start_time=request.start_time,
                                    end_time=request.end_time,
                                ),
                            ),
                        ]
            else:
                upper, middle, lower = _bbands(close, period, std_dev)
                bb_lines = [
                    IndicatorLine(
                        id=f"{item.id}-upper",
                        label=f"BB Upper {period}",
                        points=to_points(
                            unix_times,
                            upper,
                            start_time=request.start_time,
                            end_time=request.end_time,
                        ),
                    ),
                    IndicatorLine(
                        id=f"{item.id}-middle",
                        label=f"BB Mid {period}",
                        points=to_points(
                            unix_times,
                            middle,
                            start_time=request.start_time,
                            end_time=request.end_time,
                        ),
                    ),
                    IndicatorLine(
                        id=f"{item.id}-lower",
                        label=f"BB Lower {period}",
                        points=to_points(
                            unix_times,
                            lower,
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
