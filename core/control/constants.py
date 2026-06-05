from pathlib import Path

from core.control.market_time import PRE_MARKET_START, REGULAR_MARKET_END, REGULAR_MARKET_START

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
LOGS_ROOT = PROJECT_ROOT / "logs"
