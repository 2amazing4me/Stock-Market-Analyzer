import pandas_market_calendars as mcal
from datetime import datetime

from core.control.helpers import get_instrument_universe_db_conn
from core.control.constants import PRE_MARKET_START, REGULAR_MARKET_START, REGULAR_MARKET_END
from core.strategy.scanner.core.config import ScannerConfig
from core.strategy.scanner.data.parquet import ParquetDataSource
from core.strategy.scanner.data.ibkr import IBKRDataSource
from core.strategy.scanner.filters.atr import ATRFilter
from core.strategy.scanner.filters.price import PriceChangeFilter, PremarketPriceChangeFilter
from core.strategy.scanner.filters.volume import AvgVolumeFilter, RelativeVolumeFilter, PremarketVolumeFilter
from core.strategy.scanner.scanners.historical import HistoricalScanner
from core.strategy.scanner.scanners.intraday import IntradayScanner
from core.strategy.scanner.scanners.premarket import PremarketScanner


def _is_trading_day(date=None):
    if date is None:
        date = datetime.now()

    nyse = mcal.get_calendar('NYSE')
    schedule = nyse.schedule(start_date=date.date(), end_date=date.date())

    return not schedule.empty

def _get_symbols_to_scan():
    """
    Connects to the instrumentDB and retrieves all tickers and their corresponding IDs.
    """
    conn = get_instrument_universe_db_conn()
    if not conn:
        return []

    try:
        with conn.cursor() as cur:
            cur.execute("SELECT ticker, instrument_id FROM instruments")
            # Format as a list of dictionaries
            return [{"ticker": row[0], "id": row[1]} for row in cur.fetchall()]
    except Exception as e:
        print(f"Database query error: {e}")
        return []
    finally:
        if conn:
            conn.close()

def _get_ids_from_symbols(symbols):
    """A one-liner to extract just the integer IDs from the symbol dictionaries."""
    return [s['id'] for s in symbols]

def _get_tickers_from_ids(filtered_ids, all_symbols):
    """Filters the original symbols list to find tickers for the given IDs."""
    id_to_ticker_map = {s['id']: s['ticker'] for s in all_symbols}
    return [id_to_ticker_map[id] for id in filtered_ids if id in id_to_ticker_map]

def run_premarket_scanner():
    symbols = _get_symbols_to_scan()
    if not symbols:
        print("No symbols found to scan.")
        return

    parquet_source = ParquetDataSource()
    IBKR_source = IBKRDataSource()
    config = ScannerConfig(
        name="pre-market",
        historical_filters=[
            AvgVolumeFilter(1_000_000),
            ATRFilter(0.5)
        ],
        realtime_filters=[
            PremarketVolumeFilter(50_000),
            PremarketPriceChangeFilter(1)
        ]
    )

    # Stage 1 - Filter for generally liquid stocks
    historical = HistoricalScanner(parquet_source, config.historical_filters)
    filtered_ids = historical.scan(_get_ids_from_symbols(symbols))
    
    # Stage 2 - Filter for stocks with strong intraday movements
    realtime = PremarketScanner(IBKR_source, config.realtime_filters)
    candidates = realtime.scan(_get_tickers_from_ids(filtered_ids, symbols))

    return candidates

def run_intraday_scanner():
    symbols = _get_symbols_to_scan()
    if not symbols:
        print("No symbols found to scan.")
        return

    parquet_source = ParquetDataSource()
    IBKR_source = IBKRDataSource()
    config = ScannerConfig(
        name="intraday",
        historical_filters=[
            AvgVolumeFilter(1_000_000),
            ATRFilter(0.5)
        ],
        realtime_filters=[
            RelativeVolumeFilter(1.5),
            PriceChangeFilter(1)
        ]
    )

    # Stage 1 - Filter for generally liquid stocks
    historical = HistoricalScanner(parquet_source, config.historical_filters)
    filtered_ids = historical.scan(_get_ids_from_symbols(symbols))
    
    # Stage 2 - Filter for stocks with strong intraday movements
    realtime = IntradayScanner(IBKR_source, config.realtime_filters)
    candidates = realtime.scan(_get_tickers_from_ids(filtered_ids, symbols))

    return candidates

def run():
    """
    Run the appropriate scanner based on the current time:
    - If it's a trading day and before 9:30 AM, run the pre-market scanner.
    - If it's a trading day and between 9:30 AM and 4:00 PM, run the intraday scanner.
    - Otherwise, do not run any scanner.
    """
    if not _is_trading_day():
        print("Today is not a trading day. Scanner will not run.")
        return

    candidates = []

    # Get current time in Eastern Timezone
    now = datetime.now(tz=mcal.get_calendar('NYSE').tz).time()
    if PRE_MARKET_START <= now < REGULAR_MARKET_START:
        print("Running pre-market scanner...")
        candidates =run_premarket_scanner()
    elif REGULAR_MARKET_START <= now < REGULAR_MARKET_END:
        print("Running regular market scanner...")
        candidates = run_intraday_scanner()
    else:
        print("Market is closed. Scanner will not run.")

    print(f"Scanner found {len(candidates)} candidates:")
    for c in candidates:
        print(c)

if __name__ == "__main__":
    # run()
    symbols = _get_symbols_to_scan()
    filtered_ids = run_premarket_scanner()

    print("Total symbols scanned:", len(symbols))
    print("Total candidates found:", len(filtered_ids))

    # print("Filtered IDs:", filtered_ids)
    # print("Corresponding tickers:", _get_tickers_from_ids(filtered_ids, symbols))