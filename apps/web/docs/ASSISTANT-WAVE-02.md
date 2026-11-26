# Assistant Wave 02

## WEB-AST-04
Core turn status is authoritative. Accepted requests use turn-ID observation;
uncertain submissions retain their normalized payload and idempotency key in
authenticated feature memory for exact-key lookup and explicit replay.
Pending turns are discovered from fresh detail and expired leases require a
user-initiated recover command. Read-only polling has a 60-second budget
and 1/2/4/5-second backoff; transport uncertainty is not terminal failure.
Navigation stops observation and never creates an operation. URL search
identities are validated and opening a conversation resets old history before
enabling protected reads. Core's conversation meeting is authoritative.
Older history follows server continuation anchors. On terminal completion
the infinite query rebuilds its loaded window through fresh anchor reads.
Security-sensitive refresh discards the old window rather than overlaying it.

Creation has no server idempotency contract; uncertain outcomes refresh the
authorized list and require confirmation before another create. Lost browser
intent with no durable pending turn cannot establish the previous outcome.

## WEB-AST-05
Structured meeting filters reuse the Meeting Management filter component and
canonical list/option contracts. Search and prospective scope maintain
independent queries. The selected scope uses an independent authorized
meeting-detail read. Selecting a prospective meeting does not change an
existing conversation's canonical scope.

## API-AST-S02
See services/api/docs/ASSISTANT-EVIDENCE-RESOLUTION.md. The typed Web adapter
validates source identity, current revision metadata, claim associations and
scope; it does not independently cache protected source previews. Source
navigation is section-level, not fabricated exact transcript provenance.

## Scope
No product workspace redesign, streaming, cross-meeting retrieval, new AI
infrastructure, or browser-persisted protected content. Wave 03 owns evidence
interaction and final presentation. Live Web-to-Core-to-AI verification remains
a separate integration gate.

## Targeted lifecycle and security corrections

- Idempotency conflict is a rejected intent, independent of transient lookup or status errors; observing a conflicting durable turn does not accept the rejected question.
- Status retry deadlines are scoped to the durable turn and survive conversation navigation and observation cancellation in authenticated feature memory.
- A changed authoritative pending identity displaces old recovery controls. Observe the old identity and then the replacement before allowing recovery of the current turn.
- Confirmed canonical meeting-detail denial uses the Assistant meeting containment boundary, including history reads already in flight. Creation checks the current selected meeting projection at the action boundary; metadata visibility is not a content grant.
- Infinite history commits may sanitize earlier pages with redactions observed during the same reset generation. Session, resource and explicit reset fences remain strict; obsolete reads cannot restore source content.
