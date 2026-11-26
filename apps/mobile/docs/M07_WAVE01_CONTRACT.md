# M07 — Assistant data and recovery contract

The mobile Assistant uses the shared authenticated Core API client. Its
session-owned workspace keeps pending commands in memory, separate from
canonical server messages. Administrators use the same member-facing flow.

- Each conversation has exactly one meeting scope. Ownership and current
  meeting-content access are enforced on the server, including on replay.
- List: GET /assistant/conversations (zero-based page, default size 20).
  A full page may have a successor; overlap signals that a list refresh is
  required. No fabricated totals.
- Create: POST /assistant/conversations (meetingId, optional title); 201.
  Mobile supplies an Idempotency-Key per intent. The server binds the key
  digest to the owner and normalized creation intent for the lifetime of the
  conversation. Replay does not consume another creation quota event;
  a different intent with the same key conflicts. Older callers may omit
  the header, but then cannot rely on replay safety.
- Detail: GET /assistant/conversations/{id} (default size 50). Page zero is
  the latest window, messages chronological with stable UUID tie-breaking.
  For earlier messages, Mobile supplies beforeMessageId from the oldest
  loaded message and page=0. The anchor is conversation-scoped; new messages
  do not shift its boundary. Legacy offset pagination remains supported.
- Submit: POST /assistant/conversations/{id}/messages with the question
  and caller-owned Idempotency-Key. 200 means COMPLETED; 202 means PROCESSING.
  A replay may reclaim expired work and is not a read-only poll.
- Status: GET /assistant/conversations/{id}/turns/by-key with the same key
  in the header. A successful response contains turn and recoveryEligible.
  This never starts inference. PROCESSING, COMPLETED, FAILED and STALE_SOURCE
  are explicit; only completed visible answers have answer/evidence.
  Explicit same-key retry may reclaim an expired lease. A missing status
  does not establish that an in-flight POST cannot commit.
- Error category and remote mutation outcome remain independent. Do not
  treat 503, timeout, transport error, or authorization after write as proof
  that no write occurred. Respect Retry-After; never replay a mutation
  automatically.
- Submission has bounded 60-second dispatch/overall timeouts. A client
  timeout is not server cancellation.
- Session changes fence reads and mutations. Conversation selection also
  fences history responses. Leaving the tab/backgrounding clears visible
  history; activation and invalidation fetch authoritative history again.
  No persisted chat or pending intent data is added to Mobile.
- SOURCE_UNAVAILABLE carries no content, claims or citations. The client
  displays source type, revision and canonical claim links. Chunk IDs are
  opaque, not transcript segment IDs. Evidence deep links require their own
  verified navigation contract.

The backend requires migration V67 before keyed creation can be used.
API HTTP/PostgreSQL tests and Flutter tests cover contract and recovery
behavior; they do not constitute a live Core API–AI Core–Qdrant check.
Live verification requires a configured authorized test deployment, a
meeting with indexed content, and an approved provider. Verify create/replay,
grounded and insufficient answers, history continuation during new messages,
read-only status after a lost response, and revoked access/source revision
redaction using real service responses. Do not record secrets or protected
meeting content in test evidence.
