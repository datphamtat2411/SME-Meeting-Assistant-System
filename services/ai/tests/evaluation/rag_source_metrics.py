"""Score observed retrieval ranks against independently labeled source revisions.

No provider calls, raw meeting text or synthetic quality claims. The input
observations are collected by an approved live run; this module only scores them.
"""
import argparse
import hashlib
import json
import math
import re
from pathlib import Path


def _unique(values):
    if not isinstance(values, list) or any(
        not isinstance(value, str) or not value.strip() for value in values
    ):
        raise ValueError("Expected a list of nonempty opaque source keys")
    if len(values) != len(set(values)):
        raise ValueError("Duplicate source key")
    return set(values)


def _cases(rows):
    if not isinstance(rows, list) or not rows:
        raise ValueError("Expected nonempty cases")
    indexed = {}
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("Invalid case")
        case_id = row.get("case_id")
        if not isinstance(case_id, str) or not case_id or case_id in indexed:
            raise ValueError("Missing or duplicate case identity")
        indexed[case_id] = row
    return indexed


def score(manifest, observations, *, manifest_sha256, k):
    """Binary source-level metrics; duplicate chunks collapse to source rank.

    Source keys must include meeting, type, source ID and revision. Eligible
    sources are a separately labeled authorization/currentness set. Inspect
    every returned rank, not merely top K, for unauthorized or stale evidence.
    """
    if type(k) is not int or k < 1:
        raise ValueError("K must be a positive integer")
    if not re.fullmatch(r"[0-9a-f]{64}", manifest_sha256):
        raise ValueError("Invalid manifest digest")
    if (
        manifest.get("schema_version") != 1
        or manifest.get("annotation_origin") != "independent-human"
        or manifest.get("privacy_approved") is not True
        or not isinstance(manifest.get("dataset_version"), str)
        or not manifest["dataset_version"].strip()
    ):
        raise ValueError("Independent approved versioned labels required")
    if (
        observations.get("schema_version") != 1
        or observations.get("manifest_sha256") != manifest_sha256
        or not re.fullmatch(r"[0-9a-f]{40}", observations.get("candidate_sha", ""))
        or not isinstance(observations.get("runtime_id"), str)
        or not observations["runtime_id"].strip()
        or not isinstance(observations.get("retrieval_config"), str)
        or not observations["retrieval_config"].strip()
    ):
        raise ValueError("Observation provenance does not match labels")
    labels = _cases(manifest.get("cases"))
    observed = _cases(observations.get("cases"))
    if labels.keys() != observed.keys():
        raise ValueError("Every labeled case requires exactly one observation")
    scores = []
    no_answer = []
    violations = 0
    for case_id, label in labels.items():
        relevant = _unique(label.get("relevant_sources"))
        eligible = _unique(label.get("eligible_sources"))
        if not relevant <= eligible:
            raise ValueError("Relevant evidence must be eligible")
        raw = observed[case_id].get("ranked_sources")
        if not isinstance(raw, list) or any(
            not isinstance(value, str) or not value.strip() for value in raw
        ):
            raise ValueError("Invalid observed rank list")
        # Repeated chunks from the same source cannot inflate source recall.
        ranked = list(dict.fromkeys(raw))
        violations += int(any(source not in eligible for source in ranked))
        if not relevant:
            no_answer.append(not ranked)
            continue
        hits = [int(source in relevant) for source in ranked[:k]]
        dcg = sum(hit / math.log2(rank + 2) for rank, hit in enumerate(hits))
        ideal = sum(1 / math.log2(rank + 2) for rank in range(min(k, len(relevant))))
        first = next((rank for rank, hit in enumerate(hits, 1) if hit), None)
        scores.append({
            "recall_at_k": sum(hits) / len(relevant),
            "precision_at_k": sum(hits) / k,
            "mrr_at_k": 0.0 if first is None else 1 / first,
            "ndcg_at_k": dcg / ideal,
        })
    metrics = {
        metric: sum(row[metric] for row in scores) / len(scores) if scores else None
        for metric in ("recall_at_k", "precision_at_k", "mrr_at_k", "ndcg_at_k")
    }
    return {
        "schema_version": 1,
        "candidate_sha": observations["candidate_sha"],
        "manifest_sha256": manifest_sha256,
        "dataset_version": manifest["dataset_version"],
        "runtime_id": observations["runtime_id"],
        "retrieval_config": observations["retrieval_config"],
        "k": k,
        "case_count": len(labels),
        "answerable_count": len(scores),
        "no_answer_count": len(no_answer),
        "no_evidence_rate": sum(no_answer) / len(no_answer) if no_answer else None,
        "ineligible_source_cases": violations,
        "eligibility_gate_passed": violations == 0,
        "ranking_metrics": metrics,
    }


def _reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--observations", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--k", type=int, default=5)
    args = parser.parse_args()
    label_bytes = args.manifest.read_bytes()
    manifest = json.loads(label_bytes, object_pairs_hook=_reject_duplicate_keys)
    observations = json.loads(
        args.observations.read_bytes(), object_pairs_hook=_reject_duplicate_keys
    )
    report = score(
        manifest, observations, manifest_sha256=hashlib.sha256(label_bytes).hexdigest(), k=args.k
    )
    # Never replace an input file or an earlier report.
    with args.output.open("x", encoding="utf-8") as output:
        json.dump(report, output, ensure_ascii=False, indent=2, allow_nan=False)
        output.write("\n")
    return 0 if report["eligibility_gate_passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
