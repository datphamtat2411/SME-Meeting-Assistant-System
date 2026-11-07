# AI-08.6 — Final Action Items × Notification cross-module acceptance

**Target branch:** `api/action-items-integration`
**Baseline:** AI-08.5 commit `d81780d6ffa8eb9a498ae4e4c98fa753a312394d`
**Purpose:** Verify both recovered modules as **one** production-oriented
feature, rather than accepting independently green component tests.

This is an acceptance-gate task, not a new feature. No historical Flyway
migration, API contract, email purpose, queue implementation, or business
authorization rule is altered by AI-08.6.

## Source-of-truth acceptance matrix

| Requirement / invariant | Proof from current test suite |
|---|---|
| `BR-NOTIF-001/002/008`, `FEAT-NOTIF-DELIVERY-002/003`: SMTP is secondary; business commits survive failures | `ActionItemsNotificationsCrossModuleAcceptanceIntegrationTests.smtpOutageDoesNotUndoMeetingOrActionAndRetryUsesSameDeliveryIdentity`; `ActionItemSecureDeliveryIntegrationTests.smtpTransientFailureRetriesSameBusinessEventWithoutDuplicateIntent`; `MeetingNotificationSupersessionIntegrationTests` |
| `BR-NOTIF-003/004`, `ARCH-API-004/005/006/007`: business event → canonical audit → one durable intent | `ActionItemAssignmentNotificationIntegrationTests` (manual, proposal confirmation, A→B→A, concurrent idempotency); `ActionItemsNotificationsCrossModuleAcceptanceIntegrationTests.aiHandoffIsOnlyProposalUntilHumanConfirmationThenOneOfficialEmail`; `MeetingParticipantNotificationIntegrationTests` |
| `BR-NOTIF-005`, `BR-MTG-009`, `SEC-MAIL-012/014`: minimal content, no transcript or sensitive task/meeting leakage | `ActionItemsNotificationsCrossModuleAcceptanceIntegrationTests.scheduledMeetingAndOfficialAssignmentShareOneWorkerWithoutLeakingMeetingContent`; `ActionItemSecureDeliveryIntegrationTests.officialAssignmentPassesSendTimeChecksAndSendsOnlyMinimalContent`; `MeetingEmailSendTimeIntegrationTests` |
| `BR-NOTIF-006`, `FEAT-SET-NOTIF-*`: independent optional preferences; security email is mandatory | `ActionItemsNotificationsCrossModuleAcceptanceIntegrationTests.meetingAndActionItemPreferencesAreIndependentForTheSameUsers`; `MeetingEmailSendTimeIntegrationTests`; `AccountSetupIntegrationTests.smtpWorkerDeliversDedicatedTokenWithoutPersistingItsPlaintext`; `PasswordRecoveryIntegrationTests.recoveryEmailUsesSharedWorkerAndRandomTokenWithVerifierOnly` |
| `BR-NOTIF-007`, `SEC-MAIL-008/009`: current recipient ID/address and configured sender; no CRLF header abuse | `ActionItemSecureDeliveryIntegrationTests.changedEmailAndInactiveAccountCannotReceiveStaleMail`; `MeetingEmailSendTimeIntegrationTests.recipientEmailChangeAndAddressRecyclingCannotRetargetOldQueuedNotice`; `TransactionalEmailDeliveryWorker` canonical address validation |
| `FEAT-NOTIF-EMAIL-002/003/004/005`: meeting schedule/change/cancel and official assignment in the same worker | `ActionItemsNotificationsCrossModuleAcceptanceIntegrationTests` (mixed purpose sends, supersession, cancellation, independent worker claims) |
| No AI proposal is official until human confirmation; original batch retry is idempotent after confirmation | `ActionItemsNotificationsCrossModuleAcceptanceIntegrationTests.aiHandoffIsOnlyProposalUntilHumanConfirmationThenOneOfficialEmail`; `ActionItemProposalSinkIntegrationTests`; `ActionItemAssignmentNotificationIntegrationTests` |
| Immutable assignment event, A→B→A, terminal revocation, later reopen fails closed | `ActionItemSecureDeliveryIntegrationTests.reassignmentAtoBtoASupersedesOldQueueAndDoesNotResurrectFirstA`; `completeThenReopenCannotResurrectOriginalEmailOrAssignmentVersion`; `ActionItemAssignmentFlywayUpgradeIntegrationTests`; `AssignmentRevocationFlywayUpgradeIntegrationTests` |
| Conditional HTTP state/authorization rejects ghost assignments and notifications | `ActionItemsNotificationsCrossModuleAcceptanceIntegrationTests.unauthorizedAndStaleHttpRequestsNeverManufactureExtraAssignmentOrMeetingMail`; `ActionItemsIntegrationTests`; `MeetingNotificationSupersessionIntegrationTests` |
| Shared queue uses claim fencing; independent workers do not claim same intent twice | `ActionItemsNotificationsCrossModuleAcceptanceIntegrationTests.independentWorkersCannotDoubleClaimSameBusinessEvent`; `ActionItemSecureDeliveryIntegrationTests.staleSmtpAttemptCannotOverwriteNewlyClaimedGeneration`; `NotificationRecoveryIntegrationTests` |
| SMTP/mock provider failure cannot leave an orphan action/meeting business mutation | `ActionItemAssignmentAtomicRollbackIntegrationTests` (intent persistence failure); `ActionItemsNotificationsCrossModuleAcceptanceIntegrationTests.smtpOutageDoesNotUndoMeetingOrActionAndRetryUsesSameDeliveryIdentity`; `MeetingParticipantNotificationIntegrationTests` (transaction rollback) |
| V1–V34 append-only Flyway and upgrade data preservation | `ActionItemFlywayUpgradeIntegrationTests`; `NotificationPreferencesFlywayUpgradeIntegrationTests`; `AssignmentRevocationFlywayUpgradeIntegrationTests` |
| Default-off assignment gates block accidental assignment SMTP delivery | `ActionItemAssignmentFeatureGateIntegrationTests`; `ActionItemDeliveryGateFailClosedIntegrationTests` |

## Seven new real cross-module tests

`ActionItemsNotificationsCrossModuleAcceptanceIntegrationTests`
uses real MockMvc HTTP transactions, PostgreSQL through
`PostgresTestConfiguration`, the actual single
`TransactionalEmailDeliveryWorker`, and mocked `JavaMailSender`.
The test context **explicitly enables both assignment feature gates**,
but globally scheduled polling is disabled; no external SMTP is called.

1. Meeting scheduled and Action Item created: both modules create independent
   intents, then the single worker sends 3 minimal messages to the correct users.
2. Two users with opposite optional notification preferences receive only
   their opted-in purpose; meeting/action flags do not leak across modules.
3. Meeting rescheduled then cancelled, with Action Item completed: stale schedule
   and assignment intents are skipped, canonical state and cancellation emails
   remain valid and independent.
4. SMTP outage on one purpose: Meeting and Action Item retain their committed
   state; another purpose sends; bounded retry reuses the same delivery identity.
5. Real MI-G7 proposal acceptance, human assignee correction and confirmation:
   no proposal email before confirmation; exactly one official email afterward;
   immutable batch replay after human confirmation causes no new event/intent.
6. Two concurrent independent worker claims of distinct purposes: each
   is claimed/sent once and the shared queue is drained.
7. Unauthorized actor and stale ETag attempts: no ghost meeting changes,
   assignment events or notifications.
Existing independent tests additionally cover account setup/recovery, feature
gates, migration upgrades, email tampering, A→B→A and attempt fencing.

## Release-quality requirements and explicit limitations

- **Completion gate:** full GitHub API `./mvnw -B -ntp verify` on the
  **exact pushed branch HEAD**, with 0 failures/errors. The scope includes
  independent database/HTTP tests, not merely Java compilation or Mockito
  unit tests.
- No skipped critical notification tests may be silently accepted as
  evidence. Report all full-suite skipped counts.
- After success, compare branch HEAD with `develop`, verify clean
  forward-only migration sequence, and record the final commit/CI run in
  the task handoff. Merging remains AI-07, not AI-08.6.
- SMTP is **at-least-once**. PostgreSQL does not transactionally commit a
  network SMTP handoff; a crash or pause can duplicate an already accepted
  message. The 5-minute claim generation fence only prevents stale workers
  from overwriting newer database results.
- No live Gmail credentials or production provider are used in tests.
  Actual deployment configuration, secrets, monitored observability and
  operational email acceptance remain separate release gates.
- `FEAT-NOTIF-EMAIL-006` reminders are an optional extension and are not
  silently treated as implemented.
- Running this acceptance suite does **not** automatically enable
  assignment SMTP in production. Both feature gates default OFF and
  require separately approved deployment configuration.

## Merge/handoff

Once the final HEAD is green, hand off to **AI-07** for final integration
review, branch/PR reconciliation, ownership, requirements traceability,
and merge decision. Do not merge this branch as part of AI-08.6.
