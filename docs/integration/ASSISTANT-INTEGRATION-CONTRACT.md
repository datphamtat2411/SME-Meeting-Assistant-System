# Wave 04 — Assistant integration contract

Applies to INT-08/09/10 on pre-integration-develop. This maps existing canonical
requirements (API-CON, API-IDEM, API-PAGE, API-EP-AST, BR-RAG, SEC-RAG,
SEC-LLM and AI-RAGAUTH) to both repository consumers. It does not replace
[conversation reliability](../../services/api/docs/ASSISTANT-CONVERSATION-RELIABILITY.md),
[admission](../../services/api/docs/ASSISTANT-ADMISSION.md) or
[evidence resolution](../../services/api/docs/ASSISTANT-EVIDENCE-RESOLUTION.md).
Core is authoritative; Web and Mobile retain their own presentation.

## Public transport

All paths below are relative to /api/v1/assistant/conversations.

| Operation | Canonical semantics |
| --- | --- |
| GET collection, POST collection | List owned authorized conversations; create with an owner-scoped Idempotency-Key on both repository clients. Legacy unkeyed creation remains compatible. |
| GET /{conversationId} | Current authorized history, nullable pendingTurn and nextBeforeMessageId. Exclusive beforeMessageId anchor or explicit offset page; stable order. |
| POST /{conversationId}/messages | One immutable normalized question intent and key; replay does not create a second turn. |
| GET /{conversationId}/turns | Exact lookup by Idempotency-Key header, never URL. |
| GET /{conversationId}/turns/{turnId} | Read-only durable turn projection; no request key required. |
| POST /{conversationId}/turns/{turnId}/recover | Explicit recovery of the same durable turn; active lease is not reexecuted. |
| GET /{conversationId}/messages/{messageId}/evidence | Canonical current evidence for the persisted answer; not arbitrary source lookup. |

Question normalization matches existing Java String.trim and String.isBlank
behavior. The limit is 4096 Unicode code points after normalization, not UTF-16
units or grapheme clusters. Blank questions are rejected. Existing SHA-256
request fingerprint and V67 owner-scoped creation uniqueness are unchanged.

## Reliability and authorization

- Same normalized creation intent/key resolves the same row and consumes quota
  once; a conflicting payload is rejected. Web retains unresolved keys for the
  exact meeting/title intent within its authenticated session.
- Persisted content rights and active-account checks are re-evaluated after
  local/global admission waits and before model invocation; management metadata
  visibility is not content access. Current access is required for replay.
- Durable PROCESSING with ACTIVE lease is observed; EXPIRED lease may be
  explicitly recovered. Core fencing prevents old claims publishing over a
  newer claim. Terminal failure is not transport uncertainty; stale-source
  results are not current answers. Insufficient evidence is a valid answer
  outcome. Honor Retry-After; no blind resend or fabricated success.
- Mobile can discover a server-owned pending turn without the original local
  request. Once its ID is known, use ID observation and explicit ID recovery.
  Key lookup remains necessary before durable identity is known.
- Use server nextBeforeMessageId; revalidate older pages rather than retain an
  unverified prefix after source redaction. Protect state across session changes
  and selection races. No new shared persistent storage of questions or keys.

## Retrieval and evidence

- Preserve existing model/index stack and single-meeting scope. Scope returned
  by the authorization provider must exactly match the requested authorized
  scope, not merely share its ID. Validate scope before contextualization sends
  prior dialogue to the model; empty/expired scopes cannot send dialogue.
- Existing authorized dense/sparse retrieval, reranking, final source checks,
  grounding and redaction remain authoritative. No unverified evidence enters
  generation. Clients do not confer permission through their own DTOs.
- For Transcript, Summary, Decision and Action Item, both clients use the
  canonical message evidence endpoint. Mobile retains detailed artifact
  presentation, checks origin/message/citation/source identity and revision,
  and verifies the canonical proof again after reading the artifact.
  Permission loss and source revision change fail closed. No invented segment
  timing or unrelated source substitution.

## Acceptance boundary

No new endpoint alias, migration, model, CI relaxation or redesign. Real
PostgreSQL/MockMvc tests use controlled inference; browser and Flutter fixtures
exercise public-contract behavior. They are not proof of two live devices or
live model/vector-store quality. Global Assistant is a separate open product
decision; deployed compatibility inventory, Vietnamese quality evaluation and
full live/visual acceptance remain INT-13/14/15. Server fencing guarantees one
canonical result, not exactly-once external provider execution. Fully
terminated client processes do not persist unresolved Web creation intents.
