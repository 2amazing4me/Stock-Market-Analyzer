import math
from typing import Any

import pandas as pd

from core.strategy.scanner.preprocessing.constants import (
    ATR_PERIODS,
    AVG_VOLUME_PERIODS,
    BENCHMARK_SYMBOL,
    BETA_PERIODS,
    INDICATOR_WARMUP_BARS,
    RSI_PERIODS,
)


def build_daily_metrics(rows: list[dict[str, Any]], trading_days: int) -> dict[str, dict[str, float | None]]:
    """Builds average volume, RSI, ATR, and beta metrics from daily OHLCV rows."""
    frame = _normalized_frame(rows, preserve_time=False)
    if frame.empty:
        return {}

    benchmark_returns = _daily_returns(frame[frame["ticker"] == BENCHMARK_SYMBOL])
    metrics: dict[str, dict[str, float | None]] = {}
    for ticker, group in frame.groupby("ticker"):
        if ticker == BENCHMARK_SYMBOL:
            continue

        tail = group.tail(trading_days).copy()
        if tail.empty:
            continue

        ticker_metrics: dict[str, float | None] = {}
        _set_finite_metric(ticker_metrics, "close_1d", group["close"].iloc[-1])
        for period in AVG_VOLUME_PERIODS:
            if period <= len(group):
                _set_finite_metric(ticker_metrics, f"avg_volume_{period}", group.tail(period)["volume"].mean())
                _set_finite_metric(ticker_metrics, f"avg_dollar_volume_{period}", average_dollar_volume(group.tail(period)))
        for period in RSI_PERIODS:
            if period < len(group):
                rsi = relative_strength_index(group.tail(indicator_lookback(period))["close"], period)
                _set_finite_metric(ticker_metrics, f"rsi_{period}", rsi)
                _set_finite_metric(ticker_metrics, f"rsi_1d_{period}", rsi)
        for period in ATR_PERIODS:
            if period <= len(group):
                atr = average_true_range(group.tail(indicator_lookback(period)), period)
                _set_finite_metric(ticker_metrics, f"atr_{period}", atr)
                _set_finite_metric(ticker_metrics, f"atr_1d_{period}", atr)
        for period in BETA_PERIODS:
            if period < len(group):
                _set_finite_metric(ticker_metrics, f"beta_{period}", beta(_daily_returns(group.tail(period + 1)), benchmark_returns))

        _set_finite_metric(ticker_metrics, "avg_volume", ticker_metrics.get("avg_volume_30") or tail["volume"].mean())
        _set_finite_metric(ticker_metrics, "avg_dollar_volume", ticker_metrics.get("avg_dollar_volume_30"))
        ticker_metrics["rsi"] = ticker_metrics.get("rsi_14")
        ticker_metrics["atr"] = ticker_metrics.get("atr_14") or ticker_metrics.get("atr_1d_14") or 0.0
        ticker_metrics["beta"] = ticker_metrics.get("beta_1260") or ticker_metrics.get("beta_252")
        metrics[str(ticker)] = ticker_metrics

    return metrics


def build_technical_metrics(rows: list[dict[str, Any]], specs: list[dict[str, Any]]) -> dict[str, dict[str, float]]:
    """Builds selected RSI, ATR, and VWAP metrics from aggregate rows."""
    frame = _normalized_frame(rows, preserve_time=True)
    if frame.empty:
        return {}

    metrics: dict[str, dict[str, float]] = {}
    for ticker, group in frame.groupby("ticker"):
        ticker_metrics: dict[str, float] = {}
        for spec in specs:
            metric = str(spec["metric"])
            timeframe = str(spec["timeframe"])
            value = None
            _set_finite_metric(ticker_metrics, f"close_{timeframe}", group["close"].iloc[-1])
            if metric == "vwap":
                key = f"vwap_{timeframe}"
                value = latest_vwap(group)
            else:
                period = int(spec["range"])
                key = f"{metric}_{timeframe}_{period}"
            if metric == "rsi" and period < len(group):
                value = relative_strength_index(group.tail(indicator_lookback(period))["close"], period)
            elif metric == "atr" and period <= len(group):
                value = average_true_range(group.tail(indicator_lookback(period)), period)
            if value is not None:
                _set_finite_metric(ticker_metrics, key, value)
        if ticker_metrics:
            metrics[str(ticker)] = ticker_metrics

    return metrics


def average_true_range(frame: pd.DataFrame, window: int) -> float:
    """Calculates ATR for one normalized aggregate frame."""
    previous_close = frame["close"].shift(1)
    true_range = pd.concat(
        [
            frame["high"] - frame["low"],
            (frame["high"] - previous_close).abs(),
            (frame["low"] - previous_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    return wilder_average(true_range, window)


def average_dollar_volume(frame: pd.DataFrame) -> float:
    """Calculates average dollar volume as mean close multiplied by volume."""
    dollar_volume = frame["close"].astype(float) * frame["volume"].astype(float)
    return float(dollar_volume.mean())


def latest_vwap(frame: pd.DataFrame) -> float | None:
    """Returns the latest aggregate VWAP or calculates it from close and volume."""
    if frame.empty:
        return None

    if "vwap" in frame.columns:
        latest = optional_float(frame.iloc[-1].get("vwap"))
        if latest is not None:
            return latest

    latest_row = frame.iloc[-1]
    close = optional_float(latest_row.get("close"))
    volume = optional_float(latest_row.get("volume"))
    if close is None or volume is None:
        return None
    return close if volume >= 0 else None


def indicator_lookback(window: int) -> int:
    """Returns the minimum bar count used to warm up Wilder indicators."""
    return window + INDICATOR_WARMUP_BARS


def relative_strength_index(series: pd.Series, window: int) -> float:
    """Calculates the latest RSI value for a closing-price series."""
    delta = series.astype(float).diff().dropna()
    if delta.empty:
        return 50.0

    gains = delta.clip(lower=0)
    losses = -delta.clip(upper=0)
    average_gain = wilder_average(gains, window)
    average_loss = wilder_average(losses, window)
    if average_loss == 0:
        return 100.0 if average_gain > 0 else 50.0

    relative_strength = average_gain / average_loss
    return float(100 - (100 / (1 + relative_strength)))


def wilder_average(series: pd.Series, window: int) -> float:
    """Calculates Wilder's smoothed average for an indicator series."""
    values = [float(value) for value in series.dropna().tolist()]
    if not values:
        return 0.0
    if len(values) < window:
        return float(sum(values) / len(values))

    average = sum(values[:window]) / window
    for value in values[window:]:
        average = ((average * (window - 1)) + value) / window

    return float(average)


def beta(returns: pd.Series, benchmark_returns: pd.Series) -> float | None:
    """Calculates beta from ticker returns against benchmark returns."""
    returns = returns[~returns.index.duplicated(keep="last")]
    benchmark_returns = benchmark_returns[~benchmark_returns.index.duplicated(keep="last")]
    aligned = pd.concat([returns, benchmark_returns], axis=1, join="inner").dropna()
    if len(aligned) < 2:
        return None

    variance = aligned.iloc[:, 1].var()
    if variance == 0 or pd.isna(variance):
        return None

    value = float(aligned.iloc[:, 0].cov(aligned.iloc[:, 1]) / variance)
    return value if math.isfinite(value) else None


def optional_float(value: Any) -> float | None:
    """Converts optional values to finite floats."""
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _normalized_frame(rows: list[dict[str, Any]], preserve_time: bool) -> pd.DataFrame:
    """Returns a normalized OHLCV dataframe from provider rows."""
    if not rows:
        return pd.DataFrame()

    frame = pd.DataFrame(rows)
    frame["date"] = _normalize_history_values(frame["date"], preserve_time)
    for column in ("open", "high", "low", "close", "volume"):
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    if "vwap" in frame.columns:
        frame["vwap"] = pd.to_numeric(frame["vwap"], errors="coerce")
    frame = frame.dropna(subset=["date", "open", "high", "low", "close", "volume"])
    return frame.sort_values(["ticker", "date"]).drop_duplicates(["ticker", "date"], keep="last")


def _normalize_history_values(values: pd.Series, preserve_time: bool) -> pd.Series:
    """Normalizes local and provider historical dates or timestamps."""
    numeric_values = pd.to_numeric(values, errors="coerce")
    if numeric_values.notna().any():
        numeric_dates = pd.to_datetime(numeric_values, unit="ms", errors="coerce")
        text_dates = pd.to_datetime(values.where(numeric_values.isna()), errors="coerce")
        normalized = numeric_dates.fillna(text_dates)
    else:
        normalized = pd.to_datetime(values, errors="coerce")

    return normalized if preserve_time else normalized.dt.normalize()


def _daily_returns(frame: pd.DataFrame) -> pd.Series:
    """Returns daily percentage returns indexed by trading date."""
    if frame.empty:
        return pd.Series(dtype=float)

    closes = (
        frame.sort_values("date")
        .groupby("date", sort=True)["close"]
        .last()
        .astype(float)
    )
    return closes.pct_change().dropna()


def _set_finite_metric(metrics: dict[str, float | None], key: str, value: Any) -> None:
    """Stores one metric only when it is a finite numeric value."""
    number = optional_float(value)
    if number is not None:
        metrics[key] = number
