# Assistant conversation reliability — Wave 01

This package-level note documents the additive v1 Assistant conversation contracts.
Core API continues to own conversation authorization, durable turn identity,
admission, lease ownership, and canonical result persistence. AI inference
remains synchronous and outside the database transaction.

## History

`GET /api/v1/assistant/conversations/{conversationId}`

- Existing zero-based `page` and `size` parameters remain supported (size 1–50).
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
