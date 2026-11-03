"""Pure, test-local transcription contracts and independently denominated metrics.

Text normalization vi-nfc-casefold-technical-1: NFC, casefold, NFC; Unicode
letters/numbers/marks form whitespace-separated tokens. Sentence punctuation is
discarded, but attached +/# and internal . / _ - retain technical distinctions
(C++, C#, v2.1). CER uses those same tokens with whitespace removed, counting
Unicode code points, never UTF-8 bytes. Vietnamese accents and đ are preserved.
Edit-distance ties prefer diagonal (match/substitution), deletion, then insertion.
Neither normalized text, tokens nor edit alignments enter returned records.
"""

import hashlib
import json
import unicodedata
from fractions import Fraction
from pathlib import Path
from typing import Literal, TypedDict

from pydantic import Field, model_validator

from sme_meeting_ai.core.config import Settings

from .support import (
    CONDITIONS,
    Bounds,
    Contract,
    EvaluationError,
    Identifier,
    Positive,
    Rational,
    TranscriptionMetric,
    TranscriptionStage,
    _unique_keys,
    digest_json,
    intersect,
    merge,
    quality_metrics,
    rational,
    require,
    samples,
    subtract,
)

EVALUATION_VERSION = "transcription-1"
NORMALIZATION_VERSION = "vi-nfc-casefold-technical-1"
STAGES = ("preprocessing", "chunk_planning", "baseline_asr", "recovery", "reconciliation", "correction", "end_to_end")
_MAX_JSON_BYTES = 16 * 1024 * 1024
ReportStatus = Literal["PASS", "FAIL", "UNESTABLISHED", "UNAVAILABLE"]
Ratio = dict[str, int]


class TextMetrics(TypedDict):
    normalization_version: str
    reference_words: int
    hypothesis_words: int
    word_errors: int
    word_substitutions: int
    word_deletions: int
    word_insertions: int
    reference_characters: int
    hypothesis_characters: int
    character_errors: int
    character_substitutions: int
    character_deletions: int
    character_insertions: int
    wer: Ratio | None
    cer: Ratio | None


class TranscriptionMetrics(TypedDict, total=False):
    confirmed_speech_samples: int
    covered_speech_samples: int
    coverage_rate: Ratio | None
    missed_samples: int
    missed_material_samples: int
    missed_critical_samples: int
    hallucinated_samples: int
    hallucination_rate: Ratio | None
    unresolved_speech_samples: int
    unresolved_rate: Ratio | None
    pipeline_unresolved_rate: Ratio | None
    initial_unresolved_speech_samples: int | None
    recovered_speech_samples: int | None
    recovery_success_rate: Ratio | None
    false_success: bool | None


class StageOutcome(TypedDict):
    stage: str
    status: ReportStatus
    metrics: dict | None
    duration_ns: int | None
    failure: str | None


class ProviderCallTelemetry(TypedDict):
    phase: str
    stage: str
    call_id: str
    duration_ns: int
    cost: Ratio | None
    failure: str | None
    provider: str | None
    requested_model: str | None
    resolved_model: str | None
    upstream_provider: str | None
    input_tokens: int | None
    output_tokens: int | None
    total_tokens: int | None


class TranscriptionCaseRecord(TypedDict):
    fixture_id: str
    variant_id: str
    evidence_mode: Literal["offline-contract", "approved-live"]
    case_configuration_id: str
    evaluation_id: str
    identity: dict
    configuration: dict
    provenance: dict | None
    stages: list[StageOutcome]
    telemetry: dict
    quality_gates: dict
    status: ReportStatus


class TranscriptionReport(TypedDict):
    schema_version: int
    evaluation_version: str
    dataset: dict
    configuration_matrix: dict
    configuration_matrix_sha256: str
    quality_gate_status: ReportStatus
    results: list[TranscriptionCaseRecord]
    aggregates: dict
    baseline_comparisons: list[dict]
    baseline_checks: list[dict]
    regressions: list[dict]


def status_of(statuses):
    statuses = list(statuses)
    for status in ("FAIL", "UNAVAILABLE", "UNESTABLISHED"):
        if status in statuses:
            return status
    return "PASS" if statuses else "UNESTABLISHED"


def external_file(root, relative):
    """Reject symlinks at every component, not just at the leaf."""
    root = root.absolute()
    path = root / relative
    require(path.resolve().is_relative_to(root.resolve()), "external path")
    for part in (path, *path.parents):
        require(not part.is_symlink(), "external symlink")
    require(path.is_file(), "external file")
    return path


def read_document(path):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= _MAX_JSON_BYTES, "JSON file")
    raw = path.read_bytes()
    def invalid(_value):
        raise ValueError
    document = json.loads(raw, object_pairs_hook=_unique_keys, parse_constant=invalid)
    return raw, document


class ReferenceSegment(Bounds):
    label: Literal["speech", "silence", "noise", "music", "ambiguous"]
    text: str = Field(repr=False)

    @model_validator(mode="after")
    def independent_text(self):
        self.text.encode("utf-8")
        if self.label == "speech":
            if not _tokens(self.text):
                raise ValueError("speech reference required")
        elif self.text:
            raise ValueError("text restricted to independently labeled speech")
        return self


class GroundTruthReference(Contract):
    schema_version: Literal[1]
    fixture_id: Identifier
    reference_version: Identifier
    annotation_version: Identifier
    origin: Literal["independent-human"]
    language: Literal["vi"]
    sample_count: Positive
    segments: list[ReferenceSegment] = Field(min_length=1, repr=False)

    @model_validator(mode="after")
    def timeline(self):
        position = 0
        for segment in self.segments:
            if segment.start_sample != position or segment.end_sample > self.sample_count:
                raise ValueError("complete reference partition required")
            position = segment.end_sample
        if position != self.sample_count:
            raise ValueError("complete reference timeline required")
        return self


def require_transcription_manifest(manifest):
    require(manifest.schema_version == 2, "transcription manifest version")
    require(CONDITIONS <= set().union(*(set(f.conditions) for f in manifest.fixtures)), "Vietnamese conditions")
    for fixture in manifest.fixtures:
        if any(label.label == "speech" for label in fixture.labels):
            require(fixture.reference is not None and fixture.kind == "recording"
                    and fixture.language == "vi" and fixture.annotation_origin == "independent-human", "human reference")


def load_reference(root: Path, fixture) -> GroundTruthReference:
    try:
        descriptor = fixture.reference
        require(descriptor is not None and fixture.kind == "recording" and fixture.language == "vi", "reference")
        path = external_file(root, descriptor.path)
        raw, document = read_document(path)
        require(hashlib.sha256(raw).hexdigest() == descriptor.sha256, "reference digest")
        reference = GroundTruthReference.model_validate(document)
        require(reference.fixture_id == fixture.fixture_id
                and reference.sample_count == fixture.sample_count
                and reference.reference_version == descriptor.reference_version
                and reference.annotation_version == fixture.annotation_version, "reference identity")
        # Subdivision is allowed; no reference segment may cross a human label.
        for segment in reference.segments:
            require(samples(intersect([segment], [label for label in fixture.labels if label.label == segment.label]))
                    == segment.end_sample - segment.start_sample, "reference labels")
        return reference
    except (OSError, ValueError, TypeError, AttributeError, UnicodeError):
        pass
    raise EvaluationError("evaluation reference invalid or unavailable")


def _tokens(text):
    text.encode("utf-8")
    text = unicodedata.normalize("NFC", unicodedata.normalize("NFC", text).casefold())
    def content(char):
        return unicodedata.category(char)[0] in "LNM"
    tokens, token = [], []
    for index, char in enumerate(text):
        attached = char in "+#" and bool(token)
        internal = char in "./_-" and token and index + 1 < len(text) and content(text[index + 1])
        if content(char) or attached or internal:
            token.append(char)
        elif token:
            tokens.append("".join(token))
            token = []
    if token:
        tokens.append("".join(token))
    return tokens


def _edits(reference, hypothesis):
    # O(hypothesis length) storage; counts, not input-bearing alignments.
    previous = [(index, 0, 0, index) for index in range(len(hypothesis) + 1)]
    for row, left in enumerate(reference, 1):
        current = [(row, 0, row, 0)]
        for column, right in enumerate(hypothesis, 1):
            distance, substitutions, deletions, insertions = previous[column - 1]
            different = int(left != right)
            diagonal = (distance + different, substitutions + different, deletions, insertions)
            distance, substitutions, deletions, insertions = previous[column]
            deletion = (distance + 1, substitutions, deletions + 1, insertions)
            distance, substitutions, deletions, insertions = current[column - 1]
            insertion = (distance + 1, substitutions, deletions, insertions + 1)
            current.append(min((diagonal, deletion, insertion), key=lambda value: value[0]))
        previous = current
    return previous[-1]


def compute_text_metrics(reference: str, hypothesis: str) -> TextMetrics:
    left, right = _tokens(reference), _tokens(hypothesis)
    result = {"normalization_version": NORMALIZATION_VERSION}
    for unit, a, b, rate in (("word", left, right, "wer"), ("character", "".join(left), "".join(right), "cer")):
        errors, substitutions, deletions, insertions = _edits(a, b)
        result.update({f"reference_{unit}s": len(a), f"hypothesis_{unit}s": len(b),
                       f"{unit}_errors": errors, f"{unit}_substitutions": substitutions,
                       f"{unit}_deletions": deletions, f"{unit}_insertions": insertions,
                       rate: rational(errors, len(a))})
    return result


def compute_transcription_metrics(
    fixture, supported, *, initial_supported=None, unresolved=None, initial_unresolved=None,
    pipeline_speech_samples=None, pipeline_unresolved_samples=None, pipeline_status=None,
    result_available=None,
) -> TranscriptionMetrics:
    supported = merge(supported)
    for item in (*supported, *(unresolved or ()), *(initial_supported or ()), *(initial_unresolved or ())):
        require(0 <= item.start_sample < item.end_sample <= fixture.sample_count, "metric bounds")
    metrics = quality_metrics(fixture, supported, [])
    speech = [label for label in fixture.labels if label.label == "speech"]
    missing = subtract(speech, supported)
    remaining = merge([*missing, *intersect(speech, unresolved or ())])
    before = None
    recovered = None
    if initial_supported is not None:
        initial = merge([*subtract(speech, initial_supported), *intersect(speech, initial_unresolved or ())])
        before = samples(initial)
        # Signed progress exposes regressions too; do not clip negative deltas.
        recovered = before - samples(remaining)
    metrics.update({
        "hallucinated_samples": metrics["false_positive_samples"],
        "hallucination_rate": metrics["false_positive_rate"],
        "hallucination_by_label": metrics["false_positives_by_label"],
        "unresolved_speech_samples": samples(remaining),
        "unresolved_rate": rational(samples(remaining), samples(speech)),
        "pipeline_speech_samples": pipeline_speech_samples,
        "pipeline_unresolved_speech_samples": pipeline_unresolved_samples,
        "pipeline_unresolved_rate": (rational(pipeline_unresolved_samples, pipeline_speech_samples)
                                     if pipeline_unresolved_samples is not None and pipeline_speech_samples is not None else None),
        "initial_unresolved_speech_samples": before,
        "recovered_speech_samples": recovered,
        "recovery_success_rate": rational(recovered, before) if before is not None else None,
        "false_success": (pipeline_status in {"COMPLETED", "COMPLETED_WITH_WARNINGS"}
                          and bool(samples(remaining) or (samples(speech) and not result_available)))
                         if pipeline_status is not None else None,
    })
    return metrics


def evaluate_transcription_gates(manifest, fixture, stages):
    checks = []
    for gate in sorted(manifest.transcription_quality_gates, key=lambda gate: (gate.stage, gate.metric)):
        stage = stages.get(gate.stage)
        metrics = stage.get("metrics") if stage else None
        actual = metrics.get(gate.metric) if metrics is not None else None
        status = "UNAVAILABLE" if metrics is None else "UNESTABLISHED"
        if actual is not None:
            value = Fraction(**actual) if isinstance(actual, dict) else Fraction(actual)
            threshold = gate.minimum or gate.maximum
            bound = Fraction(threshold.numerator, threshold.denominator)
            status = "PASS" if (value >= bound if gate.minimum is not None else value <= bound) else "FAIL"
        checks.append({**gate.model_dump(exclude_none=True), "actual": actual, "status": status})
    if "historical-regression" in fixture.conditions:
        final = stages.get("end_to_end")
        metrics = final.get("metrics") if final else None
        for metric in ("missed_material_samples", "missed_critical_samples", "false_success"):
            actual = metrics.get(metric) if metrics is not None else None
            checks.append({"stage": "end_to_end", "metric": metric,
                           "maximum": {"numerator": 0, "denominator": 1},
                           "basis_version": "mandatory-zero-material-loss-1", "actual": actual,
                           "status": "UNAVAILABLE" if actual is None else "PASS" if actual == 0 else "FAIL"})
    # A mandatory gate does not establish optional ASR quality thresholds.
    statuses = [check["status"] for check in checks]
    if not manifest.transcription_quality_gates:
        statuses.append("UNESTABLISHED")
    return {"status": status_of(statuses), "checks": checks}


class ConfigurationVariant(Contract):
    variant_id: Identifier
    version: Identifier
    target_samples: Positive
    max_request_samples: Positive
    overlap_samples: int = Field(ge=0, le=230400000)
    boundary_search_samples: int = Field(ge=0, le=230400000)

    @model_validator(mode="after")
    def geometry(self):
        if (self.max_request_samples > 230400000 or self.target_samples + self.overlap_samples > self.max_request_samples
                or self.overlap_samples >= self.max_request_samples or self.boundary_search_samples >= self.target_samples):
            raise ValueError("invalid chunk geometry")
        return self

    def settings(self, base: Settings):
        data = base.model_dump(by_alias=True)
        data.update(audio_asr_chunk_target_samples=self.target_samples,
                    audio_asr_chunk_max_request_samples=self.max_request_samples,
                    audio_asr_chunk_overlap_samples=self.overlap_samples,
                    audio_asr_chunk_boundary_search_samples=self.boundary_search_samples)
        return Settings(_env_file=None, **data)


class BaselinePolicy(Contract):
    stage: TranscriptionStage
    metric: TranscriptionMetric
    direction: Literal["lower", "higher"]
    maximum_regression: Rational
    basis_version: Identifier


class ConfigurationMatrix(Contract):
    schema_version: Literal[1]
    configuration_version: Identifier
    baseline_variant: Identifier
    variants: list[ConfigurationVariant] = Field(min_length=1)
    baseline_policies: list[BaselinePolicy] = Field(default_factory=list)

    @model_validator(mode="after")
    def identities(self):
        ids = [variant.variant_id for variant in self.variants]
        if len(set(ids)) != len(ids) or self.baseline_variant not in ids:
            raise ValueError("invalid configuration identities")
        if len({(p.stage, p.metric) for p in self.baseline_policies}) != len(self.baseline_policies):
            raise ValueError("duplicate baseline policy")
        return self

    def canonical(self):
        return {**self.model_dump(),
                "variants": [variant.model_dump() for variant in sorted(self.variants, key=lambda v: v.variant_id)],
                "baseline_policies": [p.model_dump() for p in sorted(self.baseline_policies, key=lambda p: (p.stage, p.metric))]}


def load_configuration(path):
    try:
        _, document = read_document(path)
        return ConfigurationMatrix.model_validate(document)
    except (OSError, ValueError, TypeError):
        pass
    raise EvaluationError("evaluation configuration invalid or unavailable")


def safe_settings(settings):
    # No paths, environment dumps, transport integrations, secrets or prompts.
    return {key: value for key, value in settings.model_dump().items()
            if key.startswith(("audio_", "transcript_correction_"))
            and not key.endswith(("_path", "_dir"))
            and (value is None or type(value) in (str, int, float, bool))}


def configuration_identity(settings, variant=None, configuration_version="explicit-settings-1"):
    config = {"configuration_version": configuration_version,
              "variant": variant.model_dump() if variant is not None else None,
              "effective_settings": safe_settings(settings)}
    return {**config, "sha256": digest_json(config)}


def validate_output_path(output, fixture_root, protected_paths):
    try:
        output = output.absolute()
        require(output.parent.is_dir() and not output.is_symlink()
                and not output.resolve().is_relative_to(fixture_root.resolve()), "output location")
        require(not any(part.is_symlink() for part in output.parents), "output symlink")
        for path in protected_paths:
            require(output.resolve().parent != path.resolve().parent
                    and output.resolve() != path.resolve()
                    and (not output.exists() or not path.exists() or not output.samefile(path)), "output alias")
        # Never write a generated artifact inside the Git workspace.
        repository = Path(__file__).resolve().parents[4]
        require(not output.resolve().is_relative_to(repository), "output repository")
    except (OSError, ValueError):
        raise EvaluationError("evaluation output location invalid") from None


def load_baseline(path):
    try:
        _, document = read_document(path)
        require(isinstance(document, dict) and document.get("evaluation_version") == EVALUATION_VERSION
                and isinstance(document.get("results"), list) and isinstance(document.get("dataset"), dict), "baseline")
        return document
    except (OSError, ValueError, TypeError):
        pass
    raise EvaluationError("evaluation baseline invalid or unavailable")
