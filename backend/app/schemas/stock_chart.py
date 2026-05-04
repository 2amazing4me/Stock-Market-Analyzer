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
