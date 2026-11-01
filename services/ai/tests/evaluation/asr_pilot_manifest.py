"""Explicit partial-dataset policy and atomic synchronization of private manifests.

Full-production Manifest validation is deliberately not overridden or bypassed.
Only independent reference files select recordings; directory audio never does.
"""

import argparse
import hashlib
import os
import tempfile
from pathlib import Path
from types import SimpleNamespace
from typing import Literal

from pydantic import Field, model_validator

from .support import (
    Contract,
    Digest,
    EvaluationError,
    Fixture,
    Gate,
    Identifier,
    Manifest,
    Positive,
    TranscriptionGate,
    _normalization_integrity,
    canonical_json,
    digest_json,
    load_manifest,
    require,
    verify_source,
)
from .transcription_support import (
    GroundTruthReference,
    external_file,
    load_reference,
    read_document,
    require_transcription_manifest,
)


class PilotManifest(Contract):
    """Schema-2 fields with pilot completeness, never production completeness."""

    schema_version: Literal[2]
    dataset_id: Identifier
    dataset_version: Identifier
    privacy_approved: bool
    legal_approved: bool
    approval_version: Identifier
    labeling_guideline_version: Identifier
    long_audio_min_samples: Positive
    fixtures: list[Fixture] = Field(min_length=2)
    quality_gates: list[Gate] = Field(default_factory=list)
    transcription_quality_gates: list[TranscriptionGate] = Field(default_factory=list)
    manifest_sha256: Digest = "0" * 64

    @model_validator(mode="after")
    def pilot_scope(self):
        require(len({f.fixture_id for f in self.fixtures}) == len(self.fixtures), "unique pilot fixtures")
        require(len({f.source_sha256 for f in self.fixtures}) == len(self.fixtures), "distinct pilot sources")
        speech = [f for f in self.fixtures if any(label.label == "speech" for label in f.labels)]
        require(len({f.source_sha256 for f in speech}) >= 2, "two independent speech recordings")
        for fixture in self.fixtures:
            require(fixture.kind == "recording" and fixture.language == "vi"
                    and fixture.annotation_origin == "independent-human" and fixture.reference is not None,
                    "independent pilot references")
            require("long-audio" not in fixture.conditions or fixture.sample_count >= self.long_audio_min_samples,
                    "long control duration")
        require(len({g.metric for g in self.quality_gates}) == len(self.quality_gates), "unique pilot gates")
        require(len({(g.stage, g.metric) for g in self.transcription_quality_gates})
                == len(self.transcription_quality_gates), "unique pilot transcription gates")
        return self


def external_path(path):
    require(isinstance(path, Path), "explicit external path")
    repository = Path(__file__).resolve().parents[4]
    require(not path.resolve().is_relative_to(repository)
            and not any(p.is_symlink() for p in (path, *path.parents)), "external nonsymlink path")


def load_pilot_manifest(root):
    try:
        path = external_file(root, "manifest.json")
        raw, document = read_document(path)
        require(isinstance(document, dict) and "manifest_sha256" not in document, "pilot document")
        return PilotManifest.model_validate({**document, "manifest_sha256": hashlib.sha256(raw).hexdigest()})
    except (OSError, ValueError, TypeError):
        raise EvaluationError("pilot manifest invalid or unavailable") from None


def validate_pilot_manifest(root, manifest=None, *, require_approval=False):
    """Local validation includes PCM counts and boundary anchors before inference."""
    try:
        external_path(root)
        manifest = load_pilot_manifest(root) if manifest is None else PilotManifest.model_validate(manifest)
        if require_approval:
            require(manifest.privacy_approved and manifest.legal_approved, "pilot private approval")
        for fixture in manifest.fixtures:
            path = verify_source(root, fixture)
            _normalization_integrity(fixture, SimpleNamespace(path=path, sample_count=fixture.sample_count,
                                                            sample_rate_hz=16000, channels=1, sample_format="s16"))
            load_reference(root, fixture)
        return manifest
    except (OSError, ValueError, TypeError):
        raise EvaluationError("pilot assets, references or scope invalid") from None


def manifest_summary(manifest, *, missing=()):
    full = False
    try:
        production = Manifest.model_validate(manifest.model_dump())
        require_transcription_manifest(production)
        full = True
    except ValueError:
        pass
    return {
        "evaluation_scope": "pilot", "schema_valid": True,
        "eligible_fixture_count": len(manifest.fixtures),
        "manifest_sha256": manifest.manifest_sha256,
        "fixture_ids": [f.fixture_id for f in manifest.fixtures],
        "reference_digests": {f.fixture_id: f.reference.sha256 for f in manifest.fixtures},
        "source_digests": {f.fixture_id: f.source_sha256 for f in manifest.fixtures},
        "annotation_digests": {f.fixture_id: digest_json(f.model_dump(include={"labels", "anchors", "sample_count",
                                                                             "annotation_version", "annotation_origin"}))
                               for f in manifest.fixtures},
        "missing_human_references": sorted(missing),
        "condition_coverage": sorted({c for f in manifest.fixtures for c in f.conditions}),
        "source_integrity": "VERIFIED", "reference_integrity": "VERIFIED",
        "privacy_approved": manifest.privacy_approved, "legal_approved": manifest.legal_approved,
        "pilot_ready": manifest.privacy_approved and manifest.legal_approved,
        "pilot_scope_valid": True, "full_cutover_ready": False,
        "full_transcription_manifest_valid": full,
        "production_readiness": "NOT_ASSESSED",
    }


def _candidate(preprocessing_manifest, root):
    reviewed = load_manifest(preprocessing_manifest.parent, manifest_path=preprocessing_manifest)
    existing_path = root / "manifest.json"
    previous = load_pilot_manifest(root) if existing_path.exists() else None
    approved = {f.fixture_id: f for f in reviewed.fixtures}
    references = root / "references"
    require(references.is_dir() and not references.is_symlink(), "reference directory")
    selected = {}
    for path in sorted(references.iterdir()):
        if path.suffix != ".json":
            continue
        external_file(root, path.relative_to(root).as_posix())
        raw, document = read_document(path)
        reference = GroundTruthReference.model_validate(document)
        identity = reference.fixture_id
        require(path.name == f"{identity}.json" and identity in approved and identity not in selected,
                "known unique reference identity")
        item = approved[identity].model_dump()
        item["reference"] = dict(schema_version=1, path=path.relative_to(root).as_posix(),
                                 sha256=hashlib.sha256(raw).hexdigest(), reference_version=reference.reference_version,
                                 origin="independent-human")
        selected[identity] = Fixture.model_validate(item)
    header = previous if previous is not None else reviewed
    document = header.model_dump(exclude={"manifest_sha256", "fixtures"})
    document.update(schema_version=2, fixtures=[selected[key].model_dump() for key in sorted(selected)])
    if previous is None:
        document["dataset_id"] = root.name
    # Approval applies only to exactly unchanged bytes/metadata. Never inherit
    # preprocessing approval as authorization to route new transcripts externally.
    if previous is None or document != previous.model_dump(exclude={"manifest_sha256"}):
        document.update(privacy_approved=False, legal_approved=False, approval_version="pending-review")
    raw = canonical_json(document).encode()
    manifest = PilotManifest.model_validate({**document, "manifest_sha256": hashlib.sha256(raw).hexdigest()})
    validate_pilot_manifest(root, manifest)
    return raw, manifest, sorted(set(approved) - set(selected))


def _exclusive_bytes(path, raw):
    external_path(path)
    with path.open("xb") as destination:
        destination.write(raw)
        destination.flush()
        os.fsync(destination.fileno())


def sync_manifest(preprocessing_manifest, root, *, output=None, write=False):
    """Dry run by default. A changed replacement snapshots exact prior bytes."""
    try:
        root, preprocessing_manifest = root.absolute(), preprocessing_manifest.absolute()
        output = (output if output is not None else root / "manifest.json").absolute()
        for path in (root, preprocessing_manifest, output):
            external_path(path)
        require(root.is_dir() and output == root / "manifest.json"
                and not preprocessing_manifest.resolve().is_relative_to(root.resolve()), "stable manifest destination")
        require(not output.exists() or output.stat().st_nlink == 1, "manifest hardlink")
        before = output.read_bytes() if output.exists() else None
        raw, manifest, missing = _candidate(preprocessing_manifest, root)
        if write and raw != before:
            if before is not None:
                snapshot = root / f"manifest.{hashlib.sha256(before).hexdigest()}.json"
                external_path(snapshot)
                if snapshot.exists():
                    require(snapshot.stat().st_nlink == 1 and snapshot.read_bytes() == before, "snapshot integrity")
                else:
                    _exclusive_bytes(snapshot, before)
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(dir=root, prefix=".manifest-", delete=False) as destination:
                    temporary = Path(destination.name)
                    destination.write(raw)
                    destination.flush()
                    os.fsync(destination.fileno())
                external_path(output)
                require((output.read_bytes() if output.exists() else None) == before, "concurrent manifest change")
                require(not output.exists() or output.stat().st_nlink == 1, "manifest hardlink")
                os.replace(temporary, output)
                directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)
        return {**manifest_summary(manifest, missing=missing), "changed": raw != before, "written": bool(write)}
    except (OSError, ValueError, TypeError):
        raise EvaluationError("pilot synchronization invalid; reviewed inputs and safe destination required") from None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    sync = commands.add_parser("sync")
    sync.add_argument("--preprocessing-manifest", type=Path, required=True)
    sync.add_argument("--transcription-root", type=Path, required=True)
    sync.add_argument("--output", type=Path)
    mode = sync.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--write", action="store_true")
    validate = commands.add_parser("validate")
    validate.add_argument("--transcription-root", type=Path, required=True)
    validate.add_argument("--preprocessing-manifest", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "sync":
            result = sync_manifest(args.preprocessing_manifest, args.transcription_root, output=args.output, write=args.write)
        else:
            manifest = validate_pilot_manifest(args.transcription_root)
            missing = []
            if args.preprocessing_manifest is not None:
                reviewed = load_manifest(args.preprocessing_manifest.parent, manifest_path=args.preprocessing_manifest)
                missing = {f.fixture_id for f in reviewed.fixtures} - {f.fixture_id for f in manifest.fixtures}
            result = manifest_summary(manifest, missing=missing)
            result["missing_reference_inventory"] = "REVIEWED_MANIFEST" if args.preprocessing_manifest else "NOT_REQUESTED"
        print(canonical_json(result), end="")
        return 0
    except (OSError, ValueError, TypeError):
        print(canonical_json({"status": "INVALID", "error": "pilot local validation failed"}), end="")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
