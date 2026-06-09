from datetime import date, datetime, time, timedelta

import pandas_market_calendars as mcal

from core.control.market_time import EXCHANGE_TIMEZONE


def recent_completed_trading_dates(count: int) -> list[date]:
    """Returns the most recent completed NYSE trading dates."""
    exchange_now = datetime.now(tz=EXCHANGE_TIMEZONE)
    end_date = exchange_now.date()
    if exchange_now.time() < time(18, 0):
        end_date = end_date - timedelta(days=1)

    nyse = mcal.get_calendar("NYSE")
    schedule = nyse.schedule(start_date=end_date - timedelta(days=max(90, count * 2)), end_date=end_date)
    dates = [ts.date() for ts in schedule.index]
    return dates[-count:]


def is_trading_day(value: date | None = None) -> bool:
    """Returns whether the provided date is an NYSE trading day."""
    if value is None:
        value = datetime.now(tz=EXCHANGE_TIMEZONE).date()

    nyse = mcal.get_calendar("NYSE")
    schedule = nyse.schedule(start_date=value, end_date=value)
    return not schedule.empty
