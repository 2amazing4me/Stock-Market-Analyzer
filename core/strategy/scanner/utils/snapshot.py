from typing import Any


def build_candidate_context(
    ticker: str,
    snapshot: dict[str, Any],
    historical_metrics: dict[str, dict[str, float]],
    scanner_name: str,
) -> dict[str, Any] | None:
    historical = historical_metrics.get(ticker)
    if not historical:
        return None

    price = snapshot_price(snapshot)
    price_change = snapshot_price_change(snapshot, price)
    avg_volume = historical["avg_volume"]
    volume = snapshot_premarket_volume(snapshot) if scanner_name == "premarket" else snapshot_volume(snapshot)

    context = {
        "symbol": ticker,
        "price": price or 0.0,
        "volume": volume,
        "avg_volume": avg_volume,
        "atr": historical["atr"],
    }

    if scanner_name == "premarket":
        context.update(
            {
                "premarket_price_change": price_change,
                "premarket_volume": volume,
            }
        )
    else:
        context.update(
            {
                "price_change": price_change,
                "relative_volume": volume / avg_volume if avg_volume else 0.0,
            }
        )

    return context


def prefilter_tickers(
    scanner_name: str,
    tickers: list[str],
    snapshots: dict[str, dict[str, Any]],
) -> list[str]:
    if scanner_name not in {"premarket", "intraday"}:
        return [ticker for ticker in tickers if ticker in snapshots]

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


def snapshot_price(snapshot: dict[str, Any]) -> float | None:
    return (
        _nested_number(snapshot, "lastTrade", "p")
        or _nested_number(snapshot, "day", "c")
        or _nested_number(snapshot, "min", "c")
    )


def snapshot_volume(snapshot: dict[str, Any]) -> float:
    return _nested_number(snapshot, "day", "v") or 0.0


def snapshot_premarket_volume(snapshot: dict[str, Any]) -> float:
    return _nested_number(snapshot, "min", "av") or snapshot_volume(snapshot)


def snapshot_price_change(snapshot: dict[str, Any], price: float | None) -> float:
    todays_change = _number(snapshot.get("todaysChange"))
    if todays_change is not None:
        return todays_change

    previous_close = _nested_number(snapshot, "prevDay", "c")
    if price is None or previous_close is None:
        return 0.0

    return price - previous_close


def _nested_number(payload: dict[str, Any], *path: str) -> float | None:
    current: Any = payload
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return _number(current)


def _number(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
