from pydantic import BaseModel


class Candle(BaseModel):
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: int


class StockCandlesResponse(BaseModel):
    symbol: str
    timeframe: str
    candles: list[Candle]
    source_mode: str = "local"
    source_provider: str = "TwelveData"
    delayed: bool = False
    delay_minutes: int | None = None
