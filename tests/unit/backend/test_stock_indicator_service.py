import pytest

from backend.app.schemas.stock_chart import Candle
from backend.app.schemas.stock_indicators import IndicatorRequestItem, StockIndicatorsRequest
from backend.app.services import stock_indicator_service as service


def make_candles(count=40):
    """Build deterministic candles for indicator service tests."""
    return [
        Candle(
            time=1_700_000_000 + index * 60,
            open=100 + index,
            high=102 + index,
            low=99 + index,
            close=100 + index,
            volume=1_000 + index * 10,
        )
        for index in range(count)
    ]


def test_get_stock_indicators_uses_request_candles_without_loading_data(monkeypatch):
    """Verify supplied candles are enough to calculate indicators offline."""
    monkeypatch.setattr(service, "ta", None)
    monkeypatch.setattr(
        service,
        "get_stock_candle_dataframe",
        lambda **_: pytest.fail("external candle loader should not be called"),
    )
    request = StockIndicatorsRequest(
        candles=make_candles(),
        indicators=[
            IndicatorRequestItem(id="sma", type="SMA", period=3),
            IndicatorRequestItem(id="ema", type="EMA", period=3),
            IndicatorRequestItem(id="wma", type="WMA", period=3),
            IndicatorRequestItem(id="macd", type="MACD", period=3, slow_period=6, signal_period=3),
            IndicatorRequestItem(id="bb", type="BBANDS", period=5, std_dev=2),
        ],
    )

    response = service.get_stock_indicators("aapl", request)

    assert response.symbol == "AAPL"
    assert response.timeframe == "1d"
    assert [item.type for item in response.indicators] == ["SMA", "EMA", "WMA", "MACD", "BBANDS"]
    assert response.indicators[0].lines[0].points[0].time == make_candles()[2].time
    assert response.indicators[0].lines[0].points[0].value == pytest.approx(101.0)
    assert len(response.indicators[3].lines) == 3
    assert len(response.indicators[4].lines) == 3


def test_get_stock_indicators_sorts_deduplicates_and_filters_display_window(monkeypatch):
    """Verify candle normalization keeps latest duplicate and applies output bounds."""
    monkeypatch.setattr(service, "ta", None)
    candles = make_candles(8)
    duplicated_time = candles[3].time
    request = StockIndicatorsRequest(
        candles=[candles[4], candles[0], candles[3], candles[2], candles[1], candles[3].model_copy(update={"close": 130})],
        start_time=duplicated_time,
        end_time=candles[4].time,
        indicators=[IndicatorRequestItem(id="sma", type="SMA", period=3)],
    )

    response = service.get_stock_indicators("MSFT", request)
    points = response.indicators[0].lines[0].points

    assert [point.time for point in points] == [duplicated_time, candles[4].time]
    assert points[0].value == pytest.approx((101 + 102 + 130) / 3)


def test_get_stock_indicators_rejects_unsupported_indicator():
    """Verify unsupported indicator names return a service validation error."""
    request = StockIndicatorsRequest(
        candles=make_candles(),
        indicators=[IndicatorRequestItem(id="bad", type="NOPE")],
    )

    with pytest.raises(ValueError, match="Unsupported indicator type"):
        service.get_stock_indicators("AAPL", request)
