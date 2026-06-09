import logging
from datetime import datetime, time
from typing import Any

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
from core.strategy.scanner.preprocessing.calendar import is_trading_day
from core.strategy.scanner.utils.output import format_candidate_for_log, format_candidate_for_output
from core.strategy.scanner.utils.snapshot import build_candidate_context, prefilter_tickers

logger = logging.getLogger(__name__)
HISTORICAL_FILTER_PREFIXES = ("avg_volume", "avg_dollar_volume", "relative_volume", "rsi", "beta", "atr", "atr_pct", "vwap_")
MAX_HISTORICAL_SCAN_TICKERS = 1_000


def _parse_market_time(value: str) -> time:
    """Parses configured market session times."""
    return datetime.strptime(value, "%H:%M:%S").time()


PRE_MARKET_START_TIME = _parse_market_time(PRE_MARKET_START)
REGULAR_MARKET_START_TIME = _parse_market_time(REGULAR_MARKET_START)
REGULAR_MARKET_END_TIME = _parse_market_time(REGULAR_MARKET_END)


def _log_and_print(message: str, *args, output_message: str | None = None) -> None:
    """Logs a scanner progress message and mirrors it to stdout."""
    formatted = message % args if args else message
    logger.info(formatted)
    print(output_message or formatted, flush=True)


def _error_and_print(message: str, *args, output_message: str | None = None) -> None:
    """Logs a scanner error message and mirrors it to stdout."""
    formatted = message % args if args else message
    logger.error(formatted)
    print(output_message or formatted, flush=True)


def _scanner_data_source() -> MassiveDataSource | None:
    """Creates a Massive data source after validating API access."""
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


def _is_historical_filter(scanner_filter: Filter) -> bool:
    """Returns whether a filter needs historical scanner metrics."""
    if isinstance(scanner_filter, (AvgVolumeFilter, RelativeVolumeFilter, ATRFilter)):
        return True

    metric = getattr(scanner_filter, "metric", "")
    if metric == "avg_volume_30":
        return False
    return any(str(metric).startswith(prefix) for prefix in HISTORICAL_FILTER_PREFIXES)


def _split_filters_by_cost(filters: list[Filter]) -> tuple[list[Filter], list[Filter]]:
    """Separates cheap context filters from historical-metric filters."""
    cheap_filters: list[Filter] = []
    historical_filters: list[Filter] = []
    for scanner_filter in filters:
        if _is_historical_filter(scanner_filter):
            historical_filters.append(scanner_filter)
        else:
            cheap_filters.append(scanner_filter)
    return cheap_filters, historical_filters


def _apply_filters(ticker: str, context: dict[str, Any], filters: list[Filter]) -> bool:
    """Applies scanner filters to one candidate context."""
    return all(scanner_filter.apply(ticker, context) for scanner_filter in filters)


def _needs_market_cap_fallback(filters: list[Filter]) -> bool:
    """Returns whether filters require per-ticker market-cap overview fallback."""
    return any(getattr(scanner_filter, "metric", "") == "market_cap" for scanner_filter in filters)


def _needs_average_volume_fallback(filters: list[Filter]) -> bool:
    """Returns whether filters require ratio average-volume metadata."""
    return False


def _allows_broad_historical_scan(filters: list[Filter]) -> bool:
    """Returns whether broad grouped historical requests are acceptable."""
    allowed_prefixes = ("avg_volume", "avg_dollar_volume")
    return bool(filters) and all(str(getattr(scanner_filter, "metric", "")).startswith(allowed_prefixes) for scanner_filter in filters)


def _scan_with_filters(
    scanner_name: str,
    filters: list[Filter],
    source: MassiveDataSource | None = None,
    candidate_tickers: list[str] | None = None,
    fundamental_metrics: dict[str, dict[str, float | str | None]] | None = None,
    historical_days: int = 30,
    metric_periods: dict[str, Any] | None = None,
    technical_specs: list[dict[str, Any]] | None = None,
    should_cancel=None,
) -> list[dict[str, Any]]:
    """Runs a scanner pass over the ticker universe with configured filters."""
    source = source or _scanner_data_source()
    if source is None:
        return []
    if should_cancel and should_cancel():
        logger.info("%s scanner cancelled before loading tickers.", scanner_name.capitalize())
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

    if candidate_tickers is not None:
        candidate_set = {ticker.upper() for ticker in candidate_tickers}
        original_count = len(tickers)
        tickers = [ticker for ticker in tickers if ticker in candidate_set]
        _log_and_print(
            "%s metadata prefilter kept %d/%d tickers.",
            scanner_name.capitalize(),
            len(tickers),
            original_count,
            output_message=f"{scanner_name.capitalize()} metadata prefilter: {len(tickers):,} of {original_count:,} tickers kept.",
        )
        if not tickers:
            _log_and_print(
                "%s scanner found no tickers after metadata prefilter.",
                scanner_name.capitalize(),
                output_message=f"{scanner_name.capitalize()} scanner: no metadata matches.",
            )
            return []

    try:
        snapshots = source.get_full_market_snapshot()
        if should_cancel and should_cancel():
            logger.info("%s scanner cancelled after snapshot request.", scanner_name.capitalize())
            return []
        scan_tickers = prefilter_tickers(scanner_name, tickers, snapshots)
        _print_prefilter_result(scanner_name, len(scan_tickers), len(tickers))
        live_fundamental_metrics = source.get_fundamental_metrics(scan_tickers)
        if fundamental_metrics is None:
            fundamental_metrics = live_fundamental_metrics
        else:
            fundamental_metrics = {
                ticker: {**fundamental_metrics.get(ticker, {}), **live_fundamental_metrics.get(ticker, {})}
                for ticker in set(fundamental_metrics) | set(live_fundamental_metrics)
            }
        if _needs_market_cap_fallback(filters):
            fundamental_metrics = source.fill_missing_overview_metrics(scan_tickers, fundamental_metrics)
        if _needs_average_volume_fallback(filters):
            fundamental_metrics = source.fill_missing_average_volume_metrics(scan_tickers, fundamental_metrics)
    except Exception as exc:
        _error_and_print(
            "Scanner failed while requesting Massive market data: %s",
            exc,
            output_message=f"Scanner stopped: Massive market data request failed ({exc}).",
        )
        return []

    cheap_filters, historical_filters = _split_filters_by_cost(filters)
    cheap_contexts: dict[str, dict[str, Any]] = {}
    for ticker in scan_tickers:
        if should_cancel and should_cancel():
            logger.info("%s scanner cancelled during cheap filter pass.", scanner_name.capitalize())
            return []
        snapshot = snapshots.get(ticker)
        if not snapshot:
            continue

        context = build_candidate_context(ticker, snapshot, {}, scanner_name, fundamental_metrics, metric_periods)
        if context is None:
            continue

        try:
            passed = _apply_filters(ticker, context, cheap_filters)
        except Exception as exc:
            logger.warning("%s failed cheap filter evaluation: %s", ticker, exc)
            continue

        if passed:
            cheap_contexts[ticker] = context

    scan_tickers = list(cheap_contexts)
    if not scan_tickers:
        _log_and_print(
            "%s scanner found no tickers after cheap filter pass.",
            scanner_name.capitalize(),
            output_message=f"{scanner_name.capitalize()} scanner: no cheap-filter matches.",
        )
        return []

    historical_metrics = {}
    if historical_filters and historical_days > 0:
        if len(scan_tickers) > MAX_HISTORICAL_SCAN_TICKERS and not _allows_broad_historical_scan(historical_filters):
            _error_and_print(
                "Historical scanner request rejected for %d tickers; limit is %d.",
                len(scan_tickers),
                MAX_HISTORICAL_SCAN_TICKERS,
                output_message=(
                    f"Scanner stopped: historical filters match {len(scan_tickers):,} tickers before historical data. "
                    f"Add a cheap filter first; limit is {MAX_HISTORICAL_SCAN_TICKERS:,}."
                ),
            )
            return []
        try:
            historical_metrics = source.get_historical_metrics(
                scan_tickers,
                trading_days=historical_days,
                technical_specs=technical_specs,
                should_cancel=should_cancel,
            )
        except Exception as exc:
            _error_and_print(
                "Scanner failed while requesting Massive historical data: %s",
                exc,
                output_message=f"Scanner stopped: Massive historical data request failed ({exc}).",
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
        if should_cancel and should_cancel():
            logger.info("%s scanner cancelled during final filter pass.", scanner_name.capitalize())
            return []
        snapshot = snapshots.get(ticker)
        if not snapshot:
            continue

        context = build_candidate_context(ticker, snapshot, historical_metrics, scanner_name, fundamental_metrics, metric_periods)
        if context is None:
            continue

        try:
            passed = _apply_filters(ticker, context, historical_filters)
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
    """Prints the live snapshot prefilter result."""
    _log_and_print(
        "%s live snapshot prefilter kept %d/%d tickers.",
        scanner_name.capitalize(),
        selected_count,
        total_count,
        output_message=f"{scanner_name.capitalize()} prefilter: {selected_count:,} of {total_count:,} tickers kept.",
    )


def run_premarket_scanner(source: MassiveDataSource | None = None, historical_days: int = 30, should_cancel=None) -> list[dict[str, Any]]:
    """Runs the predefined premarket scanner."""
    filters = [
        AvgVolumeFilter(1_000_000),
        ATRFilter(0.5),
        PremarketPriceChangeFilter(1),
        PremarketVolumeFilter(50_000),
    ]
    return _scan_with_filters("premarket", filters, source=source, historical_days=historical_days, should_cancel=should_cancel)


def run_intraday_scanner(source: MassiveDataSource | None = None, historical_days: int = 30, should_cancel=None) -> list[dict[str, Any]]:
    """Runs the predefined intraday scanner."""
    filters = [
        AvgVolumeFilter(1_000_000),
        ATRFilter(0.5),
        RelativeVolumeFilter(1.5),
        PriceChangeFilter(1),
    ]
    return _scan_with_filters("intraday", filters, source=source, historical_days=historical_days, should_cancel=should_cancel)


def run_custom_scanner(
    custom_filters: list[Filter] | None = None,
    source: MassiveDataSource | None = None,
    candidate_tickers: list[str] | None = None,
    fundamental_metrics: dict[str, dict[str, float | str | None]] | None = None,
    historical_days: int = 30,
    metric_periods: dict[str, Any] | None = None,
    technical_specs: list[dict[str, Any]] | None = None,
    should_cancel=None,
) -> list[dict[str, Any]]:
    """Runs the custom scanner with frontend-provided filters."""
    if not custom_filters:
        logger.info("Custom scanner requested without filters; returning no results.")
        return []

    return _scan_with_filters(
        "custom",
        custom_filters,
        source=source,
        candidate_tickers=candidate_tickers,
        fundamental_metrics=fundamental_metrics,
        historical_days=historical_days,
        metric_periods=metric_periods,
        technical_specs=technical_specs,
        should_cancel=should_cancel,
    )


def run(historical_days: int = 30, should_cancel=None) -> list[dict[str, Any]]:
    """Runs the predefined scanner that matches the current market session."""
    source = _scanner_data_source()
    if source is None:
        return []

    scanner_name = current_predefined_scanner_name(source)
    if scanner_name == "premarket":
        logger.info("Running pre-market scanner.")
        return run_premarket_scanner(source=source, historical_days=historical_days, should_cancel=should_cancel)

    if scanner_name == "intraday":
        logger.info("Running intraday scanner.")
        return run_intraday_scanner(source=source, historical_days=historical_days, should_cancel=should_cancel)

    logger.info("Market is closed. Scanner will not run.")
    return []


def current_predefined_scanner_name(source: MassiveDataSource | None = None) -> str | None:
    """Returns the predefined scanner name that matches the current market session."""
    source = source or MassiveDataSource()
    exchange_date = source.exchange_date()
    if not is_trading_day(exchange_date):
        logger.info("%s is not a trading day. Scanner will not run.", exchange_date)
        return None

    now = datetime.now(tz=EXCHANGE_TIMEZONE).time()
    if PRE_MARKET_START_TIME <= now < REGULAR_MARKET_START_TIME:
        return "premarket"

    if REGULAR_MARKET_START_TIME <= now < REGULAR_MARKET_END_TIME:
        return "intraday"

    return None


if __name__ == "__main__":
    configure_file_logging("core/scanner/scanner.log")
    candidates = run()
    logger.info("Total candidates found: %d", len(candidates))
