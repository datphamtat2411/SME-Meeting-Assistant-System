# DE-01 — Dashboard Metric Dictionary v1 (Proposal for Product/API Review)

> **Status:** ENGINEERING PROPOSAL, NOT APPROVED BUSINESS POLICY.
>
> **Companion:** DE01_DASHBOARD_EXPORT_CONTRACTS.md; outstanding decisions and sign-off in DE01_DECISION_REGISTER.md.
>
> **Invariants:** BR-DASH-001..005, BR-ACT-010, BR-MTG-006, BR-MTG-LC-011, BR-ACT-001..015, BR-ROLE-003..004, SEC-AZ-012 and FEAT-DASH-MGMT-001..005 take precedence.

## 1. Definitions and non-negotiable conventions

- **Entity grain:** One meeting metric counts distinct meetings.id, one Action Item metric counts distinct action_items.id. One processing-job metric counts distinct processing_jobs.id; one affected-meetings metric counts distinct meeting IDs. These two metrics are NOT interchangeable.
- **Scope:** First compute effective authorized entity IDs under the owning feature's current authorization, then aggregate. An organizational scope edge, an Action Item assignment and meeting-content access are separate predicates. Do not count all rows then redact details. Overlapping manager scopes cannot multiply distinct entity counts.
- **Current-state metrics:** Status counts and completionRate over a date range describe the CURRENT status of selected entities at one asOf instant; they are not historical state transitions as of a past date. For historical transition counts, use versioned history/attribution and document a distinct metric.
- **Time capture:** Sample one trusted asOf Instant for a request and pass it to every query. All absolute instants use UTC/offset storage; apply configured business ZoneId only to business calendar date comparisons. Do not treat a DATE deadline as an instant. For asOf 2026-11-07T16:00:00Z and Asia/Ho_Chi_Minh, the business local date is 2026-11-07.
- **Periods:** All instant-based filters are half-open [from,to); from is inclusive, to is exclusive, both absolute instants and from < to. Date-only reporting, if added, must explicitly document how the zone maps dates to instants.
- **Nullness:** Missing due_date never counts overdue. A zero metric may return 0; an undefined rate must be null/not-applicable, not silently 0% or 100%.
- **No independent OVERDUE state:** due_date < businessLocalDate(asOf), subject to BR-ACT-010 eligibility. The metric's *population* is separately defined; BR-ACT-010 itself must not be rewritten.
- **Official obligations:** Proposed candidate work is not an official Action Item (BR-ACT-002). For official-work metrics, use OPEN, IN_PROGRESS and DONE; CANCELLED is retained history but excluded from active completion denominator. It may be included in a separate breakdown with its own meaning.
- **Meeting execution and AI status:** ENDED means occurrence ended; AI completion can remain pending/review/failed. Never conflate processing stage status with meetings.status.

## 2. Shared access contract

| Population | Required source authority | Leakage precaution |
| --- | --- | --- |
| Personal upcoming/recent meetings | Meeting-owned permission query; organizer and/or authorized participant based on current policy | Avoid internal title/room info for metadata-concealed meeting |
| Personal assigned actions | Action Items-owned read policy for assignee, independently of meeting-content permission | Action Item visibility does not disclose transcript/summary |
| Management meetings | Exact approved meeting-to-unit attribution and management authorization, yet to be locked | NEVER infer from manager_scope_units alone; meetings has no org_unit_id baseline |
| Management actions | Exact approved Action Item managerial population rule, yet to be locked | Avoid counting items outside authorized unit/scope |
| AI processing metrics | Media-owned scoped job read, only approved operational fields | No source text, media location or provider secrets |
| Minutes / Export | Meeting-owned meeting-content read authorization, current at request time | Manager/admin role not a bypass |

**BLOCKER M-01:** RE05 meetings has organizer_user_id but no org_unit_id; organizational scopes are explicit in manager_scope_units and user primary_org_unit_id. Decide whether meeting management attribution uses historically pinned organizer department, another approved relation, or different authorized reporting scope. **Do not silently join the organizer's current department and call it meeting ownership.** DE-04 management counts must not ship until this rule is approved.

## 3. Personal Dashboard — proposed field semantics

| ID / field | Grain and definition | Time/filter | Source and access | Status |
| --- | --- | --- | --- | --- |
| P01 upcomingMeetings | Distinct authorized SCHEDULED meetings with scheduled_start_at >= asOf; bounded nearest-first list, tie-break (scheduled_start_at,id) | Start instant in [asOf, asOf+horizon) | Meeting-owned | PROPOSED; horizon/default pending |
| P02 recentMeetings | Distinct authorized previously occurred meetings, e.g. ENDED with ended_at present, ordered by ended_at DESC,id DESC | Bounded past lookback; choice of ended_at vs scheduled end needs review | Meeting-owned | PENDING Product |
| P03 assignedActionItems.open | Distinct visible official actions with assignee_user_id=caller and status OPEN | Current state asOf | Action Items-owned | PROPOSED |
| P04 assignedActionItems.inProgress | Distinct visible official actions with assignee_user_id=caller and status IN_PROGRESS | Current state asOf | Action Items-owned | PROPOSED |
| P05 assignedActionItems.done | Distinct visible official actions with assignee_user_id=caller and status DONE | Current state asOf | Action Items-owned | PROPOSED |
| P06 assignedActionItems.overdue | Distinct visible assigned official OPEN/IN_PROGRESS actions with due_date < businessLocalDate(asOf) | Calendar date | Action Items-owned | PROPOSED; reconcile overdue semantics |
| P07 processingAttention.pendingReview | Count of distinct eligible meetings whose current approved processing/review evidence requires attention, not raw job-count | Current state | Media/Transcript/Meeting Intelligence read boundary | PENDING precise taxonomy |
| P08 processingAttention.failedOrWarning | Distinct affected meetings with current actionable failure/warning; exclude superseded attempts unless specifically labeled | Current effective processing state | Media read boundary | PENDING policy |

These candidate fields are sufficient for DE-03 but not mandatory additions to the RE02 baseline. An endpoint may omit an optional metric until its policy has been approved; it MUST NOT return a fabricated 0 for an unavailable metric.

## 4. Management Dashboard — proposed field semantics

| ID / field | Numerator / population | Time semantics | Notes / open questions |
| --- | --- | --- | --- |
| M01 meetingCountsByState | COUNT(DISTINCT meeting.id) by current canonical DRAFT/SCHEDULED/IN_PROGRESS/ENDED/CANCELLED | Candidate selected period uses scheduled_start_at or actual occurrence; not decided | Meeting date axis and scope attribution require approval M-01/M-02 |
| M02 actionCountsByState | COUNT(DISTINCT official action.id) grouped OPEN/IN_PROGRESS/DONE and optionally CANCELLED history | Current status of selected action population | Proposed: action.created_at in [from,to); changes made later affect current status, not historical cohort |
| M03 overdueActionItems | COUNT(DISTINCT official action.id) with status OPEN/IN_PROGRESS and due_date < business date | Current asOf; selected organizational scope | Do not count PROPOSED as official obligations; separate metric needed if proposals included |
| M04 completionRate.numerator | COUNT of scoped official actions in DONE | Same exact population as denominator | Exclude PROPOSED and CANCELLED from denominator |
| M05 completionRate.denominator | COUNT of scoped official actions in OPEN, IN_PROGRESS or DONE | Same cohort selection and asOf as numerator | Proposed rate = 100 * numerator/denominator; null if denominator=0 |
| M06 aiProcessing.failedMeetings | COUNT(DISTINCT meeting.id) whose current effective processing has FAILED outcome | Current effective job/state, optional period by meeting | Do NOT count failed attempts across superseded jobs as failed meetings |
| M07 aiProcessing.warningMeetings | COUNT(DISTINCT meeting.id) with current warning/unresolved evidence | Current effective processing evidence | Not equivalent to failed job |
| M08 processingJobFailures (optional separate metric) | COUNT(DISTINCT processing_job.id) of failed jobs | Job completion/start period specified separately | Do not label this "failedMeetings" |

**BLOCKER M-02:** RE06 lists possible counts and completion ratio but RE04 BR-DASH-005 delegates denominator to detailed feature requirements, which do not yet prescribe an exact denominator or date axis. The above current-state completion formula is a **Product proposal**; it is NOT already approved. For a historic period, define entity cohort separately from status event period. Do not advertise "completion rate during month" for a current-state cohort as if it were a month-end historical snapshot.

**BLOCKER M-03:** For manager operational metrics, small cell counts can leak sensitive existence. Determine if/how small-cell suppression, thresholding or coarse aggregation is required by Product/Security, and keep endpoint fail-closed pending that decision.

## 5. Special cases and truth tables

| Case | Expected fact | Metric treatment |
| --- | --- | --- |
| Meeting ENDED, AI processing FAILED | Occurrence completed and processing failed | Meeting status ENDED count unchanged; processing failure count separate |
| Meeting CANCELLED with old processing history | No successful occurrence; history retained | Cancellation counted only in approved cohort; no blanket "completed" interpretation |
| Action Item PROPOSED, due_date in past | Proposal is not official obligation | Excluded from official-work overdue KPI; BR-ACT-010 still governs canonical overdue predicate if that predicate is exposed independently |
| OPEN item without due_date | Not overdue | Due missing => false |
| OPEN item with due_date equal business local date | Not yet overdue | Due date must be strictly less than local today |
| DONE item with due_date yesterday | Completed obligation | Not currently overdue |
| DONE item reopened to OPEN | Current work is active again | Current completion counts change; history remains unchanged |
| OPEN item reassigned from A to B | Current assignment is B | A personal current counts drop; B counts increase |
| Same meeting in two authorized manager joins | One meeting | COUNT DISTINCT / EXISTS; no double counting |
| Manager granted unit but meeting content not permitted | Operational access only if authorized | Never include transcript/title or unapproved detail |
| All denominator candidates cancelled or proposed | Denominator 0 | completionRatePercent is null (proposal), not fabricated 100 |
| AI source/status unavailable | Unknown, not 0 failed | Return omission/unavailable status if policy permits; do not convert to success |
| Authorized scope contains no matching records | Legitimate zero | Empty lists/zero counts are valid |
| User has revoked or inactive session | Unauthorized | No cached sensitive results |

## 6. Test dataset design and oracle

Build reproducible DE-02/03/04 integration fixtures:
- Actors: Employee A and B, Manager for unit U1, Manager scoped to U1+U2, Administrator lacking meeting-content membership, deactivated user and former participant.
- Meeting records: SCHEDULED upcoming, ENDED with AI pending, ENDED with failed latest processing, CANCELLED, cross-unit meeting and meeting appearing in multiple relevant relationships.
- Action records: PROPOSED, OPEN, IN_PROGRESS, DONE, CANCELLED, due yesterday/today/tomorrow/null, reassigned and reopened.
- Time: a fixed Clock at 2026-11-07T16:00:00Z and configured Asia/Ho_Chi_Minh zone plus an explicit UTC boundary-crossing case; actual zone must follow Action Items configuration approved in M-04.
- Assertions: each returned count is traced to exact entity IDs visible to caller; zero unauthorized rows, zero double-counts, correct denominator and date comparator.
- SQL query plans and authorization tests are DE-02 acceptance; full HTTP envelope and field tests are DE-03/04.

## 7. Ownership and review status

The following require sign-off before implementation:
- M-01 authorized manager-to-meeting mapping and departmental attribution (Product + Security + Meeting/User Organization).
- M-02 period axis, current-vs-historical interpretation and completion numerator/denominator (Product + API).
- M-03 small-cell/aggregate disclosure policy (Security + Product).
- M-04 canonical Action Item due-date business ZoneId and assignee-visible scope (Action Items + API).
- M-05 P07/P08 current processing failure/warning/review taxonomy (Media + Meeting Intelligence + Product).
- M-06 personal dashboard horizons and bounded list caps (Product + API).

Cross-document requirement changes must be reflected in canonical owner RE04/RE06 before freezing new business semantics. Until then, these definitions are executable TEST DESIGN PROPOSALS, not definitive shipped product behavior.
