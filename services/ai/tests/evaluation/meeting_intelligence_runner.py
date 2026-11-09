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


class _TelemetryAdapter:
    def __init__(self, adapter):
        self.adapter = adapter
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
            self.calls.append({
                "call_index": len(self.calls),
                "duration_ns": duration,
                "failure_category": failure,
                "requested_model": getattr(result, "requested_model", request.model) if result else request.model,
                "reported_model": getattr(result, "reported_model", None) if result else None,
                "provider": getattr(result, "provider", None) if result else None,
                "reported_provider": getattr(result, "reported_provider", None) if result else None,
                "input_tokens": getattr(usage, "input_tokens", None) if usage else None,
                "output_tokens": getattr(usage, "output_tokens", None) if usage else None,
                "total_tokens": getattr(usage, "total_tokens", None) if usage else None,
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
        return {
            "call_count": len(self.calls),
            "calls": sorted(self.calls, key=lambda call: call["call_index"]),
            "reported_cost_call_count": len(costs),
            "reported_cost_subtotal": _sum_fraction(costs),
            "cost": _sum_fraction(costs) if costs and len(costs) == len(self.calls) else None,
            "provider_duration_ns": sum(call["duration_ns"] for call in self.calls),
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


class _BudgetAdapter:
    """Bound provider attempts and estimated request cost for one live run."""

    def __init__(self, adapter, *, max_calls: int, budget: int):
        self.adapter = adapter
        self.max_calls = max_calls
        self.budget = budget
        self.calls = 0
        self.estimated_units = 0

    def complete(self, request):
        self.calls += 1
        if self.calls > self.max_calls:
            raise IntelligenceError("CONTEXT_BUDGET")
        units = request.window.estimated_input_tokens + request.output_budget
        if self.estimated_units + units > self.budget:
            raise IntelligenceError("CONTEXT_BUDGET")
        self.estimated_units += units
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
                       fixture_id: str | None = None) -> dict:
    """Run one real production processor with an injected, bounded adapter."""
    if feature not in FEATURES:
        raise EvaluationError("unknown meeting intelligence feature")
    mode = str(mode)
    telemetry = _TelemetryAdapter(adapter)
    record = {
        "fixture_id": fixture_id or context.source_snapshot_id,
        "feature": feature,
        "status": "FAILED",
        "failure_category": None,
        "empty_result": False,
        "quality_status": "UNESTABLISHED" if mode != EvaluationMode.APPROVED_LIVE.value else "UNESTABLISHED",
        "source": {"snapshot_id": context.source_snapshot_id, "transcript_id": context.transcript_id,
                   "content_revision": context.content_revision, "source_sha256": context.source_sha256},
        "provenance": {"processor_version": processor_version, "mode": mode},
        "telemetry": None,
        "metrics": None,
        "critical_failures": [],
        "prediction": None,
    }
    try:
        candidate = _processor(feature, settings, telemetry)(context)
        validate_processor_candidate(feature, candidate, context.snapshot, _claim(context, feature))
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
    except EvaluationError:
        record["failure_category"] = "VALIDATION"
    except Exception:
        record["failure_category"] = "PROCESSOR_FAILURE"
    finally:
        record["telemetry"] = telemetry.report()
        record["duration_ns"] = record["telemetry"]["provider_duration_ns"]
        record["prediction"] = record.get("prediction")
    return record


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
