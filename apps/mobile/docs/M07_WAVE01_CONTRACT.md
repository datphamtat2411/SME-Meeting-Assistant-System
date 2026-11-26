# M07 Wave 01 — Assistant data contract

The mobile Assistant repository uses the existing authenticated Core API client.
It is stateless and registered in the application dependency holder. Wave 02
owns conversation and chat controllers, pending intent recovery, and UI.

- Each conversation has exactly one meeting scope. The server authorizes both
  conversation ownership and current meeting-content access. No Mobile role
  receives a privileged Assistant path.
- List: GET /assistant/conversations (zero-based page, default size 20).
  The response data is an array; a full page may have a successor, not a
  guaranteed successor. There are no fabricated totals.
- Create: POST /assistant/conversations (meetingId, optional title); 201.
  No creation idempotency guarantee; do not automatically replay creation.
- Detail: GET /assistant/conversations/{id} (default size 50).
  The returned page/size/hasMore are authoritative. Page zero is the latest
  window; within each page messages are chronological, with stable database
  UUID tie-breaking. Offset pagination is not a snapshot across requests:
  Wave 02 must reconcile/merge by message identity.
- Submit: POST /assistant/conversations/{id}/messages (question and caller
  owned Idempotency-Key). 200 means COMPLETED; 202 means PROCESSING.
  A processing response has no assistant message or completed answer.
  Use the same normalized question and key for the same intent; replay can
  reclaim an expired lease and is not a read-only poll.
- 409 ASSISTANT_SOURCE_STALE is explicit stale evidence; other 409 outcomes
  may represent conflicts. 503 is not proof of a terminal turn: the public
  error envelope does not expose a TurnView. Authorization may be reevaluated
  after a durable write, so even 404/403 cannot always prove non-execution.
  Failure category and remote mutation outcome are separate. A definitive
  rejection of an attempt does not prove an earlier same-key attempt failed.
- The submission transport uses a 60-second dispatch and overall deadline
  with the existing response-body bound. Timeouts are not server cancellation.
- Pass a captured authenticated session scope through every operation.
  Do not reuse commands or results after session change. Repository methods
  never generate keys, schedule retries, or persist chat content.
- Message visibility is independent of answer quality. SOURCE_UNAVAILABLE
  carries no content, claims or citations. Evidence identifiers and revisions
  are canonical; chunk IDs are opaque, not transcript segment IDs.
- All supported evidence references are single-meeting and internally linked.
  The client does not independently verify the actual evidence or expand
  retrieval scope. No admin UI, cross-meeting, streaming, offline persistence,
  or new public endpoint is part of Wave 01.

The backend correction preserves the DTOs and existing authorization and
admission logic. History lookahead changes the fetch limit, never the offset.
