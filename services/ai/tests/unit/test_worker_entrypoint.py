"""Role-isolated worker selection is explicit and fail-closed."""

from __future__ import annotations

import pytest

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.workers import __main__ as entrypoint


def settings(role: str | None, identity: str):
    options = {}
    if role == "meeting-intelligence":
        options.update(
            meeting_intelligence_worker_enabled=True,
            meeting_intelligence_inference_enabled=True,
            meeting_intelligence_summary_enabled=True,
            meeting_intelligence_decision_enabled=True,
            meeting_intelligence_action_item_enabled=True,
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


def test_transcription_role_runs_optional_diarization_only_when_enabled(monkeypatch):
    selected = object()
    monkeypatch.setattr(entrypoint, "AiWorkerExecution", lambda _settings: selected)
    configured = settings("transcription", "ai-worker").model_copy(update={
        "diarization_worker_enabled": True,
    })
    assert entrypoint.build_execution(configured) is selected
    with pytest.raises(RuntimeError, match="capability gates"):
        entrypoint.build_execution(configured.model_copy(update={"meeting_intelligence_worker_enabled": True}))


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


@pytest.mark.parametrize(
    "missing_gate",
    [
        "meeting_intelligence_worker_enabled",
        "meeting_intelligence_inference_enabled",
        "meeting_intelligence_summary_enabled",
        "meeting_intelligence_decision_enabled",
        "meeting_intelligence_action_item_enabled",
    ],
)
def test_meeting_intelligence_requires_all_capability_gates(missing_gate):
    options = {
        "meeting_intelligence_worker_enabled": True,
        "meeting_intelligence_inference_enabled": True,
        "meeting_intelligence_summary_enabled": True,
        "meeting_intelligence_decision_enabled": True,
        "meeting_intelligence_action_item_enabled": True,
    }
    options[missing_gate] = False
    selected = Settings(
        service_name="test-worker",
        service_identity="mi-worker",
        worker_role="meeting-intelligence",
        _env_file=None,
        **options,
    )

    with pytest.raises(RuntimeError, match="capability gate"):
        entrypoint.build_execution(selected)


def test_unscoped_unit_composition_retains_legacy_selection(monkeypatch):
    selected = object()
    monkeypatch.setattr(entrypoint, "AiWorkerExecution", lambda _settings: selected)

    assert entrypoint.build_execution(settings(None, "ai-worker")) is selected
