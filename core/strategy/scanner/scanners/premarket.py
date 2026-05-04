from core.strategy.scanner.data.base import MarketDataSource
from core.strategy.scanner.filters.base import Filter
from core.strategy.scanner.indicators.indicators import IndicatorCalculator

class PremarketScanner:
    def __init__(self, data_source: MarketDataSource, filters: list[Filter], batch_size=50):
        self.data_source = data_source
        self.filters = filters
        self.batch_size = batch_size

    def build_context(self, data):
        return {
            "price": data["price"],
            "volume": data["volume"],
            "premarket_change": data.get("premarket_change"),
            "premarket_volume": data.get("premarket_volume"),
        }

    def scan(self, symbols: list[str]) -> list[dict]:
        results = []

        for i in range(0, len(symbols), self.batch_size):
            batch = symbols[i:i+self.batch_size]

            snapshots = self.data_source.get_snapshot_batch(batch)

            for symbol, data in snapshots.items():
                context = self.build_context(data)

                if all(f.apply(symbol, context) for f in self.filters):
                    results.append({
                        "symbol": symbol,
                        **context
                    })

        return results