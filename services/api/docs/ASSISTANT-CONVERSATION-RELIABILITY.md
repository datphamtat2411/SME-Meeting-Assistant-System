# Assistant conversation reliability — Wave 01

This package-level note documents the additive v1 Assistant conversation contracts.
Core API continues to own conversation authorization, durable turn identity,
admission, lease ownership, and canonical result persistence. AI inference
remains synchronous and outside the database transaction.

## Public creation and wire contract

Base path: /api/v1/assistant/conversations. GET lists the current caller's
authorized conversations (page defaults to 0, size to 20); POST creates a
meeting-scoped conversation. Create requires meetingId UUID and an optional
title (max 255 characters); blank title normalizes to null. The optional
Idempotency-Key header is 1–128 ASCII characters matching
[A-Za-z0-9][A-Za-z0-9._:-]{0,127}. V67 binds the owner-scoped SHA-256 key digest
to a digest of the normalized meeting ID/title intent. Same-intent replay
reauthorizes and returns the same conversation, without charging quota again;
both creation and replay currently return 201 and Location. Different intent
under the key returns 409 CONFLICT. Unkeyed creation is not idempotent.
No global scope or new public route is introduced.

The merged AssistantModels records are the exact server wire definition;
the following documents the nullable fields and state invariants. Required
arrays are non-null, possibly empty. IDs are UUIDs and timestamps are
offset-aware.

| DTO | Fields / nullability |
| --- | --- |
| ConversationView | id, meetingId, status, createdAt, updatedAt required; title nullable |
| MessageView | id, role (USER/ASSISTANT), visibility (VISIBLE/SOURCE_UNAVAILABLE), claims, citations, createdAt required; content and answerStatus nullable |
| ConversationDetail | conversation, messages, page, size, hasMore required; nextBeforeMessageId and pendingTurn nullable |
| TurnStatusView | conversationId, turnId, state, userMessageId required; leaseStatus, assistantMessageId, answerStatus nullable according to state |
| TurnView | turnId, state, userMessageId, claims, citations required; assistantMessageId, answerStatus, answer nullable |
| ClaimView | claimId, text, support, citationIds |
| CitationView | citationId, sourceType, sourceId, meetingId, sourceRevision, retrievalChunkId, claimIds |
| MessageEvidence | conversationId, messageId, meetingId, evidence |
| EvidenceView | citationId, sourceType, sourceId, sourceRevision, label, meetingTitle, preview, claimIds, navigation (target, precision); source-specific projection/preview restrictions are documented in ASSISTANT-EVIDENCE-RESOLUTION.md |

The answer status vocabulary is GROUNDED, PARTIAL, INSUFFICIENT_EVIDENCE and
FAILED. PROCESSING turn observations have an ACTIVE/EXPIRED lease and null
assistantMessageId/answerStatus; terminal observations have null leaseStatus
and the persisted assistant message ID/status. A stale completed answer has
state STALE_SOURCE. Unavailable message content is null with empty claims and
citations, not a fabricated answer. Both clients must preserve these distinctions.

POST /{conversationId}/messages requires the original Idempotency-Key and
a non-null question; replay of the same normalized question recovers the
durable outcome, while a different question conflicts. GET
/{conversationId}/messages/{messageId}/evidence resolves current authorized
sources only. GET /{conversationId}/turns is exact header lookup; the
branch-only /turns/by-key is retired in the integrated consumer contract.

## History

`GET /api/v1/assistant/conversations/{conversationId}`

- Existing zero-based `page` and `size` parameters remain supported (page 0–10000; size 1–50; default history size 50).
- Optional `beforeMessageId` is an exclusive older-history anchor. Do not
  combine it with an explicit `page` parameter. Its identity must belong to
  the authorized conversation. Invalid anchors return a scoped 404
  (`ASSISTANT_HISTORY_ANCHOR_NOT_FOUND`).
- Responses preserve ascending chronological order within each returned page.
  The canonical order uses creation timestamp and UUID as a tie-breaker.
  Offset is requested page × requested size, not lookahead limit.
- `nextBeforeMessageId` is the oldest returned message ID when `hasMore`
  is true, otherwise null. In anchored mode the legacy `page` field is 0;
  clients continue via the returned anchor, not the page field.
- `pendingTurn` is a nullable, read-only processing-turn projection.
- Anchoring prevents shifting offsets when newer messages are appended; it
  is not a persistent snapshot or permission grant.

## Turn observation

`GET /api/v1/assistant/conversations/{conversationId}/turns/{turnId}`

`GET /api/v1/assistant/conversations/{conversationId}/turns` with the
original `Idempotency-Key` header (exact lookup, not a collection listing).

Both return the common response envelope with the same bounded data object:
conversationId, turnId, state, leaseStatus, userMessageId,
assistantMessageId, answerStatus.

Processing exposes ACTIVE or EXPIRED lease status (database time); terminal
outcomes use null. The execution states PROCESSING, COMPLETED and FAILED
are preserved. STALE_SOURCE is a public visibility projection, not a new
persisted execution state. Current ownership and meeting-content access are
required; completed evidence is revalidated. No answer body, citation payload,
fingerprint, execution token or key is returned. Missing turn lookup returns
404 ASSISTANT_TURN_NOT_FOUND only after parent authorization; it is not proof
that a prior uncertain submission cannot be accepted.

Observation never executes inference, extends/reclaims a lease, consumes
submission quota, or changes durable business state.

## Explicit recovery

`POST /api/v1/assistant/conversations/{conversationId}/turns/{turnId}/recover`

An authorized client can explicitly recover a known durable turn even if its
original browser request state was lost. No request body or Idempotency-Key
header is required. Core resolves the original stored question and request
identity, verifies their integrity and reuses the existing reservation,
admission and lease fencing path. The reservation must still find the exact
turn; recovery never inserts a replacement turn or user message.

The response uses the existing message-submission outcome contract: 202 for
an active processing turn, 200 for an eligible completed result, 503 with
ASSISTANT_TURN_FAILED for terminal failure, or the existing stale-source and
authorization outcomes. Only an expired processing turn may be reclaimed.
Concurrent recovery attempts cannot execute another inference while the
reclaimed lease remains active. GET observations remain strictly read-only.
The explicit recovery command does not expose stored request keys or tokens.

## Error semantics

- 409 ASSISTANT_TURN_IN_PROGRESS, ASSISTANT_IDEMPOTENCY_CONFLICT,
  ASSISTANT_CONVERSATION_INACTIVE, ASSISTANT_SOURCE_STALE.
- 503 ASSISTANT_TURN_FAILED: confirmed terminal durable failure; replay does
  not restart inference.
- 503 ASSISTANT_UNAVAILABLE: capability/dependency unavailable; does not
  prove terminal failure.
- Existing 401/403/404, validation and 429 Retry-After conventions remain.

Question length is 4096 Unicode code points after existing Java trim
normalization. The durable fingerprint remains the SHA-256 of the normalized
question's UTF-8 bytes. Blank questions are rejected.

These additions are intended for the next Web conversation lifecycle wave;
no AI retrieval, cross-meeting scope or streaming contract is introduced.
