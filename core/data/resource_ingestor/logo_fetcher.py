import argparse
import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import pandas as pd

from core.control.constants import PROJECT_ROOT
from core.control.logging_config import configure_file_logging
from core.strategy.scanner.data.massive import MassiveDataSource

try:
    from dotenv import load_dotenv
except ImportError:
    load_dotenv = None


MASSIVE_REST_BASE_URL = "https://api.massive.com"
LOGO_DIR = PROJECT_ROOT / "core" / "resources" / "logos"
COMPANY_METADATA_CACHE = PROJECT_ROOT / "core" / "resources" / "company_metadata.csv"
MAX_WORKERS = 12
LOGO_EXTENSIONS = (".svg", ".png", ".jpg", ".jpeg")
RASTER_LOGO_EXTENSIONS = (".png", ".jpg", ".jpeg")
LOGO_FORMAT_CHOICES = ("smallest", "raster", "svg")
METADATA_COLUMNS = ("symbol", "name", "market_cap", "weighted_shares_outstanding")

logger = logging.getLogger(__name__)


def _load_api_key() -> str:
    """Loads the Massive REST API key from the project environment."""
    if load_dotenv is not None:
        load_dotenv(PROJECT_ROOT / ".env")
    api_key = os.getenv("MASSIVE_KEY")
    if not api_key:
        raise RuntimeError("MASSIVE_KEY is not configured")
    return api_key


def _canonical_ticker(ticker: str) -> str:
    """Converts local ticker separators to Massive ticker separators."""
    return str(ticker).strip().upper().replace("/", ".")


def _logo_stem(ticker: str) -> str:
    """Returns the local logo filename stem for a ticker."""
    safe_ticker = "".join(char if char.isalnum() or char in {".", "-"} else "_" for char in _canonical_ticker(ticker))
    return f"{safe_ticker}_logo"


def _extension_from_content_type(content_type: str, fallback_url: str) -> str:
    """Returns a file extension for a downloaded logo payload."""
    normalized = content_type.lower()
    if "svg" in normalized:
        return ".svg"
    if "png" in normalized:
        return ".png"
    if "jpeg" in normalized or "jpg" in normalized:
        return ".jpg"

    suffix = Path(fallback_url.split("?", 1)[0]).suffix.lower()
    return suffix if suffix in LOGO_EXTENSIONS else ".png"


def _logo_matches_format(extension: str, logo_format: str) -> bool:
    """Checks whether a logo file extension matches the requested format mode."""
    if logo_format == "smallest":
        return True
    if logo_format == "svg":
        return extension == ".svg"
    return extension in RASTER_LOGO_EXTENSIONS


def _scanner_universe_tickers() -> set[str]:
    """Loads scanner universe tickers from Massive or its daily cache."""
    try:
        return {_canonical_ticker(ticker) for ticker in MassiveDataSource().load_ticker_universe()}
    except Exception as exc:
        logger.warning("Could not load scanner universe for logos: %s", exc)
        return set()


def _ticker_universe() -> list[str]:
    """Returns the Massive-backed ticker universe used for local logo caching."""
    tickers = _scanner_universe_tickers()
    return sorted(ticker for ticker in tickers if ticker)


def _request_json(url: str) -> dict:
    """Requests one JSON payload from Massive."""
    with urlopen(Request(url, headers={"Accept": "application/json"}), timeout=12) as response:
        return json.loads(response.read().decode("utf-8"))


def _request_image(url: str) -> tuple[bytes, str]:
    """Requests one image payload from Massive."""
    with urlopen(Request(url, headers={"Accept": "image/svg+xml,image/*"}), timeout=12) as response:
        return response.read(), response.headers.get("Content-Type", "image/png")


def _url_with_api_key(url: str, api_key: str) -> str:
    """Adds the Massive API key to a request URL."""
    separator = "&" if "?" in url else "?"
    return f"{url}{separator}{urlencode({'apiKey': api_key})}"


def _ticker_details(ticker: str, api_key: str) -> dict:
    """Returns one Massive reference ticker detail payload."""
    details_url = _url_with_api_key(f"{MASSIVE_REST_BASE_URL}/v3/reference/tickers/{ticker}", api_key)
    payload = _request_json(details_url)
    return payload.get("results") or {}


def _branding_urls(details: dict) -> list[str]:
    """Returns the SVG and raster branding URLs from ticker details."""
    branding = details.get("branding") or {}
    return [
        str(url)
        for url in (branding.get("logo_url"), branding.get("icon_url"))
        if url
    ]


def _metadata_record(ticker: str, details: dict) -> dict[str, object]:
    """Builds one company metadata cache row from ticker details."""
    return {
        "symbol": _canonical_ticker(details.get("ticker") or ticker),
        "name": str(details.get("name") or "").strip(),
        "market_cap": details.get("market_cap"),
        "weighted_shares_outstanding": details.get("weighted_shares_outstanding"),
    }


def _replace_logo(ticker: str, content: bytes, extension: str) -> Path:
    """Writes one ticker logo and removes older extensions for that ticker."""
    LOGO_DIR.mkdir(parents=True, exist_ok=True)
    stem = _logo_stem(ticker)
    for old_extension in LOGO_EXTENSIONS:
        old_path = LOGO_DIR / f"{stem}{old_extension}"
        if old_path.exists():
            old_path.unlink()

    destination = LOGO_DIR / f"{stem}{extension}"
    temp_destination = destination.with_suffix(f"{destination.suffix}.tmp")
    temp_destination.write_bytes(content)
    temp_destination.replace(destination)
    return destination


def fetch_ticker_logo(ticker: str, api_key: str, logo_format: str = "smallest") -> tuple[str, int | None, str | None, dict[str, object]] | None:
    """Downloads one ticker logo and returns its company metadata."""
    try:
        details = _ticker_details(ticker, api_key)
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
        logger.warning("Skipping ticker details for %s: %s", ticker, exc)
        return None

    metadata = _metadata_record(ticker, details)
    candidates: list[tuple[int, bytes, str]] = []
    for branding_url in _branding_urls(details):
        try:
            content, content_type = _request_image(_url_with_api_key(branding_url, api_key))
        except (HTTPError, URLError, TimeoutError, OSError) as exc:
            logger.warning("Skipping one logo variant for %s: %s", ticker, exc)
            continue

        extension = _extension_from_content_type(content_type, branding_url)
        if not _logo_matches_format(extension, logo_format):
            continue
        candidates.append((len(content), content, extension))

    if not candidates:
        return ticker, None, None, metadata

    size, content, extension = min(candidates, key=lambda item: item[0])
    path = _replace_logo(ticker, content, extension)
    return ticker, size, path.name, metadata


def _write_metadata_cache(records: list[dict[str, object]]) -> None:
    """Writes company metadata records to a reusable CSV cache."""
    if not records:
        logger.warning("No company metadata records available to cache.")
        return

    COMPANY_METADATA_CACHE.parent.mkdir(parents=True, exist_ok=True)
    frame = pd.DataFrame(records)
    frame = frame.dropna(subset=["symbol"]).drop_duplicates("symbol", keep="last")
    for column in METADATA_COLUMNS:
        if column not in frame.columns:
            frame[column] = None
    frame = frame[list(METADATA_COLUMNS)].sort_values("symbol")

    temp_path = COMPANY_METADATA_CACHE.with_suffix(f"{COMPANY_METADATA_CACHE.suffix}.tmp")
    frame.to_csv(temp_path, index=False)
    temp_path.replace(COMPANY_METADATA_CACHE)
    logger.info("Cached %d company metadata rows to %s.", len(frame), COMPANY_METADATA_CACHE)


def fetch_all_logos(logo_format: str = "smallest") -> int:
    """Fetches and refreshes local logo files for the full ticker universe."""
    api_key = _load_api_key()
    tickers = _ticker_universe()
    if not tickers:
        logger.warning("No tickers available for logo fetching.")
        return 0

    fetched_count = 0
    metadata_records: list[dict[str, object]] = []
    logger.info("Fetching %s logos for %d tickers.", logo_format, len(tickers))
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {executor.submit(fetch_ticker_logo, ticker, api_key, logo_format): ticker for ticker in tickers}
        for future in as_completed(futures):
            ticker = futures[future]
            try:
                result = future.result()
            except Exception as exc:
                logger.warning("Skipping logo for %s: %s", ticker, exc)
                continue
            if result is None:
                continue
            result_ticker, size, filename, metadata = result
            metadata_records.append(metadata)
            if filename is None or size is None:
                continue
            fetched_count += 1
            logger.info("Stored %s logo as %s (%d bytes).", result_ticker, filename, size)

    _write_metadata_cache(metadata_records)
    logger.info("Fetched %d/%d ticker logos.", fetched_count, len(tickers))
    return fetched_count


def _parse_args() -> argparse.Namespace:
    """Parses command-line options for local logo ingestion."""
    parser = argparse.ArgumentParser(description="Fetch Massive company logos into the local resources folder.")
    parser.add_argument(
        "--logo-format",
        choices=LOGO_FORMAT_CHOICES,
        default="smallest",
        help="Logo variant to keep: smallest available file, raster png/jpg/jpeg only, or svg only.",
    )
    return parser.parse_args()


def main() -> None:
    """Runs local logo ingestion from the command line."""
    configure_file_logging("core/resource_ingestion/logo_fetcher.log")
    args = _parse_args()
    fetch_all_logos(args.logo_format)


if __name__ == "__main__":
    main()
