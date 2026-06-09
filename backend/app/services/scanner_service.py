import math
from datetime import datetime, timezone
from typing import Any

from backend.app.schemas.scanner import (
    ScannerColumnMetricsRequest,
    ScannerColumnMetricsResponse,
    ScannerFilterRequest,
    ScannerMetadataResponse,
    ScannerRequest,
    ScannerResponse,
    ScannerResult,
)
from backend.app.services.logo_service import local_logo_url
from core.strategy.scanner.data.massive import MassiveDataSource
from core.strategy.scanner.filters.base import Filter, SetMembershipFilter
from core.strategy.scanner.filters.factory import build_filter
from core.strategy.scanner.preprocessing.constants import INDICATOR_WARMUP_BARS
from core.strategy.scanner.scanner import current_predefined_scanner_name, run, run_custom_scanner

FUNDAMENTAL_PREFILTER_FIELDS = {"industry"}
CATEGORICAL_FILTER_FIELDS = {"industry"}
PERIOD_OPTIONS = {
    "avg_volume": [10, 30, 60, 90],
    "avg_dollar_volume": [10, 30, 60, 90],
    "relative_volume": ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w", "1mo"],
    "beta": ["1y", "3y", "5y"],
}
TA_TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w", "1mo"]
TA_RANGES = [7, 14, 21, 30]
TA_FILTER_FIELDS = {"rsi", "atr", "atr_pct"}
TIMEFRAME_FILTER_FIELDS = {"vwap"}
DEFAULT_PERIODS = {
    "avg_volume": 30,
    "avg_dollar_volume": 30,
    "relative_volume": "1d",
    "vwap": "1d",
    "rsi": {"timeframe": "1d", "range": 14},
    "atr": {"timeframe": "1d", "range": 14},
    "atr_pct": {"timeframe": "1d", "range": 14},
    "beta": "5y",
}
BETA_TRADING_DAYS = {"1y": 252, "3y": 756, "5y": 1260}
RELATIVE_VOLUME_HISTORY_DAYS = {
    "1m": 30,
    "5m": 30,
    "15m": 30,
    "30m": 30,
    "1h": 30,
    "2h": 30,
    "4h": 30,
    "1d": 1,
    "1w": 5,
    "1mo": 30,
}
FILTER_METRICS = {
    "price": "price",
    "market_cap": "market_cap",
    "beta": "beta",
    "change": "price_change",
    "change_pct": "price_change_pct",
    "volume": "volume",
    "dollar_volume": "dollar_volume",
    "vwap": "vwap",
    "relative_volume": "relative_volume",
    "avg_volume": "avg_volume",
    "avg_dollar_volume": "avg_dollar_volume",
    "rsi": "rsi",
    "atr": "atr",
    "atr_pct": "atr_pct",
    "industry": "industry",
}
FILTER_LIMITS = {
    "price": (0, 1_000_000),
    "market_cap": (0, 100_000_000_000_000),
    "beta": (-20, 20),
    "change": (-10_000, 10_000),
    "change_pct": (-1_000, 1_000),
    "volume": (0, 10_000_000_000),
    "dollar_volume": (0, 100_000_000_000_000),
    "vwap": (0, 1_000_000),
    "relative_volume": (0, 1_000),
    "avg_volume": (0, 10_000_000_000),
    "avg_dollar_volume": (0, 100_000_000_000_000),
    "rsi": (0, 100),
    "atr": (0, 10_000),
    "atr_pct": (0, 1_000),
}
COLUMN_METRIC_FIELDS = set(FILTER_METRICS) - CATEGORICAL_FILTER_FIELDS
PREDEFINED_CALCULATED_METRICS = {
    "premarket": ["avg_volume", "atr"],
    "intraday": ["avg_volume", "relative_volume", "atr"],
}
PREDEFINED_HISTORY_DAYS = INDICATOR_WARMUP_BARS + 30


def _expected_value_count(operator: str) -> int:
    """Returns how many numeric values an operator needs."""
    return 2 if operator in {"between", "outside"} else 1


def _normalized_period(request_filter: ScannerFilterRequest) -> int | str | None:
    """Returns a period value using the configured option type."""
    if request_filter.field not in PERIOD_OPTIONS:
        return None

    default_period = DEFAULT_PERIODS[request_filter.field]
    period = request_filter.period or default_period
    if isinstance(default_period, int):
        return int(period)
    return str(period)


def _normalized_ta_period(request_filter: ScannerFilterRequest) -> dict[str, int | str]:
    """Returns the selected TA timeframe and range."""
    default = DEFAULT_PERIODS[request_filter.field]
    timeframe = request_filter.timeframe or default["timeframe"]
    period_range = request_filter.range or default["range"]
    return {"timeframe": str(timeframe), "range": int(period_range)}


def _normalized_timeframe(request_filter: ScannerFilterRequest) -> str:
    """Returns the selected timeframe for timeframe-only filters."""
    return str(request_filter.timeframe or DEFAULT_PERIODS[request_filter.field])


def _validate_filter(request_filter: ScannerFilterRequest) -> None:
    """Validates one frontend scanner filter before core conversion."""
    if request_filter.field not in FILTER_METRICS:
        raise ValueError(f"Unsupported scanner filter: {request_filter.field}")

    if request_filter.field in CATEGORICAL_FILTER_FIELDS:
        if not request_filter.selected_values:
            raise ValueError(f"{request_filter.field} requires at least one selected value")
        return

    expected_count = _expected_value_count(request_filter.operator)
    if len(request_filter.values) != expected_count:
        raise ValueError(f"{request_filter.operator} requires {expected_count} value(s)")

    min_value, max_value = FILTER_LIMITS[request_filter.field]
    for value in request_filter.values:
        if value < min_value or value > max_value:
            raise ValueError(f"{request_filter.field} must be between {min_value:g} and {max_value:g}")

    if request_filter.field in TA_FILTER_FIELDS:
        ta_period = _normalized_ta_period(request_filter)
        if ta_period["timeframe"] not in TA_TIMEFRAMES:
            raise ValueError(f"{request_filter.field} timeframe must be one of: {', '.join(TA_TIMEFRAMES)}")
        if ta_period["range"] not in TA_RANGES:
            raise ValueError(f"{request_filter.field} range must be one of: {', '.join(str(option) for option in TA_RANGES)}")
    elif request_filter.field in TIMEFRAME_FILTER_FIELDS:
        timeframe = _normalized_timeframe(request_filter)
        if timeframe not in TA_TIMEFRAMES:
            raise ValueError(f"{request_filter.field} timeframe must be one of: {', '.join(TA_TIMEFRAMES)}")
    elif request_filter.field in PERIOD_OPTIONS:
        period = _normalized_period(request_filter)
        if period not in PERIOD_OPTIONS[request_filter.field]:
            options = ", ".join(str(option) for option in PERIOD_OPTIONS[request_filter.field])
            raise ValueError(f"{request_filter.field} period must be one of: {options}")


def _metric_name(request_filter: ScannerFilterRequest) -> str:
    """Returns the context metric name for a request filter."""
    metric = FILTER_METRICS[request_filter.field]
    if request_filter.field in TA_FILTER_FIELDS:
        ta_period = _normalized_ta_period(request_filter)
        return f"{metric}_{ta_period['timeframe']}_{ta_period['range']}"
    if request_filter.field in TIMEFRAME_FILTER_FIELDS:
        timeframe = _normalized_timeframe(request_filter)
        return metric if timeframe == "1d" else f"{metric}_{timeframe}"
    if request_filter.field not in PERIOD_OPTIONS:
        return metric
    if request_filter.field == "beta":
        period = str(_normalized_period(request_filter))
        return f"{metric}_{BETA_TRADING_DAYS[period]}"
    return f"{metric}_{_normalized_period(request_filter)}"


def _core_filter(request_filter: ScannerFilterRequest) -> Filter:
    """Converts one validated request filter to a core scanner filter."""
    _validate_filter(request_filter)
    if request_filter.field == "industry":
        return SetMembershipFilter("industry", request_filter.selected_values)

    return build_filter(
        _metric_name(request_filter),
        request_filter.operator,
        request_filter.values,
    )


def _metric_periods(request_filters: list[ScannerFilterRequest]) -> dict[str, Any]:
    """Builds the period selections used by scanner result metrics."""
    periods: dict[str, Any] = {
        "price": None,
        "market_cap": None,
        "change": None,
        "change_pct": None,
        "volume": None,
        "dollar_volume": None,
        **DEFAULT_PERIODS,
    }
    for request_filter in request_filters:
        if request_filter.field in TA_FILTER_FIELDS:
            periods[request_filter.field] = _normalized_ta_period(request_filter)
        elif request_filter.field in TIMEFRAME_FILTER_FIELDS:
            periods[request_filter.field] = _normalized_timeframe(request_filter)
        elif request_filter.field in PERIOD_OPTIONS:
            periods[request_filter.field] = _normalized_period(request_filter)
    return periods


def _required_history_days(request_filters: list[ScannerFilterRequest]) -> int:
    """Returns the historical lookback needed for period-based scanner metrics."""
    periods: list[int] = []
    for request_filter in request_filters:
        if request_filter.field in CATEGORICAL_FILTER_FIELDS:
            continue
        if request_filter.field in {"avg_volume", "avg_dollar_volume"}:
            periods.append(int(_normalized_period(request_filter)))
        elif request_filter.field in TA_FILTER_FIELDS:
            periods.append(int(_normalized_ta_period(request_filter)["range"]) + INDICATOR_WARMUP_BARS)
        elif request_filter.field in TIMEFRAME_FILTER_FIELDS and _normalized_timeframe(request_filter) != "1d":
            periods.append(1)
        elif request_filter.field == "relative_volume":
            periods.append(RELATIVE_VOLUME_HISTORY_DAYS[str(_normalized_period(request_filter))])
        elif request_filter.field == "beta":
            periods.append(BETA_TRADING_DAYS[str(_normalized_period(request_filter))] + 1)
    return max(periods or [0])


def _technical_specs(request_filters: list[ScannerFilterRequest]) -> list[dict[str, Any]]:
    """Builds selected technical analysis metric requests for the core scanner."""
    specs: list[dict[str, Any]] = []
    seen: set[tuple[str, str, int]] = set()
    for request_filter in request_filters:
        if request_filter.field not in TA_FILTER_FIELDS | TIMEFRAME_FILTER_FIELDS:
            continue
        if request_filter.field in TIMEFRAME_FILTER_FIELDS and _normalized_timeframe(request_filter) == "1d":
            continue
        if request_filter.field in TIMEFRAME_FILTER_FIELDS:
            timeframe = _normalized_timeframe(request_filter)
            spec_key = (request_filter.field, timeframe, 0)
            if spec_key in seen:
                continue
            seen.add(spec_key)
            specs.append({"metric": request_filter.field, "timeframe": timeframe})
            continue
        ta_period = _normalized_ta_period(request_filter)
        metric = "atr" if request_filter.field == "atr_pct" else request_filter.field
        spec_key = (metric, str(ta_period["timeframe"]), int(ta_period["range"]))
        if spec_key in seen:
            continue
        seen.add(spec_key)
        specs.append({"metric": metric, **ta_period})
    return specs


def _calculated_metrics(request_filters: list[ScannerFilterRequest]) -> list[str]:
    """Returns result columns that should be shown because they were calculated."""
    calculated = []
    for request_filter in request_filters:
        if request_filter.field in {"avg_volume", "avg_dollar_volume", "relative_volume", "beta", "rsi", "atr", "atr_pct"}:
            calculated.append(request_filter.field)
    return sorted(set(calculated))


def _column_metric_filter(metric: str, metric_periods: dict[str, Any]) -> ScannerFilterRequest:
    """Builds a pseudo filter carrying period settings for one result column."""
    period = metric_periods.get(metric)
    if metric in TA_FILTER_FIELDS:
        period = period if isinstance(period, dict) else DEFAULT_PERIODS[metric]
        return ScannerFilterRequest(
            field=metric,
            operator="above",
            values=[0],
            timeframe=str(period["timeframe"]),
            range=int(period["range"]),
        )
    if metric in TIMEFRAME_FILTER_FIELDS:
        return ScannerFilterRequest(field=metric, operator="above", values=[0], timeframe=str(period or DEFAULT_PERIODS[metric]))
    if metric in PERIOD_OPTIONS:
        return ScannerFilterRequest(field=metric, operator="above", values=[0], period=period or DEFAULT_PERIODS[metric])
    return ScannerFilterRequest(field=metric, operator="above", values=[0])


def _historical_column_metrics(request_filters: list[ScannerFilterRequest]) -> list[ScannerFilterRequest]:
    """Returns pseudo filters that require historical enrichment."""
    historical_filters: list[ScannerFilterRequest] = []
    for request_filter in request_filters:
        if request_filter.field in {"avg_volume", "relative_volume", "beta", "rsi", "atr", "atr_pct"}:
            historical_filters.append(request_filter)
        elif request_filter.field == "avg_dollar_volume":
            historical_filters.append(request_filter)
        elif request_filter.field == "vwap" and _normalized_timeframe(request_filter) != "1d":
            historical_filters.append(request_filter)
    return historical_filters


def _custom_metadata_prefilter(
    source: MassiveDataSource,
    request_filters: list[ScannerFilterRequest],
) -> tuple[list[str] | None, dict[str, dict[str, float | str | None]] | None]:
    """Uses Massive ratio metrics to reduce custom scanner candidates early."""
    metadata_filters = [
        request_filter
        for request_filter in request_filters
        if request_filter.field in FUNDAMENTAL_PREFILTER_FIELDS
    ]
    if not metadata_filters:
        return None, None

    tickers = source.load_ticker_universe()
    fundamental_metrics = source.get_fundamental_metrics(tickers)
    core_filters = [_core_filter(request_filter) for request_filter in metadata_filters]
    candidates = [
        ticker
        for ticker, context in fundamental_metrics.items()
        if all(scanner_filter.apply(ticker, context) for scanner_filter in core_filters)
    ]
    return candidates, fundamental_metrics


def _json_float(value: Any, default: float | None = None) -> float | None:
    """Returns a JSON-safe finite float or a fallback value."""
    if value is None:
        return default
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _result_from_context(context: dict, include_logo: bool) -> ScannerResult:
    """Maps one core scanner context to the API response row."""
    change = context.get("price_change")
    if change is None:
        change = context.get("premarket_price_change")

    change_pct = context.get("price_change_pct")
    if change_pct is None:
        change_pct = context.get("premarket_price_change_pct")

    volume = context.get("volume")
    if volume is None:
        volume = context.get("premarket_volume")

    return ScannerResult(
        symbol=context["symbol"],
        name=context.get("name"),
        logo_url=local_logo_url(context["symbol"]) if include_logo else "",
        industry=context.get("industry"),
        price=_json_float(context.get("price"), 0.0) or 0.0,
        market_cap=_json_float(context.get("market_cap")),
        beta=_json_float(context.get("beta")),
        change=_json_float(change),
        change_pct=_json_float(change_pct),
        volume=_json_float(volume),
        dollar_volume=_json_float(context.get("dollar_volume")),
        vwap=_json_float(context.get("vwap")),
        relative_volume=_json_float(context.get("relative_volume")),
        avg_volume=_json_float(context.get("avg_volume")),
        avg_dollar_volume=_json_float(context.get("avg_dollar_volume")),
        rsi=_json_float(context.get("rsi")),
        atr=_json_float(context.get("atr")),
        atr_pct=_json_float(context.get("atr_pct")),
    )


def get_scanner_metadata() -> ScannerMetadataResponse:
    """Returns static option metadata used by scanner controls."""
    return ScannerMetadataResponse(industries=MassiveDataSource().local_industries())


def get_scanner_results(request: ScannerRequest, should_cancel=None) -> ScannerResponse:
    """Runs the requested scanner mode and returns normalized candidates."""
    metric_periods = _metric_periods(request.filters)
    historical_days = _required_history_days(request.filters)
    include_logo = True
    if request.mode == "predefined":
        scanner_name = current_predefined_scanner_name()
        contexts = run(historical_days=PREDEFINED_HISTORY_DAYS, should_cancel=should_cancel)
        calculated_metrics = PREDEFINED_CALCULATED_METRICS.get(str(scanner_name), ["avg_volume", "atr"])
    else:
        source = MassiveDataSource()
        filters = [_core_filter(request_filter) for request_filter in request.filters]
        candidate_tickers, fundamental_metrics = _custom_metadata_prefilter(source, request.filters)
        technical_specs = _technical_specs(request.filters)
        contexts = run_custom_scanner(
            filters,
            source=source,
            candidate_tickers=candidate_tickers,
            fundamental_metrics=fundamental_metrics,
            historical_days=historical_days,
            metric_periods=metric_periods,
            technical_specs=technical_specs,
            should_cancel=should_cancel,
        )
        scanner_name = "custom"
        calculated_metrics = _calculated_metrics(request.filters)

    return ScannerResponse(
        as_of=datetime.now(timezone.utc),
        mode=request.mode,
        scanner_name=scanner_name,
        total_count=len(contexts),
        historical_metrics_enabled=bool(calculated_metrics),
        metric_periods=metric_periods,
        calculated_metrics=calculated_metrics,
        results=[_result_from_context(context, include_logo) for context in contexts],
    )


def get_scanner_column_metrics(request: ScannerColumnMetricsRequest, should_cancel=None) -> ScannerColumnMetricsResponse:
    """Calculates extra result columns for existing scanner result symbols."""
    symbols = sorted({symbol.strip().upper() for symbol in request.symbols if symbol.strip()})
    requested_metrics = sorted({metric for metric in request.metrics if metric in COLUMN_METRIC_FIELDS})
    if not symbols or not requested_metrics:
        return ScannerColumnMetricsResponse(metric_periods=request.metric_periods, calculated_metrics=[], results=[])

    source = MassiveDataSource()
    metric_periods = {**DEFAULT_PERIODS, **request.metric_periods}
    request_filters = [_column_metric_filter(metric, metric_periods) for metric in requested_metrics]
    for request_filter in request_filters:
        _validate_filter(request_filter)
        if request_filter.field in TA_FILTER_FIELDS:
            metric_periods[request_filter.field] = _normalized_ta_period(request_filter)
        elif request_filter.field in TIMEFRAME_FILTER_FIELDS:
            metric_periods[request_filter.field] = _normalized_timeframe(request_filter)
        elif request_filter.field in PERIOD_OPTIONS:
            metric_periods[request_filter.field] = _normalized_period(request_filter)

    snapshots = source.get_full_market_snapshot()
    if should_cancel and should_cancel():
        return ScannerColumnMetricsResponse(metric_periods=metric_periods, calculated_metrics=[], results=[])

    fundamental_metrics = source.get_fundamental_metrics(symbols)
    if "market_cap" in requested_metrics:
        fundamental_metrics = source.fill_missing_overview_metrics(symbols, fundamental_metrics)
    if "avg_dollar_volume" in requested_metrics:
        fundamental_metrics = source.fill_missing_average_volume_metrics(symbols, fundamental_metrics)

    historical_filters = _historical_column_metrics(request_filters)
    historical_metrics = {}
    if historical_filters:
        historical_metrics = source.get_historical_metrics(
            symbols,
            trading_days=_required_history_days(historical_filters),
            technical_specs=_technical_specs(historical_filters),
            should_cancel=should_cancel,
        )

    contexts = [
        build_context
        for symbol in symbols
        if (snapshot := snapshots.get(symbol))
        if (build_context := _build_column_context(symbol, snapshot, historical_metrics, fundamental_metrics, metric_periods))
    ]
    return ScannerColumnMetricsResponse(
        metric_periods=metric_periods,
        calculated_metrics=sorted(set(requested_metrics)),
        results=[_result_from_context(context, include_logo=True) for context in contexts],
    )


def _build_column_context(
    symbol: str,
    snapshot: dict[str, Any],
    historical_metrics: dict[str, dict[str, float]],
    fundamental_metrics: dict[str, dict[str, float | str | None]],
    metric_periods: dict[str, Any],
) -> dict[str, Any] | None:
    """Builds one scanner context for column enrichment."""
    from core.strategy.scanner.utils.snapshot import build_candidate_context

    return build_candidate_context(symbol, snapshot, historical_metrics, "custom", fundamental_metrics, metric_periods)
