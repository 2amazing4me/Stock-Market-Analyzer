import os
import pandas as pd
import time
from datetime import datetime
from dotenv import load_dotenv
from twelvedata import TDClient

from core.control.constants import PROJECT_ROOT
from core.data.market_data_ingestor.data_processing import normalize_data

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
    with open(f"{PROJECT_ROOT}/core/control/data_layer/all.csv") as f:
        # Skip header, extract first column (symbol)
        tickers = [line.split(",")[0] for line in f.read().strip().splitlines()[1:]]

    if current_ticker not in tickers:
        return None

    current_index = tickers.index(current_ticker)

    if (current_index + 1) >= len(tickers):
        return None  # No more tickers to fetch
    else:
        return tickers[current_index + 1]


def update_progress(ticker, interval, date, data):
    """
    Update the next ticker, interval and date to fetch.
    """

    # If data is None, set last_date to a default that skips to the next interval or ticker
    last_date = data.index[-1] if data is not None else pd.Timestamp("2005-01-01")

    if interval == "1day":
        next_date = last_date - pd.Timedelta(days=1)

        if next_date < pd.Timestamp("2006-01-01"):
            # Move to next interval
            interval = "1h"
            date = "2026-03-08"
        else:
            date = next_date.strftime("%Y-%m-%d")

    elif interval == "1h":
        next_date = last_date - pd.Timedelta(hours=1)

        if next_date < pd.Timestamp("2021-01-01"):
            # Move to next interval
            interval = "5min"
            date = "2026-03-08"
        else:
            date = next_date.strftime("%Y-%m-%d %H:%M:%S")

    elif interval == "5min":
        next_date = last_date - pd.Timedelta(minutes=5)

        if next_date < pd.Timestamp("2024-01-01"):
            ticker = get_next_ticker(ticker)
            interval = "1day"
            date = "2026-03-08"
        else:
            date = next_date.strftime("%Y-%m-%d %H:%M:%S")
    
    open(f"{PROJECT_ROOT}/core/control/data_layer/progress.txt", "w").write(f"{ticker}\n{interval}\n{date}")
    return ticker, interval, date


def populate_historic_market_data():
    """
    Populate the historical market data incrementally from Twelve Data API and
    save it as parquet files.

    Due to API rate limits (8 req/min, 800 req/day, 5000 data points per request)
    we will either fetch until we have built our dataset or until we hit the daily limit.

    Will fetch all current US tickers ({root}/core/control/data_layer/all.csv):
        1. Daily data for last 20 years (cutoff: 01/01/2006)
        2. Hourly data for last 5 years (cutoff: 01/01/2021)
        3. 5-min data for last 2 years (cutoff: 01/01/2024)

    Fetches today's rate limit from {root}/core/control/data_layer/rate_limits_today.txt and updates it after each request.

    Once rate limit is hit, update {root}/core/control/data_layer/progress.txt with the last ticker, interval and date fetched.
    """

    load_dotenv()
    td = TDClient(apikey=os.getenv("TWELVE_DATA_KEY"))

    rate_limit = int(open(f"{PROJECT_ROOT}/core/control/data_layer/rate_limits_today.txt").read().strip())
    ticker, interval, date = open(f"{PROJECT_ROOT}/core/control/data_layer/progress.txt").read().strip().split("\n")

    requests_in_last_minute = 0
    last_request_seconds = 0

    while rate_limit > 0 and ticker is not None:
        print(f"Fetching data for {ticker} at interval {interval} starting from {date} with {rate_limit} requests left today and {requests_in_last_minute} requests made in the last minute.")

        # Fetch and store data for the next ticker, interval and date
        data = None
        try:
            data = td.time_series(symbol=ticker, interval=interval, end_date=date, outputsize=5000).as_pandas()

            data = normalize_data(data, ticker)
            store_data(data, interval, rate_limit)
        except Exception as e:
            print(f"Skipping {ticker} ({interval}, {date}): {e}")
            open(f"{PROJECT_ROOT}/core/control/logs/data_ingestion/skipped.txt", "a").write(f"Skipping {ticker} ({interval}, {date}): {e}\n")

        # Update rate_limit after each request
        rate_limit -= 1
        open(f"{PROJECT_ROOT}/core/control/data_layer/rate_limits_today.txt", "w").write(str(rate_limit))

        current_seconds = int(datetime.now().strftime("%S"))
        if current_seconds < last_request_seconds:
            requests_in_last_minute = 1
        else:
            requests_in_last_minute += 1

        last_request_seconds = current_seconds

        if requests_in_last_minute >= 8:
            time.sleep(60 - current_seconds)

        # update progress.txt
        ticker, interval, date = update_progress(ticker, interval, date, data)

    if rate_limit <= 0:
        print("Daily rate limit reached. Run again tomorrow.")
        return
    
    if ticker is None:
        print("All tickers fetched. Process complete.")
        return


def main():
    populate_historic_market_data()


if __name__ == "__main__":
    main()
