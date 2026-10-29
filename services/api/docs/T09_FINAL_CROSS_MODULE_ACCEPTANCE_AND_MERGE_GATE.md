# T09 — Final Cross-Module Acceptance and Owner-Controlled Merge Gate

**Status: IMPLEMENTATION / CI EVIDENCE ONLY. NO MERGE AUTHORIZATION.** This task is a Draft stacked PR on T08 / PR #49, not a pull request against `develop`. The user expressly requires another personal review even if all checks pass. T09 may not merge, auto-merge, mark any PR ready, or change `develop`.

## 1. Scope, methodology and source of truth

T09 adds **independent final HTTP-to-PostgreSQL acceptance scenarios** and a reviewable release-readiness ledger for the full T01–T08 Room Scheduling chain. T09 has **no production behavior change**, no new endpoint, no migration, no external SMTP delivery claim, and no authorization-policy change. Canonical source evidence: `services/api/docs/T01_*.md` through `T08_*.md`, the current implementation and API tests; requirement anchors are drawn from RE02/RE03/RE04/RE05/RE06/RE08. A green suite supports tested behaviors; it is **not** proof that every normative requirement line has been exhaustively verified.

Five independent acceptance boundaries are implemented in `FinalRoomSchedulingNotificationAcceptanceTests` using real Testcontainers PostgreSQL and separate committed HTTP requests:

1. Catalog room -> Draft + participant -> Schedule -> Add second member -> Remove first -> Reschedule to another room -> Cancel. Check DB reservation history, per-recipient outbox disposition, removal access revocation and safe historical notice.
2. Two separate Meetings share a recipient. Removal and cancellation in one must not supersede the other Meeting's membership invitation or deny access to the other.
3. A conflicting reschedule following a successful new-member invitation must roll back the reservation change and preserve the pending invitation and ETag, without ghost reschedule email.
4. FAILED queued notices are deliberately superseded, while already claimed SENDING handoffs remain untouched; cancellation retains valid new notices. SMTP in-flight race is explicitly not eliminated.
5. An administrator who is not the organizer cannot read or mutate a private Meeting, add/remove participants, or enqueue unauthorized membership email.

Previous T03–T08 suites already exercise database overlap races, cross-module room acceptance, notification retries, deterministic fake SMTP delivery, V1–V8 Flyway upgrades, historical membership, DRAFT vs SCHEDULED policy, and add/remove rollback. T09 must not needlessly duplicate those lower-level tests.

## 2. Evidence matrix

| Requirement area | Normative anchor | Implementation / test evidence | Gate disposition |
| --- | --- | --- | --- |
| Room catalog & deactivation | BR-ROOM-001..006, DB-ROOM-001..004, API-EP-ROOM-001..006 | T01/T04/T05/T06 and T09 room transition tests | Automated evidence; human business policy review pending |
| Meeting lifecycle & versioning | BR-MTG-001..010, BR-MTG-LC-001..017, API-EP-MTG-001..009 | T02/T04/T05/T06 and T09 conflict/ETag rollback | Automated evidence; complete ID-by-ID formal audit not claimed |
| DB reservation exclusivity | BR-SCH-001/002/004/005/006, DB-RSV-001..007, DB-CONC-003..005 | T03 PostgreSQL exclusion/uniqueness, T04 concurrency, T06 full lifecycle, T09 rejected mutation | Automated evidence |
| Membership access & history | BR-PART-001..008, SEC-AZ-001/002/009/010/012, DB-PART-001/002 | T02/T06/T08 and T09 recipient isolation / admin denial | Automated evidence |
| Email outbox & privacy | BR-NOTIF-001..005/007/008, DB-NOTIF-001..005 | T07 V8 SKIPPED, T08 handlers/rollback/SMTP mock, T09 full reconciliation | Automated evidence; real external SMTP validation pending |
| Availability and capacity | BR-SCH-003, BR-ROOM-005, FEAT-ROOM-AVAIL-001/002 | T05 read-only previews, T06 stale preview/capacity warning | Capacity remains *advisory* by policy |
| Auth/account compatibility | BR-NOTIF-002/006/007, RE08 auth/security boundaries | Canonical auth regression tests; T07 reissue + password recovery and worker assertions | Automated evidence |
| Historical migration safety | DB-MIG-001..008, DB-GEN-002 | V1–V8 Flyway scripts unchanged by T09; T07 migration upgrade tests | Automated evidence; production backup/restore not demonstrated |

## 3. Immutable stack and integration baseline

Expected dependency chain: `develop` <- #42 T01 <- #43 T02 <- #44 T03 <- #45 T04 <- #46 T05 <- #47 T06 <- #48 T07 <- #49 T08 <- **T09**. Each PR must be independently reviewed against its immediate predecessor; do not treat the last PR as a replacement for the earlier reviews.

At T09 branch creation (2026-10-29), #42–#49 were open, Draft and unmerged. T08 HEAD `a2a1433ad07633e0488b0fdc8d9f36631769cbdb` had a green [API CI #269](https://github.com/datphamtat2411/SME-Meeting-Assistant-System/actions/runs/40881663052) with **352 tests / 0 failures**. T09 must separately provide CI evidence for its own final head; never reuse prior green as its own verification.

Only `email_deliveries` semantics change in T07/V8; T08/T09 must not edit historical migrations. PostgreSQL remains authoritative for collision and lifecycle. No room booking REST CRUD, new broker, event sourcing, tenant grant, or capacity hard block is introduced.

## 4. Human review decisions / external checks — OPEN

| Review item | Current state | Owner action before any merge |
| --- | --- | --- |
| Manager permission for room catalog | ADMINISTRATOR-only | Confirm or explicitly change policy |
| Capacity and participant overlap | Capacity and participant conflict are advisory; room overlap hard-blocked | Confirm policy and warning UX |
| T07 supersession | SKIPPED terminal delivery state, reason; SENDING cannot be revoked in-flight | Approve semantics and retention/observability |
| T08 participant notices | Only SCHEDULED add/remove triggers separate mail; DRAFT/IN_PROGRESS do not | Approve policy and minimal removal wording |
| Production mail integration | CI tests SMTP through mocked JavaMailSender | Validate real SMTP credentials, deliverability and operational alerts separately |
| External browser/mobile UX | API acceptance covers server only | Manually test client ETags, status errors, booking warnings and email UX |
| Multi-node production behavior | PostgreSQL transaction races covered in tests | Staging load/deployment validation as applicable |
| Historical media-import flow | Not in the room booking API | Keep separate pending product decision |
| Compliance traceability | Requirement anchors mapped to code/test groups | Perform line-by-line compliance audit if formal certification is required |
| Merge readiness | No formal owner approval yet | Owner reviews T01–T09 patches, approves each decision, and explicitly authorizes any future merge |

These open entries are **not automatically software defects**. A green GitHub Actions run cannot close them without real evidence.

## 5. Non-negotiable final checklist

- [ ] Final T09 HEAD full Maven verify passes against PostgreSQL Testcontainers; attach immutable CI URL and exact SHA.
- [ ] Every earlier PR still targets its predecessor and has expected diff; no accidental merges/rebases or legacy PR #5.
- [ ] No failed tests, unreviewed schema edits, or ghost notification intents.
- [ ] Privacy, active-membership access, admin isolation and recipient routing independently reviewed.
- [ ] V1–V8 checksum and upgrade path reviewed; no `flyway repair` or migration rewrite.
- [ ] Owner records explicit decisions for permissions, advisories, notification states and T08 policy.
- [ ] Owner manually validates SMTP integration and client behavior in the intended environment.
- [ ] Owner has personally reviewed the stack and gives **separate, explicit merge authorization**.

**DO NOT MERGE**: All PRs remain Draft even if all automated checks are green. This document deliberately makes no claim of production release readiness.
