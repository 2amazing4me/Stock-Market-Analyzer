import pandas_ta as ta
import pandas as pd

class IndicatorCalculator:
    @staticmethod
    def avg_volume(df, window=30):
        avg_volume = df["volume"].rolling(window).mean().iloc[-1]
        if pd.isna(avg_volume):
            return 0.0
        
        return avg_volume

    @staticmethod
    def atr(df, window=14):
        atr = ta.atr(df["high"], df["low"], df["close"], length=window).iloc[-1]
        if pd.isna(atr):
            return 0.0

        return atr

    @staticmethod
    def relative_volume(current_vol, avg_vol):
        return current_vol / avg_vol if avg_vol != 0 else 0