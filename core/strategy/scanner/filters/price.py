import math

from core.strategy.scanner.filters.base import Filter


def _finite_context_number(context: dict, key: str) -> float | None:
    """Returns a finite numeric context value when available."""
    try:
        value = float(context.get(key))
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


class PriceChangeFilter(Filter):
    def __init__(self, min_change):
        """Creates an intraday absolute price-change filter."""
        self.min_change = min_change

    def apply(self, symbol: str, context: dict) -> bool:
        """Returns true when absolute intraday change exceeds the threshold."""
        value = _finite_context_number(context, "price_change")
        return value is not None and abs(value) >= self.min_change


class PremarketPriceChangeFilter(Filter):
    def __init__(self, min_change):
        """Creates a premarket absolute price-change filter."""
        self.min_change = min_change

    def apply(self, symbol: str, context: dict) -> bool:
        """Returns true when absolute premarket change exceeds the threshold."""
        value = _finite_context_number(context, "premarket_price_change")
        return value is not None and abs(value) >= self.min_change
