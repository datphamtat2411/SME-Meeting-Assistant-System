"""Invented contract evidence only: no human audio, local models or network."""

import hashlib
import io
import socket
import wave
from dataclasses import replace
from fractions import Fraction

import pytest
from pydantic import SecretStr

from sme_meeting_ai.audio import AudioSource, SpeechMapWarning
from sme_meeting_ai.pipeline.models import (
    PreprocessingFailure,
    PreprocessingStage,
    PreprocessingStatus,
)
from sme_meeting_ai.providers.openrouter_whisper import OpenRouterWhisperAdapter
from sme_meeting_ai.transcription.asr import (
    AsrCandidate,
    AsrError,
    AsrErrorCategory,
    AsrProvenance,
    AsrQualityMetadata,
    AsrSegment,
    AsrUsage,
)

from . import asr_strategy_comparison as comparison
from . import test_transcription_runner
from .support import EvaluationError, canonical_json
from .test_transcription_runner import Clock
from .transcription_support import ConfigurationMatrix, load_reference

# Register the existing decorated fixture under the name the local wrapper uses.
base_case = test_transcription_runner.case


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("network forbidden in comparison contract tests")
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(OpenRouterWhisperAdapter, "transcribe", forbidden)
    monkeypatch.delenv("RUN_ASR_COMPARISON_LIVE", raising=False)


@pytest.fixture
def case(base_case):
    """Reuse synthetic audio/evidence, but honor warning-bearing outcome contracts.

    The shared helper only constructs warning-free COMPLETED outcomes. Keep its
    settings unchanged and rebuild derived maps locally when a comparison needs
    different speech-map settings. Transfer the original ownership to a normally
    validated outcome instead of mutating frozen records or bypassing validation.
    """
    def make(**overrides):
        map_settings = {key: overrides.pop(key) for key in tuple(overrides)
                        if key.startswith("audio_speech_map_")}
        h = base_case(**overrides)
        if not map_settings:
            return h
        h.settings = type(h.settings)(
            _env_file=None, **{**h.settings.model_dump(by_alias=True), **map_settings})
        original = h.preprocessing.run
        def preprocessing(source):
            outcome = original(source)
            try:
                result = outcome.result
                speech_map = comparison.SpeechMapBuilder(h.settings).build(
                    result.normalized_artifact, result.speech_evidence)
                provenance = replace(result.provenance, speech_map=speech_map.provenance)
                result = replace(result, speech_map=speech_map, warnings=speech_map.quality.warnings,
                                 provenance=provenance)
                status = (PreprocessingStatus.COMPLETED_WITH_WARNINGS if result.warnings
                          else PreprocessingStatus.COMPLETED)
                return replace(outcome, status=status, result=result, provenance=provenance)
            except BaseException:
                outcome.close()
                raise
        h.preprocessing.run = preprocessing
        return h
    return make


def matrix(h):
    s = h.settings
    variant = {"variant_id": "selected", "version": "1",
               "target_samples": s.audio_asr_chunk_target_samples,
               "max_request_samples": s.audio_asr_chunk_max_request_samples,
               "overlap_samples": s.audio_asr_chunk_overlap_samples,
               "boundary_search_samples": s.audio_asr_chunk_boundary_search_samples}
    return ConfigurationMatrix.model_validate({
        "schema_version": 1, "configuration_version": "contract-1", "baseline_variant": "selected",
        "variants": [{**variant, "variant_id": "never-run"}, variant],
    })


def candidate(chunk, segments, *, cost=Fraction(1, 10), text=None, provenance=None):
    evidence = tuple(AsrSegment(Fraction(start, 16000), Fraction(end, 16000), wording)
                     for start, end, wording in segments)
    return AsrCandidate(
        " ".join(s.text for s in evidence) if text is None else text,
        evidence, AsrQualityMetadata(), AsrUsage(cost=cost),
        provenance or AsrProvenance("openrouter", "openai/whisper-large-v3", "openai/whisper-large-v3",
                                   inference_config=(("language", "vi"), ("temperature", 0),
                                                     ("response_format", "verbose_json"),
                                                     ("timestamp_granularity", "segment"))), chunk.chunk_id,
    )


def provider(h, function=None):
    class Fake:
        def transcribe(self, chunk):
            h.calls.append(chunk.chunk_id)
            if function:
                return function(chunk)
            return candidate(chunk, [(0, round(chunk.duration * 16000), "Kubernetes API")])
    return Fake()


def invoke(h, transcriber=None, **kwargs):
    return comparison.run_comparison_case(
        h.manifest, h.fixture, h.root, h.preprocessing, transcriber or provider(h), h.settings,
        matrix(h), expected_model_sha256="d" * 64, clock=Clock(), **kwargs,
    )


def strategies(record):
    assert [s["strategy_id"] for s in record["strategies"]] == [
        "whole-file", "chunked-baseline", "chunked-recovery"]
    return record["strategies"]


def reference(h, segments):
    old = load_reference(h.root, h.fixture)
    document = {**old.model_dump(), "segments": [
        {"start_sample": start, "end_sample": end, "label": "speech", "text": text}
        for start, end, text in segments]}
    raw = canonical_json(document).encode()
    (h.root / h.fixture.reference.path).write_bytes(raw)
    h.fixture = h.fixture.model_copy(update={"reference": h.fixture.reference.model_copy(
        update={"sha256": hashlib.sha256(raw).hexdigest()})})
    h.manifest = h.manifest.model_copy(update={"fixtures": [h.fixture, *h.manifest.fixtures[1:]]})


def test_r01_shared_baseline_identity_and_one_preprocessing_and_plan(case, monkeypatch):
    h = case(count=4096, audio_asr_chunk_target_samples=1024,
             audio_asr_chunk_max_request_samples=1536, audio_asr_chunk_overlap_samples=256)
    seen = {}
    execute, recover, reconcile = comparison.execute_asr_chunks, comparison.recover_speech, comparison.reconcile_transcript
    planner = comparison.SpeechAwareAsrChunkPlanner.plan
    def planning(self, result):
        seen["planning"] = seen.get("planning", 0) + 1
        return planner(self, result)
    def execution(*args):
        seen["baseline"] = execute(*args)
        return seen["baseline"]
    def recovery(preprocessed, plan, baseline, *args, **kwargs):
        assert baseline is seen["baseline"]
        seen["recovered"] = recover(preprocessed, plan, baseline, *args, **kwargs)
        return seen["recovered"]
    def reconciliation(plan, results, settings, **kwargs):
        seen["reconciliation"] = seen.get("reconciliation", 0) + 1
        assert all(a is b for a, b in zip(results, seen["baseline"]))
        return reconcile(plan, results, settings, **kwargs)
    monkeypatch.setattr(comparison.SpeechAwareAsrChunkPlanner, "plan", planning)
    monkeypatch.setattr(comparison, "execute_asr_chunks", execution)
    monkeypatch.setattr(comparison, "recover_speech", recovery)
    monkeypatch.setattr(comparison, "reconcile_transcript", reconciliation)
    record = invoke(h)
    _, b, c = strategies(record)
    planned = b["reconciliation_metrics"]["planned_chunks"]
    assert planned > 1
    assert sum(name.startswith("chunk-") for name in h.calls) == planned
    assert len(set(h.calls)) == len(h.calls)
    assert h.preprocessing_calls == h.closes == seen["planning"] == 1
    assert record["configuration_identity"]["baseline_variant"] == "selected"
    assert c["resource_telemetry"]["repeated_baseline_asr_calls"] == 0
    assert seen["reconciliation"] == 1  # C consumes the actual admitted snapshot.
    assert c["reconciliation_metrics"]["reconciled_segments"] == len(seen["recovered"].accepted_reconciliation.segments)
    assert b["component_versions"]["coverage_phase"] == c["component_versions"]["coverage_phase"] == "final-canonical"
    assert c["component_versions"]["recovery"] == "2"


def test_r02_whole_file_payload_and_real_fractional_timestamp_translation(case):
    h = case()
    observed = []
    def response(chunk):
        if chunk.chunk_id == "whole-file":
            with wave.open(io.BytesIO(chunk.payload), "rb") as wav:
                assert wav.getnframes() == h.fixture.sample_count
                assert wav.readframes(wav.getnframes()) == b"\xa0\x0f" * h.fixture.sample_count
            observed.append(chunk.duration)
            return candidate(chunk, [(17, 3901, "Kubernetes API")], text="different top-level private text")
        return candidate(chunk, [(0, round(chunk.duration * 16000), "Kubernetes API")])
    a, _, _ = strategies(invoke(h, provider(h, response)))
    assert observed == [Fraction(h.fixture.sample_count, 16000)]
    assert h.calls.count("whole-file") == 1
    assert a["timestamp_diagnostics"]["supported_intervals"] == [{"start_sample": 17, "end_sample": 3901}]
    assert a["timestamp_diagnostics"]["top_level_text_differs"] is True
    assert a["text_metrics"]["word_errors"] == 0
    assert a["speech_metrics"]["covered_speech_samples"] == 3901 - 17


def test_r03_long_segment_crossing_multiple_shorter_segments_measures_legacy(case):
    h = case(count=4096, audio_asr_chunk_target_samples=1024,
             audio_asr_chunk_max_request_samples=4096, audio_asr_chunk_overlap_samples=2048)
    def response(chunk):
        count = round(chunk.duration * 16000)
        if chunk.chunk_id == "chunk-000000":
            return candidate(chunk, [(0, count, "đoạn dài Kubernetes API")])
        return candidate(chunk, [(0, count // 2, "một đoạn ngắn"), (count // 2, count, "đoạn ngắn khác")])
    _, b, _ = strategies(invoke(h, provider(h, response)))
    metrics = b["reconciliation_metrics"]
    assert metrics["overlapping_evidence_samples"] > 0
    assert metrics["conflicting_overlap_segments"] + metrics["unresolved_boundary_segments"] > 0
    assert metrics["baseline_asr_segments"] > metrics["planned_chunks"]
    assert metrics["true_duplicate_utterance_count"] == "UNESTABLISHED"


def test_r04_genuine_repetition_preserved_and_omission_is_deletion(case):
    h = case()
    phrase = "Hello anh Hiếu nha!"
    reference(h, [(0, 2048, phrase), (2048, 4096, phrase)])
    def response(chunk):
        return candidate(chunk, [(0, 2048, phrase), (2048, 4096, phrase)])
    a, b, _ = strategies(invoke(h, provider(h, response)))
    assert a["text_metrics"]["reference_words"] == b["text_metrics"]["hypothesis_words"] == 8
    assert b["text_metrics"]["word_errors"] == 0
    a, b, _ = strategies(invoke(h, provider(h, lambda chunk: candidate(chunk, [(0, 2048, phrase)]))))
    assert a["text_metrics"]["word_deletions"] == b["text_metrics"]["word_deletions"] == 4
    assert b["speech_metrics"]["missed_samples"] == 2048


def test_r05_overlapping_hypotheses_raw_insertions_separate_from_legacy_cleanup(case):
    h = case(count=4096, audio_asr_chunk_target_samples=2048,
             audio_asr_chunk_max_request_samples=3072, audio_asr_chunk_overlap_samples=1024)
    def response(chunk):
        # Real same-occurrence support: identical absolute bounds inside both
        # requests, not merely equal wording at displaced request timestamps.
        if chunk.chunk_id.startswith("recovery-"):
            return candidate(chunk, [(0, round(chunk.duration * 16000), "Kubernetes API")])
        offset = 0 if chunk.chunk_id in ("whole-file", "chunk-000000") else 1536
        return candidate(chunk, [(1792 - offset, 2304 - offset, "Kubernetes API")])
    _, b, _ = strategies(invoke(h, provider(h, response)))
    assert b["reconciliation_metrics"]["overlapping_evidence_samples"] > 0
    assert b["provider_text_metrics"]["word_insertions"] > 0
    assert b["reconciliation_metrics"]["duplicate_overlap_segments"] > 0
    assert b["reconciliation_metrics"]["true_duplicate_utterance_count"] == "UNESTABLISHED"
    assert b["text_metrics"]["word_errors"] == 0  # Existing algorithm, not evaluator deduplication.


def test_r05_displaced_equal_hypotheses_remain_ambiguous_instead_of_fabricated_duplicates(case):
    h = case(count=4096, audio_asr_chunk_target_samples=2048,
             audio_asr_chunk_max_request_samples=3072, audio_asr_chunk_overlap_samples=1024)
    _, b, _ = strategies(invoke(h))
    assert b["provider_text_metrics"]["word_insertions"] > 0
    assert b["reconciliation_metrics"]["duplicate_overlap_segments"] == 0
    assert b["reconciliation_metrics"]["unresolved_boundary_segments"] > 0
    assert b["text_metrics"]["word_insertions"] == b["provider_text_metrics"]["word_insertions"]


def test_r06_recovery_progress_is_not_accuracy_and_can_regress(case):
    # Genuine changed-context observations, not a repeated full-source request.
    h = case(omission=True, audio_asr_chunk_target_samples=2048,
             audio_asr_chunk_max_request_samples=2304, audio_asr_chunk_overlap_samples=256)
    def response(chunk):
        count = round(chunk.duration * 16000)
        if chunk.chunk_id.startswith("chunk-"):
            return candidate(chunk, [])
        text = "lời sai hoàn toàn" if chunk.chunk_id.startswith("recovery-") else "Kubernetes API"
        return candidate(chunk, [(0, count, text)])
    record = invoke(h, provider(h, response))
    _, b, c = strategies(record)
    assert c["recovery_metrics"]["meaningful_progress_attempts"] > 0
    assert c["recovery_metrics"]["accepted_attempts"] > 0
    assert c["text_metrics"]["word_errors"] >= b["text_metrics"]["word_errors"]
    assert Fraction(**record["comparison"]["deltas"]["wer"]) >= 0
    assert record["comparison"]["deltas"]["covered_speech_samples"] > 0
    assert record["comparison"]["accuracy_improvement"] is False


def test_r06_canonically_supported_weak_speech_does_not_schedule_recovery(case):
    # The fake PCM is about -18 dBFS: a -10 dBFS floor marks weak speech,
    # but T07 does not retry intact canonical support merely to create a conflict.
    h = case(audio_speech_map_energy_floor_dbfs=-10)
    def response(chunk):
        count = round(chunk.duration * 16000)
        text = "lời khác hoàn toàn" if chunk.chunk_id.startswith("recovery-") else "Kubernetes API"
        return candidate(chunk, [(0, count, text)])
    record = invoke(h, provider(h, response))
    _, b, c = strategies(record)
    assert b["status"] == c["status"] == "PASS"
    assert b["availability"] == c["availability"] == "AVAILABLE"
    assert record["failure_stage"] is None
    assert h.preprocessing_calls == h.closes == 1
    assert c["recovery_metrics"]["successful_recovery_requests"] == 0
    assert c["recovery_metrics"]["failed_recovery_requests"] == 0
    assert c["recovery_metrics"]["meaningful_progress_attempts"] == 0
    assert c["recovery_metrics"]["no_progress_attempts"] == c["recovery_metrics"]["recovery_attempts"] == 0
    assert c["recovery_metrics"]["recovery_stop_reason"] == "no-actionable-regions"
    assert not any(name.startswith("recovery-") for name in h.calls)
    assert b["text_metrics"]["word_errors"] == 0
    assert c["text_metrics"] == b["text_metrics"]
    assert c["provider_text_metrics"] == b["provider_text_metrics"]
    assert record["comparison"]["deltas"]["conflicting_overlap_segments"] == 0
    assert record["comparison"]["deltas"]["unresolved_boundary_segments"] == 0
    assert record["comparison"]["deltas"]["overlapping_evidence_samples"] == 0
    assert record["comparison"]["accuracy_improvement"] is False


def test_r06_low_confidence_alone_does_not_trigger_legacy_recovery(case):
    h = case()
    def response(chunk):
        response = candidate(chunk, [(0, round(chunk.duration * 16000), "Kubernetes API")])
        return replace(response, quality=AsrQualityMetadata(confidence=0.1))
    record = invoke(h, provider(h, response))
    _, b, c = strategies(record)
    assert b["status"] == c["status"] == "PASS"
    assert c["recovery_metrics"]["recovery_attempts"] == 0
    assert c["recovery_metrics"]["recovery_stop_reason"] == "no-actionable-regions"
    assert not any(name.startswith("recovery-") for name in h.calls)
    assert record["comparison"]["additional_recovery_requests"] == 0
    assert record["comparison"]["accuracy_improvement"] is False


@pytest.mark.parametrize("floor, expected", [(-60, PreprocessingStatus.COMPLETED),
                                            (-10, PreprocessingStatus.COMPLETED_WITH_WARNINGS)])
def test_synthetic_preprocessing_outcome_status_matches_actual_map_warnings(case, floor, expected):
    h = case(audio_speech_map_energy_floor_dbfs=floor)
    source = AudioSource(h.fixture.fixture_id, h.root / h.fixture.path)
    with h.preprocessing.run(source) as outcome:
        assert outcome.status is expected
        assert bool(outcome.result.warnings) == (expected is PreprocessingStatus.COMPLETED_WITH_WARNINGS)
        assert outcome.provenance == outcome.result.provenance
        assert outcome.provenance.speech_map == outcome.result.speech_map.provenance
        assert outcome.result.speech_map.provenance.effective_configuration["energy_floor_dbfs"] == floor
        if expected is PreprocessingStatus.COMPLETED_WITH_WARNINGS:
            assert SpeechMapWarning.WEAK_SPEECH in outcome.result.warnings
            assert outcome.result.speech_map.quality.weak_speech_frame_count > 0
        assert hashlib.sha256(source.path.read_bytes()).hexdigest() == h.fixture.source_sha256
    assert h.closes == h.preprocessing_calls == 1
    assert h.calls == []


def test_r07_missing_speech_independent_of_vad_and_text(case):
    h = case()
    a, b, c = strategies(invoke(h, provider(h, lambda chunk: candidate(chunk, []))))
    assert a["status"] == "FAIL"  # No real timestamp evidence; no synthetic fallback.
    for row in (b, c):
        assert row["speech_metrics"]["missed_samples"] == h.fixture.sample_count
        assert row["speech_metrics"]["coverage_rate"] == {"numerator": 0, "denominator": 1}
        assert row["text_metrics"]["word_deletions"] == 2


def test_r08_confirmed_non_speech_hallucination_has_separate_denominator(case):
    h = case(speech=False, hallucination=True)
    for row in strategies(invoke(h)):
        assert row["speech_metrics"]["hallucinated_samples"] == h.fixture.sample_count
        assert row["speech_metrics"]["missed_samples"] == 0
        assert row["speech_metrics"]["coverage_rate"] is None
        assert row["text_metrics"]["wer"] is None
        assert row["text_metrics"]["word_insertions"] == 2


@pytest.mark.parametrize("failure", ["timeout", "transport", "malformed_output", "missing", "reversed", "outside"])
def test_r09_whole_file_failures_never_substitute_chunked_output(case, failure, caplog):
    h = case()
    def response(chunk):
        if chunk.chunk_id != "whole-file":
            return candidate(chunk, [(0, round(chunk.duration * 16000), "Kubernetes API")])
        if failure in {"timeout", "transport", "malformed_output"}:
            if failure == "timeout":
                raise TimeoutError("private-provider-body")
            raise AsrError(AsrErrorCategory(failure))
        if failure == "missing":
            return candidate(chunk, [], text="private-provider-body")
        if failure == "reversed":
            return candidate(chunk, [(300, 100, "private-provider-body")])
        return candidate(chunk, [(0, h.fixture.sample_count + 1, "private-provider-body")])
    record = invoke(h, provider(h, response))
    a, b, _ = strategies(record)
    assert a["status"] == "FAIL" and a["text_metrics"] is a["speech_metrics"] is None
    assert a["sanitized_failure"] == (failure if failure in {"timeout", "transport"} else "malformed_output")
    assert b["text_metrics"]["word_errors"] == 0
    assert h.calls.count("whole-file") == 1
    assert "private-provider-body" not in canonical_json(record) + caplog.text


def test_r09_payload_rejection_is_local_and_not_a_call(case):
    h = case(count=4096, audio_asr_chunk_target_samples=1024,
             audio_asr_chunk_max_request_samples=1280, audio_asr_chunk_overlap_samples=128,
             audio_asr_max_payload_bytes=2604)
    a, b, c = strategies(invoke(h))
    assert a["status"] == "UNAVAILABLE" and a["sanitized_failure"] == "resource"
    assert a["resource_telemetry"]["whole_file_asr_calls"] == 0
    assert "whole-file" not in h.calls
    assert b["reconciliation_metrics"]["successful_baseline_chunks"] == 4
    assert c["resource_telemetry"]["shared_baseline_asr_calls"] == 4


def test_r09_chunk_failures_are_not_hidden(case):
    h = case(recover=False)
    def fail(chunk):
        raise AsrError(AsrErrorCategory.TRANSPORT)
    record = invoke(h, provider(h, fail))
    _, b, _ = strategies(record)
    assert b["reconciliation_metrics"]["failed_baseline_chunks"] == 1
    assert b["speech_metrics"]["missed_samples"] == h.fixture.sample_count
    assert record["telemetry"]["asr_failures"] == len(h.calls)


def test_r10_missing_reference_returns_three_unavailable_records_without_provider(case):
    h = case()
    (h.root / h.fixture.reference.path).unlink()
    record = invoke(h)
    assert record["quality_status"] == "UNAVAILABLE"
    assert record["failure_stage"] == "assets"
    assert all(row["sanitized_failure"] == "assets-or-reference-unavailable" for row in strategies(record))
    assert all(row["status"] == "UNAVAILABLE" and row["text_metrics"] is None for row in strategies(record))
    assert h.calls == [] and h.preprocessing_calls == 0


def test_r11_unique_calls_incremental_and_inclusive_costs(case):
    h = case(audio_asr_chunk_target_samples=2048,
             audio_asr_chunk_max_request_samples=2304, audio_asr_chunk_overlap_samples=256)
    def response(chunk):
        text = "" if chunk.chunk_id.startswith("chunk-") else "Kubernetes API"
        return candidate(chunk, [(0, round(chunk.duration * 16000), text)] if text else [])
    record = invoke(h, provider(h, response))
    a, b, c = strategies(record)
    totals = record["telemetry"]
    assert totals["total_unique_asr_calls"] == len(h.calls)
    assert totals["total_unique_asr_calls"] == 1 + totals["shared_baseline_asr_calls"] + totals["additional_recovery_calls"]
    baseline_cost = Fraction(**b["provider_telemetry"]["reported_cost"])
    recovery_cost = Fraction(**c["incremental_provider_telemetry"]["reported_cost"])
    assert Fraction(**c["provider_telemetry"]["reported_cost"]) == baseline_cost + recovery_cost
    assert Fraction(**totals["reported_cost"]) == Fraction(**a["provider_telemetry"]["reported_cost"]) + baseline_cost + recovery_cost
    assert totals["additional_recovery_calls"] > 0
    assert record["comparison"]["additional_recovery_requests"] == totals["additional_recovery_calls"]


def test_r11_missing_cost_is_unknown_not_zero_or_estimated(case):
    h = case()
    def response(chunk):
        return candidate(chunk, [(0, round(chunk.duration * 16000), "Kubernetes API")],
                         cost=None if chunk.chunk_id == "whole-file" else Fraction(1, 10))
    telemetry = invoke(h, provider(h, response))["telemetry"]
    assert telemetry["reported_cost"] is None
    assert telemetry["reported_cost_call_count"] < telemetry["total_unique_asr_calls"]
    assert telemetry["reported_cost_subtotal"] is not None


def test_r12_no_correction_instantiation_or_invocation(case, monkeypatch):
    from sme_meeting_ai.providers.openrouter_instruction_llm import (
        OpenRouterInstructionLlmAdapter,
    )
    from sme_meeting_ai.transcription import correction
    def forbidden(*args, **kwargs):
        raise AssertionError("correction forbidden")
    monkeypatch.setattr(OpenRouterInstructionLlmAdapter, "__init__", forbidden)
    monkeypatch.setattr(correction, "correct_transcript", forbidden)
    h = case(transcript_correction_model=None)
    h.corrector.complete = forbidden
    assert len(invoke(h)["strategies"]) == 3


def test_r13_private_text_paths_credentials_diagnostics_never_serialize(case, caplog):
    h = case(transcript_correction_model="private-correction-model")
    h.settings.openrouter_api_key = SecretStr("private-credential-marker")
    reference(h, [(0, 4096, "private-reference-marker")])
    provenance = AsrProvenance("openrouter", "openai/whisper-large-v3", "private-resolved-marker",
                               "private-upstream-marker", (("prompt", "private-prompt-marker"),))
    def response(chunk):
        return candidate(chunk, [(0, round(chunk.duration * 16000), "private-candidate-marker")],
                         text="private-top-level-marker", provenance=provenance)
    record = invoke(h, provider(h, response))
    rendered = canonical_json(record) + caplog.text
    for marker in ("private-reference-marker", "private-credential-marker", "private-candidate-marker",
                   "private-top-level-marker", "private-resolved-marker", "private-upstream-marker",
                   "private-prompt-marker", "private-correction-model", str(h.root), h.fixture.path):
        assert marker not in rendered
    assert record["telemetry"]["calls"][0]["resolved_model"] is None
    assert record["telemetry"]["calls"][0]["upstream_provider"] is None


def test_r14_controlled_clock_canonical_report_and_identity_incompatibility(case):
    h = case()
    first, second = invoke(h), invoke(h)
    assert canonical_json(first) == canonical_json(second)
    assert first["evaluation_version"] == "asr-strategy-comparison-2"
    assert first["algorithm_scope"] == "current-components"
    assert comparison.compare_records(first, second)["status"] == "COMPARABLE"
    for key in ("dataset_identity", "reference_identity", "configuration_identity", "pipeline_identity"):
        changed = {**second, key: {**second[key], "version": "different"}}
        assert comparison.compare_records(first, changed) == {"status": "INCOMPATIBLE", "deltas": {}}
    original = {**first, "evaluation_version": "asr-strategy-comparison-1"}
    assert comparison.compare_records(original, second) == {"status": "INCOMPATIBLE", "deltas": {}}


@pytest.mark.parametrize("failure", ["malformed_output", "transport"])
def test_failed_recovery_calls_remain_accounted_without_entering_canonical_output(case, failure):
    h = case(audio_asr_chunk_target_samples=2048,
             audio_asr_chunk_max_request_samples=2304, audio_asr_chunk_overlap_samples=256)
    def response(chunk):
        if chunk.chunk_id == "whole-file":
            return candidate(chunk, [(0, round(chunk.duration * 16000), "Kubernetes API")])
        if chunk.chunk_id.startswith("recovery-"):
            if failure == "transport":
                raise AsrError(AsrErrorCategory.TRANSPORT)
            return candidate(chunk, [(10, 1, "private-failed-candidate")])
        return candidate(chunk, [])
    record = invoke(h, provider(h, response))
    _, b, c = strategies(record)
    calls = [call for call in record["telemetry"]["calls"] if call["stage"] == "recovery"]
    assert calls and all(call["failure"] == failure for call in calls)
    assert c["recovery_metrics"]["failed_recovery_requests"] == len(calls)
    assert c["recovery_metrics"]["failed_attempts"] == len(calls)
    assert c["recovery_metrics"]["accepted_attempts"] == 0
    assert c["text_metrics"] == b["text_metrics"]
    assert c["status"] == "FAIL" and c["sanitized_failure"] == "asr-recovery-failure"
    assert record["telemetry"]["total_unique_asr_calls"] == len(h.calls)
    assert "private-failed-candidate" not in canonical_json(record)


def test_rejected_recovery_is_charged_but_not_scored_as_accepted_text(case, monkeypatch):
    h = case(audio_asr_chunk_target_samples=2048,
             audio_asr_chunk_max_request_samples=2304, audio_asr_chunk_overlap_samples=256)
    recover = comparison.recover_speech
    def observed(*args, **kwargs):
        result = recover(*args, **kwargs)
        assert result.attempts and not result.recovered_results
        assert all(a.admission.value == "rejected" for a in result.attempts)
        return result
    monkeypatch.setattr(comparison, "recover_speech", observed)
    def response(chunk):
        return candidate(chunk, []) if chunk.chunk_id.startswith("recovery-") else candidate(
            chunk, [(0, round(chunk.duration * 16000), "Kubernetes API")])
    record = invoke(h, provider(h, response))
    _, b, c = strategies(record)
    assert record["failure_stage"] is None
    assert c["recovery_metrics"]["rejected_attempts"] > 0
    assert c["recovery_metrics"]["accepted_attempts"] == 0
    assert c["provider_telemetry"]["asr_calls"] > b["provider_telemetry"]["asr_calls"]
    assert c["text_metrics"] == b["text_metrics"]
    assert c["provider_text_metrics"] == b["provider_text_metrics"]


def test_recovery_evaluation_failure_cannot_be_reported_as_execution_pass(case, monkeypatch):
    h = case()
    recover = comparison.recover_speech
    def broken(*args, **kwargs):
        return replace(recover(*args, **kwargs), evaluation_failure=AsrErrorCategory.RESOURCE)
    monkeypatch.setattr(comparison, "recover_speech", broken)
    _, b, c = strategies(invoke(h))
    assert b["status"] == "PASS"
    assert c["status"] == c["quality_status"] == "FAIL"
    assert c["sanitized_failure"] == "resource"


def live_assets(h, tmp_path):
    """Only invented files under pytest temp storage; never private workspace data."""
    assets = tmp_path / "assets"
    assets.mkdir()
    cover = h.manifest.fixtures[1].model_copy(update={
        "path": h.fixture.path, "source_sha256": h.fixture.source_sha256,
        "sample_count": h.fixture.sample_count, "anchors": h.fixture.anchors,
    })
    h.manifest = h.manifest.model_copy(update={"fixtures": [h.fixture, cover]})
    for fixture in h.manifest.fixtures:
        (assets / fixture.path).write_bytes((h.root / fixture.path).read_bytes())
        if fixture.reference:
            (assets / fixture.reference.path).write_bytes((h.root / fixture.reference.path).read_bytes())
    (assets / "manifest.json").write_text(canonical_json(h.manifest.model_dump(exclude={"manifest_sha256"})))
    for name in ("models", "configs", "results"):
        (tmp_path / name).mkdir()
    model = tmp_path / "models" / "vad.onnx"
    model.write_bytes(b"invented model control")
    h.settings.audio_vad_model_path = model
    h.settings.audio_vad_model_sha256 = hashlib.sha256(model.read_bytes()).hexdigest()
    h.settings.openrouter_api_key = SecretStr("contract-key")
    original = h.preprocessing.run
    def pinned_preprocessing(source):
        outcome = original(source)
        result = outcome.result
        evidence = replace(result.speech_evidence, provenance=replace(
            result.speech_evidence.provenance, model_sha256=h.settings.audio_vad_model_sha256))
        object.__setattr__(evidence, "iter_frames", result.speech_evidence.iter_frames)
        speech_map = comparison.SpeechMapBuilder(h.settings).build(result.normalized_artifact, evidence)
        provenance = replace(result.provenance, detection=evidence.provenance, speech_map=speech_map.provenance)
        object.__setattr__(outcome, "result", replace(result, speech_evidence=evidence, speech_map=speech_map,
                                                    provenance=provenance, warnings=speech_map.quality.warnings))
        object.__setattr__(outcome, "provenance", provenance)
        return outcome
    h.preprocessing.run = pinned_preprocessing
    config = tmp_path / "configs" / "matrix.json"
    config.write_text(canonical_json(matrix(h).canonical()))
    return assets, config, tmp_path / "results" / "report.json"


@pytest.mark.parametrize("damage", ["opt-in", "approval", "reference", "credential", "model-digest", "missing-model-digest",
                                    "output", "missing-output", "configuration", "budget", "late-source", "symlink"])
def test_r15_entire_live_preflight_rejects_before_any_provider_creation(case, tmp_path, monkeypatch, damage):
    h = case(count=1031)
    root, config, output = live_assets(h, tmp_path)
    monkeypatch.setenv("RUN_ASR_COMPARISON_LIVE", "1")
    budget = 1000
    if damage == "opt-in":
        monkeypatch.delenv("RUN_ASR_COMPARISON_LIVE")
    elif damage == "approval":
        raw = (root / "manifest.json").read_text().replace('"privacy_approved":true', '"privacy_approved":false')
        (root / "manifest.json").write_text(raw)
    elif damage == "reference":
        (root / h.manifest.fixtures[-1].reference.path).unlink()
    elif damage == "credential":
        h.settings.openrouter_api_key = None
    elif damage == "model-digest":
        h.settings.audio_vad_model_sha256 = "0" * 64
    elif damage == "missing-model-digest":
        h.settings.audio_vad_model_sha256 = None
    elif damage == "output":
        output = root / "report.json"
    elif damage == "missing-output":
        output = None
    elif damage == "configuration":
        config.write_text("{}")
    elif damage == "budget":
        budget = 1
    elif damage == "late-source":
        (root / h.fixture.path).write_bytes(b"wrong digest")
    else:
        alias = tmp_path / "alias"
        alias.symlink_to(root, target_is_directory=True)
        root = alias
    created = []
    def create_provider(settings, resources):
        created.append(True)
        return provider(h)
    with pytest.raises(EvaluationError) as caught:
        comparison.run_live_comparison(root, config, output, budget, h.settings,
                                       preprocessing_factory=lambda s, r: h.preprocessing,
                                       transcriber_factory=create_provider, clock=Clock())
    assert created == [] and h.calls == []
    assert str(tmp_path) not in str(caught.value)
    assert h.closes == h.preprocessing_calls
    assert output is None or not output.exists()


def test_r15_budget_preflight_uses_all_plans_and_does_not_reprocess(case, tmp_path, monkeypatch):
    h = case(count=1031, transcript_correction_model=None)
    root, config, output = live_assets(h, tmp_path)
    monkeypatch.setenv("RUN_ASR_COMPARISON_LIVE", "1")
    def create_provider(settings, resources):
        assert h.preprocessing_calls == 2
        return provider(h)
    report = comparison.run_live_comparison(root, config, output, 1000, h.settings,
                                            preprocessing_factory=lambda s, r: h.preprocessing,
                                            transcriber_factory=create_provider, clock=Clock())
    assert h.preprocessing_calls == h.closes == 2
    assert report["telemetry"]["maximum_asr_calls"] == 2 * (1 + 1 + h.settings.audio_asr_recovery_max_total_attempts)
    assert report["telemetry"]["total_unique_asr_calls"] == len(h.calls)
    assert output.is_file()
    assert report["quality_status"] != "PASS"  # No reviewed A gates, even when live path is exercised with fakes.


def test_r15_offline_api_rejects_real_adapter_without_opt_in(case):
    h = case()
    with OpenRouterWhisperAdapter(h.settings) as adapter:
        with pytest.raises(EvaluationError):
            invoke(h, adapter)
    assert h.preprocessing_calls == 0


def test_whole_file_model_and_audio_identity_are_locked(case):
    h = case(audio_asr_model="different/model")
    with pytest.raises(EvaluationError):
        invoke(h)
    assert h.calls == []


def test_cross_strategy_resolved_model_mismatch_blocks_delta(case):
    h = case()
    def response(chunk):
        p = AsrProvenance("openrouter", "openai/whisper-large-v3",
                          "different/model" if chunk.chunk_id == "whole-file" else "openai/whisper-large-v3")
        return candidate(chunk, [(0, round(chunk.duration * 16000), "Kubernetes API")], provenance=p)
    record = invoke(h, provider(h, response))
    assert record["comparison"]["whole_file_vs_baseline"]["status"] == "INCOMPATIBLE"


def test_preprocessing_failure_releases_owned_artifacts_and_no_requests(case):
    h = case()
    original = h.preprocessing.run
    def broken(source):
        outcome = original(source)
        object.__setattr__(outcome.result.normalized_artifact, "sample_count", 1)
        return outcome
    h.preprocessing.run = broken
    record = invoke(h)
    assert record["quality_status"] == "FAIL"
    assert record["failure_stage"] == "preprocessing-validation"
    for row in strategies(record):
        assert row["availability"] == "UNAVAILABLE" and row["status"] == "FAIL"
        assert row["sanitized_failure"] == "validation"
        assert row["text_metrics"] is row["speech_metrics"] is row["recovery_metrics"] is None
    assert h.calls == [] and h.closes == 1


@pytest.mark.parametrize("category", ["validation", "unknown"])
def test_preprocessing_errors_are_not_mislabeled_missing_assets(case, category, caplog):
    from sme_meeting_ai.audio.errors import AudioProcessingError
    h = case()
    def broken(source):
        if category == "validation":
            raise AudioProcessingError("VALIDATION")
        raise RuntimeError("private-preprocessing-diagnostic " + str(source.path))
    h.preprocessing.run = broken
    record = invoke(h)
    assert record["failure_stage"] == "preprocessing"
    assert record["quality_status"] == "FAIL"
    for row in strategies(record):
        assert row["status"] == "FAIL" and row["availability"] == "UNAVAILABLE"
        assert row["sanitized_failure"] == ("validation" if category == "validation" else "evaluation-stage-error")
        assert row["text_metrics"] is row["speech_metrics"] is row["recovery_metrics"] is None
    assert record["telemetry"]["total_unique_asr_calls"] == 0
    assert h.calls == []
    rendered = canonical_json(record) + caplog.text
    assert "private-preprocessing-diagnostic" not in rendered and str(h.root) not in rendered


def test_failed_preprocessing_outcome_preserves_category_and_closes_partial_artifacts(case):
    h = case()
    original = h.preprocessing.run
    def failed(source):
        outcome = original(source)
        return replace(
            outcome, status=PreprocessingStatus.FAILED, result=None,
            completed_stages=(PreprocessingStage.NORMALIZATION, PreprocessingStage.DETECTION),
            failure=PreprocessingFailure(PreprocessingStage.SPEECH_MAP, "VALIDATION"),
            provenance=replace(outcome.provenance, speech_map=None),
            partial_artifacts=(outcome.result.normalized_artifact, outcome.result.speech_evidence))
    h.preprocessing.run = failed
    record = invoke(h)
    assert record["failure_stage"] == "preprocessing"
    assert record["quality_status"] == "FAIL"
    for row in strategies(record):
        assert row["status"] == "FAIL" and row["sanitized_failure"] == "validation"
        assert row["text_metrics"] is row["speech_metrics"] is row["recovery_metrics"] is None
    assert record["telemetry"]["total_unique_asr_calls"] == 0
    assert h.calls == [] and h.closes == h.preprocessing_calls == 1


def test_planner_validation_failure_is_not_mislabeled_missing_assets(case, monkeypatch):
    from sme_meeting_ai.audio.errors import AudioProcessingError
    h = case()
    def failed(self, result):
        raise AudioProcessingError("VALIDATION")
    monkeypatch.setattr(comparison.SpeechAwareAsrChunkPlanner, "plan", failed)
    record = invoke(h)
    assert record["failure_stage"] == "chunk-planning"
    assert record["quality_status"] == "FAIL"
    assert all(row["status"] == "FAIL" and row["sanitized_failure"] == "validation" for row in strategies(record))
    assert record["telemetry"]["total_unique_asr_calls"] == 0
    assert h.calls == [] and h.closes == h.preprocessing_calls == 1


def test_unavailable_whole_file_does_not_look_like_perfect_metrics(case):
    h = case(count=4096, audio_asr_chunk_target_samples=1024,
             audio_asr_chunk_max_request_samples=1280, audio_asr_chunk_overlap_samples=128,
             audio_asr_max_payload_bytes=2604)
    record = invoke(h)
    a, _, _ = strategies(record)
    assert a["text_metrics"] is a["speech_metrics"] is None
    assert record["comparison"]["whole_file_vs_baseline"] == {"status": "UNAVAILABLE", "deltas": {}}


def test_union_overlap_does_not_sum_pairwise_intersections():
    from sme_meeting_ai.audio import SampleInterval
    assert comparison._overlap_samples([SampleInterval(0, 100), SampleInterval(20, 80),
                                        SampleInterval(40, 90)]) == 70
