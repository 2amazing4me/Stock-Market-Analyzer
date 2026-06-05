import os
import time
import glob
import logging
from datetime import datetime, timedelta

import pandas as pd
from dotenv import load_dotenv
from twelvedata import TDClient

from core.control.constants import LOGS_ROOT, PROJECT_ROOT
from core.control.helpers import get_instrument_universe_db_conn
from core.control.logging_config import configure_file_logging
from core.data.market_data_ingestor.data_processing import normalize_data

TICKERS_FILE = f"{PROJECT_ROOT}/core/control/data_layer/all.csv"
PROGRESS_FILE = f"{PROJECT_ROOT}/core/control/data_layer/progress.txt"
RATE_LIMIT_FILE = f"{PROJECT_ROOT}/core/control/data_layer/rate_limits_today.txt"
SKIPPED_LOG_FILE = LOGS_ROOT / "core" / "data_ingestion" / "skipped.txt"
HISTORICAL_DATA_ROOT = f"{PROJECT_ROOT}/core/data/historical_market_data"
INTERVALS = ["1day", "1h", "5min"]
INSTRUMENT_ID_CACHE = {}
logger = logging.getLogger(__name__)


def get_batch_end_date():
    """
    Use the most recent complete day as the newest date for a batch, avoiding
    partial intraday data from today.
    """
    return datetime.now().date() - timedelta(days=1)


def get_cutoff_date(batch_end_date, years):
    """
    Get Jan 1st from the year that is `years` before the batch end date.
    """
    return pd.Timestamp(year=batch_end_date.year - years, month=1, day=1)


def read_tickers():
    with open(TICKERS_FILE) as f:
        # Skip header, extract first column (symbol)
        return [line.split(",")[0] for line in f.read().strip().splitlines()[1:]]


def get_instrument_id(ticker):
    if ticker in INSTRUMENT_ID_CACHE:
        return INSTRUMENT_ID_CACHE[ticker]

    conn = get_instrument_universe_db_conn()
    if conn is None:
        return None

    result = None
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS instruments (
                        instrument_id SERIAL PRIMARY KEY,
                        ticker        TEXT UNIQUE NOT NULL
                    )
                """)
                cur.execute("SELECT instrument_id FROM instruments WHERE ticker = %s", (ticker,))
                result = cur.fetchone()
    except Exception as e:
        logger.warning("Skipping parquet coverage check for %s: unable to read instrument id (%s)", ticker, e)
    finally:
        conn.close()

    instrument_id = result[0] if result else None
    INSTRUMENT_ID_CACHE[ticker] = instrument_id
    return instrument_id


def read_progress():
    progress = open(PROGRESS_FILE).read().strip().split("\n")

    if len(progress) == 3:
        ticker, interval, date = progress
        batch_end_date = date
    elif len(progress) == 4:
        ticker, interval, date, batch_end_date = progress
    else:
        raise ValueError(f"Invalid progress file format in {PROGRESS_FILE}")

    if ticker == "None":
        ticker = read_tickers()[0]
        interval = "1day"
        date = get_batch_end_date().strftime("%Y-%m-%d")
        batch_end_date = date

    return ticker, interval, date, datetime.strptime(batch_end_date[:10], "%Y-%m-%d").date()


def write_progress(ticker, interval, date, batch_end_date):
    open(PROGRESS_FILE, "w").write(f"{ticker}\n{interval}\n{date}\n{batch_end_date:%Y-%m-%d}")


def get_partition_pattern(layer, interval, timestamp):
    if interval == "1day":
        return f"{HISTORICAL_DATA_ROOT}/{layer}/{interval}/{timestamp.year}/part-*.parquet"

    return f"{HISTORICAL_DATA_ROOT}/{layer}/{interval}/{timestamp.year}/{timestamp.month}/part-*.parquet"


def get_staging_pattern(interval, timestamp):
    if interval == "1day":
        return f"{HISTORICAL_DATA_ROOT}/staging/{interval}/{timestamp.year}/req-*.parquet"

    return f"{HISTORICAL_DATA_ROOT}/staging/{interval}/{timestamp.year}/{timestamp.month}/req-*.parquet"


def get_parquet_files_for_date(interval, timestamp):
    files = glob.glob(get_partition_pattern("curated", interval, timestamp))
    files.extend(glob.glob(get_staging_pattern(interval, timestamp)))
    return sorted(files)


def request_already_covered(ticker, interval, date):
    """
    Return True when the requested end date is already covered by local parquet
    data for this ticker and interval.
    """
    instrument_id = get_instrument_id(ticker)
    if instrument_id is None:
        return False

    requested_date = pd.Timestamp(date)

    for file_path in get_parquet_files_for_date(interval, requested_date):
        try:
            data = pd.read_parquet(file_path, columns=["instrument_id"])
        except Exception as e:
            logger.warning("Skipping parquet coverage check for %s: %s", file_path, e)
            continue

        if data.empty or "instrument_id" not in data.columns:
            continue

        ticker_data = data[data["instrument_id"] == instrument_id]
        if ticker_data.empty:
            continue

        first_available = ticker_data.index.min()
        last_available = ticker_data.index.max()
        if first_available <= requested_date <= last_available:
            return True

    return False


def store_data(data, interval, rate_limit):
    """
    Store the fetched data as parquet files in the following structure:
    historical_market_data/
        staging/
            1day/
                year/
                    req-000.parquet
                    req-001.parquet
                        ...
            1hour/
                year/
                    month/
                        req-000.parquet
                        req-001.parquet
                        ...
            5min/
                year/
                    month/
                        req-000.parquet
                        req-001.parquet
                        ...
    """

    if interval == "1day":
        for year, year_data in data.groupby(data.index.year):
            file_path = f"{PROJECT_ROOT}/core/data/historical_market_data/staging/{interval}/{year}/req-{rate_limit}.parquet"
            os.makedirs(os.path.dirname(file_path), exist_ok=True)
            year_data.to_parquet(file_path, index=True)
    else:
        for (year, month), group_data in data.groupby([data.index.year, data.index.month]):
            file_path = f"{PROJECT_ROOT}/core/data/historical_market_data/staging/{interval}/{year}/{month}/req-{rate_limit}.parquet"
            os.makedirs(os.path.dirname(file_path), exist_ok=True)
            group_data.to_parquet(file_path, index=True)


def get_next_ticker(current_ticker):
    """
    Get the next ticker to fetch from the list of tickers in /core/control/data_layer/all.csv
    """
    tickers = read_tickers()

    if current_ticker not in tickers:
        return None

    current_index = tickers.index(current_ticker)

    if (current_index + 1) >= len(tickers):
        return tickers[0]
    else:
        return tickers[current_index + 1]


def advance_past_completed_request(ticker, interval, batch_end_date):
    if interval == "1day":
        return ticker, "1h", batch_end_date.strftime("%Y-%m-%d"), batch_end_date, False

    if interval == "1h":
        return ticker, "5min", batch_end_date.strftime("%Y-%m-%d"), batch_end_date, False

    next_ticker = get_next_ticker(ticker)
    next_batch_end_date = batch_end_date
    wrapped = next_ticker == read_tickers()[0]

    if wrapped:
        next_batch_end_date = get_batch_end_date()

    return next_ticker, "1day", next_batch_end_date.strftime("%Y-%m-%d"), next_batch_end_date, wrapped


def advance_to_next_missing_request(ticker, interval, date, batch_end_date):
    """
    Skip requests whose requested end date is already present locally.
    Returns should_continue=False if the current batch is fully covered.
    """
    max_skips = len(read_tickers()) * len(INTERVALS)
    skips = 0

    while ticker is not None and request_already_covered(ticker, interval, date):
        logger.info("Skipping %s (%s, %s): already covered by local parquet data.", ticker, interval, date)
        previous_batch_end_date = batch_end_date
        ticker, interval, date, batch_end_date, wrapped = advance_past_completed_request(
            ticker, interval, batch_end_date
        )
        write_progress(ticker, interval, date, batch_end_date)

        if wrapped and batch_end_date == previous_batch_end_date:
            logger.info("All tickers already covered for batch end date %s.", f"{batch_end_date:%Y-%m-%d}")
            return ticker, interval, date, batch_end_date, False

        skips += 1
        if skips >= max_skips:
            logger.info("All pending requests are already covered by local parquet data.")
            return ticker, interval, date, batch_end_date, False

    return ticker, interval, date, batch_end_date, True


def update_progress(ticker, interval, date, batch_end_date, data):
    """
    Update the next ticker, interval and date to fetch.
    """

    # If data is None, set last_date to a default that skips to the next interval or ticker
    last_date = data.index[-1] if data is not None else pd.Timestamp("2005-01-01")

    if interval == "1day":
        next_date = last_date - pd.Timedelta(days=1)

        if next_date < get_cutoff_date(batch_end_date, 20):
            # Move to next interval
            interval = "1h"
            date = batch_end_date.strftime("%Y-%m-%d")
        else:
            date = next_date.strftime("%Y-%m-%d")

    elif interval == "1h":
        next_date = last_date - pd.Timedelta(hours=1)

        if next_date < get_cutoff_date(batch_end_date, 5):
            # Move to next interval
            interval = "5min"
            date = batch_end_date.strftime("%Y-%m-%d")
        else:
            date = next_date.strftime("%Y-%m-%d %H:%M:%S")

    elif interval == "5min":
        next_date = last_date - pd.Timedelta(minutes=5)

        if next_date < get_cutoff_date(batch_end_date, 2):
            ticker, interval, date, batch_end_date, _ = advance_past_completed_request(
                ticker, interval, batch_end_date
            )
        else:
            date = next_date.strftime("%Y-%m-%d %H:%M:%S")

    write_progress(ticker, interval, date, batch_end_date)
    return ticker, interval, date, batch_end_date


def populate_historic_market_data():
    """
    Populate the historical market data incrementally from Twelve Data API and
    save it as parquet files.

    Due to API rate limits (8 req/min, 800 req/day, 5000 data points per request)
    we will either fetch until we have built our dataset or until we hit the daily limit.

    Will fetch all current US tickers ({root}/core/control/data_layer/all.csv):
        1. Daily data for last 20 years (cutoff: Jan 1, 20 years before batch end date)
        2. Hourly data for last 5 years (cutoff: Jan 1, 5 years before batch end date)
        3. 5-min data for last 2 years (cutoff: Jan 1, 2 years before batch end date)

    Fetches today's rate limit from {root}/core/control/data_layer/rate_limits_today.txt and updates it after each request.

    Once rate limit is hit, update {root}/core/control/data_layer/progress.txt with the last ticker, interval and date fetched.
    """

    load_dotenv()
    td = TDClient(apikey=os.getenv("TWELVE_DATA_KEY"))

    rate_limit = int(open(RATE_LIMIT_FILE).read().strip())
    ticker, interval, date, batch_end_date = read_progress()
    write_progress(ticker, interval, date, batch_end_date)

    requests_in_last_minute = 0
    last_request_seconds = 0

    while rate_limit > 0 and ticker is not None:
        ticker, interval, date, batch_end_date, should_continue = advance_to_next_missing_request(
            ticker, interval, date, batch_end_date
        )
        if not should_continue:
            return

        logger.info(
            "Fetching data for %s at interval %s starting from %s with batch end date %s, %d requests left today and %d requests made in the last minute.",
            ticker,
            interval,
            date,
            f"{batch_end_date:%Y-%m-%d}",
            rate_limit,
            requests_in_last_minute,
        )

        # Fetch and store data for the next ticker, interval and date
        data = None
        try:
            data = td.time_series(symbol=ticker, interval=interval, end_date=date, outputsize=5000).as_pandas()

            data = normalize_data(data, ticker)
            store_data(data, interval, rate_limit)
        except Exception as e:
            logger.warning("Skipping %s (%s, %s): %s", ticker, interval, date, e)
            SKIPPED_LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
            open(SKIPPED_LOG_FILE, "a").write(f"Skipping {ticker} ({interval}, {date}): {e}\n")

        # Update rate_limit after each request
        rate_limit -= 1
        open(RATE_LIMIT_FILE, "w").write(str(rate_limit))

        current_seconds = int(datetime.now().strftime("%S"))
        if current_seconds < last_request_seconds:
            requests_in_last_minute = 1
        else:
            requests_in_last_minute += 1

        last_request_seconds = current_seconds

        if requests_in_last_minute >= 8:
            time.sleep(60 - current_seconds)

        # update progress.txt
        ticker, interval, date, batch_end_date = update_progress(ticker, interval, date, batch_end_date, data)

    if rate_limit <= 0:
        logger.info("Daily rate limit reached. Run again tomorrow.")
        return


def main():
    configure_file_logging("core/data_ingestion/market_data_ingestor.log")
    populate_historic_market_data()


if __name__ == "__main__":
    main()
