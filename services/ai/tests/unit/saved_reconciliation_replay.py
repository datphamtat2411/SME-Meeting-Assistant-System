"""Explicit offline reconstruction of saved *selected* observations, never ASR.

The old five-file export discarded raw wording. Join canonical text to a unique
numeric source identity only; leave unavailable raw text empty and count it. This
is a declared evidence subset, not a fabricated provider cache or a WER reference.
No provider, model, audio decoder, environment credentials or network is used.
"""

import argparse
import hashlib
import json
import re
from collections import Counter
from dataclasses import asdict
from fractions import Fraction
from pathlib import Path

from sme_meeting_ai.audio.models import SampleInterval
from sme_meeting_ai.core.config import Settings
from sme_meeting_ai.transcription import reconciliation as engine
from sme_meeting_ai.transcription.asr import (
    AsrCandidate,
    AsrProvenance,
    AsrQualityMetadata,
    AsrSegment,
    AsrSegmentQuality,
    AsrUsage,
)
from sme_meeting_ai.transcription.chunk_execution import (
    AsrChunkResult,
    _translate_candidate,
)
from sme_meeting_ai.transcription.chunk_planning import AsrChunk, ChunkBoundaryReason

_ROW = re.compile(r"\[([0-9.]+)s - ([0-9.]+)s\] (.*)")


def union(intervals):
    output = []
    for start, end in sorted(intervals):
        if output and start <= output[-1][1]:
            output[-1][1] = max(output[-1][1], end)
        else:
            output.append([start, end])
    return output


def difference(left, right):
    output = []
    right = union(right)
    index = 0
    for start, end in union(left):
        while index < len(right) and right[index][1] <= start:
            index += 1
        scan = index
        while scan < len(right) and right[scan][0] < end:
            a, b = right[scan]
            if start < a:
                output.append([start, a])
            start = max(start, b)
            scan += 1
        if start < end:
            output.append([start, end])
    return output


def _transcript(path):
    output = []
    for line in path.read_text().splitlines():
        match = _ROW.fullmatch(line)
        if match is None:
            raise ValueError("unrecognized saved transcript row")
        start, end, text = match.groups()
        if not text.startswith("[MISSING_TRANSCRIPT:"):
            output.append((start, end, text))
    return output


def load_observations(run):
    diagnostics = json.loads((run / "05_pipeline_diagnostics.json").read_text())
    info = json.loads((run / "04_run_info.json").read_text())
    rows = _transcript(run / "01_whisper_before_llm.txt")
    corrected = _transcript(run / "02_after_llm.txt")
    selected = diagnostics["selected_segments"]
    if len(rows) != len(corrected) or len(rows) != len(selected):
        raise ValueError("inconsistent saved handoff")
    rechecks = {r["chunk_id"]: r for r in diagnostics["decoder_rechecks"]}
    observations = {}
    chunks = []
    previous = ChunkBoundaryReason.TIMELINE_START
    for ordinal, row in enumerate(diagnostics["plan"]):
        end_reason = ChunkBoundaryReason(row["end_reason"])
        chunk = AsrChunk(row["id"], ordinal, SampleInterval(*row["core"]), SampleInterval(*row["request"]),
                         previous, end_reason)
        chunks.append(chunk)
        previous = end_reason
        if chunk.chunk_id in rechecks:
            actual, = (a for a in rechecks[chunk.chunk_id]["attempts"] if a["selected"])
            offset, end = actual["interval"]
        else:
            offset, end = row["request"]
        observation, = (o for o in diagnostics["provider_observations"]
                        if o["chunk_id"] == chunk.chunk_id and o["request_samples"] == end - offset)
        for index, item in enumerate(observation["segments"]):
            observations[(chunk.chunk_id, index)] = {
                "interval": [offset + item["start_sample"], offset + item["end_sample"]],
                "metadata": item, "text": None,
            }
    for original, selection in zip(rows, selected, strict=True):
        start, end, text = original
        interval = selection["interval"]
        # Presentation rounds to centiseconds; all replay timing uses the exact
        # integer diagnostics, never timestamps reconstructed from the text file.
        if (abs(Fraction(start) * 16000 - interval[0]) > 80
                or abs(Fraction(end) * 16000 - interval[1]) > 80):
            raise ValueError("inconsistent saved interval")
        matches = [o for (source, _), o in observations.items()
                   if source in selection["sources"] and o["interval"] == interval
                   and o["metadata"]["text_characters"] == len(text)
                   and o["metadata"]["text_tokens"] == len(text.split())]
        if len(matches) != 1 or matches[0]["text"] is not None:
            raise ValueError("source wording cannot be uniquely reconstructed")
        matches[0]["text"] = text
    results = []
    provenance = AsrProvenance("openrouter", "openai/whisper-large-v3")
    for chunk in chunks:
        segments = []
        for (source, _), observation in observations.items():
            if source != chunk.chunk_id:
                continue
            start, end = observation["interval"]
            quality = AsrSegmentQuality(**{k: observation["metadata"].get(k) for k in (
                "confidence", "average_log_probability", "compression_ratio", "no_speech_probability",
            )})
            segments.append(AsrSegment(Fraction(start - chunk.request_interval.start_sample, 16000),
                                       Fraction(end - chunk.request_interval.start_sample, 16000),
                                       observation["text"] or "", quality))
        candidate = AsrCandidate(" ".join(s.text for s in segments if s.text), tuple(segments),
                                 AsrQualityMetadata(), AsrUsage(), provenance, chunk.chunk_id)
        results.append(AsrChunkResult(chunk, candidate, _translate_candidate(candidate, chunk)))
    return diagnostics, info, tuple(chunks), tuple(results), observations, rows, corrected


def replay(run):
    diagnostics, info, chunks, results, observations, rows, corrected = load_observations(run)
    _, evidence, _ = engine._collect(chunks, results)
    boundary_risk = {index: 1 for index, item in enumerate(evidence)
                     if any(item.interval.start_sample < sample < item.interval.end_sample
                            for sample, reason in ((item.chunk.core_interval.start_sample, item.chunk.start_boundary_reason),
                                                   (item.chunk.core_interval.end_sample, item.chunk.end_boundary_reason))
                            if reason is ChunkBoundaryReason.FORCED_CONTINUOUS_SPEECH)}
    work = engine._Work()
    segments, relationships, redundant, conflicting, ambiguous, many, one = engine._canonical_graph(
        evidence, 2, boundary_risk, work,
    )
    intervals = [[s.interval.start_sample, s.interval.end_sample] for s in segments]
    original_intervals = [s["interval"] for s in diagnostics["selected_segments"]]
    preserved_union = union(intervals) == union(original_intervals)
    uncertain = union([(s.interval.start_sample, s.interval.end_sample) for s in segments
                       if engine.ReconciliationFlag.UNRESOLVED_BOUNDARY in s.flags] +
                      [(i.interval.start_sample, i.interval.end_sample) for r in relationships
                       if r.classification in (engine.OccurrenceRelationship.AMBIGUOUS,
                                               engine.OccurrenceRelationship.PARTIAL_SUPPORT)
                       for i in (*r.left, *r.right)])

    def identity(value):
        return {"chunk_id": value.chunk_id, "segment_index": value.segment_index,
                "interval": [value.interval.start_sample, value.interval.end_sample]}

    pairs = [(a, b) for a, b in zip(segments, segments[1:]) if a.interval.end_sample > b.interval.start_sample]
    return {
        "scope": "selected-observation-reconstruction-not-complete-raw-ASR",
        "source_samples": info["asr_resource_plan"]["source_sample_count"],
        "source_chunks": [asdict(c) for c in chunks],
        "observation_lineage": [{"chunk_id": source, "segment_index": index,
                                 "interval": o["interval"], "provider_metadata": o["metadata"],
                                 "wording_available": o["text"] is not None}
                                for (source, index), o in observations.items()],
        "engine_sha256": hashlib.sha256(Path(engine.__file__).read_bytes()).hexdigest(),
        "alignment_revision": engine._configuration(Settings(
            service_name="offline-replay", service_identity="ai-core", _env_file=None,
            audio_asr_reconciliation_min_shared_tokens=2,
        )),
        "input_sha256": {name: hashlib.sha256((run / name).read_bytes()).hexdigest() for name in (
            "01_whisper_before_llm.txt", "02_after_llm.txt", "03_changes.md", "04_run_info.json", "05_pipeline_diagnostics.json",
        )},
        "known_observation_count": len(evidence),
        "unavailable_raw_wording_count": sum(o["text"] is None for o in observations.values()),
        "word_timing_observation_count": 0,
        "segment_count": len(segments),
        "consecutive_overlap_candidates": len(pairs),
        "intersection_over_one_second": sum(min(a.interval.end_sample, b.interval.end_sample)
                                             - b.interval.start_sample > 16000 for a, b in pairs),
        "prior_end_minus_next_start_over_one_second": sum(a.interval.end_sample - b.interval.start_sample > 16000
                                                          for a, b in pairs),
        "redundant_observations": redundant,
        "conflicting_observations": conflicting,
        "ambiguous_observations": ambiguous,
        "many_to_one_alignments": many, "one_to_many_alignments": one,
        "relationship_counts": dict(Counter(r.classification.value for r in relationships)),
        "ambiguity_interval_samples": sum(b - a for a, b in uncertain),
        "canonical_timestamp_union_samples": sum(b - a for a, b in union(intervals)),
        "canonical_timestamp_union_unchanged": preserved_union,
        "new_uncovered_intervals": difference(original_intervals, intervals),
        "missing_speech_samples": diagnostics["missing_speech_samples"] if preserved_union else None,
        "missing_speech_intervals": diagnostics["missing_speech_intervals"] if preserved_union else None,
        "gaps": diagnostics["quality_summary"]["suspected_gaps"],
        "recovery_reasons": dict(Counter(a["reason"] for a in diagnostics["attempts"])),
        "recovery_accepted": sum(a["admission"] == "accepted" for a in diagnostics["attempts"]),
        "saved_initial_final_equal": diagnostics["initial_canonical"] == diagnostics["final_canonical"],
        "saved_llm_changed_segments": sum(a != b for a, b in zip(rows, corrected, strict=True)),
        "word_omission_rate": "unverified-no-independent-word-reference",
        "false_deletion_rate": "unverified-on-private-recording",
        "segments": [{"selected": identity(s.selected_evidence_id), "text": s.text,
                      "supporting": [identity(i) for i in s.supporting_evidence_ids],
                      "alternatives": [identity(i) for i in s.alternative_evidence_ids],
                      "flags": [f.value for f in s.flags]} for s in segments],
        "relationships": [asdict(r) for r in relationships],
    }


def write_report(path, report):
    # Exclusive, private output; never overwrite a frozen baseline or asset.
    with path.open("x", encoding="utf-8") as stream:
        path.chmod(0o600)
        json.dump(report, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if not args.output.parent.exists():
        args.output.parent.mkdir(mode=0o700)
    report = replay(args.run)
    write_report(args.output, report)
    print(json.dumps({k: v for k, v in report.items() if k not in (
        "segments", "relationships", "gaps", "missing_speech_intervals", "input_sha256",
        "source_chunks", "observation_lineage",
    )}, indent=2))


if __name__ == "__main__":
    main()
