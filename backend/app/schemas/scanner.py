from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


ScannerMode = Literal["predefined", "custom"]
ScannerOperator = Literal["above", "under", "between", "outside"]


class ScannerFilterRequest(BaseModel):
    """Carries one configured custom scanner filter from the frontend."""

    field: str
    operator: ScannerOperator
    values: list[float] = Field(default_factory=list, max_length=2)
    selected_values: list[str] = Field(default_factory=list, max_length=32)
    period: int | str | None = None
    timeframe: str | None = None
    range: int | None = None


class ScannerRequest(BaseModel):
    """Carries a scanner run request."""

    mode: ScannerMode
    filters: list[ScannerFilterRequest] = Field(default_factory=list, max_length=16)


class ScannerColumnMetricsRequest(BaseModel):
    """Carries a request to enrich current scanner rows with extra columns."""

    symbols: list[str] = Field(default_factory=list, max_length=2000)
    metrics: list[str] = Field(default_factory=list, max_length=16)
    metric_periods: dict[str, object] = Field(default_factory=dict)


class ScannerResult(BaseModel):
    """Represents one scanner candidate row."""

    symbol: str
    name: str | None = None
    logo_url: str = ""
    industry: str | None = None
    price: float = 0.0
    market_cap: float | None = None
    beta: float | None = None
    change: float | None = None
    change_pct: float | None = None
    volume: float | None = None
    dollar_volume: float | None = None
    vwap: float | None = None
    relative_volume: float | None = None
    avg_volume: float | None = None
    avg_dollar_volume: float | None = None
    rsi: float | None = None
    atr: float | None = None
    atr_pct: float | None = None


class ScannerResponse(BaseModel):
    """Returns scanner candidates and request metadata."""

    as_of: datetime
    mode: ScannerMode
    scanner_name: str | None = None
    total_count: int
    historical_metrics_enabled: bool = False
    metric_periods: dict[str, object] = Field(default_factory=dict)
    calculated_metrics: list[str] = Field(default_factory=list)
    results: list[ScannerResult]


class ScannerMetadataResponse(BaseModel):
    """Returns static scanner option metadata."""

    industries: list[str] = Field(default_factory=list)


class ScannerColumnMetricsResponse(BaseModel):
    """Returns enriched scanner column values for existing result symbols."""

    metric_periods: dict[str, object] = Field(default_factory=dict)
    calculated_metrics: list[str] = Field(default_factory=list)
    results: list[ScannerResult]
