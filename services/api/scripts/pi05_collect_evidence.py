#!/usr/bin/env python3
"""PI-05 deterministic acceptance evidence from real Surefire testcase outcomes.

This collector never manufactures PASS from a class name, a green build, or a
skipped test. Cross-process live scenarios are tracked separately as NOT_RUN.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import UTC, datetime
from pathlib import Path
from xml.etree import ElementTree as ET

# Exact Java test METHOD identities, not merely a class-wide build outcome.
SCENARIOS = {
    "PI05-001-access-revocation": [
        "Pi05CrossModuleAcceptanceTests.meetingMembershipRevocationBlocksAssistantHistoryAndExportAccessTogether",
        "AssistantHttpIntegrationTests.reauthorizationAfterAiWorkPreventsRevokedContentDelivery",
    ],
    "PI05-002-transcript-to-knowledge": [
        "CrossModuleRevisionConsistencyIntegrationTests.transcriptCorrectionInvalidatesDerivedEvidenceWithoutDestroyingOfficialHistory",
        "TranscriptReviewRevisionGuardIntegrationTests.twoConcurrentSpeakerMappingsUsingSameTranscriptRevisionCannotBothWin",
    ],
    "PI05-003-room-atomicity": [
        "MeetingRoomLifecycleIntegrationTests.realConcurrentHttpScheduleOnlyOneOverlappingBookingCommits",
        "MeetingRoomLifecycleIntegrationTests.cancellationReleasesRoomAllowsReuseAndDoesNotDeleteMeeting",
    ],
    "PI05-004-proposal-authority": [
        "ActionItemProposalHandoffIntegrationTests.supersededClaimAndStolenTokenCannotReachCanonicalSink",
        "IntelligenceResultIngestionIntegrationTests.finalAcceptanceAiProposalRequiresHumanConfirmationAndRetainsProvenance",
    ],
    "PI05-005-export-revocation-freshness": [
        "ExportAccessHttpIntegrationTests.permissionRemovalAndInactiveActorImmediatelyBlockNewCapability",
        "ExportAccessHttpIntegrationTests.sourceRevisionChangeMakesHistoricalReadyExportStaleWithoutMutation",
        "ExportJobIntegrationTests.transientArtifactFailureNeverMarksReadyAndRetriesWithSamePinnedIntake",
    ],
    "PI05-006-assistant-idempotency": [
        "AssistantHttpIntegrationTests.successfulSubmissionIsDurableIdempotentAndScopeBound",
        "AssistantHttpIntegrationTests.sourceRevisionChangeBetweenVerificationAndCommitFailsClosed",
    ],
    "PI05-007-reconciliation-inventory": [
        "KnowledgeIndexingWorkerIntegrationTests.missingWorkWithUnattributedVectorsRequiresManualReviewNotBlindReindex",
        "KnowledgeIndexingWorkerIntegrationTests.reconciliationInventoriesUntrackedQdrantPointsWithoutBlindDeletion",
        "KnowledgeIndexingWorkerIntegrationTests.failedOrAcknowledgedLifecycleWithRemainingPointsCanBeRepairedAgain",
    ],
    "PI05-008-generation-readiness": [
        "KnowledgeIndexingWorkerIntegrationTests.generationActivationRequiresCompleteWorkAndRetainsRollbackGeneration",
        "KnowledgeIndexingWorkerIntegrationTests.newlyIneligibleIndexedSourceCannotQualifyCandidateForActivation",
        "KnowledgeIndexingWorkerIntegrationTests.pagedVectorInventoryPersistsCursorAndCompletesOnlyAfterLastPage",
    ],
    "PI05-009-worker-recovery": [
        "OutboxLeaseIntegrationTests.expiredLeaseIsRecoveredButLateConfirmCannotMarkNewClaimPublished",
        "ProcessingStageFencingIntegrationTests.manualRetryCreatesNewStageClaimAndFencesOldWorker",
    ],
}

LIVE_SCENARIOS = [
    "PI05-L01-full-transcript-to-assistant",
    "PI05-L02-revision-replacement-and-retrieval",
    "PI05-L03-membership-revocation-during-generation",
    "PI05-L04-broker-duplicate-recovery",
    "PI05-L05-worker-lease-and-restart",
    "PI05-L06-qdrant-outage-and-reconciliation",
    "PI05-L07-orphan-and-missing-work-inventory",
    "PI05-L08-generation-activation-and-rollback",
    "PI05-L09-export-freshness-and-download-auth",
    "PI05-L10-room-conflict-and-notification",
]


def read_results(report_dir: Path) -> dict[str, list[str]]:
    observed: dict[str, list[str]] = {}
    for file in sorted(report_dir.glob("TEST-*.xml")):
        root = ET.parse(file).getroot()
        if root.tag not in {"testsuite", "testsuites"}:
            raise ValueError(f"Unsupported Surefire XML root: {file.name}")
        for case in root.iter("testcase"):
            classname = case.get("classname", "")
            name = case.get("name", "")
            if not classname or not name:
                raise ValueError(f"Case identity is incomplete in {file.name}")
            key = f"{classname.rsplit('.', 1)[-1]}.{name}"
            markers = [item.tag for item in case if item.tag in {"skipped", "failure", "error"}]
            state = "FAIL" if any(m in {"failure", "error"} for m in markers) else (
                "BLOCKED" if "skipped" in markers else "PASS"
            )
            observed.setdefault(key, []).append(state)
    return observed


def evaluate(observed: dict[str, list[str]]) -> dict[str, dict]:
    result: dict[str, dict] = {}
    for scenario, required in SCENARIOS.items():
        cases = {}
        for identity in required:
            values = observed.get(identity, [])
            cases[identity] = "NOT_RUN" if not values else (
                values[0] if len(values) == 1 else "FAIL"
            )
        states = set(cases.values())
        status = (
            "FAIL" if "FAIL" in states else
            "BLOCKED" if "BLOCKED" in states else
            "NOT_RUN" if "NOT_RUN" in states else "PASS"
        )
        result[scenario] = {"status": status, "kind": "DETERMINISTIC_POSTGRES",
                            "testcases": cases}
    return result


def build_evidence(report_dir: Path) -> dict:
    observed = read_results(report_dir)
    result = evaluate(observed)
    sha = os.environ.get("GITHUB_SHA", "")
    return {
        "schemaVersion": "1.0",
        "task": "PI-05",
        "createdAt": datetime.now(UTC).isoformat(),
        "sourceCommit": sha if re.fullmatch(r"[0-9a-f]{40}", sha) else None,
        "githubRunId": os.environ.get("GITHUB_RUN_ID") or None,
        "environment": "CI_POSTGRES_WITH_CONTROLLED_EXTERNAL_BOUNDARIES",
        "deterministic": result,
        "live": {scenario: {"status": "NOT_RUN", "kind": "LIVE_INFRASTRUCTURE",
                           "reason": "Requires isolated real-process evidence"}
                 for scenario in LIVE_SCENARIOS},
        "summary": {s: sum(v["status"] == s for v in result.values())
                    for s in ("PASS", "FAIL", "BLOCKED", "NOT_RUN")},
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reports", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args(argv)
    try:
        evidence = build_evidence(args.reports)
    except (OSError, ET.ParseError, ValueError) as error:
        print(f"PI05_EVIDENCE_INVALID: {type(error).__name__}", file=sys.stderr)
        return 2
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(evidence, ensure_ascii=False, indent=2,
                                      sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(evidence["summary"], sort_keys=True))
    if args.strict and any(v["status"] != "PASS" for v in evidence["deterministic"].values()):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
