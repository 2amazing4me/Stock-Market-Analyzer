from pydantic import BaseModel, Field


class IndicatorRequestItem(BaseModel):
    id: str
    type: str
    period: int | None = None


class StockIndicatorsRequest(BaseModel):
    timeframe: str = "1d"
    limit: int = Field(default=1200, ge=50, le=5000)
    start_time: int | None = None
    end_time: int | None = None
    warmup_bars: int = Field(default=250, ge=0, le=1000)
    indicators: list[IndicatorRequestItem]


class IndicatorPoint(BaseModel):
    time: int
    value: float


class IndicatorLine(BaseModel):
    id: str
    label: str
    points: list[IndicatorPoint]


class IndicatorSeriesItem(BaseModel):
    id: str
    type: str
    period: int | None = None
    lines: list[IndicatorLine]


class StockIndicatorsResponse(BaseModel):
    symbol: str
    timeframe: str
    indicators: list[IndicatorSeriesItem]
