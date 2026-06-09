import math


class Filter:
    def apply(self, symbol: str, context: dict) -> bool:
        """Returns whether a scanner candidate matches this filter."""
        raise NotImplementedError


class MetricRangeFilter(Filter):
    def __init__(self, metric: str, operator: str, values: list[float]):
        """Creates a numeric range filter for a candidate context metric."""
        self.metric = metric
        self.operator = operator
        self.values = values

    def apply(self, symbol: str, context: dict) -> bool:
        """Compares one context metric against the configured range."""
        raw_value = context.get(self.metric)
        if raw_value is None:
            return False

        try:
            value = float(raw_value)
        except (TypeError, ValueError):
            return False
        if not math.isfinite(value):
            return False

        if self.operator == "above":
            return value > self.values[0]
        if self.operator == "under":
            return value < self.values[0]
        if self.operator == "between":
            low, high = sorted(self.values[:2])
            return low <= value <= high
        if self.operator == "outside":
            low, high = sorted(self.values[:2])
            return value < low or value > high

        return False


class SetMembershipFilter(Filter):
    def __init__(self, metric: str, values: list[str]):
        """Creates a categorical filter for a candidate context metric."""
        self.metric = metric
        self.values = {value.strip().casefold() for value in values if value.strip()}

    def apply(self, symbol: str, context: dict) -> bool:
        """Checks whether one context value is among the selected values."""
        value = context.get(self.metric)
        if value is None:
            return False
        return str(value).strip().casefold() in self.values
