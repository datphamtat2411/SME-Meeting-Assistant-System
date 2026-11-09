# AIMI-T08 Meeting Intelligence Rollout

This runbook covers the controlled migration of Meeting Intelligence Summary,
Decision, and Action Item inference to `openai/gpt-6-luna` with one shared
`reasoning.effort=high` policy. It does not change transcript correction, ASR,
Core ownership, canonical acceptance, or the T01-T07 algorithms.

## Readiness States

Report these states separately. A green state must never imply that another
state is green.

| State | Meaning | Required evidence |
| --- | --- | --- |
| Implementation | Code, contracts, defaults, and focused tests are complete | Scoped review, test output, `git diff --check` |
| Deterministic verification | Existing unit, contract, storage, broker, mTLS, and acceptance checks pass | Versioned test/build evidence with no live provider call |
| Staging | Isolated deployment, credentials, routes, leases, storage, recovery, and alerts are verified | Approved synthetic staging record |
| Provider compatibility | GPT-6 Luna accepts the exact strict payload and bounded budgets | Authorized finite-call provider report |
| Model quality | Vietnamese quality is independently reviewed | T07 compatible dataset, double review, adjudication, and gate report |
| Production authorization | Privacy, security, operations, deployment, and release owners approve | Recorded release decision |

The committed configuration is not a quality claim. T07 model quality remains
`UNESTABLISHED` until reviewed real predictions exist. Production inference and
Core dispatch remain disabled by default.

## Committed Defaults

The AI examples and typed settings use:

- model `openai/gpt-6-luna`;
- shared `AI_MEETING_INTELLIGENCE_REASONING_EFFORT=high`;
- context/input/output limits `131072` / `98304` / `32768` tokens;
- stage-wide estimated input plus reserved completion ceiling `2000000` tokens;
- provider and MI worker deadlines of `120` and `1800` seconds;
- no provider fallback and no automatic reasoning downgrade;
- all MI worker, inference, feature, Core dispatch, and result-acceptance gates off.

The versioned migration record is
`tests/evaluation/fixtures/meeting-intelligence-model-config-v1.json`.
Historical GPT-5 mini artifacts are immutable and are not rewritten by this
migration.

## Activation Prerequisites

1. Review the implementation and run the focused AI/API/infra tests. Do not
   enable a feature flag to make a test pass.
2. Provision a separate `mi-worker` client certificate, Core result-acceptance
   bearer token, broker user, and storage user. Do not reuse `ai-worker`, Core
   publisher, broker bootstrap, or storage administrator credentials.
3. Mount only the files listed by
   `infra/local/secure-integration/intelligence-worker.env.example`. Container
   paths and host paths are not interchangeable.
4. Verify the dedicated quorum work/dead queues and exact route with
   `broker.py --intelligence`. The MI dead queue has no transcription consumer
   and no automatic replay path.
5. Verify Core's storage role can create source snapshots and read accepted
   results, but cannot write or delete MI result objects. The MI worker can read
   approved source snapshots and create its stage result only.
6. Verify private mTLS, hostname validation, correlated publisher confirms,
   mandatory returns, HTTPS storage trust, immutable create-only result writes,
   lease renewal, cancellation, duplicate acceptance, and reconciliation.
7. Keep `APP_MEDIA_INTELLIGENCE_ENABLED`,
   `APP_MEDIA_INTELLIGENCE_DISPATCH_ENABLED`,
   `APP_MEDIA_INTELLIGENCE_INFRASTRUCTURE_VERIFIED`, and
   `APP_MI_INTERNAL_RESULT_ENABLED` false until the preceding evidence is
   recorded. Enabling transport alone must not activate dispatch.

## Staging Checks

Use synthetic, non-sensitive data only. Do not use a developer `.env`, shared
Development CA, production bucket, production broker, or unrestricted output
directory.

```sh
docker compose --env-file "$CONFIG/compose.env" \
  -f infra/local/secure-integration/compose.yaml config --quiet
python3 infra/local/secure-integration/broker.py verify \
  --container "$BROKER_CONTAINER" --vhost "$BROKER_VHOST" --intelligence
```

Run the scoped deterministic tests from the repository instructions. A live
provider compatibility check requires `RUN_MEETING_INTELLIGENCE_LIVE=1`, explicit
operator opt-in, privacy-approved data, finite calls and budget, valid external
credentials, and an output path outside the repository. It never enables the
production worker.

Record only bounded identifiers, configuration fingerprints, model/provider
names, counts, durations, token counts, reported cost when supplied, attempts,
failure categories, queue state, lease state, result digests, and approval IDs.
Never retain transcript text, raw prompts, raw provider bodies, credentials,
cookies, claim tokens, object URLs, or reasoning traces.

## Monitoring and Response

Alert on:

- invalid startup configuration or missing provider credentials;
- `AUTHENTICATION`, `CONFIGURATION`, `UNSUPPORTED_PARAMETERS`, `CONTEXT_BUDGET`,
  `RATE_LIMIT`, `TIMEOUT`, `PROVIDER`, `INTEGRITY`, or `MALFORMED_OUTPUT` failures;
- provider latency/deadline rate, retry count, reserved-token exhaustion, and
  reported-cost anomalies;
- lease loss, unresolved acceptance, duplicate/conflicting artifacts, source
  digest mismatch, queue backlog, retained MI dead letters, and reconciliation
  growth;
- any result acceptance that does not bind the original stage, claim, source
  revision, and artifact digest.

On an alert, pause dispatch first, preserve queue/storage/database evidence, and
inspect the safe worker/Core classifications. Do not replay a dead message,
delete a result, purge a queue, widen an IAM grant, disable TLS verification, or
retry a rejected schema to recover throughput.

MI dead-lettered work is an operational signal. Core reconciliation owns the
durable delivery/attempt state and an authorized retry decision. Operators must
not fabricate a replay event from the dead queue.

## Rollout and Rollback

Roll out one environment and one feature at a time:

1. Disabled baseline: all AI and Core MI gates remain false.
2. Staging deterministic run: injected adapters and infrastructure checks only.
3. Authorized provider compatibility: finite GPT-6 Luna calls, bounded budget,
   no production meeting data, no quality PASS claim.
4. Staging controlled run: enable the dedicated worker and one feature, observe
   full lifecycle/reconciliation, then repeat for the other features.
5. Production canary: only after all readiness states and release approvals are
   recorded; expand gradually while watching the alerts above.

Rollback is explicit and non-destructive:

1. Set Core dispatch false to stop new MI notifications.
2. Set AI feature/inference gates false and stop the dedicated MI worker after
   its current bounded delivery reaches a durable disposition, or preserve its
   lease only while the capability remains healthy and reconciliation is active.
3. Keep queues, source snapshots, accepted results, receipts, and audit records.
4. Reconcile unresolved deliveries and decide any retry through Core ownership;
   never run an ad hoc provider replay.
5. If the model configuration must change, use a new configuration identity and
   fingerprint. Do not relabel historical artifacts or overwrite accepted
   results.

Credential and certificate rotation is staged outside Git with a new
   role-specific key/certificate, trust validation, restart, transport check,
   and recorded old/new fingerprints. Result-token rotation uses the existing
   current/previous-token overlap and requires distinct validated credentials.
No hot reload, uninterrupted rotation, or expired-certificate recovery is
claimed.

## Outstanding Approvals

- GPT-6 Luna strict-schema compatibility and cost/latency behavior;
- privacy/security approval for any external transcript data;
- independent Vietnamese human review and T07 quality gate;
- staging operational sign-off, IAM/mTLS/broker evidence, and rollback drill;
- production release authorization.
