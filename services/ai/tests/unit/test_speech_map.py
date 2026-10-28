import math
from dataclasses import FrozenInstanceError, replace
from fractions import Fraction
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

from sme_meeting_ai.audio import (
    AudioProbe,
    AudioProcessingError,
    AudioProvenance,
    DetectionProvenance,
    EvidenceFrame,
    NormalizedAudioArtifact,
    SampleInterval,
    SpeechEnergyEvidence,
    SpeechMap,
    SpeechMapBuilder,
    SpeechMapProvenance,
    SpeechMapQuality,
    SpeechMapWarning,
    VadLabel,
)
from sme_meeting_ai.audio.models import _EVIDENCE_HEADER, _EVIDENCE_LABELS, _EVIDENCE_RECORD
from sme_meeting_ai.core.config import Settings

SPEECH = VadLabel.LIKELY_SPEECH
NON_SPEECH = VadLabel.LIKELY_NON_SPEECH
UNCERTAIN = VadLabel.UNCERTAIN


@pytest.fixture
def audio_inputs(tmp_path):
    resources = []

    def make(labels=(), *, sample_count=None, rms_values=None, detector_configuration=None):
        if sample_count is None:
            sample_count = len(labels) * 512
        audio_directory = TemporaryDirectory(dir=tmp_path)
        evidence_directory = TemporaryDirectory(dir=tmp_path)
        resources.extend([audio_directory, evidence_directory])
        audio_path = Path(audio_directory.name) / "normalized.wav"
        audio_path.write_bytes(b"caller-owned audio; mapping must not read or rewrite PCM")
        probe = AudioProbe("source-1", "wav", "pcm_s16le", 16000, 1, "mono", None, 0)
        audio = NormalizedAudioArtifact(
            path=audio_path, source_id="source-1", source_metadata=probe,
            sample_count=sample_count,
            provenance=AudioProvenance("source-1", "1", "ffmpeg", "test", {}, {}),
            _temporary=audio_directory,
        )
        configuration = {
            "sample_rate_hz": 16000, "frame_samples": 512,
            "tail_padding": "model-only-zero-padding",
            "speech_threshold": 0.6, "non_speech_threshold": 0.35,
            **(detector_configuration or {}),
        }
        provenance = DetectionProvenance(
            "silero-vad", "5", "a" * 64, "fake-replay", "1", configuration,
        )
        frames = []
        for index, label in enumerate(labels):
            start = index * 512
            end = min(start + 512, sample_count)
            probability = {SPEECH: 0.9, NON_SPEECH: 0.1, UNCERTAIN: 0.5}[label]
            rms = rms_values[index] if rms_values is not None else {
                SPEECH: 0.1, NON_SPEECH: 0.0, UNCERTAIN: 0.01,
            }[label]
            frames.append(EvidenceFrame(
                start, end, probability, label, rms,
                20 * math.log10(rms) if rms else -math.inf, 512 - (end - start),
            ))
        evidence_path = Path(evidence_directory.name) / "frames.bin"
        evidence_path.write_bytes(_EVIDENCE_HEADER + b"".join(
            _EVIDENCE_RECORD.pack(
                frame.start_sample, frame.end_sample, frame.vad_probability,
                frame.rms, frame.dbfs, _EVIDENCE_LABELS.index(frame.vad_label),
                frame.padding_samples,
            )
            for frame in frames
        ))
        evidence = SpeechEnergyEvidence(
            source_id="source-1", sample_count=sample_count, frame_count=len(frames),
            likely_speech_frame_count=labels.count(SPEECH),
            likely_non_speech_frame_count=labels.count(NON_SPEECH),
            uncertain_frame_count=labels.count(UNCERTAIN), provenance=provenance,
            _path=evidence_path, _temporary=evidence_directory,
        )
        return audio, evidence, frames

    yield make
    for resource in resources:
        resource.cleanup()


def builder(*, padding=0, merge_gap=0, energy_floor=-50):
    return SpeechMapBuilder(Settings(
        service_name="test-ai", service_identity="ai-core", _env_file=None,
        audio_speech_map_boundary_padding_samples=padding,
        audio_speech_map_merge_gap_samples=merge_gap,
        audio_speech_map_energy_floor_dbfs=energy_floor,
    ))


def bounds(intervals):
    return [(interval.start_sample, interval.end_sample) for interval in intervals]


def replay(monkeypatch, frames):
    monkeypatch.setattr(SpeechEnergyEvidence, "iter_frames", lambda _: iter(frames))


def assert_validation(audio, evidence):
    with pytest.raises(AudioProcessingError) as caught:
        builder().build(audio, evidence)
    assert caught.value.category == "VALIDATION"


def test_sample_intervals_have_exact_absolute_half_open_timing():
    interval = SampleInterval(513, 1025)
    assert interval.start_time == Fraction(513, 16000)
    assert interval.end_time == Fraction(1025, 16000)
    assert interval.duration == Fraction(512, 16000)
    assert SampleInterval(0, 1).start_time == Fraction(0)


@pytest.mark.parametrize("start,end", [
    (-1, 1), (0, 0), (2, 1), (0.0, 1), (0, 1.0), (False, 1), (0, True),
])
def test_invalid_sample_intervals_are_rejected(start, end):
    with pytest.raises(AudioProcessingError) as caught:
        SampleInterval(start, end)
    assert caught.value.category == "VALIDATION"


def test_detected_and_protected_intervals_are_ordered_absolute_candidates(audio_inputs):
    audio, evidence, _ = audio_inputs([NON_SPEECH, SPEECH, SPEECH, NON_SPEECH, SPEECH, NON_SPEECH])
    result = builder().build(audio, evidence)

    assert isinstance(result, SpeechMap)
    assert isinstance(result.quality, SpeechMapQuality)
    assert isinstance(result.provenance, SpeechMapProvenance)
    assert bounds(result.speech_intervals) == [(512, 1536), (2048, 2560)]
    assert result.protected_intervals == result.speech_intervals
    assert result.uncertain_intervals == ()
    assert result.quality.frame_count == 6
    assert result.quality.likely_speech_frame_count == 3
    assert result.quality.likely_non_speech_frame_count == 3
    assert result.quality.warnings == ()
    for collection in (result.speech_intervals, result.protected_intervals, result.uncertain_intervals):
        assert isinstance(collection, tuple)
        assert all(0 <= item.start_sample < item.end_sample <= audio.sample_count for item in collection)
        assert all(left.end_sample < right.start_sample for left, right in zip(collection, collection[1:]))
    assert result.speech_intervals[0].start_time == Fraction(512, 16000)


@pytest.mark.parametrize("labels,sample_count,detected,protected", [
    ([SPEECH, NON_SPEECH], 1024, [(0, 512)], [(0, 812)]),
    ([NON_SPEECH, SPEECH], 529, [(512, 529)], [(212, 529)]),
    ([SPEECH], 1, [(0, 1)], [(0, 1)]),
])
def test_padding_clips_to_real_samples_without_changing_detection(
    audio_inputs, labels, sample_count, detected, protected,
):
    audio, evidence, _ = audio_inputs(labels, sample_count=sample_count)
    result = builder(padding=300).build(audio, evidence)
    assert bounds(result.speech_intervals) == detected
    assert bounds(result.protected_intervals) == protected
    assert result.protected_intervals[-1].end_time <= audio.duration


@pytest.mark.parametrize("labels,gap,expected", [
    ([SPEECH, SPEECH, SPEECH], 0, [(0, 1536)]),
    ([SPEECH, NON_SPEECH, SPEECH], 511, [(0, 512), (1024, 1536)]),
    ([SPEECH, NON_SPEECH, SPEECH], 512, [(0, 1536)]),
    ([SPEECH, NON_SPEECH, NON_SPEECH, SPEECH], 512, [(0, 512), (1536, 2048)]),
    ([SPEECH, NON_SPEECH, NON_SPEECH, SPEECH], 1024, [(0, 2048)]),
])
def test_continuous_adjacent_close_and_distant_candidates(audio_inputs, labels, gap, expected):
    audio, evidence, _ = audio_inputs(labels)
    result = builder(merge_gap=gap).build(audio, evidence)
    assert bounds(result.speech_intervals) == expected


@pytest.mark.parametrize("padding,expected,coalescing_count", [
    (255, [(0, 767), (769, 1536)], 0),
    (256, [(0, 1536)], 1),
    (300, [(0, 1536)], 1),
])
def test_protected_windows_coalesce_on_overlap_or_adjacency_only(
    audio_inputs, padding, expected, coalescing_count,
):
    audio, evidence, _ = audio_inputs([SPEECH, NON_SPEECH, SPEECH])
    result = builder(padding=padding).build(audio, evidence)
    assert bounds(result.speech_intervals) == [(0, 512), (1024, 1536)]
    assert bounds(result.protected_intervals) == expected
    assert result.quality.protected_window_coalescing_count == coalescing_count
    assert (SpeechMapWarning.PROTECTED_WINDOW_COALESCING in result.quality.warnings) == bool(coalescing_count)


def test_chained_protected_window_coalescing_is_counted_deterministically(audio_inputs):
    audio, evidence, _ = audio_inputs([SPEECH, NON_SPEECH, SPEECH, NON_SPEECH, SPEECH])
    result = builder(padding=256).build(audio, evidence)
    assert bounds(result.protected_intervals) == [(0, 2560)]
    assert result.quality.protected_window_coalescing_count == 2


@pytest.mark.parametrize("rms", [0, 0.0001])
def test_single_sample_weak_speech_is_preserved_and_flagged(audio_inputs, rms):
    audio, evidence, _ = audio_inputs([SPEECH], sample_count=1, rms_values=[rms])
    result = builder().build(audio, evidence)
    assert bounds(result.speech_intervals) == [(0, 1)]
    assert bounds(result.protected_intervals) == [(0, 1)]
    assert result.quality.weak_speech_frame_count == 1
    assert result.quality.vad_energy_disagreement_frame_count == 1
    assert SpeechMapWarning.WEAK_SPEECH in result.quality.warnings
    assert SpeechMapWarning.VAD_ENERGY_DISAGREEMENT in result.quality.warnings


def test_uncertain_and_high_energy_non_speech_remain_visible_across_merges(audio_inputs):
    audio, evidence, _ = audio_inputs(
        [SPEECH, UNCERTAIN, NON_SPEECH, SPEECH], rms_values=[0.1, 0.01, 0.5, 0.0001],
    )
    result = builder(merge_gap=1024).build(audio, evidence)
    assert bounds(result.speech_intervals) == [(0, 2048)]
    assert bounds(result.uncertain_intervals) == [(512, 1536)]
    assert result.quality.uncertain_frame_count == 1
    assert result.quality.high_energy_non_speech_frame_count == 1
    assert result.quality.weak_speech_frame_count == 1
    assert result.quality.vad_energy_disagreement_frame_count == 2
    assert set(result.quality.warnings) == {
        SpeechMapWarning.WEAK_SPEECH, SpeechMapWarning.UNCERTAIN_VAD,
        SpeechMapWarning.VAD_ENERGY_DISAGREEMENT, SpeechMapWarning.HIGH_ENERGY_NON_SPEECH,
    }


def test_high_energy_noise_or_music_never_creates_speech(audio_inputs):
    audio, evidence, _ = audio_inputs([NON_SPEECH, NON_SPEECH], rms_values=[0.8, 0.5])
    result = builder(padding=1600, merge_gap=512).build(audio, evidence)
    assert result.speech_intervals == result.protected_intervals == ()
    assert bounds(result.uncertain_intervals) == [(0, 1024)]
    assert result.quality.high_energy_non_speech_frame_count == 2
    assert result.quality.vad_energy_disagreement_frame_count == 2


def test_energy_floor_changes_indicators_only(audio_inputs):
    audio, evidence, _ = audio_inputs([SPEECH, NON_SPEECH], rms_values=[0.01, 0.01])
    lower = builder(energy_floor=-50).build(audio, evidence)
    higher = builder(energy_floor=-30).build(audio, evidence)
    assert lower.speech_intervals == higher.speech_intervals == (SampleInterval(0, 512),)
    assert lower.protected_intervals == higher.protected_intervals
    assert lower.quality.weak_speech_frame_count == 0
    assert lower.quality.high_energy_non_speech_frame_count == 1
    assert higher.quality.weak_speech_frame_count == 1
    assert higher.quality.high_energy_non_speech_frame_count == 0


def test_energy_floor_equality_is_not_weak_speech(audio_inputs):
    audio, evidence, _ = audio_inputs([SPEECH, NON_SPEECH], rms_values=[0.01, 0.01])
    result = builder(energy_floor=-40).build(audio, evidence)
    assert result.quality.weak_speech_frame_count == 0
    assert result.quality.high_energy_non_speech_frame_count == 1


@pytest.mark.parametrize("labels", [[], [NON_SPEECH], [UNCERTAIN]])
def test_no_detected_speech_and_empty_timelines_are_valid(audio_inputs, labels):
    audio, evidence, _ = audio_inputs(labels)
    result = builder(padding=1600).build(audio, evidence)
    assert result.speech_intervals == result.protected_intervals == ()
    assert result.quality.likely_speech_frame_count == 0
    assert bounds(result.uncertain_intervals) == ([(0, 512)] if labels == [UNCERTAIN] else [])
    if not labels or labels == [NON_SPEECH]:
        assert result.quality.warnings == ()


def test_provenance_is_complete_and_outputs_are_deterministic_immutable_and_independent(audio_inputs):
    audio, evidence, frames = audio_inputs([NON_SPEECH, SPEECH, UNCERTAIN])
    mapper = builder(padding=123, merge_gap=456, energy_floor=-62.5)
    before = audio.path.read_bytes(), audio.path.stat(), tuple(evidence.iter_frames())
    result = mapper.build(audio, evidence)
    assert result == mapper.build(audio, evidence)
    assert (audio.path.read_bytes(), audio.path.stat(), tuple(evidence.iter_frames())) == before
    assert tuple(frames) == before[2]
    assert result.provenance.source_id == audio.source_id
    assert result.provenance.sample_count == audio.sample_count
    assert result.provenance.sample_rate_hz == 16000
    assert result.provenance.mapper_version == "1"
    assert result.provenance.detector_provenance == evidence.provenance
    assert dict(result.provenance.effective_configuration) == {
        "boundary_padding_samples": 123, "merge_gap_samples": 456, "energy_floor_dbfs": -62.5,
    }
    for obj, attribute, value in [
        (result, "speech_intervals", ()),
        (result.speech_intervals[0], "start_sample", 0),
        (result.quality, "weak_speech_frame_count", 100),
        (result.provenance, "mapper_version", "changed"),
    ]:
        with pytest.raises(FrozenInstanceError):
            setattr(obj, attribute, value)
    with pytest.raises(TypeError):
        result.provenance.effective_configuration["merge_gap_samples"] = 999
    with pytest.raises(TypeError):
        result.provenance.detector_provenance.effective_configuration["speech_threshold"] = 0
    configuration = dict(result.provenance.effective_configuration)
    copied = replace(result.provenance, effective_configuration=configuration)
    configuration["merge_gap_samples"] = 999
    assert copied == result.provenance
    evidence.close()
    audio.close()
    assert result.speech_intervals[0].end_time == Fraction(1024, 16000)


@pytest.mark.parametrize("target,changes", [
    ("audio", {"source_id": "another-source"}),
    ("evidence", {"source_id": "another-source"}),
    ("audio", {"source_id": ""}),
    ("audio", {"sample_count": 513}),
    ("evidence", {"sample_count": 513}),
    ("audio", {"sample_count": -1}),
    ("evidence", {"sample_count": -1}),
    ("audio", {"sample_count": 512.0}),
    ("evidence", {"sample_count": 512.0}),
    ("evidence", {"sample_count": True}),
])
def test_source_and_sample_timeline_mismatches_are_rejected(audio_inputs, target, changes):
    audio, evidence, _ = audio_inputs([SPEECH])
    if target == "audio":
        audio = replace(audio, **changes)
    else:
        evidence = replace(evidence, **changes)
    assert_validation(audio, evidence)


@pytest.mark.parametrize("index,changes", [
    (0, {"start_sample": 1}),
    (0, {"start_sample": -1}),
    (0, {"start_sample": False}),
    (0, {"end_sample": 0}),
    (0, {"end_sample": 513}),
    (1, {"start_sample": 513}),
    (1, {"start_sample": 511}),
    (1, {"start_sample": 0}),
    (1, {"end_sample": 512}),
    (1, {"end_sample": 511}),
    (1, {"end_sample": 1025}),
    (1, {"end_sample": 1024.0}),
    (0, {"padding_samples": 1}),
    (1, {"padding_samples": -1}),
    (1, {"padding_samples": 512}),
    (1, {"padding_samples": False}),
])
def test_invalid_frame_bounds_coverage_and_padding_are_rejected(audio_inputs, monkeypatch, index, changes):
    audio, evidence, frames = audio_inputs([NON_SPEECH, NON_SPEECH])
    frames[index] = replace(frames[index], **changes)
    replay(monkeypatch, frames)
    assert_validation(audio, evidence)


@pytest.mark.parametrize("padding", [0, 494, 496, 495.0])
def test_tail_padding_must_match_real_sample_count(audio_inputs, monkeypatch, padding):
    audio, evidence, frames = audio_inputs([NON_SPEECH, SPEECH], sample_count=529)
    frames[-1] = replace(frames[-1], padding_samples=padding)
    replay(monkeypatch, frames)
    assert_validation(audio, evidence)


@pytest.mark.parametrize("mode", ["reversed", "missing", "extra", "wrong-type"])
def test_replay_order_and_frame_count_are_never_repaired(audio_inputs, monkeypatch, mode):
    audio, evidence, frames = audio_inputs([SPEECH, SPEECH])
    invalid = {
        "reversed": frames[::-1], "missing": frames[:-1],
        "extra": [*frames, frames[-1]], "wrong-type": [object(), frames[-1]],
    }[mode]
    replay(monkeypatch, invalid)
    assert_validation(audio, evidence)


@pytest.mark.parametrize("changes", [
    {"frame_count": -1}, {"frame_count": 1.0}, {"frame_count": True},
    {"frame_count": 2}, {"frame_count": 0},
    {"likely_speech_frame_count": -1}, {"likely_speech_frame_count": 1.0},
    {"likely_speech_frame_count": True}, {"likely_speech_frame_count": 0},
    {"likely_speech_frame_count": 0, "likely_non_speech_frame_count": 1},
    {"likely_non_speech_frame_count": 1}, {"uncertain_frame_count": 1},
])
def test_inconsistent_declared_counts_are_rejected(audio_inputs, changes):
    audio, evidence, _ = audio_inputs([SPEECH])
    assert_validation(audio, replace(evidence, **changes))


@pytest.mark.parametrize("changes", [
    {"vad_probability": -0.1}, {"vad_probability": 1.1},
    {"vad_probability": math.nan}, {"vad_probability": math.inf},
    {"vad_probability": True}, {"vad_probability": "private-invalid"},
    {"vad_probability": 0.5}, {"vad_probability": 0.1},
    {"vad_label": "invalid"}, {"vad_label": "likely-speech"},
    {"rms": -0.1}, {"rms": 1.1}, {"rms": math.nan}, {"rms": math.inf},
    {"rms": True}, {"rms": "private-invalid"},
    {"dbfs": math.nan}, {"dbfs": math.inf}, {"dbfs": -math.inf},
    {"dbfs": 1}, {"dbfs": -19}, {"dbfs": True}, {"dbfs": "private-invalid"},
    {"rms": 0, "dbfs": -120},
])
def test_invalid_or_inconsistent_vad_and_energy_values_are_rejected(audio_inputs, monkeypatch, changes):
    audio, evidence, frames = audio_inputs([SPEECH])
    replay(monkeypatch, [replace(frames[0], **changes)])
    assert_validation(audio, evidence)


@pytest.mark.parametrize("configuration", [
    {"sample_rate_hz": 8000}, {"sample_rate_hz": 16000.0},
    {"frame_samples": 0}, {"frame_samples": 256}, {"frame_samples": True},
    {"tail_padding": "included-in-timeline"},
    {"speech_threshold": math.nan}, {"speech_threshold": math.inf},
    {"speech_threshold": 1.1}, {"speech_threshold": True},
    {"non_speech_threshold": -0.1}, {"non_speech_threshold": 0.6},
    {"non_speech_threshold": "private-invalid"},
])
def test_incompatible_detector_timeline_and_bands_are_rejected(audio_inputs, configuration):
    audio, evidence, _ = audio_inputs([SPEECH], detector_configuration=configuration)
    assert_validation(audio, evidence)


@pytest.mark.parametrize("key", [
    "sample_rate_hz", "frame_samples", "tail_padding", "speech_threshold", "non_speech_threshold",
])
def test_required_detector_configuration_cannot_be_missing(audio_inputs, key):
    audio, evidence, _ = audio_inputs([SPEECH])
    configuration = dict(evidence.provenance.effective_configuration)
    del configuration[key]
    evidence = replace(evidence, provenance=replace(evidence.provenance, effective_configuration=configuration))
    assert_validation(audio, evidence)


def test_detector_bands_not_current_settings_validate_labels(audio_inputs, monkeypatch):
    audio, evidence, frames = audio_inputs(
        [UNCERTAIN], detector_configuration={"speech_threshold": 0.8, "non_speech_threshold": 0.2},
    )
    replay(monkeypatch, [replace(frames[0], vad_probability=0.7)])
    result = builder().build(audio, evidence)
    assert result.speech_intervals == ()
    assert bounds(result.uncertain_intervals) == [(0, 512)]


@pytest.mark.parametrize("label,probability", [
    (SPEECH, 0.6), (NON_SPEECH, 0.35), (UNCERTAIN, 0.350001), (UNCERTAIN, 0.599999),
])
def test_detector_probability_band_edges_are_preserved(audio_inputs, monkeypatch, label, probability):
    audio, evidence, frames = audio_inputs([label])
    replay(monkeypatch, [replace(frames[0], vad_probability=probability)])
    result = builder().build(audio, evidence)
    assert bool(result.speech_intervals) == (label is SPEECH)


@pytest.mark.parametrize("failure", ["closed", "truncated"])
def test_evidence_replay_resource_errors_remain_resource_errors(audio_inputs, failure):
    audio, evidence, _ = audio_inputs([SPEECH])
    if failure == "closed":
        evidence.close()
    else:
        evidence._path.write_bytes(_EVIDENCE_HEADER)
    with pytest.raises(AudioProcessingError) as caught:
        builder().build(audio, evidence)
    assert caught.value.category == "RESOURCE"
