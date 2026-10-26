"""Explicit standard-library JSON logging with an allowlisted record schema."""

import json
import logging
import re
import sys
from datetime import UTC, datetime

from sme_meeting_ai.core.config import Settings, get_settings

from .context import get_correlation_context

_EVENT = re.compile(r"[a-z0-9_.-]{1,128}")
_HANDLER_TAG = "_sme_meeting_ai_json_handler"
_EVENT_KEY = "_sme_meeting_ai_event"


def _valid_event(event: object) -> bool:
    return isinstance(event, str) and _EVENT.fullmatch(event) is not None


class _StructuredEvent:
    """Marker used only by the event helper, never arbitrary message text."""

    def __init__(self, name: str) -> None:
        self.name = name


class JsonFormatter(logging.Formatter):
    """Serialize fixed safe fields without formatting messages or exceptions."""

    def __init__(self, service_name: str) -> None:
        super().__init__()
        self.service_name = service_name

    def format(self, record: logging.LogRecord) -> str:
        structured = getattr(record, _EVENT_KEY, None)
        event = (
            structured.name
            if isinstance(structured, _StructuredEvent) and _valid_event(structured.name)
            else "unstructured"
        )
        # Resolve severity from the numeric level, not arbitrary record extras.
        severity = {
            logging.DEBUG: "DEBUG",
            logging.INFO: "INFO",
            logging.WARNING: "WARNING",
            logging.ERROR: "ERROR",
            logging.CRITICAL: "CRITICAL",
        }.get(record.levelno, "NOTSET")
        data = {
            "timestamp": datetime.fromtimestamp(record.created, UTC)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
            "severity": severity,
            "event": event,
            "service": self.service_name,
        }
        context = get_correlation_context()
        if context is not None:
            for field in (
                "trace_id", "span_id", "trace_flags", "parent_span_id",
                "request_id", "job_id",
            ):
                value = getattr(context, field)
                if value is not None:
                    data[field] = value
        return json.dumps(data, ensure_ascii=True, separators=(",", ":"))


def configure_logging(settings: Settings | None = None) -> None:
    """Configure only the package logger; replace only our tagged handlers."""
    if settings is None:
        settings = get_settings()
    logger = logging.getLogger("sme_meeting_ai")
    handler = logging.StreamHandler(sys.stdout)
    setattr(handler, _HANDLER_TAG, True)
    handler.setFormatter(JsonFormatter(settings.service_name))
    for existing in logger.handlers[:]:
        if getattr(existing, _HANDLER_TAG, False):
            logger.removeHandler(existing)
            existing.close()
    logger.addHandler(handler)
    logger.setLevel(settings.log_level)
    logger.propagate = False


def log_event(logger: logging.Logger, level: int, event: str) -> None:
    """Log a bounded stable event name, with no free-text payload API."""
    if not _valid_event(event):
        raise ValueError("Invalid event name")
    logger.log(level, "", extra={_EVENT_KEY: _StructuredEvent(event)})
