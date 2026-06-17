import math

import pytest

from backend.app.schemas.scanner import ScannerColumnMetricsRequest, ScannerFilterRequest
from backend.app.services import scanner_service as service
from core.strategy.scanner.filters.base import SetMembershipFilter


def scanner_filter(**overrides):
    """Build a scanner filter request with readable test defaults."""
    payload = {"field": "price", "operator": "above", "values": [10]}
    payload.update(overrides)
    return ScannerFilterRequest(**payload)


def test_metric_name_respects_period_timeframe_and_ta_options():
    """Verify frontend filter settings map to core metric names."""
    assert service._metric_name(scanner_filter(field="avg_volume", period=60)) == "avg_volume_60"
    assert service._metric_name(scanner_filter(field="beta", period="3y")) == "beta_756"
    assert service._metric_name(scanner_filter(field="vwap", timeframe="5m")) == "vwap_5m"
    assert service._metric_name(scanner_filter(field="rsi", timeframe="1h", range=21)) == "rsi_1h_21"


def test_validate_filter_rejects_invalid_numeric_shape_and_options():
    """Verify invalid filters fail before scanner execution."""
    with pytest.raises(ValueError, match="between requires 2 value"):
        service._validate_filter(scanner_filter(operator="between", values=[10]))

    with pytest.raises(ValueError, match="price must be between"):
        service._validate_filter(scanner_filter(values=[-1]))

    with pytest.raises(ValueError, match="period must be one of"):
        service._validate_filter(scanner_filter(field="avg_volume", period=999))

    with pytest.raises(ValueError, match="timeframe must be one of"):
        service._validate_filter(scanner_filter(field="rsi", timeframe="2d", range=14))


def test_industry_filter_requires_selected_values_and_builds_membership_filter():
    """Verify categorical scanner filters become set membership filters."""
    with pytest.raises(ValueError, match="requires at least one selected value"):
        service._validate_filter(scanner_filter(field="industry", values=[], selected_values=[]))

    result = service._core_filter(scanner_filter(field="industry", values=[], selected_values=["Technology"]))

    assert isinstance(result, SetMembershipFilter)
    assert result.apply("AAPL", {"industry": " technology "})
    assert not result.apply("XOM", {"industry": "Energy"})


def test_metric_periods_history_days_and_technical_specs_are_derived_once():
    """Verify scanner enrichment inputs are normalized and deduplicated."""
    filters = [
        scanner_filter(field="avg_volume", period=60),
        scanner_filter(field="relative_volume", period="15m"),
        scanner_filter(field="rsi", timeframe="5m", range=14),
        scanner_filter(field="atr_pct", timeframe="5m", range=14),
        scanner_filter(field="vwap", timeframe="1d"),
        scanner_filter(field="vwap", timeframe="5m"),
        scanner_filter(field="rsi", timeframe="5m", range=14),
    ]

    metric_periods = service._metric_periods(filters)
    specs = service._technical_specs(filters)

    assert metric_periods["avg_volume"] == 60
    assert metric_periods["relative_volume"] == "15m"
    assert metric_periods["rsi"] == {"timeframe": "5m", "range": 14}
    assert service._required_history_days(filters) == service.INDICATOR_WARMUP_BARS + 14
    assert specs == [
        {"metric": "rsi", "timeframe": "5m", "range": 14},
        {"metric": "atr", "timeframe": "5m", "range": 14},
        {"metric": "vwap", "timeframe": "5m"},
    ]


def test_result_from_context_uses_fallbacks_and_json_safe_numbers(monkeypatch):
    """Verify scanner contexts become API-safe response rows."""
    monkeypatch.setattr(service, "local_logo_url", lambda symbol: f"/logos/{symbol}.png")

    result = service._result_from_context(
        {
            "symbol": "AAPL",
            "name": "Apple Inc.",
            "price": "185.5",
            "market_cap": math.inf,
            "premarket_price_change": 1.25,
            "premarket_price_change_pct": 0.67,
            "premarket_volume": 12345,
            "industry": "Technology",
        },
        include_logo=True,
    )

    assert result.symbol == "AAPL"
    assert result.logo_url == "/logos/AAPL.png"
    assert result.price == 185.5
    assert result.market_cap is None
    assert result.change == 1.25
    assert result.change_pct == 0.67
    assert result.volume == 12345


def test_column_metrics_short_circuits_empty_requests():
    """Verify column metric enrichment avoids data-source work without input."""
    response = service.get_scanner_column_metrics(ScannerColumnMetricsRequest(symbols=[], metrics=["price"]))

    assert response.metric_periods == {}
    assert response.calculated_metrics == []
    assert response.results == []
