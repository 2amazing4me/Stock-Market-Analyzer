import math

import pandas as pd

from backend.app.schemas.stock_indicators import IndicatorRequestItem
from backend.app.utils import stock_indicator_utils as utils


def test_find_column_prefers_exact_match_then_prefix():
    """Verify pandas-ta output columns are resolved predictably."""
    assert utils.find_column(["MACD_12_26_9", "MACDs_12_26_9"], "MACD_12_26_9", "MACD_") == "MACD_12_26_9"
    assert utils.find_column(["MACD_12_26_9"], "MACD_10_20_9", "MACD_") == "MACD_12_26_9"
    assert utils.find_column(["close"], "MACD_10_20_9", "MACD_") is None


def test_period_and_numeric_resolvers_apply_defaults_and_minimums():
    """Verify indicator option normalization protects calculations."""
    assert utils.resolve_period(IndicatorRequestItem(id="a", type="RSI")) == 14
    assert utils.resolve_period(IndicatorRequestItem(id="a", type="SMA", period=1)) == 2
    assert utils.resolve_positive_int(None, default=9) == 9
    assert utils.resolve_positive_int(0, default=9, minimum=2) == 2
    assert utils.resolve_float(None, default=2.0) == 2.0
    assert utils.resolve_float(0.01, default=2.0, minimum=0.5) == 0.5


def test_to_points_filters_time_window_nan_and_non_finite_values():
    """Verify indicator series are converted to JSON-safe chart points."""
    unix_times = pd.Series([100, 200, 300, 400])
    values = pd.Series([1.0, math.nan, math.inf, 4.0])

    points = utils.to_points(unix_times, values, start_time=150, end_time=450)

    assert [point.model_dump() for point in points] == [{"time": 400, "value": 4.0}]


def test_series_from_single_line_builds_expected_response_shape():
    """Verify a single-line indicator response keeps ids and labels stable."""
    item = IndicatorRequestItem(id="sma-1", type="sma", period=3)
    result = utils.series_from_single_line(
        item,
        "SMA 3",
        pd.Series([100, 200, 300]),
        pd.Series([None, None, 12.5]),
        3,
    )

    assert result.id == "sma-1"
    assert result.type == "SMA"
    assert result.period == 3
    assert result.lines[0].id == "sma-1-line"
    assert result.lines[0].points[0].model_dump() == {"time": 300, "value": 12.5}
