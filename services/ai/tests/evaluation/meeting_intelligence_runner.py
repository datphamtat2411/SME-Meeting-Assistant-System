"""Controlled T07 execution and report orchestration.

The runner calls the production processors with an injected adapter. It does
not invoke the worker, broker, Core API, object storage, or a provider unless
the separately authorized live entry point is used.
"""

from __future__ import annotations

import json
import os
import re
import time
from datetime import date
from enum import StrEnum
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID

import httpx
from pydantic import SecretStr

from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.meeting_intelligence.action_items import build_action_item_processor
from sme_meeting_ai.meeting_intelligence.decision import build_decision_processor
from sme_meeting_ai.meeting_intelligence.errors import IntelligenceError
from sme_meeting_ai.meeting_intelligence.processor import StageContext
from sme_meeting_ai.meeting_intelligence.summary import build_summary_processor

from .meeting_intelligence_support import (
    EVALUATION_VERSION,
    FEATURES,
    EvaluationError,
    GatePolicy,
    MeetingDataset,
    build_evaluation_report,
    decision_metrics,
    score_action_items,
    score_summary,
    validate_processor_candidate,
    write_evaluation_report,
    write_evaluation_summary,
)
from .support import _unique_keys, require


class EvaluationMode(StrEnum):
    DETERMINISTIC_OFFLINE = "deterministic-offline"
    OFFLINE_CAPTURED_REAL = "offline-captured-real"
    APPROVED_LIVE = "approved-live"


_UNSPECIFIED = object()


class ProviderAttemptCapture(httpx.AsyncBaseTransport):
    """Safe one-shot transport telemetry; never retains request/response bodies."""

    def __init__(self):
        self._inner = httpx.AsyncHTTPTransport(trust_env=False)
        self.request_count = 0
        self.response_statuses = []
        self.transport_error_count = 0
        self._closed = False

    async def handle_async_request(self, request):
        self.request_count += 1
        try:
            response = await self._inner.handle_async_request(request)
        except Exception:
            self.transport_error_count += 1
            raise
        self.response_statuses.append(response.status_code)
        return response

    async def aclose(self):
        if not self._closed:
            self._closed = True
            await self._inner.aclose()


class _TelemetryAdapter:
    def __init__(self, adapter, *, provider_metadata=None):
        self.adapter = adapter
        self.provider_metadata = provider_metadata
        self.calls = []

    def complete(self, request):
        started = time.monotonic_ns()
        result = None
        failure = None
        try:
            result = self.adapter.complete(request)
            return result
        except IntelligenceError as error:
            failure = error.category
            raise
        except Exception:
            failure = "ADAPTER_FAILURE"
            raise IntelligenceError("PROVIDER") from None
        finally:
            usage = getattr(result, "usage", None)
            duration = time.monotonic_ns() - started
            schema_failure_categories = {
                "MALFORMED_OUTPUT", "SCHEMA_MISMATCH", "INCOMPLETE_OUTPUT",
                "REFUSAL", "UNSUPPORTED_SCHEMA",
            }
            self.calls.append({
                "call_index": len(self.calls),
                "duration_ns": duration,
                "failure_category": failure,
                "schema_validation": (
                    "PASS" if result is not None else
                    "FAIL" if failure in schema_failure_categories else
                    "NOT_REACHED"
                ),
                "requested_model": getattr(result, "requested_model", request.model) if result else request.model,
                "reported_model": getattr(result, "reported_model", None) if result else None,
                "provider": getattr(result, "provider", None) if result else None,
                "reported_provider": getattr(result, "reported_provider", None) if result else None,
                "input_tokens": getattr(usage, "input_tokens", None) if usage else None,
                "output_tokens": getattr(usage, "output_tokens", None) if usage else None,
                "total_tokens": getattr(usage, "total_tokens", None) if usage else None,
                "reasoning_tokens": getattr(usage, "reasoning_tokens", None) if usage else None,
                "reported_cost": _fraction(getattr(usage, "reported_cost", None)) if usage else None,
                "configuration_sha256": getattr(result, "configuration_sha256", None) if result else None,
                "planning_version": getattr(result, "planning_version", None) if result else None,
                "task_sha256": getattr(result, "task_sha256", None) if result else None,
                "prompt_version": getattr(result, "prompt_version", None) if result else None,
                "schema_version": getattr(result, "schema_version", None) if result else None,
                "reasoning_effort": getattr(result, "reasoning_effort", request.reasoning_effort)
                if result else request.reasoning_effort,
                "estimated_input_tokens": getattr(result, "estimated_input_tokens", None) if result else None,
                "reserved_tokens": request.window.estimated_input_tokens + request.output_budget,
                "attempts": getattr(result, "attempts", None) if result else None,
              })

    def report(self):
        costs = [call["reported_cost"] for call in self.calls if call["reported_cost"] is not None]
        statuses = getattr(self.provider_metadata, "response_statuses", None)
        request_count = getattr(self.provider_metadata, "request_count", None)
        transport_errors = getattr(self.provider_metadata, "transport_error_count", None)
        if not isinstance(statuses, list):
            statuses = None
        elif not all(type(status) is int and 100 <= status <= 599 for status in statuses):
            statuses = None
        if type(request_count) is not int or request_count < 0:
            request_count = None
        if type(transport_errors) is not int or transport_errors < 0:
            transport_errors = None
        return {
            "call_count": len(self.calls),
            "calls": sorted(self.calls, key=lambda call: call["call_index"]),
            "reported_cost_call_count": len(costs),
            "reported_cost_subtotal": _sum_fraction(costs),
            "cost": _sum_fraction(costs) if costs and len(costs) == len(self.calls) else None,
            "provider_duration_ns": sum(call["duration_ns"] for call in self.calls),
            "provider_request_count": request_count,
            "provider_response_statuses": statuses,
            "provider_transport_error_count": transport_errors,
        }


def _fraction(value):
    if value is None:
        return None
    numerator, denominator = getattr(value, "numerator", None), getattr(value, "denominator", None)
    if type(numerator) is not int or type(denominator) is not int or denominator <= 0:
        return None
    return {"numerator": numerator, "denominator": denominator}


def _sum_fraction(values):
    if not values:
        return None
    numerator, denominator = 0, 1
    for value in values:
        numerator = numerator * value["denominator"] + value["numerator"] * denominator
        denominator *= value["denominator"]
    from fractions import Fraction

    total = Fraction(numerator, denominator)
    return {"numerator": total.numerator, "denominator": total.denominator}


def _schema_validation_status(telemetry):
    if any(call["schema_validation"] == "PASS" for call in telemetry.calls):
        return "PASS"
    if any(call["schema_validation"] == "FAIL" for call in telemetry.calls):
        return "FAIL"
    return "NOT_REACHED"


class _BudgetAdapter:
    """Bound aggregate adapter calls and reserved tokens for one run.

    Live callers must pair this with ``meeting_intelligence_max_attempts=1``
    when the bound is an HTTP-request budget. The production adapter otherwise
    may retry a single logical call for a transient provider response.
    """

    def __init__(self, adapter, *, max_calls: int, budget: int):
        require(type(max_calls) is int and max_calls > 0, "CONFIGURATION")
        require(type(budget) is int and budget > 0, "CONFIGURATION")
        self.adapter = adapter
        self.max_calls = max_calls
        self.budget = budget
        self.calls = 0
        self.accepted_calls = 0
        self.blocked_calls = 0
        self.estimated_units = 0

    def complete(self, request):
        self.calls += 1
        if self.calls > self.max_calls:
            self.blocked_calls += 1
            raise IntelligenceError("CONTEXT_BUDGET")
        units = request.window.estimated_input_tokens + request.output_budget
        if self.estimated_units + units > self.budget:
            self.blocked_calls += 1
            raise IntelligenceError("CONTEXT_BUDGET")
        self.estimated_units += units
        self.accepted_calls += 1
        return self.adapter.complete(request)


def _captured_text(value, maximum: int):
    require(isinstance(value, str) and 0 < len(value) <= maximum and value.strip(), "captured prediction")


def _validate_captured_prediction(feature: str, prediction: dict):
    try:
        require(isinstance(prediction, dict) and set(prediction) == {"producer", "result"}, "captured prediction")
        producer = prediction["producer"]
        require(isinstance(producer, dict) and {"model", "promptVersion"} <= set(producer)
                and not set(producer) - {"model", "promptVersion", "provider"}, "captured producer")
        for key, maximum in (("model", 160), ("promptVersion", 80), ("provider", 80)):
            if key in producer:
                _captured_text(producer[key], maximum)
                require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_./:-]{0,159}", producer[key]) is not None,
                        "captured producer")
        result = prediction["result"]
        require(isinstance(result, dict), "captured result")
        if feature == "summary":
            require(set(result) == {"content", "warnings"}, "captured summary")
            _captured_text(result["content"], 20_000)
            warnings = result["warnings"]
            require(isinstance(warnings, list) and len(warnings) <= 4 and len(set(warnings)) == len(warnings)
                    and all(warning in {"INCOMPLETE_COVERAGE", "UNRESOLVED_EVIDENCE", "SUSPICIOUS_EVIDENCE",
                                        "SOURCE_QUALITY_WARNING"} for warning in warnings), "captured warnings")
        else:
            expected = {"candidates", "warnings"} if feature == "decision" else {"candidates"}
            require(set(result) == expected and isinstance(result["candidates"], list)
                    and len(result["candidates"]) <= (500 if feature == "decision" else 200), "captured candidates")
            keys = set()
            for item in result["candidates"]:
                fields = ({"candidateKey", "content", "evidenceSegmentIds", "uncertainty"}
                          if feature == "decision" else
                          {"candidateKey", "title", "details", "suggestedDueDate", "evidenceSegmentIds"})
                require(isinstance(item, dict) and set(item) == fields, "captured candidate")
                require(isinstance(item["candidateKey"], str)
                        and re.fullmatch(r"[A-Za-z0-9._-]{1,128}", item["candidateKey"])
                        and item["candidateKey"] not in keys, "captured candidate key")
                keys.add(item["candidateKey"])
                text_key = "content" if feature == "decision" else "title"
                _captured_text(item[text_key], 5_000 if feature == "decision" else 500)
                if feature == "action":
                    if item["details"] is not None:
                        _captured_text(item["details"], 10_000)
                    due = item["suggestedDueDate"]
                    if due is not None:
                        require(isinstance(due, str) and date.fromisoformat(due).isoformat() == due,
                                "captured due date")
                else:
                    require(item["uncertainty"] in {"NONE", "LOW", "MATERIAL"}, "captured uncertainty")
                evidence = item["evidenceSegmentIds"]
                require(isinstance(evidence, list) and 1 <= len(evidence) <= 50
                        and len(set(evidence)) == len(evidence), "captured evidence")
                for segment_id in evidence:
                    UUID(segment_id)
            if feature == "decision":
                warnings = result["warnings"]
                require(isinstance(warnings, list) and len(warnings) <= 4 and len(set(warnings)) == len(warnings)
                        and all(warning in {"INCOMPLETE_COVERAGE", "UNRESOLVED_EVIDENCE", "SUSPICIOUS_EVIDENCE",
                                            "SOURCE_QUALITY_WARNING"} for warning in warnings), "captured warnings")
    except (TypeError, ValueError, KeyError, AttributeError):
        raise EvaluationError("captured prediction failed canonical shape validation") from None
    return prediction


def _claim(context: StageContext, feature: str):
    source = SimpleNamespace(
        snapshotId=context.source_snapshot_id,
        transcriptId=context.transcript_id,
        contentRevision=context.content_revision,
        sha256=context.source_sha256,
    )
    return SimpleNamespace(
        executionStageCode={"summary": "GENERATING_SUMMARY", "decision": "EXTRACTING_DECISIONS",
                            "action": "EXTRACTING_ACTION_ITEMS"}[feature],
        processingJobId=context.processing_job_id,
        executionStageRunId=context.stage_run_id,
        eventId=context.stage_run_id,
        claimToken=SecretStr("evaluation-claim-token"),
        source=source,
        resultSlot=None,
    )


def _processor(feature, settings, adapter):
    return {
        "summary": build_summary_processor,
        "decision": build_decision_processor,
        "action": build_action_item_processor,
    }[feature](settings, adapter)


def _failure_category(error):
    value = getattr(error, "category", None)
    return value if isinstance(value, str) else "PROCESSOR_FAILURE"


def run_processor_case(feature: str, context: StageContext, settings: Settings, adapter,
                       *, mode: EvaluationMode | str = EvaluationMode.DETERMINISTIC_OFFLINE,
                       processor_version: str = "meeting-intelligence-processors-1",
                       fixture_id: str | None = None,
                       provider_metadata=None) -> dict:
    """Run one real production processor with an injected, bounded adapter."""
    if feature not in FEATURES:
        raise EvaluationError("unknown meeting intelligence feature")
    mode = str(mode)
    telemetry = _TelemetryAdapter(adapter, provider_metadata=provider_metadata)
    record = {
        "fixture_id": fixture_id or context.source_snapshot_id,
        "feature": feature,
        "status": "FAILED",
        "failure_category": None,
        "failure_reason": None,
        "empty_result": False,
        "quality_status": "UNESTABLISHED" if mode != EvaluationMode.APPROVED_LIVE.value else "UNESTABLISHED",
        "source": {"snapshot_id": context.source_snapshot_id, "transcript_id": context.transcript_id,
                   "content_revision": context.content_revision, "source_sha256": context.source_sha256},
        "provenance": {"processor_version": processor_version, "mode": mode},
        "telemetry": None,
        "schema_validation": "NOT_REACHED",
        "canonical_validation": "NOT_RUN",
        "semantic_validation": "NOT_REACHED",
        "candidate_count": None,
        "smoke_semantic_validation": "NOT_RUN",
        "smoke_semantic_failure_reasons": [],
        "metrics": None,
        "critical_failures": [],
        "prediction": None,
    }
    candidate = None
    try:
        candidate = _processor(feature, settings, telemetry)(context)
        if isinstance(candidate, dict) and isinstance(candidate.get("result"), dict):
            values = candidate["result"].get("candidates")
            if isinstance(values, list):
                record["candidate_count"] = len(values)
        record["schema_validation"] = _schema_validation_status(telemetry)
        validate_processor_candidate(feature, candidate, context.snapshot, _claim(context, feature))
        record["canonical_validation"] = "PASS"
        record["semantic_validation"] = "PASS"
        result = candidate["result"]
        empty = (feature in {"decision", "action"} and not result.get("candidates"))
        if feature == "summary":
            empty = not bool(result.get("content", "").strip())
        record.update({
            "status": "SUCCESS", "empty_result": empty, "prediction": candidate,
            "provenance": {
                **record["provenance"], "model": candidate["producer"].get("model"),
                "prompt_version": candidate["producer"].get("promptVersion"),
                "provider": candidate["producer"].get("provider"),
                "configuration_sha256": telemetry.calls[0].get("configuration_sha256") if telemetry.calls else None,
                "planning_version": telemetry.calls[0].get("planning_version") if telemetry.calls else None,
                "task_sha256": telemetry.calls[0].get("task_sha256") if telemetry.calls else None,
                "reasoning_effort": telemetry.calls[0].get("reasoning_effort") if telemetry.calls else None,
            },
        })
    except IntelligenceError as error:
        record["failure_category"] = _failure_category(error)
        record["failure_reason"] = record["failure_category"]
        record["schema_validation"] = _schema_validation_status(telemetry)
        record["semantic_validation"] = (
            "FAIL" if record["schema_validation"] == "PASS" else "NOT_REACHED"
        )
    except EvaluationError:
        record["failure_category"] = "VALIDATION"
        record["failure_reason"] = "CANONICAL_VALIDATION"
        record["canonical_validation"] = "FAIL"
        record["semantic_validation"] = "FAIL"
    except Exception:
        record["failure_category"] = "PROCESSOR_FAILURE"
        record["failure_reason"] = "PROCESSOR_FAILURE"
        record["semantic_validation"] = (
            "FAIL" if record["schema_validation"] == "PASS" else "NOT_REACHED"
        )
    finally:
        record["telemetry"] = telemetry.report()
        record["duration_ns"] = record["telemetry"]["provider_duration_ns"]
        if telemetry.calls:
            first = telemetry.calls[0]
            record["provenance"] = {
                **record["provenance"],
                "model": first.get("requested_model"),
                "reported_model": first.get("reported_model"),
                "provider": first.get("provider"),
                "reported_provider": first.get("reported_provider"),
                "prompt_version": first.get("prompt_version"),
                "schema_version": first.get("schema_version"),
                "configuration_sha256": first.get("configuration_sha256"),
                "planning_version": first.get("planning_version"),
                "task_sha256": first.get("task_sha256"),
                "reasoning_effort": first.get("reasoning_effort"),
            }
        record["prediction"] = record.get("prediction")
    return record


def evaluate_action_smoke_semantics(
    record: dict,
    *,
    expected_count: int,
    expected_action_phrase: str | None = None,
    expected_due_date: str | None | object = _UNSPECIFIED,
    expected_party: str | None | object = _UNSPECIFIED,
    expected_evidence_segment_id: str | None = None,
) -> dict:
    """Apply fixture-specific expectations without narrowing the production contract.

    Empty and multi-candidate production results are valid processor outcomes.
    This evaluator reports a smoke-fixture mismatch instead of raising or
    converting either outcome into a provider/schema failure.
    """
    require(record.get("feature") == "action", "action smoke feature")
    reasons = []
    prediction = record.get("prediction")
    candidates = []
    if record.get("status") == "SUCCESS" and isinstance(prediction, dict):
        result = prediction.get("result")
        if isinstance(result, dict) and isinstance(result.get("candidates"), list):
            candidates = result["candidates"]
    actual_count = len(candidates) if record.get("status") == "SUCCESS" else record.get("candidate_count")
    if record.get("status") != "SUCCESS":
        smoke_status = "NOT_REACHED"
    else:
        if actual_count != expected_count:
            reasons.append("ACTION_COUNT_MISMATCH")
        if expected_action_phrase is not None and not any(
            isinstance(item.get("title"), str)
            and expected_action_phrase.casefold() in item["title"].casefold()
            for item in candidates
        ):
            reasons.append("EXPECTED_ACTION_NOT_FOUND")
        if expected_due_date is not _UNSPECIFIED and expected_due_date is not None and not any(
            item.get("suggestedDueDate") == expected_due_date for item in candidates
        ):
            reasons.append("EXPECTED_DEADLINE_NOT_FOUND")
        if expected_due_date is None and any(
            item.get("suggestedDueDate") is not None for item in candidates
        ):
            reasons.append("UNEXPECTED_DEADLINE")
        party_marker = "Người được nhắc trong bằng chứng:"
        parties = [
            item.get("details", "").split(party_marker, 1)[1].split(".", 1)[0].strip()
            for item in candidates
            if isinstance(item.get("details"), str) and party_marker in item["details"]
        ]
        if expected_party is None and parties:
            reasons.append("UNEXPECTED_ASSIGNEE")
        elif expected_party is not _UNSPECIFIED and expected_party is not None and not any(
            expected_party.casefold() in party.casefold() for party in parties
        ):
            reasons.append("EXPECTED_ASSIGNEE_NOT_FOUND")
        if expected_evidence_segment_id is not None and not any(
            expected_evidence_segment_id in item.get("evidenceSegmentIds", ())
            for item in candidates
        ):
            reasons.append("EXPECTED_EVIDENCE_NOT_FOUND")
        smoke_status = "PASS" if not reasons else "FAIL"
    record.update({
        "smoke_semantic_validation": smoke_status,
        "smoke_semantic_failure_reasons": reasons,
        "smoke_candidate_count": actual_count,
    })
    return record


def run_action_smoke_case(
    context: StageContext,
    settings: Settings,
    adapter,
    *,
    expected_count: int,
    expected_action_phrase: str | None = None,
    expected_due_date: str | None | object = _UNSPECIFIED,
    expected_party: str | None | object = _UNSPECIFIED,
    expected_evidence_segment_id: str | None = None,
    provider_metadata=None,
    mode: EvaluationMode | str = EvaluationMode.DETERMINISTIC_OFFLINE,
    max_provider_calls: int | None = None,
    aggregate_token_budget: int | None = None,
) -> dict:
    """Run one production Action Items processor and a fixture check.

    ``max_provider_calls`` and ``aggregate_token_budget`` install the same
    aggregate guard used by approved live evaluation. The HTTP-request
    interpretation additionally requires the production adapter's retry
    setting to be one.
    """
    require(
        (max_provider_calls is None and aggregate_token_budget is None)
        or (
            type(max_provider_calls) is int
            and max_provider_calls > 0
            and type(aggregate_token_budget) is int
            and aggregate_token_budget > 0
        ),
        "CONFIGURATION",
    )
    bounded_adapter = adapter
    if max_provider_calls is not None:
        bounded_adapter = _BudgetAdapter(
            adapter,
            max_calls=max_provider_calls,
            budget=aggregate_token_budget,
        )
    record = run_processor_case(
        "action",
        context,
        settings,
        bounded_adapter,
        mode=mode,
        processor_version="meeting-intelligence-smoke-1",
        provider_metadata=provider_metadata,
    )
    if isinstance(bounded_adapter, _BudgetAdapter):
        record["telemetry"].update({
            "aggregate_max_calls": bounded_adapter.max_calls,
            "aggregate_attempted_calls": bounded_adapter.calls,
            "aggregate_accepted_calls": bounded_adapter.accepted_calls,
            "aggregate_blocked_calls": bounded_adapter.blocked_calls,
            "aggregate_reserved_tokens": bounded_adapter.estimated_units,
            "aggregate_token_budget": bounded_adapter.budget,
        })
    return evaluate_action_smoke_semantics(
        record,
        expected_count=expected_count,
        expected_action_phrase=expected_action_phrase,
        expected_due_date=expected_due_date,
        expected_party=expected_party,
        expected_evidence_segment_id=expected_evidence_segment_id,
    )


def _context(case, feature: str):
    source = case.descriptor.source
    return StageContext(
        "00000000-0000-0000-0000-000000000004", "00000000-0000-0000-0000-000000000005",
        {"summary": "GENERATING_SUMMARY", "decision": "EXTRACTING_DECISIONS",
         "action": "EXTRACTING_ACTION_ITEMS"}[feature], source.meeting_id, source.snapshot_id,
        source.sha256, source.transcript_id, source.content_revision, case.snapshot,
        time.monotonic() + 600, __import__("threading").Event(),
    )


def run_dataset(dataset: MeetingDataset, feature: str, settings: Settings, adapter_factory,
                *, mode: EvaluationMode | str = EvaluationMode.DETERMINISTIC_OFFLINE):
    records = []
    for case in dataset.cases:
        if feature not in case.descriptor.features or case.descriptor.eligibility == "EXCLUDED":
            continue
        records.append(run_processor_case(feature, _context(case, feature), settings,
                                          adapter_factory(case, feature), mode=mode,
                                          fixture_id=case.descriptor.fixture_id))
    return records


def load_captured_run(path: Path) -> dict:
    try:
        path = Path(path)
        if (not path.is_file() or path.is_symlink()
                or any(parent.is_symlink() for parent in path.parents)
                or path.stat().st_size > 64 * 1024 * 1024):
            raise ValueError
        raw = path.read_bytes()
        document = json.loads(raw, object_pairs_hook=_unique_keys, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        require(isinstance(document, dict) and document.get("schema_version") == 1
                and document.get("evaluation_version") == EVALUATION_VERSION
                and document.get("mode") in {mode.value for mode in EvaluationMode}
                and isinstance(document.get("dataset"), dict) and isinstance(document.get("results"), list),
                "captured run")
        identities = set()
        for result in document["results"]:
            require(isinstance(result, dict) and result.get("feature") in FEATURES
                    and result.get("status") in {"SUCCESS", "FAILED"}
                    and isinstance(result.get("fixture_id"), str)
                    and ("prediction" in result and (result.get("prediction") is None
                                                      or isinstance(result.get("prediction"), dict))), "captured result")
            identity = (result.get("fixture_id"), result.get("feature"))
            require(identity not in identities, "duplicate captured result")
            identities.add(identity)
            if result.get("status") == "FAILED":
                require(result.get("prediction") is None, "failed prediction")
            else:
                require(isinstance(result.get("prediction"), dict), "successful prediction")
        return document
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        raise EvaluationError("captured evaluation run invalid or unavailable") from None


def score_captured_run(captured: dict, manifest, references: dict, *, policy: GatePolicy | None = None,
                       reviews: dict | None = None) -> dict:
    dataset = captured.get("dataset", {})
    require(dataset.get("dataset_id") == getattr(manifest, "dataset_id")
            and dataset.get("dataset_version") == getattr(manifest, "dataset_version"), "captured dataset")
    records = []
    for captured_record in captured["results"]:
        fixture_id = captured_record.get("fixture_id")
        reference = references.get(fixture_id)
        require(reference is not None, "captured reference")
        if captured_record["status"] != "SUCCESS":
            records.append({key: value for key, value in captured_record.items() if key != "prediction"})
            continue
        source = captured_record.get("source", {})
        if hasattr(reference, "source_snapshot_id"):
            require(source.get("snapshot_id") == reference.source_snapshot_id
                    and source.get("transcript_id") == reference.transcript_id
                    and source.get("content_revision") == reference.content_revision
                    and source.get("source_sha256") == reference.source_sha256, "captured source")
        prediction = captured_record.get("prediction")
        feature = captured_record["feature"]
        _validate_captured_prediction(feature, prediction)
        case_reviews = (reviews or {}).get(fixture_id, ())
        metrics = (score_summary(prediction, reference) if feature == "summary"
                   else decision_metrics(prediction, reference) if feature == "decision"
                   else score_action_items(prediction, reference))
        if feature == "summary" and case_reviews:
            metrics = score_summary(prediction, reference, human_review=case_reviews)
        records.append({key: value for key, value in captured_record.items() if key != "prediction"} | {
            "metrics": metrics, "critical_failures": metrics.get("critical_failures", []),
            "reference_reviewed": getattr(reference.provenance, "review_status", "NOT_REVIEWED") != "NOT_REVIEWED",
        })
    return build_evaluation_report(manifest, records, mode=captured["mode"], policy=policy,
                                   run_id=captured.get("run_id"))


def build_review_template(results, *, run_id: str) -> dict:
    return {
        "schema_version": 1, "review_template_version": "meeting-intelligence-review-1",
        "run_id": run_id, "status": "NOT_COMPLETED", "human_review_status": "PENDING",
        "instructions": "Review source evidence independently; do not treat model labels as ground truth.",
        "cases": [{"fixture_id": row.get("fixture_id"), "feature": row.get("feature"),
                   "claim_judgments": [], "omissions": [], "evidence_findings": [],
                   "decision": None, "action": None, "readability": None,
                   "reviewer_id": None, "adjudication": None} for row in results],
    }


def require_live_evaluation(settings: Settings, *, operator_opt_in: bool, dataset_authorized: bool,
                            max_calls: int, budget: int, output_path: str | Path):
    key = settings.openrouter_api_key.get_secret_value() if settings.openrouter_api_key else ""
    path = Path(output_path).absolute()
    summary_path = path.with_suffix(".md")
    repository = Path(__file__).resolve().parents[4]
    require(os.environ.get("RUN_MEETING_INTELLIGENCE_LIVE") == "1"
            and operator_opt_in is True and dataset_authorized is True
            and type(max_calls) is int and 0 < max_calls <= 1000
            and type(budget) is int and budget > 0
            and settings.meeting_intelligence_inference_enabled
            and bool(key) and all(33 <= ord(char) <= 126 for char in key)
            and path.parent.is_dir() and not path.exists()
            and not summary_path.exists()
            and not path.resolve().is_relative_to(repository)
            and not any(part.is_symlink() for part in (path, summary_path, *path.parents)),
            "live evaluation authorization")


def run_live_evaluation(dataset: MeetingDataset, settings: Settings, *, features: tuple[str, ...],
                        output_path: Path, operator_opt_in: bool, dataset_authorized: bool,
                        max_calls: int, budget: int, policy: GatePolicy | None = None) -> dict:
    require_live_evaluation(settings, operator_opt_in=operator_opt_in, dataset_authorized=dataset_authorized,
                            max_calls=max_calls, budget=budget, output_path=output_path)
    from sme_meeting_ai.providers.openrouter_intelligence import (
        OpenRouterIntelligenceAdapter,
    )

    records = []
    with OpenRouterIntelligenceAdapter(settings) as adapter:
        bounded_adapter = _BudgetAdapter(adapter, max_calls=max_calls, budget=budget)
        for feature in features:
            for case in dataset.cases:
                if feature not in case.descriptor.features:
                    continue
                record = run_processor_case(feature, _context(case, feature), settings, bounded_adapter,
                                            mode=EvaluationMode.APPROVED_LIVE,
                                            fixture_id=case.descriptor.fixture_id)
                if record["status"] == "SUCCESS":
                    metrics = (score_summary(record["prediction"], case.reference)
                               if feature == "summary" else decision_metrics(record["prediction"], case.reference)
                               if feature == "decision" else score_action_items(record["prediction"], case.reference))
                    record.update(metrics=metrics, critical_failures=metrics.get("critical_failures", []),
                                  reference_reviewed=case.reference.provenance.review_status != "NOT_REVIEWED")
                records.append(record)
    report = build_evaluation_report(dataset.manifest, records, mode=EvaluationMode.APPROVED_LIVE,
                                     policy=policy)
    write_evaluation_report(output_path, report)
    write_evaluation_summary(Path(output_path).with_suffix(".md"), report)
    return report
