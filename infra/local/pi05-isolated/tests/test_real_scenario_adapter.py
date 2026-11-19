"""Offline tests for the explicit real-service L02-L10 adapter."""

from __future__ import annotations

import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[2] / "services/ai/tests"))

from observation_receipts import Observation, ReceiptWriter  # noqa: E402
from pi05_live_contract import REQUIRED  # noqa: E402
from real_scenario_adapter import (  # noqa: E402
    L02_L10_SCENARIOS,
    RealScenarioAdapter,
    RealScenarioOperations,
    ScenarioFixtureError,
    ScenarioFixtureSet,
    ScenarioHandle,
    ScenarioUnavailable,
)
from scenario_orchestrator import OrchestrationContext  # noqa: E402


def context(tmp_path: Path) -> OrchestrationContext:
    run_id = str(uuid4())
    proofs = tmp_path / "proofs"
    sources = tmp_path / "sources"
    proofs.mkdir(mode=0o700)
    sources.mkdir(mode=0o700)
    commit = "a" * 40
    generation = "generation-" + run_id
    collection = "collection-" + run_id
    return OrchestrationContext(
        run_id=run_id,
        commit=commit,
        generation=generation,
        collection=collection,
        environment={
            "disposable": True,
            "coreBuild": commit,
            "aiBuild": commit,
            "tlsMode": "MTLS",
            "generationId": generation,
            "collectionName": collection,
        },
        proof_dir=proofs,
        source_dir=sources,
    )


def _fixture_payload(run_id: str) -> dict:
    value = str(uuid4())
    payload = {
        "runId": run_id,
        "fixtures": {
            scenario: {
                "meetingId": value,
                "sourceId": str(uuid4()),
            }
            for scenario in L02_L10_SCENARIOS
        },
    }
    payload["fixtures"]["generation-rollback"].update({
        "incompleteCandidateGenerationId": f"incomplete-{run_id}",
        "cleanCandidateGenerationId": f"clean-{run_id}",
        "oldGenerationId": f"old-{run_id}",
    })
    return payload


def test_fixture_set_requires_exact_scenario_fixture_file(tmp_path):
    run_id = str(uuid4())
    path = tmp_path / "fixtures.json"
    path.write_text(json.dumps(_fixture_payload(run_id)), encoding="utf-8")
    path.chmod(0o600)

    fixtures = ScenarioFixtureSet.load(path, run_id)

    assert fixtures.run_id == run_id
    assert set(fixtures.scenarios) == set(L02_L10_SCENARIOS)
    assert fixtures.for_scenario("room-notification")["meetingId"]

    path.write_text(json.dumps({"runId": run_id, "fixtures": {}}), encoding="utf-8")
    path.chmod(0o600)
    with pytest.raises(ScenarioFixtureError):
        ScenarioFixtureSet.load(path, run_id)


@pytest.mark.parametrize(
    "payload",
    [
        {"runId": str(uuid4()), "fixtures": {"full-pipeline": {}}},
        {"runId": str(uuid4()), "fixtures": {scenario: {} for scenario in L02_L10_SCENARIOS}},
    ],
)
def test_fixture_set_rejects_wrong_scope_or_missing_fields(tmp_path, payload):
    path = tmp_path / "fixtures.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    path.chmod(0o600)

    with pytest.raises(ScenarioFixtureError):
        ScenarioFixtureSet.load(path, str(uuid4()))


def test_fixture_set_rejects_protected_values_and_symbolic_paths(tmp_path):
    run_id = str(uuid4())
    payload = _fixture_payload(run_id)
    payload["fixtures"]["revision-retrieval"]["transcriptText"] = "must not persist"
    path = tmp_path / "fixtures.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    path.chmod(0o600)

    with pytest.raises(ScenarioFixtureError):
        ScenarioFixtureSet.load(path, run_id)


@pytest.mark.parametrize(
    "field,value",
    [
        ("incompleteCandidateGenerationId", "clean-{run_id}"),
        ("cleanCandidateGenerationId", "foreign-generation"),
        ("oldGenerationId", "/old-{run_id}"),
    ],
)
def test_fixture_set_requires_distinct_run_scoped_generation_identities(
    tmp_path, field, value,
):
    run_id = str(uuid4())
    payload = _fixture_payload(run_id)
    payload["fixtures"]["generation-rollback"][field] = value.format(run_id=run_id)
    if field == "incompleteCandidateGenerationId":
        payload["fixtures"]["generation-rollback"]["cleanCandidateGenerationId"] = (
            f"clean-{run_id}"
        )
    path = tmp_path / "fixtures.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    path.chmod(0o600)

    with pytest.raises(ScenarioFixtureError):
        ScenarioFixtureSet.load(path, run_id)


def _operation(context_value, scenario, fixture=None):
    operation = RealScenarioOperations.__new__(RealScenarioOperations)
    operation.context = context_value
    operation.scenario = scenario
    operation.fixture = fixture or {"meetingId": str(uuid4()), "sourceId": str(uuid4())}
    operation._state = {}
    return operation


class _FakeMemberCore:
    def __init__(self, member_id: str, access_statuses=(200, 403)):
        self.member_id = member_id
        self.access_statuses = list(access_statuses)
        self.calls = []

    def request(self, method, path, **kwargs):
        self.calls.append(("request", method, path, kwargs))
        if path == "/api/v1/auth/me":
            return {"userId": self.member_id}, {}
        raise AssertionError(f"unexpected member request: {method} {path}")

    def request_status(self, method, path, **kwargs):
        self.calls.append(("status", method, path, kwargs))
        if path.endswith("/access-url"):
            status = self.access_statuses.pop(0)
            if status == 200:
                return status, {
                    "success": True,
                    "data": {"exportId": kwargs.get("exportId", str(uuid4()))},
                }, {}
            return status, {"success": False, "errorCode": "MEETING_ACCESS_DENIED"}, {}
        raise AssertionError(f"unexpected member status request: {method} {path}")

    def close(self):
        return None


class _FakeObserverCore:
    def __init__(self, payloads):
        self.payloads = payloads
        self.calls = []

    def request_json(self, request_id, path):
        self.calls.append((request_id, path))
        return self.payloads[path]

    def write_checked(self, observation, *, operation, path, predicate):
        payload = self.request_json(str(uuid4()), path)
        fields = predicate(payload)
        assert fields
        return "a" * 64


def _observation(context_value, step, component, result):
    return Observation(
        run_id=context_value.run_id,
        request_id=str(uuid4()),
        step=step,
        component=component,
        observed_result=result,
        observed_at=datetime.now(UTC),
    )


def test_l03_requires_an_active_fixture_member_and_matching_member_identity(
    tmp_path, monkeypatch,
):
    context_value = context(tmp_path)
    member_id = str(uuid4())
    organizer_id = str(uuid4())
    operation = _operation(
        context_value,
        "membership-revocation",
        {"meetingId": str(uuid4()), "sourceId": str(uuid4()), "memberId": member_id},
    )
    operation.settings = SimpleNamespace(
        revoked_member_core=_FakeMemberCore(member_id),
    )
    participants = [
        {"userId": organizer_id, "removedAt": None},
        {"userId": member_id, "removedAt": None},
    ]
    monkeypatch.setattr(
        operation,
        "_core_data",
        lambda method, path, **kwargs: (
            (participants, {})
            if path.endswith("/participants")
            else ({"organizerUserId": organizer_id}, {})
        ),
    )

    assert operation._select_revocable_member(operation.fixture["meetingId"]) == member_id

    participants[1]["removedAt"] = "2026-11-18T00:00:00Z"
    with pytest.raises(ScenarioUnavailable):
        operation._select_revocable_member(operation.fixture["meetingId"])


def test_l03_revocation_observer_treats_removed_rows_as_inactive(tmp_path):
    context_value = context(tmp_path)
    member_id = str(uuid4())
    meeting_id = str(uuid4())
    conversation_id = str(uuid4())
    operation = _operation(
        context_value,
        "membership-revocation",
        {"meetingId": meeting_id, "sourceId": str(uuid4()), "memberId": member_id},
    )
    operation._state.update({
        "meetingId": meeting_id,
        "memberId": member_id,
        "conversationId": conversation_id,
    })
    operation.settings = SimpleNamespace(
        l01=SimpleNamespace(
            observer_core=_FakeObserverCore({
                f"/api/v1/meetings/{meeting_id}/participants": {
                    "success": True,
                    "data": [
                        {"userId": member_id, "removedAt": "2026-11-18T00:00:00Z"},
                    ],
                },
            }),
        ),
    )

    digest = operation._observe_membership_revocation(
        "revoked-during-generation",
        _observation(context_value, "revoked-during-generation", "CORE", "REVOKED"),
    )

    assert len(digest) == 64


def test_l09_revocation_uses_revoked_member_identity_for_access_denial(
    tmp_path, monkeypatch,
):
    context_value = context(tmp_path)
    member_id = str(uuid4())
    meeting_id = str(uuid4())
    export_id = str(uuid4())
    operation = _operation(
        context_value,
        "export-revocation",
        {"meetingId": meeting_id, "sourceId": str(uuid4()), "memberId": member_id},
    )
    member = _FakeMemberCore(member_id)
    operation.settings = SimpleNamespace(revoked_member_core=member)
    operation._state.update({"meetingId": meeting_id, "exportId": export_id})
    monkeypatch.setattr(
        operation,
        "_core_data",
        lambda method, path, **kwargs: (
            ([{"userId": member_id, "removedAt": None}], {})
            if path.endswith("/participants")
            else ({"organizerUserId": str(uuid4())}, {"ETag": '"meeting-v1"'})
        ),
    )
    monkeypatch.setattr(
        operation,
        "_core_status",
        lambda method, path, **kwargs: (
            (204, {"success": True, "data": {}}, {})
            if method == "DELETE"
            else (_ for _ in ()).throw(AssertionError("organizer must not probe member access"))
        ),
    )

    handle = operation._action_export_revocation(
        "revoke-download-access", str(uuid4()),
    )

    assert handle.values["denied"] is True
    assert [call[2] for call in member.calls if call[0] == "status"] == [
        f"/api/v1/exports/{export_id}/access-url",
        f"/api/v1/exports/{export_id}/access-url",
    ]


def test_l08_observes_only_the_requested_rollback_generation(tmp_path, monkeypatch):
    context_value = context(tmp_path)
    old_generation = f"old-{context_value.run_id}"
    operation = _operation(
        context_value,
        "generation-rollback",
        {
            "meetingId": str(uuid4()),
            "sourceId": str(uuid4()),
            "incompleteCandidateGenerationId": f"incomplete-{context_value.run_id}",
            "cleanCandidateGenerationId": f"clean-{context_value.run_id}",
            "oldGenerationId": old_generation,
        },
    )
    operation._state["cleanGenerationId"] = operation.fixture["cleanCandidateGenerationId"]

    def core_status(method, path, **kwargs):
        return (
            200,
            {"success": True, "data": {"generationId": "foreign-generation", "state": "ACTIVE"}},
            {},
        )

    monkeypatch.setattr(operation, "_core_status", core_status)

    with pytest.raises(ScenarioUnavailable):
        operation._action_generation_rollback("old-generation-rollback", str(uuid4()))


def test_l06_core_failure_observer_does_not_reuse_action_client(tmp_path):
    context_value = context(tmp_path)
    reconciliation_id = str(uuid4())
    operation = _operation(context_value, "qdrant-outage")
    operation.writer = ReceiptWriter(context_value.proof_dir, context_value.source_dir)
    operation._state["reconciliationRunId"] = reconciliation_id
    operation.settings = SimpleNamespace(
        l01=SimpleNamespace(
            action_core=object(),
            observer_core=_FakeObserverCore({
                f"/api/v1/admin/knowledge/reconciliation/{reconciliation_id}": {
                    "success": True,
                    "data": {
                        "generationId": context_value.generation,
                        "state": "FAILED",
                        "lastErrorCode": "VECTOR_AUDIT_UNAVAILABLE",
                    },
                },
            }),
        ),
    )

    digest = operation._observe_qdrant_outage(
        "core-failed-closed",
        _observation(context_value, "core-failed-closed", "CORE", "FAILED"),
    )

    assert len(digest) == 64


def test_l10_cancellation_observer_uses_core_observer_request_contract(tmp_path):
    context_value = context(tmp_path)
    room_id = str(uuid4())
    accepted = str(uuid4())
    replacement = str(uuid4())
    operation = _operation(
        context_value,
        "room-notification",
        {"meetingId": str(uuid4()), "sourceId": str(uuid4()), "roomId": room_id},
    )
    operation.writer = ReceiptWriter(context_value.proof_dir, context_value.source_dir)
    operation._state.update({
        "roomId": room_id,
        "acceptedMeetingId": accepted,
        "replacementMeetingId": replacement,
    })
    operation.settings = SimpleNamespace(
        l01=SimpleNamespace(
            observer_core=_FakeObserverCore({
                f"/api/v1/meetings/{accepted}": {
                    "success": True,
                    "data": {"status": "CANCELLED", "roomId": room_id},
                },
                f"/api/v1/meetings/{replacement}": {
                    "success": True,
                    "data": {"status": "SCHEDULED", "roomId": room_id},
                },
            }),
        ),
    )

    digest = operation._observe_room_notification(
        "cancellation-released-room",
        _observation(
            context_value, "cancellation-released-room", "CORE", "RELEASED",
        ),
    )

    assert len(digest) == 64


def test_l06_resume_uses_the_failed_reconciliation_run(tmp_path, monkeypatch):
    context_value = context(tmp_path)
    run_id = str(uuid4())
    operation = _operation(context_value, "qdrant-outage")
    operation.settings = SimpleNamespace(timeout_seconds=60, poll_interval_seconds=0.01)
    operation._state["reconciliationRunId"] = run_id
    calls = []

    class Fault:
        def start(self, service):
            calls.append(("start", service))

    monkeypatch.setattr(operation, "_fault", lambda service: Fault())
    monkeypatch.setattr(
        operation,
        "_wait_for_container_state",
        lambda service, expected: calls.append(("wait", service, expected)),
    )

    def core_status(method, path, **kwargs):
        calls.append((method, path, kwargs))
        return (
            200,
            {
                "success": True,
                "data": {
                    "id": run_id,
                    "state": "COMPLETED",
                    "inventoryComplete": True,
                },
            },
            {},
        )

    monkeypatch.setattr(operation, "_core_status", core_status)

    handle = operation._action_qdrant_outage("reconciliation-resumed", str(uuid4()))

    assert handle.values["reconciliationRunId"] == run_id
    assert ("start", "qdrant") in calls
    assert ("wait", "qdrant", "running") in calls
    assert any(
        item[0] == "POST"
        and item[1] == f"/api/v1/admin/knowledge/reconciliation/{run_id}/resume"
        for item in calls
        if isinstance(item, tuple) and len(item) == 3
    )
    assert not any(
        item[0] == "POST"
        and item[1] == "/api/v1/admin/knowledge/reconciliation"
        for item in calls
        if isinstance(item, tuple) and len(item) == 3
    )


def test_l07_uses_reconciliation_counts_and_protects_manual_review(tmp_path, monkeypatch):
    context_value = context(tmp_path)
    operation = _operation(context_value, "inventory-coverage")
    run_id = str(uuid4())
    monkeypatch.setattr(
        operation,
        "_start_reconciliation",
        lambda request_id: (
            run_id,
            {
                "generationId": context_value.generation,
                "state": "RUNNING",
                "findingCount": 2,
            },
        ),
    )
    missing = operation._action_inventory_coverage("missing-work-reported", str(uuid4()))
    assert missing.values["missingWork"] is True
    assert missing.values["reconciliationRunId"] == run_id

    monkeypatch.setattr(
        operation,
        "_reconciliation",
        lambda current_run_id, request_id: {
            "generationId": context_value.generation,
            "state": "COMPLETED",
            "inventoryComplete": True,
            "findingCount": 2,
            "repairedCount": 0,
            "vectorScannedCount": 3,
            "findingCodes": ["not used by the adapter"],
        },
    )
    orphan = operation._action_inventory_coverage("orphan-point-reported", str(uuid4()))
    protected = operation._action_inventory_coverage(
        "unsafe-auto-delete-prevented", str(uuid4()),
    )

    assert orphan.values["orphanedPoints"] is True
    assert protected.values["manualReview"] is True
    assert operation._state["vectorScannedCount"] == 3


def test_l08_actions_use_three_distinct_generation_fixtures(tmp_path, monkeypatch):
    context_value = context(tmp_path)
    run_id = context_value.run_id
    fixture = {
        "meetingId": str(uuid4()),
        "sourceId": str(uuid4()),
        "incompleteCandidateGenerationId": f"incomplete-{run_id}",
        "cleanCandidateGenerationId": f"clean-{run_id}",
        "oldGenerationId": f"old-{run_id}",
    }
    operation = _operation(context_value, "generation-rollback", fixture)
    calls = []

    def core_status(method, path, **kwargs):
        calls.append((method, path))
        if "incomplete-" in path:
            return 409, {"success": False, "errorCode": "GENERATION_NOT_READY"}, {}
        generation = path.rsplit("/", 2)[-2]
        return (
            200,
            {
                "success": True,
                "data": {"generationId": generation, "state": "ACTIVE"},
            },
            {},
        )

    monkeypatch.setattr(operation, "_core_status", core_status)

    rejected = operation._action_generation_rollback(
        "incomplete-candidate-rejected", str(uuid4()),
    )
    activated = operation._action_generation_rollback(
        "clean-candidate-activated", str(uuid4()),
    )
    rollback = operation._action_generation_rollback(
        "old-generation-rollback", str(uuid4()),
    )

    assert rejected.values["generationId"] == fixture["incompleteCandidateGenerationId"]
    assert activated.values["generationId"] == fixture["cleanCandidateGenerationId"]
    assert rollback.values["generationId"] == fixture["oldGenerationId"]
    assert [path.rsplit("/", 2)[-2] for _method, path in calls] == [
        fixture["incompleteCandidateGenerationId"],
        fixture["cleanCandidateGenerationId"],
        fixture["oldGenerationId"],
    ]


def test_l10_contract_uses_authoritative_cancellation_step_name(tmp_path):
    context_value = context(tmp_path)
    operation = _operation(context_value, "room-notification")
    handlers = RealScenarioAdapter(
        context_value, "room-notification", operation,
    ).step_handlers()

    assert "cancellation-released-room" in handlers
    assert "cancellation-released" not in handlers


class FakeOperations:
    def __init__(self, context_value: OrchestrationContext):
        self.context = context_value
        self.calls: list[tuple[str, str]] = []
        self.writer = ReceiptWriter(context_value.proof_dir, context_value.source_dir)

    def action(self, step, _context, request_id):
        self.calls.append(("action", step))
        return ScenarioHandle(step, request_id, {"stepOrdinal": len(self.calls)})

    def observe(self, step, _context, execution, requirement):
        self.calls.append(("observe", step))
        return self.writer.write(
            Observation(
                run_id=self.context.run_id,
                request_id=execution.request_id,
                step=step,
                component=requirement[0],
                observed_result=requirement[1],
                observed_at=datetime.now(UTC),
            ),
            {"boundary": requirement[0], "operation": step},
        )


def test_adapter_runs_every_l02_l10_action_then_independent_observer(tmp_path):
    context_value = context(tmp_path)
    scenario = "room-notification"
    operations = FakeOperations(context_value)
    adapter = RealScenarioAdapter(context_value, scenario, operations)
    handlers = adapter.step_handlers()

    for step, requirement in REQUIRED[scenario].items():
        execution = handlers[step].action(context_value)
        assert handlers[step].observer(context_value, execution, requirement)

    assert operations.calls == [
        item
        for step in REQUIRED[scenario]
        for item in (("action", step), ("observe", step))
    ]


def test_adapter_rejects_cross_run_context_and_repeated_actions(tmp_path):
    context_value = context(tmp_path)
    operations = FakeOperations(context_value)
    adapter = RealScenarioAdapter(context_value, "qdrant-outage", operations)
    handler = adapter.step_handlers()["qdrant-outage-observed"]

    with pytest.raises(Exception):
        handler.action(context(tmp_path / "foreign"))

    first = handler.action(context_value)
    assert first.request_id
    with pytest.raises(Exception):
        handler.action(context_value)


def test_scenario_handle_never_accepts_unsanitized_execution_values():
    with pytest.raises(ScenarioFixtureError):
        ScenarioHandle(
            "missing-work-reported",
            str(uuid4()),
            {"rawContent": "no"},
        )
