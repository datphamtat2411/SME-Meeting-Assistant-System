"""Opt-in, bounded native ASR with one classified transition to legacy chunks.

Plans and public telemetry are text-free. Execution results are transient borrowed
evidence; this module owns neither normalized artifacts nor provider clients.
Unknown verified duration is uncertainty, not unlimited support: native execution
is restricted by an explicit internal sample trial ceiling and upload eligibility.
"""

import hashlib
import time
import traceback
from concurrent.futures import CancelledError
from dataclasses import dataclass, field, replace
from enum import StrEnum
from fractions import Fraction
from threading import Lock

from sme_meeting_ai.audio.models import NormalizedAudioArtifact, SampleInterval
from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.pipeline.models import PreprocessingResult

from .asr import (
    AsrCandidate,
    AsrCapabilityStatus,
    AsrError,
    AsrErrorCategory,
    AsrProvenance,
    AsrProviderCapabilities,
    AsrRoutingMode,
    AsrTimestampMode,
    AsrTranscriptionRequest,
    AsrUsage,
)
from .chunk_execution import AsrChunkResult
from .chunk_planning import (
    AsrChunk,
    AsrChunkPlan,
    ChunkBoundaryReason,
    ChunkPlanningProvenance,
    SpeechAwareAsrChunkPlanner,
    _configuration,
    _validate_handoff,
    validate_asr_chunk_plan,
)

STRATEGY_VERSION = "adaptive-asr-v1"
_FALLBACK = frozenset((AsrErrorCategory.TIMEOUT, AsrErrorCategory.TRANSPORT,
                       AsrErrorCategory.PROVIDER, AsrErrorCategory.MALFORMED_OUTPUT))


class AsrStrategy(StrEnum):
    WHOLE_FILE = "whole-file"
    CHUNKED = "chunked"


class AsrStrategyReason(StrEnum):
    NATIVE_ELIGIBLE = "native-eligible"
    ADAPTIVE_DISABLED = "adaptive-disabled"
    NATIVE_SAMPLE_LIMIT = "native-sample-limit"
    NATIVE_PAYLOAD_LIMIT = "native-payload-limit"
    UNSUPPORTED_PROVIDER_CAPABILITY = "unsupported-provider-capability"
    MISSING_V2_CONTRACT = "missing-v2-contract"
    CHUNKED_REQUIRED = "chunked-required"


class NativeAttemptOutcome(StrEnum):
    NOT_ATTEMPTED = "not-attempted"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class AsrStrategyDecision:
    selected_strategy: AsrStrategy
    policy_version: str
    reason: AsrStrategyReason
    source_sample_count: int
    estimated_payload_bytes: int
    effective_payload_limit: int


@dataclass(frozen=True, slots=True)
class AsrStrategyTelemetry:
    decision: AsrStrategyDecision
    selected_strategy: AsrStrategy
    native_attempt_outcome: NativeAttemptOutcome
    native_failure: AsrErrorCategory | None
    native_attempts: int
    native_successes: int
    native_failures: int
    chunked_baseline_calls: int
    recovery_calls: int
    total_actual_asr_calls: int
    fallback_used: bool
    fallback_reason: AsrErrorCategory | None
    reported_asr_cost: Fraction | None
    reported_cost_call_count: int
    reported_cost_subtotal: Fraction | None
    provider_provenance: tuple[tuple[str, str, AsrProvenance], ...]
    # Timings describe a run, not deterministic strategy/evidence identity.
    native_duration_ns: int = field(compare=False)
    chunked_duration_ns: int = field(compare=False)
    total_asr_duration_ns: int = field(compare=False)

    @property
    def strategy_reason(self) -> AsrStrategyReason:
        return self.decision.reason


@dataclass(frozen=True, slots=True)
class AsrStrategyExecutionResult:
    selected_strategy: AsrStrategy
    plan: AsrChunkPlan
    baseline: tuple[AsrChunkResult, ...] = field(repr=False)
    telemetry: AsrStrategyTelemetry


def _require(condition: bool, category=AsrErrorCategory.VALIDATION) -> None:
    if not condition:
        raise AsrError(category)


def build_whole_file_plan(
    preprocessing: PreprocessingResult, settings: Settings, effective_payload_limit: int,
) -> AsrChunkPlan:
    """One real request, full-source core, no legacy target/overlap geometry."""
    _validate_handoff(preprocessing)
    geometry = _configuration(settings)
    count = preprocessing.normalized_artifact.sample_count
    ceiling = settings.audio_asr_native_max_samples
    _require(type(ceiling) is int and 0 < count <= ceiling <= 230400000)
    _require(type(effective_payload_limit) is int
             and 44 + count * 2 <= effective_payload_limit <= settings.audio_asr_max_payload_bytes)
    configuration = {
        "target_core_samples": count, "max_request_samples": count,
        "overlap_samples": 0, "boundary_search_samples": 0, "max_chunks": 1,
        "max_core_samples": count, "left_context_samples": 0, "right_context_samples": 0,
        "minimum_progress_samples": count, "max_timeline_samples": geometry["max_timeline_samples"],
        "native_max_samples": ceiling, "effective_payload_limit": effective_payload_limit,
        "expected_wav_bytes": 44 + count * 2,
    }
    interval = SampleInterval(0, count)
    plan = AsrChunkPlan(preprocessing.provenance.source_id, count, (
        AsrChunk("chunk-000000", 0, interval, interval,
                 ChunkBoundaryReason.TIMELINE_START, ChunkBoundaryReason.TIMELINE_END),
    ), ChunkPlanningProvenance("whole-file-v1", preprocessing.provenance, configuration))
    validate_asr_chunk_plan(plan)
    return plan


def _capabilities(transcriber) -> AsrProviderCapabilities | None:
    try:
        value = transcriber.capabilities
        if isinstance(value, AsrProviderCapabilities):
            return value
    except Exception:
        pass
    return None


def _supported(capabilities, settings, count) -> bool:
    if capabilities is None:
        return False
    ceiling = capabilities.verified_duration_ceiling
    return (
        capabilities.gateway == "openrouter"
        and capabilities.model == settings.audio_asr_model == "openai/whisper-large-v3"
        and settings.audio_asr_language == "vi"
        and capabilities.transport == "https-multipart" and capabilities.audio_format == "wav"
        and capabilities.response_format == "verbose_json"
        and isinstance(capabilities.timestamp_modes, tuple)
        and any(mode is AsrTimestampMode.SEGMENT for mode in capabilities.timestamp_modes)
        and isinstance(capabilities.segment_timestamp_status, AsrCapabilityStatus)
        and capabilities.segment_timestamp_status in (AsrCapabilityStatus.DOCUMENTED, AsrCapabilityStatus.LIVE_VERIFIED)
        and isinstance(capabilities.capability_status, AsrCapabilityStatus)
        and capabilities.capability_status in (AsrCapabilityStatus.DOCUMENTED, AsrCapabilityStatus.LIVE_VERIFIED)
        and capabilities.routing_mode is AsrRoutingMode.ROUTED_UPSTREAM
        and type(capabilities.effective_payload_limit) is int
        and 0 < capabilities.effective_payload_limit <= 26214400
        and (ceiling is None or (isinstance(ceiling, Fraction) and Fraction(count, 16000) <= ceiling))
    )


def _public_identity(value, approved) -> str | None:
    if value is None:
        return None
    if value in approved:
        return value
    # Preserve distinguishability without publishing arbitrary provider identifiers.
    return "sha256-" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def _public_provenance(candidate) -> AsrProvenance | None:
    from .reconciliation import _safe_provenance

    try:
        safe = _safe_provenance(candidate.provenance)
        return replace(
            safe, provider=_public_identity(safe.provider, {"openrouter"}),
            requested_model=_public_identity(safe.requested_model, {"openai/whisper-large-v3"}),
            resolved_model=_public_identity(safe.resolved_model, {"openai/whisper-large-v3", "whisper-large-v3"}),
            upstream_provider=_public_identity(safe.upstream_provider, {
                "DeepInfra", "deepinfra", "Together", "together", "Groq", "groq", "OpenAI", "openai",
            }),
            inference_config=tuple((key, value) for key, value in safe.inference_config
                                   if key == "temperature" or (key == "language" and value == "vi")),
        )
    except Exception:
        return None


class _TrackedTranscriber:
    """Minimal V2-to-legacy bridge at the actual local request boundary."""

    def __init__(self, runner):
        self._runner = runner

    def transcribe(self, audio):
        runner = self._runner
        phase = runner._phase
        with runner._lock:
            if runner._adaptive:
                _require(sum(runner._calls.values()) < runner._settings.audio_asr_adaptive_max_total_calls,
                         AsrErrorCategory.RESOURCE)
            runner._calls[phase] += 1
        candidate = None
        started = time.monotonic_ns()
        try:
            if callable(getattr(runner._transcriber, "transcribe_request", None)):
                candidate = runner._transcriber.transcribe_request(
                    AsrTranscriptionRequest(audio, AsrTimestampMode.SEGMENT),
                )
            else:
                candidate = runner._transcriber.transcribe(audio)
            return candidate
        except BaseException as error:
            if not isinstance(error, Exception) or isinstance(error, CancelledError):
                # Preserve cancellation identity, not provider diagnostic wording.
                error.args = ()
                error.__cause__ = error.__context__ = None
            raise
        finally:
            elapsed = time.monotonic_ns() - started
            with runner._lock:
                if phase == "recovery":
                    runner._recovery_duration_ns += elapsed
                if isinstance(candidate, AsrCandidate):
                    usage = candidate.usage
                    if (isinstance(usage, AsrUsage) and isinstance(usage.cost, Fraction)
                            and usage.cost >= 0 and usage.cost.numerator.bit_length() <= 512
                            and usage.cost.denominator.bit_length() <= 512):
                        runner._cost += usage.cost
                        runner._cost_calls += 1
                    provenance = _public_provenance(candidate)
                    if provenance is not None:
                        runner._provenance.append((phase, audio.chunk_id, provenance))
            candidate = audio = None


class AsrStrategyRunner:
    """Per-run preparation, execution and Recovery policy; never reuse after execution."""

    def __init__(self, transcriber, settings: Settings):
        _require(isinstance(settings, Settings))
        _require(settings.audio_asr_strategy_mode in ("chunked", "adaptive"))
        _require(type(settings.audio_asr_native_max_samples) is int
                 and 1 <= settings.audio_asr_native_max_samples <= 230400000)
        _require(type(settings.audio_asr_adaptive_max_total_calls) is int
                 and 1 <= settings.audio_asr_adaptive_max_total_calls <= 65793)
        self._settings = settings.model_copy(deep=True)
        self._adaptive = settings.audio_asr_strategy_mode == "adaptive"
        self._transcriber = transcriber
        self._bridge = _TrackedTranscriber(self)
        self._lock = Lock()
        self._calls = dict(native=0, chunked=0, recovery=0)
        self._phase = "chunked"
        self._decision = self.plan = self._fallback_plan = None
        self._selected = AsrStrategy.CHUNKED
        self._native_outcome = NativeAttemptOutcome.NOT_ATTEMPTED
        self._native_failure = self._fallback_reason = None
        self._fallback_used = False
        self._native_duration_ns = self._chunked_duration_ns = self._recovery_duration_ns = 0
        self._cost, self._cost_calls, self._provenance = Fraction(0), 0, []
        self._prepared = self._executed = self._recovered = False

    @property
    def telemetry(self) -> AsrStrategyTelemetry | None:
        if self._decision is None:
            return None
        with self._lock:
            total = sum(self._calls.values())
            return AsrStrategyTelemetry(
                self._decision, self._selected, self._native_outcome, self._native_failure,
                self._calls["native"], int(self._native_outcome is NativeAttemptOutcome.SUCCEEDED),
                int(self._native_outcome is NativeAttemptOutcome.FAILED),
                self._calls["chunked"], self._calls["recovery"], total,
                self._fallback_used, self._fallback_reason,
                self._cost if total and self._cost_calls == total else None, self._cost_calls,
                self._cost if self._cost_calls else None,
                tuple(sorted(self._provenance, key=lambda item: (item[0], item[1]))),
                self._native_duration_ns, self._chunked_duration_ns,
                self._native_duration_ns + self._chunked_duration_ns + self._recovery_duration_ns,
            )

    def prepare(self, preprocessing: PreprocessingResult, planner: SpeechAwareAsrChunkPlanner) -> AsrStrategyDecision:
        from .chunk_execution import _validate_handoff as validate_execution
        from .recovery import _configuration as recovery_configuration

        _require(not self._executed)
        self._prepared = False
        _validate_handoff(preprocessing)
        settings = self._settings
        capabilities = _capabilities(self._transcriber)
        limit = settings.audio_asr_max_payload_bytes
        if (capabilities is not None and type(capabilities.effective_payload_limit) is int
                and 0 < capabilities.effective_payload_limit <= 26214400):
            limit = min(limit, capabilities.effective_payload_limit)
        count = preprocessing.normalized_artifact.sample_count
        expected_bytes = 44 + count * 2
        reason = AsrStrategyReason.CHUNKED_REQUIRED
        if not self._adaptive:
            reason = AsrStrategyReason.ADAPTIVE_DISABLED
        elif not callable(getattr(self._transcriber, "transcribe_request", None)) or capabilities is None:
            reason = AsrStrategyReason.MISSING_V2_CONTRACT
        elif not _supported(capabilities, settings, count):
            reason = AsrStrategyReason.UNSUPPORTED_PROVIDER_CAPABILITY
        elif count > settings.audio_asr_native_max_samples:
            reason = AsrStrategyReason.NATIVE_SAMPLE_LIMIT
        elif expected_bytes > limit:
            reason = AsrStrategyReason.NATIVE_PAYLOAD_LIMIT
        else:
            reason = AsrStrategyReason.NATIVE_ELIGIBLE
        selected = AsrStrategy.WHOLE_FILE if reason is AsrStrategyReason.NATIVE_ELIGIBLE else AsrStrategy.CHUNKED
        self._decision = AsrStrategyDecision(selected, STRATEGY_VERSION, reason, count, expected_bytes, limit)
        self._selected = selected
        # Prepare but never execute baseline comparison work speculatively.
        chunked = planner.plan(preprocessing)
        validate_asr_chunk_plan(chunked)
        _require(chunked.source_id == preprocessing.provenance.source_id
                 and chunked.sample_count == count and chunked.provenance.preprocessing == preprocessing.provenance)
        self._fallback_plan = chunked
        self._settings = settings.model_copy(update={"audio_asr_max_payload_bytes": limit})
        if self._adaptive:
            recovery = recovery_configuration(self._settings)
            chunked_calls = len(chunked.chunks) + recovery["max_total_attempts"]
            budget = settings.audio_asr_adaptive_max_total_calls
            if selected is AsrStrategy.WHOLE_FILE and chunked_calls == budget:
                # Native plus its full fallback cannot fit, but chunked alone can.
                selected = self._selected = AsrStrategy.CHUNKED
                self._decision = replace(self._decision, selected_strategy=selected,
                                         reason=AsrStrategyReason.CHUNKED_REQUIRED)
            _require(int(selected is AsrStrategy.WHOLE_FILE) + chunked_calls <= budget, AsrErrorCategory.RESOURCE)
        self.plan = (build_whole_file_plan(preprocessing, settings, limit)
                     if selected is AsrStrategy.WHOLE_FILE else chunked)
        for chunk in chunked.chunks:
            _require(44 + (chunk.request_interval.end_sample - chunk.request_interval.start_sample) * 2 <= limit,
                     AsrErrorCategory.RESOURCE)
        if self._adaptive:
            validate_execution(chunked, preprocessing.normalized_artifact, self._bridge, self._settings)
            validate_execution(self.plan, preprocessing.normalized_artifact, self._bridge, self._settings)
        self._prepared = True
        return self._decision

    def _execute_plan(self, audio, phase):
        from .chunk_execution import execute_asr_chunks

        self._phase = phase
        started = time.monotonic_ns()
        try:
            return execute_asr_chunks(self.plan, audio, self._bridge, self._settings)
        except CancelledError:
            raise
        except AsrError as error:
            failure = error.category
            traceback.clear_frames(error.__traceback__)
        except Exception as error:
            failure = AsrErrorCategory.RESOURCE
            traceback.clear_frames(error.__traceback__)
        finally:
            elapsed = time.monotonic_ns() - started
            if phase == "native":
                self._native_duration_ns += elapsed
            else:
                self._chunked_duration_ns += elapsed
        if phase == "native" and self._calls["native"]:
            self._native_outcome = NativeAttemptOutcome.FAILED
            self._native_failure = failure
        raise AsrError(failure)

    def execute(self, audio: NormalizedAudioArtifact) -> AsrStrategyExecutionResult:
        from .coverage import _valid_result
        from .reconciliation import _safe_provenance

        _require(self._prepared and self.plan is not None and not self._executed)
        self._executed = True
        if self._selected is AsrStrategy.WHOLE_FILE:
            native, = self._execute_plan(audio, "native")
            failure = native.failure
            if failure is None:
                valid = _valid_result(native)
                try:
                    provenance = _safe_provenance(native.candidate.provenance)
                    valid = valid and provenance.provider == "openrouter"
                    valid = valid and provenance.requested_model == "openai/whisper-large-v3"
                    valid = valid and all(key != "language" or value == "vi"
                                          for key, value in provenance.inference_config)
                except Exception:
                    valid = False
                if not valid:
                    failure = AsrErrorCategory.MALFORMED_OUTPUT
            if failure is None:
                self._native_outcome = NativeAttemptOutcome.SUCCEEDED
                return AsrStrategyExecutionResult(self._selected, self.plan, (native,), self.telemetry)
            self._native_outcome = NativeAttemptOutcome.FAILED
            self._native_failure = failure
            # Never salvage failed native text or keep it in fallback evidence.
            native = None
            if failure not in _FALLBACK:
                raise AsrError(failure)
            self._fallback_used, self._fallback_reason = True, failure
            self._selected, self.plan = AsrStrategy.CHUNKED, self._fallback_plan
        baseline = self._execute_plan(audio, "chunked")
        if self._fallback_used:
            failure = next((item.failure for item in baseline if item.failure is not None), None)
            if failure is not None:
                raise AsrError(failure)
        return AsrStrategyExecutionResult(self._selected, self.plan, baseline, self.telemetry)

    def recover(self, preprocessing: PreprocessingResult, execution: AsrStrategyExecutionResult):
        from .coverage import assess_speech_coverage
        from .recovery import (
            RecoveryProvenance,
            RecoveryStopReason,
            SpeechRecoveryResult,
            recover_speech,
        )

        _require(self._executed and not self._recovered and execution.plan == self.plan)
        self._recovered = True
        if execution.selected_strategy is AsrStrategy.WHOLE_FILE:
            coverage = assess_speech_coverage(preprocessing, execution.plan, execution.baseline, self._settings)
            return SpeechRecoveryResult(
                execution.baseline, (), coverage, coverage, (), RecoveryStopReason.SKIPPED_BY_ASR_STRATEGY,
                RecoveryProvenance("strategy-skipped-v1", execution.plan.provenance, {"executed_requests": 0}),
            )
        self._phase = "recovery"
        return recover_speech(preprocessing, execution.plan, execution.baseline, self._bridge, self._settings)
