import asyncio
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

from backend.app.api import routes
from backend.app.schemas.health import HealthResponse
from backend.app.schemas.scanner import ScannerRequest, ScannerResponse
from backend.app.schemas.stock_chart import Candle, StockCandlesResponse
from backend.app.schemas.stock_indicators import IndicatorRequestItem, StockIndicatorsRequest, StockIndicatorsResponse


class ConnectedRequest:
    """Provide the async disconnect interface used by scanner routes."""

    async def is_disconnected(self):
        """Report that the test client is still connected."""
        return False


def test_health_route_returns_service_payload(monkeypatch):
    """Verify the health endpoint serializes the service payload."""
    monkeypatch.setattr(
        routes,
        "build_health_payload",
        lambda request_id: HealthResponse(status="ok", request_id=request_id),
    )

    response = routes.health_check(request_id="test-request")

    assert response.status == "ok"
    assert response.request_id == "test-request"


def test_stock_candles_route_clamps_limit_and_maps_success(monkeypatch):
    """Verify stock candle route normalizes query args before calling service."""
    observed = {}

    def fake_get_stock_candles(**kwargs):
        """Capture candle service kwargs and return a minimal response."""
        observed.update(kwargs)
        return StockCandlesResponse(
            symbol=kwargs["ticker"].upper(),
            timeframe=kwargs["timeframe"],
            candles=[Candle(time=100, open=1, high=2, low=1, close=2, volume=10)],
        )

    monkeypatch.setattr(routes, "get_stock_candles", fake_get_stock_candles)

    response = routes.stock_candles(ticker="aapl", timeframe="1h", limit=10)

    assert observed["limit"] == 50
    assert observed["ticker"] == "aapl"
    assert response.symbol == "AAPL"


def test_stock_candles_route_rejects_conflicting_bounds():
    """Verify mutually exclusive candle bounds produce a client error."""
    with pytest.raises(HTTPException) as exc_info:
        routes.stock_candles(ticker="aapl", before=100, after=50)

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == "Use either before or after, not both."


def test_stock_indicators_route_maps_validation_errors(monkeypatch):
    """Verify indicator service validation errors become HTTP 400 responses."""
    monkeypatch.setattr(
        routes,
        "get_stock_indicators",
        lambda **_: (_ for _ in ()).throw(ValueError("Unsupported indicator type: BAD")),
    )

    with pytest.raises(HTTPException) as exc_info:
        routes.stock_indicators(
            "aapl",
            StockIndicatorsRequest(indicators=[IndicatorRequestItem(id="bad", type="BAD")]),
        )

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == "Unsupported indicator type: BAD"


def test_stock_indicators_route_clamps_limit_and_returns_payload(monkeypatch):
    """Verify indicator route normalizes limit and serializes service output."""
    observed = {}

    def fake_get_stock_indicators(ticker, request):
        """Capture indicator service input and return a minimal response."""
        observed["ticker"] = ticker
        observed["limit"] = request.limit
        return StockIndicatorsResponse(symbol=ticker.upper(), timeframe=request.timeframe, indicators=[])

    monkeypatch.setattr(routes, "get_stock_indicators", fake_get_stock_indicators)

    response = routes.stock_indicators(
        "msft",
        StockIndicatorsRequest(limit=5000, indicators=[IndicatorRequestItem(id="sma", type="SMA")]),
    )

    assert observed == {"ticker": "msft", "limit": 5000}
    assert response.symbol == "MSFT"


def test_scanner_route_returns_service_response(monkeypatch):
    """Verify scanner route delegates to service and serializes results."""
    async def immediate_to_thread(func, *args, **kwargs):
        """Run the threaded scanner callable inline for deterministic route tests."""
        return func(*args, **kwargs)

    monkeypatch.setattr(routes.asyncio, "to_thread", immediate_to_thread)
    monkeypatch.setattr(
        routes,
        "get_scanner_results",
        lambda scanner_request, should_cancel=None: ScannerResponse(
            as_of=datetime(2026, 1, 1, tzinfo=timezone.utc),
            mode=scanner_request.mode,
            scanner_name="custom",
            total_count=0,
            results=[],
        ),
    )

    response = asyncio.run(routes.scanner(ConnectedRequest(), ScannerRequest(mode="custom", filters=[])))

    assert response.mode == "custom"
    assert response.scanner_name == "custom"
