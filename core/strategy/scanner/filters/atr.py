import math

from core.strategy.scanner.filters.base import Filter


class ATRFilter(Filter):
    def __init__(self, min_atr):
        """Creates an ATR minimum filter."""
        self.min_atr = min_atr

    def apply(self, symbol: str, context: dict) -> bool:
        """Returns true when absolute ATR exceeds the threshold."""
        try:
            atr = float(context.get("atr"))
        except (TypeError, ValueError):
            return False
        return math.isfinite(atr) and abs(atr) >= self.min_atr
