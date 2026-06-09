"""Defines shared scanner preprocessing periods and timeframe settings."""

BENCHMARK_SYMBOL = "SPY"
AVG_VOLUME_PERIODS = (1, 5, 10, 30, 60, 90)
RSI_PERIODS = (7, 14, 21, 30)
ATR_PERIODS = (7, 14, 21, 30)
BETA_PERIODS = (252, 756, 1260)
INDICATOR_WARMUP_BARS = 250
TECHNICAL_TIMEFRAMES = {
    "1m": (1, "minute", 10),
    "5m": (5, "minute", 14),
    "15m": (15, "minute", 21),
    "30m": (30, "minute", 30),
    "1h": (1, "hour", 45),
    "2h": (2, "hour", 75),
    "4h": (4, "hour", 120),
    "1d": (1, "day", 120),
    "1w": (1, "week", 500),
    "1mo": (1, "month", 1200),
}
