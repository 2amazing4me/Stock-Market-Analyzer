import logging
from datetime import datetime, time
from typing import Any

import pandas_market_calendars as mcal

from core.control.logging_config import configure_file_logging
from core.control.market_time import (
    EXCHANGE_TIMEZONE,
    PRE_MARKET_START,
    REGULAR_MARKET_END,
    REGULAR_MARKET_START,
)
from core.strategy.scanner.data.massive import MassiveDataSource
from core.strategy.scanner.filters.atr import ATRFilter
from core.strategy.scanner.filters.base import Filter
from core.strategy.scanner.filters.price import PriceChangeFilter, PremarketPriceChangeFilter
from core.strategy.scanner.filters.volume import AvgVolumeFilter, PremarketVolumeFilter, RelativeVolumeFilter
from core.strategy.scanner.utils.output import format_candidate_for_log, format_candidate_for_output
from core.strategy.scanner.utils.snapshot import build_candidate_context, prefilter_tickers

logger = logging.getLogger(__name__)


def _parse_market_time(value: str) -> time:
    return datetime.strptime(value, "%H:%M:%S").time()


PRE_MARKET_START_TIME = _parse_market_time(PRE_MARKET_START)
REGULAR_MARKET_START_TIME = _parse_market_time(REGULAR_MARKET_START)
REGULAR_MARKET_END_TIME = _parse_market_time(REGULAR_MARKET_END)


def _log_and_print(message: str, *args, output_message: str | None = None) -> None:
    formatted = message % args if args else message
    logger.info(formatted)
    print(output_message or formatted, flush=True)


def _error_and_print(message: str, *args, output_message: str | None = None) -> None:
    formatted = message % args if args else message
    logger.error(formatted)
    print(output_message or formatted, flush=True)


def _is_trading_day(date=None) -> bool:
    if date is None:
        date = datetime.now(tz=EXCHANGE_TIMEZONE).date()

    nyse = mcal.get_calendar("NYSE")
    schedule = nyse.schedule(start_date=date, end_date=date)
    return not schedule.empty


def _scanner_data_source() -> MassiveDataSource | None:
    source = MassiveDataSource()
    health = source.check_access()
    if not health.valid:
        _error_and_print(
            "Massive API access is invalid; scanner is shutting down. Reason: %s",
            health.reason,
            output_message=f"Scanner stopped: Massive API access is invalid ({health.reason}).",
        )
        return None

    logger.info("Massive API access is valid for scanner data.")
    return source


def _scan_with_filters(
    scanner_name: str,
    filters: list[Filter],
    source: MassiveDataSource | None = None,
) -> list[dict[str, Any]]:
    source = source or _scanner_data_source()
    if source is None:
        return []

    try:
        tickers = source.load_ticker_universe()
    except Exception as exc:
        _error_and_print(
            "Scanner failed while loading the Massive ticker universe: %s",
            exc,
            output_message=f"Scanner stopped: could not load the ticker universe ({exc}).",
        )
        return []

    if not tickers:
        _log_and_print("No Massive ticker universe found to scan.", output_message="No tickers available to scan.")
        return []

    try:
        snapshots = source.get_full_market_snapshot()
        scan_tickers = prefilter_tickers(scanner_name, tickers, snapshots)
        _print_prefilter_result(scanner_name, len(scan_tickers), len(tickers))
        historical_metrics = source.get_historical_metrics(scan_tickers)
    except Exception as exc:
        _error_and_print(
            "Scanner failed while requesting Massive market data: %s",
            exc,
            output_message=f"Scanner stopped: Massive market data request failed ({exc}).",
        )
        return []

    if not scan_tickers:
        _log_and_print(
            "%s scanner found no tickers after live snapshot prefilter.",
            scanner_name.capitalize(),
            output_message=f"{scanner_name.capitalize()} scanner: no live movers matched the first pass.",
        )
        return []

    _log_and_print(
        "Scanning %d US stock tickers with the %s scanner.",
        len(scan_tickers),
        scanner_name,
        output_message=f"{scanner_name.capitalize()} scanner: checking {len(scan_tickers):,} live movers.",
    )
    results: list[dict[str, Any]] = []
    for ticker in scan_tickers:
        snapshot = snapshots.get(ticker)
        if not snapshot:
            continue

        context = build_candidate_context(ticker, snapshot, historical_metrics, scanner_name)
        if context is None:
            continue

        try:
            passed = all(scanner_filter.apply(ticker, context) for scanner_filter in filters)
        except Exception as exc:
            logger.warning("%s failed filter evaluation: %s", ticker, exc)
            continue

        if passed:
            results.append(context)
            _log_and_print(
                "PASSED %s scanner: %s",
                scanner_name,
                format_candidate_for_log(context),
                output_message=format_candidate_for_output(context, scanner_name),
            )

    _log_and_print(
        "%s scanner found %d candidates.",
        scanner_name.capitalize(),
        len(results),
        output_message=f"{scanner_name.capitalize()} scanner: {len(results):,} candidates found.",
    )
    return results


def _print_prefilter_result(scanner_name: str, selected_count: int, total_count: int) -> None:
    _log_and_print(
        "%s live snapshot prefilter kept %d/%d tickers.",
        scanner_name.capitalize(),
        selected_count,
        total_count,
        output_message=f"{scanner_name.capitalize()} prefilter: {selected_count:,} of {total_count:,} tickers kept.",
    )


def run_premarket_scanner(source: MassiveDataSource | None = None) -> list[dict[str, Any]]:
    filters = [
        AvgVolumeFilter(1_000_000),
        ATRFilter(0.5),
        PremarketPriceChangeFilter(1),
        PremarketVolumeFilter(50_000),
    ]
    return _scan_with_filters("premarket", filters, source=source)


def run_intraday_scanner(source: MassiveDataSource | None = None) -> list[dict[str, Any]]:
    filters = [
        AvgVolumeFilter(1_000_000),
        ATRFilter(0.5),
        RelativeVolumeFilter(1.5),
        PriceChangeFilter(1),
    ]
    return _scan_with_filters("intraday", filters, source=source)


def run_custom_scanner(custom_filters: list[Filter] | None = None) -> list[dict[str, Any]]:
    if not custom_filters:
        logger.info("Custom scanner requested without frontend filters; returning no results for now.")
        return []

    return _scan_with_filters("custom", custom_filters)


def run() -> list[dict[str, Any]]:
    source = _scanner_data_source()
    if source is None:
        return []

    exchange_date = source.exchange_date()
    if not _is_trading_day(exchange_date):
        logger.info("%s is not a trading day. Scanner will not run.", exchange_date)
        return []

    now = datetime.now(tz=EXCHANGE_TIMEZONE).time()
    if PRE_MARKET_START_TIME <= now < REGULAR_MARKET_START_TIME:
        logger.info("Running pre-market scanner.")
        return run_premarket_scanner(source=source)

    if REGULAR_MARKET_START_TIME <= now < REGULAR_MARKET_END_TIME:
        logger.info("Running intraday scanner.")
        return run_intraday_scanner(source=source)

    logger.info("Market is closed. Scanner will not run.")
    return []


if __name__ == "__main__":
    configure_file_logging("core/scanner/scanner.log")
    candidates = run()
    logger.info("Total candidates found: %d", len(candidates))
