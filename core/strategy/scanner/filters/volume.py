from core.strategy.scanner.filters.base import Filter

class AvgVolumeFilter(Filter):
    def __init__(self, min_volume):
        self.min_volume = min_volume

    def apply(self, symbol: str, context: dict) -> bool:
        return context["avg_volume"] >= self.min_volume
    
class RelativeVolumeFilter(Filter):
    def __init__(self, min_volume):
        self.min_volume = min_volume

    def apply(self, symbol: str, context: dict) -> bool:
        return context["relative_volume"] >= self.min_volume
    
class PremarketVolumeFilter(Filter):
    def __init__(self, min_volume):
        self.min_volume = min_volume

    def apply(self, symbol: str, context: dict) -> bool:
        return context["premarket_volume"] >= self.min_volume