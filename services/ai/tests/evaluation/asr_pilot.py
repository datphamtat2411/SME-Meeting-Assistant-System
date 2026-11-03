"""Bounded production-entry pilot. Its evidence cannot be a cutover CaseRecord."""

import argparse
import os
import time
import traceback
from concurrent.futures import CancelledError
from contextlib import ExitStack
from pathlib import Path
from typing import Literal

from pydantic import model_validator

from .asr_cutover import (
    MODEL,
    CaseRecord,
    _aggregates,
    _CallLedger,
    _compatible,
    _delta,
    fixture_identity,
    pipeline_identity,
    run_production_case,
)
from .asr_pilot_manifest import (
    _exclusive_bytes,
    external_path,
    validate_pilot_manifest,
)
from .support import (
    CONDITIONS,
    Contract,
    Digest,
    EvaluationError,
    Identifier,
    Positive,
    canonical_json,
    digest_json,
    rational,
    require,
    require_pinned_model,
    samples,
    subtract,
)
from .transcription_runner import require_live_evaluation
from .transcription_support import (
    external_file,
    load_configuration,
    read_document,
    safe_settings,
    validate_output_path,
)

EVALUATION_VERSION = "asr-pilot-1"


def configuration_identity(matrix, settings):
    return digest_json({"evaluation": EVALUATION_VERSION, "matrix": matrix.canonical(),
                        "settings": safe_settings(settings), "modes": ["chunked", "adaptive"]})


def operational_limits(settings):
    # Exact effective settings are pinned too; this readable subset is explicitly
    # reviewed for spending/time/payload/concurrency, not inferred permission.
    names = ("audio_max_input_bytes", "audio_max_duration_seconds", "audio_max_output_bytes",
             "audio_probe_timeout_seconds", "audio_decode_timeout_seconds", "audio_vad_timeout_seconds",
             "audio_asr_chunk_max_chunks", "audio_asr_max_payload_bytes", "audio_asr_max_concurrent_chunks",
             "audio_asr_timeout_seconds", "audio_asr_adaptive_max_total_calls",
             "audio_asr_recovery_max_total_attempts", "audio_asr_recovery_max_total_request_samples",
             "audio_asr_recovery_max_wall_time_seconds", "transcript_correction_max_attempts",
             "transcript_correction_timeout_seconds", "transcript_correction_max_input_tokens",
             "transcript_correction_max_output_tokens")
    return {name: getattr(settings, name) for name in names}


class PilotApproval(Contract):
    schema_version: Literal[1]
    evaluation_scope: Literal["pilot"]
    approved: bool
    approval_version: Identifier
    approval_evidence_sha256: Digest
    manifest_sha256: Digest
    dataset_root_identity: Digest
    configuration_identity: Digest
    pipeline_identity: Digest
    fixture_identities: dict[Identifier, Digest]
    trials: Positive = 1
    maximum_asr_calls: Positive
    operational_limits: dict[str, int | float]


def _inputs(root, config_path, settings, *, require_approval):
    for path in (root, config_path):
        external_path(path)
    manifest = validate_pilot_manifest(root, require_approval=require_approval)
    matrix = load_configuration(config_path)
    require(len(matrix.variants) == 1, "one pilot geometry for two modes")
    effective = matrix.variants[0].settings(settings)
    require(effective.audio_asr_model == MODEL and effective.audio_asr_language == "vi", "locked pilot model")
    require_pinned_model(effective)
    external_path(effective.audio_vad_model_path)
    for fixture in manifest.fixtures:
        require(fixture.sample_count <= effective.audio_max_duration_seconds * 16000
                and fixture.sample_count * 2 + 44 <= effective.audio_max_output_bytes
                and (root / fixture.path).stat().st_size <= effective.audio_max_input_bytes,
                "pilot local media limits")
    return manifest, matrix, effective


def approval_draft(root, config_path, settings, *, max_asr_calls, trials=1):
    """Computes identities, NEVER approval. Owner must review and edit externally."""
    try:
        manifest, matrix, effective = _inputs(root, config_path, settings, require_approval=False)
        return PilotApproval(
            schema_version=1, evaluation_scope="pilot", approved=False, approval_version="pending-review",
            approval_evidence_sha256="0" * 64, manifest_sha256=manifest.manifest_sha256,
            dataset_root_identity=digest_json(str(root.resolve())),
            configuration_identity=configuration_identity(matrix, settings), pipeline_identity=pipeline_identity(),
            fixture_identities={f.fixture_id: fixture_identity(f) for f in manifest.fixtures}, trials=trials,
            maximum_asr_calls=max_asr_calls, operational_limits=operational_limits(effective),
        ).model_dump()
    except (OSError, ValueError, TypeError):
        raise EvaluationError("pilot scope draft unavailable; valid local assets required") from None


def preflight_pilot(root, config_path, approval_path, output, max_asr_calls, settings):
    __tracebackhide__ = True
    try:
        require(os.environ.get("RUN_ASR_PILOT_LIVE") == "1", "pilot live opt-in")
        require_live_evaluation(settings)
        for path in (root, config_path, approval_path, output):
            external_path(path)
        manifest, matrix, effective = _inputs(root, config_path, settings, require_approval=True)
        _, document = read_document(approval_path)
        approval = PilotApproval.model_validate(document)
        require(approval.approved and approval.approval_evidence_sha256 != "0" * 64, "human pilot scope approval")
        draft = approval_draft(root, config_path, settings, max_asr_calls=approval.maximum_asr_calls, trials=approval.trials)
        for key in ("manifest_sha256", "dataset_root_identity", "configuration_identity", "pipeline_identity",
                    "fixture_identities", "operational_limits"):
            require(getattr(approval, key) == draft[key], "exact approved pilot scope")
        per_case = effective.audio_asr_chunk_max_chunks + effective.audio_asr_recovery_max_total_attempts + 1
        maximum = len(manifest.fixtures) * 2 * approval.trials * per_case
        require(type(max_asr_calls) is int and maximum <= max_asr_calls <= approval.maximum_asr_calls,
                "complete pilot request budget")
        protected = [root / "manifest.json", config_path, approval_path, effective.audio_vad_model_path]
        for fixture in manifest.fixtures:
            protected.extend([external_file(root, fixture.path), external_file(root, fixture.reference.path)])
        validate_output_path(output, root, protected)
        require(not output.exists(), "new pilot output")
        return manifest, matrix, approval, effective, maximum
    except Exception as error:
        traceback.clear_frames(error.__traceback__)
    raise EvaluationError("pilot preflight unavailable; opt-ins, reviewed scope, local assets and budget required") from None


class PilotCase(CaseRecord):
    evidence_mode: Literal["pilot-offline", "pilot-live"]
    fixture_id: Identifier
    conditions: list[str]

    @model_validator(mode="after")
    def pilot_conditions(self):
        require(set(self.conditions) <= CONDITIONS, "pilot demonstrated conditions")
        return self


class PilotDataset(Contract):
    dataset_id: Identifier
    dataset_version: Identifier
    manifest_sha256: Digest
    fixture_identities: dict[Identifier, Digest]
    reference_digests: dict[Identifier, Digest]
    recording_count: Positive
    sample_count: Positive
    duration_seconds: dict[Literal["numerator", "denominator"], int]
    condition_coverage: list[str]


class PilotReport(Contract):
    report_schema_version: Literal[1]
    evaluation_version: Literal["asr-pilot-1"]
    evaluation_scope: Literal["pilot"]
    production_readiness: Literal["NOT_ASSESSED"]
    deployment_authorized: Literal[False]
    run_timestamp_ns: Positive
    dataset: PilotDataset
    configuration_identity: Digest
    pipeline_identity: Digest
    approval_sha256: Digest | None
    trials: Positive
    cases: list[PilotCase]
    aggregates: dict
    comparison: dict
    fixture_metrics: list[dict]
    report_sha256: Digest


def _assemble(dataset, config_identity, pipeline, approval, trials, timestamp, cases):
    cases = sorted((PilotCase.model_validate(c) for c in cases), key=lambda c: (c.fixture_id, c.trial, c.strategy_mode))
    expected = {(key, trial, mode) for key in dataset.fixture_identities for trial in range(trials)
                for mode in ("chunked", "adaptive")}
    require(len(cases) == len(expected) and {(c.fixture_id, c.trial, c.strategy_mode) for c in cases} == expected,
            "complete pilot paired scope")
    for case in cases:
        require(case.fixture_identity == dataset.fixture_identities[case.fixture_id]
                and case.reference_sha256 == dataset.reference_digests[case.fixture_id]
                and case.pipeline_identity == pipeline, "pilot case identities")
    unique = {c.fixture_id: c for c in cases}
    require(dataset.recording_count == len(unique) >= 2
            and dataset.sample_count == sum(c.sample_count for c in unique.values())
            and dataset.duration_seconds == rational(dataset.sample_count)
            and set(dataset.reference_digests) == set(unique)
            and dataset.condition_coverage == sorted({c for case in cases for c in case.conditions}),
            "pilot dataset summary")
    require(len({c.source_sha256 for c in unique.values() if c.human_speech_samples}) >= 2,
            "independent pilot report speech")
    pairs = [(cases[index], cases[index + 1]) for index in range(0, len(cases), 2)]
    # Sort is alphabetical: adaptive precedes chunked. Compare explicitly by mode.
    pairs = [(b, a) if a.strategy_mode == "adaptive" else (a, b) for a, b in pairs]
    complete = all(_compatible(a, b) and a.metrics and b.metrics
                   and a.execution_status == b.execution_status == "PASS" for a, b in pairs)
    aggregates = _aggregates(cases)
    for mode in ("chunked", "adaptive"):
        for label in ("silence", "noise", "music"):
            group = aggregates[mode]["hallucination"]
            group[f"{label}_text_rate"] = rational(group[f"{label}_text_samples"], group[f"confirmed_{label}_samples"])
    comparison = {
        "status": "PAIRED_COMPLETE" if complete else "INCOMPLETE_OR_INCOMPATIBLE",
        "aggregate_comparable": bool(complete),
        "wer_delta": _delta(aggregates["chunked"]["text"]["wer"], aggregates["adaptive"]["text"]["wer"]) if complete else None,
        "cer_delta": _delta(aggregates["chunked"]["text"]["cer"], aggregates["adaptive"]["text"]["cer"]) if complete else None,
        "regressions": [{"fixture_id": a.fixture_id, "trial": a.trial,
                         "new_critical_loss_samples": samples(subtract(b.metrics.missing_critical, a.metrics.missing_critical)),
                         "wer_delta": _delta(a.metrics.text.wer, b.metrics.text.wer),
                         "cer_delta": _delta(a.metrics.text.cer, b.metrics.text.cer),
                         "provider_confounded": a.provider_upstreams != b.provider_upstreams
                         or bool(a.unknown_upstream_calls or b.unknown_upstream_calls)} for a, b in pairs
                        if a.metrics and b.metrics and _compatible(a, b)],
    }
    report = dict(report_schema_version=1, evaluation_version=EVALUATION_VERSION, evaluation_scope="pilot",
                  production_readiness="NOT_ASSESSED", deployment_authorized=False, run_timestamp_ns=timestamp,
                  dataset=dataset.model_dump(), configuration_identity=config_identity, pipeline_identity=pipeline,
                  approval_sha256=approval, trials=trials, cases=[c.model_dump() for c in cases],
                  aggregates=aggregates, comparison=comparison,
                  fixture_metrics=[{
                      "fixture_id": c.fixture_id, "strategy_mode": c.strategy_mode, "trial": c.trial,
                      "status": c.execution_status,
                      "speech_coverage": rational(c.metrics.supported_speech_samples, c.metrics.confirmed_speech_samples) if c.metrics else None,
                      "missing_speech_samples": samples(c.metrics.missing_speech) if c.metrics else None,
                      "missing_critical_speech_samples": samples(c.metrics.missing_critical) if c.metrics else None,
                      "missing_material_speech_samples": samples(c.metrics.missing_material) if c.metrics else None,
                  } for c in cases])
    report["report_sha256"] = digest_json(report)
    return report


def serialize_pilot_report(report):
    __tracebackhide__ = True
    try:
        parsed = PilotReport.model_validate(report)
        expected = _assemble(parsed.dataset, parsed.configuration_identity, parsed.pipeline_identity,
                             parsed.approval_sha256, parsed.trials, parsed.run_timestamp_ns, parsed.cases)
        require(canonical_json(expected) == canonical_json(report), "pilot report derived integrity")
        return canonical_json(expected).encode()
    except Exception as error:
        traceback.clear_frames(error.__traceback__)
    raise EvaluationError("pilot report invalid or unavailable") from None


def compare_scope(previous, current):
    """Scope-only comparison: never invent deltas on an expanded/corrected corpus."""
    before, after = previous["dataset"]["fixture_identities"], current["dataset"]["fixture_identities"]
    return {"aggregate_comparable": before == after,
            "matched": sorted(key for key in before.keys() & after.keys() if before[key] == after[key]),
            "changed": sorted(key for key in before.keys() & after.keys() if before[key] != after[key]),
            "added": sorted(after.keys() - before.keys()), "removed": sorted(before.keys() - after.keys())}


def run_pilot(manifest, root, matrix, settings, provider_factory, *, max_asr_calls, trials=1, approval=None):
    """Injected offline path or preflight-authorized live path; no stage replay."""
    manifest = validate_pilot_manifest(root, manifest, require_approval=approval is not None)
    require(len(matrix.variants) == 1 and type(trials) is int and trials > 0, "pilot geometry and trials")
    require(type(max_asr_calls) is int and max_asr_calls > 0, "explicit pilot budget")
    effective = matrix.variants[0].settings(settings)
    if approval is not None:
        approval = PilotApproval.model_validate(approval)
        require(os.environ.get("RUN_ASR_PILOT_LIVE") == "1" and approval.approved
                and approval.approval_evidence_sha256 != "0" * 64
                and manifest.manifest_sha256 == approval.manifest_sha256
                and digest_json(str(root.resolve())) == approval.dataset_root_identity
                and {f.fixture_id: fixture_identity(f) for f in manifest.fixtures} == approval.fixture_identities
                and configuration_identity(matrix, settings) == approval.configuration_identity
                and operational_limits(effective) == approval.operational_limits
                and pipeline_identity() == approval.pipeline_identity
                and trials == approval.trials and max_asr_calls <= approval.maximum_asr_calls, "pilot authorization")
        require_live_evaluation(settings)
        require_pinned_model(effective)
        external_path(effective.audio_vad_model_path)
        require(len(manifest.fixtures) * 2 * trials * (effective.audio_asr_chunk_max_chunks
                + effective.audio_asr_recovery_max_total_attempts + 1) <= max_asr_calls, "pilot complete budget")
    timestamp = time.time_ns()
    ledger, cases = _CallLedger(max_asr_calls), []
    with ExitStack() as resources:
        for mode in ("chunked", "adaptive"):
            config = effective.model_copy(update={"audio_asr_strategy_mode": mode})
            preprocessing, transcriber, corrector = provider_factory(config, resources)
            for fixture in sorted(manifest.fixtures, key=lambda f: f.fixture_id):
                for trial in range(trials):
                    row = run_production_case(
                        manifest, fixture, root, preprocessing, transcriber, corrector, config,
                        evidence_mode="approved-live" if approval is not None else "offline-contract",
                        ledger=ledger, trial=trial, authorized_live=approval is not None, authorization_scope="pilot")
                    row.update(fixture_id=fixture.fixture_id, conditions=sorted(fixture.conditions),
                               evidence_mode="pilot-live" if approval is not None else "pilot-offline")
                    cases.append(row)
    dataset = PilotDataset(dataset_id=manifest.dataset_id, dataset_version=manifest.dataset_version,
                           manifest_sha256=manifest.manifest_sha256,
                           fixture_identities={f.fixture_id: fixture_identity(f) for f in manifest.fixtures},
                           reference_digests={f.fixture_id: f.reference.sha256 for f in manifest.fixtures},
                           recording_count=len(manifest.fixtures), sample_count=sum(f.sample_count for f in manifest.fixtures),
                           duration_seconds=rational(sum(f.sample_count for f in manifest.fixtures)),
                           condition_coverage=sorted({c for f in manifest.fixtures for c in f.conditions}))
    return _assemble(dataset, configuration_identity(matrix, settings), pipeline_identity(),
                     digest_json(approval.model_dump()) if approval is not None else None, trials, timestamp, cases)


def _live_factory(settings, resources):
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

    backend = SileroVadBackend.from_settings(settings)
    resources.callback(backend.close)
    asr = resources.enter_context(OpenRouterWhisperAdapter(settings))
    corrector = resources.enter_context(OpenRouterInstructionLlmAdapter(settings))
    preprocessing = AudioPreprocessingPipeline(AudioNormalizer(settings), AudioEvidenceDetector(settings, backend), SpeechMapBuilder(settings))
    return preprocessing, asr, corrector


def run_live_pilot(root, config_path, approval_path, output, max_asr_calls, settings, *, provider_factory=None):
    __tracebackhide__ = True
    try:
        manifest, matrix, approval, _, maximum = preflight_pilot(root, config_path, approval_path, output, max_asr_calls, settings)
        report = run_pilot(manifest, root, matrix, settings, provider_factory or _live_factory,
                           max_asr_calls=maximum, trials=approval.trials, approval=approval)
        again = preflight_pilot(root, config_path, approval_path, output, max_asr_calls, settings)
        require(again[:3] == (manifest, matrix, approval), "pilot post-inference identity")
        _exclusive_bytes(output, serialize_pilot_report(report))
        return report
    except CancelledError:
        raise
    except Exception as error:
        traceback.clear_frames(error.__traceback__)
    raise EvaluationError("pilot live evaluation unavailable") from None


def main(argv=None):
    parser = argparse.ArgumentParser(description="Generate a non-approved pilot scope draft, or compare report scope")
    commands = parser.add_subparsers(dest="command", required=True)
    scope = commands.add_parser("scope")
    for name in ("transcription-root", "configuration", "output"):
        scope.add_argument(f"--{name}", type=Path, required=True)
    scope.add_argument("--max-calls", type=int, required=True)
    scope.add_argument("--trials", type=int, default=1)
    compare = commands.add_parser("compare-scope")
    compare.add_argument("previous", type=Path)
    compare.add_argument("current", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "scope":
            from sme_meeting_ai.core.config import load_settings

            settings = load_settings(env_file=None)
            draft = approval_draft(args.transcription_root, args.configuration, settings,
                                   max_asr_calls=args.max_calls, trials=args.trials)
            validate_output_path(args.output, args.transcription_root, [args.configuration, settings.audio_vad_model_path])
            _exclusive_bytes(args.output, canonical_json(draft).encode())
            result = {"status": "REVIEW_REQUIRED", "manifest_sha256": draft["manifest_sha256"], "approved": False}
        else:
            reports = [read_document(path)[1] for path in (args.previous, args.current)]
            for report in reports:
                serialize_pilot_report(report)
            result = compare_scope(*reports)
        print(canonical_json(result), end="")
        return 0
    except (OSError, ValueError, TypeError):
        print(canonical_json({"status": "INVALID", "error": "pilot command unavailable"}), end="")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
