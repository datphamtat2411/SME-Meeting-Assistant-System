# DE-02 — Authorization-Aware Reporting Query Infrastructure

> **Status:** IMPLEMENTED FOR CI VERIFICATION; NOT CLOSED UNTIL FINAL BRANCH HEAD API CI IS GREEN.
>
> **Branch:** api/module-dashboard-export, continuing DE-01 engineering review docs.
>
> **Scope:** Internal Core API query foundations only. No public Dashboard or Export controller, no new business policy, no Flyway migration, no PDF/job/storage implementation. DE-03 onward consume these read ports and must obtain outstanding DE-01 approvals before finalizing user-visible metrics.

## 1. Requirement ownership and invariant mapping

- RE03 ARCH-API-001/004/005/009/010: source-feature-owned read boundary and acyclic dependencies; no cross-module repository calls.
- RE03 ARCH-GEN-002/009/010: PostgreSQL canonical business state; projections are rebuildable and read-only.
- RE04 BR-DASH-001..005: authorized canonical aggregation, correct time semantics, no independent overdue state and no confusing meeting with AI status.
- RE04 BR-ROLE-003/004, BR-MTG-009/010, BR-PART-004..006, RE08 SEC-AZ-001..014: active session/actor, current meeting membership, manager permissions bounded to explicit Action Items scope, no administrator content bypass.
- RE05 DB-GEN-009, DB-PG-003/004: derived overdue and distinct instant/date types.
- DE01_DECISION_REGISTER.md D01–D14 remains pending approval. This task cannot silently approve management meeting attribution, rate denominator, date-axis business policy or AI latest-status taxonomy.

## 2. Selected implementation

### 2.1 Meeting-owned read port

- MeetingReportingPort and SqlMeetingReportingAdapter in meeting/service.
- countVisibleByStatus returns canonical Meeting execution-state counts with zero values for absent statuses.
- scheduledStartingIn selects SCHEDULED rows whose scheduled_start_at instant is within [from,to), ordered by (scheduled_start_at ASC,id ASC), bounded 1..100.
- endedIn selects ENDED rows whose actual ended_at instant is within [from,to), ordered by (ended_at DESC,id DESC), bounded 1..100.
- SQL predicate: current organizer OR EXISTS currently active participant. This is exactly the existing meeting content visibility rule; no department or administrator implied content visibility.
- Authorization precedes GROUP BY/LIMIT; EXISTS avoids organizer+participant double-counting; all rows are typed projections, not JPA entities.

These queries are **generic internal primitives**, not an approved personal dashboard time horizon. The caller must choose explicitly approved from/to windows in DE-03.

### 2.2 Action Items-owned read port

- ActionItemReportingPort and SqlActionItemReportingAdapter in actionitems/application.
- assignedOfficial: only official currently assigned work. This is intentionally separate from meeting-content permission: a legitimate assignee may read their task without transcript rights.
- visibleOfficial: official work within the existing ActionItemService.list visibility predicate: organizer; active meeting participant; official assignee; active manager with captured meeting_action_item_scopes and active manager_scope_units grant. "Visible" does not mean "countable as manager KPI" without approved DE-01 D01/D03.
- SQL FILTER aggregates count OPEN, IN_PROGRESS, DONE, CANCELLED and the currently-overdue subset. No Java-side full entity loading and no duplicated dashboard counters.
- The official population is source_type='MANUAL' OR confirmed_by_user_id IS NOT NULL. AI candidate/hint PROPOSED cannot become an official work obligation just by assigning a person.
- Derive overdue from due_date DATE < businessLocalDate(asOf) and status IN ('OPEN','IN_PROGRESS'), using the same app.action-items.business-zone setting as the Action Items service. Caller passes a trusted asOf Instant, not an arbitrary client-supplied zone.
- Current-state counts are not history-as-of, completion rate or period-cohort metrics; DE-01 D02/D03 are still pending.

**Known existing discrepancy:** ActionItemView.overdue static helper reads UTC, while ActionItemService's business-zone policy is configurable. DE-02 intentionally does not modify unrelated public API behavior; Action Items owner must resolve DE-01 D04 before DE-03 presents overdue metrics. The read port uses the configured Action Items service business zone, not a third independent setting.

### 2.3 Media-owned technical job read port

- ProcessingReportingPort and SqlProcessingReportingAdapter in media/service.
- Returns raw technical processing job status counts for meetings whose content the actor currently may read (organizer or active participant). Access uses exact current Meeting content authorization predicate in SQL. No manager Action Item-only bypass.
- Deliberately NOT a "failed meetings" or "latest processing failed" product KPI; multiple jobs for one meeting can be counted separately. Owner agreement on latest effective outcome and warnings is DE-01 D06 and DE-04 work.
- Does not expose media object key, provider info, error details, transcript or AI result payload.

### 2.4 Dashboard coordinator

- DashboardReportingQueries in dashboard/query imports only exported source-feature read ports, no repositories.
- currentVisible returns one immutable AuthorizedProjection with one asOf, explicit bounded scheduled/ended windows, meeting status counts, assigned/visible official action counts and raw technical job status counts.
- Transaction boundary: @Transactional(readOnly=true,isolation=REPEATABLE_READ). In a normal nontransactional request this establishes a consistent PostgreSQL snapshot across all read queries. Any future outer transaction must not silently downgrade this guarantee.
- No HTTP endpoint, no business persistence and no management-specific aggregation are added.

## 3. Query/index audit at starting schema V34

Existing index support:
- V6: ix_meetings_organizer_created; ix_meetings_status_schedule; ix_meeting_participants_active_user; ux_meeting_participants_active_user.
- V29: ix_action_items_assignee_status_due; ix_action_items_meeting_status_created.
- V30: ix_meeting_ai_scope_unit.
- V11: ix_processing_jobs_meeting_created; ix_processing_jobs_status_queued.
- V1: manager scope grants use an explicit composite primary key.

No new index is introduced speculatively by DE-02. A permission-aware query need not always use each available index on a small fixture. For DE-12 performance assessment, use EXPLAIN (ANALYZE, BUFFERS) with representative meeting, participant, assignment and job cardinalities; record p95 and actual query plans before adding additional migration(s). Avoid claiming measured speedup without performance evidence.

Potential future optimization for large organizations: refactor the repeated current-content authorization SQL as a Meeting-owned, test-covered SQL visibility artifact or an approved secure read port; avoid an unreviewed global "permission" table. Current predicates are intentionally verified against MeetingCoreService and ActionItemService behavior by integration tests.

## 4. Integration verification

New file: src/test/java/com/sme/meetingassistant/api/dashboard/ReportingQueryIntegrationTests.java

Runs with SpringBootTest, real PostgreSQL 17 Testcontainers and Flyway migrations (PostgresTestConfiguration), not H2 or Mock repositories.

Coverage:
1. Organizer and participant visibility, duplicate organizer membership and manager/admin no-content bypass.
2. Current participant removal and stable half-open time filters.
3. Deterministic tie-breaking/bounded result window validation.
4. Wrong actor ID and inactive session rejected before aggregate SQL.
5. Official assignee without meeting membership; managed Action Items within explicitly recorded unit scopes; no retroactive scope changes; role revoke.
6. DATE overdue relative to configured Asia/Ho_Chi_Minh zone; DONE excluded.
7. Raw AI job status remains independent from Meeting ENDED, revoked meeting participant loses job visibility.
8. Coordinator combines ports with same asOf, read-only architecture and immutable projections.

CI acceptance requires the branch's FINAL commit HEAD to have an actual successful API CI run (./mvnw -B -ntp verify) with all relevant tests executed. Earlier green runs, Java compilation alone, or a green develop build do NOT close DE-02.

## 5. Explicit follow-up gates

- **DE-03:** Do not ship upcoming/recent horizon or current dashboard processing KPI until D06/D07 are approved. Reuse ports; no duplicate query logic in controller.
- **DE-04:** Do not equate visibleOfficial with a management cohort; D01/D02/D03/D05 must be resolved and approved first.
- **DE-05:** New meeting-content snapshot read port requires same authorization boundary and immutable canonical views, but is not implemented in DE-02.
- **DE-12:** Benchmarks, workload budgets, query indexes and cross-module SQL visibility drift monitoring remain to be measured and hardened.
- **Security:** No real endpoint was introduced, so DE-02 tests exercise server request principal into the source-owned read boundary; DE-03/04 must add full HTTP/JWT/session integration tests.

## 6. Completion rule

**Engineering code submitted** is not synonymous with **DE-02 closed**. Mark CLOSED only after: final SHA CI conclusion=success; no test skip masking DE-02 integration; source-boundary review; DE-01 pending decisions remain transparently documented (not silently treated as approved). No product-facing Dashboard API can be accepted until its specific Product/Security decisions are approved.
