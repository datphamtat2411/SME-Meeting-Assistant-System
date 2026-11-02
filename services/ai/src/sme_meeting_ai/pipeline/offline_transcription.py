"""Transport-independent offline composition with text-free, immutable evidence.

The preprocessing outcome owns all temporary artifacts through correction. Model
providers are borrowed. Candidate-bearing objects live only in run() and never in
the published evidence; only validated correction can publish transcript text.
"""

import traceback
from concurrent.futures import CancelledError
from dataclasses import dataclass, field, replace
from enum import StrEnum
from types import MappingProxyType
from typing import TYPE_CHECKING, Mapping

from sme_meeting_ai.audio.errors import AudioErrorCategory, AudioProcessingError
from sme_meeting_ai.audio.models import AudioSource, SampleInterval, SpeechMap
from sme_meeting_ai.core.config import Settings

from .models import (
    PreprocessingAudioMetadata,
    PreprocessingFailure,
    PreprocessingOutcome,
    PreprocessingProvenance,
    PreprocessingStage,
    PreprocessingStatus,
)
from .preprocessing import AudioPreprocessingPipeline

# Transcription modules themselves depend on pipeline.models/preprocessing. Keep
# all runtime imports local so either package can be imported first.
if TYPE_CHECKING:
    from sme_meeting_ai.transcription.asr import (
        AsrProvenance,
        AsrTranscriber,
    )
    from sme_meeting_ai.transcription.asr_strategy import AsrStrategyTelemetry
    from sme_meeting_ai.transcription.boundary_alignment import BoundaryAlignmentReport
    from sme_meeting_ai.transcription.chunk_planning import (
        AsrChunkPlan,
        ChunkPlanningProvenance,
        SpeechAwareAsrChunkPlanner,
    )
    from sme_meeting_ai.transcription.correction import (
        CorrectionProvenance,
        TranscriptCorrectionProvider,
        TranscriptCorrectionResult,
    )
    from sme_meeting_ai.transcription.coverage import (
        CoverageProvenance,
        SpeechCoverageAssessment,
    )
    from sme_meeting_ai.transcription.reconciliation import (
        ReconciliationChunkOutcome,
        ReconciliationFlag,
        ReconciliationProvenance,
    )
    from sme_meeting_ai.transcription.recovery import (
        RecoveryAttempt,
        RecoveryProvenance,
        RecoveryStopReason,
    )


class OfflineTranscriptionStatus(StrEnum):
    COMPLETED = "COMPLETED"
    COMPLETED_WITH_WARNINGS = "COMPLETED_WITH_WARNINGS"
    FAILED = "FAILED"


class OfflineTranscriptionStage(StrEnum):
    PREPROCESSING = "preprocessing"
    CHUNK_PLANNING = "chunk_planning"
    ASR = "asr"
    COVERAGE_RECOVERY = "coverage_recovery"
    RECONCILIATION = "reconciliation"
    CORRECTION = "correction"


@dataclass(frozen=True)
class OfflineTranscriptionFailure:
    stage: OfflineTranscriptionStage
    category: str
    attempts: int | None = None


@dataclass(frozen=True)
class OfflineTranscriptionWarning:
    """Stable, stage-tagged quality indicators; no free-form diagnostics."""

    stage: OfflineTranscriptionStage
    code: str
    interval: SampleInterval | None = None
    source_chunk_ids: tuple[str, ...] = ()
    phase: str | None = None


@dataclass(frozen=True)
class OfflineAsrProvenance:
    asr: tuple[tuple[str, "AsrProvenance"], ...]
    effective_configuration: Mapping[str, str | int | float]

    def __post_init__(self) -> None:
        object.__setattr__(self, "asr", tuple(self.asr))
        object.__setattr__(self, "effective_configuration", MappingProxyType(dict(self.effective_configuration)))


@dataclass(frozen=True)
class OfflineAsrEvidence:
    chunk_outcomes: tuple["ReconciliationChunkOutcome", ...]
    provenance: OfflineAsrProvenance
    boundary_alignment: "BoundaryAlignmentReport | None" = None


@dataclass(frozen=True)
class OfflineRecoveryEvidence:
    initial_assessment: "SpeechCoverageAssessment"
    final_assessment: "SpeechCoverageAssessment"
    attempts: tuple["RecoveryAttempt", ...]
    stop_reason: "RecoveryStopReason"
    provenance: "RecoveryProvenance"
    # Kept separately for phase compatibility; V2 admission deltas are canonical.
    pre_canonical_final_assessment: "SpeechCoverageAssessment | None" = None
    initial_canonical_assessment: "SpeechCoverageAssessment | None" = None


@dataclass(frozen=True)
class OfflineReconciliationSegment:
    segment_id: str
    ordinal: int
    interval: SampleInterval
    source_chunk_ids: tuple[str, ...]
    flags: tuple["ReconciliationFlag", ...]


@dataclass(frozen=True)
class OfflineReconciliationEvidence:
    chunk_outcomes: tuple["ReconciliationChunkOutcome", ...]
    segments: tuple[OfflineReconciliationSegment, ...]
    unresolved_intervals: tuple[SampleInterval, ...]
    provenance: "ReconciliationProvenance"


@dataclass(frozen=True)
class OfflineTranscriptionProvenance:
    pipeline_version: str
    source_id: str
    sample_count: int | None = None
    preprocessing: PreprocessingProvenance | None = None
    planning: "ChunkPlanningProvenance | None" = None
    asr: OfflineAsrProvenance | None = None
    coverage: "CoverageProvenance | None" = None
    recovery: "RecoveryProvenance | None" = None
    reconciliation: "ReconciliationProvenance | None" = None
    correction: "CorrectionProvenance | None" = None
    strategy: "AsrStrategyTelemetry | None" = None
    sample_rate_hz: int = field(default=16000, init=False)


@dataclass(frozen=True)
class OfflineTranscriptionEvidence:
    source_id: str
    audio_metadata: PreprocessingAudioMetadata | None
    preprocessing_status: PreprocessingStatus | None
    preprocessing_completed_stages: tuple[PreprocessingStage, ...]
    preprocessing_failure: PreprocessingFailure | None
    speech_map: SpeechMap | None
    chunk_plan: "AsrChunkPlan | None"
    asr: OfflineAsrEvidence | None
    coverage: "SpeechCoverageAssessment | None"
    recovery: OfflineRecoveryEvidence | None
    reconciliation: OfflineReconciliationEvidence | None
    warnings: tuple[OfflineTranscriptionWarning, ...]
    provenance: OfflineTranscriptionProvenance


@dataclass(frozen=True)
class OfflineTranscriptionOutcome:
    status: OfflineTranscriptionStatus
    completed_stages: tuple[OfflineTranscriptionStage, ...]
    result: "TranscriptCorrectionResult | None" = field(repr=False)
    failure: OfflineTranscriptionFailure | None
    evidence: OfflineTranscriptionEvidence
    warnings: tuple[OfflineTranscriptionWarning, ...]
    provenance: OfflineTranscriptionProvenance

    def __post_init__(self) -> None:
        if self.status is OfflineTranscriptionStatus.FAILED:
            valid = self.failure is not None
        else:
            valid = (
                self.failure is None and self.result is not None
                and self.completed_stages == tuple(OfflineTranscriptionStage)
                and (self.status is OfflineTranscriptionStatus.COMPLETED_WITH_WARNINGS) == bool(self.warnings)
            )
        if not valid:
            raise AudioProcessingError("VALIDATION")


class _Stopped(Exception):
    """An already sanitized stage outcome, rather than an operation exception."""

    def __init__(self, failure: OfflineTranscriptionFailure):
        self.failure = failure


class _CorrectionCancelled(BaseException):
    def __init__(self, original: CancelledError):
        self.original = original


class _BorrowedCorrector:
    """Let futures cancellation cross correction's ordinary provider-error catch."""

    def __init__(self, provider: "TranscriptCorrectionProvider"):
        self._provider = provider

    def complete(self, request):
        try:
            return self._provider.complete(request)
        except CancelledError as error:
            raise _CorrectionCancelled(error) from None


def _require(condition: bool) -> None:
    if not condition:
        raise AudioProcessingError("VALIDATION")


def _failure(error: Exception, stage: OfflineTranscriptionStage) -> OfflineTranscriptionFailure:
    from sme_meeting_ai.transcription.asr import AsrError, AsrErrorCategory
    from sme_meeting_ai.transcription.correction import (
        CorrectionError,
        CorrectionErrorCategory,
    )

    category = {
        OfflineTranscriptionStage.PREPROCESSING: "INFERENCE",
        OfflineTranscriptionStage.CHUNK_PLANNING: "VALIDATION",
        OfflineTranscriptionStage.ASR: "PROVIDER",
        OfflineTranscriptionStage.COVERAGE_RECOVERY: "VALIDATION",
        OfflineTranscriptionStage.RECONCILIATION: "VALIDATION",
        OfflineTranscriptionStage.CORRECTION: "PROVIDER",
    }[stage]
    if isinstance(error, AudioProcessingError) and isinstance(error.category, AudioErrorCategory):
        category = error.category.value
    elif isinstance(error, AsrError) and isinstance(error.category, AsrErrorCategory):
        category = error.category.value.upper()
    elif isinstance(error, CorrectionError) and isinstance(error.category, CorrectionErrorCategory):
        category = error.category.value.upper()
    elif isinstance(error, TimeoutError):
        category = "TIMEOUT"
    elif isinstance(error, (OSError, MemoryError)):
        category = "RESOURCE"
    return OfflineTranscriptionFailure(stage, category)


def _asr_evidence(plan, results, settings: Settings, payload_limit: int | None = None) -> OfflineAsrEvidence:
    """Project local failures and validated provider provenance, never wording."""
    from sme_meeting_ai.transcription.asr import AsrErrorCategory
    from sme_meeting_ai.transcription.boundary_alignment import (
        analyze_boundary_alignment,
    )
    from sme_meeting_ai.transcription.chunk_execution import AsrChunkResult
    from sme_meeting_ai.transcription.coverage import _valid_result
    from sme_meeting_ai.transcription.reconciliation import (
        ReconciliationChunkOutcome,
        ReconciliationChunkState,
        _safe_provenance,
    )

    _require(isinstance(results, tuple) and len(results) == len(plan.chunks))
    outcomes, provenance = [], []
    for chunk, item in zip(plan.chunks, results, strict=True):
        _require(isinstance(item, AsrChunkResult) and item.chunk == chunk)
        state = ReconciliationChunkState.MALFORMED
        failure = AsrErrorCategory.MALFORMED_OUTPUT
        if (isinstance(item.failure, AsrErrorCategory) and item.candidate is None
                and item.timeline_segments == ()):
            failure = item.failure
            if failure is not AsrErrorCategory.MALFORMED_OUTPUT:
                state = ReconciliationChunkState.FAILED
        elif item.failure is None and _valid_result(item):
            try:
                safe = _safe_provenance(item.candidate.provenance)
            except AudioProcessingError:
                pass
            else:
                provenance.append((chunk.chunk_id, safe))
                failure = None
                state = (ReconciliationChunkState.CANDIDATE_EVIDENCE
                         if any(s.segment.text.strip() for s in item.timeline_segments)
                         else ReconciliationChunkState.EMPTY)
        outcomes.append(ReconciliationChunkOutcome(chunk.chunk_id, chunk.core_interval, state, failure))
    alignment = (analyze_boundary_alignment(plan, results)
                 if plan.provenance.planner_version in ("speech-aware-v2", "speech-aware-v3") else None)
    return OfflineAsrEvidence(tuple(outcomes), OfflineAsrProvenance(tuple(provenance), {
        "max_concurrent_chunks": settings.audio_asr_max_concurrent_chunks,
        "max_payload_bytes": settings.audio_asr_max_payload_bytes if payload_limit is None else payload_limit,
        "timeout_seconds": settings.audio_asr_timeout_seconds,
        "model": settings.audio_asr_model,
        "language": settings.audio_asr_language,
        "temperature": settings.audio_asr_temperature,
    }), alignment)


def _chunk_warnings(stage, outcomes) -> tuple[OfflineTranscriptionWarning, ...]:
    from sme_meeting_ai.transcription.reconciliation import ReconciliationChunkState

    return tuple(OfflineTranscriptionWarning(
        stage, item.state.value, item.core_interval, (item.chunk_id,),
    ) for item in outcomes if item.state is not ReconciliationChunkState.CANDIDATE_EVIDENCE)


def _coverage_warnings(assessment, phase: str) -> tuple[OfflineTranscriptionWarning, ...]:
    from sme_meeting_ai.transcription.coverage import CoveragePhase

    # Preserve the existing worker/Core warning literals while binding each to
    # the explicit V2 phase. Never publish a provisional post-attempt as "final".
    expected = CoveragePhase.PRE_CANONICAL if phase == "initial" else CoveragePhase.FINAL_CANONICAL
    _require(phase in ("initial", "final") and assessment.provenance.assessment_phase is expected)
    stage = OfflineTranscriptionStage.COVERAGE_RECOVERY
    return (
        *(OfflineTranscriptionWarning(stage, reason.value, region.interval,
                                      region.supporting_chunk_ids, phase)
          for region in assessment.regions for reason in region.reasons),
        *(OfflineTranscriptionWarning(stage, "unresolved-speech", interval, phase=phase)
          for interval in assessment.unresolved_intervals),
    )


class OfflineTranscriptionPipeline:
    """Compose existing finite stages once, retaining successful evidence on failure.

    Construct the injected preprocessing/planner/providers from the same Settings
    snapshot. Execution borrows those objects; run() owns only the preprocessing
    outcome it obtains. No transport, persistence, or orchestration retry is added.
    """

    def __init__(
        self, preprocessing: AudioPreprocessingPipeline, planner: "SpeechAwareAsrChunkPlanner",
        transcriber: "AsrTranscriber", correction_provider: "TranscriptCorrectionProvider",
        settings: Settings, pipeline_version: str = "1",
    ):
        _require(isinstance(settings, Settings))
        _require(isinstance(pipeline_version, str) and bool(pipeline_version.strip()))
        self._preprocessing = preprocessing
        self._planner = planner
        self._transcriber = transcriber
        self._correction_provider = correction_provider
        self._settings = settings.model_copy(deep=True)
        self._pipeline_version = pipeline_version

    def run(self, source: AudioSource) -> OfflineTranscriptionOutcome:
        from sme_meeting_ai.transcription.asr_strategy import (
            STRATEGY_VERSION,
            AsrStrategy,
            AsrStrategyRunner,
        )
        from sme_meeting_ai.transcription.correction import (
            TranscriptCorrectionOutcome,
            TranscriptCorrectionStatus,
            correct_transcript,
        )
        from sme_meeting_ai.transcription.recovery import RecoveryStopReason

        stage = OfflineTranscriptionStage.PREPROCESSING
        source_id = source.source_id if isinstance(source, AudioSource) else ""
        version = self._pipeline_version
        if self._settings.audio_asr_strategy_mode == "adaptive":
            version = f"{version}:{STRATEGY_VERSION}"
        provenance = OfflineTranscriptionProvenance(version, source_id)
        completed, warnings = [], []
        ownership = None
        metadata = preprocessing_status = preprocessing_failure = speech_map = None
        preprocessing_completed = ()
        plan = asr = coverage = recovery = reconciliation = result = failure = None
        # These are the only candidate-bearing locals; none enters public output.
        baseline = recovered = reconciled = preprocessing_result = None
        strategy = execution = None
        cancellation = None
        try:
            _require(isinstance(source, AudioSource))
            ownership = self._preprocessing.run(source)
            _require(isinstance(ownership, PreprocessingOutcome))
            metadata = ownership.audio_metadata
            preprocessing_status = ownership.status
            preprocessing_completed = tuple(ownership.completed_stages)
            preprocessing_failure = ownership.failure
            provenance = replace(
                provenance, preprocessing=ownership.provenance,
                sample_count=metadata.sample_count if metadata is not None else None,
            )
            if ownership.status is PreprocessingStatus.FAILED:
                raise _Stopped(OfflineTranscriptionFailure(stage, ownership.failure.category.value))
            preprocessing_result = ownership.result
            speech_map = preprocessing_result.speech_map
            warnings.extend(OfflineTranscriptionWarning(stage, warning.value)
                            for warning in preprocessing_result.warnings)
            completed.append(stage)

            stage = OfflineTranscriptionStage.CHUNK_PLANNING
            strategy = AsrStrategyRunner(self._transcriber, self._settings)
            strategy.prepare(preprocessing_result, self._planner)
            plan = strategy.plan
            _require(plan.source_id == source_id and plan.sample_count == metadata.sample_count
                     and plan.provenance.preprocessing == provenance.preprocessing)
            provenance = replace(provenance, planning=plan.provenance)
            completed.append(stage)

            stage = OfflineTranscriptionStage.ASR
            execution = strategy.execute(preprocessing_result.normalized_artifact)
            plan, baseline = execution.plan, execution.baseline
            asr = _asr_evidence(plan, baseline, self._settings,
                                strategy.telemetry.decision.effective_payload_limit)
            warnings.extend(_chunk_warnings(stage, asr.chunk_outcomes))
            provenance = replace(provenance, asr=asr.provenance, planning=plan.provenance,
                                 strategy=strategy.telemetry)
            completed.append(stage)

            stage = OfflineTranscriptionStage.COVERAGE_RECOVERY
            recovered = strategy.recover(preprocessing_result, execution, boundary_alignment=asr.boundary_alignment)
            recovery = OfflineRecoveryEvidence(
                recovered.initial_assessment, recovered.final_assessment, tuple(recovered.attempts),
                recovered.stop_reason, recovered.provenance, recovered.initial_assessment,
                recovered.initial_canonical_assessment,
            )
            coverage = recovery.final_assessment
            provenance = replace(provenance, coverage=coverage.provenance, recovery=recovery.provenance)
            warnings.extend(_coverage_warnings(recovery.initial_assessment, "initial"))
            if recovery.stop_reason not in (
                RecoveryStopReason.SUFFICIENT_COVERAGE, RecoveryStopReason.NO_ACTIONABLE_REGIONS,
            ):
                warnings.append(OfflineTranscriptionWarning(stage, recovery.stop_reason.value))
            for attempt in recovery.attempts:
                if attempt.failure is not None:
                    warnings.append(OfflineTranscriptionWarning(
                        stage, attempt.failure.value, attempt.window.chunk.request_interval,
                        (attempt.window.chunk.chunk_id,), "attempt",
                    ))
            if recovered.evaluation_failure is not None:
                raise AudioProcessingError("RESOURCE")
            completed.append(stage)

            stage = OfflineTranscriptionStage.RECONCILIATION
            # Recovery returns the last validated, admitted T05/T06 snapshot.
            # No speculative trial is published as a completed public stage.
            reconciled = recovered.accepted_reconciliation
            _require(reconciled is not None and reconciled.source_id == plan.source_id
                     and reconciled.sample_count == plan.sample_count)
            if execution.selected_strategy is AsrStrategy.WHOLE_FILE:
                # The compatibility boundary must represent each original segment
                # once with its exact interval/text; no virtual ownership or stitch.
                original = baseline[0].timeline_segments
                _require(reconciled.source_id == plan.source_id and reconciled.sample_count == plan.sample_count
                         and reconciled.provenance.source_chunks == plan.chunks
                         and len(reconciled.segments) == len(original))
                _require(all(
                    segment.interval == item.interval and segment.text == item.segment.text
                    and segment.source_chunk_ids == (plan.chunks[0].chunk_id,)
                    and not segment.alternatives and not segment.flags
                    for segment, item in zip(reconciled.segments, original, strict=True)
                ))
            reconciliation = OfflineReconciliationEvidence(
                tuple(reconciled.chunk_outcomes),
                tuple(OfflineReconciliationSegment(
                    segment.segment_id, segment.ordinal, segment.interval,
                    tuple(segment.source_chunk_ids), tuple(segment.flags),
                ) for segment in reconciled.segments),
                tuple(reconciled.unresolved_intervals), reconciled.provenance,
            )
            coverage = recovered.final_assessment
            provenance = replace(provenance, reconciliation=reconciliation.provenance, coverage=coverage.provenance)
            warnings.extend(_coverage_warnings(coverage, "final"))
            warnings.extend(_chunk_warnings(stage, reconciliation.chunk_outcomes))
            warnings.extend(OfflineTranscriptionWarning(stage, flag.value, segment.interval, segment.source_chunk_ids)
                            for segment in reconciliation.segments for flag in segment.flags)
            warnings.extend(OfflineTranscriptionWarning(stage, "unresolved-interval", interval)
                            for interval in reconciliation.unresolved_intervals)
            completed.append(stage)

            stage = OfflineTranscriptionStage.CORRECTION
            corrected = correct_transcript(reconciled, coverage, _BorrowedCorrector(self._correction_provider),
                                           self._settings)
            _require(isinstance(corrected, TranscriptCorrectionOutcome))
            if corrected.status is TranscriptCorrectionStatus.FAILED:
                raise _Stopped(OfflineTranscriptionFailure(
                    stage, corrected.failure.category.value.upper(), corrected.failure.attempts,
                ))
            result = corrected.result
            provenance = replace(provenance, correction=result.provenance)
            if corrected.status is TranscriptCorrectionStatus.COMPLETED_WITH_WARNINGS:
                warnings.append(OfflineTranscriptionWarning(stage, "completed-with-warnings"))
            if not any(segment.text.strip() for segment in result.segments):
                warnings.append(OfflineTranscriptionWarning(stage, "empty-transcript"))
            completed.append(stage)
        except _Stopped as stopped:
            failure = stopped.failure
        except _CorrectionCancelled as error:
            cancellation = error.original
            traceback.clear_frames(cancellation.__traceback__)
            raise cancellation.with_traceback(None) from None
        except CancelledError as error:
            cancellation = error
            raise
        except Exception as error:
            failure = _failure(error, stage)
            traceback.clear_frames(error.__traceback__)
        except BaseException as error:
            cancellation = error
            raise
        finally:
            if cancellation is not None:
                # Cancellation identity/lifecycle survives, provider diagnostics do
                # not. Correction can propagate cancellation outside Exception.
                cancellation.args = ()
                cancellation.__cause__ = cancellation.__context__ = None
                traceback.clear_frames(cancellation.__traceback__)
            if strategy is not None:
                provenance = replace(provenance, strategy=strategy.telemetry)
                if OfflineTranscriptionStage.CHUNK_PLANNING in completed:
                    plan = strategy.plan
                    provenance = replace(provenance, planning=plan.provenance)
            baseline = recovered = reconciled = preprocessing_result = execution = strategy = None
            if isinstance(ownership, PreprocessingOutcome):
                try:
                    ownership.close()
                except Exception:
                    if cancellation is None:
                        failure = OfflineTranscriptionFailure(stage, "RESOURCE")
                except BaseException:
                    if cancellation is None:
                        raise

        # Only completed stages publish their metadata/provenance. A planner
        # exception after returning an invalid value must not publish that value.
        if OfflineTranscriptionStage.CHUNK_PLANNING not in completed:
            plan = None
        status = (OfflineTranscriptionStatus.FAILED if failure is not None else
                  OfflineTranscriptionStatus.COMPLETED_WITH_WARNINGS if warnings else
                  OfflineTranscriptionStatus.COMPLETED)
        published_warnings = tuple(warnings)
        evidence = OfflineTranscriptionEvidence(
            source_id, metadata, preprocessing_status, preprocessing_completed, preprocessing_failure,
            speech_map, plan, asr, coverage, recovery, reconciliation, published_warnings, provenance,
        )
        return OfflineTranscriptionOutcome(
            status, tuple(completed), result, failure, evidence, published_warnings, provenance,
        )
