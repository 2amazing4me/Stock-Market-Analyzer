from core.strategy.scanner.filters.base import Filter, MetricRangeFilter
from core.strategy.scanner.filters.metrics import (
    ATRMetricFilter,
    ATRPercentMetricFilter,
    AvgDollarVolumeMetricFilter,
    AvgVolumeMetricFilter,
    BetaFilter,
    ChangeFilter,
    ChangePercentFilter,
    DollarVolumeFilter,
    MarketCapFilter,
    PriceFilter,
    RSIFilter,
    RelativeVolumeMetricFilter,
    VWAPFilter,
    VolumeFilter,
)


def build_filter(metric: str, operator: str, values: list[float]) -> Filter:
    """Creates the most specific scanner filter for a metric/operator/value set."""
    if metric == "price":
        return PriceFilter(operator, values)
    if metric == "market_cap":
        return MarketCapFilter(operator, values)
    if metric == "price_change":
        return ChangeFilter(operator, values)
    if metric == "price_change_pct":
        return ChangePercentFilter(operator, values)
    if metric == "volume":
        return VolumeFilter(operator, values)
    if metric == "dollar_volume":
        return DollarVolumeFilter(operator, values)
    if metric == "vwap":
        return VWAPFilter(operator, values)
    if metric.startswith("vwap_"):
        return VWAPFilter(operator, values, metric)
    if metric.startswith("relative_volume"):
        return RelativeVolumeMetricFilter(metric, operator, values)
    if metric.startswith("avg_dollar_volume"):
        return AvgDollarVolumeMetricFilter(metric, operator, values)
    if metric.startswith("avg_volume"):
        return AvgVolumeMetricFilter(metric, operator, values)
    if metric.startswith("beta"):
        return BetaFilter(metric, operator, values)
    if metric.startswith("rsi"):
        return RSIFilter(metric, operator, values)
    if metric.startswith("atr_pct"):
        return ATRPercentMetricFilter(metric, operator, values)
    if metric.startswith("atr"):
        return ATRMetricFilter(metric, operator, values)
    return MetricRangeFilter(metric, operator, values)
