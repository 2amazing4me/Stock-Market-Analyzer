from core.strategy.scanner.filters.base import Filter

class PriceChangeFilter(Filter):
    def __init__(self, min_change):
        self.min_change = min_change

    def apply(self, symbol: str, context: dict) -> bool:
        return abs(context["price_change"]) >= self.min_change
    
class PremarketPriceChangeFilter(Filter):
    def __init__(self, min_change):
        self.min_change = min_change

    def apply(self, symbol: str, context: dict) -> bool:
        return abs(context["premarket_price_change"]) >= self.min_change