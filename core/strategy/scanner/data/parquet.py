import glob
from datetime import datetime

import pandas as pd
import pyarrow.dataset as ds

from core.strategy.scanner.data.base import MarketDataSource
from core.control.constants import PROJECT_ROOT

class ParquetDataSource(MarketDataSource):
    def __init__(self):
        super().__init__()

    def get_daily(self, symbol: int, lookback=30):
        current_year = datetime.now().year
        years = [current_year, current_year - 1]

        files = []
        for year in years:
            files.extend(
                glob.glob(
                    f"{PROJECT_ROOT}/core/data/historical_market_data/curated/1day/{year}/part-*.parquet"
                )
            )

        if not files:
            return pd.DataFrame()

        dataset = ds.dataset(files, format="parquet")
        df = dataset.to_table().to_pandas()

        # Scanner passes instrument ids, not ticker strings.
        filtered = df[df["instrument_id"] == symbol]
        filtered = filtered.sort_values("datetime", ascending=True)
        return filtered.tail(lookback)

    def get_intraday(self, symbols: list[int], timeframe="5min", lookback=-1):
        raise NotImplementedError("Intraday data retrieval is not available in the ParquetDataSource, as it only contains historic data.")