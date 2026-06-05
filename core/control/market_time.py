import json
from pathlib import Path
from zoneinfo import ZoneInfo

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
MARKET_CONFIG = json.loads((PROJECT_ROOT / "shared" / "market_config.json").read_text())

EXCHANGE_TIMEZONE_NAME = MARKET_CONFIG["exchangeTimezone"]
EXCHANGE_TIMEZONE = ZoneInfo(EXCHANGE_TIMEZONE_NAME)

PRE_MARKET_START = MARKET_CONFIG["preMarketStart"]
REGULAR_MARKET_START = MARKET_CONFIG["regularMarketStart"]
REGULAR_MARKET_END = MARKET_CONFIG["regularMarketEnd"]

REGULAR_MARKET_OPEN_MINUTES = int(MARKET_CONFIG["regularMarketOpenMinutes"])
REGULAR_MARKET_CLOSE_MINUTES = int(MARKET_CONFIG["regularMarketCloseMinutes"])
