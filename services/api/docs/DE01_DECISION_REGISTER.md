# DE-01 — Decisions, Approval Gates, Test Matrix and Handoff

> **Status:** DE-01 ENGINEERING REVIEW PACKAGE DELIVERED; HUMAN SIGN-OFF PENDING. No Product, API, Meeting, Action Items, Media, Security or Operations owner approval is represented as already granted.
>
> **Companions:** DE01_DASHBOARD_EXPORT_CONTRACTS.md; DE01_METRIC_DICTIONARY.md; DE01_API_CONTRACT_EXAMPLES.md.
>
> **Canonical requirement governance:** requirement-docs/RE09-README.md sections 8–14. RE02/03/04/05/06/08 remain authoritative.

## 1. Decision classification

- **INHERITED:** The rule already exists in canonical requirements; no new approval needed to repeat it. A later implementation must satisfy it.
- **SELECTED ENGINEERING DESIGN:** A preferred implementation approach consistent with the baseline; it still needs normal technical review, but does not itself create a new product rule.
- **PROPOSED PRODUCT POLICY:** Not canonical. Needs named human owner approval and corresponding RE04/RE06 changes if it changes business semantics.
- **OPEN TECHNICAL VALIDATION:** Requires repository/compatibility/load/security evidence; approval is blocked until evidence exists.
- **BLOCKED:** A downstream task must not assume this decision has been approved.

## 2. Requirements-derived decisions (INHERITED)

| ID | Binding rule | Authority |
| --- | --- | --- |
| R01 | Exactly six baseline Dashboard/Minutes/Export endpoints, no aliases | RE02 API-EP-DASH-001/002; API-EP-EXP-001..004 |
| R02 | Common API Response, correct HTTP codes, stable client errors and IDs | RE02 API-RESP-*, API-ERR-*, API-STATUS-*, API-DATA-* |
| R03 | Current authorization before returning meeting content and new signed capability; admin/manager role not universal content access | RE08 SEC-AZ-001..014; SEC-OBJ-003..007; RE04 BR-ROLE-003/004 |
| R04 | Dashboard derived from canonical state, overdue from BR-ACT-010, AI failure not meeting failure, documented denominator | RE04 BR-DASH-001..005; RE06 FEAT-DASH-* |
| R05 | Proposed decisions/work separate from official, preserve transcript uncertainty and historical attribution | RE04 BR-EXP-001..004; BR-DEC-*; BR-ACT-*; RE06 FEAT-EXP-MINUTES-* |
| R06 | Persisted exports use meeting_exports metadata and private object storage, not PostgreSQL BLOB; stale exports not labeled current | RE05 DB-EXP-001..003; RE03 ARCH-EXP-001..004; RE08 SEC-OBJ-* |
| R07 | Status for meeting_exports is PENDING, GENERATING, READY or FAILED; Markdown and PDF supported | RE05 section 26; RE06 FEAT-EXP-FILE-001..004 |

## 3. Proposed decisions — blocked until sign-off

| ID | Concern | Preferred proposal | Reject/avoid | Owner | Gate |
| --- | --- | --- | --- | --- | --- |
| D01 | Manager meeting attribution | Explicit, stable organization-scoped meeting ownership/read policy, not current organizer department inferred as meeting ownership | JOIN user current primary_org_unit_id and assume full meeting access | Product + Security + Meeting/User Organization | **BLOCKS DE-04** |
| D02 | Dashboard cohort time axis | Instant-based [from,to), current-state cohort clearly labeled, choose meeting occurrence/scheduled timestamp per field | Mix creation, schedule and occurrence dates without declaring axis | Product + API | **BLOCKS DE-03/04** |
| D03 | Completion rate | Current official OPEN+IN_PROGRESS+DONE denominator, DONE numerator, null for zero denominator; cancellation/proposals excluded | Unqualified "success rate", convert zero denominator to 100% | Product + API; update RE04/RE06 | **BLOCKS DE-04** |
| D04 | Deadline business timezone | Reuse authoritative Action Items due DATE + approved configured business ZoneId; local today comparison is strictly due_date < today | UTC timestamp comparison of DATE, third independent overdue implementation | Action Items + API | **BLOCKS DE-03/04** |
| D05 | Management aggregate disclosure | Authorize each metric population; determine small-cell suppression/coarsening requirement | Show unauthorized small-group sensitive existence via counts | Security + Product | **BLOCKS DE-04** |
| D06 | Current processing status metrics | Distinguish latest effective meeting-level job outcome from total failed job attempts; choose what is returned | A failed historical retry makes every ended meeting "failed" | Media + Meeting Intelligence + Product | **BLOCKS DE-03/04** |
| D07 | Personal horizon and list bounds | Bounded upcoming/recent list with explicit horizon/lookback caps and stable sort | Unbounded lists, hidden hardcoded business windows | Product + API | **BLOCKS DE-03** |
| D08 | Minutes completeness and proposed AI inclusion | Main minutes include available official/confirmed content; optional AI proposals only separately labeled, explicit unavailable/warning sections | Treat missing Summary as empty official Summary; silently promote proposals | Product + Meeting Intelligence + Action Items | **BLOCKS DE-05** |
| D09 | Export admission on incomplete minutes | Distinguish previewable incomplete Minutes from eligible export; approve whether labeled DRAFT export is supported | Generate an official-looking complete PDF from incomplete AI output | Product + Security + API | **BLOCKS DE-09** |
| D10 | Export idempotency/replay window | Idempotency-Key scoped to principal + operation + body hash; replay after current auth; key conflict 409; finite retained window | Duplicate expensive jobs after HTTP timeout; cross-principal replay | API + Security | **BLOCKS DE-06/09** |
| D11 | Artifact retention, provenance and freshness | Immutable source snapshot pinned for each attempt, separate source/template/artifact hashes; approved retention and cleanup | Hash only updated_at; overwrite current PDF; destructive cleanup without reference check | Product + Security + Operations + API | **BLOCKS DE-06/10/11** |
| D12 | API payload DTO names/error codes | Candidate fields and error codes from contract examples, reviewed and frozen in Task Spec/OpenAPI | Controllers independently invent formats, enum codes and error messages | API + Web QA liaison | **BLOCKS DE-03/04/05/09/10** |
| D13 | Resource limits/performance acceptance | Explicit maximum meeting period, response page lengths, export size, queue capacity and measurable SLOs set from benchmark evidence | Unbounded queries or invented "performance passed" claim | API + Operations + Product | **BLOCKS DE-12 final gate** |
| D14 | Export concurrency/worker runtime | PostgreSQL durable claim/lease/fencing and bounded worker; validate against existing outbox/job conventions | In-memory queue or immediate success, new broker merely for prestige | API + Operations | **BLOCKS DE-06/09** |

**Important:** This document records preferences, not human approvals. Do not mark any row APPROVED by inference. Product policy decisions D01–D09 generally need changes in their canonical owner document when they establish new business semantics. Technical decisions D10–D14 need design review and may also require RE updates if they change client-visible behavior or security.

## 4. Explicit current implementation gaps

1. **Manager-to-meeting ownership gap:** meeting table baseline has organizer_user_id, not a first-class meeting org_unit_id. manager_scope_units alone is not meeting membership/content authority. Define authoritative reporting population before DE-04 query design.
2. **Overdue divergence risk:** Action Items domain currently has a business-zone configuration and an ActionItemView helper that compares with UTC. DE-02 must reconcile with the owning Action Items service rather than fork the business clock. Do not call the implementation discrepancy "approved rule".
3. **Processing-data availability:** API ingests validated AI-derived outputs but missing external AI producer coverage may mean no Summary/Decision rows in integration fixtures. DE-05 must distinguish absent processing from no approved decisions.
4. **Snapshot atomicity:** Consistent PostgreSQL source reads and S3 snapshot persistence cannot share a transaction. DE-05/06/09 must specify how job intent points to an immutable verified snapshot and how failed writes are reconciled.
5. **Privacy of export metadata:** An export's requester identity is not sufficient authorization for content access. A currently revoked participant cannot get fresh artifact download even if they created the export earlier.

These are planning constraints; the DE-01 docs do not alter code to conceal or "fix" them.

## 5. Acceptance case matrix (contract-level; runtime ownership follows task IDs)

| Test ID | Given | Expected invariant | Implementing task |
| --- | --- | --- | --- |
| A01 | Employee vs another department private meeting | Dashboard neither lists nor counts unauthorized meeting details | DE-02/03 |
| A02 | Manager belongs to overlapping authorized scopes | Same meeting counted once, never twice | DE-02/04 |
| A03 | Administrator without meeting membership | No content in Minutes/Export by role alone | DE-05/10 |
| A04 | Meeting ENDED and AI failed | Execution=ENDED; AI failure separate | DE-03/04 |
| A05 | Action due yesterday / today / null in business zone | yesterday overdue (if eligible), today/null not overdue | DE-02/03/04 |
| A06 | Proposed AI Action and Decision | No proposed content counted as official confirmed work; if included in Minutes, explicitly labeled | DE-03/04/05 |
| A07 | No eligible official action items | Rate undefined/null per approved denominator, not 100% | DE-04 |
| A08 | Summary absent or processing incomplete | Explicit unavailability/warnings, no fabricated Summary | DE-05 |
| A09 | Source changes during Minutes read | One internally consistent snapshot, no mixed revisions | DE-05 |
| A10 | Same export idempotency key replay | Same intent/ID after auth; different payload -> conflict | DE-06/09 |
| A11 | Concurrent worker claims | At most one valid fenced publication, recoverable timeout | DE-06/09 |
| A12 | SQL commit succeeds and S3 fails; reverse failure | Explicit non-READY or reconcile, no false READY | DE-09/10/11 |
| A13 | Permission revoked after READY | New signed capability is denied | DE-10 |
| A14 | Summary revision changes after READY | Historical file remains authentic and marked source-stale | DE-11 |
| A15 | Long Vietnamese, Unicode, untrusted markup | Markdown and PDF preserve content safely, no external content resolution | DE-07/08/12 |
| A16 | Scope changes during repeated request | Each new request evaluated against current session+role scope | DE-02/03/04/10 |

## 6. DE-01 documentation evidence checklist

- [x] Inspect exact develop HEAD and current feature boundaries.
- [x] Index all six canonical RE02 endpoints without route duplication.
- [x] Provide authorization matrix with admin/manager restrictions.
- [x] Define field-level metric dictionary including cohort, time, scope and denominator proposals.
- [x] Provide canonical/proposed/uncertain Minutes source distinction.
- [x] Record idempotency, export state, snapshot, access capability and freshness proposals.
- [x] Provide candidate payload examples and stable errors for review.
- [x] Provide risk register, owner approvals and downstream acceptance mapping.
- [x] Keep all DE-01 changes documentation-only.
- [ ] Product/API sign-off for D01/D02/D03/D07/D08/D09/D12 and required canonical RE changes.
- [ ] Action Items/Media sign-off for D04/D06.
- [ ] Security sign-off for D01/D05/D09/D10/D11.
- [ ] Operations/API sign-off for D11/D13/D14.
- [ ] DE-02/03/04/05 PLANs review approved current versions.

The completed checkboxes are documentation completion claims only. Remaining unchecked items are **real approval gates**, not tests that the author can declare green.

## 7. Review/approval record (not pre-filled)

| Decision ID | Owner | Decision APPROVE / REVISE / REJECT | Linked canonical requirement diff | Reviewer | Date |
| --- | --- | --- | --- | --- | --- |
| D01–D04 | Product / API / domain owner | PENDING | PENDING | — | — |
| D05–D09 | Product / Security / domain owner | PENDING | PENDING | — | — |
| D10–D14 | API / Security / Operations | PENDING | If necessary | — | — |

Record the full review outcome in this file or a reviewed PR before marking DE-01 contract **FROZEN**. If a rule changes, update the *owning* requirement and then update these subordinate task specs. Merely checking off an item in a PR discussion does not amend global business rules.

## 8. Gate and next task

**Go for design review:** YES. **Go for unreviewed implementation of unresolved product semantics:** NO.

Once D01–D14 required approvals have been recorded, DE-02 implements authorized read ports; DE-03 personal API; DE-04 management API; DE-05 Minutes; DE-06 durable schema; DE-07/08 renderers; DE-09 job; DE-10 secure storage; DE-11 version/freshness; DE-12 hardening; DE-13 end-to-end acceptance. Each task must include focused real-boundary tests and update docs for any approved contract changes.

This separation is intentional: the task exists to prevent "make it work for a demo" behavior from becoming accidental, unreviewed product policy.
