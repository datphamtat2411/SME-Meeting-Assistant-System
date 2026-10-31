"""Narrow, test-local contracts and exact sample metrics; no model/asset loading."""

import hashlib
import json
import math
import platform
import wave
from collections import Counter
from dataclasses import asdict
from fractions import Fraction
from importlib.metadata import version
from pathlib import Path, PurePosixPath
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from sme_meeting_ai.audio import SampleInterval, VadLabel
from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.pipeline.models import PreprocessingResult

CONDITIONS = frozenset({
    "silence", "weak-distant-speech", "background-noise", "music", "continuous-speech",
    "recording-boundaries", "long-audio", "historical-regression",
})
_SPEECH_CONDITIONS = CONDITIONS - {"silence", "background-noise", "music", "long-audio"}
_LABELS = ("speech", "silence", "noise", "music", "ambiguous")
Identifier = Annotated[str, Field(min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_.-]+$")]
Digest = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
Sample = Annotated[int, Field(ge=0)]
Positive = Annotated[int, Field(gt=0)]


class EvaluationError(ValueError):
    """Sanitized evaluation failure; never carries media/annotation payloads."""


def require(condition, category):
    if not condition:
        raise EvaluationError(f"evaluation {category} violation")


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True, hide_input_in_errors=True)


class Bounds(Contract):
    start_sample: Sample
    end_sample: Positive

    @model_validator(mode="after")
    def ordered(self):
        if self.start_sample >= self.end_sample:
            raise ValueError("empty/reversed bounds")
        return self


class Label(Bounds):
    label: Literal["speech", "silence", "noise", "music", "ambiguous"]
    critical: bool = False
    material: bool = False

    @model_validator(mode="after")
    def speech_flags(self):
        if self.label != "speech" and (self.critical or self.material):
            raise ValueError("speech-only flags")
        return self


class Anchor(Bounds):
    pcm_sha256: Digest


class Fixture(Contract):
    fixture_id: Identifier
    path: str
    source_sha256: Digest
    kind: Literal["recording", "synthetic"]
    language: Literal["vi", "none"]
    conditions: list[str] = Field(min_length=1)
    annotation_version: Identifier
    annotation_origin: Literal["independent-human", "synthetic-control"]
    sample_count: Positive
    labels: list[Label] = Field(min_length=1)
    anchors: list[Anchor] = Field(min_length=2, max_length=2)

    @model_validator(mode="after")
    def complete_independent_timeline(self):
        path = PurePosixPath(self.path)
        if (not self.path or path.is_absolute() or ".." in path.parts
                or "\\" in self.path or ":" in self.path or "\0" in self.path):
            raise ValueError("fixture-relative path required")
        if len(set(self.conditions)) != len(self.conditions) or not set(self.conditions) <= CONDITIONS:
            raise ValueError("unknown/duplicate condition")
        position = 0
        for label in self.labels:
            if label.start_sample != position or label.end_sample > self.sample_count:
                raise ValueError("incomplete annotation partition")
            position = label.end_sample
        if position != self.sample_count:
            raise ValueError("incomplete annotation timeline")
        if (self.anchors[0].start_sample != 0 or self.anchors[1].end_sample != self.sample_count
                or any(anchor.end_sample > self.sample_count for anchor in self.anchors)):
            raise ValueError("leading/trailing anchors required")
        kinds = {label.label for label in self.labels}
        if self.kind == "synthetic":
            if (self.language != "none" or self.annotation_origin != "synthetic-control"
                    or "speech" in kinds or set(self.conditions) & _SPEECH_CONDITIONS):
                raise ValueError("synthetic controls cannot satisfy speech coverage")
        elif self.language != "vi" or self.annotation_origin != "independent-human":
            raise ValueError("independent Vietnamese labels required")
        if set(self.conditions) & _SPEECH_CONDITIONS and "speech" not in kinds:
            raise ValueError("speech condition without speech labels")
        for condition, label in (("silence", "silence"), ("background-noise", "noise"), ("music", "music")):
            if condition in self.conditions and label not in kinds:
                raise ValueError("condition without matching labels")
        if "recording-boundaries" in self.conditions and (
            self.labels[0].label != "speech" or self.labels[-1].label != "speech"
        ):
            raise ValueError("boundary speech labels required at both edges")
        if "historical-regression" in self.conditions and not any(label.critical or label.material for label in self.labels):
            raise ValueError("historical regression requires critical/material speech")
        return self


class Rational(Contract):
    numerator: Sample
    denominator: Positive


class Gate(Contract):
    metric: Literal["coverage_rate", "missed_samples", "largest_missed_samples", "false_positive_rate"]
    minimum: Rational | None = None
    maximum: Rational | None = None
    basis_version: Identifier

    @model_validator(mode="after")
    def one_bound(self):
        if (self.minimum is None) == (self.maximum is None):
            raise ValueError("one explicit bound required")
        bound = self.minimum or self.maximum
        if self.metric.endswith("rate") and bound.numerator > bound.denominator:
            raise ValueError("rate bound exceeds one")
        return self


class Manifest(Contract):
    schema_version: Literal[1]
    dataset_id: Identifier
    dataset_version: Identifier
    privacy_approved: bool
    legal_approved: bool
    approval_version: Identifier
    labeling_guideline_version: Identifier
    long_audio_min_samples: Positive
    fixtures: list[Fixture] = Field(min_length=1)
    quality_gates: list[Gate] = Field(default_factory=list)
    # Computed from original manifest bytes, never accepted from the document.
    manifest_sha256: Digest = "0" * 64

    @model_validator(mode="after")
    def approved_coverage(self):
        if not self.privacy_approved or not self.legal_approved:
            raise ValueError("dataset approval required")
        if len({fixture.fixture_id for fixture in self.fixtures}) != len(self.fixtures):
            raise ValueError("duplicate fixture ID")
        if set().union(*(set(fixture.conditions) for fixture in self.fixtures)) != CONDITIONS:
            raise ValueError("incomplete required conditions")
        if any("long-audio" in fixture.conditions and fixture.sample_count < self.long_audio_min_samples for fixture in self.fixtures):
            raise ValueError("long control below dataset-defined duration")
        if len({gate.metric for gate in self.quality_gates}) != len(self.quality_gates):
            raise ValueError("duplicate quality gate")
        return self


def canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False) + "\n"


def digest_json(value):
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def file_digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def _unique_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def load_manifest(root: Path) -> Manifest:
    try:
        require(root.is_dir(), "manifest")
        path = root / "manifest.json"
        require(path.is_file() and not path.is_symlink(), "manifest")
        raw = path.read_bytes()
        document = json.loads(raw, object_pairs_hook=_unique_keys)
        require(isinstance(document, dict) and "manifest_sha256" not in document, "manifest")
        return Manifest.model_validate({**document, "manifest_sha256": hashlib.sha256(raw).hexdigest()})
    except (OSError, ValueError, ValidationError):
        raise EvaluationError("evaluation manifest invalid or unavailable") from None


def verify_source(root: Path, fixture: Fixture) -> Path:
    try:
        path = root / fixture.path
        require(path.resolve().is_relative_to(root.resolve()) and not path.is_symlink() and path.is_file(), "source")
        require(file_digest(path) == fixture.source_sha256, "source digest")
        return path
    except OSError:
        raise EvaluationError("evaluation source unavailable") from None


def require_pinned_model(settings: Settings):
    try:
        path = settings.audio_vad_model_path
        require(path is not None and settings.audio_vad_model_sha256 is not None, "model pin")
        require(path.is_file() and not path.is_symlink(), "model")
        require(0 < path.stat().st_size <= settings.audio_vad_model_max_bytes, "model size")
        require(file_digest(path) == settings.audio_vad_model_sha256, "model digest")
    except OSError:
        raise EvaluationError("evaluation model unavailable") from None


def merge(intervals):
    result = []
    for item in sorted(intervals, key=lambda item: (item.start_sample, item.end_sample)):
        if result and item.start_sample <= result[-1].end_sample:
            result[-1] = SampleInterval(result[-1].start_sample, max(item.end_sample, result[-1].end_sample))
        else:
            result.append(SampleInterval(item.start_sample, item.end_sample))
    return result


def intersect(left, right):
    left, right = merge(left), merge(right)
    result = []
    i = j = 0
    while i < len(left) and j < len(right):
        start = max(left[i].start_sample, right[j].start_sample)
        end = min(left[i].end_sample, right[j].end_sample)
        if start < end:
            result.append(SampleInterval(start, end))
        if left[i].end_sample <= right[j].end_sample:
            i += 1
        else:
            j += 1
    return result


def subtract(left, right):
    right = merge(right)
    result = []
    j = 0
    for item in merge(left):
        position = item.start_sample
        while j < len(right) and right[j].end_sample <= position:
            j += 1
        k = j
        while k < len(right) and right[k].start_sample < item.end_sample:
            if position < right[k].start_sample:
                result.append(SampleInterval(position, right[k].start_sample))
            position = max(position, right[k].end_sample)
            if position >= item.end_sample:
                break
            k += 1
        if position < item.end_sample:
            result.append(SampleInterval(position, item.end_sample))
    return result


def samples(intervals):
    return sum(item.end_sample - item.start_sample for item in merge(intervals))


def rational(numerator, denominator=16000):
    if not denominator:
        return None
    value = Fraction(numerator, denominator)
    return {"numerator": value.numerator, "denominator": value.denominator}


def bounds(item):
    return {"start_sample": item.start_sample, "end_sample": item.end_sample}


def quality_metrics(fixture, speech, uncertain):
    speech, uncertain = merge(speech), merge(uncertain)
    labels = {kind: merge(label for label in fixture.labels if label.label == kind) for kind in _LABELS}
    truth = labels["speech"]
    missed = subtract(truth, speech)
    non_speech = merge(labels["silence"] + labels["noise"] + labels["music"])
    missed_regions = []
    for item in missed:
        overlapping = [label for label in fixture.labels if label.label == "speech" and intersect([item], [label])]
        missed_regions.append({**bounds(item), "critical": any(label.critical for label in overlapping),
                               "material": any(label.material for label in overlapping)})
    timing = []
    # Match only actual overlaps; unmatched labels have no fabricated timing error.
    # A merged prediction may match multiple labels; publish match counts explicitly.
    for label in (label for label in fixture.labels if label.label == "speech"):
        matched = [item for item in speech if intersect([label], [item])]
        onset = matched[0].start_sample - label.start_sample if matched else None
        offset = matched[-1].end_sample - label.end_sample if matched else None
        timing.append({
            **bounds(label), "status": "OVERLAP" if matched else "MISSED", "matched_interval_count": len(matched),
            "onset_error_samples": onset, "offset_error_samples": offset,
            "onset_error_seconds": rational(onset) if onset is not None else None,
            "offset_error_seconds": rational(offset) if offset is not None else None,
        })
    covered = samples(intersect(truth, speech))
    false_positives = samples(intersect(non_speech, speech))
    return {
        "confirmed_speech_samples": samples(truth), "covered_speech_samples": covered,
        "coverage_rate": rational(covered, samples(truth)),
        "missed_samples": samples(missed), "missed_regions": missed_regions,
        "largest_missed_samples": max((item.end_sample - item.start_sample for item in missed), default=0),
        "missed_critical_samples": samples(intersect(missed, [label for label in fixture.labels if label.critical])),
        "missed_material_samples": samples(intersect(missed, [label for label in fixture.labels if label.material])),
        "false_positive_samples": false_positives,
        "confirmed_non_speech_samples": samples(non_speech),
        "false_positive_rate": rational(false_positives, samples(non_speech)),
        "false_positives_by_label": {
            kind: {"samples": samples(intersect(labels[kind], speech)), "denominator_samples": samples(labels[kind]),
                   "rate": rational(samples(intersect(labels[kind], speech)), samples(labels[kind]))}
            for kind in ("silence", "noise", "music")
        },
        "ambiguous_samples": samples(labels["ambiguous"]),
        "predicted_speech_in_ambiguous_samples": samples(intersect(labels["ambiguous"], speech)),
        "uncertainty_by_label": {
            kind: {"samples": samples(intersect(labels[kind], uncertain)), "denominator_samples": samples(labels[kind]),
                   "rate": rational(samples(intersect(labels[kind], uncertain)), samples(labels[kind]))}
            for kind in _LABELS
        },
        "timing": timing,
    }


def _gate_status(statuses):
    statuses = list(statuses)
    return "FAIL" if "FAIL" in statuses else "UNESTABLISHED" if not statuses or "UNESTABLISHED" in statuses else "PASS"


def evaluate_gates(manifest, metrics):
    checks = []
    for gate in manifest.quality_gates:
        actual = metrics[gate.metric]
        bound = gate.minimum or gate.maximum
        threshold = Fraction(bound.numerator, bound.denominator)
        status = "UNESTABLISHED"
        if actual is not None:
            value = Fraction(actual["numerator"], actual["denominator"]) if isinstance(actual, dict) else Fraction(actual)
            passed = value >= threshold if gate.minimum is not None else value <= threshold
            status = "PASS" if passed else "FAIL"
        checks.append({**gate.model_dump(exclude_none=True), "actual": actual, "status": status})
    return {"status": _gate_status(check["status"] for check in checks), "checks": checks}


def _normalization_integrity(fixture, audio):
    require(audio.sample_count == fixture.sample_count, "normalization sample count")
    require((audio.sample_rate_hz, audio.channels, audio.sample_format) == (16000, 1, "s16"), "normalization format")
    try:
        with wave.open(str(audio.path), "rb") as decoded:
            require((decoded.getnchannels(), decoded.getsampwidth(), decoded.getframerate(), decoded.getcomptype()) == (1, 2, 16000, "NONE"), "WAV PCM16")
            require(decoded.getnframes() == fixture.sample_count, "normalization sample count")
            count = 0
            pcm_digest = hashlib.sha256()
            while data := decoded.readframes(8192):
                count += len(data)
                pcm_digest.update(data)
            require(count == fixture.sample_count * 2, "complete normalized PCM")
            for anchor in fixture.anchors:
                decoded.setpos(anchor.start_sample)
                data = decoded.readframes(anchor.end_sample - anchor.start_sample)
                require(hashlib.sha256(data).hexdigest() == anchor.pcm_sha256, "normalization anchor")
    except (OSError, wave.Error, EOFError):
        raise EvaluationError("evaluation normalized WAV unavailable or invalid") from None
    return {"sample_count": fixture.sample_count, "sample_rate_hz": 16000, "channels": 1,
            "sample_format": "s16", "normalized_pcm_sha256": pcm_digest.hexdigest(),
            "boundary_anchors_verified": True}


def _published_intervals(speech_map, sample_count):
    for intervals in (speech_map.speech_intervals, speech_map.protected_intervals, speech_map.uncertain_intervals):
        previous = -1
        for item in intervals:
            require(type(item.start_sample) is int and type(item.end_sample) is int
                    and 0 <= item.start_sample < item.end_sample <= sample_count
                    and previous < item.start_sample, "published interval bounds")
            require(item.start_time == Fraction(item.start_sample, 16000)
                    and item.end_time == Fraction(item.end_sample, 16000), "sample timing")
            previous = item.end_sample
    padding = speech_map.provenance.effective_configuration["boundary_padding_samples"]
    expected = merge(SampleInterval(max(0, item.start_sample - padding), min(sample_count, item.end_sample + padding))
                     for item in speech_map.speech_intervals)
    require(list(speech_map.protected_intervals) == expected, "boundary protection")


def _evidence_integrity(result):
    evidence, speech_map = result.speech_evidence, result.speech_map
    sample_count = result.normalized_artifact.sample_count
    configuration = evidence.provenance.effective_configuration
    require(evidence.sample_count == sample_count and configuration["frame_samples"] == 512
            and configuration["sample_rate_hz"] == 16000
            and configuration["tail_padding"] == "model-only-zero-padding", "evidence configuration")
    speech_threshold, non_speech_threshold = configuration["speech_threshold"], configuration["non_speech_threshold"]
    require(0 <= non_speech_threshold < speech_threshold <= 1, "evidence thresholds")
    counts = Counter()
    bands = {label: [] for label in VadLabel}
    high_energy = []
    weak_count = 0
    position = frame_count = tail_padding = 0
    floor = speech_map.provenance.effective_configuration["energy_floor_dbfs"]
    for frame in evidence.iter_frames():
        require(type(frame.start_sample) is int and type(frame.end_sample) is int
                and frame.start_sample == position and frame.end_sample == min(position + 512, sample_count)
                and position < frame.end_sample <= sample_count, "complete frame coverage")
        require(frame.padding_samples == 512 - (frame.end_sample - frame.start_sample), "model-only padding")
        require(frame.start_time == Fraction(position, 16000)
                and frame.end_time == Fraction(frame.end_sample, 16000), "evidence timing")
        require(math.isfinite(frame.vad_probability) and 0 <= frame.vad_probability <= 1, "VAD evidence")
        label = (VadLabel.LIKELY_SPEECH if frame.vad_probability >= speech_threshold else
                 VadLabel.LIKELY_NON_SPEECH if frame.vad_probability <= non_speech_threshold else VadLabel.UNCERTAIN)
        require(frame.vad_label == label, "VAD evidence band")
        require(math.isfinite(frame.rms) and 0 <= frame.rms <= 1 and (
            frame.dbfs == -math.inf if frame.rms == 0 else
            math.isfinite(frame.dbfs) and math.isclose(frame.dbfs, 20 * math.log10(frame.rms), abs_tol=1e-9)
        ), "energy evidence")
        item = SampleInterval(frame.start_sample, frame.end_sample)
        # Coalesce while streaming: no per-frame probabilities or media in reports.
        target = bands[label]
        if target and target[-1].end_sample == item.start_sample:
            target[-1] = SampleInterval(target[-1].start_sample, item.end_sample)
        else:
            target.append(item)
        if label == VadLabel.LIKELY_NON_SPEECH and frame.dbfs >= floor:
            if high_energy and high_energy[-1].end_sample == item.start_sample:
                high_energy[-1] = SampleInterval(high_energy[-1].start_sample, item.end_sample)
            else:
                high_energy.append(item)
            counts["high-energy"] += 1
        if label == VadLabel.LIKELY_SPEECH and frame.dbfs < floor:
            weak_count += 1
        counts[label] += 1
        frame_count += 1
        tail_padding += frame.padding_samples
        position = frame.end_sample
    quality = speech_map.quality
    require(position == sample_count and frame_count == evidence.frame_count == (sample_count + 511) // 512, "complete frame coverage")
    require((counts[VadLabel.LIKELY_SPEECH], counts[VadLabel.LIKELY_NON_SPEECH], counts[VadLabel.UNCERTAIN]) == (
        evidence.likely_speech_frame_count, evidence.likely_non_speech_frame_count, evidence.uncertain_frame_count,
    ), "evidence counters")
    require(asdict(quality) == {
        "frame_count": frame_count, "likely_speech_frame_count": counts[VadLabel.LIKELY_SPEECH],
        "likely_non_speech_frame_count": counts[VadLabel.LIKELY_NON_SPEECH],
        "uncertain_frame_count": counts[VadLabel.UNCERTAIN], "weak_speech_frame_count": weak_count,
        "high_energy_non_speech_frame_count": counts["high-energy"],
        "vad_energy_disagreement_frame_count": weak_count + counts["high-energy"],
        "protected_window_coalescing_count": len(speech_map.speech_intervals) - len(speech_map.protected_intervals),
    }, "speech-map warning counts")
    require(not subtract(bands[VadLabel.UNCERTAIN] + high_energy, speech_map.uncertain_intervals), "visible uncertainty")
    require(not subtract(bands[VadLabel.LIKELY_SPEECH], speech_map.speech_intervals), "visible detected speech")
    require(tuple(result.warnings) == quality.warnings, "speech-map warnings")
    return bands, high_energy, {"frame_coverage_samples": position, "frame_count": frame_count,
                                "tail_padding_samples": tail_padding, "boundary_protection_verified": True}


def _provenance(result, expected_model_sha256):
    provenance = result.provenance
    audio, evidence, speech_map = result.normalized_artifact, result.speech_evidence, result.speech_map
    require(provenance.normalization == audio.provenance and provenance.detection == evidence.provenance
            and provenance.speech_map == speech_map.provenance
            and speech_map.provenance.detector_provenance == evidence.provenance
            and provenance.source_id == audio.source_id == evidence.source_id == speech_map.provenance.source_id
            and provenance.sample_count == audio.sample_count == speech_map.provenance.sample_count, "stage provenance")
    require(evidence.provenance.model_sha256 == expected_model_sha256
            and evidence.provenance.backend == "onnxruntime-cpu", "model provenance")
    require(all(isinstance(value, str) and value for value in (
        provenance.pipeline_version, audio.provenance.normalizer_version, audio.provenance.decoder_version,
        evidence.provenance.model_id, evidence.provenance.model_version,
        evidence.provenance.detector_version, speech_map.provenance.mapper_version,
    )), "version provenance")
    configuration = {stage: dict(values) for stage, values in provenance.effective_configuration.items()}
    # Retain storage identity as an opaque digest, never a private filesystem path.
    if "temp_dir" in configuration["normalization"]:
        configuration["normalization"]["temp_dir"] = {"sha256": digest_json(configuration["normalization"]["temp_dir"])}
    return {
        "pipeline_version": provenance.pipeline_version,
        "normalizer_version": audio.provenance.normalizer_version,
        "decoder": audio.provenance.decoder, "decoder_version": audio.provenance.decoder_version,
        "target_format": dict(audio.provenance.target_format),
        "detector_version": evidence.provenance.detector_version,
        "mapper_version": speech_map.provenance.mapper_version,
        "model_id": evidence.provenance.model_id, "model_version": evidence.provenance.model_version,
        "model_sha256": evidence.provenance.model_sha256, "backend": evidence.provenance.backend,
        "effective_configuration": configuration, "configuration_sha256": digest_json(configuration),
        "runtime_versions": {"python": platform.python_version(), "numpy": version("numpy"), "onnxruntime": version("onnxruntime")},
    }


def analyze_result(manifest: Manifest, fixture: Fixture, result: PreprocessingResult, *, expected_model_sha256: str):
    require(result.normalized_artifact.source_id == fixture.fixture_id, "fixture provenance")
    provenance = _provenance(result, expected_model_sha256)
    integrity = _normalization_integrity(fixture, result.normalized_artifact)
    _published_intervals(result.speech_map, fixture.sample_count)
    bands, high_energy, evidence_integrity = _evidence_integrity(result)
    integrity.update(evidence_integrity)
    speech_map = result.speech_map
    metrics = quality_metrics(fixture, speech_map.speech_intervals, speech_map.uncertain_intervals)
    missed = subtract([label for label in fixture.labels if label.label == "speech"], speech_map.speech_intervals)
    metrics.update({
        "missed_uncertain_samples": samples(intersect(missed, speech_map.uncertain_intervals)),
        "missed_likely_non_speech_samples": samples(intersect(missed, bands[VadLabel.LIKELY_NON_SPEECH])),
        "missed_high_energy_non_speech_samples": samples(intersect(missed, high_energy)),
        "missed_unprotected_samples": samples(subtract(missed, speech_map.protected_intervals)),
    })
    annotation_digest = digest_json(fixture.model_dump(include={"annotation_version", "annotation_origin", "labels", "sample_count", "anchors"}))
    identity = {
        "evaluation_version": "1", "dataset_id": manifest.dataset_id, "dataset_version": manifest.dataset_version,
        "manifest_sha256": manifest.manifest_sha256,
        "fixture_id": fixture.fixture_id, "source_sha256": fixture.source_sha256,
        "annotation_sha256": annotation_digest, "provenance": provenance,
    }
    return {
        "evaluation_id": digest_json(identity), "fixture_id": fixture.fixture_id,
        "source_sha256": fixture.source_sha256, "annotation_version": fixture.annotation_version,
        "annotation_origin": fixture.annotation_origin, "annotation_sha256": annotation_digest,
        "conditions": sorted(fixture.conditions), "provenance": provenance, "integrity": integrity,
        "metrics": metrics, "quality_gates": evaluate_gates(manifest, metrics),
        "evidence": {
            "speech_intervals": [bounds(item) for item in speech_map.speech_intervals],
            "protected_intervals": [bounds(item) for item in speech_map.protected_intervals],
            "uncertain_intervals": [bounds(item) for item in speech_map.uncertain_intervals],
            "vad_band_samples": {label.value: samples(bands[label]) for label in VadLabel},
            "high_energy_non_speech_samples": samples(high_energy),
            "warning_counts": asdict(speech_map.quality), "warnings": [warning.value for warning in result.warnings],
        },
    }


def build_report(manifest, records):
    require(len(records) == len(manifest.fixtures)
            and {record["fixture_id"] for record in records} == {fixture.fixture_id for fixture in manifest.fixtures}, "incomplete results")
    return {
        "schema_version": 1, "evaluation_version": "1",
        "dataset": {
            "dataset_id": manifest.dataset_id, "dataset_version": manifest.dataset_version,
            "manifest_sha256": manifest.manifest_sha256,
            "dataset_sha256": digest_json(manifest.model_dump(exclude={"manifest_sha256"})),
            "privacy_approved": manifest.privacy_approved, "legal_approved": manifest.legal_approved,
            "approval_version": manifest.approval_version,
            "labeling_guideline_version": manifest.labeling_guideline_version,
            "long_audio_min_samples": manifest.long_audio_min_samples,
        },
        "quality_gate_status": _gate_status(record["quality_gates"]["status"] for record in records),
        "results": sorted(records, key=lambda record: record["fixture_id"]),
    }


def write_report(path, report):
    try:
        # Explicit output path only; no directory creation or output-path fallback.
        with path.open("w", encoding="utf-8") as output:
            output.write(canonical_json(report))
    except (OSError, ValueError):
        raise EvaluationError("evaluation output unavailable or invalid") from None
