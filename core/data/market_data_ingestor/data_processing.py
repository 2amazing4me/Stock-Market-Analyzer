from core.control.helpers import get_instrument_universe_db_conn

def _ensure_instruments_table(cursor):
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS instruments (
            instrument_id SERIAL PRIMARY KEY,
            ticker        TEXT UNIQUE NOT NULL
        )
    """)

def normalize_data(data, ticker):
    """
    Normalize the data by adding a instrument_id column being the ticker mapped to an integer.
    Looks up the ticker in instrumentDB; inserts a new row if not present.
    """
    with get_instrument_universe_db_conn() as conn:
        with conn.cursor() as cur:
            _ensure_instruments_table(cur)

            cur.execute(
                "INSERT INTO instruments (ticker) VALUES (%s) ON CONFLICT (ticker) DO NOTHING",
                (ticker,)
            )

            cur.execute(
                "SELECT instrument_id FROM instruments WHERE ticker = %s",
                (ticker,)
            )
            instrument_id = cur.fetchone()[0]

        conn.commit()

    data["instrument_id"] = instrument_id
    return data