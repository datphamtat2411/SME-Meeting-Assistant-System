import copy
import traceback
from dataclasses import FrozenInstanceError, replace
from fractions import Fraction
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

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
from sme_meeting_ai.audio.errors import AudioProcessingError
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
)


def settings(**overrides):
    values = {
        "audio_asr_chunk_target_samples": 100,
        "audio_asr_chunk_max_request_samples": 150,
        "audio_asr_chunk_overlap_samples": 30,
        "audio_asr_chunk_boundary_search_samples": 20,
    }
    return Settings(
        service_name="test-ai", service_identity="ai-core", _env_file=None,
        **(values | overrides),
    )


@pytest.fixture
def result_factory(tmp_path):
    temporary_directories = []

    def make(sample_count=1000, *, speech=None, protected=None, uncertain=()):
        if speech is None:
            speech = ((0, sample_count),) if sample_count > 0 else ()
        if protected is None:
            protected = speech
        audio_temp = TemporaryDirectory(dir=tmp_path)
        evidence_temp = TemporaryDirectory(dir=tmp_path)
        temporary_directories.extend((audio_temp, evidence_temp))
        audio_path = Path(audio_temp.name) / "private-cuoc-hop.wav"
        evidence_path = Path(evidence_temp.name) / "evidence.bin"
        # Metadata-only planning must never open either artifact.
        audio_path.write_bytes(b"preprocessing-owned PCM sentinel")
        evidence_path.write_bytes(b"preprocessing-owned evidence sentinel")
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
        speech_count = int(bool(speech))
        uncertain_count = int(bool(uncertain))
        non_speech_count = frame_count - speech_count - uncertain_count
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
        assert core.end_sample - core.start_sample <= (
            configuration.audio_asr_chunk_max_request_samples - configuration.audio_asr_chunk_overlap_samples
        )
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


def test_continuous_speech_forces_maximum_cores_without_skipping_audio(result_factory):
    configuration = settings()
    result = result_factory()
    plan = SpeechAwareAsrChunkPlanner(configuration).plan(result)
    assert_partition(plan, configuration)
    assert [chunk.core_interval.end_sample for chunk in plan.chunks] == [120, 240, 360, 480, 600, 720, 840, 960, 1000]
    assert all(chunk.end_boundary_reason is ChunkBoundaryReason.FORCED_CONTINUOUS_SPEECH for chunk in plan.chunks[:-1])


@pytest.mark.parametrize("speech,expected", [
    (((0, 95), (110, 1000)), 100),
    (((0, 90), (91, 110), (111, 1000)), 90),  # Equal distance: lower sample wins.
    (((0, 80), (81, 1000)), 80),  # Inclusive lower search bound.
    (((0, 120), (121, 1000)), 120),  # Inclusive upper search/core bound.
    (((0, 121), (122, 1000)), 120),  # Outside search: forced maximum.
])
def test_nearest_natural_gap_and_ties_are_deterministic(result_factory, speech, expected):
    planner = SpeechAwareAsrChunkPlanner(settings())
    result = result_factory(speech=speech)
    plan = planner.plan(result)
    assert plan.chunks[0].core_interval.end_sample == expected
    expected_reason = (
        ChunkBoundaryReason.FORCED_CONTINUOUS_SPEECH if speech[0][1] == 121
        else ChunkBoundaryReason.NATURAL_SILENCE_CANDIDATE
    )
    assert plan.chunks[0].end_boundary_reason is expected_reason
    assert planner.plan(result) == plan
    assert_partition(plan, settings())


@pytest.mark.parametrize("uncertain", [((90, 110),), ((80, 100), (105, 120))])
def test_union_of_protection_and_uncertainty_blocks_natural_boundaries(result_factory, uncertain):
    result = result_factory(speech=((0, 70), (130, 1000)),
                            protected=((0, 90), (110, 1000)), uncertain=uncertain)
    plan = SpeechAwareAsrChunkPlanner(settings()).plan(result)
    for chunk in plan.chunks:
        if chunk.end_boundary_reason is ChunkBoundaryReason.NATURAL_SILENCE_CANDIDATE:
            boundary = chunk.core_interval.end_sample
            assert all(not interval.start_sample <= boundary < interval.end_sample for interval in (
                *result.speech_map.protected_intervals, *result.speech_map.uncertain_intervals,
            ))
    if uncertain == ((90, 110),):
        assert plan.chunks[0].end_boundary_reason is ChunkBoundaryReason.FORCED_CONTINUOUS_SPEECH
    assert_partition(plan, settings())


@pytest.mark.parametrize("sample_count", [1, 15, 100, 120])
def test_short_or_exact_maximum_recording_has_one_terminal_core(result_factory, sample_count):
    plan = SpeechAwareAsrChunkPlanner(settings()).plan(result_factory(sample_count))
    assert len(plan.chunks) == 1
    assert plan.chunks[0].core_interval == SampleInterval(0, sample_count)
    assert plan.chunks[0].request_interval == SampleInterval(0, sample_count)
    assert_partition(plan, settings())


@pytest.mark.parametrize("overlap", [0, 1, 30, 31, 101])
def test_overlap_is_total_adjacent_intersection_with_integer_context_and_clipping(result_factory, overlap):
    configuration = settings(audio_asr_chunk_overlap_samples=overlap,
                             audio_asr_chunk_max_request_samples=120 + overlap)
    plan = SpeechAwareAsrChunkPlanner(configuration).plan(result_factory(241))
    assert_partition(plan, configuration)
    left, right = overlap // 2, overlap - overlap // 2
    for chunk in plan.chunks:
        assert chunk.request_interval == SampleInterval(
            max(0, chunk.core_interval.start_sample - left),
            min(241, chunk.core_interval.end_sample + right),
        )
    for previous, chunk in zip(plan.chunks, plan.chunks[1:]):
        boundary = chunk.core_interval.start_sample
        assert previous.request_interval.end_sample - chunk.request_interval.start_sample == (
            min(241, boundary + right) - max(0, boundary - left)
        )
    assert plan.provenance.effective_configuration["left_context_samples"] == left
    assert plan.provenance.effective_configuration["right_context_samples"] == right


@pytest.mark.parametrize("sample_count", [121, 239, 240, 241, 999, 1000])
def test_all_provisional_silence_is_retained_in_target_cores(result_factory, sample_count):
    configuration = settings()
    plan = SpeechAwareAsrChunkPlanner(configuration).plan(result_factory(sample_count, speech=()))
    assert_partition(plan, configuration)
    assert all(chunk.end_boundary_reason is ChunkBoundaryReason.NATURAL_SILENCE_CANDIDATE for chunk in plan.chunks[:-1])
    assert sum(chunk.core_interval.end_sample - chunk.core_interval.start_sample for chunk in plan.chunks) == sample_count


def test_small_positive_progress_and_chunk_limit_are_enforced(result_factory):
    configuration = settings(audio_asr_chunk_target_samples=2,
                             audio_asr_chunk_boundary_search_samples=1,
                             audio_asr_chunk_overlap_samples=0,
                             audio_asr_chunk_max_request_samples=3,
                             audio_asr_chunk_max_chunks=40)
    plan = SpeechAwareAsrChunkPlanner(configuration).plan(result_factory(40, speech=()))
    assert_partition(plan, configuration)
    assert plan.provenance.effective_configuration["minimum_progress_samples"] == 1


def test_provenance_and_models_are_immutable_deterministic_snapshots(result_factory):
    configuration = settings()
    result = result_factory()
    planner = SpeechAwareAsrChunkPlanner(configuration)
    plan = planner.plan(result)
    assert planner.plan(result) == plan
    assert plan.source_id == result.provenance.source_id
    assert plan.sample_count == result.normalized_artifact.sample_count
    assert isinstance(plan.provenance, ChunkPlanningProvenance)
    assert plan.provenance.planner_version == "1"
    assert plan.provenance.sample_rate_hz == 16000
    assert plan.provenance.preprocessing == result.provenance
    assert dict(plan.provenance.effective_configuration) == {
        "target_core_samples": 100, "max_request_samples": 150, "overlap_samples": 30,
        "boundary_search_samples": 20, "max_chunks": 4096, "max_core_samples": 120,
        "left_context_samples": 15, "right_context_samples": 15,
        "minimum_progress_samples": 80, "max_timeline_samples": 57600000,
    }
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
    assert plan.provenance.effective_configuration["overlap_samples"] == 30


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
    # Silence requires 10 target cores; continuous speech requires 9 maximum cores.
    planner = SpeechAwareAsrChunkPlanner(settings(audio_asr_chunk_max_chunks=9))
    result = result_factory(1000, speech=speech)
    if speech is None:
        assert len(planner.plan(result).chunks) == 9
        planner = SpeechAwareAsrChunkPlanner(settings(audio_asr_chunk_max_chunks=8))
    with pytest.raises(AudioProcessingError) as caught:
        planner.plan(result)
    assert caught.value.category == "RESOURCE"


@pytest.mark.parametrize("overrides", [
    {"audio_asr_chunk_target_samples": 0},
    {"audio_asr_chunk_target_samples": True},
    {"audio_asr_chunk_overlap_samples": 30.0},
    {"audio_asr_chunk_overlap_samples": 150},
    {"audio_asr_chunk_max_request_samples": 129},
    {"audio_asr_chunk_boundary_search_samples": 100},
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
def test_planning_never_reads_closes_or_changes_owned_artifacts(result_factory, monkeypatch, max_chunks):
    result = result_factory()
    audio, evidence = result.normalized_artifact, result.speech_evidence
    audio_bytes, evidence_bytes = audio.path.read_bytes(), evidence._path.read_bytes()

    def forbidden(*args, **kwargs):
        pytest.fail("planner accessed preprocessing-owned resources")

    with monkeypatch.context() as patch:
        patch.setattr(NormalizedAudioArtifact, "close", forbidden)
        patch.setattr(SpeechEnergyEvidence, "close", forbidden)
        patch.setattr(SpeechEnergyEvidence, "iter_frames", forbidden)
        patch.setattr(Path, "open", forbidden)
        planner = SpeechAwareAsrChunkPlanner(settings(audio_asr_chunk_max_chunks=max_chunks))
        if max_chunks == 1:
            with pytest.raises(AudioProcessingError):
                planner.plan(result)
        else:
            planner.plan(result)
    assert audio.path.read_bytes() == audio_bytes
    assert evidence._path.read_bytes() == evidence_bytes
    assert not evidence._closed
