"""Private, single-recording diarization smoke evidence; no implicit live calls."""

import argparse
import hashlib
import logging
import math
import os
import re
import stat
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass
from fractions import Fraction
from itertools import groupby
from pathlib import Path

from sme_meeting_ai.audio import AudioNormalizer, AudioSource
from sme_meeting_ai.audio.errors import AudioProcessingError
from sme_meeting_ai.core.config import ConfigurationError, Settings, load_settings
from sme_meeting_ai.diarization.contract import (
    MAX_TURNS,
    ContractValidationError,
    _model,
)
from sme_meeting_ai.diarization.models import (
    DiarizationError,
    DiarizationErrorCategory,
    DiarizationResult,
)
from sme_meeting_ai.diarization.service import _validate_evidence
from sme_meeting_ai.providers.replicate_diarization import (
    _MAX_UPLOAD_BYTES,
    ReplicateDiarizationAdapter,
)

from .support import canonical_json, digest_json

REPOSITORY = Path(__file__).resolve().parents[4]
TOOL_VERSION = "diarization-smoke-1"
_SUFFIXES = {"wav": ".wav", "mp3": ".mp3", "mov,mp4,m4a,3gp,3g2,mj2": ".m4a", "matroska,webm": ".webm"}


class SmokeError(ValueError):
    """A category-only local failure; never include paths or provider details."""


def _require(condition, category):
    if not condition:
        raise SmokeError(category)


@dataclass(frozen=True, slots=True)
class Inputs:
    audio: Path
    expected_sha256: str
    output: Path
    expected_speaker_count: int | None = None


@dataclass(frozen=True, slots=True)
class Preflight:
    audio_sha256: str
    audio_duration_ms: int
    duration_seconds: Fraction
    size_bytes: int
    container: str
    codec: str


def _absolute_path(value):
    _require(isinstance(value, (str, Path)) and bool(str(value)), "path")
    path = Path(value)
    _require(".." not in path.parts, "path")
    path = path.absolute()
    _require(not any(part.is_symlink() for part in (path, *path.parents)), "path")
    return path


def _output_path(value):
    path = _absolute_path(value)
    try:
        _require(not path.resolve().is_relative_to(REPOSITORY), "output")
        # Other Git worktrees/repositories are also unsuitable private destinations.
        _require(not any((parent / ".git").exists() for parent in (path, *path.parents)), "output")
        _require(not path.exists() and not path.is_symlink(), "output")
        parent = path.parent
        info = parent.stat()
        _require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid()
                 and not info.st_mode & 0o022, "output")
    except OSError:
        raise SmokeError("output") from None
    return path


def _validate_configuration(settings):
    _require(isinstance(settings, Settings) and settings.diarization_enabled, "configuration")
    try:
        _model(settings.diarization_model)
    except ContractValidationError:
        raise SmokeError("configuration") from None
    _require(re.fullmatch(r"konieshadow/speaker-diarization:[a-f0-9]{64}", settings.diarization_model) is not None
             and 0 < settings.audio_max_input_bytes <= 2_147_483_648
             and math.isfinite(settings.audio_max_duration_seconds) and 0 < settings.audio_max_duration_seconds <= 14400
             and math.isfinite(settings.audio_probe_timeout_seconds) and 0 < settings.audio_probe_timeout_seconds <= 120
             and math.isfinite(settings.diarization_timeout_seconds) and 0 < settings.diarization_timeout_seconds <= 3600,
             "configuration")


def _credential_configured(settings):
    secret = settings.replicate_api_token
    token = secret.get_secret_value() if secret else ""
    return bool(token) and all(33 <= ord(char) <= 126 for char in token)


def _read_source(path, max_bytes, destination=None):
    """Hash bounded regular-file bytes, optionally writing a private snapshot."""
    descriptor = None
    try:
        path = _absolute_path(path)
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        before = os.fstat(descriptor)
        _require(stat.S_ISREG(before.st_mode) and before.st_mode & 0o444 and 0 < before.st_size <= max_bytes, "source")
        digest = hashlib.sha256()
        total = 0
        with os.fdopen(descriptor, "rb") as source:
            descriptor = None
            while chunk := source.read(1024 * 1024):
                total += len(chunk)
                _require(total <= max_bytes, "source")
                digest.update(chunk)
                if destination is not None:
                    destination.write(chunk)
            after = os.fstat(source.fileno())
        _require(total == before.st_size and (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns,
                 before.st_ctime_ns) == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns,
                                          after.st_ctime_ns), "source")
        return digest.hexdigest(), total
    except (OSError, ValueError):
        raise SmokeError("source") from None
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _probe(path, settings):
    try:
        probe = AudioNormalizer(settings).probe(AudioSource("diarization-smoke", path))
        duration = probe.declared_duration
        _require(isinstance(duration, Fraction) and 0 < duration <= Fraction(str(settings.audio_max_duration_seconds)),
                 "duration")
        _require(probe.container in _SUFFIXES, "audio")
        # The provider rounds timestamps to nearest ms, half up. Ceil the
        # independently probed endpoint instead: at most <1 ms of endpoint slack.
        milliseconds = (duration.numerator * 1000 + duration.denominator - 1) // duration.denominator
        _require(milliseconds > 0, "duration")
        return probe, duration, milliseconds
    except (AudioProcessingError, OSError, ValueError, TypeError, AttributeError):
        raise SmokeError("audio_or_duration") from None


def preflight(inputs, settings):
    """Validate local inputs only; does not instantiate a provider or write output."""
    try:
        _require(isinstance(inputs, Inputs), "input")
        _validate_configuration(settings)
        _require(isinstance(inputs.expected_sha256, str)
                 and re.fullmatch(r"[a-f0-9]{64}", inputs.expected_sha256) is not None, "digest")
        _require(inputs.expected_speaker_count is None or type(inputs.expected_speaker_count) is int
                 and 1 <= inputs.expected_speaker_count <= 1000, "expected_speakers")
        _output_path(inputs.output)
        source = _absolute_path(inputs.audio)
        limit = min(_MAX_UPLOAD_BYTES, settings.audio_max_input_bytes)
        digest, size = _read_source(source, limit)
        _require(digest == inputs.expected_sha256, "digest")
        probe, duration, milliseconds = _probe(source, settings)
        _require(_read_source(source, limit) == (digest, size), "source_integrity")
        return Preflight(digest, milliseconds, duration, size, probe.container, probe.codec)
    except SmokeError:
        raise
    except (OSError, ValueError, TypeError, AttributeError):
        raise SmokeError("input") from None


def analyze_result(result, duration_ms, *, expected_model_id=None):
    """Validate existing domain evidence, then sweep half-open integer intervals."""
    try:
        _require(type(duration_ms) is int and duration_ms > 0, "malformed_output")
        _require(isinstance(result, DiarizationResult), "malformed_output")
        _validate_evidence(result, duration_ms)
        _model(result.model_id)
        _require(len(result.turns) <= MAX_TURNS
                 and (expected_model_id is None or result.model_id == expected_model_id), "malformed_output")
        _require(all(left.start_ms <= right.start_ms for left, right in zip(result.turns, result.turns[1:])),
                 "malformed_output")
    except (DiarizationError, ContractValidationError, SmokeError, AttributeError, TypeError, ValueError):
        raise SmokeError("malformed_output") from None

    counts = {label: 0 for label in result.speakers}
    durations = dict.fromkeys(result.speakers, 0)
    events = []
    for turn in result.turns:
        counts[turn.speaker_label] += 1
        events.extend(((turn.start_ms, turn.speaker_label, 1), (turn.end_ms, turn.speaker_label, -1)))
    active = dict.fromkeys(result.speakers, 0)
    began = {}
    distinct = covered = overlap = 0
    previous = 0
    for timestamp, grouped in groupby(sorted(events), key=lambda event: event[0]):
        span = timestamp - previous
        if distinct:
            covered += span
        if distinct >= 2:
            overlap += span
        changes = {}
        for _, label, delta in grouped:
            changes[label] = changes.get(label, 0) + delta
        for label, delta in changes.items():
            before = active[label]
            after = before + delta
            if before == 0 and after > 0:
                began[label] = timestamp
                distinct += 1
            elif before > 0 and after == 0:
                durations[label] += timestamp - began.pop(label)
                distinct -= 1
            active[label] = after
        previous = timestamp
    return {
        "model_id": result.model_id,
        "speakers": list(result.speakers),
        "turns": [{"start_ms": turn.start_ms, "end_ms": turn.end_ms, "speaker_label": turn.speaker_label}
                  for turn in result.turns],
        "structural_status": "VALID" if result.turns else "VALID_EMPTY",
        "metrics": {
            "audio_duration_ms": duration_ms,
            "speaker_count": len(result.speakers), "turn_count": len(result.turns),
            "speaker_duration_ms": durations, "speaker_turn_counts": counts,
            "speech_union_duration_ms": covered, "uncovered_duration_ms": duration_ms - covered,
            "overlap_duration_ms": overlap,
        },
    }


def _configuration(settings):
    return {
        "provider": "replicate", "model_id": settings.diarization_model,
        "diarization_enabled": settings.diarization_enabled,
        "provider_approval_configured": settings.diarization_worker_provider_approved,
        "provider_timeout_seconds": settings.diarization_timeout_seconds,
        "max_upload_bytes": min(_MAX_UPLOAD_BYTES, settings.audio_max_input_bytes),
        "max_audio_duration_seconds": settings.audio_max_duration_seconds,
        "probe_timeout_seconds": settings.audio_probe_timeout_seconds,
        "speaker_hints": {"num_speakers": None, "min_speakers": None, "max_speakers": None},
    }


def _revision():
    try:
        completed = subprocess.run(
            ["/usr/bin/git", "rev-parse", "--verify", "HEAD"], cwd=REPOSITORY,
            env={"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "GIT_CONFIG_NOSYSTEM": "1"},
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=3, check=True,
        )
        value = completed.stdout.decode("ascii").strip()
        return value if re.fullmatch(r"(?:[a-f0-9]{40}|[a-f0-9]{64})", value) else None
    except (OSError, ValueError, UnicodeError, subprocess.SubprocessError):
        return None


def _report(inputs, checked, settings, provider_kind):
    configuration = _configuration(settings)
    return {
        "schema_version": 1, "evaluation_tool_version": TOOL_VERSION,
        "evaluation_scope": "manual-smoke", "speaker_quality_status": "NOT_ESTABLISHED",
        "production_readiness": "NOT_ASSESSED", "manual_review_status": "PENDING",
        "annotation_checks": "UNAVAILABLE", "source_revision": _revision(),
        "audio": {"sha256": checked.audio_sha256, "duration_ms": checked.audio_duration_ms,
                  "duration_seconds": {"numerator": checked.duration_seconds.numerator,
                                       "denominator": checked.duration_seconds.denominator},
                  "duration_basis": "ffprobe_container_metadata_ceil_ms",
                  "size_bytes": checked.size_bytes, "container": checked.container, "codec": checked.codec},
        "expected_speaker_count": inputs.expected_speaker_count,
        "model_id": settings.diarization_model,
        "configuration": configuration, "configuration_sha256": digest_json(configuration),
        "execution": {"provider_kind": provider_kind, "status": "FAILED", "failure_category": None,
                      "elapsed_ms": None, "provider_calls": 0, "prediction_count": None},
        "structural_status": "NOT_EVALUATED", "speakers": None, "turns": None, "metrics": None,
    }


def _timestamp(milliseconds):
    seconds, fraction = divmod(milliseconds, 1000)
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    return (f"{hours:02d}:{minutes:02d}:{seconds:02d}.{fraction:03d}" if hours
            else f"{minutes:02d}:{seconds:02d}.{fraction:03d}")


def _timeline(report):
    lines = ["Start\tEnd\tSpeaker\tDuration_seconds"]
    for turn in report["turns"]:
        duration = turn["end_ms"] - turn["start_ms"]
        lines.append(f"{_timestamp(turn['start_ms'])}\t{_timestamp(turn['end_ms'])}\t{turn['speaker_label']}\t"
                     f"{duration // 1000}.{duration % 1000:03d}")
    return "\n".join(lines) + "\n"


def _review(report):
    expected = report["expected_speaker_count"]
    return f"""# Manual diarization review — NOT COMPLETED

- Audio SHA-256: `{report['audio']['sha256']}`
- Audio duration: {report['audio']['duration_ms']} ms
- Expected speaker count (review context): {expected if expected is not None else 'unknown'}
- Detected speaker clusters: {report['metrics']['speaker_count']}
- Reviewer / date: ____________________

Listen to the original recording alongside `timeline.tsv`; labels are anonymous clusters.

- Speaker clustering errors observed? ____________________
- Speaker transitions plausible? ____________________
- Clear false speaker transitions? ____________________
- Substantial speaker regions missing? ____________________
- Notable issues and timestamps: ____________________
- Final qualitative assessment: ____________________

No DER/JER was calculated. This template is not a completed or approved review.
"""


def _write_private(path, content):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as output:
        output.write(content)


def _snapshot(source, destination, checked, settings):
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as output:
        digest, size = _read_source(source, min(_MAX_UPLOAD_BYTES, settings.audio_max_input_bytes), output)
    _require((digest, size) == (checked.audio_sha256, checked.size_bytes), "source_integrity")
    probe, duration, milliseconds = _probe(destination, settings)
    _require((duration, milliseconds, probe.container, probe.codec) ==
             (checked.duration_seconds, checked.audio_duration_ms, checked.container, checked.codec), "source_integrity")


@contextmanager
def _quiet_provider_logging():
    # Child client loggers may include signed URLs, even under custom logging
    # configuration. This standalone run restores the caller's logging threshold.
    previous = logging.root.manager.disable
    try:
        logging.disable(logging.CRITICAL)
        yield
    finally:
        logging.disable(previous)


def run(inputs, settings, *, live_opt_in, authorize_upload, max_provider_calls, provider_factory=None):
    """Make at most one adapter call and write a new private run directory."""
    _require(live_opt_in is True and authorize_upload is True and type(max_provider_calls) is int
             and max_provider_calls == 1, "live_authorization")
    _validate_configuration(settings)
    _require(settings.diarization_worker_provider_approved and _credential_configured(settings), "provider_approval")
    checked = preflight(inputs, settings)
    output = _output_path(inputs.output)
    try:
        output.mkdir(mode=0o700)
        # Correct even if a restrictive/atypical umask was in effect.
        output.chmod(0o700)
    except OSError:
        raise SmokeError("output") from None
    report = _report(inputs, checked, settings, "replicate" if provider_factory is None else "injected")
    execution = report["execution"]
    try:
        with tempfile.TemporaryDirectory(prefix=".audio-", dir=output) as directory:
            snapshot = Path(directory) / ("audio" + _SUFFIXES[checked.container])
            _snapshot(inputs.audio, snapshot, checked, settings)
            factory = ReplicateDiarizationAdapter if provider_factory is None else provider_factory
            provider = factory(settings)
            execution["provider_calls"] = 1
            start = time.monotonic_ns()
            try:
                with _quiet_provider_logging():
                    evidence = provider.diarize(snapshot)
            finally:
                execution["elapsed_ms"] = (time.monotonic_ns() - start) // 1_000_000
            execution["status"] = "COMPLETED"
            if _read_source(snapshot, min(_MAX_UPLOAD_BYTES, settings.audio_max_input_bytes)) != (
                checked.audio_sha256, checked.size_bytes
            ):
                raise SmokeError("source_integrity")
            try:
                analysis = analyze_result(evidence, checked.audio_duration_ms, expected_model_id=settings.diarization_model)
            except SmokeError:
                report["structural_status"] = "INVALID"
                raise
            report.update(analysis)
    except DiarizationError as error:
        execution["failure_category"] = (error.category.value if isinstance(error.category, DiarizationErrorCategory)
                                         else "processing_failed")
    except SmokeError as error:
        execution["failure_category"] = ("malformed_output" if str(error) == "malformed_output" else "source_integrity")
    except Exception:
        execution["failure_category"] = "processing_failed"
    try:
        if report["structural_status"] in ("VALID", "VALID_EMPTY"):
            _write_private(output / "timeline.tsv", _timeline(report))
            _write_private(output / "manual-review.md", _review(report))
        # Written last: a completed report never points to unfinished review artifacts.
        _write_private(output / "report.json", canonical_json(report))
    except (OSError, ValueError, TypeError):
        raise SmokeError("output") from None
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description="Private, single-recording diarization smoke evaluation")
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("preflight", "run"):
        command = commands.add_parser(name)
        command.add_argument("--audio", required=True, type=Path)
        command.add_argument("--expected-sha256", required=True)
        command.add_argument("--output", required=True, type=Path, help="New run directory, outside Git")
        command.add_argument("--expected-speakers", type=int, default=None, help="Review context only; not a model hint")
        if name == "run":
            command.add_argument("--max-provider-calls", required=True, type=int, choices=[1])
            command.add_argument("--authorize-external-upload", action="store_true")
    args = parser.parse_args(argv)
    inputs = Inputs(args.audio, args.expected_sha256, args.output, args.expected_speakers)
    try:
        settings = load_settings(env_file=None)
        if args.command == "preflight":
            checked = preflight(inputs, settings)
            configuration = _configuration(settings)
            print(canonical_json({
                "audio_sha256": checked.audio_sha256, "audio_duration_ms": checked.audio_duration_ms,
                "expected_speaker_count": inputs.expected_speaker_count, "model_id": settings.diarization_model,
                "configuration_sha256": digest_json(configuration), "provider_calls": 0,
                "provider_approval_configured": settings.diarization_worker_provider_approved,
                "credential_configured": _credential_configured(settings),
            }), end="")
            return 0
        report = run(inputs, settings, live_opt_in=os.environ.get("AI_RUN_REPLICATE_LIVE") == "1",
                     authorize_upload=args.authorize_external_upload, max_provider_calls=args.max_provider_calls)
        print(canonical_json({"provider_status": report["execution"]["status"],
                              "failure_category": report["execution"]["failure_category"],
                              "structural_status": report["structural_status"]}), end="")
        return 0 if report["structural_status"] in ("VALID", "VALID_EMPTY") else 1
    except (SmokeError, ConfigurationError, OSError, ValueError, TypeError):
        print("diarization smoke: input, configuration, authorization or output invalid", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
