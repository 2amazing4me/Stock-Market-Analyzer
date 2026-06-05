from datetime import datetime

from pydantic import BaseModel


class MarketMover(BaseModel):
    """Represents a single ranked market mover row."""

    symbol: str
    instrument_id: int
    name: str = ""
    logo_url: str = ""
    close: float
    change_pct: float
    volume: int


class MarketMoversResponse(BaseModel):
    """Carries market movers lists with data-source attribution."""

    as_of: datetime
    source_mode: str = "local"
    source_provider: str = "Twelve Data"
    delayed: bool = False
    delay_minutes: int | None = None
    source_error: str = ""
    gainers: list[MarketMover]
    losers: list[MarketMover]
