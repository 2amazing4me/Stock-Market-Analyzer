from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent

# Eastern Timezone for US stock market hours
PRE_MARKET_START = "04:00:00"
REGULAR_MARKET_START = "09:30:00"
REGULAR_MARKET_END = "16:00:00"