# MI-09 — Source Freshness, Staleness and Conditional Writes

> Branch: `api/module-meeting-intelligence` (direct implementation after MI-08).  
> Scope: authoritative Summary/Decision source-freshness behavior, response ETag consistency, and regression coverage. No schema changes, public endpoint additions, RAG index writes, or speculative event consumers.

## Requirement anchors

- `requirement-docs/RE03-ARCHITECTURE.md`: ARCH-INTEL-001/005 (pinned transcript revision, downstream invalidation), ARCH-RAG-007/008 (future index freshness) and source-authority rules.
- `requirement-docs/RE01-AI.md`: AI-DOWN-004 and human-corrected transcript precedence.
- `requirement-docs/RE06-FEATURES.md`: FEAT-TRN-DOWNSTREAM-001.
- `services/api/docs/MI01_ARCHITECTURE_AND_CONTRACTS.md`: ADR-02 and ADR-08. In MI-01's planned build sequence, MI-09 is the staleness workstream.

## Authoritative semantics

Each canonical Summary version and sourced Decision holds immutable `(transcriptId, contentRevision)`. Read projection compares this pinned pair to the **current** transcript for the same meeting.

| Case | `isStale` | Authority |
| --- | --- | --- |
| Same transcript ID and content revision | false | Pinned artifact and current transcript agree |
| Same transcript ID, newer current revision | true | Current transcript wins; stored content is not changed |
| Different current transcript ID, even when revision numbers happen to match | true | Identity must match as well as revision |
| No current transcript for a sourced artifact | true | Source no longer corresponds to an authoritative current transcript |
| Unsourced MANUAL Decision | false | Does not claim transcript-based evidence |
| Current Summary is HUMAN_EDIT of an old source | true when source differs | Human text is retained, but editing does not falsely reset its source |
| CONFIRMED Decision whose transcript changes | true when source differs | Confirmation/actor/time remain authoritative; evidence is flagged outdated |
| Rejected or proposed Decision whose transcript changes | true when source differs | Status and immutable origin remain unchanged |

Staleness is **derived on authorized reads**, not a mutable status column, and does not conflate Summary `qualityStatus` with Decision `status`. Transcript corrections and speaker-map changes already advance the canonical transcript revision through the Transcript-owned meeting lock. MI-07 keeps stale AI Summary results non-current and MI-06 blocks source-stale AI confirmation; this task does not silently regenerate, delete, demote, or re-confirm anything.

## Freshness-aware strong ETags

The existing ETag was based only on entity identity/version although the public representation also contains `isStale`. A material transcript change could therefore modify the representation without changing the claimed **strong** ETag.

MI-09 aligns the existing version tags with that observable state:

- Fresh Summary: `"sum-{summaryVersionId}-{versionNumber}"` (unchanged).
- Stale Summary: `"sum-{summaryVersionId}-{versionNumber}-stale"`.
- Fresh Decision: `"dec-{decisionId}-{rowVersion}"` (unchanged).
- Stale Decision: `"dec-{decisionId}-{rowVersion}-stale"`.

When the artifact first becomes stale, authorized clients must refresh their representation. An old pre-correction `If-Match` fails with **412**, not a silent successful write. An organizer may explicitly edit an already-stale current Summary or confirmed Decision using the **new stale ETag**; such edits preserve original pinned source identity/revision and continue reporting `isStale=true`. Version changes always rotate ETag as before. The same freshness-aware check applies to MI-06 confirm/reject: reject remains allowed on stale evidence **after** fetching its new token, whereas confirming stale AI evidence is still blocked by evidence validation. Unauthorized access is checked before tokens.

This affects only `If-Match` / ETag semantics of existing protected endpoints, not URLs, business status values, request bodies or database constraints. `Cache-Control: no-store` remains in effect.

## Transactional boundaries and non-goals

- Transcript owns authoritative correction/speaker-map/source identity. Summary/Decision read models compare to current transcript via one meeting-scoped SQL projection; writes use the established Meeting row lock and then re-evaluate the current ETag.
- No persistent `stale` flag is added: it can drift and requires extra recovery/reconciliation infrastructure. Historic Summary/Decision provenance is not rewritten.
- No outbox `TRANSCRIPT_CHANGED` event is emitted without an actual consumer. Action Items and RAG own their own correction/index invalidation, at the future feature boundary; this implementation does **not** represent Qdrant as synchronized or build an unused queue.
- MI-08 regeneration remains an explicit organizer-authorized action and disabled by default until compatible AI workers exist.
- Pending MI-01 review gates continue to apply to producer/worker contracts and storage-retention policy; there is no implied cross-team approval.

## Focused verification

Tests use the real PostgreSQL schema via Testcontainers and authenticated MockMvc requests:

- `SummaryManagementIntegrationTests`: source revision causes `isStale`, rotates ETag, rejects old `If-Match`, permits explicitly acknowledged human edit while retaining old source; replacement transcript also becomes stale.
- `DecisionManagementIntegrationTests`: sourced confirmed Decision becomes stale after source correction or replacement, cannot be rewritten with old ETag, can be edited with new stale token while preserving old evidence; unsourced manual Decision remains fresh.
- `DecisionReviewIntegrationTests`: old pre-correction token fails; stale AI proposal still cannot be confirmed; reject works after refreshed token without erasing evidence or status attribution.
- Existing MI-07 ingestion tests cover old-result non-promotion, and MI-08 tests cover admission recheck of current source.

Run in `services/api`:

    ./mvnw -B -ntp -Dtest=SummaryManagementIntegrationTests,DecisionManagementIntegrationTests,DecisionReviewIntegrationTests test
    ./mvnw -B -ntp verify

Acceptance: **full API CI must complete successfully for the final HEAD** on `api/module-meeting-intelligence`.
