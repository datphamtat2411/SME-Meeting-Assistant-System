import copy
import math
import struct
import traceback
from dataclasses import FrozenInstanceError, replace
from fractions import Fraction
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

from sme_meeting_ai.audio.errors import AudioProcessingError
from sme_meeting_ai.audio.models import (
    AudioProbe,
    AudioProvenance,
    DetectionProvenance,
    NormalizedAudioArtifact,
    SampleInterval,
    SpeechEnergyEvidence,
    SpeechMap,
    SpeechMapProvenance,
    SpeechMapQuality,
)
from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.pipeline import (
    PreprocessingAudioMetadata,
    PreprocessingProvenance,
    PreprocessingResult,
)
from sme_meeting_ai.transcription import (
    AsrChunk,
    AsrChunkPlan,
    ChunkBoundaryReason,
    ChunkPlanningProvenance,
    SpeechAwareAsrChunkPlanner,
    validate_asr_chunk_plan,
)


@pytest.mark.parametrize("kind", ["version", "geometry", "payload", "source", "ordinal", "boundary"])
def test_whole_file_plan_validation_does_not_admit_forged_plans(result_factory, kind):
    from sme_meeting_ai.transcription.asr_strategy import build_whole_file_plan

    result = result_factory(128000)
    native = build_whole_file_plan(result, settings(), 256044)
    validate_asr_chunk_plan(native)
    if kind == "version":
        legacy = SpeechAwareAsrChunkPlanner(settings()).plan(result)
        invalid = replace(legacy, provenance=replace(legacy.provenance, planner_version="whole-file-v1"))
    elif kind == "geometry":
        invalid = replace(native, chunks=(replace(native.chunks[0], request_interval=SampleInterval(0, 999)),))
    elif kind == "payload":
        config = dict(native.provenance.effective_configuration) | {"effective_payload_limit": 2043}
        invalid = replace(native, provenance=replace(native.provenance, effective_configuration=config))
    elif kind == "source":
        invalid = replace(native, source_id="different-source")
    elif kind == "ordinal":
        invalid = replace(native, chunks=(replace(native.chunks[0], ordinal=1),))
    else:
        invalid = replace(native, chunks=(replace(native.chunks[0],
                          end_boundary_reason=ChunkBoundaryReason.FORCED_CONTINUOUS_SPEECH),))
    with pytest.raises(AudioProcessingError):
        validate_asr_chunk_plan(invalid)
    legacy = SpeechAwareAsrChunkPlanner(settings()).plan(result)
    with pytest.raises(AudioProcessingError):
        validate_asr_chunk_plan(replace(legacy, chunks=(legacy.chunks[0],)))


def settings(**overrides):
    values = {
        "audio_asr_chunk_target_samples": 32000,
        "audio_asr_chunk_max_request_samples": 48000,
        "audio_asr_chunk_overlap_samples": 8000,
        "audio_asr_chunk_boundary_search_samples": 8000,
    }
    return Settings(
        service_name="test-ai", service_identity="ai-core", _env_file=None,
        **(values | overrides),
    )


@pytest.fixture
def result_factory(tmp_path):
    temporary_directories = []

    def make(sample_count=128000, *, speech=None, protected=None, uncertain=(), observations=None):
        if speech is None:
            speech = ((0, sample_count),) if sample_count > 0 else ()
        if protected is None:
            protected = speech
        audio_temp = TemporaryDirectory(dir=tmp_path)
        evidence_temp = TemporaryDirectory(dir=tmp_path)
        temporary_directories.extend((audio_temp, evidence_temp))
        audio_path = Path(audio_temp.name) / "private-cuoc-hop.wav"
        evidence_path = Path(evidence_temp.name) / "evidence.bin"
        # Planning may replay frame evidence, but must never open PCM.
        audio_path.write_bytes(b"preprocessing-owned PCM sentinel")
        probe = AudioProbe("recording-1", "wav", "pcm_s16le", 48000, 2, "stereo", None, 0)
        normalization = AudioProvenance(
            "recording-1", "1", "ffmpeg", "7-test",
            {"container": "wav", "codec": "pcm_s16le", "sample_format": "s16",
             "sample_rate_hz": 16000, "channels": 1},
            {"max_duration_seconds": 3600},
        )
        detection = DetectionProvenance(
            "silero-test", "5", "a" * 64, "test-backend", "1",
            {"sample_rate_hz": 16000, "frame_samples": 512,
             "tail_padding": "model-only-zero-padding",
             "speech_threshold": 0.6, "non_speech_threshold": 0.35},
        )
        frame_count = (sample_count + 511) // 512
        records, counts = [], [0, 0, 0]
        for start in range(0, sample_count, 512):
            probability = (0.9 if any(a <= start < b for a, b in speech) else
                           0.5 if any(a <= start < b for a, b in uncertain) else 0.1)
            probability, rms = (observations or {}).get(start, (probability, 0.1))
            label = 0 if probability >= 0.6 else 1 if probability <= 0.35 else 2
            counts[label] += 1
            end = min(start + 512, sample_count)
            records.append(struct.pack("<QQdddBI", start, end, probability, rms,
                                       20 * math.log10(rms) if rms else -math.inf, label, 512 - end + start))
        evidence_path.write_bytes(b"SMEEVD\x00\x01" + b"".join(records))
        speech_count, non_speech_count, uncertain_count = counts
        audio = NormalizedAudioArtifact(
            audio_path, "recording-1", probe, sample_count, normalization, audio_temp,
        )
        evidence = SpeechEnergyEvidence(
            "recording-1", sample_count, frame_count, speech_count, non_speech_count,
            uncertain_count, detection, evidence_path, evidence_temp,
        )
        map_provenance = SpeechMapProvenance(
            "recording-1", sample_count, "1", detection,
            {"boundary_padding_samples": 0, "merge_gap_samples": 0, "energy_floor_dbfs": -50},
        )
        speech_map = SpeechMap(
            tuple(SampleInterval(*bounds) for bounds in speech),
            tuple(SampleInterval(*bounds) for bounds in protected),
            tuple(SampleInterval(*bounds) for bounds in uncertain),
            SpeechMapQuality(
                frame_count, speech_count, non_speech_count, uncertain_count,
                0, 0, 0, len(speech) - len(protected),
            ),
            map_provenance,
        )
        return PreprocessingResult(
            audio, PreprocessingAudioMetadata(probe, sample_count), evidence,
            speech_map, speech_map.quality.warnings,
            PreprocessingProvenance("1", "recording-1", sample_count,
                                    normalization, detection, map_provenance),
        )

    yield make
    for temporary in reversed(temporary_directories):
        temporary.cleanup()


def assert_partition(plan, configuration):
    assert isinstance(plan, AsrChunkPlan)
    assert isinstance(plan.chunks, tuple)
    assert plan.chunks
    position = 0
    for ordinal, chunk in enumerate(plan.chunks):
        assert isinstance(chunk, AsrChunk)
        core, request = chunk.core_interval, chunk.request_interval
        assert chunk.ordinal == ordinal
        assert chunk.chunk_id == f"chunk-{ordinal:06d}"
        assert core.start_sample == position
        assert 0 <= request.start_sample <= core.start_sample < core.end_sample <= request.end_sample <= plan.sample_count
        assert core.end_sample - core.start_sample <= plan.provenance.effective_configuration["max_core_samples"]
        assert request.end_sample - request.start_sample <= configuration.audio_asr_chunk_max_request_samples
        assert all(type(value) is int for value in (
            core.start_sample, core.end_sample, request.start_sample, request.end_sample,
        ))
        if ordinal:
            previous = plan.chunks[ordinal - 1]
            assert previous.end_boundary_reason == chunk.start_boundary_reason
        position = core.end_sample
    assert position == plan.sample_count
    assert plan.chunks[0].start_boundary_reason is ChunkBoundaryReason.TIMELINE_START
    assert plan.chunks[-1].end_boundary_reason is ChunkBoundaryReason.TIMELINE_END


def test_continuous_speech_uses_acoustic_valley_not_maximum_core(result_factory):
    configuration = settings()
    result = result_factory(observations={30720: (0.05, 0.0)})
    plan = SpeechAwareAsrChunkPlanner(configuration).plan(result)
    assert_partition(plan, configuration)
    assert plan.chunks[0].core_interval.end_sample == 30720
    assert plan.chunks[0].core_interval.end_sample != 40000
    assert all(chunk.end_boundary_reason is ChunkBoundaryReason.FORCED_CONTINUOUS_SPEECH for chunk in plan.chunks[:-1])


@pytest.mark.parametrize("speech,expected", [
    (((0, 30000), (34000, 128000)), 32000),
    (((0, 26000), (30000, 34000), (38000, 128000)), 28000),
    (((0, 26000), (30000, 33000), (39000, 128000)), 36000),  # Wider gap wins tie.
])
def test_natural_midpoint_distance_width_and_earlier_ties(result_factory, speech, expected):
    planner = SpeechAwareAsrChunkPlanner(settings())
    result = result_factory(speech=speech)
    plan = planner.plan(result)
    assert plan.chunks[0].core_interval.end_sample == expected
    assert plan.chunks[0].end_boundary_reason is ChunkBoundaryReason.NATURAL_SILENCE_CANDIDATE
    assert planner.plan(result) == plan
    assert_partition(plan, settings())


@pytest.mark.parametrize("uncertain", [((30000, 34000),), ((29000, 32000), (32500, 35000))])
def test_union_of_protection_and_uncertainty_blocks_natural_boundaries(result_factory, uncertain):
    result = result_factory(speech=((0, 28000), (36000, 128000)),
                            protected=((0, 30000), (34000, 128000)), uncertain=uncertain)
    plan = SpeechAwareAsrChunkPlanner(settings()).plan(result)
    for chunk in plan.chunks:
        if chunk.end_boundary_reason is ChunkBoundaryReason.NATURAL_SILENCE_CANDIDATE:
            boundary = chunk.core_interval.end_sample
            assert all(not interval.start_sample <= boundary < interval.end_sample for interval in (
                *result.speech_map.protected_intervals, *result.speech_map.uncertain_intervals,
            ))
    assert plan.chunks[0].end_boundary_reason is ChunkBoundaryReason.FORCED_CONTINUOUS_SPEECH
    assert_partition(plan, settings())


@pytest.mark.parametrize("sample_count", [1, 15, 32000, 40000])
def test_short_or_exact_maximum_recording_has_one_terminal_core(result_factory, sample_count):
    plan = SpeechAwareAsrChunkPlanner(settings()).plan(result_factory(sample_count))
    assert len(plan.chunks) == 1
    assert plan.chunks[0].core_interval == SampleInterval(0, sample_count)
    assert plan.chunks[0].request_interval == SampleInterval(0, sample_count)
    assert_partition(plan, settings())


@pytest.mark.parametrize("overlap", [2, 31, 8000, 80000])
@pytest.mark.parametrize("natural", [False, True])
def test_variable_symmetric_context_and_overlap_cap(result_factory, overlap, natural):
    configuration = settings(audio_asr_chunk_overlap_samples=overlap,
                             audio_asr_chunk_max_request_samples=48000 + overlap)
    source = result_factory(160000, speech=() if natural else None)
    plan = SpeechAwareAsrChunkPlanner(configuration).plan(source)
    assert_partition(plan, configuration)
    context = min(1600 if natural else 16000, overlap // 2)
    for previous, chunk in zip(plan.chunks, plan.chunks[1:]):
        boundary = chunk.core_interval.start_sample
        assert previous.request_interval.end_sample == min(160000, boundary + context)
        assert chunk.request_interval.start_sample == max(0, boundary - context)
        assert previous.request_interval.end_sample - chunk.request_interval.start_sample <= overlap


@pytest.mark.parametrize("sample_count", [40001, 63999, 64000, 64001, 127999, 128000])
def test_all_provisional_silence_is_retained_in_target_cores(result_factory, sample_count):
    configuration = settings()
    plan = SpeechAwareAsrChunkPlanner(configuration).plan(result_factory(sample_count, speech=()))
    assert_partition(plan, configuration)
    assert all(chunk.end_boundary_reason is ChunkBoundaryReason.NATURAL_SILENCE_CANDIDATE for chunk in plan.chunks[:-1])
    assert sum(chunk.core_interval.end_sample - chunk.core_interval.start_sample for chunk in plan.chunks) == sample_count


@pytest.mark.parametrize("overlap", [0, 1])
def test_forced_cut_without_context_fails_closed(result_factory, overlap):
    with pytest.raises(AudioProcessingError):
        SpeechAwareAsrChunkPlanner(settings(audio_asr_chunk_overlap_samples=overlap)).plan(result_factory())


def test_provenance_and_models_are_immutable_deterministic_snapshots(result_factory):
    configuration = settings()
    result = result_factory()
    planner = SpeechAwareAsrChunkPlanner(configuration)
    plan = planner.plan(result)
    assert planner.plan(result) == plan
    assert plan.source_id == result.provenance.source_id
    assert plan.sample_count == result.normalized_artifact.sample_count
    assert isinstance(plan.provenance, ChunkPlanningProvenance)
    assert plan.provenance.planner_version == "speech-aware-v3"
    assert plan.provenance.sample_rate_hz == 16000
    assert plan.provenance.preprocessing == result.provenance
    captured = plan.provenance.effective_configuration
    assert captured["natural_context_samples"] == 1600
    assert captured["forced_context_samples"] == 4000
    assert captured["max_core_samples"] == 40000
    assert captured["minimum_progress_samples"] == 16000
    assert captured["effective_payload_limit"] == 25000000
    with pytest.raises(FrozenInstanceError):
        plan.sample_count = 1
    with pytest.raises(FrozenInstanceError):
        plan.chunks[0].ordinal = 9
    with pytest.raises(FrozenInstanceError):
        plan.provenance.planner_version = "other"
    with pytest.raises(TypeError):
        plan.provenance.effective_configuration["overlap_samples"] = 0
    with pytest.raises(TypeError):
        plan.provenance.preprocessing.normalization.target_format["channels"] = 2
    result.normalized_artifact.provenance.target_format["channels"] = 2
    configuration.audio_asr_chunk_overlap_samples = 0
    assert plan.provenance.preprocessing.normalization.target_format["channels"] == 1
    assert plan.provenance.effective_configuration["overlap_samples"] == 8000
    validate_asr_chunk_plan(plan)  # Independent of mutated Settings and open files.


def altered(value, **changes):
    duplicate = copy.copy(value)
    for name, item in changes.items():
        object.__setattr__(duplicate, name, item)
    return duplicate


@pytest.mark.parametrize("mutate", [
    lambda r: None,
    lambda r: r.normalized_artifact,
    lambda r: replace(r, normalized_artifact=None),
    lambda r: replace(r, normalized_artifact=replace(r.normalized_artifact, source_id="private-other")),
    lambda r: replace(r, normalized_artifact=replace(r.normalized_artifact, sample_count=True)),
    lambda r: replace(r, normalized_artifact=altered(r.normalized_artifact, sample_rate_hz=8000)),
    lambda r: replace(r, normalized_artifact=altered(r.normalized_artifact, channels=2)),
    lambda r: replace(r, normalized_artifact=altered(r.normalized_artifact, sample_format="f32")),
    lambda r: replace(r, audio_metadata=replace(r.audio_metadata, sample_count=999)),
    lambda r: replace(r, audio_metadata=altered(r.audio_metadata, sample_rate_hz=8000)),
    lambda r: replace(r, audio_metadata=altered(r.audio_metadata, channels=True)),
    lambda r: replace(r, speech_evidence=replace(r.speech_evidence, source_id="private-other")),
    lambda r: replace(r, speech_evidence=replace(r.speech_evidence, sample_count=999)),
    lambda r: replace(r, provenance=None),
    lambda r: replace(r, provenance=replace(r.provenance, pipeline_version="")),
    lambda r: replace(r, provenance=replace(r.provenance, source_id="private-other")),
    lambda r: replace(r, provenance=replace(r.provenance, sample_count=True)),
    lambda r: replace(r, provenance=replace(r.provenance, normalization=None)),
    lambda r: replace(r, provenance=replace(r.provenance, detection=None)),
    lambda r: replace(r, provenance=replace(r.provenance, speech_map=None)),
    lambda r: replace(r, provenance=replace(r.provenance, detection=replace(r.provenance.detection, model_version="private-other"))),
    lambda r: replace(r, speech_map=replace(r.speech_map, provenance=replace(r.speech_map.provenance, sample_count=999))),
    lambda r: replace(r, speech_map=replace(r.speech_map, protected_intervals=())),
    lambda r: replace(r, speech_map=replace(r.speech_map, uncertain_intervals=(SampleInterval(500, 600), SampleInterval(400, 450)))),
    lambda r: replace(r, speech_map=replace(r.speech_map, protected_intervals=(SampleInterval(0, 1001),))),
    lambda r: replace(r, speech_map=replace(r.speech_map, protected_intervals=(altered(SampleInterval(0, 1000), start_sample=-1),))),
    lambda r: replace(r, speech_map=replace(r.speech_map, uncertain_intervals=(altered(SampleInterval(0, 1), start_sample=True),))),
    lambda r: replace(r, speech_map=replace(r.speech_map, speech_intervals=(altered(SampleInterval(0, 1), end_sample=1.5),))),
    lambda r: replace(r, warnings=("private-warning",)),
])
def test_malformed_handoffs_fail_sanitized_without_publishing_a_plan(result_factory, mutate):
    result = mutate(result_factory())
    with pytest.raises(AudioProcessingError) as caught:
        SpeechAwareAsrChunkPlanner(settings()).plan(result)
    assert caught.value.category == "VALIDATION"
    assert caught.value.__context__ is None
    assert "private-" not in "".join(traceback.format_exception(caught.value))


def test_zero_length_fails_validation(result_factory):
    with pytest.raises(AudioProcessingError) as caught:
        SpeechAwareAsrChunkPlanner(settings()).plan(result_factory(0))
    assert caught.value.category == "VALIDATION"


@pytest.mark.parametrize("duration", [0.0100625, 0.01009])
def test_duration_ceiling_uses_exact_fraction_sample_arithmetic(result_factory, duration):
    configuration = settings(audio_max_duration_seconds=duration)
    planner = SpeechAwareAsrChunkPlanner(configuration)
    exact_limit = Fraction(str(configuration.audio_max_duration_seconds)) * 16000
    assert 161 <= exact_limit < 162
    plan = planner.plan(result_factory(161))
    assert plan.provenance.effective_configuration["max_timeline_samples"] == 161
    with pytest.raises(AudioProcessingError) as caught:
        planner.plan(result_factory(162))
    assert caught.value.category == "RESOURCE"


@pytest.mark.parametrize("speech", [None, ()])
def test_chunk_count_overflow_is_resource_failure_without_partial_results(result_factory, speech):
    planner = SpeechAwareAsrChunkPlanner(settings(audio_asr_chunk_max_chunks=2))
    result = result_factory(speech=speech)
    with pytest.raises(AudioProcessingError) as caught:
        planner.plan(result)
    assert caught.value.category == "RESOURCE"


@pytest.mark.parametrize("overrides", [
    {"audio_asr_chunk_target_samples": 0},
    {"audio_asr_chunk_target_samples": True},
    {"audio_asr_chunk_overlap_samples": 30.0},
    {"audio_asr_chunk_overlap_samples": 48000},
    {"audio_asr_chunk_max_request_samples": 39999},
    {"audio_asr_chunk_boundary_search_samples": 32000},
    {"audio_asr_chunk_max_chunks": 0},
    {"audio_max_duration_seconds": float("nan")},
])
def test_impossible_or_unvalidated_configuration_fails_sanitized(overrides):
    invalid = settings().model_copy(update=overrides)
    with pytest.raises(AudioProcessingError) as caught:
        SpeechAwareAsrChunkPlanner(invalid)
    assert caught.value.category == "VALIDATION"
    assert caught.value.__context__ is None


@pytest.mark.parametrize("max_chunks", [4096, 1])
def test_planning_replays_only_frames_without_changing_or_closing_artifacts(result_factory, monkeypatch, max_chunks):
    result = result_factory()
    audio, evidence = result.normalized_artifact, result.speech_evidence
    audio_bytes, evidence_bytes = audio.path.read_bytes(), evidence._path.read_bytes()

    def forbidden(*args, **kwargs):
        pytest.fail("planner accessed preprocessing-owned resources")

    original_open = Path.open

    def open_evidence_only(path, *args, **kwargs):
        assert path != audio.path
        return original_open(path, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(NormalizedAudioArtifact, "close", forbidden)
        patch.setattr(SpeechEnergyEvidence, "close", forbidden)
        patch.setattr(Path, "open", open_evidence_only)
        planner = SpeechAwareAsrChunkPlanner(settings(audio_asr_chunk_max_chunks=max_chunks))
        if max_chunks == 1:
            with pytest.raises(AudioProcessingError):
                planner.plan(result)
        else:
            planner.plan(result)
    assert audio.path.read_bytes() == audio_bytes
    assert evidence._path.read_bytes() == evidence_bytes
    assert not evidence._closed


@pytest.mark.parametrize("gap_length", [3199, 3200, 3201])
def test_minimum_natural_gap_and_strict_safety_margin(result_factory, gap_length):
    start = 30400
    result = result_factory(speech=((0, start), (start + gap_length, 128000)))
    chunk = SpeechAwareAsrChunkPlanner(settings()).plan(result).chunks[0]
    natural = chunk.end_boundary_reason is ChunkBoundaryReason.NATURAL_SILENCE_CANDIDATE
    assert natural is (gap_length >= 3200)
    if natural:
        assert start + 800 < chunk.core_interval.end_sample < start + gap_length - 800


def test_forced_ranking_prioritizes_risk_probability_energy_then_distance(result_factory):
    result = result_factory(
        speech=((0, 29500), (34500, 128000)), uncertain=((29500, 34500),),
        observations={28672: (0.01, 0), 30720: (0.2, 0.02), 33280: (0.2, 0.01)},
    )
    plan = SpeechAwareAsrChunkPlanner(settings()).plan(result)
    assert plan.chunks[0].core_interval.end_sample == 33280  # Uncertain only beats protected.
    assert plan.boundary_decisions[0].uncertain and not plan.boundary_decisions[0].protected


@pytest.mark.parametrize("count", [40001, 40002, 72001, 80001, 128001])
def test_final_tail_remains_valid_without_tiny_fragment(result_factory, count):
    plan = SpeechAwareAsrChunkPlanner(settings()).plan(result_factory(count))
    assert_partition(plan, settings())
    minimum = plan.provenance.effective_configuration["minimum_progress_samples"]
    tail = plan.chunks[-1].core_interval.end_sample - plan.chunks[-1].core_interval.start_sample
    assert tail >= minimum or count in (40001, 40002)
    assert tail > 1


def test_effective_payload_geometry_is_captured_and_enforced(result_factory):
    planner = SpeechAwareAsrChunkPlanner(settings())
    plan = planner.plan(result_factory(), effective_payload_limit=72044)
    assert plan.provenance.effective_configuration["max_request_samples"] == 36000
    assert all(44 + 2 * (c.request_interval.end_sample - c.request_interval.start_sample) <= 72044
               for c in plan.chunks)
    with pytest.raises(AudioProcessingError):
        planner.plan(result_factory(), effective_payload_limit=44)


@pytest.mark.parametrize("kind", ["version", "context", "configuration", "decision", "source", "tail"])
def test_v2_snapshot_validation_rejects_fabrication(result_factory, kind):
    plan = SpeechAwareAsrChunkPlanner(settings()).plan(result_factory())
    if kind == "version":
        invalid = replace(plan, provenance=replace(plan.provenance, planner_version="arbitrary"))
    elif kind == "configuration":
        config = dict(plan.provenance.effective_configuration) | {"forced_context_samples": 1}
        invalid = replace(plan, provenance=replace(plan.provenance, effective_configuration=config))
    elif kind == "decision":
        invalid = replace(plan, boundary_decisions=())
    elif kind == "source":
        invalid = replace(plan, sample_count=plan.sample_count + 1)
    elif kind == "tail":
        invalid = replace(plan, chunks=plan.chunks[:-1])
    else:
        first = replace(plan.chunks[0], request_interval=plan.chunks[0].core_interval)
        invalid = replace(plan, chunks=(first, *plan.chunks[1:]))
    with pytest.raises(AudioProcessingError):
        validate_asr_chunk_plan(invalid)


@pytest.mark.parametrize("invalid", [float("nan"), float("inf"), -0.1])
def test_invalid_frame_evidence_is_rejected_sanitized(result_factory, monkeypatch, invalid):
    result = result_factory()
    original = SpeechEnergyEvidence.iter_frames

    def frames(self):
        for frame in original(self):
            yield replace(frame, vad_probability=invalid)

    monkeypatch.setattr(SpeechEnergyEvidence, "iter_frames", frames)
    with pytest.raises(AudioProcessingError) as caught:
        SpeechAwareAsrChunkPlanner(settings()).plan(result)
    assert caught.value.category == "VALIDATION" and caught.value.__context__ is None


def test_frames_are_replayed_once_and_bounded_by_declared_count(result_factory, monkeypatch):
    result = result_factory()
    original = SpeechEnergyEvidence.iter_frames
    visits = []

    def frames(self):
        for frame in original(self):
            visits.append(frame.start_sample)
            yield frame

    monkeypatch.setattr(SpeechEnergyEvidence, "iter_frames", frames)
    SpeechAwareAsrChunkPlanner(settings()).plan(result)
    assert visits == list(range(0, result.normalized_artifact.sample_count, 512))


def test_valid_snapshot_needs_neither_audio_nor_frame_artifacts(result_factory):
    result = result_factory()
    plan = SpeechAwareAsrChunkPlanner(settings()).plan(result)
    result.normalized_artifact.close()
    result.speech_evidence.close()
    validate_asr_chunk_plan(plan)


def test_weak_speech_and_energy_disagreement_remain_blocked(result_factory):
    result = result_factory(speech=((0, 30000), (34000, 128000)),
                            protected=((0, 30500), (33500, 128000)),
                            uncertain=((30500, 33500),), observations={28672: (0.9, 0.00001)})
    quality = replace(result.speech_map.quality, weak_speech_frame_count=1,
                      vad_energy_disagreement_frame_count=1)
    speech_map = replace(result.speech_map, quality=quality)
    result = replace(result, speech_map=speech_map, warnings=quality.warnings)
    plan = SpeechAwareAsrChunkPlanner(settings()).plan(result)
    assert plan.boundary_decisions[0].reason is ChunkBoundaryReason.FORCED_CONTINUOUS_SPEECH
    assert plan.boundary_decisions[0].uncertain
    assert_partition(plan, settings())


@pytest.mark.parametrize("kind", ["missing", "extra", "invalid-zero"])
def test_frame_replay_integrity_is_bounded_and_fail_closed(result_factory, monkeypatch, kind):
    result = result_factory()
    original = SpeechEnergyEvidence.iter_frames

    def frames(self):
        last = None
        for frame in original(self):
            last = frame
            if kind == "missing" and frame.end_sample == self.sample_count:
                return
            yield replace(frame, dbfs=-math.inf) if kind == "invalid-zero" else frame
        if kind == "extra":
            yield last

    monkeypatch.setattr(SpeechEnergyEvidence, "iter_frames", frames)
    with pytest.raises(AudioProcessingError) as caught:
        SpeechAwareAsrChunkPlanner(settings()).plan(result)
    assert caught.value.category == "VALIDATION"


@pytest.mark.parametrize("payload,search", [(72044, 8000), (2043, 0)])
def test_effective_cap_shortens_preferred_core_without_losing_context_or_frame_grid(result_factory, payload, search):
    configuration = settings(audio_asr_chunk_target_samples=32000 if search else 1024,
                             audio_asr_chunk_max_request_samples=48000 if search else 1536,
                             audio_asr_chunk_overlap_samples=8000 if search else 128,
                             audio_asr_chunk_boundary_search_samples=search)
    source = result_factory(128000 if search else 2048)
    plan = SpeechAwareAsrChunkPlanner(configuration).plan(source, effective_payload_limit=payload)
    assert_partition(plan, configuration)
    c = plan.provenance.effective_configuration
    assert c["target_core_samples"] == configuration.audio_asr_chunk_target_samples
    assert c["forced_context_samples"] == configuration.audio_asr_chunk_overlap_samples // 2
    assert c["max_core_samples"] < c["target_core_samples"]
    assert all(44 + 2 * (chunk.request_interval.end_sample - chunk.request_interval.start_sample) <= payload
               for chunk in plan.chunks)
    assert all(chunk.core_interval.end_sample % 512 == 0 for chunk in plan.chunks[:-1])
    validate_asr_chunk_plan(plan)


def test_impossible_context_is_not_shrunk_to_make_a_payload_fit(result_factory):
    planner = SpeechAwareAsrChunkPlanner(settings())
    with pytest.raises(AudioProcessingError) as caught:
        planner.plan(result_factory(), effective_payload_limit=300)
    assert caught.value.category == "RESOURCE"


@pytest.mark.parametrize("gap_start,gap_end,count", [
    (8000, 56000, 64000),  # Even a short recording needs independent decoding.
    (16000, 80000, 160000),  # Restart before the ordinary minimum core size.
    (160000, 224000, 240000),  # Restart even when the final tail is short.
    (80000, 144000, 320000),  # Interruption outside the preferred search window.
])
def test_long_internal_silence_restarts_near_resumed_evidence(result_factory, gap_start, gap_end, count):
    configuration = Settings(_env_file=None)
    result = result_factory(count, speech=((0, gap_start), (gap_end, count)))
    plan = SpeechAwareAsrChunkPlanner(configuration).plan(result)
    assert_partition(plan, configuration)
    assert len(plan.chunks) == 2
    left, right = plan.chunks
    assert right.core_interval.start_sample == gap_end
    assert right.request_interval.start_sample == gap_end
    assert left.request_interval.end_sample == gap_end
    assert plan.boundary_decisions[0].candidate_gap == SampleInterval(gap_start, gap_end)
    assert right.start_boundary_reason is ChunkBoundaryReason.SPEECH_RESUMPTION
    validate_asr_chunk_plan(plan)


def test_interruption_still_honors_chunk_budget_without_skipping_silence(result_factory):
    result = result_factory(160000, speech=((0, 16000), (80000, 160000)))
    with pytest.raises(AudioProcessingError) as caught:
        SpeechAwareAsrChunkPlanner(Settings(_env_file=None, audio_asr_chunk_max_chunks=1)).plan(result)
    assert caught.value.category == "RESOURCE"


def test_existing_v2_continuous_plan_snapshot_still_validates(result_factory):
    plan = SpeechAwareAsrChunkPlanner(settings()).plan(result_factory())
    configuration = {k: v for k, v in plan.provenance.effective_configuration.items()
                     if k not in {"interruption_gap_samples", "interruption_padding_samples"}}
    old = replace(plan, provenance=replace(plan.provenance, planner_version="speech-aware-v2",
                                          effective_configuration=configuration))
    validate_asr_chunk_plan(old)


@pytest.mark.parametrize("kind", ["context", "gap", "reason"])
def test_restart_snapshot_requires_exact_acoustic_edge_and_independent_context(result_factory, kind):
    result = result_factory(160000, speech=((0, 16000), (80000, 160000)))
    plan = SpeechAwareAsrChunkPlanner(Settings(_env_file=None)).plan(result)
    if kind == "context":
        right = replace(plan.chunks[1], request_interval=SampleInterval(78400, 160000))
        invalid = replace(plan, chunks=(plan.chunks[0], right))
    elif kind == "gap":
        decision = replace(plan.boundary_decisions[0], candidate_gap=SampleInterval(16000, 79999))
        invalid = replace(plan, boundary_decisions=(decision,))
    else:
        left = replace(plan.chunks[0], end_boundary_reason=ChunkBoundaryReason.NATURAL_SILENCE_CANDIDATE)
        right = replace(plan.chunks[1], start_boundary_reason=ChunkBoundaryReason.NATURAL_SILENCE_CANDIDATE)
        decision = replace(plan.boundary_decisions[0], reason=ChunkBoundaryReason.NATURAL_SILENCE_CANDIDATE)
        invalid = replace(plan, chunks=(left, right), boundary_decisions=(decision,))
    with pytest.raises(AudioProcessingError):
        validate_asr_chunk_plan(invalid)
