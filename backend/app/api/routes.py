import asyncio
from contextlib import suppress

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect

from backend.app.data_sources.massive_stock_chart_source import check_massive_rest_health
from backend.app.data_sources.massive_stream_manager import massive_stream_manager
from backend.app.dependencies.common import get_request_id
from backend.app.schemas.health import HealthResponse
from backend.app.schemas.market_movers import MarketMoversResponse
from backend.app.schemas.stock_chart import StockCandlesResponse
from backend.app.schemas.stock_indicators import StockIndicatorsRequest, StockIndicatorsResponse
from backend.app.services.health_service import build_health_payload
from backend.app.services.market_movers_service import get_market_movers
from backend.app.services.stock_chart_service import get_stock_candles
from backend.app.services.stock_indicator_service import get_stock_indicators

router = APIRouter(tags=["system"])


@router.get("/health", response_model=HealthResponse)
def health_check(request_id: str = Depends(get_request_id)) -> HealthResponse:
    return build_health_payload(request_id)


@router.get("/market-movers", response_model=MarketMoversResponse)
def market_movers() -> MarketMoversResponse:
    return get_market_movers(limit=30)


@router.get("/market-data/health")
def market_data_health() -> dict:
    health = check_massive_rest_health()
    health["local_provider"] = "TwelveData"
    return health


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
