"""Optional explicit local replay; normal CI uses synthetic regressions instead."""

import json
import os
from collections import Counter
from pathlib import Path

import pytest

from .saved_reconciliation_replay import difference, replay, union, write_report


def _key(identity):
    return identity["chunk_id"], identity["segment_index"], tuple(identity["interval"])


def _exclusive_or_identical(path, report):
    if path.exists():
        assert json.loads(path.read_text()) == report
    else:
        write_report(path, report)


def test_explicit_saved_observations_keep_wording_timing_coverage_and_uncertainty():
    names = ("SME_RECONCILIATION_REPLAY_RUN", "SME_RECONCILIATION_REPLAY_BASELINE", "SME_RECONCILIATION_REPLAY_OUTPUT")
    if not any(os.environ.get(name) for name in names):
        pytest.skip("private evidence replay requires explicit local paths")
    assert all(os.environ.get(name) for name in names)
    run, baseline, output = (Path(os.environ[name]) for name in names)
    before = json.loads(baseline.read_text())
    after = replay(run)
    assert before["input_sha256"] == after["input_sha256"]
    assert before["known_observation_count"] == after["known_observation_count"]
    assert before["unavailable_raw_wording_count"] == after["unavailable_raw_wording_count"]
    assert after["word_timing_observation_count"] == 0
    original = {_key(s["selected"]): s for s in before["segments"]}
    selected = {_key(s["selected"]): s for s in after["segments"]}
    assert selected.keys() <= original.keys()
    assert all(s["text"] == original[key]["text"] for key, s in selected.items())
    removed = original.keys() - selected.keys()
    assert removed
    for key in removed:
        representing = [s for s in after["segments"] if key in {_key(i) for i in s["alternatives"]}]
        assert representing
        assert not difference([original[key]["selected"]["interval"]],
                              [s["selected"]["interval"] for s in representing])
    assert after["canonical_timestamp_union_unchanged"]
    assert after["new_uncovered_intervals"] == []
    assert before["canonical_timestamp_union_samples"] == after["canonical_timestamp_union_samples"]
    assert before["missing_speech_intervals"] == after["missing_speech_intervals"]
    assert before["missing_speech_samples"] == after["missing_speech_samples"]
    assert after["conflicting_observations"] <= before["conflicting_observations"]

    # These operator observations live beside the private baseline, not in Git.
    # Report unmet acceptance explicitly rather than claiming a passing acoustic
    # test just because the engine's conservative contracts pass.
    cases = json.loads((baseline.parent / "review_cases.json").read_text())
    case_results = []
    for case in cases:
        retained = tuple((i["chunk_id"], i["segment_index"]) for i in case["retain"])
        redundant = tuple((i["chunk_id"], i["segment_index"]) for i in case["redundant"])
        selected_ids = {(key[0], key[1]) for key in selected}
        assert set(retained) <= selected_ids
        remaining = set(redundant) & selected_ids
        case_results.append({"id": case["id"], "verification": case["verification"],
                             "resolved": not remaining, "redundant_observations_remaining": len(remaining)})

    keys = ("segment_count", "consecutive_overlap_candidates", "intersection_over_one_second",
            "prior_end_minus_next_start_over_one_second", "redundant_observations", "conflicting_observations",
            "ambiguous_observations", "ambiguity_interval_samples", "canonical_timestamp_union_samples",
            "missing_speech_samples", "relationship_counts")
    comparison = {
        "scope": after["scope"],
        "before": {key: before[key] for key in keys},
        "after": {key: after[key] for key in keys},
        "removed_observations": [original[key]["selected"] for key in sorted(removed)],
        "new_uncovered_intervals": after["new_uncovered_intervals"],
        "all_existing_missing_intervals_preserved": True,
        "original_missing_interval_count": len(after["missing_speech_intervals"]),
        "gap_triage": {
            "timestamp_boundary_adjacent_unverified": sum(g["timestamp_boundary_adjacent"] for g in after["gaps"]),
            "internal_acoustic_gap_unverified": sum(not g["timestamp_boundary_adjacent"] for g in after["gaps"]),
            "classification_counts": dict(Counter(g["classification"] for g in after["gaps"])),
            "internal_intervals": [g["interval"] for g in after["gaps"] if not g["timestamp_boundary_adjacent"]],
            "largest_intervals": sorted(after["missing_speech_intervals"], key=lambda i: i[1] - i[0], reverse=True)[:2],
            "minimum_duration_samples": min(b - a for a, b in after["missing_speech_intervals"]),
            "maximum_duration_samples": max(b - a for a, b in after["missing_speech_intervals"]),
        },
        "operator_verified_cases": case_results,
        "confirmed_duplicate_groups_before": len(case_results),
        "confirmed_duplicate_groups_after": sum(not c["resolved"] for c in case_results),
        "acceptance_met": all(c["resolved"] for c in case_results),
        "independent_word_omission_rate": after["word_omission_rate"],
        "private_recording_false_deletion_rate": after["false_deletion_rate"],
        "integrity": "all selected wording and intervals borrowed unchanged; all removed observations retained as alternatives",
        "engine_sha256_before": before["engine_sha256"], "engine_sha256_after": after["engine_sha256"],
    }
    suffix = after["engine_sha256"][:12]
    _exclusive_or_identical(output / f"after-{suffix}.json", after)
    _exclusive_or_identical(output / f"comparison-{suffix}.json", comparison)
    print("\nOFFLINE_EVIDENCE_COMPARISON " + json.dumps(comparison, ensure_ascii=False))
    # The union assertion above is deliberately exact down to one sample.
    assert union(s["selected"]["interval"] for s in before["segments"]) == union(
        s["selected"]["interval"] for s in after["segments"])
