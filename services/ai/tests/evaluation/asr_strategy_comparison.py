"""T01: controlled, evaluation-only measurement of the legacy ASR algorithms.

Only numeric projections escape execution. Preprocessing ownership spans all
three strategies; B and C borrow the very same baseline tuple and objects. The
offline API accepts injected providers, never the real network adapter. Only the
separate live API can construct that adapter, after dataset-wide local preflight.
No correction stage, raw HTTP endpoint, candidate persistence or retry is used.
"""

import os
import time
import traceback
from contextlib import ExitStack
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path
from threading import Lock

from sme_meeting_ai.audio import (
    AudioEvidenceDetector,
    AudioNormalizer,
    AudioProcessingError,
    AudioSource,
    SampleInterval,
    SileroVadBackend,
    SpeechMapBuilder,
)
from sme_meeting_ai.pipeline import AudioPreprocessingPipeline
from sme_meeting_ai.providers.openrouter_whisper import OpenRouterWhisperAdapter
from sme_meeting_ai.transcription.asr import AsrError, AsrErrorCategory
from sme_meeting_ai.transcription.chunk_execution import (
    AsrChunkResult,
    _execute_chunk,
    _validate_handoff,
    execute_asr_chunks,
)
from sme_meeting_ai.transcription.chunk_planning import (
    AsrChunk,
    ChunkBoundaryReason,
    SpeechAwareAsrChunkPlanner,
)
from sme_meeting_ai.transcription.coverage import _valid_result, assess_speech_coverage
from sme_meeting_ai.transcription.reconciliation import reconcile_transcript
from sme_meeting_ai.transcription.recovery import recover_speech

from .support import (
    EvaluationError,
    analyze_result,
    bounds,
    digest_json,
    load_manifest,
    merge,
    rational,
    require,
    require_pinned_model,
    samples,
    verify_source,
    write_report,
)
from .transcription_runner import (
    _duration,
    _failure,
    _numeric_metric,
    _supported,
    _Telemetry,
)
from .transcription_support import (
    EVALUATION_VERSION,
    compute_text_metrics,
    compute_transcription_metrics,
    configuration_identity,
    evaluate_transcription_gates,
    external_file,
    load_configuration,
    load_reference,
    require_transcription_manifest,
    status_of,
    validate_output_path,
)

COMPARISON_VERSION = "asr-strategy-comparison-1"
STRATEGIES = ("whole-file", "chunked-baseline", "chunked-recovery")
MODEL = "openai/whisper-large-v3"
_WHOLE, _BASELINE, _RECOVERY = "whole_file_asr", "baseline_asr", "recovery"
# Public provenance vocabulary only; an entry is emitted ONLY if returned by
# the provider. Unknown upstream identity remains unavailable, never inferred.
_APPROVED_UPSTREAM = frozenset({"OpenAI", "openai", "Azure", "azure", "Groq", "groq",
                                "DeepInfra", "deepinfra", "Fireworks", "fireworks"})


def _selected(matrix, settings):
    variant = next(v for v in matrix.variants if v.variant_id == matrix.baseline_variant)
    effective = variant.settings(settings)
    require(effective.audio_asr_model == MODEL and effective.audio_asr_language == "vi", "locked inference")
    return variant, effective


def require_live_comparison(settings):
    """No implicit env file and no GPT model requirement."""
    secret = settings.openrouter_api_key
    key = secret.get_secret_value() if secret is not None else ""
    require(os.environ.get("RUN_ASR_COMPARISON_LIVE") == "1"
            and bool(key) and all(33 <= ord(c) <= 126 for c in key), "comparison opt-in and credentials")


def _summary(calls):
    # Reuse the existing exact, reported-only cost aggregation and ordering.
    ledger = _Telemetry(None)
    ledger.calls = list(calls)
    data = ledger.report()
    return {"asr_calls": data["call_count"], "asr_failures": sum(c["failure"] is not None for c in calls),
            "reported_cost": data["cost"], "reported_cost_subtotal": data["reported_cost_subtotal"],
            "reported_cost_call_count": data["reported_cost_call_count"],
            "provider_duration_ns": data["provider_duration_ns"]}


class _ComparisonTelemetry(_Telemetry):
    def __init__(self, clock, *, maximum=None):
        super().__init__(clock)
        self.maximum = maximum
        self.started_calls = 0
        self.budget_lock = Lock()

    def asr(self, provider, stage):
        telemetry = self
        class BorrowedAsr:
            def transcribe(self, chunk):
                with telemetry.budget_lock:
                    if telemetry.maximum is not None and telemetry.started_calls >= telemetry.maximum:
                        raise AsrError(AsrErrorCategory.RESOURCE)
                    telemetry.started_calls += 1
                return telemetry.call("comparison", stage, chunk.chunk_id, provider.transcribe, chunk)
        return BorrowedAsr()

    def results(self, results):
        # A provider call returning malformed timestamps still consumed a call.
        # Extraction/local admission failures do not fabricate provider calls.
        by_id = {r.chunk.chunk_id: r for r in results}
        for call in self.calls:
            result = by_id.get(call["call_id"])
            if result is not None and result.failure is not None:
                call["failure"] = result.failure.value
            elif result is not None and not _valid_result(result):
                call["failure"] = "malformed_output"

    def projected(self):
        raw = super().report()["calls"]
        calls = []
        for item in raw:
            # Returned provenance is not arbitrary report text. T01 approves
            # the configured public provider/model only. Unapproved returned
            # identity is hashed for incompatibility checks, never published.
            identity = {k: item[k] for k in ("provider", "requested_model", "resolved_model", "upstream_provider")}
            approved = {"provider": item["provider"] if item["provider"] == "openrouter" else None,
                        "requested_model": item["requested_model"] if item["requested_model"] == MODEL else None,
                        "resolved_model": item["resolved_model"] if item["resolved_model"] == MODEL else None,
                        "upstream_provider": item["upstream_provider"] if item["upstream_provider"] in _APPROVED_UPSTREAM else None}
            calls.append({**item, **approved, "provenance_sha256": digest_json(identity),
                          "model_identity_sha256": (digest_json({k: identity[k] for k in ("requested_model", "resolved_model")})
                                                    if identity["requested_model"] is not None else None),
                          "requested_model_matches": identity["requested_model"] in (None, MODEL),
                          "unapproved_provenance": any(identity[k] is not None and approved[k] is None for k in identity)})
        return calls


def _overlap_samples(intervals):
    """Union of positions with >=2 supports, never sum of pairwise durations."""
    events = {}
    for item in intervals:
        events[item.start_sample] = events.get(item.start_sample, 0) + 1
        events[item.end_sample] = events.get(item.end_sample, 0) - 1
    previous = active = total = 0
    for position, delta in sorted(events.items()):
        if active >= 2:
            total += position - previous
        active += delta
        previous = position
    return total


def _raw_hypothesis(results):
    segments = [(t.interval.start_sample, t.interval.end_sample, r.chunk.ordinal, index, t.segment.text)
                for r in results if r.failure is None and _valid_result(r)
                for index, t in enumerate(r.timeline_segments)]
    return " ".join(s[-1] for s in sorted(segments, key=lambda s: s[:-1]))


def _reconciliation_metrics(plan, baseline, results, reconciled):
    segments = reconciled.segments
    metrics = {"planned_chunks": len(plan.chunks),
               "successful_baseline_chunks": sum(r.failure is None and _valid_result(r) for r in baseline),
               "failed_baseline_chunks": sum(r.failure is not None or not _valid_result(r) for r in baseline),
               "baseline_asr_segments": sum(len(r.timeline_segments) for r in baseline if r.failure is None and _valid_result(r)),
               "reconciled_segments": len(segments), "flagged_segments": sum(bool(s.flags) for s in segments),
               "overlapping_evidence_samples": _overlap_samples(_supported(results)),
               "reconciled_overlap_samples": _overlap_samples(s.interval for s in segments if s.text.strip()),
               "unresolved_intervals": [bounds(i) for i in merge(reconciled.unresolved_intervals)],
               "unresolved_samples": samples(reconciled.unresolved_intervals),
               "true_duplicate_utterance_count": "UNESTABLISHED"}
    for key, flag in (("conflicting_overlap_segments", "conflicting-overlap"),
                      ("unresolved_boundary_segments", "unresolved-boundary"),
                      ("duplicate_overlap_segments", "duplicate-overlap")):
        metrics[key] = sum(any(f.value == flag for f in s.flags) for s in segments)
    return metrics


def _recovery_metrics(recovered, speech_metrics, recovery_calls):
    return {"recovery_attempts": len(recovered.attempts),
            "successful_recovery_requests": sum(c["failure"] is None for c in recovery_calls),
            "failed_recovery_requests": sum(c["failure"] is not None for c in recovery_calls),
            "meaningful_progress_attempts": sum(a.meaningful_progress for a in recovered.attempts),
            "no_progress_attempts": sum(not a.meaningful_progress for a in recovered.attempts),
            "recovery_stop_reason": recovered.stop_reason.value,
            "initial_unresolved_samples": samples(recovered.initial_assessment.unresolved_intervals),
            "final_unresolved_samples": samples(recovered.final_assessment.unresolved_intervals),
            "recovered_speech_samples": speech_metrics["recovered_speech_samples"],
            "recovery_success_rate": speech_metrics["recovery_success_rate"],
            "attempt_progress": [{"attempt_index": index, "meaningful_progress": a.meaningful_progress,
                                  "unresolved_samples_before": a.unresolved_samples_before,
                                  "unresolved_samples_after": a.unresolved_samples_after,
                                  "covered_speech_delta": a.covered_speech_delta,
                                  "failure": a.failure.value if a.failure else None,
                                  "stop_reason": a.stop_reason.value if a.stop_reason else None}
                                 for index, a in enumerate(recovered.attempts)]}


def _empty(strategy):
    return {"strategy_id": strategy, "availability": "UNAVAILABLE", "status": "UNAVAILABLE",
            "quality_status": "UNAVAILABLE", "text_metrics": None, "provider_text_metrics": None,
            "speech_metrics": None, "reconciliation_metrics": None, "recovery_metrics": None,
            "provider_telemetry": _summary([]), "resource_telemetry": None,
            "sanitized_failure": None, "quality_gates": {"status": "UNAVAILABLE", "checks": []}}


def _quality(row, manifest, fixture, evidence_mode):
    if row["status"] != "PASS":
        row["quality_status"] = row["status"]
        return
    if row["strategy_id"] == "whole-file":
        # The legacy gate schema has no whole-file strategy role. Do not invent
        # reviewed A gates by relabeling pipeline/end-to-end gates.
        gates = {"status": "UNESTABLISHED", "checks": []}
    else:
        applicable = manifest.model_copy(update={"transcription_quality_gates": [
            gate for gate in manifest.transcription_quality_gates if gate.stage == "reconciliation"]})
        measured = {**row["text_metrics"], **row["speech_metrics"]}
        gates = evaluate_transcription_gates(applicable, fixture, {
            "reconciliation": {"metrics": measured}, "end_to_end": {"metrics": measured}})
    row["quality_gates"] = gates
    row["quality_status"] = status_of([gates["status"], *(["UNESTABLISHED"] if evidence_mode == "offline-contract" else [])])


def _identity(manifest, fixture, matrix, variant, settings, expected_model_sha256):
    configuration = configuration_identity(settings, variant, matrix.configuration_version)
    return {"schema_version": 1, "evaluation_version": COMPARISON_VERSION, "failure_stage": None,
            "measurement_version": EVALUATION_VERSION,
            "dataset_identity": {"dataset_id": manifest.dataset_id, "dataset_version": manifest.dataset_version,
                                 "manifest_sha256": manifest.manifest_sha256, "fixture_id": fixture.fixture_id,
                                 "source_sha256": fixture.source_sha256, "approval_version": manifest.approval_version},
            "reference_identity": {"reference_sha256": fixture.reference.sha256 if fixture.reference else None,
                                   "reference_version": fixture.reference.reference_version if fixture.reference else None,
                                   "annotation_version": fixture.annotation_version,
                                   "annotation_sha256": digest_json(fixture.model_dump(include={"labels", "sample_count", "anchors", "annotation_origin"}))},
            # Hash the existing complete snapshot, but publish only explicitly
            # selected public inference/geometry settings, not correction config.
            "configuration_identity": {"configuration_version": matrix.configuration_version,
                                       "baseline_variant": matrix.baseline_variant,
                                       "variant": variant.model_dump(), "sha256": configuration["sha256"],
                                       "requested_model": MODEL, "language": "vi",
                                       "temperature": settings.audio_asr_temperature,
                                       "response_format": "verbose_json", "timestamp_granularity": "segment"},
            "pipeline_identity": {"pipeline_version": "1", "vad_model_sha256": expected_model_sha256}}


@dataclass
class _PreparedCase:
    manifest: object = field(repr=False)
    fixture: object = field(repr=False)
    root: Path = field(repr=False)
    outcome: object = field(repr=False)
    plan: object = field(repr=False)
    reference_text: str = field(repr=False)
    record: dict
    whole_chunk: AsrChunk
    whole_eligible: bool
    maximum_calls: int


def _validate_case_assets(manifest, fixture, root):
    require_transcription_manifest(manifest)
    require(manifest.privacy_approved and manifest.legal_approved and fixture in manifest.fixtures, "approved fixture")
    source = external_file(root, fixture.path)  # Includes every parent symlink.
    require(verify_source(root, fixture) == source, "source identity")
    if any(label.label == "speech" for label in fixture.labels) or fixture.reference is not None:
        reference = load_reference(root, fixture)
        return source, " ".join(s.text for s in reference.segments if s.label == "speech")
    return source, ""  # Independent non-speech controls have no invented transcript.


def _prepare(manifest, fixture, root, preprocessing, settings, record, expected_model_sha256, clock, resources):
    record["failure_stage"] = "assets"
    source, reference_text = _validate_case_assets(manifest, fixture, root)
    record["failure_stage"] = "preprocessing"
    started = clock()
    outcome = preprocessing.run(AudioSource(fixture.fixture_id, source))
    resources.callback(outcome.close)
    if outcome.failure is not None:
        raise AudioProcessingError(outcome.failure.category)
    record["failure_stage"] = "preprocessing-validation"
    require(outcome.result is not None, "preprocessing outcome")
    result = outcome.result
    analysis = analyze_result(manifest, fixture, result, expected_model_sha256=expected_model_sha256)
    record["pipeline_identity"].update({"pipeline_version": result.provenance.pipeline_version,
                                       "preprocessing_sha256": digest_json(analysis["provenance"]),
                                       "normalized_pcm_sha256": analysis["integrity"]["normalized_pcm_sha256"]})
    record["preprocessing_duration_ns"] = _duration(clock, started)
    record["failure_stage"] = "chunk-planning"
    started = clock()
    plan = SpeechAwareAsrChunkPlanner(settings).plan(result)
    # Existing executor validation reads/validates WAV without making requests.
    class NoInference:
        def transcribe(self, chunk):
            raise AssertionError("preflight cannot infer")
    _validate_handoff(plan, result.normalized_artifact, NoInference(), settings)
    record["planning_duration_ns"] = _duration(clock, started)
    interval = SampleInterval(0, plan.sample_count)
    whole = AsrChunk("whole-file", 0, interval, interval,
                     ChunkBoundaryReason.TIMELINE_START, ChunkBoundaryReason.TIMELINE_END)
    # This local chunk is deliberately NOT passed through production geometry
    # validation. Extraction/translation contracts still apply without changes.
    eligible = 44 + plan.sample_count * 2 <= settings.audio_asr_max_payload_bytes
    eligible_baseline = sum(44 + (c.request_interval.end_sample - c.request_interval.start_sample) * 2
                            <= settings.audio_asr_max_payload_bytes for c in plan.chunks)
    recovery_maximum = settings.audio_asr_recovery_max_total_attempts if settings.audio_asr_max_payload_bytes >= 46 else 0
    maximum = int(eligible) + eligible_baseline + recovery_maximum
    record["maximum_asr_calls"] = maximum
    record["pipeline_identity"]["planning_sha256"] = digest_json({
        "planner_version": plan.provenance.planner_version,
        "effective_configuration": dict(plan.provenance.effective_configuration),
        "chunks": [{"core": bounds(c.core_interval), "request": bounds(c.request_interval)} for c in plan.chunks]})
    record["failure_stage"] = None
    return _PreparedCase(manifest, fixture, root, outcome, plan, reference_text, record, whole, eligible, maximum)


def _project_chunked(row, prepared, baseline, results, assessment, reconciled, initial=None):
    supported = [s.interval for s in reconciled.segments if s.text.strip()]
    kwargs = {"unresolved": assessment.unresolved_intervals,
              "pipeline_speech_samples": assessment.quality.likely_speech_samples,
              "pipeline_unresolved_samples": assessment.quality.unresolved_speech_samples + assessment.quality.suspicious_speech_samples}
    if initial is not None:
        kwargs.update(initial_supported=initial[0], initial_unresolved=initial[1])
    row["availability"] = "AVAILABLE"
    row["status"] = "FAIL" if any(r.failure is not None or not _valid_result(r) for r in results) else "PASS"
    row["text_metrics"] = compute_text_metrics(prepared.reference_text, " ".join(s.text for s in reconciled.segments))
    row["provider_text_metrics"] = compute_text_metrics(prepared.reference_text, _raw_hypothesis(results))
    row["speech_metrics"] = compute_transcription_metrics(
        prepared.fixture, supported, pipeline_status="COMPLETED" if row["status"] == "PASS" else "FAILED",
        result_available=True, **kwargs)
    row["reconciliation_metrics"] = _reconciliation_metrics(prepared.plan, baseline, results, reconciled)
    row["component_versions"] = {"coverage": assessment.provenance.assessor_version,
                                 "reconciliation": reconciled.provenance.reconciler_version}
    if row["status"] == "FAIL":
        row["sanitized_failure"] = "asr-chunk-failure"


def _resources(row, calls, durations, whole_count, baseline_count, recovery_count):
    row["provider_telemetry"] = _summary(calls)
    row["model_identity"] = sorted({c["model_identity_sha256"] for c in calls if c["model_identity_sha256"]})
    row["inference_compatible"] = all(c["requested_model_matches"] for c in calls)
    row["resource_telemetry"] = {"whole_file_asr_calls": whole_count, "shared_baseline_asr_calls": baseline_count,
                                 "additional_recovery_calls": recovery_count, "repeated_baseline_asr_calls": 0,
                                 "logical_asr_calls": len(calls), "per_strategy_duration_ns": durations}


def _metric_deltas(before, after):
    deltas = {}
    for section, keys in (("text_metrics", ("wer", "cer")),
                          ("speech_metrics", ("covered_speech_samples", "coverage_rate", "missed_samples", "missed_material_samples",
                                              "missed_critical_samples", "hallucinated_samples", "hallucination_rate",
                                              "unresolved_speech_samples", "unresolved_rate")),
                          ("reconciliation_metrics", ("overlapping_evidence_samples", "reconciled_overlap_samples",
                                                      "conflicting_overlap_segments", "unresolved_boundary_segments"))):
        for key in keys:
            left, right = (before.get(section) or {}).get(key), (after.get(section) or {}).get(key)
            if left is None or right is None:
                deltas[key] = None
            elif type(left) is int and type(right) is int:
                deltas[key] = right - left
            else:
                difference = _numeric_metric(right) - _numeric_metric(left)
                deltas[key] = rational(difference.numerator, difference.denominator)
    return deltas


def _strategy_comparison(before, after):
    if before["availability"] != "AVAILABLE" or after["availability"] != "AVAILABLE":
        return {"status": "UNAVAILABLE", "deltas": {}}
    if (before.get("model_identity") != after.get("model_identity")
            or not before.get("inference_compatible", True) or not after.get("inference_compatible", True)):
        return {"status": "INCOMPATIBLE", "deltas": {}}
    return {"status": "COMPARABLE", "deltas": _metric_deltas(before, after)}


def compare_records(before, after):
    """Only identical measurement/audio/reference/config/model/pipeline identities."""
    keys = ("schema_version", "evaluation_version", "measurement_version", "dataset_identity", "reference_identity",
            "configuration_identity", "pipeline_identity", "evidence_mode")
    if any(before.get(k) != after.get(k) for k in keys):
        return {"status": "INCOMPATIBLE", "deltas": {}}
    old = {s["strategy_id"]: s for s in before["strategies"]}
    comparisons = {s["strategy_id"]: _strategy_comparison(old[s["strategy_id"]], s) for s in after["strategies"]}
    statuses = [v["status"] for v in comparisons.values()]
    if "INCOMPATIBLE" in statuses:
        return {"status": "INCOMPATIBLE", "deltas": {}}
    return {"status": "UNAVAILABLE" if "UNAVAILABLE" in statuses else "COMPARABLE",
            "deltas": {key: value["deltas"] for key, value in sorted(comparisons.items())}}


def _finish(record, rows, ledger, durations):
    calls = ledger.projected()
    whole = [c for c in calls if c["stage"] == _WHOLE]
    baseline = [c for c in calls if c["stage"] == _BASELINE]
    recovery = [c for c in calls if c["stage"] == _RECOVERY]
    a, b, c = rows
    _resources(a, whole, durations[0], len(whole), 0, 0)
    _resources(b, baseline, durations[1], 0, len(baseline), 0)
    _resources(c, [*baseline, *recovery], durations[2], 0, len(baseline), len(recovery))
    c["incremental_provider_telemetry"] = _summary(recovery)
    record["telemetry"] = {**_summary(calls), "calls": calls, "whole_file_asr_calls": len(whole),
                           "shared_baseline_asr_calls": len(baseline), "additional_recovery_calls": len(recovery),
                           "total_unique_asr_calls": len(calls)}
    comparison = _strategy_comparison(b, c)
    comparison.update({"whole_file_vs_baseline": _strategy_comparison(a, b),
                       "additional_recovery_requests": len(recovery),
                       "incremental_provider_telemetry": _summary(recovery),
                       "additional_latency_ns": (durations[2] - durations[1]
                                                 if durations[2] is not None and durations[1] is not None else None),
                       "accuracy_improvement": None})
    if comparison["status"] == "COMPARABLE":
        rates = [comparison["deltas"].get(key) for key in ("wer", "cer")]
        if all(value is not None for value in rates):
            values = [Fraction(**v) for v in rates]
            comparison["accuracy_improvement"] = all(v <= 0 for v in values) and any(v < 0 for v in values)
    record.update(strategies=rows, comparison=comparison,
                  quality_status=status_of(row["quality_status"] for row in rows))
    record["pipeline_identity"]["component_versions"] = {
        row["strategy_id"]: row.get("component_versions") for row in rows}
    return record


def _execute(prepared, transcriber, settings, clock, evidence_mode, maximum=None):
    __tracebackhide__ = True
    record = prepared.record
    record["evidence_mode"] = evidence_mode
    rows = [_empty(s) for s in STRATEGIES]
    a, b, c = rows
    ledger = _ComparisonTelemetry(clock, maximum=maximum)
    result = baseline = recovered = reconciled = assessment = whole_result = combined = text = None
    durations = [None, None, None]
    active = 0
    shared_duration = 0
    try:
        started = clock()
        if not prepared.whole_eligible:
            a["sanitized_failure"] = "resource"
        else:
            whole_result = _execute_chunk(prepared.whole_chunk, prepared.outcome.result.normalized_artifact,
                                          ledger.asr(transcriber, _WHOLE), settings.audio_asr_max_payload_bytes)
            if whole_result.failure is None and (not whole_result.timeline_segments or not _valid_result(whole_result)):
                whole_result = AsrChunkResult(prepared.whole_chunk, failure=AsrErrorCategory.MALFORMED_OUTPUT)
            ledger.results((whole_result,))
            if whole_result.failure is not None:
                a.update(status="FAIL", sanitized_failure=whole_result.failure.value)
            else:
                a.update(availability="AVAILABLE", status="PASS")
                text = " ".join(t.segment.text for t in whole_result.timeline_segments)
                a["text_metrics"] = compute_text_metrics(prepared.reference_text, text)
                a["speech_metrics"] = compute_transcription_metrics(prepared.fixture, _supported((whole_result,)))
                a["timestamp_diagnostics"] = {"segment_count": len(whole_result.timeline_segments),
                                              "supported_intervals": [bounds(i) for i in merge(_supported((whole_result,)))],
                                              "top_level_text_differs": whole_result.candidate.text != text}
                text = None
        durations[0] = _duration(clock, started)
        _quality(a, prepared.manifest, prepared.fixture, evidence_mode)
        whole_result = None

        active = 1
        result = prepared.outcome.result
        started = clock()
        baseline = execute_asr_chunks(prepared.plan, result.normalized_artifact,
                                      ledger.asr(transcriber, _BASELINE), settings)
        ledger.results(baseline)
        assessment = assess_speech_coverage(result, prepared.plan, baseline, settings)
        shared_duration = _duration(clock, started)
        started = clock()
        reconciled = reconcile_transcript(prepared.plan, baseline, settings)
        _project_chunked(b, prepared, baseline, baseline, assessment, reconciled)
        initial_support = [s.interval for s in reconciled.segments if s.text.strip()]
        initial_unresolved = assessment.unresolved_intervals
        durations[1] = shared_duration + _duration(clock, started)
        _quality(b, prepared.manifest, prepared.fixture, evidence_mode)
        reconciled = None

        active = 2
        started = clock()
        recovered = recover_speech(result, prepared.plan, baseline, ledger.asr(transcriber, _RECOVERY), settings)
        ledger.results(recovered.recovered_results)
        # No cloning, regenerating, filtering or re-admitting the baseline.
        combined = (*baseline, *recovered.recovered_results)
        reconciled = reconcile_transcript(prepared.plan, combined, settings)
        _project_chunked(c, prepared, baseline, combined, recovered.final_assessment, reconciled,
                         initial=(initial_support, initial_unresolved))
        c["recovery_metrics"] = _recovery_metrics(
            recovered, c["speech_metrics"], [call for call in ledger.calls if call["stage"] == _RECOVERY])
        c["component_versions"]["recovery"] = recovered.provenance.recovery_version
        durations[2] = shared_duration + _duration(clock, started)
        _quality(c, prepared.manifest, prepared.fixture, evidence_mode)
        combined = None
        _validate_case_assets(prepared.manifest, prepared.fixture, prepared.root)
    except Exception as error:
        record["failure_stage"] = STRATEGIES[active]
        if durations[active] is None:
            durations[active] = (shared_duration if active else 0) + _duration(clock, started)
        category = _failure(error)
        for row in rows:
            if row["status"] == "UNAVAILABLE" and row["sanitized_failure"] is None:
                row.update(status="FAIL", quality_status="FAIL", sanitized_failure=category)
        # Mutated assets invalidate scored evidence too, never publish quality
        # metrics for a different source/reference revision.
        if isinstance(error, EvaluationError):
            for index, row in enumerate(rows):
                rows[index] = {**_empty(row["strategy_id"]), "sanitized_failure": "assets-or-reference-unavailable"}
        traceback.clear_frames(error.__traceback__)
    finally:
        result = baseline = recovered = reconciled = assessment = whole_result = combined = text = None
    return _finish(record, rows, ledger, durations)


def run_comparison_case(manifest, fixture, root, preprocessing, transcriber, settings, matrix, *,
                        expected_model_sha256, clock=time.monotonic_ns):
    """Offline injected contract case; a real adapter requires dataset-wide live preflight."""
    __tracebackhide__ = True
    require(not isinstance(transcriber, OpenRouterWhisperAdapter), "offline injected provider")
    variant, effective = _selected(matrix, settings)
    record = _identity(manifest, fixture, matrix, variant, effective, expected_model_sha256)
    record["evidence_mode"] = "offline-contract"
    prepared = completed = None
    try:
        with ExitStack() as resources:
            prepared = _prepare(manifest, fixture, root, preprocessing, effective, record,
                                expected_model_sha256, clock, resources)
            completed = _execute(prepared, transcriber, effective, clock, "offline-contract")
        return completed
    except Exception as error:
        traceback.clear_frames(error.__traceback__)
        if completed is not None:
            completed["failure_stage"] = "cleanup"
            for row in completed["strategies"]:
                row.update(status="FAIL", quality_status="FAIL", sanitized_failure="resource")
            completed["quality_status"] = "FAIL"
            return completed
        stage = record["failure_stage"] or "execution"
        record["failure_stage"] = stage
        # Missing approval/source/reference evidence is unavailable. A failed
        # preprocessor, invalid returned artifact or invalid plan is an execution
        # failure, not evidence that approved assets are missing. Keep only the
        # fixed stage/category vocabulary, never exception messages or paths.
        status = "UNAVAILABLE" if stage == "assets" else "FAIL"
        category = ("assets-or-reference-unavailable" if stage == "assets" else
                    "validation" if isinstance(error, EvaluationError) else _failure(error))
        rows = [{**_empty(s), "status": status, "quality_status": status,
                 "sanitized_failure": category} for s in STRATEGIES]
        return _finish(record, rows, _ComparisonTelemetry(clock), [None, None, None])
    finally:
        if prepared is not None:
            prepared.reference_text = ""
        prepared = None


def _default_preprocessing(settings, resources):
    backend = SileroVadBackend.from_settings(settings)
    resources.callback(backend.close)
    return AudioPreprocessingPipeline(AudioNormalizer(settings), AudioEvidenceDetector(settings, backend), SpeechMapBuilder(settings))


def _default_transcriber(settings, resources):
    return resources.enter_context(OpenRouterWhisperAdapter(settings))


def run_live_comparison(root, config_path, output, max_asr_calls, settings, *,
                        preprocessing_factory=None, transcriber_factory=None, clock=time.monotonic_ns):
    """Explicitly authorized dataset run; ALL local plans precede ANY paid request.

    Factories are dependency-injection seams for offline preflight tests. Real
    execution uses only the existing adapters and never needs a GPT model.
    Prepared artifacts are held until the complete-dataset budget is established;
    callers must provision sufficient local temporary capacity for the corpus.
    """
    __tracebackhide__ = True
    prepared = []
    try:
        require_live_comparison(settings)
        require(type(max_asr_calls) is int and max_asr_calls > 0, "explicit maximum ASR calls")
        require(all(path is not None for path in (root, config_path, output)), "explicit comparison paths")
        root, config_path, output = Path(root).absolute(), Path(config_path).absolute(), Path(output).absolute()
        repository = Path(__file__).resolve().parents[4]
        require(not root.resolve().is_relative_to(repository), "external fixture root")
        require(not any(part.is_symlink() for part in (root, *root.parents)), "fixture root symlink")
        manifest = load_manifest(root)
        require_transcription_manifest(manifest)
        matrix = load_configuration(config_path)
        variant, effective = _selected(matrix, settings)
        require_pinned_model(effective)
        protected = [effective.audio_vad_model_path, config_path, root / "manifest.json"]
        for fixture in manifest.fixtures:
            _validate_case_assets(manifest, fixture, root)
            protected.append(external_file(root, fixture.path))
            if fixture.reference:
                protected.append(external_file(root, fixture.reference.path))
        require(all(not path.resolve().is_relative_to(repository) for path in protected), "external comparison assets")
        require(not any(part.is_symlink() for path in protected for part in (path, *path.parents)), "asset symlink")

        def check_inputs_output():
            require(load_manifest(root) == manifest and load_configuration(config_path) == matrix, "input revision")
            require_pinned_model(effective)
            for fixture in manifest.fixtures:
                _validate_case_assets(manifest, fixture, root)
            validate_output_path(output, root, protected)
            require(not output.exists() or output.is_file(), "output file")

        check_inputs_output()
        with ExitStack() as resources:
            preprocessing = (preprocessing_factory or _default_preprocessing)(effective, resources)
            for fixture in sorted(manifest.fixtures, key=lambda f: f.fixture_id):
                record = _identity(manifest, fixture, matrix, variant, effective, effective.audio_vad_model_sha256)
                prepared.append(_prepare(manifest, fixture, root, preprocessing, effective, record,
                                         effective.audio_vad_model_sha256, clock, resources))
            maximum = sum(case.maximum_calls for case in prepared)
            require(max_asr_calls >= maximum, "complete comparison call budget")
            check_inputs_output()
            # Construction occurs only after whole-dataset assets, models,
            # preprocessing, chunk plans and the conservative budget all pass.
            transcriber = (transcriber_factory or _default_transcriber)(effective, resources)
            records = [_execute(case, transcriber, effective, clock, "approved-live", maximum=case.maximum_calls)
                       for case in prepared]
            check_inputs_output()
            calls = [call for record in records for call in record["telemetry"]["calls"]]
            report = {"schema_version": 1, "evaluation_version": COMPARISON_VERSION,
                      "dataset_identity": {"dataset_id": manifest.dataset_id, "dataset_version": manifest.dataset_version,
                                           "manifest_sha256": manifest.manifest_sha256},
                      "configuration_identity": records[0]["configuration_identity"],
                      "reference_identity": {"sha256": digest_json([r["reference_identity"] for r in records])},
                      "cases": records, "telemetry": {**_summary(calls), "maximum_asr_calls": maximum,
                                                       "explicit_call_budget": max_asr_calls,
                                                       "total_unique_asr_calls": len(calls),
                                                       **{key: sum(r["telemetry"][key] for r in records) for key in (
                                                           "whole_file_asr_calls", "shared_baseline_asr_calls", "additional_recovery_calls")}},
                      "quality_status": status_of(r["quality_status"] for r in records)}
        # All cleanup must also succeed before a report is published.
        check_inputs_output()
        write_report(output, report)
        return report
    except Exception as error:
        traceback.clear_frames(error.__traceback__)
    finally:
        for case in prepared:
            case.reference_text = ""
        prepared.clear()
    # Outside handler: no input-bearing exception chain, paths or response body.
    raise EvaluationError("ASR comparison preflight or execution unavailable") from None
