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

Each property has an `APP_ASSISTANT_ADMISSION_*` environment override in
`application.properties`. Startup rejects zero, negative, contradictory, or
out-of-bounds values. Admission is not silently disabled when the Assistant is
enabled.

## Transaction and Lock Order

Authorization and the initial conversation lookup happen before admission. The
short admission transaction rechecks authorization, then uses transaction-scoped
PostgreSQL advisory locks in this order:

1. `assistant-admission|global` for the shared active-turn decision.
2. `assistant-admission|user|<UUID>` for the user's rolling quota and active count.
3. `assistant-admission|meeting|<UUID>` for the meeting active count.
4. The `assistant_conversations` row with `FOR UPDATE` for idempotency and
   reclaim.

Conversation creation takes only the user advisory lock because it does not
   participate in active-turn capacity; it never holds a lock and then waits
   for the global ASK lock. This preserves the ASK ordering without needlessly
   serializing creation quota with inference admission. Existing result
   acceptance takes the meeting row lock before the conversation row lock and
   does not acquire these advisory locks, so the new path cannot invert that row
   lock order.

The global advisory lock deliberately serializes active-capacity decisions. A
single shared decision point is required when active capacity is derived from
durable turn rows rather than a separately maintained counter. It is released
before any AI call. No database transaction, row lock, or advisory transaction
lock spans inference.

## Atomicity and Idempotency

Within one transaction the service revalidates the conversation and meeting,
resolves the idempotency key, checks rolling ASK quota and active user/meeting/
global capacity, inserts the turn, and records the ASK event. A conversation
creation similarly inserts its event only after the conversation row. A rollback
removes both the business row and its event.

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
- `sme.assistant.admission.persistence.failures`.
- `sme.assistant.leases.expired` and `sme.assistant.leases.reclaimed`.

No metric label contains a user, meeting, conversation, turn, question,
prompt, token, provider response, or exception message.

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
