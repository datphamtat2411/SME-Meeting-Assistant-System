"""Worker-independent stage and end-to-end evaluation with transient text only.

Stages and OfflineTranscriptionPipeline execute separately using borrowed injected
providers. Both executions are measured/billed in telemetry: there is no hidden
replay, provider substitution, token-based price estimate, or published fallback.
Only numeric metrics and allowlisted metadata leave run_transcription_case().
"""

import os
import re
import time
import traceback
from fractions import Fraction
from threading import Lock
from typing import Literal

from sme_meeting_ai.audio import AudioSource
from sme_meeting_ai.pipeline import OfflineTranscriptionPipeline
from sme_meeting_ai.transcription.chunk_execution import execute_asr_chunks
from sme_meeting_ai.transcription.chunk_planning import SpeechAwareAsrChunkPlanner
from sme_meeting_ai.transcription.correction import correct_transcript
from sme_meeting_ai.transcription.coverage import _valid_result
from sme_meeting_ai.transcription.reconciliation import reconcile_transcript
from sme_meeting_ai.transcription.recovery import recover_speech

from .support import (
    EvaluationError,
    analyze_result,
    bounds,
    digest_json,
    quality_metrics,
    rational,
    require,
    verify_source,
)
from .transcription_support import (
    EVALUATION_VERSION,
    STAGES,
    ProviderCallTelemetry,
    StageOutcome,
    TranscriptionCaseRecord,
    TranscriptionReport,
    compute_text_metrics,
    compute_transcription_metrics,
    configuration_identity,
    evaluate_transcription_gates,
    load_reference,
    require_transcription_manifest,
    status_of,
)

_IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:+-]*(?:/[A-Za-z0-9][A-Za-z0-9_.:+-]*)?\Z")
_METRICS = (
    "wer", "cer", "coverage_rate", "missed_samples", "largest_missed_samples",
    "missed_material_samples", "missed_critical_samples", "hallucination_rate",
    "hallucinated_samples", "unresolved_rate", "pipeline_unresolved_rate", "recovery_success_rate",
)


def require_live_evaluation(settings):
    secret = settings.openrouter_api_key
    key = secret.get_secret_value() if secret is not None else ""
    require(os.environ.get("RUN_OPENROUTER_LIVE_EVALUATION") == "1"
            and bool(key) and all(33 <= ord(char) <= 126 for char in key)
            and settings.transcript_correction_model is not None, "live opt-in and credentials")


def _identifier(value):
    return value if isinstance(value, str) and len(value) <= 256 and _IDENTIFIER.fullmatch(value) else None


def _duration(clock, started):
    value = clock() - started
    require(type(value) is int and value >= 0, "integer monotonic duration")
    return value


def _failure(error):
    # Never serialize str(error), provider bodies or arbitrary category objects.
    category = getattr(error, "category", None)
    value = getattr(category, "value", None)
    allowed = {"validation", "configuration", "context_overflow", "resource", "provider", "transport",
               "timeout", "authentication", "rate_limit", "malformed_output", "suspicious_output",
               "decoding", "model_unavailable", "inference"}
    return value.lower() if isinstance(value, str) and value.lower() in allowed else "evaluation-stage-error"


class _Telemetry:
    def __init__(self, clock):
        self.clock = clock
        self.calls = []
        self.lock = Lock()

    def call(self, phase, stage, call_id, function, argument):
        __tracebackhide__ = True
        started = self.clock()
        response = None
        failure = None
        try:
            response = function(argument)
            return response
        except Exception as error:
            failure = _failure(error)
            raise
        finally:
            duration = _duration(self.clock, started)
            usage = getattr(response, "usage", None)
            provenance = getattr(response, "provenance", response)
            cost = getattr(usage, "cost", None)
            cost = rational(cost.numerator, cost.denominator) if isinstance(cost, Fraction) and cost >= 0 else None
            tokens = {}
            for name in ("input_tokens", "output_tokens", "total_tokens"):
                value = getattr(usage, name, None)
                tokens[name] = value if type(value) is int and value >= 0 else None
            record: ProviderCallTelemetry = {"phase": phase, "stage": stage, "call_id": call_id, "duration_ns": duration,
                      "cost": cost, "failure": failure, **tokens,
                      **{key: _identifier(getattr(provenance, key, None))
                         for key in ("provider", "requested_model", "resolved_model", "upstream_provider")}}
            with self.lock:
                self.calls.append(record)
            response = argument = None

    def asr(self, provider, phase):
        telemetry = self
        class BorrowedAsr:
            def transcribe(self, chunk):
                stage = "recovery" if chunk.chunk_id.startswith("recovery-") else "baseline_asr"
                return telemetry.call(phase, stage, chunk.chunk_id, provider.transcribe, chunk)
        return BorrowedAsr()

    def corrector(self, provider, phase):
        telemetry = self
        class BorrowedCorrector:
            attempts = 0
            def complete(self, request):
                self.attempts += 1
                return telemetry.call(phase, "correction", f"attempt-{self.attempts:06d}", provider.complete, request)
        return BorrowedCorrector()

    def report(self):
        calls = sorted(self.calls, key=lambda c: (c["phase"], c["stage"], c["call_id"]))
        costs = [Fraction(**call["cost"]) for call in calls if call["cost"] is not None]
        subtotal = sum(costs, Fraction(0))
        return {"calls": calls, "call_count": len(calls), "reported_cost_call_count": len(costs),
                "reported_cost_subtotal": rational(subtotal.numerator, subtotal.denominator) if costs else None,
                "cost": rational(subtotal.numerator, subtotal.denominator) if calls and len(costs) == len(calls) else None,
                "provider_duration_ns": sum(call["duration_ns"] for call in calls)}


def _empty_stage(stage) -> StageOutcome:
    return {"stage": stage, "status": "UNAVAILABLE", "metrics": None, "duration_ns": None, "failure": None}


def _supported(results):
    return [timeline.interval for result in results if result.failure is None and _valid_result(result)
            for timeline in result.timeline_segments if timeline.segment.text.strip()]


def _hypothesis(results):
    # Raw, chronological stage hypothesis intentionally retains overlap wording;
    # reconciliation is measured independently rather than credited to raw ASR.
    evidence = [(timeline.interval.start_sample, timeline.interval.end_sample, result.chunk.ordinal, index,
                 timeline.segment.text)
                for result in results if result.failure is None and _valid_result(result)
                for index, timeline in enumerate(result.timeline_segments)]
    return " ".join(item[-1] for item in sorted(evidence, key=lambda item: item[:-1]))


def _coverage_args(assessment):
    return {"unresolved": assessment.unresolved_intervals,
            "pipeline_speech_samples": assessment.quality.likely_speech_samples,
            "pipeline_unresolved_samples": assessment.quality.unresolved_speech_samples + assessment.quality.suspicious_speech_samples}


def _chunk(chunk):
    return {"chunk_id": chunk.chunk_id, "ordinal": chunk.ordinal,
            "core_interval": bounds(chunk.core_interval), "request_interval": bounds(chunk.request_interval),
            "left_overlap_samples": chunk.core_interval.start_sample - chunk.request_interval.start_sample,
            "right_overlap_samples": chunk.request_interval.end_sample - chunk.core_interval.end_sample,
            "start_boundary_reason": chunk.start_boundary_reason.value,
            "end_boundary_reason": chunk.end_boundary_reason.value}


def _boundaries(plan, segments, fixture):
    output = []
    truth = [label for label in fixture.labels if label.label == "speech"]
    for chunk in plan.chunks[:-1]:
        cut = chunk.core_interval.end_sample
        relevant = [s for s in segments if s.interval.start_sample <= cut <= s.interval.end_sample]
        flags = sorted({f.value for s in relevant for f in s.flags})
        missing = any(label.start_sample < cut < label.end_sample for label in truth) and not any(
            s.text.strip() and s.interval.start_sample <= cut < s.interval.end_sample for s in relevant)
        output.append({"sample": cut, "reason": chunk.end_boundary_reason.value,
                       "inside_confirmed_speech": any(label.start_sample < cut < label.end_sample for label in truth),
                       "reconciliation_flags": flags,
                       "failures": sorted((["missing-boundary-speech"] if missing else [])
                                          + [flag for flag in flags if flag != "duplicate-overlap"])})
    return output


def _versions(provenance):
    output = {"pipeline_version": _identifier(provenance.pipeline_version)}
    for name, key in (("planning", "planner_version"), ("coverage", "assessor_version"),
                      ("recovery", "recovery_version"), ("reconciliation", "reconciler_version"),
                      ("correction", "correction_version")):
        value = getattr(provenance, name, None)
        output[name] = {key: _identifier(getattr(value, key, None))} if value is not None else None
    correction = provenance.correction
    if correction is not None:
        output["correction"].update({key: _identifier(getattr(correction, key, None))
                                     for key in ("prompt_version", "provider", "requested_model", "resolved_model")})
    preprocessing = provenance.preprocessing
    if preprocessing is not None:
        for stage, fields in (("normalization", ("normalizer_version", "decoder", "decoder_version")),
                              ("detection", ("detector_version", "model_id", "model_version", "model_sha256", "backend")),
                              ("speech_map", ("mapper_version",))):
            value = getattr(preprocessing, stage)
            output[stage] = {key: _identifier(getattr(value, key, None)) for key in fields} if value is not None else None
    return output


def _run_stages(source, fixture, reference_text, preprocessing, asr, corrector, settings, clock):
    __tracebackhide__ = True
    stages = {stage: _empty_stage(stage) for stage in STAGES}
    ownership = None
    chunks, recovery_record, boundaries = [], None, []

    def execute(stage, operation, projection):
        __tracebackhide__ = True
        started = clock()
        value = None
        try:
            value = operation()
            data = projection(value)
            stages[stage].update({"status": "PASS", **data})
            return value
        except Exception as error:
            stages[stage].update(status="FAIL", failure=_failure(error))
            traceback.clear_frames(error.__traceback__)
            return None
        finally:
            stages[stage]["duration_ns"] = _duration(clock, started)
            value = None

    def acquire():
        nonlocal ownership
        ownership = preprocessing.run(source)
        return ownership

    def preprocess(outcome):
        require(outcome.result is not None and outcome.failure is None, "preprocessing outcome")
        return {"metrics": quality_metrics(fixture, outcome.result.speech_map.speech_intervals,
                                           outcome.result.speech_map.uncertain_intervals),
                "quality_gates": preprocessing.last_analysis["quality_gates"]}

    try:
        initial = execute("preprocessing", acquire, preprocess)
        if initial is None:
            return stages, chunks, recovery_record, boundaries
        result = initial.result
        plan = execute("chunk_planning", lambda: SpeechAwareAsrChunkPlanner(settings).plan(result), lambda p: {"metrics": None})
        if plan is None:
            return stages, chunks, recovery_record, boundaries
        chunks = [_chunk(chunk) for chunk in plan.chunks]
        baseline = execute("baseline_asr", lambda: execute_asr_chunks(plan, result.normalized_artifact, asr, settings), lambda r: {
            "metrics": {**compute_transcription_metrics(fixture, _supported(r)), **compute_text_metrics(reference_text, _hypothesis(r))},
            "chunk_failures": sum(item.failure is not None for item in r),
        })
        if baseline is None:
            return stages, chunks, recovery_record, boundaries
        recovered = execute("recovery", lambda: recover_speech(result, plan, baseline, asr, settings), lambda r: {
            "metrics": {**compute_transcription_metrics(
                fixture, _supported((*baseline, *r.recovered_results)), initial_supported=_supported(baseline),
                initial_unresolved=r.initial_assessment.unresolved_intervals, **_coverage_args(r.final_assessment)),
                **compute_text_metrics(reference_text, _hypothesis((*baseline, *r.recovered_results)))},
        })
        if recovered is None:
            return stages, chunks, recovery_record, boundaries
        recovery_record = {"stop_reason": recovered.stop_reason.value, "attempts": [
            {**_chunk(a.window.chunk), "attempt_index": a.window.attempt_index,
             "boundary_strategy": a.window.boundary_strategy, "failure": a.failure.value if a.failure else None,
             "unresolved_samples_before": a.unresolved_samples_before, "unresolved_samples_after": a.unresolved_samples_after,
             "covered_speech_delta": a.covered_speech_delta, "meaningful_progress": a.meaningful_progress,
             "stop_reason": a.stop_reason.value if a.stop_reason else None} for a in recovered.attempts]}
        reconciled = execute("reconciliation", lambda: reconcile_transcript(plan, (*baseline, *recovered.recovered_results), settings), lambda r: {
            "metrics": {**compute_transcription_metrics(fixture, [s.interval for s in r.segments if s.text.strip()],
                                                        **_coverage_args(recovered.final_assessment)),
                        **compute_text_metrics(reference_text, " ".join(s.text for s in r.segments))},
            "flags": sorted({flag.value for s in r.segments for flag in s.flags}),
        })
        if reconciled is None:
            return stages, chunks, recovery_record, boundaries
        boundaries = _boundaries(plan, reconciled.segments, fixture)

        def correction_projection(outcome):
            if outcome.result is None or outcome.failure is not None:
                return {"status": "FAIL", "metrics": None, "failure": outcome.failure.category.value}
            return {"metrics": {**compute_transcription_metrics(
                fixture, [s.interval for s in outcome.result.segments if s.text.strip()],
                **_coverage_args(recovered.final_assessment)),
                **compute_text_metrics(reference_text, " ".join(s.text for s in outcome.result.segments))}}
        execute("correction", lambda: correct_transcript(reconciled, recovered.final_assessment, corrector, settings), correction_projection)
        return stages, chunks, recovery_record, boundaries
    finally:
        if ownership is not None:
            try:
                ownership.close()
            except Exception as error:
                stages["preprocessing"].update(status="FAIL", failure="resource")
                traceback.clear_frames(error.__traceback__)


def run_transcription_case(
    manifest, fixture, root, preprocessing, transcriber, correction_provider, settings, *,
    expected_model_sha256, clock=time.monotonic_ns, evidence_mode: Literal["offline-contract", "approved-live"],
    variant=None, configuration_version="explicit-settings-1", pipeline_version="1",
) -> TranscriptionCaseRecord:
    __tracebackhide__ = True
    require(evidence_mode in {"offline-contract", "approved-live"}, "evidence mode")
    if evidence_mode == "approved-live":
        require_live_evaluation(settings)
    configuration = configuration_identity(settings, variant, configuration_version)
    identity = {"evaluation_version": EVALUATION_VERSION, "dataset_id": manifest.dataset_id,
                "dataset_version": manifest.dataset_version, "manifest_sha256": manifest.manifest_sha256,
                "fixture_id": fixture.fixture_id, "source_sha256": fixture.source_sha256,
                "annotation_sha256": digest_json(fixture.model_dump(include={"labels", "sample_count", "annotation_version", "annotation_origin", "anchors"})),
                "reference_sha256": fixture.reference.sha256 if fixture.reference else None,
                "reference_version": fixture.reference.reference_version if fixture.reference else None,
                "configuration_sha256": configuration["sha256"], "pipeline_version": pipeline_version,
                "evidence_mode": evidence_mode}
    telemetry = _Telemetry(clock)
    stages = {stage: _empty_stage(stage) for stage in STAGES}
    record = {"fixture_id": fixture.fixture_id, "variant_id": variant.variant_id if variant else "explicit",
              "evidence_mode": evidence_mode, "kind": fixture.kind, "language": fixture.language,
              "conditions": sorted(fixture.conditions), "identity": identity,
              "case_configuration_id": digest_json(identity), "configuration": configuration,
              "chunks": [], "recovery": None, "boundaries": [], "provenance": None,
              "preprocessing_provenance": None}
    reference = reference_text = source = None
    try:
        require_transcription_manifest(manifest)
        require(fixture in manifest.fixtures, "fixture membership")
        source = AudioSource(fixture.fixture_id, verify_source(root, fixture))
        if any(label.label == "speech" for label in fixture.labels):
            reference = load_reference(root, fixture)
            reference_text = " ".join(s.text for s in reference.segments if s.label == "speech")
        else:
            # Independently labeled non-speech has an empty reference, not an
            # invented speech transcript or a perfect zero-denominator rate.
            reference_text = ""
    except (EvaluationError, OSError):
        record["availability"] = "assets-or-reference-unavailable"
    else:
        class CheckedPreprocessing:
            last_analysis = None
            def run(self, audio_source):
                __tracebackhide__ = True
                outcome = preprocessing.run(audio_source)
                try:
                    if outcome.result is not None:
                        analyzed = analyze_result(manifest, fixture, outcome.result, expected_model_sha256=expected_model_sha256)
                        self.last_analysis = analyzed
                        record["preprocessing_provenance"] = analyzed["provenance"]
                    return outcome
                except Exception:
                    outcome.close()
                    raise
        checked = CheckedPreprocessing()
        try:
            stages, record["chunks"], record["recovery"], record["boundaries"] = _run_stages(
                source, fixture, reference_text, checked, telemetry.asr(transcriber, "stages"),
                telemetry.corrector(correction_provider, "stages"), settings, clock)
            started = clock()
            outcome = OfflineTranscriptionPipeline(
                checked, SpeechAwareAsrChunkPlanner(settings), telemetry.asr(transcriber, "end_to_end"),
                telemetry.corrector(correction_provider, "end_to_end"), settings, pipeline_version=pipeline_version,
            ).run(source)
            final = stages["end_to_end"]
            final.update(duration_ns=_duration(clock, started), pipeline_status=outcome.status.value,
                         status="FAIL" if outcome.failure is not None else "PASS",
                         failure=outcome.failure.category.lower() if outcome.failure else None,
                         completed_stages=sorted(stage.value for stage in outcome.completed_stages),
                         warnings=sorted({f"{w.stage.value}:{w.code}" for w in outcome.warnings}))
            if outcome.result is not None:
                supported = [segment.interval for segment in outcome.result.segments if segment.text.strip()]
                initial = outcome.evidence.recovery.initial_assessment if outcome.evidence.recovery else None
                initial_supported = ([s.interval for s in initial.transcript_coverage if s.has_text_support]
                                     if initial is not None else None)
                final["metrics"] = {**compute_transcription_metrics(
                    fixture, supported, initial_supported=initial_supported,
                    initial_unresolved=initial.unresolved_intervals if initial else None,
                    pipeline_status=outcome.status.value, result_available=True,
                    **_coverage_args(outcome.result.coverage)),
                    **compute_text_metrics(reference_text, " ".join(s.text for s in outcome.result.segments))}
            record["provenance"] = _versions(outcome.provenance)
            if record["preprocessing_provenance"] is not None:
                record["provenance"]["runtime_versions"] = record["preprocessing_provenance"]["runtime_versions"]
            verify_source(root, fixture)
            if reference is not None:
                load_reference(root, fixture)  # Detect mutation during inference.
            record["availability"] = "AVAILABLE"
        except Exception as error:
            stages["end_to_end"].update(status="FAIL", metrics=None, failure=_failure(error))
            traceback.clear_frames(error.__traceback__)
            record["availability"] = "evaluation-failed"
        finally:
            outcome = checked = None
    finally:
        reference = reference_text = source = None
    record["stages"] = [stages[stage] for stage in STAGES]
    record["telemetry"] = telemetry.report()
    record["quality_gates"] = evaluate_transcription_gates(manifest, fixture, stages)
    statuses = [record["quality_gates"]["status"], *(stage["status"] for stage in stages.values())]
    statuses.extend(stage["quality_gates"]["status"] for stage in stages.values()
                    if stage.get("quality_gates", {}).get("checks"))
    if evidence_mode == "offline-contract":
        statuses.append("UNESTABLISHED")
    record["status"] = status_of(statuses)
    model_identity = sorted({tuple((key, call[key]) for key in ("provider", "requested_model", "resolved_model", "upstream_provider"))
                             for call in record["telemetry"]["calls"]}, key=repr)
    record["evaluation_id"] = digest_json({**identity, "provenance": record["provenance"], "models": model_identity})
    return record


def run_configuration_matrix(manifest, root, matrix, provider_factory, settings, *, expected_model_sha256,
                             clock=time.monotonic_ns, evidence_mode, fixtures=None):
    require_transcription_manifest(manifest)
    records = []
    for variant in sorted(matrix.variants, key=lambda v: v.variant_id):
        effective = variant.settings(settings)
        preprocessing, transcriber, corrector = provider_factory(effective)
        for fixture in sorted(fixtures if fixtures is not None else manifest.fixtures, key=lambda f: f.fixture_id):
            records.append(run_transcription_case(
                manifest, fixture, root, preprocessing, transcriber, corrector, effective,
                expected_model_sha256=expected_model_sha256, clock=clock, evidence_mode=evidence_mode,
                variant=variant, configuration_version=matrix.configuration_version))
    return sorted(records, key=lambda r: (r["fixture_id"], r["variant_id"]))


def _aggregate(records):
    additive = ("confirmed_speech_samples", "covered_speech_samples", "missed_samples", "missed_material_samples",
                "missed_critical_samples", "confirmed_non_speech_samples", "hallucinated_samples", "unresolved_speech_samples",
                "pipeline_speech_samples", "pipeline_unresolved_speech_samples", "initial_unresolved_speech_samples",
                "recovered_speech_samples", "reference_words", "hypothesis_words", "word_errors", "word_substitutions",
                "word_deletions", "word_insertions", "reference_characters", "hypothesis_characters", "character_errors",
                "character_substitutions", "character_deletions", "character_insertions")
    rates = {"wer": ("word_errors", "reference_words"), "cer": ("character_errors", "reference_characters"),
             "coverage_rate": ("covered_speech_samples", "confirmed_speech_samples"),
             "hallucination_rate": ("hallucinated_samples", "confirmed_non_speech_samples"),
             "unresolved_rate": ("unresolved_speech_samples", "confirmed_speech_samples"),
             "pipeline_unresolved_rate": ("pipeline_unresolved_speech_samples", "pipeline_speech_samples"),
             "recovery_success_rate": ("recovered_speech_samples", "initial_unresolved_speech_samples")}
    stages = {}
    for name in STAGES:
        rows = [stage for record in records for stage in record["stages"] if stage["stage"] == name]
        metrics = [row["metrics"] for row in rows if row["metrics"] is not None]
        totals = {key: sum(m[key] for m in metrics if m.get(key) is not None)
                  if any(m.get(key) is not None for m in metrics) else None for key in additive}
        for rate, (numerator, denominator) in rates.items():
            # Pool only paired evidence; do not mix absent numerators with known
            # denominators or average rates across differently sized recordings.
            pairs = [(m[numerator], m[denominator]) for m in metrics
                     if m.get(numerator) is not None and m.get(denominator) is not None]
            totals[rate] = rational(sum(a for a, _ in pairs), sum(b for _, b in pairs)) if pairs else None
        totals["largest_missed_samples"] = max((m["largest_missed_samples"] for m in metrics
                                               if m.get("largest_missed_samples") is not None), default=None)
        decisions = [m["false_success"] for m in metrics if m.get("false_success") is not None]
        totals["false_success_count"] = sum(decisions) if decisions else None
        durations = [row["duration_ns"] for row in rows if row["duration_ns"] is not None]
        stages[name] = {"available_count": len(metrics), "unavailable_count": len(rows) - len(metrics),
                        "metrics": totals if metrics else None,
                        "duration_ns": sum(durations) if durations else None}
    calls = [call for record in records for call in record["telemetry"]["calls"]]
    costs = [Fraction(**call["cost"]) for call in calls if call["cost"] is not None]
    subtotal = sum(costs, Fraction(0))
    return {"case_count": len(records), "unavailable_count": sum(r["status"] == "UNAVAILABLE" for r in records),
            "status": status_of(r["status"] for r in records), "stages": stages,
            "telemetry": {"call_count": len(calls), "reported_cost_call_count": len(costs),
                          "reported_cost_subtotal": rational(subtotal.numerator, subtotal.denominator) if costs else None,
                          "cost": rational(subtotal.numerator, subtotal.denominator) if calls and len(costs) == len(calls) else None,
                          "provider_duration_ns": sum(call["duration_ns"] for call in calls)}}


def _numeric_metric(value):
    if type(value) is int:
        return Fraction(value)
    if (isinstance(value, dict) and set(value) == {"numerator", "denominator"}
            and type(value["numerator"]) is int and type(value["denominator"]) is int
            and value["denominator"] > 0):
        return Fraction(**value)
    raise EvaluationError("evaluation baseline metric invalid")


def _baseline_comparisons(manifest, matrix, records, baseline):
    comparable_dataset = baseline is not None and baseline.get("evaluation_version") == EVALUATION_VERSION and baseline.get("dataset", {}) == {
        "dataset_id": manifest.dataset_id, "dataset_version": manifest.dataset_version,
        "manifest_sha256": manifest.manifest_sha256,
        "approval_version": manifest.approval_version, "labeling_guideline_version": manifest.labeling_guideline_version,
    }
    previous = {}
    if comparable_dataset:
        for row in baseline.get("results", []):
            require(isinstance(row, dict) and isinstance(row.get("evaluation_id"), str)
                    and row["evaluation_id"] not in previous, "baseline identity")
            previous[row["evaluation_id"]] = row
    comparisons, regressions, checks = [], [], []
    if baseline is None and not matrix.baseline_policies:
        return comparisons, regressions, checks
    for record in records:
        before = previous.get(record["evaluation_id"])
        if before is not None and any(before.get(key) != record[key] for key in ("identity", "configuration", "provenance")):
            before = None
        status = "COMPARABLE" if before is not None else "INCOMPATIBLE" if baseline is not None else "UNAVAILABLE"
        if before is not None and record["availability"] != "AVAILABLE":
            status = "UNAVAILABLE"
        comparison = {"case_configuration_id": record["case_configuration_id"], "status": status, "deltas": []}
        current_stages = {s["stage"]: s.get("metrics") for s in record["stages"]}
        old_stages = {s["stage"]: s.get("metrics") for s in before.get("stages", [])} if before else {}
        for stage in STAGES:
            for metric in _METRICS:
                now = (current_stages.get(stage) or {}).get(metric)
                old = (old_stages.get(stage) or {}).get(metric)
                if now is None or old is None:
                    continue
                a, b = _numeric_metric(now), _numeric_metric(old)
                delta = a - b
                comparison["deltas"].append({"stage": stage, "metric": metric, "delta": rational(delta.numerator, delta.denominator)})
        for policy in sorted(matrix.baseline_policies, key=lambda p: (p.stage, p.metric)):
            delta = next((row["delta"] for row in comparison["deltas"] if row["stage"] == policy.stage and row["metric"] == policy.metric), None)
            disposition = "UNAVAILABLE"
            if delta is not None:
                value = Fraction(**delta) * (1 if policy.direction == "lower" else -1)
                bound = policy.maximum_regression
                disposition = "FAIL" if value > Fraction(bound.numerator, bound.denominator) else "PASS"
            check = {"case_configuration_id": record["case_configuration_id"], **policy.model_dump(),
                     "delta": delta, "status": disposition}
            checks.append(check)
            if disposition == "FAIL":
                regressions.append(check)
        comparisons.append(comparison)
    return comparisons, regressions, checks


def build_transcription_report(manifest, matrix, records, *, baseline=None) -> TranscriptionReport:
    expected = {(fixture.fixture_id, variant.variant_id) for fixture in manifest.fixtures for variant in matrix.variants}
    actual = [(record["fixture_id"], record["variant_id"]) for record in records]
    require(len(actual) == len(expected) and set(actual) == expected, "incomplete transcription matrix")
    records = sorted(records, key=lambda r: (r["fixture_id"], r["variant_id"]))
    comparisons, regressions, baseline_checks = _baseline_comparisons(manifest, matrix, records, baseline)
    groups = {"all": records, "vietnamese_recordings": [r for r in records if r["kind"] == "recording" and r["language"] == "vi"]}
    groups.update({f"condition:{condition}": [r for r in records if condition in r["conditions"]]
                   for condition in sorted({c for r in records for c in r["conditions"]})})
    groups.update({f"variant:{variant.variant_id}": [r for r in records if r["variant_id"] == variant.variant_id]
                   for variant in sorted(matrix.variants, key=lambda v: v.variant_id)})
    return {"schema_version": 1, "evaluation_version": EVALUATION_VERSION,
            "dataset": {"dataset_id": manifest.dataset_id, "dataset_version": manifest.dataset_version,
                        "manifest_sha256": manifest.manifest_sha256,
                        "approval_version": manifest.approval_version,
                        "labeling_guideline_version": manifest.labeling_guideline_version},
            "configuration_matrix": matrix.canonical(), "configuration_matrix_sha256": digest_json(matrix.canonical()),
            "quality_gate_status": status_of([*(r["status"] for r in records), *(c["status"] for c in baseline_checks)]),
            "results": records, "aggregates": {key: _aggregate(value) for key, value in sorted(groups.items())},
            "baseline_comparisons": comparisons, "baseline_checks": baseline_checks, "regressions": regressions}
