import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path

from core.control.constants import LOGS_ROOT

LOG_FORMAT = "%(asctime)s %(levelname)s [%(name)s] %(message)s"
DATE_FORMAT = "%Y-%m-%d %H:%M:%S"


def configure_file_logging(
    relative_log_path: str | Path,
    level: int = logging.INFO,
    include_console: bool = False,
) -> Path:
    log_path = LOGS_ROOT / relative_log_path
    log_path.parent.mkdir(parents=True, exist_ok=True)

    root_logger = logging.getLogger()
    root_logger.setLevel(level)

    def remove_console_handlers() -> None:
        for handler in list(root_logger.handlers):
            if isinstance(handler, logging.StreamHandler) and not isinstance(handler, logging.FileHandler):
                root_logger.removeHandler(handler)
                handler.close()

    if not include_console:
        remove_console_handlers()

    resolved_log_path = log_path.resolve()
    for handler in root_logger.handlers:
        if isinstance(handler, RotatingFileHandler) and Path(handler.baseFilename).resolve() == resolved_log_path:
            return log_path

    formatter = logging.Formatter(LOG_FORMAT, datefmt=DATE_FORMAT)

    for handler in list(root_logger.handlers):
        if not isinstance(handler, RotatingFileHandler):
            continue
        try:
            handler_path = Path(handler.baseFilename).resolve()
            handler_path.relative_to(LOGS_ROOT.resolve())
        except ValueError:
            continue
        root_logger.removeHandler(handler)
        handler.close()

    file_handler = RotatingFileHandler(log_path, maxBytes=10 * 1024 * 1024, backupCount=5)
    file_handler.setLevel(level)
    file_handler.setFormatter(formatter)
    root_logger.addHandler(file_handler)

    if include_console:
        remove_console_handlers()
        console_handler = logging.StreamHandler()
        console_handler.setLevel(level)
        console_handler.setFormatter(formatter)
        root_logger.addHandler(console_handler)

    return log_path
