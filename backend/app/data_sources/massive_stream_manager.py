import asyncio
import json
import logging
import os
from collections import defaultdict
from contextlib import suppress
from typing import Any

DELAYED_STOCKS_WEBSOCKET_URL = "wss://delayed.polygon.io/stocks"
MASSIVE_WEBSOCKET_TIMEOUT_SECONDS = 6

logger = logging.getLogger(__name__)


def _get_massive_api_key() -> str | None:
    return os.getenv("MASSIVE_KEY")


def _status_text(message: object) -> str:
    events = message if isinstance(message, list) else [message]
    parts: list[str] = []
    for event in events:
        if isinstance(event, dict):
            parts.extend(str(event.get(key, "")) for key in ("ev", "status", "message") if event.get(key))
        else:
            parts.append(str(event))
    return " ".join(parts).lower()


def _normalise_stream_event(event: dict[str, Any]) -> dict[str, Any] | None:
    event_type = str(event.get("ev", ""))
    symbol = str(event.get("sym", "")).upper()
    if not symbol:
        return None

    if event_type == "T" and event.get("p") is not None:
        timestamp_ms = event.get("t")
        return {
            "type": "trade",
            "symbol": symbol,
            "time": int(timestamp_ms) // 1000 if timestamp_ms is not None else None,
            "event_interval_seconds": 0,
            "price": float(event["p"]),
            "volume": int(float(event.get("s") or 0)),
            "source_mode": "streaming",
            "source_provider": "Massive/Polygon.io",
            "delayed": True,
            "delay_minutes": 15,
        }

    if event_type in {"A", "AM"} and event.get("c") is not None:
        timestamp_ms = event.get("s") or event.get("e")
        return {
            "type": "aggregate",
            "symbol": symbol,
            "time": int(timestamp_ms) // 1000 if timestamp_ms is not None else None,
            "event_interval_seconds": 1 if event_type == "A" else 60,
            "open": float(event.get("o", event["c"])),
            "high": float(event.get("h", event["c"])),
            "low": float(event.get("l", event["c"])),
            "close": float(event["c"]),
            "volume": int(float(event.get("v") or 0)),
            "source_mode": "streaming",
            "source_provider": "Massive/Polygon.io",
            "delayed": True,
            "delay_minutes": 15,
        }

    return None


def _websocket_is_open(websocket: Any) -> bool:
    if websocket is None:
        return False
    if getattr(websocket, "closed", False):
        return False
    close_code = getattr(websocket, "close_code", None)
    return close_code is None


class MassiveStreamManager:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._websocket = None
        self._receiver_task: asyncio.Task | None = None
        self._subscribed_symbols: set[str] = set()
        self._clients: dict[str, set[asyncio.Queue]] = defaultdict(set)
        self._last_error: str | None = None

    @property
    def last_error(self) -> str | None:
        return self._last_error

    async def subscribe(self, ticker: str) -> asyncio.Queue:
        symbol = ticker.upper()
        queue: asyncio.Queue = asyncio.Queue(maxsize=200)
        async with self._lock:
            await self._ensure_connected()
            self._clients[symbol].add(queue)
            await self._subscribe_symbol(symbol)
            logger.info(
                "Chart client subscribed to delayed stream for %s; client_count=%d.",
                symbol,
                len(self._clients[symbol]),
            )
        return queue

    async def unsubscribe(self, ticker: str, queue: asyncio.Queue) -> None:
        symbol = ticker.upper()
        async with self._lock:
            self._clients[symbol].discard(queue)
            if not self._clients[symbol]:
                self._clients.pop(symbol, None)
                logger.info("Last chart client unsubscribed from delayed stream for %s.", symbol)
            else:
                logger.info(
                    "Chart client unsubscribed from delayed stream for %s; client_count=%d.",
                    symbol,
                    len(self._clients[symbol]),
                )

    async def _ensure_connected(self) -> None:
        if _websocket_is_open(self._websocket):
            return

        api_key = _get_massive_api_key()
        if not api_key:
            raise RuntimeError("MASSIVE_KEY is not configured")

        try:
            import websockets
        except ImportError as exc:
            raise RuntimeError("websockets package is unavailable") from exc

        websocket = await websockets.connect(
            DELAYED_STOCKS_WEBSOCKET_URL,
            open_timeout=MASSIVE_WEBSOCKET_TIMEOUT_SECONDS,
        )
        await asyncio.wait_for(websocket.recv(), timeout=MASSIVE_WEBSOCKET_TIMEOUT_SECONDS)
        await websocket.send(json.dumps({"action": "auth", "params": api_key}))
        auth_message = json.loads(await asyncio.wait_for(websocket.recv(), timeout=MASSIVE_WEBSOCKET_TIMEOUT_SECONDS))
        auth_text = _status_text(auth_message)
        if "auth_success" not in auth_text and "authenticated" not in auth_text and "success" not in auth_text:
            await websocket.close()
            raise RuntimeError(f"Massive WebSocket authentication failed: {auth_text or auth_message}")

        self._websocket = websocket
        self._subscribed_symbols.clear()
        self._last_error = None
        self._receiver_task = asyncio.create_task(self._receive_loop())
        logger.info("Delayed Polygon/Massive WebSocket upstream connected and authenticated.")

    async def _subscribe_symbol(self, symbol: str) -> None:
        if symbol in self._subscribed_symbols:
            return
        if not self._websocket:
            raise RuntimeError("Massive WebSocket is not connected")

        params = f"A.{symbol}"
        await self._websocket.send(json.dumps({"action": "subscribe", "params": params}))
        self._subscribed_symbols.add(symbol)
        logger.info("Delayed Polygon/Massive WebSocket subscribed to %s once for all chart clients.", symbol)

    async def _receive_loop(self) -> None:
        try:
            while self._websocket:
                raw_message = await self._websocket.recv()
                message = json.loads(raw_message)
                status_text = _status_text(message)
                if any(word in status_text for word in ("not authorized", "not entitled", "permission", "upgrade", "denied")):
                    raise RuntimeError(f"Massive WebSocket plan does not allow requested live stream: {status_text}")

                events = message if isinstance(message, list) else [message]
                for event in events:
                    if not isinstance(event, dict):
                        continue
                    normalized = _normalise_stream_event(event)
                    if normalized is None or normalized.get("time") is None:
                        continue
                    logger.debug(
                        "Delayed stream event for %s at %s close=%s.",
                        normalized["symbol"],
                        normalized.get("time"),
                        normalized.get("close") or normalized.get("price"),
                    )
                    await self._broadcast(normalized["symbol"], normalized)
        except Exception as exc:
            self._last_error = str(exc)
            logger.warning("Massive WebSocket upstream failed: %s", exc)
            await self._broadcast_status(
                {
                    "type": "status",
                    "source_mode": "api_snapshot",
                    "source_provider": "Massive/Polygon.io",
                    "delayed": True,
                    "delay_minutes": 15,
                    "stream_error": str(exc),
                }
            )
        finally:
            if self._websocket:
                with suppress(Exception):
                    await self._websocket.close()
            self._websocket = None
            self._subscribed_symbols.clear()
            current_task = asyncio.current_task()
            if self._receiver_task is current_task:
                self._receiver_task = None
            if self._clients:
                asyncio.create_task(self._reconnect_if_needed())

    async def _reconnect_if_needed(self) -> None:
        await asyncio.sleep(3)
        async with self._lock:
            if not self._clients or self._websocket:
                return
            symbols = list(self._clients.keys())
            try:
                await self._ensure_connected()
                for symbol in symbols:
                    await self._subscribe_symbol(symbol)
                await self._broadcast_status(
                    {
                        "type": "status",
                        "source_mode": "streaming",
                        "source_provider": "Massive/Polygon.io",
                        "delayed": True,
                        "delay_minutes": 15,
                    }
                )
            except Exception as exc:
                self._last_error = str(exc)
                logger.warning("Massive WebSocket reconnect failed: %s", exc)
                await self._broadcast_status(
                    {
                        "type": "status",
                        "source_mode": "api_snapshot",
                        "source_provider": "Massive/Polygon.io",
                        "delayed": True,
                        "delay_minutes": 15,
                        "stream_error": str(exc),
                    }
                )
                if self._clients:
                    asyncio.create_task(self._reconnect_if_needed())

    async def _broadcast(self, symbol: str, event: dict[str, Any]) -> None:
        queues = list(self._clients.get(symbol, set()))
        if not queues:
            logger.debug("Delayed stream event for %s dropped because no chart clients are subscribed.", symbol)
            return
        logger.debug("Broadcasting delayed stream event for %s to %d chart clients.", symbol, len(queues))
        for queue in queues:
            if queue.full():
                with suppress(asyncio.QueueEmpty):
                    queue.get_nowait()
            await queue.put(event)

    async def _broadcast_status(self, message: dict[str, Any]) -> None:
        for queues in list(self._clients.values()):
            for queue in list(queues):
                if queue.full():
                    with suppress(asyncio.QueueEmpty):
                        queue.get_nowait()
                await queue.put(message)


massive_stream_manager = MassiveStreamManager()
