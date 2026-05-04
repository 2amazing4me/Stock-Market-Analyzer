import os
import psycopg2
from dotenv import load_dotenv

load_dotenv()

def get_instrument_universe_db_conn():
    """
    Establishes and returns a connection to the instrumentDB PostgreSQL database.
    """
    try:
        conn = psycopg2.connect(
            host=os.getenv("POSTGRES_HOST", "localhost"),
            port=os.getenv("POSTGRES_PORT", 5432),
            dbname=os.getenv("POSTGRES_DB", "instrumentdb"),
            user=os.getenv("POSTGRES_USER"),
            password=os.getenv("POSTGRES_PASSWORD"),
        )
        return conn
    except psycopg2.Error as e:
        print(f"Database connection error: {e}")
        return None
