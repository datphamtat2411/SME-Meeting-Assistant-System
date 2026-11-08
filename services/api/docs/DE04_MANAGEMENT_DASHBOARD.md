# DE-04 — Scoped Management Dashboard API

> **Status:** Code implemented for CI verification. DE-04 is not closed unless full API CI succeeds on the final branch HEAD.
>
> **Product contract:** CONDITIONAL. Outstanding DE-01 policy decisions D01/D02/D03/D05/D06 remain unapproved. The endpoint intentionally exposes only the reporting scope grounded in current Action Item permissions.
>
> **Requirements:** RE02 API-EP-DASH-002, RE04 BR-DASH-001..005, BR-ROLE-003/004, BR-ACT-010/015, RE06 FEAT-DASH-MGMT-001..005, RE08 SEC-AZ-*.

## 1. Security boundary and design rationale

The current Meeting schema has organizer and participant relationships, **not** an approved organizational Meeting ownership association. The immutable table meeting_action_item_scopes introduced in V30 gives Department Managers an approved scope for **Action Items**. It explicitly is **not** a right to read Meeting titles/transcripts or derive all Meeting-level organization counts. Directory administrator powers similarly do not convey arbitrary Meeting/Action Item read access.

DE-04 implements the subset that is correctly authorized **today**: management aggregates of **official Action Items** classified under active manager grants and immutable captured Action Item unit scope. Unapproved Meeting-wide metrics, AI outcomes and completion ratios are listed as unavailable, never filled with fake zeros or inferred from forbidden source rows. The manager counts work across the managed unit, including other users' assignments. This is not a personal dashboard in disguise.

This is a real endpoint with an intentionally narrow authorization grant, not approval for its remaining Product policy extensions.

## 2. Public HTTP contract

**GET /api/v1/dashboard/management?from=2026-11-01T00%3A00%3A00Z&to=2026-11-15T00%3A00%3A00Z**

Optional orgUnitId=UUID further narrows to one CURRENT, ACTIVE unit already granted to the authenticated manager.

- from and to are required ISO 8601 offset-aware instants; interval is **[from,to)**, with maximum 366 duration days. No unbounded default.
- Missing/malformed time or UUID: 400 MALFORMED_REQUEST; reversed/zero/excessive period: 422 VALIDATION_FAILED.
- Active Department Manager with at least one current active unit grant: authorized within exact captured scope. Employee, ungranted manager and global directory Administrator **without separate approved action read rights**: 403. Inactive/anonymous: 401.
- The standard Common API Response wraps the data with success/code/message/meta.requestId/meta.timestamp. **Cache-Control: no-store**.
- No query accepts arbitrary userId, organizational hierarchy override, meeting content or transcript.
- A non-granted orgUnitId is 403, not a misleading 0 result. Valid authorized empty cohorts return legitimate zeros.

## 3. Response data

~~~json
{
  "asOf": "2026-11-06T18:30:00Z",
  "timezone": "Asia/Ho_Chi_Minh",
  "period": {
    "fromInclusive": "2026-11-01T00:00:00Z",
    "toExclusive": "2026-11-15T00:00:00Z",
    "cohortTimeField": "ACTION_ITEM_CREATED_AT",
    "statusTimeSemantics": "CURRENT_STATE"
  },
  "scope": {
    "type": "MANAGED_OFFICIAL_ACTION_ITEMS",
    "organizationalUnitIds": ["11111111-1111-4111-8111-111111111111"]
  },
  "actionItems": {
    "open": 3,
    "inProgress": 1,
    "done": 1,
    "cancelled": 1,
    "overdue": 3,
    "totalOfficial": 6
  },
  "unavailableMetrics": [
    {
      "metric": "MEETING_COUNTS",
      "reason": "MEETING_ORGANIZATIONAL_REPORTING_SCOPE_NOT_APPROVED"
    },
    {
      "metric": "PROCESSING_OUTCOMES",
      "reason": "AI_PROCESSING_REPORTING_SCOPE_AND_TAXONOMY_NOT_APPROVED"
    },
    {
      "metric": "COMPLETION_RATE",
      "reason": "PRODUCT_DENOMINATOR_AND_COHORT_POLICY_NOT_APPROVED"
    }
  ]
}
~~~

**Cohort semantics:** The period selects official Action Items by their original action_items.created_at. OPEN/IN_PROGRESS/DONE/CANCELLED reflect the **current canonical state**, not historic status on the selected date. totalOfficial includes CANCELLED and therefore is NOT a completion-rate denominator. Due_date is a PostgreSQL DATE; overdue means OPEN/IN_PROGRESS and due_date before the business calendar date (same app.action-items.business-zone as DE-02/03), not a stored state. Unapproved completion rate remains explicitly unavailable.

**Historical reporting warning:** This is not “number of tasks completed during the month.” That needs a separate approved completion event or historical state reporting model.

## 4. Implementation and ownership

- **Action Items-owned port:** ManagedActionItemReportingPort and SqlManagedActionItemReportingAdapter, SQL COUNT FILTER. The query joins manager_scope_units, ACTIVE manager actor, ACTIVE organizational_units, immutable meeting_action_item_scopes and official action_items. Status filters and due-date rule remain canonical.
- **Distinct aggregation:** each Meeting has at most one immutable Action Item scope (meeting_id PRIMARY KEY) and each manager has at most one grant per unit (composite PK). No organizer/participant/assignee OR joins can multiply Action Item counts. A manager's personally assigned work from outside managed units is not silently counted as departmental work.
- **Query read boundary:** DashboardManagementQueries validates current directory manager role/grants, explicitly denies ADMINISTRATOR directory allUnits, narrows optional orgUnitId and reads official counts inside a read-only PostgreSQL REPEATABLE READ transaction.
- **Service:** ManagementDashboardService injects the server Clock and one business ZoneId, validates bounded absolute time window. The caller cannot choose an overdue timezone or asOf.
- **Controller and DTO:** ManagementDashboardController exposes the canonical API-EP-DASH-002 endpoint via ApiResponseFactory. ManagementDashboardView contains authorized aggregate counts, explicit cohort provenance and unavailable KPI reasons, not persistent entities, source object keys or individual Meeting identifiers.
- No migration: V29/V30 indexes already support manager-to-action lookup. Future DE-12 requires representative EXPLAIN ANALYZE BUFFERS and p95 benchmark before additional index decisions.

## 5. Authorization/security acceptance

Integration test ManagementDashboardHttpIntegrationTests uses actual HTTP MockMvc, PostgreSQL 17 Testcontainers and Flyway, not repository mocks. Tests check:

1. Two active grants, all official lifecycle statuses, overdue and no unauthorized third-unit/unscoped counts; no protected Meeting content/AI data in response.
2. Narrowed orgUnitId and explicit rejection of out-of-scope or nonexistent unit.
3. Employee, global Administrator, manager lacking active grants, anonymous and inactive users rejected.
4. Current manager role, grant and unit deactivation immediately affect next request.
5. Organizer department transfer never retroactively changes the recorded Action Item classification.
6. UTC-aware half-open createdAt cohort, stable current-state semantics after status mutation.
7. Empty authorized cohort is 0, but missing/malformed/invalid date bounds use standard error envelope.
8. Real RS256 bearer token, live auth session, role reevaluation and session revocation enforced at Spring Security boundary.

DE-02/03 tests must remain passing. **Close DE-04 engineering implementation only if full Maven verify, GitHub API CI and DE-04 HTTP integration tests all pass on the exact final branch SHA.** Never claim approval of D01/D02/D03/D05/D06 merely because CI is green.

## 6. Product policy gates

- **D01:** Establish an explicitly authorized Meeting organizational attribution. Do NOT relabel V30 Action Item scope as full Meeting ownership.
- **D02:** Choose Meeting period/time axis and historical semantics.
- **D03:** Approve completion rate numerator/denominator in owning RE04/RE06.
- **D05:** Assess small-cell disclosure when introducing aggregates broader than individually readable official Actions. The existing limited Action Item population is already individually readable by the authorized manager.
- **D06:** Define effective current AI processing state and authorization before adding failures/warnings; do not confuse historical failed jobs with meetings that never ended.
- **D12:** Finalize public field names and error taxonomy with API/Product reviewers.

When policy is approved, introduce independently authorized Meeting/Media projections; do not promote manager's directory permission into content authorization or backfill old scope from organizer's current unit.
