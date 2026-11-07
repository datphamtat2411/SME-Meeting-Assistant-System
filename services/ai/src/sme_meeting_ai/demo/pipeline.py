"""Local AI composition and corrected-only speaker enrichment; no worker services."""

import time
from collections.abc import Callable
from contextlib import ExitStack
from pathlib import Path
from uuid import uuid4

from sme_meeting_ai.audio.models import AudioSource, SampleInterval
from sme_meeting_ai.core.config import ConfigurationError, Settings
from sme_meeting_ai.diarization import (
    DiarizationRequest,
    DiarizationService,
    SpeakerHints as DiarizationSpeakerHints,
    TimedTranscriptSegment,
)
from sme_meeting_ai.pipeline.offline_transcription import (
    OfflineTranscriptionOutcome,
    OfflineTranscriptionStage,
    OfflineTranscriptionStatus,
)
from sme_meeting_ai.transcription.correction import (
    CorrectedSegment,
    TranscriptCorrectionResult,
)

from .models import (
    DemoDiarization,
    DemoResult,
    DemoSegment,
    DemoSpeaker,
    DemoTurn,
    SpeakerHints,
)


class DemoProcessingError(Exception):
    """Closed error vocabulary; never retain a provider exception or transcript."""

    stage = "transcription"

    def __init__(self, code="PROCESSING_FAILED"):
        self.code = code if code in ("PROCESSING_FAILED", "TIMEOUT") else "PROCESSING_FAILED"
        super().__init__(self.code)


def processing_budget_seconds(settings: Settings) -> float:
    """Conservative cooperative deadline; includes every authorized ASR call.

    Applied at stage boundaries, never used to pretend a thread was killed. Native
    per-call/preprocessing/recovery deadlines remain in force inside transcription.
    """
    return (
        4 * settings.audio_probe_timeout_seconds + settings.audio_decode_timeout_seconds
        + settings.audio_vad_timeout_seconds
        + settings.audio_asr_max_total_calls * settings.audio_asr_timeout_seconds
        + settings.audio_asr_recovery_max_wall_time_seconds
        + settings.transcript_correction_max_attempts * settings.transcript_correction_timeout_seconds
        + settings.diarization_timeout_seconds + 60
    )


def _require(condition):
    if not condition:
        raise DemoProcessingError()


def _corrected_segments(outcome, source_id):
    _require(isinstance(outcome, OfflineTranscriptionOutcome))
    if outcome.status is OfflineTranscriptionStatus.FAILED:
        raise DemoProcessingError("TIMEOUT" if outcome.failure.category == "TIMEOUT" else "PROCESSING_FAILED")
    _require(outcome.status in (OfflineTranscriptionStatus.COMPLETED, OfflineTranscriptionStatus.COMPLETED_WITH_WARNINGS)
             and outcome.failure is None and outcome.completed_stages == tuple(OfflineTranscriptionStage))
    result = outcome.result
    _require(isinstance(result, TranscriptCorrectionResult))
    _require(result.source_id == outcome.provenance.source_id == outcome.evidence.source_id == source_id
             and result.sample_rate_hz == outcome.provenance.sample_rate_hz == 16000
             and type(result.sample_count) is int and result.sample_count > 0
             and result.sample_count == outcome.provenance.sample_count == outcome.evidence.audio_metadata.sample_count
             and result.provenance == outcome.provenance.correction)
    evidence = outcome.evidence.reconciliation
    _require(evidence is not None and len(result.segments) == len(evidence.segments))
    # Empty correction with unresolved speech is not evidence of silence. In
    # particular, failed ASR calls must not become a successful empty demo result.
    # Reconciliation gaps span ALL time without text, including valid silence;
    # only final acoustic/ASR coverage identifies unresolved speech or failures.
    if not result.segments:
        _require(not getattr(result.coverage, "unresolved_intervals", ()))
    mapped, previous_start, previous_ordinal = [], -1, -1
    for segment, original in zip(result.segments, evidence.segments, strict=True):
        _require(isinstance(segment, CorrectedSegment)
                 and segment.segment_id == original.segment_id and segment.ordinal == original.ordinal
                 and segment.interval == original.interval and isinstance(segment.interval, SampleInterval)
                 and type(segment.ordinal) is int and segment.ordinal > previous_ordinal
                 and 0 <= segment.interval.start_sample < segment.interval.end_sample <= result.sample_count
                 and segment.interval.start_sample >= previous_start
                 and isinstance(segment.text, str) and bool(segment.text.strip()))
        previous_start, previous_ordinal = segment.interval.start_sample, segment.ordinal
        # Half-open evidence enclosure: floor starts, ceil ends, exact integers.
        mapped.append(DemoSegment(
            ordinal=segment.ordinal, startMs=segment.interval.start_sample // 16,
            endMs=(segment.interval.end_sample + 15) // 16, text=segment.text,
        ))
    return result.sample_count, tuple(mapped)


class DemoPipelineRunner:
    def __init__(self, pipeline, diarization_service: DiarizationService, *, language: str, close: Callable[[], None] = lambda: None,
                 clock: Callable[[], float] = time.monotonic):
        self._pipeline, self._diarization_service = pipeline, diarization_service
        self._language, self._close, self._clock = language, close, clock

    def close(self):
        self._close()

    def run(self, audio_path: Path, *, hints: SpeakerHints | None = None,
            on_stage: Callable[[str], None] = lambda stage: None,
            deadline: float | None = None) -> DemoResult:
        on_stage("transcription")
        code = None
        try:
            if deadline is not None and self._clock() >= deadline:
                raise DemoProcessingError("TIMEOUT")
            source = AudioSource(str(uuid4()), audio_path)
            outcome = self._pipeline.run(source)
            if deadline is not None and self._clock() >= deadline:
                raise DemoProcessingError("TIMEOUT")
            count, segments = _corrected_segments(outcome, source.source_id)
        except DemoProcessingError as error:
            code = error.code
        except Exception:
            code = "PROCESSING_FAILED"
        if code is not None:
            raise DemoProcessingError(code)

        diarization = DemoDiarization(status="skipped")
        if segments:
            on_stage("diarization")
            hints = hints or SpeakerHints()
            try:
                if deadline is not None and self._clock() >= deadline:
                    raise TimeoutError
                timed = tuple(TimedTranscriptSegment(s.ordinal, s.startMs, s.endMs) for s in segments)
                result = self._diarization_service.run(DiarizationRequest(
                    audio_path, (count + 15) // 16, timed, DiarizationSpeakerHints(**hints.model_dump()),
                ))
                if deadline is not None and self._clock() >= deadline:
                    raise TimeoutError
                if result.diagnostic_status == "completed":
                    enriched = tuple(s.model_copy(update={"speakerLabel": assignment.speaker_label})
                                     for s, assignment in zip(segments, result.assignments, strict=True))
                    diarization = DemoDiarization(
                        status="completed", speakers=tuple(DemoSpeaker(label=s) for s in result.speaker_labels),
                        turns=tuple(DemoTurn(startMs=t.start_ms, endMs=t.end_ms, speakerLabel=t.speaker_label)
                                    for t in result.raw_turns),
                    )
                    segments = enriched
                elif result.diagnostic_status == "failed":
                    diarization = DemoDiarization(status="failed", errorCode=result.error_category.upper())
            except TimeoutError:
                diarization = DemoDiarization(status="failed", errorCode="TIMEOUT")
            except Exception:
                diarization = DemoDiarization(status="failed", errorCode="PROCESSING_FAILED")
        return DemoResult(durationMs=(count + 15) // 16, language=self._language,
                          segments=segments, diarization=diarization)


def build_demo_runner(settings: Settings) -> DemoPipelineRunner:
    """Mirror the worker's AI-only composition, retaining configured correction mode.

    Resources are application-owned and closed only after their last reader exits.
    This factory deliberately imports no production worker or infrastructure client.
    """
    from sme_meeting_ai.audio import (
        AudioEvidenceDetector,
        AudioNormalizer,
        SpeechMapBuilder,
    )
    from sme_meeting_ai.audio.vad import SileroVadBackend
    from sme_meeting_ai.pipeline import (
        AudioPreprocessingPipeline,
        OfflineTranscriptionPipeline,
    )
    from sme_meeting_ai.providers.openrouter_instruction_llm import (
        OpenRouterInstructionLlmAdapter,
    )
    from sme_meeting_ai.providers.openrouter_instruction_llm_v62 import (
        OpenRouterInstructionLlmV62Adapter,
    )
    from sme_meeting_ai.providers.openrouter_whisper import OpenRouterWhisperAdapter
    from sme_meeting_ai.providers.replicate_diarization import (
        ReplicateDiarizationAdapter,
    )
    from sme_meeting_ai.transcription.chunk_planning import SpeechAwareAsrChunkPlanner

    resources = ExitStack()
    try:
        mode = settings.transcript_correction_mode
        key = settings.openrouter_api_key.get_secret_value() if settings.openrouter_api_key else ""
        if (mode not in ("v5_full", "v62_edits") or not key
                or any(ord(c) < 33 or ord(c) > 126 for c in key) or not settings.transcript_correction_model):
            raise ValueError
        normalizer = AudioNormalizer(settings)
        normalizer._tool("ffmpeg")
        normalizer._tool("ffprobe")
        backend = SileroVadBackend.from_settings(settings)
        resources.callback(backend.close)
        transcriber = resources.enter_context(OpenRouterWhisperAdapter(settings))
        corrector = resources.enter_context(
            OpenRouterInstructionLlmAdapter(settings) if mode == "v5_full"
            else OpenRouterInstructionLlmV62Adapter(settings)
        )
        pipeline = OfflineTranscriptionPipeline(
            AudioPreprocessingPipeline(normalizer, AudioEvidenceDetector(settings, backend), SpeechMapBuilder(settings)),
            SpeechAwareAsrChunkPlanner(settings), transcriber, corrector, settings, correction_mode=mode,
        )
        return DemoPipelineRunner(pipeline, DiarizationService(ReplicateDiarizationAdapter(settings)),
                                  language=settings.audio_asr_language, close=resources.close)
    except Exception:
        try:
            resources.close()
        except Exception:
            pass
    raise ConfigurationError("Demo AI initialization failed")
