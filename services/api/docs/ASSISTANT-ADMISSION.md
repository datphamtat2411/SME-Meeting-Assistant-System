# Assistant Distributed Admission Control

## Threat and Scope

An authenticated user can otherwise create many conversations and bypass the
existing per-conversation active-turn constraint. Each accepted Assistant ASK
now passes a PostgreSQL transaction before inference. Conversation creation is
also quota-controlled. Reads and replayed idempotent requests are not charged.

The durable `assistant_turns` state remains the source of truth for active
inference. A turn is active only while it is `PROCESSING` and its
`claim_expires_at` is later than the PostgreSQL wall clock.

## Configuration

The defaults are engineering starting points, not capacity guarantees:

| Property | Default |
| --- | ---: |
| `app.assistant.admission.max-ask-requests-per-user` | 12 |
| `app.assistant.admission.ask-window-seconds` | 600 |
| `app.assistant.admission.max-active-turns-per-user` | 2 |
| `app.assistant.admission.max-active-turns-global` | 20 |
| `app.assistant.admission.max-active-turns-per-meeting` | 5 |
| `app.assistant.admission.max-conversation-creations-per-user` | 20 |
| `app.assistant.admission.conversation-creation-window-seconds` | 3600 |
| `app.assistant.admission.lock-wait-ms` | 1500 |

Each property has an `APP_ASSISTANT_ADMISSION_*` environment override in
`application.properties`. The lock-wait setting is validated to 50–5000 ms;
the other settings retain their existing bounds. Startup rejects zero,
negative, contradictory, or out-of-bounds values. Admission is not silently
disabled when the Assistant is enabled.

## Transaction and Lock Order

Authorization and the initial conversation lookup happen before admission. The
short admission transaction applies a transaction-local PostgreSQL
`lock_timeout`, then rechecks ownership, meeting identity, current
readability, and active conversation status while holding the conversation row.
For a new or reclaimed ASK, its lock order is:

1. `assistant_conversations` row with `FOR UPDATE`.
2. `assistant-admission|user|<UUID>` for the user's rolling quota and active count.
3. `assistant-admission|meeting|<UUID>` for the meeting active count.
4. `assistant-admission|global` for the final shared active-turn decision.
5. Final global capacity check and the already-scoped durable writes.

Terminal/live idempotent replays and same-conversation live-busy conflicts stop
after the conversation authorization/state checks and never request the global
lock. Expired same-key reclaim follows the local scopes and then the global
scope without another ASK event. Conversation creation takes only the user
advisory lock and remains independent of the global ASK lock.

No local advisory lock, authorization lookup, cleanup, quota pruning, or
remote request is performed while waiting for or holding the global lock.
The global critical section contains only the bounded final capacity decision
and the durable admission writes. The transaction-local timeout applies to the
conversation row and advisory lock waits; timeout failures are safe HTTP 503,
not policy 429 responses.

The global advisory lock deliberately serializes active-capacity decisions. A
single shared decision point is required when active capacity is derived from
durable turn rows rather than a separately maintained counter. It is released
before any AI call. No database transaction, row lock, or advisory transaction
lock spans inference. Result acceptance takes the meeting row `FOR SHARE` first
and then the conversation row `FOR UPDATE`; ASK admission does not take a
meeting row lock, so it introduces no meeting-row/conversation-row cycle.

## Atomicity and Idempotency

Within one transaction the service revalidates the conversation and meeting,
resolves the idempotency key, checks rolling ASK quota and scoped user/meeting
capacity, serializes the final global capacity decision, inserts the turn, and
records the ASK event. A conversation creation similarly inserts its event only
after the conversation row. A rollback removes both the business row and its
event.

Terminal or live same-key requests return the existing turn without charging.
An expired same-key turn is reclaimed with a new claim token without another
ASK event. A different question under the same key remains a 409 conflict.
Provider failures still persist a sanitized `FAILED` answer and retain the ASK
quota event because provider work was already consumed.

## Recovery and Fencing

The active count excludes expired leases, so a crashed process frees capacity
after the durable lease deadline without in-memory cleanup. A later same-key
request may reclaim the turn. The claim token remains the fencing authority:
the stale worker cannot persist after the newer claim owns the turn. Successful
completion and failure clear the lease normally. Authorization and source
revision checks remain unchanged and still fail closed.

## HTTP and Retry Behavior

Policy rejection is HTTP 429 using the existing `RATE_LIMIT_EXCEEDED` response
envelope, `Cache-Control: no-store`, and `Retry-After`. Rolling quota hints use
the oldest event's expiration. Concurrency hints use the earliest observed live
lease where available; they are advisory and do not promise capacity at that
instant. Admission database/transaction failures return the existing safe 503
envelope and never invoke the AI gateway.

## Observability

The private metrics boundary exposes bounded Assistant measurements:

- `sme.assistant.admission.accepted` by `ASK` or `CONVERSATION_CREATE`.
- `sme.assistant.admission.replayed`.
- `sme.assistant.admission.rejected` by fixed policy reason.
- `sme.assistant.admission.active` as a database-derived live-turn gauge.
- `sme.assistant.admission.latency` by operation.
- `sme.assistant.admission.lock.wait` by fixed `CONVERSATION`, `USER`,
  `MEETING`, or `GLOBAL` scope.
- `sme.assistant.admission.lock.timeouts` by the same fixed scope.
- `sme.assistant.admission.global.critical.section` for time holding the
  global admission lock through commit or rollback.
- `sme.assistant.admission.persistence.failures`.
- `sme.assistant.leases.expired` and `sme.assistant.leases.reclaimed`.

No metric label contains a user, meeting, conversation, turn, question,
prompt, token, provider response, or exception message.

The result-acceptance graph is `meeting row FOR SHARE → conversation row FOR
UPDATE`; meeting source mutations use the meeting row serialization point.
Admission is `conversation row → user advisory → meeting advisory → global
advisory` and does not acquire that meeting row, so the two paths have no
cycle. A PostgreSQL deadlock remains a database failure requiring diagnosis;
the application does not retry it or relabel it as a quota rejection.

## Retention and Tuning

`assistant_admission_events` contains only UUID references, event type, and
timestamp. The guard opportunistically deletes rows older than the largest
configured window for the current user. Operations should also run a bounded
periodic maintenance statement for inactive users, retaining at least the
largest configured window and no more than the validated seven-day maximum:

```sql
DELETE FROM assistant_admission_events
 WHERE occurred_at <= clock_timestamp() - interval '7 days';
```

Tune limits from measured provider latency, PostgreSQL pool headroom, model
cost, and observed rejection/lease metrics. Validate changes in a disposable
environment with overlapping Core instances before production rollout.

## Requirement Evidence

This design addresses authenticated/resource-scoped controls required by
`SEC-RATE-002`, performs checks before AI work as required by `SEC-RATE-003`,
uses centrally configurable limits under `SEC-RATE-006`, and preserves the
PI-02 durable turn/idempotency/source-safety contract. The deterministic
PostgreSQL tests are not evidence that PI-05 live Core/AI/Qdrant infrastructure
scenarios have run.
