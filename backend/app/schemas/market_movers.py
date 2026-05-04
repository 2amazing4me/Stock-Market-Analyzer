from datetime import datetime

from pydantic import BaseModel


class MarketMover(BaseModel):
    symbol: str
    instrument_id: int
    close: float
    change_pct: float
    volume: int


class MarketMoversResponse(BaseModel):
    as_of: datetime
    gainers: list[MarketMover]
    losers: list[MarketMover]
