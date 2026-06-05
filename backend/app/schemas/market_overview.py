from datetime import datetime

from pydantic import BaseModel


class MarketOverviewPoint(BaseModel):
    """Represents one plotted price point for a market overview card."""

    time: int
    price: float


class MarketOverviewAsset(BaseModel):
    """Carries display data for one market overview asset."""

    key: str
    label: str
    symbol: str
    price: float
    change_pct: float
    chart: list[MarketOverviewPoint]


class MarketOverviewResponse(BaseModel):
    """Carries Yahoo Finance market overview cards with attribution."""

    as_of: datetime
    source_provider: str = "Yahoo Finance"
    indices: list[MarketOverviewAsset]
    commodities: list[MarketOverviewAsset]
