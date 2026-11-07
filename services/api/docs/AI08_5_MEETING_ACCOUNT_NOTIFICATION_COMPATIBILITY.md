# AI-08.5 — Meeting and Account Notification compatibility

**Prerequisite:** AI-08.4 secure Action Item delivery verified on GitHub API CI
at `61f92bc7bac61775df525f8424d6bc34de6ff3f8`. Work remains on
`api/action-items-integration`, with historical Flyway V1–V34 untouched.

## Scope and requirement mapping

- `FEAT-NOTIF-EMAIL-001..004`: security recovery, scheduled/invitation,
  material meeting change, cancellation emails.
- `FEAT-NOTIF-DELIVERY-001..004`, `FEAT-SET-NOTIF-001/002`:
  backend delivery, secondary status, retry, content minimization and opt-out.
- `BR-NOTIF-001..008`, `BR-MTG-009`, `BR-PART-004..007`,
  `ARCH-API-004..007`, `SEC-MAIL-008..014`:
  canonical meeting/participant authority, identity isolation,
  non-transactional SMTP, mandatory account emails, limited disclosures.

## Meeting email send-time policy

All five Meeting purposes use the generic worker's extended
`TransactionalEmailHandler.prepare(DeliveryContext)` with:
- entity type and authoritative recipient UUID from the durable row;
- current active organizational account and EXACT approved email equality;
- current `meetingEmailEnabled` preference (not just the enqueue-time value);
- current Meeting/membership validity and minimal rendered content;
- scheduled/rescheduled/cancelled event identity and supersession.

The shared worker supplies the persisted `dedupe_key` to the handler as
immutable *delivery context*. A schedule notification is current only if the
key has canonical form `meeting:{id}:{type}:{version}:{userId}` and no later
schedule/reschedule/cancel intent for the same meeting/user has a larger
canonical event version. Missing/invalid evidence fails closed.

**Important:** We do *not* require the enqueued event's version to equal the
current Meeting aggregate version. A title/description-only edit also changes
the aggregate version but must not invalidate a valid scheduled invitation.
Later material schedule changes create newer intents even for opted-out users.

Participant-added/removed emails retain historical membership semantics and
current membership checks. Removal remains content-minimal; it does not
restore access to the Meeting.

All these checks apply at SMTP handoff, including recovered `SENDING`
attempts. The existing worker attempt fencing, bounded retries and SMTP
at-least-once limits stay unchanged.

## Account and recovery boundaries

`ACCOUNT_SETUP` and `PASSWORD_RECOVERY` are mandatory security purposes.
Their token lifecycle, account eligibility, sender configuration and handlers
are not changed. Tests explicitly create `user_preferences` with
`meeting_email_enabled=false` and `action_item_email_enabled=false`
before delivering each security email, demonstrating that opt-out does not
affect mandatory account communication.

## Verification and operational limits

`MeetingEmailSendTimeIntegrationTests` uses independent real PostgreSQL/HTTP
transactions, the real shared worker, and mocked `JavaMailSender` to verify:
- opt-out after enqueuing scheduled/cancelled/add/remove messages;
- stale SENDING schedule superseded by a newer material reschedule;
- metadata-only edit preserves still-useful scheduling email;
- changed email and address recycling never reroute old recipient mail;
- inactive accounts cannot receive queued Meeting notifications;
- sensitive Meeting details never appear in outgoing templates.

Existing Meeting supersession, participant membership, Account Setup,
Password Recovery, Notification preferences, Action Items and worker tests
must continue passing without migrations or duplicated SMTP infrastructure.

The narrowly unavoidable race between final eligibility check and SMTP
acceptance still exists: exactly-once or recall of an already accepted email
is NOT claimed. All task acceptance is gated on full GitHub API CI
`./mvnw -B -ntp verify` success **at the final pushed branch HEAD**.

AI-08.6 remains the final comprehensive cross-module acceptance task.
