# MI-03 — Meeting Intelligence Authorization and API Foundation

> Branch: `feat/mi03-meeting-intelligence-api-foundation` (created from `api/module-meeting-intelligence`).  
> Scope: Core API foundation, no migrations, no AI inference, no real Summary/Decision CRUD yet.  
> Status: Implementation for independent review; MI-01 architecture review gates remain open.

## Why this is intentionally separate from MI-02

MI-02 owns PostgreSQL schema, indexes, migrations, provenance and ingestion receipts. MI-03 owns a meeting-scoped security application port, explicit request/response contracts, transport precondition helpers and safe error mapping. Neither task should modify the other's ownership. There is **no production Summary/Decision HTTP controller** in MI-03 because it would require an unimplemented persistence service; exposing fake 200/202 responses or adding placeholder `501` routes would incorrectly advertise capability.

## Implemented

| Surface | Concrete implementation | Subsequent consumer |
| --- | --- | --- |
| Authorization | Meeting-owned `MeetingIntelligenceAccess` implemented by `MeetingCoreService` | MI-04, MI-05, MI-06, MI-08 |
| Summary request | `EditSummaryRequest` (nonblank, max 20,000 characters) | MI-04 |
| Summary read | `SummaryView` (version, quality, provenance and stale metadata) | MI-04, MI-09 |
| Decision create/edit | `CreateDecisionRequest`, `EditDecisionRequest` (nonblank, max 5,000; optional evidence max 50) | MI-05, MI-06 |
| Decision read | `DecisionView` (source/evidence, status, version, attribution, stale) | MI-05, MI-06, MI-09 |
| Conditional mutation | `IntelligenceVersionTags` with distinct opaque Summary and Decision tags | MI-04, MI-05, MI-06 |
| Safe error envelope | Existing `ApiExceptionHandler` + `ApiErrorCode.PRECONDITION_REQUIRED` for HTTP 428 | All conditional endpoints |
| Verification | Authorization integration scenarios, request Bean Validation, ETag and 428 unit checks | MI-12 |

## Security semantics

- `requireIntelligenceReadable`: only the active current organizer or currently active participant. Existing meeting policy hides unauthorized/missing resource existence as 404; unauthenticated/inactive actors receive 401.
- `requireSummaryEditAllowed`, `requireDecisionEditAllowed`, `requireDecisionReviewAllowed`: organizer only, using the existing Meeting-owned transcript editor policy. Global roles (including ADMINISTRATOR) are not content grants.
- `requireSummaryRegenerationAllowed`: organizer-only `requireProcessingAllowed`, including refusal for cancelled meetings. The final Summary regeneration service must still check source eligibility, job capacity and downstream availability.
- An authorized caller's identity must come from `AuthenticatedUserId.requireUserId()`, never an arbitrary client `actorId` field.
- Delegated editor/decision reviewer capability is proposed by MI-01 but **not implemented** in the canonical Meeting model. Do not silently add ad hoc grants in MI-03; obtain G6 approval first.
- All new read/response contracts must be sent with `Cache-Control: no-store` when production controllers are added, consistent with Transcript Review; MI-03 does not emit HTTP responses for these resources.
- A read model is not a persistence entity. Requests are allowlists without `status`, `sourceType`, `createdBy`, `confirmedBy`, `isCurrent`, or trusted provenance input.
- Decision evidence IDs must be checked for duplicates, meeting/transcript membership and source revision **inside MI-05**, not merely by Bean Validation. The DTO bounds are transport admission constraints, not semantic evidence validation.

## ETag/precondition contract

- Summary current-version ETag: strong opaque `"sum-{summaryVersionId}-{versionNumber}"`. Changing current version changes the tag even if a candidate was activated.
- Decision ETag: strong opaque `"dec-{decisionId}-{rowVersion}"`.
- For the eventual PATCH/confirm/reject operations, missing/blank `If-Match` is HTTP 428 with code `PRECONDITION_REQUIRED`; wrong/stale/wildcard tag is HTTP 412 with code `PRECONDITION_FAILED`.
- The helper provides transport-time comparison only. The implementing business transaction **must also lock or compare-and-swap canonical DB version** to prevent two concurrent valid-tag requests both committing. MI-03 cannot implement that without MI-02 data models.
- Never reuse Meeting metadata ETag or Transcript segment ETag for Summary or Decisions.

## Endpoint integration handoff

The eight canonical endpoints in `RE02-API.md` remain unchanged. MI-04/05/06/08 will attach controllers only after their real application services and migrations exist. Controllers should use `ApiResponseFactory`, no-store, ETag/If-Match, @Valid and `AuthenticatedUserId` and must not put business checks in the controller. Missing Summary returns authorized 404; decision IDs must be validated under the exact parent meeting ID. Summary regeneration returns an actual durable job from Media Processing, not a fake accepted response.

The request-record limits above are **implementation proposals**; these and extended response fields must be reviewed with the relevant MI-01 gates before becoming frozen public contracts. `SummaryView` and `DecisionView` currently use response-only string fields for canonical state to avoid introducing a competing status authority.

## Test plan and scope limits

- `MeetingIntelligenceAccessIntegrationTests`: a **test-only** probe controller exercises real Meeting policy and identity through MockMvc and PostgreSQL. It is NOT shipped in production.
- `IntelligenceContractValidationTests`: Jakarta Bean Validation and allowlisted request fields.
- `IntelligenceVersionTagsTests`: strong opaque tags, different namespaces and 428/412 cases.
- `IntelligencePreconditionErrorTests`: central exception-envelope regression for 428.
- No database migrations or table-dependent tests in MI-03. MI-12 will add end-to-end HTTP authorization, stale-result, concurrent conditional update, repository and job tests after MI-02/MI-04..MI-09.
- Java 21 / Spring Boot 4.1.1; run `cd services/api && ./mvnw test` with Docker/Testcontainers available for PostgreSQL integration tests. A connector-only commit does not itself prove these tests have run.

## Merge/review coordination

MI-03 and MI-02 must both merge into `api/module-meeting-intelligence`, not into each other's branch. Resolve any DTO/persistence mapping only in the consuming implementation tasks; avoid import dependencies on hypothetical MI-02 entities. Recheck the branch head and run the combined test suite after both branches land. Requirement extensions from MI-01 G1–G7 must be approved before release.
