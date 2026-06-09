from pathlib import Path

from core.control.constants import PROJECT_ROOT


LOGO_DIR = PROJECT_ROOT / "core" / "resources" / "logos"
LOGO_EXTENSIONS = (".svg", ".png", ".jpg", ".jpeg")
LOGO_MEDIA_TYPES = {
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
}


def logo_filename_stem(symbol: str) -> str:
    """Returns the local logo filename stem for a ticker symbol."""
    canonical = str(symbol).strip().upper().replace("/", ".")
    safe_symbol = "".join(char if char.isalnum() or char in {".", "-"} else "_" for char in canonical)
    return f"{safe_symbol}_logo"


def local_logo_path(symbol: str) -> Path | None:
    """Returns the local logo path for a symbol when it exists."""
    stem = logo_filename_stem(symbol)
    for extension in LOGO_EXTENSIONS:
        path = LOGO_DIR / f"{stem}{extension}"
        if path.exists():
            return path
    return None


def local_logo_url(symbol: str) -> str:
    """Returns a public local logo URL when the cached file exists."""
    canonical = str(symbol).strip().upper().replace("/", ".")
    return f"/api/logos/{canonical}" if local_logo_path(canonical) is not None else ""


def get_local_logo(symbol: str) -> tuple[bytes, str]:
    """Returns local logo bytes and media type for a symbol."""
    path = local_logo_path(symbol)
    if path is None:
        raise FileNotFoundError(f"No local logo exists for {symbol}")
    return path.read_bytes(), LOGO_MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream")
