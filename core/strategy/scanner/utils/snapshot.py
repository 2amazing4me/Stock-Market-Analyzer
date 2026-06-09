import math
from datetime import datetime, time
from typing import Any

from core.control.market_time import EXCHANGE_TIMEZONE

REGULAR_SESSION_MINUTES = 390
DAILY_ATR_LIVE_UPDATE_CUTOFF = time(18, 0)
BETA_PERIOD_DAYS = {"1y": 252, "3y": 756, "5y": 1260}
INTRADAY_RELATIVE_VOLUME_MINUTES = {
    "1m": 1,
    "5m": 5,
    "15m": 15,
    "30m": 30,
    "1h": 60,
    "2h": 120,
    "4h": 240,
}
DAILY_RELATIVE_VOLUME_DAYS = {"1d": 1, "1w": 5, "1mo": 30}


def build_candidate_context(
    ticker: str,
    snapshot: dict[str, Any],
    historical_metrics: dict[str, dict[str, float]],
    scanner_name: str,
    fundamental_metrics: dict[str, dict[str, float | str | None]] | None = None,
    metric_periods: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Builds the scanner candidate context from live and historical metrics."""
    historical = historical_metrics.get(ticker, {})

    periods: dict[str, Any] = {
        "avg_volume": 30,
        "avg_dollar_volume": 30,
        "relative_volume": "1d",
        "vwap": "1d",
        "rsi": {"timeframe": "1d", "range": 14},
        "atr": {"timeframe": "1d", "range": 14},
        "atr_pct": {"timeframe": "1d", "range": 14},
        "beta": "5y",
        **(metric_periods or {}),
    }
    rsi_period = periods["rsi"] if isinstance(periods["rsi"], dict) else {"timeframe": "1d", "range": periods["rsi"]}
    atr_period = periods["atr"] if isinstance(periods["atr"], dict) else {"timeframe": "1d", "range": periods["atr"]}
    atr_pct_period = periods["atr_pct"] if isinstance(periods["atr_pct"], dict) else {"timeframe": "1d", "range": periods["atr_pct"]}
    rsi_key = f"rsi_{rsi_period['timeframe']}_{rsi_period['range']}"
    atr_key = f"atr_{atr_period['timeframe']}_{atr_period['range']}"
    atr_pct_source_key = f"atr_{atr_pct_period['timeframe']}_{atr_pct_period['range']}"
    fundamentals = (fundamental_metrics or {}).get(ticker, {})
    vwap_period = str(periods["vwap"])
    price = snapshot_price(snapshot)
    if price is None or price <= 0:
        return None
    atr_pct_denominator = atr_percent_denominator(historical, str(atr_pct_period["timeframe"]), price)

    price_change = snapshot_price_change(snapshot, price)
    price_change_pct = snapshot_price_change_pct(snapshot, price)
    avg_volume = historical.get(f"avg_volume_{periods['avg_volume']}") or fundamentals.get("avg_volume") or historical.get("avg_volume") or 0.0
    beta_period = BETA_PERIOD_DAYS.get(str(periods["beta"]), 1260)
    raw_volume = snapshot_premarket_volume(snapshot) if scanner_name == "premarket" else snapshot_active_volume(snapshot)
    volume = raw_volume if raw_volume > 0 else None
    atr = historical.get(atr_key) or historical.get(f"atr_{atr_period['range']}") or historical.get("atr", 0.0)
    atr_pct_source = historical.get(atr_pct_source_key) or historical.get(f"atr_{atr_pct_period['range']}") or historical.get("atr")

    context = {
        "symbol": ticker,
        "scanner_name": scanner_name,
        "name": fundamentals.get("name"),
        "industry": fundamentals.get("industry"),
        "price": price or 0.0,
        "vwap": historical.get(f"vwap_{vwap_period}") or snapshot_vwap(snapshot),
        "market_cap": fundamentals.get("market_cap"),
        "beta": historical.get(f"beta_{beta_period}") or historical.get("beta"),
        "volume": volume,
        "dollar_volume": _finite_product(price, volume),
        "avg_volume": avg_volume,
        "avg_dollar_volume": historical.get(f"avg_dollar_volume_{periods['avg_dollar_volume']}") or historical.get("avg_dollar_volume") or _finite_product(price, avg_volume),
        "avg_volume_30": historical.get("avg_volume_30") or fundamentals.get("avg_volume"),
        "avg_dollar_volume_30": historical.get("avg_dollar_volume_30") or _finite_product(price, historical.get("avg_volume_30") or fundamentals.get("avg_volume")),
        "rsi": historical.get(rsi_key) or historical.get(f"rsi_{rsi_period['range']}") or historical.get("rsi"),
        "atr": atr,
        "atr_pct": _finite_percent(atr_pct_source, atr_pct_denominator),
    }
    for key, value in historical.items():
        if key.startswith(("avg_volume_", "avg_dollar_volume_", "rsi_", "atr_", "beta_", "vwap_", "close_")):
            context[key] = value
            if key.startswith("avg_volume_"):
                avg_dollar_key = f"avg_dollar_volume_{key.removeprefix('avg_volume_')}"
                context.setdefault(avg_dollar_key, _finite_product(price, value))
            elif key.startswith("atr_"):
                atr_period_key = key.removeprefix("atr_")
                context[f"atr_pct_{atr_period_key}"] = _finite_percent(value, atr_percent_denominator(historical, atr_timeframe_from_key(atr_period_key), price))

    _apply_live_daily_atr(context, snapshot, price)
    if str(atr_period["timeframe"]) == "1d":
        context["atr"] = context.get(atr_key) or context["atr"]
    if str(atr_pct_period["timeframe"]) == "1d":
        denominator = price if context.get("_live_daily_atr_applied") else atr_pct_denominator
        context["atr_pct"] = _finite_percent(context.get(atr_pct_source_key) or atr_pct_source, denominator)

    if scanner_name == "premarket":
        context.update(
            {
                "premarket_price_change": price_change,
                "premarket_price_change_pct": price_change_pct,
                "premarket_volume": volume,
            }
        )
    else:
        context.update(
            {
                "price_change": price_change,
                "price_change_pct": price_change_pct,
            }
        )
        context.update(relative_volume_context(snapshot, volume, historical))
        context["relative_volume"] = context.get(f"relative_volume_{periods['relative_volume']}", 0.0)

    return context


def relative_volume_context(snapshot: dict[str, Any], day_volume: float, historical: dict[str, float]) -> dict[str, float]:
    """Builds relative-volume values for supported intraday and daily periods."""
    values: dict[str, float] = {}
    latest_minute_volume = snapshot_latest_minute_volume(snapshot)
    average_daily_volume = historical.get("avg_volume_30") or historical.get("avg_volume") or 0.0
    for period, minutes in INTRADAY_RELATIVE_VOLUME_MINUTES.items():
        expected_volume = average_daily_volume * (minutes / REGULAR_SESSION_MINUTES)
        estimated_period_volume = latest_minute_volume * minutes
        values[f"relative_volume_{period}"] = estimated_period_volume / expected_volume if expected_volume else 0.0

    for period, days in DAILY_RELATIVE_VOLUME_DAYS.items():
        average_volume = historical.get(f"avg_volume_{days}") or historical.get("avg_volume") or 0.0
        values[f"relative_volume_{period}"] = day_volume / average_volume if average_volume else 0.0

    return values


def prefilter_tickers(
    scanner_name: str,
    tickers: list[str],
    snapshots: dict[str, dict[str, Any]],
) -> list[str]:
    """Returns tickers worth scanning after the live snapshot first pass."""
    if scanner_name not in {"premarket", "intraday"}:
        return [
            ticker
            for ticker in tickers
            if (price := snapshot_price(snapshots.get(ticker, {}))) is not None and price > 0
        ]

    selected: list[str] = []
    for ticker in tickers:
        snapshot = snapshots.get(ticker)
        if not snapshot:
            continue

        price = snapshot_price(snapshot)
        price_change = snapshot_price_change(snapshot, price)
        if scanner_name == "premarket":
            if abs(price_change) > 1 and snapshot_premarket_volume(snapshot) > 50_000:
                selected.append(ticker)
        elif abs(price_change) > 1:
            selected.append(ticker)

    return selected


def _apply_live_daily_atr(context: dict[str, Any], snapshot: dict[str, Any], price: float) -> None:
    """Updates completed-bar daily ATR metrics with the current live day bar."""
    if datetime.now(tz=EXCHANGE_TIMEZONE).time() >= DAILY_ATR_LIVE_UPDATE_CUTOFF:
        return

    true_range = snapshot_daily_true_range(snapshot, price)
    if true_range is None:
        return

    updates: dict[str, float] = {}
    for key, value in context.items():
        period = _daily_atr_period(key)
        previous_atr = _number(value)
        if period is None or previous_atr is None:
            continue
        updates[key] = ((previous_atr * (period - 1)) + true_range) / period

    for key, value in updates.items():
        context[key] = value
        period_key = key.removeprefix("atr_")
        context[f"atr_pct_{period_key}"] = _finite_percent(value, price)
    if updates:
        context["_live_daily_atr_applied"] = True


def atr_percent_denominator(historical: dict[str, float], timeframe: str, fallback_price: float) -> float:
    """Returns the close price aligned with the ATR timeframe for ATR percent."""
    close = _number(historical.get(f"close_{timeframe}"))
    if close is not None and close > 0:
        return close
    return fallback_price


def atr_timeframe_from_key(period_key: str) -> str:
    """Extracts the timeframe part from an ATR metric suffix."""
    parts = period_key.split("_")
    if len(parts) >= 2 and not parts[0].isdigit():
        return parts[0]
    return "1d"


def _daily_atr_period(key: str) -> int | None:
    """Returns the ATR period for supported daily ATR metric keys."""
    if key.startswith("atr_1d_"):
        period = key.removeprefix("atr_1d_")
    elif key.startswith("atr_") and key.removeprefix("atr_").isdigit():
        period = key.removeprefix("atr_")
    else:
        return None

    try:
        value = int(period)
    except ValueError:
        return None
    return value if value > 0 else None


def snapshot_daily_true_range(snapshot: dict[str, Any], price: float | None = None) -> float | None:
    """Calculates true range from the live daily snapshot bar."""
    high = _nested_number(snapshot, "day", "h")
    low = _nested_number(snapshot, "day", "l")
    previous_close = _nested_number(snapshot, "prevDay", "c")
    if high is None or low is None or previous_close is None:
        return None
    if high <= 0 or low <= 0 or previous_close <= 0:
        return None

    close = price if price is not None and price > 0 else _nested_number(snapshot, "day", "c")
    if close is not None:
        high = max(high, close)
        low = min(low, close)

    return max(high - low, abs(high - previous_close), abs(low - previous_close))


def snapshot_price(snapshot: dict[str, Any]) -> float | None:
    """Extracts the latest usable price from a Massive snapshot."""
    return (
        _nested_number(snapshot, "lastTrade", "p")
        or _nested_number(snapshot, "day", "c")
        or _nested_number(snapshot, "min", "c")
    )


def snapshot_volume(snapshot: dict[str, Any]) -> float:
    """Extracts regular-session day volume from a Massive snapshot."""
    return _nested_number(snapshot, "day", "v") or 0.0


def snapshot_active_volume(snapshot: dict[str, Any]) -> float:
    """Extracts current active-session volume from a Massive snapshot."""
    return snapshot_volume(snapshot) or snapshot_premarket_volume(snapshot) or snapshot_latest_minute_volume(snapshot)


def snapshot_vwap(snapshot: dict[str, Any]) -> float | None:
    """Extracts the current session VWAP from a Massive snapshot."""
    return _nested_number(snapshot, "day", "vw") or _nested_number(snapshot, "min", "vw")


def snapshot_latest_minute_volume(snapshot: dict[str, Any]) -> float:
    """Extracts latest minute volume from a Massive snapshot."""
    return _nested_number(snapshot, "min", "v") or 0.0


def snapshot_premarket_volume(snapshot: dict[str, Any]) -> float:
    """Extracts premarket accumulated volume from a Massive snapshot."""
    return _nested_number(snapshot, "min", "av") or snapshot_latest_minute_volume(snapshot) or snapshot_volume(snapshot)


def snapshot_price_change(snapshot: dict[str, Any], price: float | None) -> float:
    """Extracts or calculates absolute price change from a Massive snapshot."""
    todays_change = _number(snapshot.get("todaysChange"))
    if todays_change is not None:
        return todays_change

    previous_close = _nested_number(snapshot, "prevDay", "c")
    if price is None or previous_close is None:
        return 0.0

    return price - previous_close


def snapshot_price_change_pct(snapshot: dict[str, Any], price: float | None) -> float:
    """Extracts or calculates percentage price change from a Massive snapshot."""
    todays_change_pct = _number(snapshot.get("todaysChangePerc"))
    if todays_change_pct is not None:
        return todays_change_pct

    previous_close = _nested_number(snapshot, "prevDay", "c")
    if price is None or previous_close in (None, 0):
        return 0.0

    return ((price - previous_close) / previous_close) * 100


def _nested_number(payload: dict[str, Any], *path: str) -> float | None:
    """Reads a nested numeric field from a Massive payload."""
    current: Any = payload
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return _number(current)


def _number(value: Any) -> float | None:
    """Converts an API value to float when possible."""
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _finite_product(first: Any, second: Any) -> float | None:
    """Returns a finite product for two optional numeric values."""
    first_value = _number(first)
    second_value = _number(second)
    if first_value is None or second_value is None:
        return None
    value = first_value * second_value
    return value if math.isfinite(value) else None


def _finite_percent(numerator: Any, denominator: Any) -> float | None:
    """Returns a finite percentage for two optional numeric values."""
    numerator_value = _number(numerator)
    denominator_value = _number(denominator)
    if numerator_value is None or denominator_value in (None, 0):
        return None
    value = (numerator_value / denominator_value) * 100
    return value if math.isfinite(value) else None
