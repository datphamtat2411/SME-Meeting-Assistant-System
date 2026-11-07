# DE-03 — Personal Dashboard API (Implementation and Acceptance)

> **Status:** Code submitted for CI verification. DE-03 is CLOSED only if the **final branch HEAD SHA** has a successful API CI run with all DE-03 tests executed.
>
> **Branch:** api/module-dashboard-export. Depends on DE-02 authorized reporting ports and DE-01 contract/decision register.
>
> **Requirements:** RE02 API-EP-DASH-001 and API-RESP-*; RE04 BR-DASH-001..005, BR-ACT-010; RE06 FEAT-DASH-PERSONAL-001..002; RE08 SEC-AZ-*.

## 1. Implemented scope

Exactly one public endpoint: **GET /api/v1/dashboard/me**.

- Caller identity is server-authenticated (AuthenticatedUserId), never accepted as a userId query parameter.
- The read-only PersonalDashboardService captures one server asOf using an injectable Clock, builds bounded half-open windows, and uses DE-02 source-domain MeetingReportingPort + ActionItemReportingPort through DashboardReportingQueries.personal.
- The coordinator reads in one PostgreSQL REPEATABLE READ read-only transaction. The endpoint does not call the technical Processing Reporting port.
- Common API Response provided by ApiResponseFactory. Cache-Control: no-store for private user content.
- Explicit response DTOs; no JPA entities, transcript, AI outputs or S3 keys are exposed.
- No schema mutation, non-baseline route alias, DE-04 management reporting or DE-05 minutes/export implementation.

## 2. Query parameters — engineering defaults, D07 still pending Product review

| Parameter | Default | Accepted | Meaning |
| --- | --- | --- | --- |
| upcomingDays | 14 | 1–90 | Absolute duration days forward from trusted asOf |
| recentDays | 30 | 1–90 | Absolute duration days backward from trusted asOf |
| limit | 10 | 1–50 | Maximum items in each meeting list |

Upcoming instant interval: [asOf, asOf + upcomingDays * 24h). Recent interval: [asOf - recentDays * 24h, asOf). These are absolute durations, not local calendar-day boundaries. They are intentionally distinct from the Action Items business timezone, which controls due-date overdue.

Upcoming meetings are currently SCHEDULED and use scheduled_start_at; recent meetings are currently ENDED and use actual ended_at. Sort stability: upcoming by (scheduled_start_at ASC, id ASC); recent by (ended_at DESC, id DESC).

Invalid integer intervals/limit return HTTP 422 VALIDATION_FAILED; malformed integer values return 400 MALFORMED_REQUEST. These bounded defaults are operational proposals and **do not mean D07 is approved**.

## 3. Response fields

An authorized 200 Common API Response has data with:

- asOf — UTC ISO-8601 timestamp captured once.
- timezone — app.action-items.business-zone (same config as owning Action Items service).
- upcomingWindow / recentWindow — fromInclusive, toExclusive, limit, precisely describing query coverage.
- meetingCountsByState — all canonical Meeting status counts for current authorized population. These are all-time current-state counts, *not* the selected-window counts.
- upcomingMeetings / recentMeetings — bounded meeting cards (id,title,status,scheduledStartAt,scheduledEndAt,endedAt), authorized by current organizer or non-removed participant relationship.
- assignedActionItems — open, inProgress, done, overdue. Only **official current assignments**. Overdue is a derived subset of OPEN + IN_PROGRESS, never a new status or independent stored counter.

Illustrative response data (not a real user):

~~~json
{
  "asOf": "2026-11-06T18:30:00Z",
  "timezone": "Asia/Ho_Chi_Minh",
  "upcomingWindow": {
    "fromInclusive": "2026-11-06T18:30:00Z",
    "toExclusive": "2026-11-20T18:30:00Z",
    "limit": 10
  },
  "recentWindow": {
    "fromInclusive": "2026-10-07T18:30:00Z",
    "toExclusive": "2026-11-06T18:30:00Z",
    "limit": 10
  },
  "meetingCountsByState": {
    "DRAFT": 0, "SCHEDULED": 1, "IN_PROGRESS": 0,
    "ENDED": 1, "CANCELLED": 0
  },
  "upcomingMeetings": [
    {
      "id": "11111111-1111-4111-8111-111111111111",
      "title": "Sprint planning",
      "status": "SCHEDULED",
      "scheduledStartAt": "2026-11-09T02:00:00Z",
      "scheduledEndAt": "2026-11-09T03:00:00Z",
      "endedAt": null
    }
  ],
  "recentMeetings": [],
  "assignedActionItems": {
    "open": 2, "inProgress": 1, "done": 3, "overdue": 1
  }
}
~~~

The existing Common API Response envelope still supplies success,code,message,data,meta.requestId/timestamp. This is not an ad-hoc response body. Bounded lists have the provided limit but do not falsely claim full pagination support.

## 4. Authorization and source truth

- Meeting counts/list: current organizer OR active/non-removed participant; administrator/manager organizational role is no content bypass.
- Assigned action counts: official manual or human-confirmed Action Items with current assignee equal to the caller, including legitimate non-member assignees; no related Meeting title/transcript/summary is exposed for nonmembers.
- Official overdue: status OPEN or IN_PROGRESS, due_date DATE strictly before LocalDate(asOf at configured business ZoneId). No due date -> not overdue; DONE/CANCELLED -> not overdue. This mirrors DE-02 and the Action Items service's configured zone.
- Actor must be active each request; source ports validate the server principal. SQL filters before counting and before LIST LIMIT. EXISTS prevents organizer/participant duplicates.

DE-01 D04 notes preexisting ActionItemView.overdue static UTC helper disagreement with configurable Action Items business zone; DE-03 intentionally uses the existing service configuration rather than changing source-owned public API behavior during a Dashboard task. Resolution remains a domain-owner review item.

## 5. Explicit deferred Product policies

- DE-01 D06: *No* processingAttention, pending-review or failed-meeting count. Raw DE-02 job counts cannot be passed off as unique effective meeting processing/review KPIs without approved semantics. No fabricated 0 for unavailable metrics.
- DE-01 D07: the current bounded default windows are provisional. Product/API owner must review horizon and item limits before final product-contract freezing.
- DE-01 D01/D02/D03/D05: management attribution, management periods and completion rate belong to DE-04; no manager-only data is leaked here.
- DE-12 remains responsible for representative-load query-plan measurements and performance budgets, not speculative index migrations.

## 6. Automated acceptance

PersonalDashboardHttpIntegrationTests uses Spring Boot MockMvc, actual PostgreSQL 17 Testcontainers, Flyway migrations, DE-02 read SQL and a deterministic injected clock. Test cases:

1. Organizer/participant membership, overlap deduplication, authorized upcoming/recent and current-state Meeting counts.
2. Membership removal immediately excludes previously visible Meeting; inactive account denied.
3. Administrator role alone does not authorize other users' meetings.
4. Non-member official Action Item assignee gets counts but no protected Meeting details.
5. OPEN/IN_PROGRESS/DONE/CANCELLED; due yesterday/today/null in Asia/Ho_Chi_Minh while UTC is still previous calendar date.
6. Half-open instant windows, deterministic tie ordering and bounded lists.
7. Invalid query validation, malformed types, Common API Response, and no-store caching.
8. Real RS256 signed bearer token + live session checked by actual Security filter, revoked token and spoofed identity denied.
9. No unapproved processing/review KPI in response.

**CI closure gate:** GitHub API CI job on the latest branch SHA runs full Maven verify, returns conclusion=success, and DE-03 integration suite has 0 errors/failures/skips. A green DE-02 commit is not sufficient evidence.

## 7. Handoff

DE-04 must implement separately approved management organization attribution and must not assume Personal Dashboard visibility is the manager's reporting population. DE-05 uses its own protected meeting-content assembly; it must not use Personal Dashboard DTO as minutes source.
