import logging

from core.strategy.scanner.data.base import MarketDataSource
from core.strategy.scanner.filters.base import Filter
from core.strategy.scanner.indicators.indicators import IndicatorCalculator

logger = logging.getLogger(__name__)


class HistoricalScanner:
    def __init__(self, data_source: MarketDataSource, filters: list[Filter]):
        self.data_source = data_source
        self.filters = filters

    def build_context(self, symbol):
        df = self.data_source.get_daily(symbol, lookback=30)

        return {
            "avg_volume": IndicatorCalculator.avg_volume(df),
            "atr": IndicatorCalculator.atr(df),
        }

    def scan(self, symbols: list[str]) -> list[str]:
        results = []

        for symbol in symbols:
            context = self.build_context(symbol)

            if all(f.apply(symbol, context) for f in self.filters):
                results.append(symbol)
            else:
                logger.info("Symbol %s failed historical filters with context: %s", symbol, context)

        return results
