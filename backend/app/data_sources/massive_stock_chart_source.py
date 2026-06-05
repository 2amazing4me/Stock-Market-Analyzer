import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import pandas as pd

from backend.app.utils.stock_chart_common import aggregate_candle_frame, filter_regular_market_hours

MASSIVE_REST_BASE_URL = "https://api.massive.com"
MASSIVE_STOCKS_WEBSOCKET_URL = "wss://socket.massive.com/stocks"
MASSIVE_WEBSOCKET_TIMEOUT_SECONDS = 4

logger = logging.getLogger(__name__)


def _get_massive_api_key() -> str | None:
    return os.getenv("MASSIVE_KEY")


def _timeframe_to_massive_range(timeframe: str) -> tuple[int, str]:
    normalized = timeframe.strip().lower()
    if normalized.endswith("s") and normalized[:-1].isdigit():
        return int(normalized[:-1]), "second"
    if normalized.endswith("m") and normalized[:-1].isdigit():
        return int(normalized[:-1]), "minute"
    if normalized.endswith("h") and normalized[:-1].isdigit():
        return int(normalized[:-1]), "hour"
    if normalized.endswith("mo") and normalized[:-2].isdigit():
        return int(normalized[:-2]), "month"
    if normalized.endswith("w") and normalized[:-1].isdigit():
        return int(normalized[:-1]), "week"
    if normalized.endswith("d") and normalized[:-1].isdigit():
        return int(normalized[:-1]), "day"
    raise ValueError(f"Unsupported timeframe for Massive aggregates: {timeframe}")


def _seconds_per_timeframe(timeframe: str) -> int:
    multiplier, timespan = _timeframe_to_massive_range(timeframe)
    seconds_by_timespan = {
        "second": 1,
        "minute": 60,
        "hour": 60 * 60,
        "day": 24 * 60 * 60,
        "week": 7 * 24 * 60 * 60,
        "month": 31 * 24 * 60 * 60,
    }
    return multiplier * seconds_by_timespan[timespan]


def _massive_rest_base_range(timeframe: str) -> tuple[int, str, str | None, int]:
    multiplier, timespan = _timeframe_to_massive_range(timeframe)
    if timespan == "minute" and multiplier > 1:
        return 1, "minute", f"{multiplier}min", multiplier
    if timespan == "second" and multiplier > 1:
        return 1, "second", f"{multiplier}s", multiplier
    return multiplier, timespan, None, 1


def _resolve_massive_window(limit: int, timeframe: str, before: int | None, after: int | None) -> tuple[int, int]:
    now = int(datetime.now(tz=timezone.utc).timestamp())
    _, timespan = _timeframe_to_massive_range(timeframe)
    interval_seconds = _seconds_per_timeframe(timeframe)
    requested_limit = max(limit, 1)
    minimum_lookback_seconds = {
        "second": 60 * 60,
        "minute": 24 * 60 * 60,
    }.get(timespan, 7 * 24 * 60 * 60)
    lookback_seconds = max(interval_seconds * requested_limit * 3, minimum_lookback_seconds)

    if after is not None:
        window_start = after + 1
        window_end = max(now, window_start + lookback_seconds)
    else:
        window_end = before - 1 if before is not None else now
        window_start = max(0, window_end - lookback_seconds)

    return window_start, window_end


def _format_massive_boundary(unix_seconds: int) -> str:
    return str(int(unix_seconds) * 1000)


def _massive_query_order(before: int | None, after: int | None) -> str:
    if after is not None and before is None:
        return "asc"
    return "desc"


def _massive_query_limit(limit: int) -> int:
    requested_limit = max(int(limit), 1)
    return min(50000, max(requested_limit * 6, requested_limit, 1000))


def _valid_price_frame(frame: pd.DataFrame) -> pd.DataFrame:
    price_columns = ["open", "high", "low", "close"]
    for column in price_columns + ["volume"]:
        frame[column] = pd.to_numeric(frame[column], errors="coerce")

    return frame[
        frame[price_columns].notna().all(axis=1)
        & (frame[price_columns] > 0).all(axis=1)
        & (frame["high"] >= frame["low"])
        & (frame["high"] >= frame[["open", "close"]].max(axis=1))
        & (frame["low"] <= frame[["open", "close"]].min(axis=1))
    ].copy()


def check_massive_rest_health() -> dict:
    api_key = _get_massive_api_key()
    if not api_key:
        return {
            "api_available": False,
            "provider": "Massive/Polygon.io",
            "reason": "MASSIVE_KEY is not configured",
            "delayed": True,
            "delay_minutes": 15,
        }

    now = int(datetime.now(tz=timezone.utc).timestamp())
    window_start = max(0, now - 10 * 24 * 60 * 60)
    path = (
        "/v2/aggs/ticker/AAPL/range/1/day/"
        f"{_format_massive_boundary(window_start)}/{_format_massive_boundary(now)}"
    )
    query = urlencode({"adjusted": "true", "sort": "desc", "limit": 1, "apiKey": api_key})
    request = Request(f"{MASSIVE_REST_BASE_URL}{path}?{query}", headers={"Accept": "application/json"})

    try:
        with urlopen(request, timeout=5) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        logger.warning("Massive REST health check failed with HTTP %s: %s", exc.code, detail)
        return {
            "api_available": False,
            "provider": "Massive/Polygon.io",
            "reason": f"HTTP {exc.code}",
            "delayed": True,
            "delay_minutes": 15,
        }
    except (URLError, TimeoutError, json.JSONDecodeError) as exc:
        logger.warning("Massive REST health check failed: %s", exc)
        return {
            "api_available": False,
            "provider": "Massive/Polygon.io",
            "reason": str(exc),
            "delayed": True,
            "delay_minutes": 15,
        }

    return {
        "api_available": bool(payload.get("results")),
        "provider": "Massive/Polygon.io",
        "reason": "" if payload.get("results") else "No sample candle returned",
        "delayed": True,
        "delay_minutes": 15,
    }


def _massive_websocket_status_text(message: object) -> str:
    events = message if isinstance(message, list) else [message]
    parts: list[str] = []
    for event in events:
        if isinstance(event, dict):
            parts.extend(str(event.get(key, "")) for key in ("ev", "status", "message") if event.get(key))
        else:
            parts.append(str(event))
    return " ".join(parts).lower()


def _massive_websocket_live_frame(message: object, ticker: str) -> pd.DataFrame | None:
    events = message if isinstance(message, list) else [message]
    rows: list[dict] = []
    normalized_ticker = ticker.upper()

    for event in events:
        if not isinstance(event, dict):
            continue
        if event.get("ev") not in {"AM", "A"} or str(event.get("sym", "")).upper() != normalized_ticker:
            continue

        start_ms = event.get("s")
        if start_ms is None:
            continue

        rows.append(
            {
                "datetime": pd.to_datetime(int(start_ms), unit="ms", utc=True),
                "open": float(event["o"]),
                "high": float(event["h"]),
                "low": float(event["l"]),
                "close": float(event["c"]),
                "volume": int(float(event.get("v", 0))),
                "instrument_id": 0,
                "unix_time": int(start_ms) // 1000,
            }
        )

    if not rows:
        return None

    return pd.DataFrame(rows)


def _merge_candle_frames(
    primary: pd.DataFrame,
    live: pd.DataFrame | None,
    limit: int,
    before: int | None = None,
    after: int | None = None,
) -> pd.DataFrame:
    if live is None or live.empty:
        return primary

    if before is not None:
        live = live[live["unix_time"] < before]

    if after is not None:
        live = live[live["unix_time"] > after]

    if live.empty:
        return primary

    df = pd.concat([primary, live], ignore_index=True)
    df = df.sort_values("datetime", ascending=True).drop_duplicates(subset=["datetime"], keep="last")
    if limit > 0:
        df = df.tail(limit)
    return df


async def _load_massive_websocket_candle_frame_async(
    ticker: str,
    limit: int,
    timeframe: str,
    before: int | None = None,
    after: int | None = None,
    include_extended_hours: bool = True,
    adjusted: bool = True,
) -> pd.DataFrame:
    api_key = _get_massive_api_key()
    if not api_key:
        raise RuntimeError("MASSIVE_KEY is not configured")

    try:
        import websockets
    except ImportError as exc:
        raise RuntimeError("websockets package is unavailable") from exc

    async with websockets.connect(MASSIVE_STOCKS_WEBSOCKET_URL, open_timeout=MASSIVE_WEBSOCKET_TIMEOUT_SECONDS) as websocket:
        await asyncio.wait_for(websocket.recv(), timeout=MASSIVE_WEBSOCKET_TIMEOUT_SECONDS)
        await websocket.send(json.dumps({"action": "auth", "params": api_key}))
        auth_message = json.loads(await asyncio.wait_for(websocket.recv(), timeout=MASSIVE_WEBSOCKET_TIMEOUT_SECONDS))
        auth_text = _massive_websocket_status_text(auth_message)
        if "auth_success" not in auth_text and "authenticated" not in auth_text and "success" not in auth_text:
            raise RuntimeError(f"Massive WebSocket authentication failed: {auth_text or auth_message}")

        await websocket.send(json.dumps({"action": "subscribe", "params": f"AM.{ticker.upper()}"}))
        subscribe_message = json.loads(await asyncio.wait_for(websocket.recv(), timeout=MASSIVE_WEBSOCKET_TIMEOUT_SECONDS))
        subscribe_text = _massive_websocket_status_text(subscribe_message)
        if any(word in subscribe_text for word in ("not authorized", "not entitled", "permission", "upgrade", "denied")):
            raise RuntimeError(f"Massive WebSocket plan does not allow live stock aggregates: {subscribe_text}")

        logger.info(
            "Massive WebSocket live stream succeeded for %s; using it for live candles with REST history backfill.",
            ticker.upper(),
        )
        history = load_massive_rest_candle_frame(
            ticker=ticker,
            timeframe=timeframe,
            limit=limit,
            before=before,
            after=after,
            include_extended_hours=include_extended_hours,
            adjusted=adjusted,
        )

        live_frame = None
        if timeframe == "1m":
            try:
                live_message = json.loads(await asyncio.wait_for(websocket.recv(), timeout=1))
                live_frame = _massive_websocket_live_frame(live_message, ticker)
                if live_frame is not None:
                    logger.info("Massive WebSocket live candle received for %s.", ticker.upper())
            except asyncio.TimeoutError:
                logger.info(
                    "Massive WebSocket stream is connected for %s, but no live candle arrived before returning history.",
                    ticker.upper(),
                )
        else:
            logger.info(
                "Massive WebSocket stream is connected for %s; timeframe %s uses REST history backfill without a one-minute live overlay.",
                ticker.upper(),
                timeframe,
            )

        live_frame = filter_regular_market_hours(live_frame, timeframe, include_extended_hours)
        return _merge_candle_frames(history, live_frame, limit, before=before, after=after)


def load_massive_websocket_candle_frame(
    ticker: str,
    limit: int,
    timeframe: str,
    before: int | None = None,
    after: int | None = None,
    include_extended_hours: bool = True,
    adjusted: bool = True,
) -> pd.DataFrame:
    return asyncio.run(
        asyncio.wait_for(
            _load_massive_websocket_candle_frame_async(
                ticker=ticker,
                timeframe=timeframe,
                limit=limit,
                before=before,
                after=after,
                include_extended_hours=include_extended_hours,
                adjusted=adjusted,
            ),
            timeout=MASSIVE_WEBSOCKET_TIMEOUT_SECONDS + 15,
        )
    )


def load_massive_rest_candle_frame(
    ticker: str,
    limit: int,
    timeframe: str,
    before: int | None = None,
    after: int | None = None,
    include_extended_hours: bool = True,
    adjusted: bool = True,
) -> pd.DataFrame:
    api_key = _get_massive_api_key()
    if not api_key:
        raise RuntimeError("MASSIVE_KEY is not configured")

    multiplier, timespan, aggregation_rule, base_multiplier = _massive_rest_base_range(timeframe)
    window_start, window_end = _resolve_massive_window(limit, timeframe, before, after)
    path = (
        f"/v2/aggs/ticker/{ticker.upper()}/range/{multiplier}/{timespan}/"
        f"{_format_massive_boundary(window_start)}/{_format_massive_boundary(window_end)}"
    )
    query_order = _massive_query_order(before=before, after=after)
    query_limit = _massive_query_limit(limit * base_multiplier)
    query = urlencode(
        {
            "adjusted": str(adjusted).lower(),
            "sort": query_order,
            "limit": query_limit,
            "apiKey": api_key,
        }
    )
    request = Request(f"{MASSIVE_REST_BASE_URL}{path}?{query}", headers={"Accept": "application/json"})
    logger.info(
        "Massive REST candles request for %s %s: window=%s..%s range=%d/%s aggregate_rule=%s sort=%s api_limit=%d requested_limit=%d.",
        ticker.upper(),
        timeframe,
        datetime.fromtimestamp(window_start, tz=timezone.utc).isoformat(),
        datetime.fromtimestamp(window_end, tz=timezone.utc).isoformat(),
        multiplier,
        timespan,
        aggregation_rule or "native",
        query_order,
        query_limit,
        limit,
    )

    try:
        with urlopen(request, timeout=12) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Massive REST request failed with HTTP {exc.code}: {detail}") from exc
    except (URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Massive REST request failed: {exc}") from exc

    results = payload.get("results") or []
    if not results:
        raise LookupError(f"Massive REST returned no candle data for ticker: {ticker}")

    frame = pd.DataFrame(results)
    frame = frame.rename(columns={"o": "open", "h": "high", "l": "low", "c": "close", "v": "volume", "t": "time_ms"})
    required_columns = ["open", "high", "low", "close", "volume", "time_ms"]
    missing_columns = [column for column in required_columns if column not in frame.columns]
    if missing_columns:
        raise RuntimeError(f"Massive REST response missing columns: {', '.join(missing_columns)}")

    frame["datetime"] = pd.to_datetime(frame["time_ms"], unit="ms", utc=True)
    frame["unix_time"] = (frame["time_ms"] // 1000).astype(int)
    frame["instrument_id"] = 0

    if before is not None:
        frame = frame[frame["unix_time"] < before]

    if after is not None:
        frame = frame[frame["unix_time"] > after]

    frame = _valid_price_frame(frame)
    if frame.empty:
        raise LookupError(f"Massive REST returned no valid candle data for ticker: {ticker}")

    if aggregation_rule is not None:
        frame = aggregate_candle_frame(frame, aggregation_rule)
        frame = _valid_price_frame(frame)

    frame = filter_regular_market_hours(frame, timeframe, include_extended_hours)
    frame = frame.sort_values("datetime", ascending=True).drop_duplicates(subset=["datetime"], keep="last")
    if limit > 0:
        if after is not None and before is None:
            frame = frame.head(limit)
        else:
            frame = frame.tail(limit)

    if frame.empty:
        raise LookupError(f"Massive REST returned no candle data for ticker: {ticker}")

    logger.info(
        "Massive REST candles returned %d rows for %s %s from %s to %s.",
        len(frame),
        ticker.upper(),
        timeframe,
        frame["datetime"].iloc[0],
        frame["datetime"].iloc[-1],
    )

    return frame[["datetime", "open", "high", "low", "close", "volume", "instrument_id", "unix_time"]]
