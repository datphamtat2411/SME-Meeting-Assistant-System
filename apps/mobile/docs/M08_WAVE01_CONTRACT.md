# M08 — Wave 01 authentication account-flow foundation

## Ownership

- AuthPage coordinates public workflow navigation; login, recovery and
  credential establishment own separate transient form state.
- The shared submission controller tracks single flight, typed failure,
  retry deadline and completion, never the password or capability.
- Authentication and current identity remain owned by AuthSessionCoordinator.
  No new session store, state management package, or endpoint was added.
- The login form stays mounted during interactive login and identity checking.
  Protected navigation remains gated on verified identity.

## Public operation contracts

Recovery and reset succeed only with a valid common envelope and nonblank
data.message; account setup succeeds only with null data. The repository
returns Future<void> rather than exposing generic response payloads.
Password and capability values are not trimmed or normalized. Only the
email is trimmed. New password validation counts Unicode code points (15–128)
and confirmation compares the exact input. Backend policy is authoritative.

These three operations use the dedicated anonymous transport path and do
not trigger access-token renewal, authorization changes, or automatic
mutation replay. Localized feedback classifies structured errors without
displaying raw server messages. Ambiguous reset/setup outcomes are not
resubmitted from the same workflow; recovery can be explicitly retried.

## Mandatory reconciliation boundary

ApiClient.reconcileSession() closes protected access before awaiting a fresh
server identity probe. Results distinguish no session, verified, invalidated,
denied and unavailable. A valid unchanged session retains its credentials;
identity ownership mismatches fail closed. A newer verification requirement
cannot be satisfied by an older successful probe. Ordinary identity reloads
and protected requests are fenced by the protected-access generation as well
as credential lifecycle. Pending refresh rotation is shared, not duplicated.

Protected navigation and local media recovery memoization are keyed to the
verified access scope. The durable media owner key remains unchanged.
Temporary verification failure keeps protected access closed and offers
the existing safe identity-retry path. Logout supersedes in-flight verification.

Wave 02 owns integration of reconciliation with confirmed or uncertain
password-reset completion and the finished recovery/setup/reset workflows.
Wave 03 owns Android capability links and dispatch. Neither is implemented
as part of this foundation. The existing manual entry points remain usable.

## Verification

Use the existing Mobile CI workflow with the committed SDK and dependency
pins. Its gates include formatting, analysis, complete Flutter tests,
Android native checks, credential durability and debug APK build.
CI is automated test evidence, not a live deployment or device test.
Do not mark this wave accepted until the final implementation revision
passes its applicable verification gates.
