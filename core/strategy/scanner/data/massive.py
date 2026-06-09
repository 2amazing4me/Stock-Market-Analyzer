import asyncio
import json
import logging
import os
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, quote, urlencode, urlparse, urlunparse
from urllib.request import Request, urlopen

from core.control.constants import PROJECT_ROOT
from core.control.market_time import EXCHANGE_TIMEZONE
from core.strategy.scanner.data.company_metadata import (
    get_company_metadata,
    local_industries,
)
from core.strategy.scanner.preprocessing.calendar import recent_completed_trading_dates
from core.strategy.scanner.preprocessing.constants import (
    BENCHMARK_SYMBOL,
    TECHNICAL_TIMEFRAMES,
)
from core.strategy.scanner.preprocessing.historical_metrics import (
    build_daily_metrics,
    build_technical_metrics,
    optional_float,
)

try:
    from dotenv import load_dotenv
except ImportError:
    load_dotenv = None


MASSIVE_REST_BASE_URL = "https://api.massive.com"
UNIVERSE_CACHE_PATH = PROJECT_ROOT / "core" / "strategy" / "scanner" / "cache" / "us_stocks.txt"
UNIVERSE_CACHE_HEADER = "# universe=us_stock_and_dr"
REFERENCE_TICKER_TYPES = ("CS", "ADRC", "ADRP", "ADRR", "ADRW", "GDR")
PER_TICKER_HISTORICAL_THRESHOLD = 500
MAX_HISTORICAL_WORKERS = 12
MAX_HISTORICAL_ROWS = 500_000

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class MassiveHealthCheck:
    valid: bool
    reason: str = ""


class MassiveAPIError(RuntimeError):
    """Represents a recoverable Massive REST API failure."""

    pass


class MassivePlanError(MassiveAPIError):
    """Represents a Massive plan or credential failure."""

    pass


class MassiveDataSource:
    def __init__(
        self,
        cache_path: Path = UNIVERSE_CACHE_PATH,
    ):
        """Creates a Massive-backed scanner data source with a small universe cache."""
        if load_dotenv is not None:
            load_dotenv(PROJECT_ROOT / ".env")

        self.api_key = os.getenv("MASSIVE_KEY")
        self.cache_path = cache_path

    def check_access(self) -> MassiveHealthCheck:
        """Checks whether configured Massive credentials can access scanner data."""
        if not self.api_key:
            return MassiveHealthCheck(False, "MASSIVE_KEY is not configured")

        try:
            payload = self._get_json(
                "/v2/snapshot/locale/us/markets/stocks/tickers",
                {"tickers": "AAPL", "include_otc": "false"},
                timeout=8,
            )
        except MassivePlanError as exc:
            return MassiveHealthCheck(False, str(exc))
        except MassiveAPIError as exc:
            return MassiveHealthCheck(False, str(exc))

        tickers = payload.get("tickers") or []
        if not tickers:
            return MassiveHealthCheck(False, "Massive snapshot endpoint returned no sample ticker")

        return MassiveHealthCheck(True)

    def exchange_date(self) -> date:
        """Returns the exchange-local date used for scanner caches."""
        return datetime.now(tz=EXCHANGE_TIMEZONE).date()

    def load_ticker_universe(self) -> list[str]:
        """Loads active US stocks and depositary receipts from cache or Massive reference data."""
        exchange_date = self.exchange_date().isoformat()
        cached = self._read_cached_universe(exchange_date)
        if cached:
            logger.info("Loaded %d US common stock tickers from cache for exchange date %s.", len(cached), exchange_date)
            return cached

        logger.info("Ticker universe cache missing or stale; requesting active US stock and DR tickers from Massive.")
        tickers = self._request_us_stock_tickers()
        self._write_cached_universe(exchange_date, tickers)
        logger.info("Cached %d US stock and DR tickers for exchange date %s.", len(tickers), exchange_date)
        return tickers

    def get_full_market_snapshot(self) -> dict[str, dict[str, Any]]:
        """Fetches the full Massive stock snapshot keyed by ticker."""
        logger.info("Requesting Massive full-market stock snapshot.")
        payload = self._get_json(
            "/v2/snapshot/locale/us/markets/stocks/tickers",
            {"include_otc": "false"},
            timeout=30,
        )
        snapshots: dict[str, dict[str, Any]] = {}
        for item in payload.get("tickers") or []:
            ticker = str(item.get("ticker", "")).upper()
            if ticker:
                snapshots[ticker] = item

        logger.info("Massive full-market snapshot returned %d tickers.", len(snapshots))
        return snapshots

    def get_historical_metrics(
        self,
        tickers: list[str],
        trading_days: int = 30,
        technical_specs: list[dict[str, Any]] | None = None,
        should_cancel=None,
    ) -> dict[str, dict[str, float]]:
        """Returns request-local average volume, ATR, RSI, and beta metrics."""
        tickers = sorted(set(ticker.upper() for ticker in tickers if ticker))
        if not tickers:
            return {}
        if should_cancel and should_cancel():
            logger.info("Historical scanner metric request cancelled before fetching.")
            return {}

        dates = recent_completed_trading_dates(trading_days)
        if not dates:
            logger.warning("No completed trading dates are available for historical scanner metrics.")
            return {}

        cache_key = dates[-1].isoformat()
        logger.info(
            "Requesting historical scanner metrics for %d tickers through %s without in-memory cache.",
            len(tickers),
            cache_key,
        )
        if len(tickers) <= PER_TICKER_HISTORICAL_THRESHOLD:
            metrics = self._request_ticker_historical_metrics(tickers, dates, trading_days, should_cancel)
        else:
            metrics = self._request_grouped_historical_metrics(tickers, dates, trading_days, should_cancel)

        if should_cancel and should_cancel():
            logger.info("Historical scanner metric request cancelled before extra technical metrics.")
            return metrics

        technical_metrics = self._request_extra_technical_metrics(tickers, technical_specs or [], should_cancel)
        for ticker, values in technical_metrics.items():
            metrics.setdefault(ticker, {}).update(values)

        logger.info("Built historical scanner metrics for %d requested tickers.", len(metrics))
        return metrics

    def _request_grouped_historical_metrics(
        self,
        tickers: list[str],
        dates: list[date],
        trading_days: int,
        should_cancel=None,
    ) -> dict[str, dict[str, float]]:
        """Requests grouped daily bars and derives scanner metrics for many tickers."""
        ticker_set = set(tickers)
        return {
            ticker: values
            for ticker, values in build_daily_metrics(self._request_grouped_historical_rows(tickers, dates, should_cancel), trading_days).items()
            if ticker in ticker_set
        }

    def _request_grouped_historical_rows(
        self,
        tickers: list[str],
        dates: list[date],
        should_cancel=None,
    ) -> list[dict[str, Any]]:
        """Requests grouped daily bars and returns normalized OHLCV rows."""
        return asyncio.run(self._request_grouped_historical_rows_async(tickers, dates, should_cancel))

    async def _request_grouped_historical_rows_async(
        self,
        tickers: list[str],
        dates: list[date],
        should_cancel=None,
    ) -> list[dict[str, Any]]:
        """Requests grouped daily bars concurrently and returns normalized OHLCV rows."""
        if not dates:
            return []
        if should_cancel and should_cancel():
            return []

        logger.info("Requesting Massive grouped daily bars for %d completed trading days.", len(dates))
        rows: list[dict[str, Any]] = []
        requested_ticker_set = set(tickers) | {BENCHMARK_SYMBOL}

        semaphore = asyncio.Semaphore(MAX_HISTORICAL_WORKERS)

        async def request_date(trading_date: date) -> tuple[date, list[dict[str, Any]]]:
            """Requests one grouped daily bar payload for a trading date."""
            async with semaphore:
                if should_cancel and should_cancel():
                    return trading_date, []
                payload = await self._get_json_async(
                    f"/v2/aggs/grouped/locale/us/market/stocks/{trading_date.isoformat()}",
                    {"adjusted": "true"},
                    timeout=20,
                )
            return trading_date, payload.get("results") or []

        results = await asyncio.gather(*(request_date(trading_date) for trading_date in dates), return_exceptions=True)
        for trading_date, result in zip(dates, results):
            if isinstance(result, Exception):
                logger.warning("Skipping grouped daily bars for %s: %s", trading_date, result)
                continue

            requested_date, items = result
            for item in items:
                ticker = str(item.get("T", "")).upper()
                if ticker in requested_ticker_set:
                    rows.append(
                        {
                            "ticker": ticker,
                            "date": requested_date,
                            "open": item.get("o"),
                            "high": item.get("h"),
                            "low": item.get("l"),
                            "close": item.get("c"),
                            "volume": item.get("v"),
                        }
                    )
                    if len(rows) >= MAX_HISTORICAL_ROWS:
                        logger.warning("Grouped historical row cap reached at %d rows; stopping row collection.", MAX_HISTORICAL_ROWS)
                        return rows

        return rows

    def _request_ticker_historical_metrics(
        self,
        tickers: list[str],
        dates: list[date],
        trading_days: int,
        should_cancel=None,
    ) -> dict[str, dict[str, float]]:
        """Requests per-ticker daily bars and derives scanner metrics for few tickers."""
        start_date = dates[0].isoformat()
        end_date = dates[-1].isoformat()
        rows: list[dict[str, Any]] = []
        requested_tickers = sorted(set(tickers) | {BENCHMARK_SYMBOL})
        logger.info(
            "Requesting Massive per-ticker daily bars for %d tickers from %s through %s.",
            len(requested_tickers),
            start_date,
            end_date,
        )

        def request_ticker(ticker: str) -> tuple[str, list[dict[str, Any]]]:
            """Requests daily aggregate bars for one ticker."""
            payload = self._get_json(
                f"/v2/aggs/ticker/{quote(ticker, safe='')}/range/1/day/{start_date}/{end_date}",
                {"adjusted": "true", "sort": "asc", "limit": "5000"},
                timeout=12,
            )
            return ticker, payload.get("results") or []

        for ticker, result in self._run_parallel_requests(request_ticker, requested_tickers, should_cancel).items():
            if isinstance(result, Exception):
                logger.warning("Skipping daily bars for %s: %s", ticker, result)
                continue
            requested_ticker, results = result
            for item in results:
                rows.append(
                    {
                        "ticker": requested_ticker,
                        "date": item.get("t"),
                        "open": item.get("o"),
                        "high": item.get("h"),
                        "low": item.get("l"),
                        "close": item.get("c"),
                        "volume": item.get("v"),
                    }
                )

        ticker_set = set(tickers)
        return {ticker: values for ticker, values in build_daily_metrics(rows, trading_days).items() if ticker in ticker_set}

    def _request_extra_technical_metrics(
        self,
        tickers: list[str],
        technical_specs: list[dict[str, Any]],
        should_cancel=None,
    ) -> dict[str, dict[str, float]]:
        """Requests non-daily RSI, ATR, and VWAP metrics for selected custom filters."""
        specs = [
            spec
            for spec in technical_specs
            if spec.get("metric") in {"rsi", "atr", "vwap"} and spec.get("timeframe") != "1d"
        ]
        if not tickers or not specs:
            return {}

        end_date = self.exchange_date()
        metrics: dict[str, dict[str, float]] = {}
        requested_tickers = sorted(set(tickers))

        def request_ticker(ticker: str) -> tuple[str, dict[str, float]]:
            """Requests the selected non-daily aggregate bars for one ticker."""
            ticker_metrics: dict[str, float] = {}
            specs_by_timeframe: dict[str, list[dict[str, Any]]] = {}
            for spec in specs:
                specs_by_timeframe.setdefault(str(spec["timeframe"]), []).append(spec)

            for timeframe, timeframe_specs in specs_by_timeframe.items():
                multiplier, timespan, lookback_days = TECHNICAL_TIMEFRAMES[timeframe]
                start_date = (end_date - timedelta(days=lookback_days)).isoformat()
                payload = self._get_json(
                    f"/v2/aggs/ticker/{quote(ticker, safe='')}/range/{multiplier}/{timespan}/{start_date}/{end_date.isoformat()}",
                    {"adjusted": "true", "sort": "asc", "limit": "5000"},
                    timeout=12,
                )
                rows = [
                    {
                        "ticker": ticker,
                        "date": item.get("t"),
                        "open": item.get("o"),
                        "high": item.get("h"),
                        "low": item.get("l"),
                        "close": item.get("c"),
                        "volume": item.get("v"),
                        "vwap": item.get("vw"),
                    }
                    for item in payload.get("results") or []
                ]
                frame_metrics = build_technical_metrics(rows, timeframe_specs)
                ticker_metrics.update(frame_metrics.get(ticker, {}))

            return ticker, ticker_metrics

        logger.info("Requesting non-daily scanner TA metrics for %d tickers.", len(requested_tickers))
        for ticker, result in self._run_parallel_requests(request_ticker, requested_tickers, should_cancel).items():
            if isinstance(result, Exception):
                logger.warning("Skipping non-daily TA metrics for %s: %s", ticker, result)
                continue
            requested_ticker, ticker_metrics = result
            if ticker_metrics:
                metrics[requested_ticker] = ticker_metrics

        return metrics

    def get_market_caps(self, tickers: list[str]) -> dict[str, float]:
        """Loads market caps for scanner tickers from cached company metadata."""
        return {
            ticker: values["market_cap"]
            for ticker, values in self.get_fundamental_metrics(tickers).items()
            if values.get("market_cap") is not None
        }

    def has_api_key(self) -> bool:
        """Returns whether Massive REST credentials are configured."""
        return bool(self.api_key)

    def get_fundamental_metrics(self, tickers: list[str]) -> dict[str, dict[str, float | str | None]]:
        """Returns stable cached company metadata for scanner tickers."""
        tickers = sorted(set(ticker.upper() for ticker in tickers if ticker))
        if not tickers:
            return {}

        local_metadata = get_company_metadata(tickers)
        ticker_set = set(tickers)
        selected: dict[str, dict[str, float | str | None]] = {}
        for ticker in ticker_set:
            values = dict(local_metadata.get(ticker, {}))
            if values:
                selected[ticker] = values

        return selected

    def fill_missing_overview_metrics(
        self,
        tickers: list[str],
        metrics: dict[str, dict[str, float | str | None]],
        max_requests: int = 1000,
    ) -> dict[str, dict[str, float | str | None]]:
        """Fills missing market caps from Massive ticker overview for small candidate sets."""
        missing_tickers = [
            ticker.upper()
            for ticker in tickers
            if metrics.get(ticker.upper(), {}).get("market_cap") is None
        ]
        if not missing_tickers or len(missing_tickers) > max_requests:
            return metrics

        def request_ticker(ticker: str) -> tuple[str, float | None]:
            """Requests market cap from Massive ticker overview for one ticker."""
            try:
                payload = self._get_json(f"/v3/reference/tickers/{quote(ticker, safe='')}", timeout=8)
            except MassiveAPIError as exc:
                logger.warning("Skipping ticker overview for %s: %s", ticker, exc)
                return ticker, None

            result = payload.get("results") or {}
            return ticker, optional_float(result.get("market_cap"))

        enriched = {ticker: dict(values) for ticker, values in metrics.items()}
        for ticker, result in self._run_parallel_requests(request_ticker, missing_tickers).items():
            if isinstance(result, Exception):
                logger.warning("Skipping ticker overview for %s: %s", ticker, result)
                continue
            requested_ticker, market_cap = result
            if market_cap is not None:
                enriched.setdefault(requested_ticker, {})["market_cap"] = market_cap

        return enriched

    def fill_missing_average_volume_metrics(
        self,
        tickers: list[str],
        metrics: dict[str, dict[str, float | str | None]],
    ) -> dict[str, dict[str, float | str | None]]:
        """Fills missing average volume from Massive ratio metrics."""
        missing_tickers = [
            ticker.upper()
            for ticker in tickers
            if metrics.get(ticker.upper(), {}).get("avg_volume") is None
        ]
        if not missing_tickers:
            return metrics

        ratio_metrics = self._request_fundamental_ratios()
        enriched = {ticker: dict(values) for ticker, values in metrics.items()}
        for ticker in missing_tickers:
            avg_volume = ratio_metrics.get(ticker, {}).get("avg_volume")
            if avg_volume is not None:
                enriched.setdefault(ticker, {})["avg_volume"] = avg_volume

        return enriched

    def _request_fundamental_ratios(self) -> dict[str, dict[str, float | None]]:
        """Requests Massive stock ratios used by custom scanner filters."""
        metrics: dict[str, dict[str, float | None]] = {}
        next_url: str | None = None
        params = {
            "limit": "50000",
            "sort": "ticker.asc",
        }

        while True:
            payload = self._get_json_from_url(next_url, timeout=30) if next_url else self._get_json(
                "/stocks/financials/v1/ratios",
                params,
                timeout=30,
            )
            for item in payload.get("results") or []:
                ticker = str(item.get("ticker", "")).upper()
                if not ticker:
                    continue
                metrics[ticker] = {
                    "market_cap": optional_float(item.get("market_cap")),
                    "avg_volume": optional_float(item.get("average_volume")),
                    "price": optional_float(item.get("price")),
                }

            next_url = payload.get("next_url")
            if not next_url:
                break

        logger.info("Massive financial ratios returned %d scanner metric rows.", len(metrics))
        return metrics

    def local_industries(self) -> list[str]:
        """Returns the local industry names available for scanner filters."""
        return local_industries()

    @staticmethod
    def _canonical_ticker(ticker: str) -> str:
        """Converts provider-specific share-class separators to Massive format."""
        return str(ticker).upper().replace("/", ".")

    def _request_us_stock_tickers(self) -> list[str]:
        """Requests active US stock and depositary receipt tickers from Massive reference data."""
        tickers: list[str] = []
        for ticker_type in REFERENCE_TICKER_TYPES:
            next_url: str | None = None
            params = {
                "market": "stocks",
                "locale": "us",
                "active": "true",
                "type": ticker_type,
                "limit": "1000",
                "sort": "ticker",
                "order": "asc",
            }

            while True:
                payload = self._get_json_from_url(next_url, timeout=20) if next_url else self._get_json(
                    "/v3/reference/tickers",
                    params,
                    timeout=20,
                )
                for item in payload.get("results") or []:
                    ticker = str(item.get("ticker", "")).upper()
                    if ticker:
                        tickers.append(ticker)

                next_url = payload.get("next_url")
                if not next_url:
                    break

        return sorted(set(tickers))

    def _read_cached_universe(self, exchange_date: str) -> list[str]:
        """Reads the cached ticker universe for the given exchange date."""
        if not self.cache_path.exists():
            return []

        lines = [line.strip() for line in self.cache_path.read_text().splitlines() if line.strip()]
        if len(lines) < 2 or lines[0] != exchange_date or lines[1] != UNIVERSE_CACHE_HEADER:
            return []

        return sorted(set(line.upper() for line in lines[2:] if not line.startswith("#")))

    def _write_cached_universe(self, exchange_date: str, tickers: list[str]) -> None:
        """Writes the daily ticker universe cache."""
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        contents = "\n".join([exchange_date, UNIVERSE_CACHE_HEADER, *tickers]) + "\n"
        self.cache_path.write_text(contents)

    def _get_json(self, path: str, params: dict[str, Any] | None = None, timeout: int = 12) -> dict[str, Any]:
        """Requests a Massive REST path with the configured API key."""
        if not self.api_key:
            raise MassiveAPIError("MASSIVE_KEY is not configured")

        query = dict(params or {})
        query["apiKey"] = self.api_key
        return self._get_json_from_url(f"{MASSIVE_REST_BASE_URL}{path}?{urlencode(query)}", timeout=timeout)

    async def _get_json_async(self, path: str, params: dict[str, Any] | None = None, timeout: int = 12) -> dict[str, Any]:
        """Requests a Massive REST path without blocking the event loop."""
        return await asyncio.to_thread(self._get_json, path, params, timeout)

    def _run_parallel_requests(self, func, items: list[Any], should_cancel=None) -> dict[Any, Any]:
        """Runs blocking provider requests concurrently behind a sync API."""
        async def run_all() -> dict[Any, Any]:
            semaphore = asyncio.Semaphore(MAX_HISTORICAL_WORKERS)

            async def run_one(item: Any) -> tuple[Any, Any]:
                async with semaphore:
                    if should_cancel and should_cancel():
                        return item, RuntimeError("cancelled")
                    try:
                        return item, await asyncio.to_thread(func, item)
                    except Exception as exc:
                        return item, exc

            pairs = await asyncio.gather(*(run_one(item) for item in items))
            return dict(pairs)

        return asyncio.run(run_all())

    def _get_json_from_url(self, url: str, timeout: int = 12) -> dict[str, Any]:
        """Requests a Massive REST URL and validates the JSON response."""
        url = self._url_with_api_key(url)
        request = Request(url, headers={"Accept": "application/json"})

        try:
            with urlopen(request, timeout=timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            if exc.code in {401, 402, 403}:
                raise MassivePlanError(f"Massive API access is invalid or plan does not allow scanner data: HTTP {exc.code} {detail}") from exc
            raise MassiveAPIError(f"Massive API request failed with HTTP {exc.code}: {detail}") from exc
        except (URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise MassiveAPIError(f"Massive API request failed: {exc}") from exc

        status = str(payload.get("status", "")).lower()
        error = payload.get("error") or payload.get("message")
        if status in {"error", "auth_failed"}:
            raise MassivePlanError(f"Massive API access is invalid: {error or status}")

        return payload

    def _url_with_api_key(self, url: str) -> str:
        """Adds the configured Massive API key to a URL when absent."""
        if not self.api_key:
            raise MassiveAPIError("MASSIVE_KEY is not configured")

        parsed = urlparse(url)
        query = dict(parse_qsl(parsed.query, keep_blank_values=True))
        query.setdefault("apiKey", self.api_key)
        return urlunparse(parsed._replace(query=urlencode(query)))
