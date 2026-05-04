from core.strategy.scanner.filters.base import Filter

class ATRFilter(Filter):
    def __init__(self, min_atr):
        self.min_atr = min_atr

    def apply(self, symbol: str, context: dict) -> bool:
        return abs(context["atr"]) >= self.min_atr