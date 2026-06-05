import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, quote, urlencode, urlparse, urlunparse
from urllib.request import Request, urlopen

import pandas as pd
import pandas_market_calendars as mcal

from core.control.constants import PROJECT_ROOT
from core.control.market_time import EXCHANGE_TIMEZONE

try:
    from dotenv import load_dotenv
except ImportError:
    load_dotenv = None


MASSIVE_REST_BASE_URL = "https://api.massive.com"
UNIVERSE_CACHE_PATH = PROJECT_ROOT / "core" / "strategy" / "scanner" / "cache" / "us_stocks.txt"
HISTORICAL_METRICS_CACHE_PATH = PROJECT_ROOT / "core" / "strategy" / "scanner" / "cache" / "historical_metrics.json"
UNIVERSE_CACHE_HEADER = "# universe=us_common_stocks"
HISTORICAL_METRICS_CACHE_VERSION = 2
PER_TICKER_HISTORICAL_THRESHOLD = 500
MAX_HISTORICAL_WORKERS = 12

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class MassiveHealthCheck:
    valid: bool
    reason: str = ""


class MassiveAPIError(RuntimeError):
    pass


class MassivePlanError(MassiveAPIError):
    pass


class MassiveDataSource:
    def __init__(
        self,
        cache_path: Path = UNIVERSE_CACHE_PATH,
        historical_metrics_cache_path: Path = HISTORICAL_METRICS_CACHE_PATH,
    ):
        if load_dotenv is not None:
            load_dotenv(PROJECT_ROOT / ".env")

        self.api_key = os.getenv("MASSIVE_KEY")
        self.cache_path = cache_path
        self.historical_metrics_cache_path = historical_metrics_cache_path

    def check_access(self) -> MassiveHealthCheck:
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
        return datetime.now(tz=EXCHANGE_TIMEZONE).date()

    def load_ticker_universe(self) -> list[str]:
        exchange_date = self.exchange_date().isoformat()
        cached = self._read_cached_universe(exchange_date)
        if cached:
            logger.info("Loaded %d US common stock tickers from cache for exchange date %s.", len(cached), exchange_date)
            return cached

        logger.info("Ticker universe cache missing or stale; requesting active US common stock tickers from Massive.")
        tickers = self._request_us_stock_tickers()
        self._write_cached_universe(exchange_date, tickers)
        logger.info("Cached %d US common stock tickers for exchange date %s.", len(tickers), exchange_date)
        return tickers

    def get_full_market_snapshot(self) -> dict[str, dict[str, Any]]:
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

    def get_historical_metrics(self, tickers: list[str], trading_days: int = 30) -> dict[str, dict[str, float]]:
        tickers = sorted(set(ticker.upper() for ticker in tickers if ticker))
        if not tickers:
            return {}

        dates = self._recent_completed_trading_dates(trading_days)
        if not dates:
            logger.warning("No completed trading dates are available for historical scanner metrics.")
            return {}

        cache_key = dates[-1].isoformat()
        cached_metrics = self._read_cached_historical_metrics(cache_key, trading_days)
        metrics = {ticker: cached_metrics[ticker] for ticker in tickers if ticker in cached_metrics}
        missing_tickers = [ticker for ticker in tickers if ticker not in metrics]
        if not missing_tickers:
            logger.info(
                "Loaded historical scanner metrics for %d tickers from cache through %s.",
                len(metrics),
                cache_key,
            )
            return metrics

        logger.info(
            "Historical scanner metrics cache hit for %d/%d tickers through %s; requesting %d missing tickers.",
            len(metrics),
            len(tickers),
            cache_key,
            len(missing_tickers),
        )
        if len(missing_tickers) <= PER_TICKER_HISTORICAL_THRESHOLD:
            fetched_metrics = self._request_ticker_historical_metrics(missing_tickers, dates, trading_days)
        else:
            fetched_metrics = self._request_grouped_historical_metrics(missing_tickers, dates, trading_days)

        if fetched_metrics:
            all_cached_metrics = {**cached_metrics, **fetched_metrics}
            self._write_cached_historical_metrics(cache_key, trading_days, all_cached_metrics)
            metrics.update({ticker: fetched_metrics[ticker] for ticker in missing_tickers if ticker in fetched_metrics})

        logger.info("Built historical scanner metrics for %d requested tickers.", len(metrics))
        return metrics

    def _request_grouped_historical_metrics(
        self,
        tickers: list[str],
        dates: list[date],
        trading_days: int,
    ) -> dict[str, dict[str, float]]:
        logger.info("Requesting Massive grouped daily bars for %d completed trading days.", len(dates))
        rows: list[dict[str, Any]] = []
        ticker_set = set(tickers)
        workers = min(MAX_HISTORICAL_WORKERS, len(dates))

        def request_date(trading_date: date) -> tuple[date, list[dict[str, Any]]]:
            payload = self._get_json(
                f"/v2/aggs/grouped/locale/us/market/stocks/{trading_date.isoformat()}",
                {"adjusted": "true"},
                timeout=20,
            )
            return trading_date, payload.get("results") or []

        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {executor.submit(request_date, trading_date): trading_date for trading_date in dates}
            for future in as_completed(futures):
                trading_date = futures[future]
                try:
                    requested_date, results = future.result()
                except MassiveAPIError as exc:
                    logger.warning("Skipping grouped daily bars for %s: %s", trading_date, exc)
                    continue
                except Exception as exc:
                    logger.warning("Skipping grouped daily bars for %s: %s", trading_date, exc)
                    continue

                for item in results:
                    ticker = str(item.get("T", "")).upper()
                    if ticker in ticker_set:
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

        return self._metrics_from_rows(rows, trading_days)

    def _request_ticker_historical_metrics(
        self,
        tickers: list[str],
        dates: list[date],
        trading_days: int,
    ) -> dict[str, dict[str, float]]:
        start_date = dates[0].isoformat()
        end_date = dates[-1].isoformat()
        rows: list[dict[str, Any]] = []
        workers = min(MAX_HISTORICAL_WORKERS, len(tickers))
        logger.info(
            "Requesting Massive per-ticker daily bars for %d tickers from %s through %s.",
            len(tickers),
            start_date,
            end_date,
        )

        def request_ticker(ticker: str) -> tuple[str, list[dict[str, Any]]]:
            payload = self._get_json(
                f"/v2/aggs/ticker/{quote(ticker, safe='')}/range/1/day/{start_date}/{end_date}",
                {"adjusted": "true", "sort": "asc", "limit": "5000"},
                timeout=12,
            )
            return ticker, payload.get("results") or []

        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {executor.submit(request_ticker, ticker): ticker for ticker in tickers}
            for future in as_completed(futures):
                ticker = futures[future]
                try:
                    requested_ticker, results = future.result()
                except MassiveAPIError as exc:
                    logger.warning("Skipping daily bars for %s: %s", ticker, exc)
                    continue
                except Exception as exc:
                    logger.warning("Skipping daily bars for %s: %s", ticker, exc)
                    continue

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

        return self._metrics_from_rows(rows, trading_days)

    def _metrics_from_rows(self, rows: list[dict[str, Any]], trading_days: int) -> dict[str, dict[str, float]]:
        if not rows:
            logger.warning("Massive returned no daily bars for the requested scanner tickers.")
            return {}

        frame = pd.DataFrame(rows)
        for column in ("open", "high", "low", "close", "volume"):
            frame[column] = pd.to_numeric(frame[column], errors="coerce")
        frame = frame.dropna(subset=["open", "high", "low", "close", "volume"])
        frame = frame.sort_values(["ticker", "date"])

        metrics: dict[str, dict[str, float]] = {}
        for ticker, group in frame.groupby("ticker"):
            tail = group.tail(trading_days).copy()
            if tail.empty:
                continue

            previous_close = tail["close"].shift(1)
            true_range = pd.concat(
                [
                    tail["high"] - tail["low"],
                    (tail["high"] - previous_close).abs(),
                    (tail["low"] - previous_close).abs(),
                ],
                axis=1,
            ).max(axis=1)
            metrics[str(ticker)] = {
                "avg_volume": float(tail["volume"].mean()),
                "atr": self._wilder_average(true_range, 14),
            }

        return metrics

    @staticmethod
    def _wilder_average(series: pd.Series, window: int) -> float:
        values = [float(value) for value in series.dropna().tolist()]
        if not values:
            return 0.0
        if len(values) < window:
            return float(sum(values) / len(values))

        average = sum(values[:window]) / window
        for value in values[window:]:
            average = ((average * (window - 1)) + value) / window

        return float(average)

    def _read_cached_historical_metrics(self, cache_key: str, trading_days: int) -> dict[str, dict[str, float]]:
        if not self.historical_metrics_cache_path.exists():
            return {}

        try:
            payload = json.loads(self.historical_metrics_cache_path.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("Ignoring unreadable historical metrics cache: %s", exc)
            return {}

        if payload.get("version") != HISTORICAL_METRICS_CACHE_VERSION:
            return {}
        if payload.get("last_completed_trading_date") != cache_key or payload.get("trading_days") != trading_days:
            return {}

        metrics: dict[str, dict[str, float]] = {}
        for ticker, values in (payload.get("metrics") or {}).items():
            try:
                metrics[ticker.upper()] = {
                    "avg_volume": float(values["avg_volume"]),
                    "atr": float(values["atr"]),
                }
            except (KeyError, TypeError, ValueError):
                continue

        return metrics

    def _write_cached_historical_metrics(
        self,
        cache_key: str,
        trading_days: int,
        metrics: dict[str, dict[str, float]],
    ) -> None:
        self.historical_metrics_cache_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": HISTORICAL_METRICS_CACHE_VERSION,
            "last_completed_trading_date": cache_key,
            "trading_days": trading_days,
            "metrics": metrics,
        }
        self.historical_metrics_cache_path.write_text(json.dumps(payload, sort_keys=True))

    def _request_us_stock_tickers(self) -> list[str]:
        tickers: list[str] = []
        next_url: str | None = None
        params = {
            "market": "stocks",
            "locale": "us",
            "active": "true",
            "type": "CS",
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

    def _recent_completed_trading_dates(self, count: int) -> list[date]:
        exchange_now = datetime.now(tz=EXCHANGE_TIMEZONE)
        end_date = exchange_now.date()
        if exchange_now.time() < time(18, 0):
            end_date = end_date - timedelta(days=1)

        nyse = mcal.get_calendar("NYSE")
        schedule = nyse.schedule(start_date=end_date - timedelta(days=90), end_date=end_date)
        dates = [ts.date() for ts in schedule.index]
        return dates[-count:]

    def _read_cached_universe(self, exchange_date: str) -> list[str]:
        if not self.cache_path.exists():
            return []

        lines = [line.strip() for line in self.cache_path.read_text().splitlines() if line.strip()]
        if len(lines) < 2 or lines[0] != exchange_date or lines[1] != UNIVERSE_CACHE_HEADER:
            return []

        return sorted(set(line.upper() for line in lines[2:] if not line.startswith("#")))

    def _write_cached_universe(self, exchange_date: str, tickers: list[str]) -> None:
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        contents = "\n".join([exchange_date, UNIVERSE_CACHE_HEADER, *tickers]) + "\n"
        self.cache_path.write_text(contents)

    def _get_json(self, path: str, params: dict[str, Any] | None = None, timeout: int = 12) -> dict[str, Any]:
        if not self.api_key:
            raise MassiveAPIError("MASSIVE_KEY is not configured")

        query = dict(params or {})
        query["apiKey"] = self.api_key
        return self._get_json_from_url(f"{MASSIVE_REST_BASE_URL}{path}?{urlencode(query)}", timeout=timeout)

    def _get_json_from_url(self, url: str, timeout: int = 12) -> dict[str, Any]:
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
        if not self.api_key:
            raise MassiveAPIError("MASSIVE_KEY is not configured")

        parsed = urlparse(url)
        query = dict(parse_qsl(parsed.query, keep_blank_values=True))
        query.setdefault("apiKey", self.api_key)
        return urlunparse(parsed._replace(query=urlencode(query)))
