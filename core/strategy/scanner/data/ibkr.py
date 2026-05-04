from attr import ib
from ib_insync import IB
from core.strategy.scanner.data.base import MarketDataSource

class IBKRDataSource(MarketDataSource):
    def __init__(self, ):
        ib = IB()

        # Connect to IB Gateway running on your machine
        # Typical IB Gateway live port: 4001, paper port: 4002
        # ib.connect(host="127.0.0.1", port=4002, clientId=1)

    def get_daily(self, symbol: str, lookback: int):
        pass

    def get_intraday(self, symbols: list[str], timeframe: str, lookback: int):
        contract = Stock(symbol, "SMART", "USD")
        
        ib.reqHistoricalData(
            contract,
            endDateTime='',
            durationStr='1 D',
            barSizeSetting='5 mins',
            whatToShow='TRADES',
            useRTH=False
        )
        pass

    def stream_market_data(self, symbols: list[str]):
        """Websocket streaming for watchlist"""
        pass