import json
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from threading import Lock
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

from backend.app.schemas.market_overview import (
    MarketOverviewAsset,
    MarketOverviewPoint,
    MarketOverviewResponse,
)

YAHOO_CHART_BASE_URL = "https://query1.finance.yahoo.com/v8/finance/chart"
YAHOO_SPARK_URL = "https://query1.finance.yahoo.com/v8/finance/spark"
YAHOO_RANGE = "1mo"
YAHOO_INTERVAL = "1d"
YAHOO_TIMEOUT_SECONDS = 8
SPARK_CACHE_SECONDS = 10
CHART_CACHE_SECONDS = 5 * 60

INDEX_ASSETS = (
    {"key": "sp500", "label": "S&P 500", "symbol": "^GSPC"},
    {"key": "nasdaq100", "label": "NASDAQ 100", "symbol": "^NDX"},
)
COMMODITY_ASSETS = (
    {"key": "oil", "label": "WTI OIL", "symbol": "CL=F"},
    {"key": "vix", "label": "VIX", "symbol": "^VIX"},
    {"key": "gold", "label": "GOLD", "symbol": "GC=F"},
)
ALL_ASSETS = INDEX_ASSETS + COMMODITY_ASSETS

_cache_lock = Lock()
_spark_cache: dict[str, object] = {"expires_at": 0.0, "spark": {}}
_chart_cache: dict[str, object] = {"expires_at": 0.0, "assets": []}


def _yahoo_chart_url(symbol: str) -> str:
    """Builds a Yahoo Finance chart API URL for one symbol."""
    query = urlencode({"range": YAHOO_RANGE, "interval": YAHOO_INTERVAL})
    return f"{YAHOO_CHART_BASE_URL}/{quote(symbol, safe='')}?{query}"


def _yahoo_spark_url(symbols: list[str]) -> str:
    """Builds a Yahoo Finance batched spark API URL."""
    query = urlencode({"symbols": ",".join(symbols), "range": "1d", "interval": "1m"})
    return f"{YAHOO_SPARK_URL}?{query}"


def _request_yahoo_chart(symbol: str) -> dict:
    """Fetches a Yahoo Finance chart payload for one symbol."""
    request = Request(
        _yahoo_chart_url(symbol),
        headers={
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0",
        },
    )
    with urlopen(request, timeout=YAHOO_TIMEOUT_SECONDS) as response:
        return json.loads(response.read().decode("utf-8"))


def _request_yahoo_spark(symbols: list[str]) -> dict[str, dict]:
    """Fetches Yahoo Finance spark data for all overview symbols in one request."""
    request = Request(
        _yahoo_spark_url(symbols),
        headers={
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0",
        },
    )
    with urlopen(request, timeout=YAHOO_TIMEOUT_SECONDS) as response:
        payload = json.loads(response.read().decode("utf-8"))

    return {
        str(symbol): row
        for symbol, row in payload.items()
        if isinstance(row, dict)
    }


def _valid_chart_points(timestamps: list[int], closes: list[object]) -> list[MarketOverviewPoint]:
    """Normalizes Yahoo timestamps and close values into valid chart points."""
    points: list[MarketOverviewPoint] = []
    for timestamp, close in zip(timestamps, closes, strict=False):
        if close is None:
            continue
        try:
            price = float(close)
        except (TypeError, ValueError):
            continue
        if price <= 0:
            continue
        points.append(MarketOverviewPoint(time=int(timestamp), price=price))
    return points


def _number(value: object) -> float | None:
    """Converts numeric API fields to floats when possible."""
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _change_pct(points: list[MarketOverviewPoint]) -> float:
    """Calculates percentage change across the visible chart period."""
    if len(points) < 2 or points[0].price == 0:
        return 0.0
    return ((points[-1].price - points[0].price) / points[0].price) * 100


def _asset_from_yahoo(config: dict[str, str]) -> MarketOverviewAsset:
    """Builds one market overview asset from Yahoo Finance chart data."""
    payload = _request_yahoo_chart(config["symbol"])
    result = (payload.get("chart") or {}).get("result") or []
    if not result:
        raise LookupError(f"Yahoo Finance returned no chart data for {config['symbol']}")

    chart = result[0]
    timestamps = chart.get("timestamp") or []
    quote_data = ((chart.get("indicators") or {}).get("quote") or [{}])[0]
    points = _valid_chart_points(timestamps, quote_data.get("close") or [])
    if not points:
        raise LookupError(f"Yahoo Finance returned no valid prices for {config['symbol']}")

    return MarketOverviewAsset(
        key=config["key"],
        label=config["label"],
        symbol=config["symbol"],
        price=points[-1].price,
        change_pct=_change_pct(points),
        chart=points,
    )


def _get_cached_chart_assets() -> list[MarketOverviewAsset]:
    """Returns chart-backed overview assets using a longer shared cache."""
    now = time.monotonic()
    with _cache_lock:
        cached_assets = _chart_cache["assets"]
        if now < float(_chart_cache["expires_at"]) and isinstance(cached_assets, list) and cached_assets:
            return cached_assets

        with ThreadPoolExecutor(max_workers=len(ALL_ASSETS)) as executor:
            assets = list(executor.map(_asset_from_yahoo, ALL_ASSETS))

        _chart_cache["assets"] = assets
        _chart_cache["expires_at"] = time.monotonic() + CHART_CACHE_SECONDS

        return assets


def _get_cached_spark() -> dict[str, dict]:
    """Returns batched Yahoo spark data using a short shared cache."""
    now = time.monotonic()
    with _cache_lock:
        cached_spark = _spark_cache["spark"]
        if now < float(_spark_cache["expires_at"]) and isinstance(cached_spark, dict) and cached_spark:
            return cached_spark

        spark = _request_yahoo_spark([config["symbol"] for config in ALL_ASSETS])
        _spark_cache["spark"] = spark
        _spark_cache["expires_at"] = time.monotonic() + SPARK_CACHE_SECONDS

        return spark


def _latest_spark_price(spark: dict) -> tuple[int, float] | None:
    """Returns the latest valid timestamp and price from Yahoo spark data."""
    timestamps = spark.get("timestamp") or []
    closes = spark.get("close") or []
    for timestamp, close in reversed(list(zip(timestamps, closes, strict=False))):
        price = _number(close)
        if price is not None and price > 0:
            return int(timestamp), price
    return None


def _asset_with_spark(asset: MarketOverviewAsset, spark: dict | None) -> MarketOverviewAsset:
    """Applies the latest Yahoo spark price to a chart-backed overview asset."""
    if not spark:
        return asset

    latest = _latest_spark_price(spark)
    if latest is None:
        return asset

    timestamp, price = latest
    previous_close = _number(spark.get("previousClose")) or _number(spark.get("chartPreviousClose"))
    if previous_close and previous_close > 0:
        change_pct = ((price - previous_close) / previous_close) * 100
    else:
        change_pct = asset.change_pct

    chart = list(asset.chart)
    if chart:
        chart[-1] = MarketOverviewPoint(time=timestamp, price=price)

    return MarketOverviewAsset(
        key=asset.key,
        label=asset.label,
        symbol=asset.symbol,
        price=price,
        change_pct=change_pct,
        chart=chart,
    )


def get_market_overview() -> MarketOverviewResponse:
    """Returns index and macro overview cards from Yahoo Finance."""
    chart_assets = _get_cached_chart_assets()
    spark = _get_cached_spark()
    assets = [_asset_with_spark(asset, spark.get(asset.symbol)) for asset in chart_assets]

    index_count = len(INDEX_ASSETS)
    return MarketOverviewResponse(
        as_of=datetime.now(tz=timezone.utc),
        indices=assets[:index_count],
        commodities=assets[index_count:],
    )
