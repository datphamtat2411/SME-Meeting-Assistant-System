import copy

import pytest

from .rag_source_metrics import score


def fixture():
    digest = "a" * 64
    manifest = {
        "schema_version": 1,
        "annotation_origin": "independent-human",
        "privacy_approved": True,
        "dataset_version": "unit-fixture",
        "cases": [
            {
                "case_id": "answerable",
                "relevant_sources": ["meeting-a:DECISION:d1:3", "meeting-a:TRANSCRIPT:t1:7"],
                "eligible_sources": [
                    "meeting-a:DECISION:d1:3",
                    "meeting-a:TRANSCRIPT:t1:7",
                    "meeting-a:SUMMARY:s1:1",
                ],
            },
            {"case_id": "unknown", "relevant_sources": [], "eligible_sources": []},
        ],
    }
    observations = {
        "schema_version": 1,
        "candidate_sha": "b" * 40,
        "manifest_sha256": digest,
        "runtime_id": "unit-fixture",
        "retrieval_config": "test-config",
        "cases": [
            {
                "case_id": "answerable",
                "ranked_sources": [
                    "meeting-a:SUMMARY:s1:1",
                    "meeting-a:DECISION:d1:3",
                    "meeting-a:DECISION:d1:3",
                    "meeting-a:TRANSCRIPT:t1:7",
                ],
            },
            {"case_id": "unknown", "ranked_sources": []},
        ],
    }
    return manifest, observations, digest


def test_source_ranking_does_not_reward_duplicate_chunks_or_abstention():
    manifest, observations, digest = fixture()
    result = score(manifest, observations, manifest_sha256=digest, k=2)
    assert result["ranking_metrics"]["recall_at_k"] == 0.5
    assert result["ranking_metrics"]["precision_at_k"] == 0.5
    assert result["ranking_metrics"]["mrr_at_k"] == 0.5
    assert result["ranking_metrics"]["ndcg_at_k"] == pytest.approx(0.386852807)
    assert result["answerable_count"] == 1
    assert result["no_answer_count"] == 1
    assert result["no_evidence_rate"] == 1
    assert result["eligibility_gate_passed"] is True


def test_ineligible_source_detected_even_below_top_k():
    manifest, observations, digest = fixture()
    observations["cases"][0]["ranked_sources"].append("meeting-a:TRANSCRIPT:t1:6")
    observations["cases"][1]["ranked_sources"].append("meeting-b:DECISION:d2:1")
    result = score(manifest, observations, manifest_sha256=digest, k=1)
    assert result["ineligible_source_cases"] == 2
    assert result["eligibility_gate_passed"] is False
    assert result["no_evidence_rate"] == 0


@pytest.mark.parametrize("damage", ["missing", "duplicate", "digest", "labels", "relevance"])
def test_rejects_incomplete_or_incompatible_observations(damage):
    manifest, observations, digest = fixture()
    if damage == "missing":
        observations["cases"].pop()
    elif damage == "duplicate":
        observations["cases"].append(copy.deepcopy(observations["cases"][0]))
    elif damage == "digest":
        observations["manifest_sha256"] = "c" * 64
    elif damage == "labels":
        manifest["annotation_origin"] = "model-output"
    else:
        manifest["cases"][0]["relevant_sources"].append("forbidden")
    with pytest.raises(ValueError):
        score(manifest, observations, manifest_sha256=digest, k=5)


def test_no_answer_only_dataset_does_not_manufacture_ranking_accuracy():
    manifest, observations, digest = fixture()
    manifest["cases"].pop(0)
    observations["cases"].pop(0)
    result = score(manifest, observations, manifest_sha256=digest, k=5)
    assert all(metric is None for metric in result["ranking_metrics"].values())
