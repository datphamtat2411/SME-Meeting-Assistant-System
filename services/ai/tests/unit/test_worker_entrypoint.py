"""Role-isolated worker selection is explicit and fail-closed."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.workers import __main__ as entrypoint


def settings(role: str | None, identity: str):
    options = {}
    if role == "meeting-intelligence":
        options.update(
            meeting_intelligence_worker_enabled=True,
            meeting_intelligence_inference_enabled=True,
            meeting_intelligence_decision_enabled=True,
        )
    elif role == "knowledge-indexing":
        options.update(knowledge_indexing_worker_enabled=True)
    elif role is None:
        options.update(meeting_intelligence_worker_enabled=True)
    return Settings(
        service_name="test-worker",
        service_identity=identity,
        worker_role=role,
        _env_file=None,
        **options,
    )


@pytest.mark.parametrize(
    ("role", "identity", "attribute"),
    [
        ("transcription", "ai-worker", "TranscriptionExecution"),
        ("meeting-intelligence", "mi-worker", "IntelligenceExecution"),
        ("knowledge-indexing", "knowledge-worker", "KnowledgeIndexingExecution"),
    ],
)
def test_isolated_role_selects_only_its_capability(monkeypatch, role, identity, attribute):
    selected = object()
    monkeypatch.setattr(entrypoint, attribute, lambda _settings: selected)

    assert entrypoint.build_execution(settings(role, identity)) is selected


@pytest.mark.parametrize(
    ("role", "identity"),
    [
        ("transcription", "mi-worker"),
        ("meeting-intelligence", "ai-worker"),
        ("knowledge-indexing", "ai-worker"),
    ],
)
def test_isolated_role_rejects_a_reused_service_identity(role, identity):
    with pytest.raises(RuntimeError, match="worker identity"):
        entrypoint.build_execution(settings(role, identity))


def test_unscoped_unit_composition_retains_legacy_selection(monkeypatch):
    selected = object()
    monkeypatch.setattr(entrypoint, "AiWorkerExecution", lambda _settings: selected)

    assert entrypoint.build_execution(settings(None, "ai-worker")) is selected
