import asyncio
import json
import threading
from contextlib import suppress
from urllib.error import HTTPError, URLError

from fastapi import APIRouter, Depends, HTTPException, Request, Response, WebSocket, WebSocketDisconnect

from backend.app.data_sources.massive_stock_chart_source import check_massive_rest_health
from backend.app.data_sources.massive_stream_manager import massive_stream_manager
from backend.app.dependencies.common import get_request_id
from backend.app.schemas.health import HealthResponse
from backend.app.schemas.market_movers import MarketMoversResponse
from backend.app.schemas.market_overview import MarketOverviewResponse
from backend.app.schemas.scanner import ScannerColumnMetricsRequest, ScannerColumnMetricsResponse, ScannerMetadataResponse, ScannerRequest, ScannerResponse
from backend.app.schemas.stock_chart import StockCandlesResponse
from backend.app.schemas.stock_indicators import StockIndicatorsRequest, StockIndicatorsResponse
from backend.app.services.health_service import build_health_payload
from backend.app.services.logo_service import get_local_logo
from backend.app.services.market_movers_service import MARKET_MOVERS_LIMIT, get_market_movers
from backend.app.services.market_overview_service import get_market_overview
from backend.app.services.scanner_service import get_scanner_column_metrics, get_scanner_metadata, get_scanner_results
from backend.app.services.stock_chart_service import get_stock_candles
from backend.app.services.stock_indicator_service import get_stock_indicators

router = APIRouter(tags=["system"])


@router.get("/health", response_model=HealthResponse)
def health_check(request_id: str = Depends(get_request_id)) -> HealthResponse:
    return build_health_payload(request_id)


@router.get("/market-movers", response_model=MarketMoversResponse)
def market_movers() -> MarketMoversResponse:
    return get_market_movers(limit=MARKET_MOVERS_LIMIT)


@router.get("/logos/{symbol}")
def local_logo(symbol: str) -> Response:
    """Returns a locally cached company logo."""
    try:
        content, media_type = get_local_logo(symbol)
    except Exception as exc:
        raise HTTPException(status_code=404, detail="Logo unavailable") from exc
    return Response(content=content, media_type=media_type)


@router.get("/market-data/health")
def market_data_health() -> dict:
    health = check_massive_rest_health()
    health["local_provider"] = "TwelveData"
    return health


@router.get("/market-overview", response_model=MarketOverviewResponse)
def market_overview() -> MarketOverviewResponse:
    """Returns read-only index and macro overview cards from Yahoo Finance."""
    try:
        return get_market_overview()
    except (LookupError, RuntimeError, TimeoutError, HTTPError, URLError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/scanner", response_model=ScannerResponse)
async def scanner(request: Request, scanner_request: ScannerRequest) -> ScannerResponse:
    """Runs the predefined or custom stock scanner."""
    cancel_event = threading.Event()
    task = asyncio.create_task(asyncio.to_thread(get_scanner_results, scanner_request, cancel_event.is_set))
    try:
        while not task.done():
            if await request.is_disconnected():
                cancel_event.set()
                raise HTTPException(status_code=499, detail="Scanner request cancelled")
            await asyncio.sleep(0.1)
        return await task
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        cancel_event.set()
        if isinstance(exc, HTTPException):
            raise exc
        raise HTTPException(status_code=503, detail="Scanner unavailable") from exc


@router.get("/scanner/metadata", response_model=ScannerMetadataResponse)
def scanner_metadata() -> ScannerMetadataResponse:
    """Returns scanner option metadata."""
    return get_scanner_metadata()


@router.post("/scanner/columns", response_model=ScannerColumnMetricsResponse)
async def scanner_columns(request: Request, scanner_request: ScannerColumnMetricsRequest) -> ScannerColumnMetricsResponse:
    """Calculates extra scanner columns for existing result symbols."""
    cancel_event = threading.Event()
    task = asyncio.create_task(asyncio.to_thread(get_scanner_column_metrics, scanner_request, cancel_event.is_set))
    try:
        while not task.done():
            if await request.is_disconnected():
                cancel_event.set()
                raise HTTPException(status_code=499, detail="Scanner column request cancelled")
            await asyncio.sleep(0.1)
        return await task
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        cancel_event.set()
        if isinstance(exc, HTTPException):
            raise exc
        raise HTTPException(status_code=503, detail="Scanner columns unavailable") from exc


@router.websocket("/stocks/{ticker}/stream")
async def stock_stream(websocket: WebSocket, ticker: str) -> None:
    await websocket.accept()
    queue = None
    try:
        while queue is None:
            try:
                queue = await massive_stream_manager.subscribe(ticker)
            except WebSocketDisconnect:
                return
            except Exception as exc:
                await websocket.send_json(
                    {
                        "type": "status",
                        "source_mode": "api_snapshot",
                        "source_provider": "Massive/Polygon.io",
                        "delayed": True,
                        "delay_minutes": 15,
                        "stream_error": str(exc),
                    }
                )
                await asyncio.sleep(3)

        await websocket.send_json(
            {
                "type": "status",
                "source_mode": "streaming",
                "source_provider": "Massive/Polygon.io",
                "delayed": True,
                "delay_minutes": 15,
            }
        )
        while True:
            event = await queue.get()
            await websocket.send_json(event)
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        with suppress(Exception):
            await websocket.send_json({"type": "error", "message": str(exc)})
    finally:
        if queue is not None:
            await massive_stream_manager.unsubscribe(ticker, queue)


@router.get("/stocks/{ticker}/candles", response_model=StockCandlesResponse)
def stock_candles(
    ticker: str,
    timeframe: str = "1d",
    limit: int = 600,
    before: int | None = None,
    after: int | None = None,
    include_extended_hours: bool = True,
    adjusted: bool = True,
) -> StockCandlesResponse:
    safe_limit = max(50, min(limit, 5000))

    if before is not None and after is not None:
        raise HTTPException(status_code=400, detail="Use either before or after, not both.")

    try:
        return get_stock_candles(
            ticker=ticker,
            timeframe=timeframe,
            limit=safe_limit,
            before=before,
            after=after,
            include_extended_hours=include_extended_hours,
            adjusted=adjusted,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Failed to load stock candles") from exc


@router.post("/stocks/{ticker}/indicators", response_model=StockIndicatorsResponse)
def stock_indicators(ticker: str, request: StockIndicatorsRequest) -> StockIndicatorsResponse:
    safe_request = request.model_copy(
        update={
            "limit": max(50, min(request.limit, 5000)),
        }
    )

    try:
        return get_stock_indicators(ticker=ticker, request=safe_request)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Failed to load stock indicators") from exc
