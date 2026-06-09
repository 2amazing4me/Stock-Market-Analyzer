import math

from core.strategy.scanner.filters.base import Filter


def _finite_context_number(context: dict, key: str) -> float | None:
    """Returns a finite numeric context value when available."""
    try:
        value = float(context.get(key))
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


class AvgVolumeFilter(Filter):
    def __init__(self, min_volume):
        """Creates an average-volume minimum filter."""
        self.min_volume = min_volume

    def apply(self, symbol: str, context: dict) -> bool:
        """Returns true when average volume exceeds the threshold."""
        value = _finite_context_number(context, "avg_volume")
        return value is not None and value >= self.min_volume


class RelativeVolumeFilter(Filter):
    def __init__(self, min_volume):
        """Creates a relative-volume minimum filter."""
        self.min_volume = min_volume

    def apply(self, symbol: str, context: dict) -> bool:
        """Returns true when relative volume exceeds the threshold."""
        value = _finite_context_number(context, "relative_volume")
        return value is not None and value >= self.min_volume


class PremarketVolumeFilter(Filter):
    def __init__(self, min_volume):
        """Creates a premarket-volume minimum filter."""
        self.min_volume = min_volume

    def apply(self, symbol: str, context: dict) -> bool:
        """Returns true when premarket volume exceeds the threshold."""
        value = _finite_context_number(context, "premarket_volume")
        return value is not None and value >= self.min_volume
