def format_candidate_for_log(candidate: dict) -> str:
    metric_order = (
        "price",
        "avg_volume",
        "atr",
        "premarket_price_change",
        "premarket_volume",
        "price_change",
        "relative_volume",
        "volume",
    )
    metrics = []
    for key in metric_order:
        if key not in candidate:
            continue
        value = candidate[key]
        if isinstance(value, float):
            metrics.append(f"{key}={value:.2f}")
        else:
            metrics.append(f"{key}={value}")

    return f"{candidate['symbol']} " + ", ".join(metrics)


def format_candidate_for_output(candidate: dict, scanner_name: str) -> str:
    symbol = candidate["symbol"]
    price = f"${candidate.get('price', 0):,.2f}"
    avg_volume = _format_compact_number(candidate.get("avg_volume", 0))
    atr = f"{candidate.get('atr', 0):.2f}"

    if scanner_name == "premarket":
        change = _format_signed_price(candidate["premarket_price_change"])
        volume = _format_compact_number(candidate["premarket_volume"])
        return f"{symbol:<6} {price:>10}  PM {change:>9}  Vol {volume:>8}  Avg {avg_volume:>8}  ATR {atr:>6}"

    change = _format_signed_price(candidate.get("price_change", 0))
    relative_volume = f"{candidate.get('relative_volume', 0):.2f}x"
    volume = _format_compact_number(candidate.get("volume", 0))
    return (
        f"{symbol:<6} {price:>10}  Chg {change:>9}  RVOL {relative_volume:>6}  "
        f"Vol {volume:>8}  Avg {avg_volume:>8}  ATR {atr:>6}"
    )


def _format_compact_number(value: float) -> str:
    """Formats a numeric value compactly for scanner console output."""
    if value is None:
        return "--"
    absolute = abs(value)
    if absolute >= 1_000_000_000:
        return f"{value / 1_000_000_000:.2f}B"
    if absolute >= 1_000_000:
        return f"{value / 1_000_000:.2f}M"
    if absolute >= 1_000:
        return f"{value / 1_000:.1f}K"
    return f"{value:.0f}"


def _format_signed_price(value: float) -> str:
    sign = "+" if value >= 0 else "-"
    return f"{sign}${abs(value):,.2f}"
