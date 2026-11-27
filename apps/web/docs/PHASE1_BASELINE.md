# INT-01 — Phase 1 Web baseline

**Verification date:** 2026-11-23
**Overall status:** **BLOCKED** — source integrity and the independent MI/RAG
replay specifications are complete, but no attributable historical live PASS
receipt was available and no approved isolated rerun was authorized. This is not
an acceptance freeze and does not authorize INT-02. MI and RAG are separate
claims; a project-owner statement that both previously passed is recorded as
`PASS (team-reported)` only and is not live acceptance.

## 1. Decision and evidence boundary

This document freezes references and evidence rules for the Product Integration
Web baseline. It does not freeze the current working tree, rewrite history, run
the live system, or promote deterministic tests to live acceptance.

Evidence levels remain separate:

1. **Source/Git integrity:** immutable commit, tree, blob, ancestry, and scope
   checks. Verified below.
2. **Deterministic Web checks:** lint, format, build, and mocked/browser CI.
   These may prove Web source behavior only; they do not prove Core, storage,
   workers, AI, or a deployed HTTPS session.
3. **Live E2E:** an authorized run in isolated infrastructure with independent
   service observations and sanitized receipts. The baseline live verification is
   currently **BLOCKED**.
4. **Formal system/release acceptance:** PI-05/PI-06 and release gates. These
   are separate from INT-01.

Status vocabulary used below:

- **`PASS (team-reported)`** means a project-owner or team statement says the
  scenario passed. It is provenance, not independently verified evidence.
- **`PASS (verified historical)`** requires an attributable receipt from the
  exact isolated run, with source/component identity, ordered state evidence,
  independent service observations, and security observations.
- **`PASS (newly verified)`** requires an authorized live execution under this
  baseline. No such execution was authorized or performed for INT-01.
- **`BLOCKED`** means a claimed or required result cannot be independently
  verified because a prerequisite or qualifying evidence is missing.
- **`NOT_RUN`** means no execution was attempted for that specific scenario.

The labels are intentionally not interchangeable: a team-reported PASS is not a
verified historical PASS, and a NOT_RUN scenario is not a failed scenario.

## 2. Immutable references and relationship

| Role | Full commit | Tree | Parent(s) | Verification |
| --- | --- | --- | --- | --- |
| Common merge base | `4b9656705053781f36aa09b4321483f21d59375d` | `55b16349c73de4d66a0f434404308fc566836ca3` | `7d60f3d05753f3529c578ef5b940fdc86be24d7c` | `PASS` |
| Develop baseline | `85ec885cbd1c38f4e1a17d95fc89f9b387f0f14e` | `a2e83e4ad39eb5e975ff453bb663c5eb1051cd50` | merge base | `PASS` |
| Rush Web source | `e7f18508912c34c447ef3b86935cc8d8b96c5048` | `36bea2fa02b11587c4216a5a47687b8333306324` | `84640b16b54c7ed3286932f558befa1579ac203f` | `PASS`; `origin/web/rush-web` |
| Existing integration checkpoint | `acd2c80a5c2732e19dbf8cb3e36bf246ab68f544` | `93a1233dd0b23504cf8db48d8a8727532271d1c5` | develop baseline | `PASS`; `web/integration-rush` |

The verified graph is:

```text
4b965670... ──> 85ec885c... ──> acd2c80a...
       \
        └──────> e7f185089...  (Rush source; imported by path, not ancestry)
```

Read-only ancestry results:

- `merge-base(develop, rush) = 4b9656705053781f36aa09b4321483f21d59375d`.
- `merge-base(develop, integration) = 85ec885cbd1c38f4e1a17d95fc89f9b387f0f14e`.
- `merge-base(rush, integration) = 4b9656705053781f36aa09b4321483f21d59375d`.
- The merge base is an ancestor of both develop and Rush.
- Develop is an ancestor of the integration checkpoint.
- Rush is intentionally **not** an ancestor of the checkpoint because the
  existing import was a squash/path import. This is expected and not a history
  discrepancy.

The checkpoint commit itself records the import scope and all four pinned
references. No branch was reset, rebased, merged, force-pushed, tagged, or
otherwise rewritten during INT-01.

## 3. Git-derived source inventory

All inventory counts below were obtained from pinned trees, not from the
working-tree file list.

| Comparison | Paths | Added | Modified | Deleted | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| Merge base → Rush Web, `-- apps/web` | 53 | 34 | 19 | 0 | **PASS** |
| Merge base → develop, `-- apps/web` | 20 | 12 | 8 | 0 | **PASS** |
| Develop → integration checkpoint | 53 | 34 | 19 | 0 | **PASS** |
| Develop → integration outside `apps/web/` | 0 | 0 | 0 | 0 | **PASS** |

The Rush path set and the checkpoint path set are identical. Every imported
path has the same blob object ID at `e7f185...` and `acd2c80...`; no Rush
content mismatch was found. The 20 develop-relative Web paths are the
Product Integration protected inventory. Their develop and checkpoint blob
IDs are recorded in
[`PHASE1_PROTECTED_FILES.txt`](./PHASE1_PROTECTED_FILES.txt), where all 20
comparisons are `same`.

### Rush path inventory

The following is the verified `A`/`M` inventory from
`4b965670...` to `e7f185089...`. The authoritative object-level derivation
command is in Section 9.

```text
M apps/web/README.md
A apps/web/src/components/request-state.tsx
A apps/web/src/features/action-items/action-api.ts
A apps/web/src/features/action-items/action-commands.tsx
A apps/web/src/features/action-items/action-form.tsx
M apps/web/src/features/action-items/index.tsx
A apps/web/src/features/action-items/meeting-actions-panel.tsx
M apps/web/src/features/assistant/index.tsx
A apps/web/src/features/auth/account-flows-api.ts
M apps/web/src/features/auth/forgot-password/components/forgot-password-form.test.tsx
M apps/web/src/features/auth/forgot-password/components/forgot-password-form.tsx
M apps/web/src/features/auth/forgot-password/index.tsx
M apps/web/src/features/auth/otp/index.tsx
A apps/web/src/features/auth/password-token-form.tsx
M apps/web/src/features/auth/sign-up/index.tsx
A apps/web/src/features/calendar/calendar-api.ts
M apps/web/src/features/calendar/index.tsx
A apps/web/src/features/dashboard/dashboard-api.ts
M apps/web/src/features/dashboard/index.tsx
M apps/web/src/features/errors/router-fallback.integration.test.tsx
A apps/web/src/features/meetings/intelligence/decision-api.ts
A apps/web/src/features/meetings/intelligence/decisions-panel.tsx
A apps/web/src/features/meetings/intelligence/export-api.ts
A apps/web/src/features/meetings/intelligence/export-panel.tsx
A apps/web/src/features/meetings/intelligence/minutes-api.ts
A apps/web/src/features/meetings/intelligence/minutes-panel.tsx
A apps/web/src/features/meetings/intelligence/query-invalidation.ts
A apps/web/src/features/meetings/intelligence/speakers-panel.tsx
A apps/web/src/features/meetings/intelligence/summary-api.ts
A apps/web/src/features/meetings/intelligence/summary-panel.tsx
A apps/web/src/features/meetings/intelligence/transcript-api.ts
A apps/web/src/features/meetings/intelligence/transcript-panel.tsx
A apps/web/src/features/meetings/media/media-api.ts
A apps/web/src/features/meetings/media/processing-api.ts
A apps/web/src/features/meetings/media/processing-panel.tsx
A apps/web/src/features/meetings/media/recording-panel.tsx
A apps/web/src/features/meetings/media/upload-panel.tsx
A apps/web/src/features/meetings/meeting-tools.tsx
M apps/web/src/features/meetings/meeting-workspace.tsx
M apps/web/src/features/members/index.tsx
A apps/web/src/features/members/manager-scope-picker.tsx
A apps/web/src/features/members/member-api.ts
A apps/web/src/features/members/organization-api.ts
M apps/web/src/features/rooms/index.tsx
A apps/web/src/features/rooms/room-api.ts
M apps/web/src/features/settings/account/account-form.tsx
M apps/web/src/features/settings/notifications/notifications-form.tsx
A apps/web/src/features/settings/preferences-api.ts
A apps/web/src/features/settings/profile/profile-api.ts
M apps/web/src/features/settings/profile/profile-form.tsx
M apps/web/src/features/settings/settings-navigation.test.tsx
A apps/web/src/lib/list-pagination.ts
M apps/web/src/lib/request-recovery.ts
```

## 4. Toolchain and package provenance

The source-of-truth values below are read from the pinned develop tree:

| Item | Pinned value | Blob/object identity |
| --- | --- | --- |
| Node pin, `apps/web/.node-version` | `26.13.0` | `1dda03ddb06ad1c7da5b913539290187eb7fc5aa` |
| Package name/version | `sme-meeting-assistant-web` / `2.2.1` | `apps/web/package.json` blob `806ca36ad102a460873f2c34ceefdad61b8f6414` |
| Package manager | `pnpm@11.24.0` | same package blob |
| Lockfile | `apps/web/pnpm-lock.yaml`, `lockfileVersion: '9.0'` | `443830ab99f1a17021890a56de6430a62d148523` |
| Workspace policy | `apps/web/pnpm-workspace.yaml` | `c4b7f9489ffcb39831a2ecfced2264cf36a62c47` |
| Web config | `apps/web/vite.config.ts` | `a638122b8e578fd95a2ef852ce319f41e57d2097` |
| Generated route tree | `apps/web/src/routeTree.gen.ts` | `91966c82094c514cec359ae9b3c93032cd928d04` |

Relevant declared package baselines are React `^19.2.5`, Vite `^8.0.8`,
TypeScript `~6.0.3`, Vitest `^4.1.4`, and Playwright `1.59.1`. The committed
lockfile, not these ranges, determines the reproducible dependency graph.
Dependencies were not installed or regenerated by INT-01.

The read-only local environment check observed:

```text
node --version  -> v24.18.1  (does not match the pinned Web runtime)
pnpm --version  -> 11.24.0   (matches)
```

The Node mismatch is recorded, not repaired. The Web testing contract
deliberately uses Node `24.18.1` only for the Playwright browser-install helper;
Web CI and Web application verification use the pinned Node `26.13.0`.
Accordingly, no local static/browser CI result is claimed by this task.

## 5. Rollback references and protected boundaries

Use full object IDs, never a floating branch name, for later comparison or
rollback:

```text
PHASE1_DEVELOP_BASELINE=85ec885cbd1c38f4e1a17d95fc89f9b387f0f14e
PHASE1_RUSH_SOURCE=e7f18508912c34c447ef3b86935cc8d8b96c5048
PHASE1_COMMON_MERGE_BASE=4b9656705053781f36aa09b4321483f21d59375d
PHASE1_INTEGRATION_CHECKPOINT=acd2c80a5c2732e19dbf8cb3e36bf246ab68f544
```

The protected boundary is exactly the 20 rows in
`PHASE1_PROTECTED_FILES.txt`. It covers:

- trusted Web/Core transport, HTTPS/local media proxy configuration, and
  generated route identity;
- account setup, normal sign-in/session behavior, CSRF/auth transport and
  authentication route coverage; and
- the operator MI workflow adapter, route, workspace, and its focused
  contracts.

Later integration work must not change a protected blob from the develop
baseline. A required change to one of these paths is a new, explicitly
reviewed scope decision; it is not an integration workaround. Rush changes
are confined to the other 53 Web paths listed above.

## 6. Critical Web route-smoke inventory

Use canonical browser URLs without a trailing slash. Every protected route
must first pass the normal session gate; a route rendering a shell is not proof
that its Core requests were authorized.

| Boundary | Routes | Smoke requirement |
| --- | --- | --- |
| Baseline public/auth entry points | `/sign-in`, `/sign-up`, `/account-setup`, `/forgot-password`, `/otp` | HTTPS trusted origin; callback fragments are not persisted; auth/recovery errors are truthful; no credential/capability appears in URL, DOM, storage, or logs. |
| Baseline protected entry and meeting routes | `/`, `/meetings`, `/meetings/:meetingId`, `/meetings/:meetingId/live`, `/meetings/operator-mi-e2e` | Anonymous deep links redirect once to `/sign-in` with a safe internal return; authenticated routes load without protected descendants before `/auth/me`; Core errors are visible and not simulated. |
| Rush-added product surfaces on existing route IDs | `/`, `/calendar`, `/rooms`, `/members`, `/action-items`, `/assistant`, `/settings`, `/settings/account`, `/settings/notifications`, and the Rush-backed meeting detail panels at `/meetings/:meetingId` | Verify the route loads from the imported feature code, uses same-origin Core API transport, preserves loading/empty/denied/failed states, and does not claim a mutation succeeded from a local banner. |
| Unchanged template smoke boundary | `/apps`, `/tasks`, `/users`, `/chats`, `/help-center`, `/settings/appearance` | Confirm protected routing and no accidental route-tree regression; these are not Rush acceptance surfaces. |

The Rush commit changes feature implementations, not route-file identity. The
route smoke therefore distinguishes the baseline route entry points from the
Rush-backed surfaces without treating a new route ID as evidence of a new
product contract.

## 7. Security and regression gates

These are mandatory later regression assertions. Their live execution is
**NOT_RUN** in INT-01.

- **Trusted transport:** the deployed Web origin and Core API path use HTTPS
  with a trusted, approved certificate chain. The operator helper accepts only
  same-origin Core configuration. HTTP or an untrusted certificate is a
  blocked run, not a successful local substitute.
- **Identity and authorization:** the active account is authenticated, active,
  `WEB` client type, and authorized by Core for every protected operation.
  Browser role labels are not an authorization boundary. Core must bind meeting
  organizer, media, job, review, and intelligence admission to the caller.
- **Cookie/CSRF/session integrity:** use the existing HttpOnly cookie session
  and in-memory CSRF mechanism. No bearer token, cookie, CSRF value, or password
  may be placed in JavaScript-readable persistent storage, screenshots, test
  output, or evidence.
- **Signed media capabilities:** a capability is used only for the one
  approved storage upload/play operation, with browser credentials omitted,
  redirect refusal, and no referrer. The signed URL is never retained in a
  receipt or presented as a Core result.
- **Asynchronous truth:** processing is established by Core state transitions
  and bounded polling, not a fixed sleep, a UI completion message, or a
  mocked response. A failed, stale, mismatched, or unobserved state cannot be
  promoted to success.
- **Human review boundary:** transcript corrections require explicit operator
  approval and the current segment ETag. MI admission requires an
  acknowledged transcript revision and digest. AI Decision/Action Item
  proposals remain distinct from human-confirmed official state.
- **RAG indexing boundary:** an eligible Core source must be correlated through
  the transactional outbox, RabbitMQ, knowledge-worker claim/snapshot,
  versioned BGE-M3 processing, Qdrant write, and Core `INDEXED` read-back.
  `INDEXED` alone or a worker-shaped payload is not independent proof.
- **RAG retrieval boundary:** retrieval must be authorized for the current
  meeting/source revision and generation. A deterministic retrieval result does
  not prove a live Assistant request or a grounded answer.
- **RAG grounding boundary:** every material Assistant claim must be supported
  by current authorized citations and an independently observed provider/final
  verification result. MI proposals cannot become official or be used as
  confirmed evidence through a read-only Assistant query.
- **Mutation and privacy boundary:** only the approved run-owned mutations may
  occur. No unauthorized meeting/media/result access, credential leakage,
  cross-meeting data, raw audio, raw transcript, prompt, signed URL, or
  unapproved cleanup is acceptable.

## 8. MI scenario/evidence provenance and current gaps

### Source-supported candidate

The only Web scenario identified by the pinned source as an operator MI
workflow is:

- route: `/meetings/operator-mi-e2e`;
- UI identity: `Level 3B.5 operator workflow` / `Vietnamese MI E2E workflow`;
- approved test identity encoded by the source: display name `E2E-04 Local
  Test`, user ID `46a30219-3c9f-498d-94fa-d6558f200714`;
- implementation provenance: introduced by `1fb59f0f358849ada48d0c6a66a67916daa0153f`
  (“e2e: Full MI E2E preflight”) and hardened by
  `8ef75795162656170b77088be0901b7441156b8a`, both ancestors of the pinned
  develop baseline;
- pinned Web source for the baseline replay:
  `85ec885cbd1c38f4e1a17d95fc89f9b387f0f14e`.

This source identity is sufficient to define the replay contract in
[`PHASE1_E2E_CONTRACT.md`](./PHASE1_E2E_CONTRACT.md), but it is **not** proof
that a live run passed. The exact previously executed live variant cannot be
distinguished from source alone: optional transcript edits, speaker mappings,
regeneration, and proposal confirmations have no attributable receipt. The
contract therefore records the mandatory source-backed path and keeps those
actions out unless historical evidence establishes them.

### Evidence accepted or rejected

| Source | Evidence level | Decision |
| --- | --- | --- |
| Pinned Git commits, trees, diffs, and blob IDs | Source/Git | Accepted for baseline integrity |
| `operator-mi-e2e-workflow.ts` and the workspace/route source | Contract source | Accepted for reconstructing operations and guards; not a live result |
| `operator-mi-e2e-workflow.test.ts` and `operator-mi-e2e-workspace.test.tsx` | Mocked deterministic/browser CI | Rejected as live proof; the workspace explicitly mocks the workflow adapter |
| `apps/web/docs/TESTING.md` and `apps/web/README.md` | Web boundary documentation | Accepted for toolchain/security/evidence limits |
| `services/api/docs/PI05-SYSTEM-ACCEPTANCE.md` | PI-05 acceptance gate | Rejected as proof of this Web scenario; it says live scenarios remain `NOT_RUN` without receipts |
| `infra/local/secure-integration/README.md` | E2E-04 controlled worker procedure | Rejected as proof of the Web route; it is a separate Core/worker flow and its commands are opt-in templates |
| `infra/local/pi05-isolated/README.md` and operator actions | PI-05 preparation | Rejected as live proof; it explicitly says no live run is authorized and L01–L10 are `NOT_RUN` |
| Commit messages claiming CI/preflight completion | Developer metadata | Rejected as live proof; the develop commit explicitly preserves the live-evidence requirement |

No sanitized receipt bundle was found that correlates this Web route with the
required Web/Core/AI revisions, run ID, execution time, isolated environment,
service/image versions, migration/model state, request correlations, state
transitions, and independent final observations. Therefore:

- historical live PASS: **NOT ESTABLISHED**;
- live-baseline rerun: **NOT_RUN**;
- INT-01 live-verification status: **BLOCKED**;
- PI-05 L01–L10: remain a separate **NOT_RUN** gate.

Resolving the block requires an attributable historical receipt or a new
authorized disposable rerun. It must not use the current integration branch as
a substitute for the pinned develop baseline.

### RAG scenario and evidence provenance

RAG is not an implicit continuation of the MI route. It has three separately
verifiable claims:

1. **Indexing:** an eligible Core source reaches the exact indexed generation
   through outbox, broker, knowledge worker, BGE-M3 processing, Qdrant, and Core
   `INDEXED` state.
2. **Retrieval:** an authorized Assistant request retrieves only current,
   authorized source evidence for the requested meeting/scope.
3. **Grounded answer:** a configured provider produces a bounded answer whose
   material claims pass final verification and cite the current authorized
   evidence. When MI Decision/Action Item evidence is used, the required human
   confirmation precedes grounding.

The available evidence is classified as follows:

| Source | Claim it can inform | Evidence level | Limitation |
| --- | --- | --- | --- |
| `contracts/RAG_T05_BGE_M3_INDEX_GENERATION_V1.json` | BGE-M3 generation/configuration identity | Source contract | Defines the contract; it is not a live receipt |
| `services/api/docs/RAG-T05-A.md` | Core → outbox/RabbitMQ → knowledge worker → BGE-M3 → Qdrant → Core indexing path | Team-reported run report | Reports `ACTION_ITEM` revision 1, `DECISION` revision 0, and `TRANSCRIPT` revision 1 as indexed, but no qualifying acceptance receipt or independent reproduction was found |
| `services/api/docs/RAG-T06-ACCEPTANCE.md` | RAG lifecycle acceptance | Acceptance specification/report boundary | Revision replacement, invalidation/deletion, reindex/generation rebuild, reconciliation, and recovery scenarios are recorded as `NOT_RUN` |
| `services/ai/docs/RAG-T07-EVALUATION-REPORT.md` | Deterministic retrieval/grounding behavior | Deterministic evaluation | Does not establish a live provider/model execution, current deployment, or independently captured Assistant receipt |
| `services/api/docs/PI05-SYSTEM-ACCEPTANCE.md` | MI proposal/confirmation before grounded Assistant evidence | Formal acceptance gate | PI-05 live scenarios remain `NOT_RUN` without the required receipts |
| Project-owner statement that MI and RAG previously passed | Aggregate historical claim | `PASS (team-reported)` | No attributable Web/Core/AI run ID, component revisions, environment identity, ordered observations, or independent receipt bundle |

No RAG source above promotes an indexing report, deterministic evaluation, CI
result, or owner statement to `PASS (verified historical)`.

### Independent MI/RAG status matrix

| Claim | Team-reported status | Verified historical PASS | Newly verified PASS | INT-01 classification |
| --- | --- | --- | --- | --- |
| MI operator workflow on `/meetings/operator-mi-e2e` | `PASS (team-reported)` | `BLOCKED` — no attributable live receipt | `NOT_RUN` | **BLOCKED** |
| RAG indexing happy path | `PASS (team-reported)`; T05 also contains a report | `BLOCKED` — report lacks qualifying independent evidence | `NOT_RUN` | **BLOCKED** |
| RAG retrieval | `PASS (team-reported)`; T07 deterministic results are not live proof | `BLOCKED` — no attributable live Assistant/retrieval receipt | `NOT_RUN` | **BLOCKED** |
| RAG grounded Assistant answer | `PASS (team-reported)` only | `BLOCKED` — provider, citation, authorization, and final-verification receipts are absent | `NOT_RUN` | **BLOCKED** |
| RAG lifecycle regressions (T06) | No scenario-specific PASS; aggregate statement only | `NOT_RUN` in the available acceptance record | `NOT_RUN` | **NOT_RUN** until an authorized lifecycle run is performed |

The aggregate INT-01 status remains **BLOCKED** because the claimed historical
MI/RAG result cannot be promoted to independently verified PASS. The new live
status remains **NOT_RUN** because no live workflow was authorized or executed.

### Phase-1 ownership and regression boundary

| Layer | Authoritative Phase-1 proof | Explicitly not proved by this Web baseline |
| --- | --- | --- |
| Web | Pinned route/workflow source, same-origin Core transport, truthful loading/error/approval controls, and the documented browser assertions | Core authorization, storage, broker, worker, model, Qdrant, or deployed HTTPS behavior |
| Core/API | Authenticated ownership, meeting/media/job/transcript/MI admission, source revisions, outbox state, `INDEXED` state, Assistant scope, citations, and canonical human-confirmed state | A Web mock, UI label, or deterministic test cannot substitute for a live Core/service observation |
| AI/worker/RAG | Independent worker/model/Qdrant/provider observations for indexing, retrieval, and grounding, each correlated to the same run and source generation | T05 prose, T07 deterministic evaluation, CI, or a model-shaped fixture cannot establish live acceptance |
| Human approval | Transcript review acknowledgement precedes MI admission; Decision/Action Item proposal confirmation is a separate explicit Core mutation before confirmed Assistant evidence | Reading a transcript/result/Assistant response does not acknowledge, confirm, assign, or reject anything |

These boundaries keep the MI human-approval path and the RAG
indexing/retrieval/grounding path independently replayable. A successful MI
read-back does not imply an indexed source or grounded Assistant answer, and an
indexed source does not imply authorized retrieval or grounded output.

## 9. Re-verification commands

Run from the repository root. These commands are read-only and use full pinned
IDs:

```bash
BASE=85ec885cbd1c38f4e1a17d95fc89f9b387f0f14e
RUSH=e7f18508912c34c447ef3b86935cc8d8b96c5048
MERGE_BASE=4b9656705053781f36aa09b4321483f21d59375d
CHECKPOINT=acd2c80a5c2732e19dbf8cb3e36bf246ab68f544

for ref in "$BASE" "$RUSH" "$MERGE_BASE" "$CHECKPOINT"; do
  git cat-file -t "$ref"
done
git merge-base "$BASE" "$RUSH"
git merge-base "$BASE" "$CHECKPOINT"
git merge-base "$RUSH" "$CHECKPOINT"
git diff --name-status "$MERGE_BASE" "$RUSH" -- apps/web
git diff --name-status "$MERGE_BASE" "$BASE" -- apps/web
git diff --name-status "$BASE" "$CHECKPOINT"
if git diff --name-only "$BASE" "$CHECKPOINT" -- | grep -qv '^apps/web/'; then
  exit 1
fi
```

The protected manifest can be regenerated directly from those trees:

```bash
git diff --name-status "$MERGE_BASE" "$BASE" -- apps/web |
while IFS=$'\t' read -r delta_status file_path; do
  base_oid="$(git rev-parse "$BASE:$file_path")"
  checkpoint_oid="$(git rev-parse "$CHECKPOINT:$file_path")"
  identity="different"
  test "$base_oid" = "$checkpoint_oid" && identity="same"
  printf '%s|%s|%s|%s|%s\n' \
    "$file_path" "$base_oid" "$checkpoint_oid" "$delta_status" "$identity"
done | LC_ALL=C sort
```

For each row in `PHASE1_PROTECTED_FILES.txt`, independently compare:

```bash
git rev-parse "$BASE:$path"
git rev-parse "$CHECKPOINT:$path"
```

The expected result is 53 Rush paths, 20 protected paths, 0 protected blob
mismatches, 0 checkpoint paths outside `apps/web/`, and exact tree-derived
object IDs as recorded in the manifest.

## 10. Acceptance status

| Criterion | Status | Basis |
| --- | --- | --- |
| AC-01 source references | **PASS** | Full IDs, trees, parents, ancestry, and checkpoint relationship verified |
| AC-02 deterministic inventory | **PASS** | 53 Rush paths and 20 protected paths derived from pinned Git trees; identities preserved |
| AC-03 toolchain/rollback | **PASS** for source provenance; **BLOCKED** for local runtime alignment | Pins and lockfile identity recorded; local Node is 24.18.1, not the 26.13.0 pin |
| AC-04 exact live scenarios | **BLOCKED** | MI candidate and independent RAG claims are identified, but historical live execution is not attributable |
| AC-05 MI/RAG replay contracts | **PASS** | Ordered, independently verifiable MI and RAG contracts are recorded in the companion artifact |
| AC-06 evidence provenance | **BLOCKED** | Required historical MI/RAG receipt bundles are missing; T06 lifecycle scenarios are explicitly `NOT_RUN` |
| AC-07 security/routes | **PASS** for specification; **NOT_RUN** live | Web, Core, MI human-approval, RAG authorization, freshness, citation, and route-smoke gates are recorded |
| AC-08 scope/data safety | **PASS** | Only the three Web documentation artifacts are introduced; no secrets or production changes |
| AC-09 focused verification | **BLOCKED** overall | Read-only source checks pass; live-baseline evidence remains unresolved |
| AC-10 status classification | **PASS** for documentation | Team-reported PASS, verified historical PASS, BLOCKED, and NOT_RUN are kept distinct for MI and RAG |
| AC-11 RAG separation | **PASS** for specification; **BLOCKED** historical; **NOT_RUN** new | Indexing, retrieval, and grounded-answer claims have separate assertions and receipts |

INT-01 must remain **BLOCKED** until the missing historical evidence is
provided or an approved isolated baseline rerun produces it.
