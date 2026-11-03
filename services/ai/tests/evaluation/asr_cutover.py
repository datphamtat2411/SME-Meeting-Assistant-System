"""T08 production-entry evaluation and fail-closed release evidence.

No alternate pipeline, inference at import, private strings in reports, implicit
dataset search, or deployment side effects. Approvals are externally reviewed
artifacts, not authentication supplied by this test-local evaluator.
"""

import hashlib
import json
import os
import platform
import resource
import time
import traceback
from concurrent.futures import CancelledError
from contextlib import ExitStack
from fractions import Fraction
from importlib.metadata import version
from pathlib import Path
from threading import Lock
from typing import Annotated, Literal
from uuid import NAMESPACE_URL, uuid5

from pydantic import Field, model_validator

from sme_meeting_ai.audio import AudioSource
from sme_meeting_ai.pipeline import OfflineTranscriptionPipeline
from sme_meeting_ai.transcription.asr import AsrTimestampMode
from sme_meeting_ai.transcription.asr_strategy import STRATEGY_VERSION
from sme_meeting_ai.transcription.chunk_planning import SpeechAwareAsrChunkPlanner
from sme_meeting_ai.workers.transcription import (
    ResultValidationError,
    map_result,
    validate_result_bytes,
)

from .support import (
    Bounds,
    Contract,
    Digest,
    EvaluationError,
    Identifier,
    Positive,
    Rational,
    Sample,
    _normalization_integrity,
    canonical_json,
    digest_json,
    file_digest,
    intersect,
    load_manifest,
    merge,
    rational,
    require,
    require_pinned_model,
    samples,
    subtract,
    verify_source,
)
from .transcription_runner import _failure, require_live_evaluation
from .transcription_support import (
    NORMALIZATION_VERSION,
    ReportStatus,
    compute_text_metrics,
    compute_transcription_metrics,
    external_file,
    load_configuration,
    load_reference,
    read_document,
    require_transcription_manifest,
    safe_settings,
    status_of,
    validate_output_path,
)

EVALUATION_VERSION = "asr-cutover-1"
MODEL = "openai/whisper-large-v3"
GATES = tuple(f"G{i:02d}" for i in range(1, 13))
REQUIRED_CONDITIONS = frozenset({
    "short-meetings", "long-meetings", "continuous-speech", "natural-pauses", "multiple-speakers",
    "overlapping-speech", "weak-distant-speech", "noisy-environments", "technical-vocabulary",
    "code-switching", "genuine-repetition", "historical-regression", "silence", "background-noise",
    "music", "no-speech", "low-energy-ambiguous",
})
Condition = Literal[
    "short-meetings", "long-meetings", "continuous-speech", "natural-pauses", "multiple-speakers",
    "overlapping-speech", "weak-distant-speech", "noisy-environments", "technical-vocabulary",
    "code-switching", "genuine-repetition", "historical-regression", "silence", "background-noise",
    "music", "no-speech", "low-energy-ambiguous",
]
Mode = Literal["chunked", "adaptive"]
EvidenceMode = Literal["offline-contract", "approved-replay", "approved-live"]
SignedRate = dict[Literal["numerator", "denominator"], int]


class TextCounts(Contract):
    normalization_version: Literal["vi-nfc-casefold-technical-1"]
    reference_words: Sample
    hypothesis_words: Sample
    word_errors: Sample
    word_substitutions: Sample
    word_deletions: Sample
    word_insertions: Sample
    reference_characters: Sample
    hypothesis_characters: Sample
    character_errors: Sample
    character_substitutions: Sample
    character_deletions: Sample
    character_insertions: Sample
    wer: SignedRate | None
    cer: SignedRate | None

    @model_validator(mode="after")
    def exact(self):
        for unit, rate in (("word", "wer"), ("character", "cer")):
            errors = sum(getattr(self, f"{unit}_{kind}") for kind in ("substitutions", "deletions", "insertions"))
            reference, hypothesis = getattr(self, f"reference_{unit}s"), getattr(self, f"hypothesis_{unit}s")
            require(errors == getattr(self, f"{unit}_errors"), "edit counts")
            require(hypothesis == reference - getattr(self, f"{unit}_deletions") + getattr(self, f"{unit}_insertions"), "edit denominators")
            require(getattr(self, f"{unit}_substitutions") + getattr(self, f"{unit}_deletions") <= reference
                    and getattr(self, f"{unit}_substitutions") + getattr(self, f"{unit}_insertions") <= hypothesis, "edit bounds")
            require(getattr(self, rate) == rational(errors, reference), "exact rate")
        return self


class QualityMetrics(Contract):
    text: TextCounts
    canonical_text: TextCounts | None = None
    confirmed_speech_samples: Sample
    supported_speech_samples: Sample
    missing_speech: list[Bounds]
    missing_material: list[Bounds]
    missing_critical: list[Bounds]
    silence_text_samples: Sample
    noise_text_samples: Sample
    music_text_samples: Sample
    confirmed_silence_samples: Sample = 0
    confirmed_noise_samples: Sample = 0
    confirmed_music_samples: Sample = 0
    unsupported_canonical_risk_samples: Sample
    unresolved_speech_samples: Sample
    false_success: bool

    @model_validator(mode="after")
    def partitions(self):
        require(self.supported_speech_samples + samples(self.missing_speech) == self.confirmed_speech_samples, "speech partition")
        for stream in (self.missing_speech, self.missing_material, self.missing_critical):
            require([(i.start_sample, i.end_sample) for i in stream] ==
                    [(i.start_sample, i.end_sample) for i in merge(stream)], "missing interval union")
        require(not subtract(self.missing_material, self.missing_speech)
                and not subtract(self.missing_critical, self.missing_speech), "missing speech labels")
        require(all(getattr(self, f"{label}_text_samples") <= getattr(self, f"confirmed_{label}_samples")
                    for label in ("silence", "noise", "music")), "independent hallucination denominator")
        return self


class RecoveryMetrics(Contract):
    attempts: Sample
    accepted: Sample
    rejected: Sample
    failed: Sample
    support_gain_samples: Sample
    ambiguity_reduction_samples: Sample = 0
    prevented_regressions: Sample
    requested_samples: Sample

    @model_validator(mode="after")
    def counts(self):
        require(self.attempts == self.accepted + self.rejected + self.failed, "admission counts")
        require(bool(self.accepted) == bool(self.support_gain_samples or self.ambiguity_reduction_samples), "admitted canonical improvement")
        return self


class ResourceMetrics(Contract):
    asr_calls: Sample
    native_calls: Sample
    chunked_calls: Sample
    recovery_calls: Sample
    correction_calls: Sample
    latency_ns: Sample
    source_samples: Positive
    max_payload_bytes: Sample
    peak_concurrent_asr: Sample
    # Linux process high-water RSS, including native allocations and earlier cases.
    # This is deliberately NOT described as isolated per-recording peak memory.
    process_peak_memory_bytes: Positive | None
    known_cost_subtotal: Rational | None
    reported_cost: Rational | None
    unknown_cost_count: Sample
    timeouts: Sample
    resource_failures: Sample

    @model_validator(mode="after")
    def counts(self):
        require(self.asr_calls == self.native_calls + self.chunked_calls + self.recovery_calls, "actual request counts")
        require(self.unknown_cost_count <= self.asr_calls + self.correction_calls, "unknown costs")
        require((self.known_cost_subtotal is not None) == (self.unknown_cost_count < self.asr_calls + self.correction_calls), "known cost subtotal")
        require(self.reported_cost is None if self.unknown_cost_count or not (self.asr_calls + self.correction_calls)
                else self.reported_cost == self.known_cost_subtotal, "cost accounting")
        return self


class Components(Contract):
    provider_contract: Literal["2"]
    strategy: Literal["adaptive-asr-v1"]
    planner: Literal["speech-aware-v2", "speech-aware-v3", "speech-aware-v5", "whole-file-v1"]
    alignment: Literal["boundary-alignment-v2"] | None
    reconciler: Literal["2"]
    coverage: Literal["2"]
    recovery: Literal["2"]
    correction: Literal["1", "2", "3", "4"]
    correction_prompt_identity: Digest
    correction_model_identity: Digest


class CaseRecord(Contract):
    fixture_identity: Digest
    source_sha256: Digest
    reference_sha256: Digest | None
    annotation_sha256: Digest
    configuration_identity: Digest
    pipeline_identity: Digest
    normalization_identity: Digest
    runtime_identity: Digest
    strategy_mode: Mode
    trial: Sample
    evidence_mode: EvidenceMode
    conditions: list[Condition]
    sample_count: Positive
    fixture_kind: Literal["recording", "synthetic"] = "recording"
    human_speech_samples: Sample
    components: Components | None
    metrics: QualityMetrics | None
    recovery: RecoveryMetrics | None
    resources: ResourceMetrics
    provider_upstreams: list[str]
    unknown_upstream_calls: Sample
    publication_validation: ReportStatus
    execution_status: ReportStatus

    @model_validator(mode="after")
    def integrity(self):
        require(self.sample_count == self.resources.source_samples, "source sample count")
        require(self.resources.recovery_calls == (self.recovery.attempts if self.recovery else 0)
                or self.execution_status == "FAIL", "recovery actual calls")
        for identity in self.provider_upstreams:
            require(identity in {"DeepInfra", "deepinfra", "Together", "together", "Groq", "groq", "OpenAI", "openai"}
                    or (identity.startswith("sha256-") and len(identity) == 71
                        and all(c in "0123456789abcdef" for c in identity[7:])), "public upstream identity")
        require(self.conditions == sorted(set(self.conditions))
                and self.provider_upstreams == sorted(set(self.provider_upstreams)), "stable set ordering")
        if self.metrics:
            m = self.metrics
            require(m.confirmed_speech_samples == self.human_speech_samples <= self.sample_count
                    and m.unsupported_canonical_risk_samples <= self.sample_count
                    and m.unresolved_speech_samples <= m.confirmed_speech_samples, "metric sample bounds")
            require(all(i.end_sample <= self.sample_count for stream in
                        (m.missing_speech, m.missing_material, m.missing_critical) for i in stream), "metric interval bounds")
            require(m.confirmed_speech_samples + m.confirmed_silence_samples + m.confirmed_noise_samples
                    + m.confirmed_music_samples <= self.sample_count, "independent label partition")
        return self


class CutoverPolicy(Contract):
    schema_version: Literal[1]
    approval_identity: Digest
    approval_version: Identifier
    manifest_sha256: Digest
    configuration_matrix_sha256: Digest
    reference_identity: Digest
    pipeline_identity: Digest
    trials: Annotated[int, Field(ge=1, le=4)]
    maximum_recordings: Positive
    maximum_source_samples: Positive
    maximum_asr_calls: Positive
    maximum_case_asr_calls: Positive
    maximum_payload_bytes: Positive
    maximum_concurrent_asr: Annotated[int, Field(ge=1, le=4)]
    maximum_recovery_attempts: Sample
    maximum_recovery_samples: Sample
    maximum_latency_ns: Positive | None = None
    maximum_process_memory_bytes: Positive | None = None
    maximum_wer_regression: Rational | None = None
    maximum_cer_regression: Rational | None = None
    maximum_hallucination_sample_regression: Sample | None = None
    maximum_word_insertion_regression: Sample | None = None
    fixture_conditions: dict[Digest, list[Condition]]

    @model_validator(mode="after")
    def scope(self):
        require(self.fixture_conditions and all(v == sorted(set(v)) for v in self.fixture_conditions.values()), "reviewed condition labels")
        require(REQUIRED_CONDITIONS <= set().union(*(set(v) for v in self.fixture_conditions.values())), "condition coverage")
        return self


class Verification(Contract):
    pipeline_identity: Digest
    configuration_matrix_sha256: Digest
    implementation: ReportStatus
    ci: ReportStatus
    publication: ReportStatus
    rollback: ReportStatus
    evidence_sha256: Digest
    ci_commit: Annotated[str, Field(pattern=r"^[a-f0-9]{40}$")]
    ci_run_id: Positive | None

    @model_validator(mode="after")
    def ci_identity(self):
        require(self.ci != "PASS" or (self.ci_run_id is not None and self.ci_commit != "0" * 40), "verified CI run identity")
        return self


class Review(Contract):
    case_sha256: Digest
    gate: Literal["G07", "G08", "G09"]
    status: ReportStatus
    approval_identity: Digest
    evidence_sha256: Digest
    violations: Sample | None = None


class HistoricalCase(Contract):
    fixture_identity: Digest
    source_sha256: Digest
    reference_sha256: Digest | None
    annotation_sha256: Digest
    normalization_identity: Digest
    runtime_identity: Digest
    trial: Sample
    strategy_id: Literal["whole-file", "chunked-baseline", "chunked-recovery"]
    metrics: QualityMetrics
    resources: ResourceMetrics

    @model_validator(mode="after")
    def strategy_calls(self):
        r = self.resources
        if self.strategy_id == "whole-file":
            require(r.native_calls == 1 and r.chunked_calls == r.recovery_calls == 0, "historical whole-file geometry")
        else:
            require(r.native_calls == 0 and r.chunked_calls > 0, "historical chunked identity")
            require(self.strategy_id != "chunked-baseline" or r.recovery_calls == 0, "historical baseline identity")
        return self


class HistoricalEvidence(Contract):
    """An approved original-revision artifact, never a current-harness relabel."""

    manifest_sha256: Digest
    reference_identity: Digest
    model: Literal["openai/whisper-large-v3"]
    language: Literal["vi"]
    normalization_version: Literal["vi-nfc-casefold-technical-1"]
    approval_identity: Digest
    evidence_sha256: Digest
    source_revision: Annotated[str, Field(pattern=r"^[a-f0-9]{40}$")]
    planner_version: Literal["1", "speech-aware-v2"]
    reconciler_version: Literal["1", "2"]
    recovery_version: Literal["1", "2"]
    strategies: list[Literal["whole-file", "chunked-baseline", "chunked-recovery"]]
    cases: list[HistoricalCase] = Field(default_factory=list)

    @model_validator(mode="after")
    def no_correction(self):
        require(all(c.resources.correction_calls == 0 for c in self.cases), "historical ASR-only identity")
        return self


class DeploymentApproval(Contract):
    report_sha256: Digest
    policy_sha256: Digest
    approval_identity: Digest
    deployment_scope_identity: Digest


def pipeline_identity():
    """Content identity covers the checked-out implementation, including dirty T07."""
    root = Path(__file__).resolve().parents[2] / "src/sme_meeting_ai"
    paths = ["pipeline/offline_transcription.py", "pipeline/preprocessing.py", "core/config.py",
             "audio/normalization.py", "audio/detection.py", "audio/speech_map.py", "audio/vad.py", "audio/models.py",
             "transcription/asr.py", "transcription/asr_strategy.py", "transcription/chunk_execution.py",
             "transcription/chunk_planning.py", "transcription/boundary_alignment.py",
             "transcription/reconciliation.py", "transcription/coverage.py", "transcription/recovery.py",
             "transcription/correction.py", "providers/openrouter_whisper.py",
             "providers/openrouter_instruction_llm.py", "workers/transcription.py"]
    # Module filenames are implementation metadata; no input/media paths leave here.
    return digest_json({name: file_digest(root / name) for name in paths})


def fixture_identity(fixture):
    return digest_json({"fixture_id": fixture.fixture_id, "source_sha256": fixture.source_sha256,
                        "reference_sha256": fixture.reference.sha256 if fixture.reference else None,
                        "annotation": fixture.model_dump(include={"labels", "annotation_version", "annotation_origin", "sample_count", "anchors"})})


def reference_identity(cases):
    return digest_json(sorted({(c.fixture_identity, c.reference_sha256, c.annotation_sha256) for c in cases},
                              key=lambda item: item[0]))


def pool_metrics(metrics):
    """Reuse historical edit counts/denominators, never average percentages."""
    values = [TextCounts.model_validate(m).model_dump() for m in metrics]
    require(bool(values), "pooled text evidence")
    output = {"normalization_version": NORMALIZATION_VERSION}
    for unit, rate in (("word", "wer"), ("character", "cer")):
        for key in (f"reference_{unit}s", f"hypothesis_{unit}s", *(f"{unit}_{k}" for k in ("errors", "substitutions", "deletions", "insertions"))):
            output[key] = sum(m[key] for m in values)
        output[rate] = rational(output[f"{unit}_errors"], output[f"reference_{unit}s"])
    return output


def _compatible(baseline, candidate):
    return all(getattr(baseline, key) == getattr(candidate, key) for key in (
        "fixture_identity", "source_sha256", "reference_sha256", "annotation_sha256", "sample_count",
        "normalization_identity", "runtime_identity", "evidence_mode", "trial", "conditions",
    )) and (baseline.components is not None and candidate.components is not None
            and baseline.components.correction_prompt_identity == candidate.components.correction_prompt_identity
            and baseline.components.correction_model_identity == candidate.components.correction_model_identity)


def _pairs(cases):
    keyed = {(c.fixture_identity, c.trial, c.strategy_mode): c for c in cases}
    return [(keyed.get((identity, trial, "chunked")), keyed.get((identity, trial, "adaptive")))
            for identity, trial in sorted({(c.fixture_identity, c.trial) for c in cases})]


def _resources(cases):
    rows = [c.resources for c in cases]
    known = [Fraction(r.known_cost_subtotal.numerator, r.known_cost_subtotal.denominator) for r in rows if r.known_cost_subtotal is not None]
    subtotal = sum(known, Fraction(0))
    unknown = sum(r.unknown_cost_count for r in rows)
    calls = sum(r.asr_calls + r.correction_calls for r in rows)
    return {**{name: sum(getattr(r, name) for r in rows) for name in (
        "asr_calls", "native_calls", "chunked_calls", "recovery_calls", "correction_calls", "latency_ns", "source_samples", "timeouts", "resource_failures")},
        "reported_cost": rational(subtotal.numerator, subtotal.denominator) if calls and not unknown else None,
        "known_cost_subtotal": rational(subtotal.numerator, subtotal.denominator) if known else None,
        "unknown_cost_count": unknown}


def _aggregates(cases):
    output = {}
    for mode in ("chunked", "adaptive"):
        selected = [c for c in cases if c.strategy_mode == mode]
        metrics = [c.metrics for c in selected if c.metrics is not None]
        output[mode] = {
            "executions": len(selected), "available_metrics": len(metrics),
            "text": pool_metrics([m.text.model_dump() for m in metrics]) if metrics else None,
            "canonical_text": pool_metrics([m.canonical_text.model_dump() for m in metrics if m.canonical_text])
                              if metrics and all(m.canonical_text is not None for m in metrics) else None,
            "speech": {"confirmed_speech_samples": sum(m.confirmed_speech_samples for m in metrics),
                       "supported_speech_samples": sum(m.supported_speech_samples for m in metrics),
                       "missing_speech_samples": sum(samples(m.missing_speech) for m in metrics),
                       "material_loss_samples": sum(samples(m.missing_material) for m in metrics),
                       "critical_loss_samples": sum(samples(m.missing_critical) for m in metrics),
                       "largest_contiguous_missing_samples": max((i.end_sample - i.start_sample for m in metrics for i in m.missing_speech), default=0)},
            "hallucination": {name: sum(getattr(m, name) for m in metrics) for name in (
                "silence_text_samples", "noise_text_samples", "music_text_samples", "unsupported_canonical_risk_samples",
                "confirmed_silence_samples", "confirmed_noise_samples", "confirmed_music_samples")},
            "recovery": {name: sum(getattr(c.recovery, name) for c in selected if c.recovery) for name in RecoveryMetrics.model_fields},
            "resources": _resources(selected),
        }
    unique = {c.source_sha256: c for c in cases if c.fixture_kind == "recording"}
    output.update(independent_recordings=len(unique),
                  independently_labeled_speech_samples=sum(c.human_speech_samples for c in unique.values()),
                  independently_labeled_speech_seconds=rational(sum(c.human_speech_samples for c in unique.values())),
                  condition_coverage=sorted({condition for c in cases for condition in c.conditions}))
    return output


def _gate_results(cases, policy, verification, reviews, historical):
    gates = dict.fromkeys(GATES, "UNAVAILABLE")
    paired = _pairs(cases)
    scope = (set(policy.fixture_conditions) == {c.fixture_identity for c in cases}
             and len(cases) == len(policy.fixture_conditions) * policy.trials * 2
             and all(c.trial < policy.trials and c.conditions == policy.fixture_conditions.get(c.fixture_identity)
                     and c.pipeline_identity == policy.pipeline_identity for c in cases)
             and all(a and b for a, b in paired))
    references = (scope and reference_identity(cases) == policy.reference_identity
                  and all(c.evidence_mode != "offline-contract" and c.metrics is not None
                          and (c.reference_sha256 is not None or not c.metrics.confirmed_speech_samples)
                          and c.execution_status == "PASS" for c in cases))
    gates["G01"] = "PASS" if references else "UNAVAILABLE"
    compatible = scope and all(_compatible(a, b) and a.metrics and b.metrics for a, b in paired)
    historical_ok = (historical is not None and historical.manifest_sha256 == policy.manifest_sha256
                     and historical.reference_identity == policy.reference_identity
                     and historical.approval_identity == policy.approval_identity
                     and historical.planner_version == "1"
                     and historical.reconciler_version == historical.recovery_version == "1"
                     and set(historical.strategies) == {"whole-file", "chunked-baseline", "chunked-recovery"}
                     and len(historical.strategies) == 3
                     and len(historical.cases) == len(policy.fixture_conditions) * policy.trials * 3
                     and len({(c.fixture_identity, c.trial, c.strategy_id) for c in historical.cases}) == len(historical.cases))
    if historical_ok:
        by_key = {(c.fixture_identity, c.trial): c for c in cases if c.strategy_mode == "adaptive"}
        historical_ok = all((h.fixture_identity, h.trial) in by_key and all(
            getattr(h, k) == getattr(by_key[h.fixture_identity, h.trial], k) for k in (
                "source_sha256", "reference_sha256", "annotation_sha256", "normalization_identity", "runtime_identity"))
            for h in historical.cases)
    regressions = []
    if compatible:
        critical = []
        for a, b in paired:
            ma, mb = a.metrics, b.metrics
            new_critical = samples(subtract(mb.missing_critical, ma.missing_critical))
            critical.append(new_critical)
            regressions.append({"fixture_identity": b.fixture_identity, "trial": b.trial,
                                "compatible": True, "new_critical_loss_samples": new_critical,
                                "wer_delta": _delta(ma.text.wer, mb.text.wer),
                                "cer_delta": _delta(ma.text.cer, mb.text.cer),
                                "provider_confounded": (a.provider_upstreams != b.provider_upstreams
                                                        or bool(a.unknown_upstream_calls or b.unknown_upstream_calls)),
                                "routing_controlled": False})
        gates["G02"] = "FAIL" if any(critical) else "PASS"
        for gate, metric, maximum in (("G04", "wer", policy.maximum_wer_regression), ("G05", "cer", policy.maximum_cer_regression)):
            if maximum is None:
                gates[gate] = "UNESTABLISHED"
                continue
            bound = Fraction(maximum.numerator, maximum.denominator)
            deltas = [Fraction(**r[f"{metric}_delta"]) for r in regressions if r[f"{metric}_delta"] is not None]
            pooled = _aggregates(cases)
            overall = _delta(pooled["chunked"]["text"][metric], pooled["adaptive"]["text"][metric])
            canonical_deltas = [_delta(getattr(a.metrics.canonical_text, metric), getattr(b.metrics.canonical_text, metric))
                                for a, b in paired if a.metrics.canonical_text and b.metrics.canonical_text]
            deltas.extend(Fraction(**d) for d in canonical_deltas if d is not None)
            canonical = [pooled[m]["canonical_text"] for m in ("chunked", "adaptive")]
            canonical_overall = _delta(canonical[0][metric], canonical[1][metric]) if all(canonical) else None
            if canonical_overall is not None:
                deltas.append(Fraction(**canonical_overall))
            gates[gate] = ("UNAVAILABLE" if not deltas or overall is None or canonical_overall is None else
                           "PASS" if max([*deltas, Fraction(**overall)]) <= bound else "FAIL")
        if policy.maximum_hallucination_sample_regression is None or policy.maximum_word_insertion_regression is None:
            gates["G06"] = "UNESTABLISHED"
        else:
            gates["G06"] = "PASS" if all(
                all(getattr(b.metrics, label) - getattr(a.metrics, label) <= policy.maximum_hallucination_sample_regression
                    for label in ("silence_text_samples", "noise_text_samples", "music_text_samples"))
                and b.metrics.text.word_insertions - a.metrics.text.word_insertions <= policy.maximum_word_insertion_regression
                for a, b in paired) else "FAIL"
    else:
        regressions = [{"fixture_identity": b.fixture_identity if b else a.fixture_identity, "trial": b.trial if b else a.trial,
                        "compatible": False, "new_critical_loss_samples": None, "wer_delta": None, "cer_delta": None,
                        "provider_confounded": True, "routing_controlled": False} for a, b in paired]
    historical_cases = [c for c in cases if c.strategy_mode == "adaptive" and "historical-regression" in c.conditions]
    if historical_cases and all(c.metrics is not None for c in historical_cases):
        gates["G03"] = "FAIL" if any(samples(c.metrics.missing_material) or samples(c.metrics.missing_critical)
                                                     or c.metrics.false_success for c in historical_cases) else "PASS"
    for gate in ("G07", "G08", "G09"):
        checked = []
        for c in cases:
            if c.strategy_mode != "adaptive":
                continue
            matches = [r for r in reviews if r.case_sha256 == digest_json(c.model_dump()) and r.gate == gate
                       and r.approval_identity == policy.approval_identity]
            if len(matches) != 1:
                checked.append("UNAVAILABLE")
            else:
                review = matches[0]
                checked.append("FAIL" if review.violations else "UNAVAILABLE" if review.status == "PASS" and review.violations is None else review.status)
        gates[gate] = status_of(checked) if checked else "UNAVAILABLE"
    if policy.maximum_latency_ns is None or policy.maximum_process_memory_bytes is None:
        gates["G10"] = "UNESTABLISHED"
    elif cases and all(c.resources.process_peak_memory_bytes is not None for c in cases):
        within = all(c.resources.asr_calls <= policy.maximum_case_asr_calls
                     and c.resources.max_payload_bytes <= policy.maximum_payload_bytes
                     and c.resources.peak_concurrent_asr <= policy.maximum_concurrent_asr
                     and c.resources.latency_ns <= policy.maximum_latency_ns
                     and c.resources.process_peak_memory_bytes <= policy.maximum_process_memory_bytes
                     and c.resources.resource_failures == 0
                     and c.sample_count <= policy.maximum_source_samples
                     and (not c.recovery or (c.recovery.attempts <= policy.maximum_recovery_attempts
                                            and c.recovery.requested_samples <= policy.maximum_recovery_samples)) for c in cases)
        within = within and sum(c.resources.asr_calls for c in cases) <= policy.maximum_asr_calls
        gates["G10"] = "PASS" if within else "FAIL"
    gates["G11"] = status_of([verification.publication, *(c.publication_validation for c in cases)])
    gates["G12"] = verification.rollback
    if any(c.evidence_mode == "approved-replay" for c in cases) and gates["G10"] != "FAIL":
        # Local replay time/cost does not establish live acoustic resource bounds.
        gates["G10"] = "UNAVAILABLE"
    return gates, regressions, compatible and historical_ok


def _delta(before, after):
    if before is None or after is None:
        return None
    value = Fraction(**after) - Fraction(**before)
    return rational(value.numerator, value.denominator)


def assemble_report(cases, policy, verification, *, reviews=(), historical=None):
    """Closed-schema assembly. Arbitrary input fields/text never pass through."""
    __tracebackhide__ = True
    try:
        return _assemble(cases, policy, verification, reviews, historical)
    except Exception as error:
        traceback.clear_frames(error.__traceback__)
    raise EvaluationError("cutover report invalid or unavailable") from None


def _assemble(cases, policy, verification, reviews, historical):
    policy = CutoverPolicy.model_validate(policy)
    verified = Verification.model_validate(verification)
    cases = sorted((CaseRecord.model_validate(c) for c in cases), key=lambda c: (c.fixture_identity, c.trial, c.strategy_mode))
    require(len({(c.fixture_identity, c.trial, c.strategy_mode) for c in cases}) == len(cases), "unique paired cases")
    require(len({c.fixture_identity for c in cases}) <= policy.maximum_recordings, "maximum evaluation scope")
    reviews = sorted((Review.model_validate(r) for r in reviews), key=lambda r: (r.case_sha256, r.gate))
    historical = HistoricalEvidence.model_validate(historical) if historical is not None else None
    if historical is not None:
        historical = historical.model_copy(update={"cases": sorted(historical.cases, key=lambda c: (c.fixture_identity, c.trial, c.strategy_id)),
                                                   "strategies": sorted(historical.strategies)})
    gates, regressions, comparable = _gate_results(cases, policy, verified, reviews, historical)
    matched = (verified.pipeline_identity == policy.pipeline_identity
               and verified.configuration_matrix_sha256 == policy.configuration_matrix_sha256)
    if not matched:
        gates["G11"] = gates["G12"] = "UNAVAILABLE"
    components = sorted({canonical_json(c.components.model_dump()) for c in cases if c.components})
    historical_comparisons = []
    if historical and comparable:
        for old in sorted(historical.cases, key=lambda c: (c.fixture_identity, c.trial, c.strategy_id)):
            current = next(c for c in cases if (c.fixture_identity, c.trial, c.strategy_mode) == (old.fixture_identity, old.trial, "adaptive"))
            historical_comparisons.append({"fixture_identity": old.fixture_identity, "trial": old.trial,
                                           "historical_strategy": old.strategy_id,
                                           "wer_delta": _delta(old.metrics.text.wer, current.metrics.canonical_text.wer) if current.metrics.canonical_text else None,
                                           "cer_delta": _delta(old.metrics.text.cer, current.metrics.canonical_text.cer) if current.metrics.canonical_text else None,
                                           "provider_confounded": True, "correction_included": False})
    aggregates = _aggregates(cases)
    for mode in ("chunked", "adaptive"):
        for label in ("silence", "noise", "music"):
            group = aggregates[mode]["hallucination"]
            group[f"{label}_text_rate"] = rational(group[f"{label}_text_samples"], group[f"confirmed_{label}_samples"])
    aggregates["reviewed_violations"] = [{"case_sha256": r.case_sha256, "gate": r.gate, "violations": r.violations} for r in reviews]
    report = {
        "report_schema_version": 1, "evaluation_version": EVALUATION_VERSION,
        "pipeline_version": policy.pipeline_identity,
        "dataset_identity": policy.manifest_sha256, "reference_identity": reference_identity(cases),
        "configuration_identity": policy.configuration_matrix_sha256,
        "model_identity": {"gateway": "openrouter", "model": MODEL, "language": "vi"},
        "provider_routing_mode": "dynamic", "strategy_identity": ["chunked", "adaptive"],
        "component_versions": [json.loads(c) for c in components],
        "quality_gate_status": gates, "quality_metrics": aggregates,
        "regression_results": regressions, "baseline_compatible": comparable,
        "historical_comparisons": historical_comparisons,
        "historical_gate_version": "mandatory-zero-material-loss-1",
        "resource_metrics": _resources(cases), "publication_validation": gates["G11"],
        "rollback_readiness": gates["G12"], "release_decision": "NO-GO",
        "policy_sha256": digest_json(policy.model_dump()),
        "policy": policy.model_dump(),
        "verification": verified.model_dump(), "reviews": [r.model_dump() for r in reviews],
        # Historical evidence contents stay external: versions + identity digest only.
        "historical_evidence": historical.model_dump() if historical else None,
        "cases": [c.model_dump() for c in cases],
    }
    report["report_sha256"] = digest_json(report)
    return report


def validate_report(report, policy=None):
    require(isinstance(report, dict), "report object")
    policy = policy if policy is not None else report["policy"]
    expected = assemble_report(report["cases"], policy, report["verification"], reviews=report["reviews"], historical=report["historical_evidence"])
    require(canonical_json(report) == canonical_json(expected), "report integrity and derived gates")
    return report


def serialize_report(report):
    __tracebackhide__ = True
    try:
        validate_report(report)
        return canonical_json(report).encode("utf-8")
    except Exception as error:
        traceback.clear_frames(error.__traceback__)
    raise EvaluationError("cutover report serialization invalid") from None


def evaluate_readiness(report, policy, deployment_approval=None):
    """Pure decision; no provider calls, configuration writes or deployment."""
    reasons = []
    implementation = quality = "UNAVAILABLE"
    try:
        policy = CutoverPolicy.model_validate(policy)
        validate_report(report, policy)
        implementation = report["verification"]["implementation"]
        quality = status_of(report["quality_gate_status"].values())
        reasons.extend(gate for gate in GATES if report["quality_gate_status"][gate] != "PASS")
        for key in ("implementation", "ci", "publication", "rollback"):
            if report["verification"][key] != "PASS":
                reasons.append(key.upper())
        if not report["baseline_compatible"]:
            reasons.append("BASELINE_INCOMPATIBLE")
        if not report["cases"] or any(c["evidence_mode"] == "offline-contract" for c in report["cases"]):
            reasons.append("QUALITY_EVIDENCE_REQUIRED")
        approval = DeploymentApproval.model_validate(deployment_approval) if deployment_approval is not None else None
        if (approval is None or approval.report_sha256 != report["report_sha256"]
                or approval.policy_sha256 != report["policy_sha256"] or approval.approval_identity != policy.approval_identity):
            reasons.append("DEPLOYMENT_APPROVAL_REQUIRED")
    except Exception as error:
        traceback.clear_frames(error.__traceback__)
        reasons.append("REPORT_OR_APPROVAL_INVALID")
    return {"production_decision": "NO-GO" if reasons else "GO", "deployment_performed": False,
            "implementation_status": "IMPLEMENTATION_READY" if implementation == "PASS" else "IMPLEMENTATION_UNVERIFIED",
            "quality_status": {"PASS": "QUALITY_APPROVED", "FAIL": "QUALITY_FAILED", "UNAVAILABLE": "EVALUATION_UNAVAILABLE",
                               "UNESTABLISHED": "QUALITY_UNESTABLISHED"}[quality], "blocking_reasons": sorted(set(reasons))}


class ReplayProvider:
    """Borrow externally approved transient responses, keyed by actual WAV bytes.

    Changing acoustic geometry, duration or timestamp mode requires captured data.
    This reproduces downstream processing only, never a fresh acoustic inference.
    """

    def __init__(self, responses, *, approval_identity, capabilities=None):
        require(len(approval_identity) == 64 and all(c in "0123456789abcdef" for c in approval_identity), "replay approval")
        self._responses = dict(responses)
        self.capabilities = capabilities

    def transcribe_request(self, request):
        key = (hashlib.sha256(request.audio.payload).hexdigest(), request.audio.duration, request.timestamp_mode)
        require(key in self._responses, "captured request geometry unavailable")
        response = self._responses[key]
        require(response.chunk_id == request.audio.chunk_id, "captured request identity")
        return response

    def transcribe(self, audio):
        from sme_meeting_ai.transcription.asr import AsrTranscriptionRequest

        return self.transcribe_request(AsrTranscriptionRequest(audio, AsrTimestampMode.SEGMENT))


class ReplayCorrector:
    """Only explicitly captured correction requests; no uncaptured GPT substitute."""

    def __init__(self, responses, *, approval_identity):
        require(len(approval_identity) == 64 and all(c in "0123456789abcdef" for c in approval_identity), "replay approval")
        self._responses = dict(responses)

    @staticmethod
    def request_identity(request):
        return digest_json({"model": request.model, "system_prompt": request.system_prompt,
                            "transcript_json": request.transcript_json,
                            "max_output_tokens": request.max_output_tokens,
                            "temperature": request.temperature, "reasoning_effort": request.reasoning_effort})

    def complete(self, request):
        identity = self.request_identity(request)
        require(identity in self._responses, "captured correction request unavailable")
        return self._responses[identity]


class _CallLedger:
    """Counts actual adapter invocations, including rejected Recovery and errors."""

    def __init__(self, maximum):
        self.maximum, self.calls, self.lock = maximum, 0, Lock()

    def reserve(self):
        from sme_meeting_ai.transcription.asr import AsrError, AsrErrorCategory

        with self.lock:
            if self.calls >= self.maximum:
                raise AsrError(AsrErrorCategory.RESOURCE)
            self.calls += 1


class _MeasuredProviders:
    def __init__(self, asr, corrector, reference_text, ledger):
        self.asr, self.corrector = asr, corrector
        self.reference_text = reference_text
        self.ledger = ledger
        self.asr_calls = self.correction_calls = self.active = self.peak = self.payload = 0
        self.known = Fraction(0)
        self.cost_count = self.timeouts = self.resource_failures = 0
        self.canonical_metrics = None
        self.lock = Lock()

    @property
    def capabilities(self):
        return getattr(self.asr, "capabilities", None)

    def _invoke(self, function, argument, *, audio=None):
        response = None
        if audio is not None:
            self.ledger.reserve()
        with self.lock:
            if audio is not None:
                self.asr_calls += 1
                self.active += 1
                self.peak = max(self.peak, self.active)
                self.payload = max(self.payload, len(audio.payload))
            else:
                self.correction_calls += 1
        try:
            response = function(argument)
            return response
        except Exception as error:
            category = _failure(error)
            with self.lock:
                self.timeouts += int(category == "timeout" or isinstance(error, TimeoutError))
                self.resource_failures += int(category == "resource" or isinstance(error, (OSError, MemoryError)))
            raise
        finally:
            usage = getattr(response, "usage", None)
            cost = getattr(usage, "cost", None)
            with self.lock:
                if isinstance(cost, Fraction) and cost >= 0:
                    self.known += cost
                    self.cost_count += 1
                if audio is not None:
                    self.active -= 1
            response = argument = audio = None

    def transcribe(self, audio):
        return self._invoke(self.asr.transcribe, audio, audio=audio)

    def transcribe_request(self, request):
        operation = getattr(self.asr, "transcribe_request", None)
        if callable(operation):
            return self._invoke(operation, request, audio=request.audio)
        return self.transcribe(request.audio)

    def complete(self, request):
        entries = json.loads(request.transcript_json)["segments"]
        self.canonical_metrics = compute_text_metrics(self.reference_text, " ".join(e["text"] for e in entries))
        entries = None
        return self._invoke(self.corrector.complete, request)


def _publication(outcome, settings, source_id, source_sha256, speech_samples):
    ids = dict(job_id=str(uuid5(NAMESPACE_URL, source_sha256 + ":job")), media_id=source_id,
               source_revision=source_sha256, producer_id=str(uuid5(NAMESPACE_URL, source_sha256 + ":producer")))
    raw = None
    try:
        raw = map_result(outcome, settings, **ids)
        validate_result_bytes(raw, **ids)
        return "PASS"
    except ResultValidationError as error:
        # Negative controls must fail publication when there is no final text.
        if (error.category == "EMPTY_OUTPUT" and not speech_samples and outcome.failure is None
                and outcome.result is not None and not outcome.result.segments):
            return "PASS"
        return "FAIL"
    finally:
        raw = None


def run_production_case(manifest, fixture, root, preprocessing, transcriber, corrector, settings, *,
                        evidence_mode="offline-contract", conditions=(), trial=0, clock=time.monotonic_ns,
                        ledger=None, authorized_live=False, authorization_scope="cutover"):
    """One call to the actual production entry, with measured borrowed adapters.

    Missing input evidence returns UNAVAILABLE without inference. Execution errors
    remain failures. Raw transcripts/prompts/responses are transient only.
    """
    __tracebackhide__ = True
    require(evidence_mode in ("offline-contract", "approved-replay", "approved-live"), "evidence mode")
    require(authorization_scope in ("cutover", "pilot"), "explicit evaluation authorization scope")
    if evidence_mode == "approved-live":
        require(authorized_live, "dataset-wide live preflight")
        require_live_evaluation(settings)
        opt_in = "RUN_ASR_CUTOVER_LIVE" if authorization_scope == "cutover" else "RUN_ASR_PILOT_LIVE"
        require(os.environ.get(opt_in) == "1", "scoped live opt-in")
    else:
        from sme_meeting_ai.providers.openrouter_instruction_llm import (
            OpenRouterInstructionLlmAdapter,
        )
        from sme_meeting_ai.providers.openrouter_whisper import OpenRouterWhisperAdapter

        require(not isinstance(transcriber, OpenRouterWhisperAdapter) and not isinstance(corrector, OpenRouterInstructionLlmAdapter), "injected offline providers")
    if evidence_mode == "approved-replay":
        require(isinstance(transcriber, ReplayProvider) and isinstance(corrector, ReplayCorrector), "approved request-bound replay")
    require(settings.audio_asr_model == MODEL and settings.audio_asr_language == "vi", "locked model and language")
    identity = fixture_identity(fixture)
    row = {
        "fixture_identity": identity, "source_sha256": fixture.source_sha256,
        "reference_sha256": fixture.reference.sha256 if fixture.reference else None,
        "annotation_sha256": digest_json(fixture.model_dump(include={"labels", "sample_count", "annotation_version", "annotation_origin", "anchors"})),
        "configuration_identity": digest_json(safe_settings(settings)), "pipeline_identity": pipeline_identity(),
        "normalization_identity": "0" * 64,
        "runtime_identity": digest_json({"python": platform.python_version(), "numpy": version("numpy"),
                                        "onnxruntime": version("onnxruntime"), "vad_asset": settings.audio_vad_model_sha256}),
        "strategy_mode": settings.audio_asr_strategy_mode, "trial": trial, "evidence_mode": evidence_mode,
        "conditions": sorted(conditions), "sample_count": fixture.sample_count,
        "fixture_kind": fixture.kind, "human_speech_samples": samples(label for label in fixture.labels if label.label == "speech"),
        "components": None, "metrics": None, "recovery": None, "provider_upstreams": [],
        "unknown_upstream_calls": 0, "publication_validation": "UNAVAILABLE", "execution_status": "UNAVAILABLE",
    }
    measured = None
    outcome = reference = source = reference_text = None
    started = clock()
    try:
        require(fixture in manifest.fixtures, "fixture membership")
        path = external_file(root, fixture.path)
        verify_source(root, fixture)
        speech = [label for label in fixture.labels if label.label == "speech"]
        if speech:
            reference = load_reference(root, fixture)
            reference_text = " ".join(s.text for s in reference.segments if s.label == "speech")
        else:
            reference_text = ""
        source = AudioSource(str(uuid5(NAMESPACE_URL, identity)), path)
        measured = _MeasuredProviders(transcriber, corrector, reference_text, ledger or _CallLedger(65793))

        class CheckedPreprocessing:
            def run(self, audio_source):
                owned = preprocessing.run(audio_source)
                try:
                    if owned.result is not None:
                        result = owned.result
                        require(result.normalized_artifact.source_id == audio_source.source_id, "exact source identity")
                        normalized = _normalization_integrity(fixture, result.normalized_artifact)
                        row["normalization_identity"] = digest_json({
                            "pcm": normalized["normalized_pcm_sha256"], "provenance": {
                                "normalizer": result.provenance.normalization.normalizer_version,
                                "decoder": result.provenance.normalization.decoder_version,
                                "format": dict(result.provenance.normalization.target_format),
                            }})
                    return owned
                except BaseException:
                    owned.close()
                    raise

        outcome = OfflineTranscriptionPipeline(
            CheckedPreprocessing(), SpeechAwareAsrChunkPlanner(settings), measured, measured, settings,
        ).run(source)
        row["execution_status"] = "FAIL" if outcome.failure else "PASS"
        p = outcome.provenance
        t = p.strategy
        if t is not None:
            require(t.total_actual_asr_calls == measured.asr_calls, "production actual-call accounting")
            upstreams = [v.upstream_provider for _, _, v in t.provider_provenance if v.upstream_provider]
            row["provider_upstreams"] = sorted(set(upstreams))
            row["unknown_upstream_calls"] = measured.asr_calls - len(upstreams)
        recovery = outcome.evidence.recovery
        if recovery is not None:
            rp = recovery.provenance
            row["recovery"] = dict(attempts=rp.actual_attempt_count, accepted=rp.accepted_attempt_count,
                                   rejected=rp.rejected_attempt_count, failed=rp.failed_attempt_count,
                                   support_gain_samples=rp.canonical_support_gain_samples,
                                   ambiguity_reduction_samples=rp.canonical_ambiguity_reduction_samples,
                                   prevented_regressions=rp.rejected_regression_count, requested_samples=rp.total_requested_samples)
        if outcome.result is not None and outcome.failure is None:
            result = outcome.result
            supported = merge(s.interval for s in result.segments if s.text.strip())
            missing = subtract(speech, supported)
            metrics = compute_transcription_metrics(fixture, supported, unresolved=result.coverage.unresolved_intervals,
                                                    pipeline_status=outcome.status.value, result_available=True)
            row["metrics"] = {
                "text": compute_text_metrics(reference_text, " ".join(s.text for s in result.segments)),
                "canonical_text": (measured.canonical_metrics if measured.canonical_metrics is not None
                                   else compute_text_metrics(reference_text, "") if not outcome.evidence.reconciliation.segments else None),
                "confirmed_speech_samples": metrics["confirmed_speech_samples"],
                "supported_speech_samples": metrics["covered_speech_samples"],
                "missing_speech": [dict(start_sample=i.start_sample, end_sample=i.end_sample) for i in missing],
                **{name: [dict(start_sample=i.start_sample, end_sample=i.end_sample) for i in intersect(missing, [label for label in speech if getattr(label, flag)])]
                   for name, flag in (("missing_material", "material"), ("missing_critical", "critical"))},
                **{f"{label}_text_samples": metrics["hallucination_by_label"][label]["samples"] for label in ("silence", "noise", "music")},
                **{f"confirmed_{label}_samples": metrics["hallucination_by_label"][label]["denominator_samples"] for label in ("silence", "noise", "music")},
                "unsupported_canonical_risk_samples": result.coverage.quality.unsupported_canonical_text_samples,
                "unresolved_speech_samples": metrics["unresolved_speech_samples"], "false_success": metrics["false_success"],
            }
            alignment = outcome.evidence.asr.boundary_alignment
            row["components"] = dict(provider_contract="2", strategy=STRATEGY_VERSION, planner=p.planning.planner_version,
                                     alignment=alignment.alignment_version if alignment else None,
                                     reconciler=p.reconciliation.reconciler_version, coverage=p.coverage.assessor_version,
                                     recovery=p.recovery.recovery_version, correction=p.correction.correction_version,
                                     correction_prompt_identity=digest_json(p.correction.prompt_version),
                                     correction_model_identity=digest_json({"requested": p.correction.requested_model,
                                                                           "resolved": p.correction.resolved_model}))
        row["publication_validation"] = _publication(outcome, settings, source.source_id, fixture.source_sha256, samples(speech))
        verify_source(root, fixture)
        if reference is not None:
            load_reference(root, fixture)
    except CancelledError:
        raise
    except Exception as error:
        row["execution_status"] = "FAIL" if measured is not None else "UNAVAILABLE"
        row["metrics"] = None
        row["publication_validation"] = "UNAVAILABLE"
        traceback.clear_frames(error.__traceback__)
    finally:
        elapsed = clock() - started
        t = outcome.provenance.strategy if outcome is not None else None
        total = (measured.asr_calls + measured.correction_calls) if measured else 0
        known = measured.known if measured else Fraction(0)
        count = measured.cost_count if measured else 0
        row["resources"] = dict(
            asr_calls=measured.asr_calls if measured else 0,
            native_calls=t.native_attempts if t else 0,
            chunked_calls=t.chunked_baseline_calls if t else 0,
            recovery_calls=t.recovery_calls if t else 0,
            correction_calls=measured.correction_calls if measured else 0,
            latency_ns=elapsed, source_samples=fixture.sample_count,
            max_payload_bytes=measured.payload if measured else 0, peak_concurrent_asr=measured.peak if measured else 0,
            process_peak_memory_bytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024,
            known_cost_subtotal=rational(known.numerator, known.denominator) if count else None,
            reported_cost=rational(known.numerator, known.denominator) if total and total == count else None,
            unknown_cost_count=total - count, timeouts=measured.timeouts if measured else 0,
            resource_failures=measured.resource_failures if measured else 0,
        )
        if measured:
            measured.reference_text = ""
        outcome = reference = reference_text = measured = source = None
    return CaseRecord.model_validate(row).model_dump()


def configuration_digest(matrix, settings):
    return digest_json({"matrix": matrix.canonical(), "settings": safe_settings(settings),
                        "modes": ["chunked", "adaptive"], "evaluation": EVALUATION_VERSION})


def _external(path):
    repository = Path(__file__).resolve().parents[4]
    require(not path.resolve().is_relative_to(repository)
            and not any(p.is_symlink() for p in (path, *path.parents)), "external approved path")


def preflight_live(root, config_path, policy_path, output, max_asr_calls, settings):
    """No assets, model loading or provider construction before opt-in.

    Budget is conservative over ALL selected fixtures, both modes and every trial.
    Deliberately uses configured hard chunk limits, not guessed typical call counts.
    """
    __tracebackhide__ = True
    result = None
    try:
        require(os.environ.get("RUN_ASR_CUTOVER_LIVE") == "1", "cutover live opt-in")
        require_live_evaluation(settings)
        require(settings.audio_asr_model == MODEL and settings.audio_asr_language == "vi", "locked model")
        require(all(isinstance(p, Path) for p in (root, config_path, policy_path, output)), "explicit cutover paths")
        for path in (root, config_path, policy_path, output):
            _external(path)
        manifest, matrix = load_manifest(root), load_configuration(config_path)
        require_transcription_manifest(manifest)
        _, document = read_document(policy_path)
        policy = CutoverPolicy.model_validate(document)
        require(policy.manifest_sha256 == manifest.manifest_sha256
                and policy.configuration_matrix_sha256 == configuration_digest(matrix, settings)
                and policy.pipeline_identity == pipeline_identity(), "approved configuration identity")
        require(all(getattr(policy, key) is not None for key in (
            "maximum_wer_regression", "maximum_cer_regression", "maximum_hallucination_sample_regression",
            "maximum_word_insertion_regression", "maximum_latency_ns", "maximum_process_memory_bytes")), "complete approved thresholds")
        require(len(matrix.variants) == 1, "one approved geometry with two production modes")
        require(len(manifest.fixtures) <= policy.maximum_recordings, "evaluation scope")
        variant = matrix.variants[0]
        effective = variant.settings(settings)
        require_pinned_model(effective)
        protected = [root / "manifest.json", config_path, policy_path, effective.audio_vad_model_path]
        identities = []
        for fixture in manifest.fixtures:
            identity = fixture_identity(fixture)
            require(identity in policy.fixture_conditions and fixture.sample_count <= policy.maximum_source_samples,
                    "approved fixture scope")
            protected.append(external_file(root, fixture.path))
            verify_source(root, fixture)
            if fixture.reference:
                load_reference(root, fixture)
                protected.append(external_file(root, fixture.reference.path))
            identities.append((identity, fixture.reference.sha256 if fixture.reference else None,
                               digest_json(fixture.model_dump(include={"labels", "sample_count", "annotation_version", "annotation_origin", "anchors"}))))
        require(set(policy.fixture_conditions) == {i[0] for i in identities}, "entire approved scope")
        require(digest_json(sorted(identities)) == policy.reference_identity, "approved reference hashes")
        for path in protected:
            _external(path)
        validate_output_path(output, root, protected)
        require(not output.exists(), "new external output destination")
        per_case = effective.audio_asr_chunk_max_chunks + effective.audio_asr_recovery_max_total_attempts + 1
        maximum = len(manifest.fixtures) * 2 * policy.trials * per_case
        require(type(max_asr_calls) is int and maximum <= max_asr_calls <= policy.maximum_asr_calls
                and per_case <= policy.maximum_case_asr_calls, "complete ASR call budget")
        require(min(effective.audio_asr_max_payload_bytes, 25000000) <= policy.maximum_payload_bytes
                and effective.audio_asr_max_concurrent_chunks <= policy.maximum_concurrent_asr
                and effective.audio_asr_recovery_max_total_attempts <= policy.maximum_recovery_attempts
                and effective.audio_asr_recovery_max_total_request_samples <= policy.maximum_recovery_samples,
                "approved operational budgets")
        result = manifest, matrix, policy, effective, maximum
    except Exception as error:
        traceback.clear_frames(error.__traceback__)
    if result is None:
        raise EvaluationError("cutover preflight unavailable; approved inputs, policy, scope, credentials and budget required") from None
    return result


def run_live_cutover(root, config_path, policy_path, output, max_asr_calls, settings):
    """Separately authorized live entry. Never invoked by ordinary pytest/CI."""
    __tracebackhide__ = True
    try:
        manifest, matrix, policy, effective, maximum = preflight_live(root, config_path, policy_path, output, max_asr_calls, settings)
        # Imports and construction follow the complete asset/policy/budget preflight.
        from sme_meeting_ai.audio import (
            AudioEvidenceDetector,
            AudioNormalizer,
            SileroVadBackend,
            SpeechMapBuilder,
        )
        from sme_meeting_ai.pipeline import AudioPreprocessingPipeline
        from sme_meeting_ai.providers.openrouter_instruction_llm import (
            OpenRouterInstructionLlmAdapter,
        )
        from sme_meeting_ai.providers.openrouter_whisper import OpenRouterWhisperAdapter

        cases = []
        ledger = _CallLedger(maximum)
        with ExitStack() as resources:
            backend = SileroVadBackend.from_settings(effective)
            resources.callback(backend.close)
            for mode in ("chunked", "adaptive"):
                config = effective.model_copy(update={"audio_asr_strategy_mode": mode})
                provider = resources.enter_context(OpenRouterWhisperAdapter(config))
                corrector = resources.enter_context(OpenRouterInstructionLlmAdapter(config))
                preprocessing = AudioPreprocessingPipeline(AudioNormalizer(config), AudioEvidenceDetector(config, backend), SpeechMapBuilder(config))
                for fixture in sorted(manifest.fixtures, key=lambda f: f.fixture_id):
                    for trial in range(policy.trials):
                        cases.append(run_production_case(manifest, fixture, root, preprocessing, provider, corrector, config,
                                                         evidence_mode="approved-live", conditions=policy.fixture_conditions[fixture_identity(fixture)],
                                                         trial=trial, ledger=ledger, authorized_live=True))
        # Revalidate every original asset/configuration after inference AND cleanup.
        again = preflight_live(root, config_path, policy_path, output, max_asr_calls, settings)
        require(again[:3] == (manifest, matrix, policy), "post-inference identity")
        verified = Verification(pipeline_identity=policy.pipeline_identity,
                                configuration_matrix_sha256=policy.configuration_matrix_sha256,
                                implementation="UNAVAILABLE", ci="UNAVAILABLE", publication=status_of(c["publication_validation"] for c in cases),
                                rollback="UNAVAILABLE", evidence_sha256=digest_json(cases), ci_commit="0" * 40, ci_run_id=None)
        report = assemble_report(cases, policy, verified)
        validate_report(report, policy)
        with output.open("xb") as destination:
            destination.write(serialize_report(report))
        return report
    except CancelledError:
        raise
    except Exception as error:
        traceback.clear_frames(error.__traceback__)
    raise EvaluationError("cutover live evaluation unavailable") from None
