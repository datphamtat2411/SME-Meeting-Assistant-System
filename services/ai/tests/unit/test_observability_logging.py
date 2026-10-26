import importlib
import io
import json
import logging
from datetime import datetime, timedelta

import pytest

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.observability import (
    JsonFormatter,
    configure_logging,
    correlation_scope,
    log_event,
    new_correlation_context,
)


@pytest.fixture(autouse=True)
def restore_package_logger():
    logger = logging.getLogger("sme_meeting_ai")
    handlers, level, propagate = logger.handlers[:], logger.level, logger.propagate
    logger.handlers = []
    yield
    for handler in logger.handlers:
        if handler not in handlers:
            handler.close()
    logger.handlers = handlers
    logger.setLevel(level)
    logger.propagate = propagate


def settings(**kwargs):
    return Settings(_env_file=None, service_name="test-ai", **kwargs)


def test_structured_output_has_fixed_fields_utc_timestamp_and_current_context(capsys):
    configure_logging(settings())
    logger = logging.getLogger("sme_meeting_ai.processing")
    context = new_correlation_context(
        traceparent="00-1234567890abcdef1234567890abcdef-1234567890abcdef-01",
        request_id="request-1", job_id="job-2",
    )
    with correlation_scope(context):
        log_event(logger, logging.WARNING, "processing.started")
    data = json.loads(capsys.readouterr().out)
    assert data.keys() == {
        "timestamp", "severity", "event", "service", "trace_id", "span_id",
        "trace_flags", "parent_span_id", "request_id", "job_id",
    }
    assert data["severity"] == "WARNING"
    assert data["event"] == "processing.started"
    assert data["service"] == "test-ai"
    for field in ("trace_id", "span_id", "trace_flags", "parent_span_id", "request_id", "job_id"):
        assert data[field] == getattr(context, field)
    assert data["timestamp"].endswith("Z")
    assert datetime.fromisoformat(data["timestamp"]).utcoffset() == timedelta(0)


def test_no_context_and_no_optional_ids_are_valid(capsys):
    configure_logging(settings())
    logger = logging.getLogger("sme_meeting_ai")
    log_event(logger, logging.INFO, "runtime.ready")
    with correlation_scope(new_correlation_context()):
        log_event(logger, logging.INFO, "runtime.ready")
    first, second = map(json.loads, capsys.readouterr().out.splitlines())
    assert first.keys() == {"timestamp", "severity", "event", "service"}
    assert second.keys() == first.keys() | {"trace_id", "span_id", "trace_flags"}


def test_repeated_configuration_emits_once_updates_settings_and_preserves_other_handlers(capsys):
    logger = logging.getLogger("sme_meeting_ai")
    unrelated = logging.NullHandler()
    logger.addHandler(unrelated)
    root = logging.getLogger()
    root_state = (root.handlers[:], root.level)
    for _ in range(3):
        configure_logging(settings(log_level="ERROR"))
    assert unrelated in logger.handlers
    assert len(logger.handlers) == 2
    assert logger.level == logging.ERROR
    assert logger.propagate is False
    log_event(logger, logging.WARNING, "ignored.event")
    configure_logging(Settings(_env_file=None, service_name="worker-ai", log_level="DEBUG"))
    log_event(logger, logging.DEBUG, "worker.ready")
    lines = capsys.readouterr().out.splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0])["service"] == "worker-ai"
    assert (root.handlers, root.level) == root_state


def test_default_configuration_reuses_get_settings(monkeypatch, capsys):
    module = importlib.import_module("sme_meeting_ai.observability.logging")
    monkeypatch.setattr(module, "get_settings", lambda: settings(log_level="DEBUG"))
    configure_logging()
    log_event(logging.getLogger("sme_meeting_ai"), logging.DEBUG, "settings.loaded")
    assert json.loads(capsys.readouterr().out)["service"] == "test-ai"


def test_reloading_package_does_not_initialize_logging():
    package = importlib.import_module("sme_meeting_ai.observability")
    logger = logging.getLogger("sme_meeting_ai")
    before = (logger.handlers[:], logger.level, logger.propagate)
    importlib.reload(package)
    assert (logger.handlers, logger.level, logger.propagate) == before


@pytest.mark.parametrize("event", [
    "", "Uppercase", "x" * 129, "meeting secret\nforged", "user@example.com",
    "https://signed?token=secret", "%s", {"transcript": "secret"},
])
def test_invalid_event_is_rejected_without_emitting_sensitive_value(event, capsys):
    configure_logging(settings())
    with pytest.raises(ValueError) as caught:
        log_event(logging.getLogger("sme_meeting_ai"), logging.INFO, event)
    assert str(caught.value) == "Invalid event name"
    assert capsys.readouterr().out == ""


def test_unstructured_messages_exceptions_extras_and_payloads_are_never_serialized(capsys):
    configure_logging(settings())
    logger = logging.getLogger("sme_meeting_ai.provider")
    secrets = [
        "Bearer private-token", "https://storage/audio?signature=private",
        "private transcript", "private prompt", "private provider payload",
        "person@example.com",
    ]
    try:
        raise ValueError("\n".join(secrets))
    except ValueError:
        logger.exception("\n".join(secrets), extra={
            "transcript": secrets, "event": "forged.event", "service": secrets,
        }, stack_info=True)
    # Formatting must not invoke arbitrary message/argument serialization.
    class UnsafeMessage:
        def __str__(self):
            raise AssertionError("raw message was formatted")

    logger.warning(UnsafeMessage())
    output = capsys.readouterr().out
    assert all(secret not in output for secret in secrets)
    lines = output.splitlines()
    assert len(lines) == 2
    for line in lines:
        data = json.loads(line)
        assert data["event"] == "unstructured"
        assert data.keys() == {"timestamp", "severity", "event", "service"}


def test_json_encoding_prevents_newline_injection_and_context_is_read_at_format_time():
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter('ai\n"forged"'))
    record = logging.LogRecord("sme_meeting_ai", logging.INFO, "", 0, "secret", (), None)
    context = new_correlation_context()
    with correlation_scope(context):
        handler.handle(record)
    assert len(stream.getvalue().splitlines()) == 1
    data = json.loads(stream.getvalue())
    assert data["service"] == 'ai\n"forged"'
    assert data["trace_id"] == context.trace_id
