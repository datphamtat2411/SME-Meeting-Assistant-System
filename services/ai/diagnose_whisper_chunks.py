"""One-shot ASR diagnostic for SME Meeting Assistant.

Run in services/ai with the project uv environment:
  uv run --env-file .env python diagnose_whisper_chunks.py

Uses the real preprocessing and exact chunk extraction, with no recovery,
reconciliation, GPT correction, saving, or printing transcript/audio/provider bodies.
Reissues up to three OpenRouter ASR requests, so costs and data transfer apply.
"""

from __future__ import annotations

import argparse
import sys
from contextlib import ExitStack
from fractions import Fraction
from pathlib import Path

from sme_meeting_ai.audio import (
    AudioEvidenceDetector,
    AudioNormalizer,
    AudioSource,
    SileroVadBackend,
    SpeechMapBuilder,
)
from sme_meeting_ai.core.config import load_settings
from sme_meeting_ai.pipeline import AudioPreprocessingPipeline
from sme_meeting_ai.providers.openrouter_whisper import (
    OpenRouterWhisperAdapter,
    _number,
)
from sme_meeting_ai.transcription.asr import AsrError
from sme_meeting_ai.transcription.chunk_execution import (
    _extract_audio,
    _translate_candidate,
)
from sme_meeting_ai.transcription.chunk_planning import (
    SpeechAwareAsrChunkPlanner,
)

RATE = 16000
AUDIO = Path.home() / (
    "sme-private/reference/vietnamese-preprocessing-v1/"
    "audio/vi-continuous-speech-01.wav"
)


def safe_response_diagnostics(data: object, duration: Fraction) -> dict[str, object]:
    """Read metadata types and timestamp numbers, never expose transcript strings."""
    out: dict[str, object] = {"object_type": type(data).__name__}
    if not isinstance(data, dict):
        return out
    out["top_level_text_is_string"] = isinstance(data.get("text"), str)
    out["task_valid"] = data.get("task", "transcribe") == "transcribe"
    out["usage_type"] = type(data.get("usage")).__name__
    out["provider_field_present"] = "provider" in data
    segments = data.get("segments")
    out["segments_type"] = type(segments).__name__
    if not isinstance(segments, list):
        return out
    out["segments_count"] = len(segments)
    out["segment_text_missing"] = sum(
        not isinstance(s, dict) or not isinstance(s.get("text"), str)
        for s in segments
    )
    out["empty_or_reversed_intervals"] = 0
    out["overlapping_or_reversed_sequence"] = 0
    out["out_of_request_bounds"] = 0
    out["off_grid_16k_boundaries"] = 0
    out["invalid_timestamp_types"] = 0
    out["max_end_overrun_samples"] = 0.0
    previous = Fraction(0)
    for segment in segments:
        if not isinstance(segment, dict):
            out["invalid_timestamp_types"] += 1
            continue
        try:
            start = _number(segment["start"])
            end = _number(segment["end"])
        except (KeyError, TypeError, ValueError, OverflowError):
            out["invalid_timestamp_types"] += 1
            continue
        if start >= end:
            out["empty_or_reversed_intervals"] += 1
        if start < previous:
            out["overlapping_or_reversed_sequence"] += 1
        if start < 0 or end > duration:
            out["out_of_request_bounds"] += 1
            if end > duration:
                out["max_end_overrun_samples"] = max(
                    out["max_end_overrun_samples"], float((end - duration) * RATE)
                )
        out["off_grid_16k_boundaries"] += int((start * RATE).denominator != 1)
        out["off_grid_16k_boundaries"] += int((end * RATE).denominator != 1)
        previous = end
    return out


class DiagnosingWhisper(OpenRouterWhisperAdapter):
    def __init__(self, settings):
        super().__init__(settings)
        self.details: dict[str, dict[str, object]] = {}

    def _normalize(self, data: object, chunk):
        # Only frames from the adapter itself. Trace captures no arguments,
        # exception messages, provider bodies, transcript text, or credentials.
        observations: list[str] = []

        def trace(frame, event, arg):
            if event == "exception" and frame.f_code.co_filename.endswith(
                "openrouter_whisper.py"
            ):
                if len(observations) < 8:
                    observations.append(
                        f"{frame.f_code.co_name}:{frame.f_lineno}"
                    )
            return trace

        audit = safe_response_diagnostics(data, chunk.duration)
        previous_trace = sys.gettrace()
        sys.settrace(trace)
        try:
            candidate = super()._normalize(data, chunk)
        except Exception:
            audit["normalization"] = "FAIL"
            audit["validation_frames"] = tuple(observations)
            self.details[chunk.chunk_id] = audit
            raise
        finally:
            sys.settrace(previous_trace)
        audit["normalization"] = "PASS"
        audit["validation_frames"] = tuple(observations)
        self.details[chunk.chunk_id] = audit
        return candidate


def main() -> int:
    parser = argparse.ArgumentParser(description="Diagnose malformed Whisper ASR chunk results")
    parser.add_argument("--chunks", nargs="+", type=int, default=[1, 3, 4])
    parser.add_argument("--audio", type=Path, default=AUDIO)
    args = parser.parse_args()
    s = load_settings(env_file=None)
    if not args.audio.is_file():
        parser.error("Audio reference file is unavailable")
    if not s.openrouter_api_key:
        parser.error("OPENROUTER_API_KEY not configured")
    print("MODEL:", s.audio_asr_model)
    print("AUDIO:", "local approved reference")
    print("CORRECTION/RECOVERY:", "OFF / OFF")
    print("PRIVACY:", "no audio/transcript/response body printed or saved")

    with ExitStack() as stack:
        vad = SileroVadBackend.from_settings(s)
        stack.callback(vad.close)
        whisper = stack.enter_context(DiagnosingWhisper(s))
        preprocess = AudioPreprocessingPipeline(
            AudioNormalizer(s),
            AudioEvidenceDetector(s, vad),
            SpeechMapBuilder(s),
        )
        outcome = stack.enter_context(
            preprocess.run(AudioSource("asr-investigation-001", args.audio))
        )
        if outcome.result is None:
            print("PREPROCESSING FAILED:", outcome.failure)
            return 1
        plan = SpeechAwareAsrChunkPlanner(s).plan(outcome.result)
        print("CHUNKS IN PLAN:", len(plan.chunks))
        print("SELECTED CHUNKS:", args.chunks)
        print()

        for index in args.chunks:
            if index < 0 or index >= len(plan.chunks):
                print("INVALID CHUNK INDEX:", index)
                return 2
            planned = plan.chunks[index]
            chunk = _extract_audio(
                planned, outcome.result.normalized_artifact,
                s.audio_asr_max_payload_bytes,
            )
            print("===", planned.chunk_id, "===")
            print("duration_s:", round(float(chunk.duration), 4))
            try:
                candidate = whisper.transcribe(chunk)
            except AsrError as exc:
                print("adapter:", exc.category.value)
                print("normalization_trace:", whisper.details.get(chunk.chunk_id, "not reached"))
                print()
                continue
            print("adapter: PASS")
            print("normalized_segments:", len(candidate.segments))
            print("resolved_provider:",
                  candidate.provenance.upstream_provider or "not reported")
            off_grid = sum(
                (seg.start * RATE).denominator != 1
                for seg in candidate.segments
            ) + sum(
                (seg.end * RATE).denominator != 1
                for seg in candidate.segments
            )
            print("off_grid_16k_boundaries:", off_grid)
            try:
                translated = _translate_candidate(candidate, planned)
                print("timeline_translation: PASS")
                print("translated_segments:", len(translated))
            except AsrError as exc:
                print("timeline_translation:", exc.category.value)
            print()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
