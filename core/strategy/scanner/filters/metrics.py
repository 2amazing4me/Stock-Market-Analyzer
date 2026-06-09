from core.strategy.scanner.filters.base import MetricRangeFilter


class PriceFilter(MetricRangeFilter):
    def __init__(self, operator: str, values: list[float]):
        """Creates a latest-price range filter."""
        super().__init__("price", operator, values)


class MarketCapFilter(MetricRangeFilter):
    def __init__(self, operator: str, values: list[float]):
        """Creates a market-cap range filter."""
        super().__init__("market_cap", operator, values)


class BetaFilter(MetricRangeFilter):
    def __init__(self, metric: str, operator: str, values: list[float]):
        """Creates a beta range filter for a selected period."""
        super().__init__(metric, operator, values)


class ChangeFilter(MetricRangeFilter):
    def __init__(self, operator: str, values: list[float]):
        """Creates an absolute price-change range filter."""
        super().__init__("price_change", operator, values)


class ChangePercentFilter(MetricRangeFilter):
    def __init__(self, operator: str, values: list[float]):
        """Creates a percentage price-change range filter."""
        super().__init__("price_change_pct", operator, values)


class VolumeFilter(MetricRangeFilter):
    def __init__(self, operator: str, values: list[float]):
        """Creates a live volume range filter."""
        super().__init__("volume", operator, values)


class DollarVolumeFilter(MetricRangeFilter):
    def __init__(self, operator: str, values: list[float]):
        """Creates a live dollar-volume range filter."""
        super().__init__("dollar_volume", operator, values)


class VWAPFilter(MetricRangeFilter):
    def __init__(self, operator: str, values: list[float], metric: str = "vwap"):
        """Creates a VWAP range filter."""
        super().__init__(metric, operator, values)


class RelativeVolumeMetricFilter(MetricRangeFilter):
    def __init__(self, metric: str, operator: str, values: list[float]):
        """Creates a relative-volume range filter for a selected period."""
        super().__init__(metric, operator, values)


class AvgVolumeMetricFilter(MetricRangeFilter):
    def __init__(self, metric: str, operator: str, values: list[float]):
        """Creates an average-volume range filter for a selected period."""
        super().__init__(metric, operator, values)


class AvgDollarVolumeMetricFilter(MetricRangeFilter):
    def __init__(self, metric: str, operator: str, values: list[float]):
        """Creates an average dollar-volume range filter for a selected period."""
        super().__init__(metric, operator, values)


class RSIFilter(MetricRangeFilter):
    def __init__(self, metric: str, operator: str, values: list[float]):
        """Creates an RSI range filter for a selected timeframe and range."""
        super().__init__(metric, operator, values)


class ATRMetricFilter(MetricRangeFilter):
    def __init__(self, metric: str, operator: str, values: list[float]):
        """Creates an ATR range filter for a selected timeframe and range."""
        super().__init__(metric, operator, values)


class ATRPercentMetricFilter(MetricRangeFilter):
    def __init__(self, metric: str, operator: str, values: list[float]):
        """Creates an ATR percent range filter for a selected timeframe and range."""
        super().__init__(metric, operator, values)
