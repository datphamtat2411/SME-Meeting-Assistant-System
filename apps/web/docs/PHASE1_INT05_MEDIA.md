# INT-05 — Rush Web media compatibility

**Verification date:** 2026-11-23  
**Overall INT-05 status:** **BLOCKED for live signed-media acceptance** —
deterministic Web compatibility verification passed, but the approved
authenticated INT-04 identity and live media fixtures were unavailable.

This report covers the Web media boundary only. It does not claim a live
signed PUT, Core finalization, signed GET, processing completion, or final
Phase-1 acceptance.

## 1. Source and protected-source result

| Item | Result |
| --- | --- |
| Branch | `web/integration-rush` |
| Git source checkpoint (HEAD) | `853abab9cc5c7411c80993f226e3e8914db46936` |
| Protected manifest comparison | **PASS** — 20 checked, 0 mismatches |
| Web-only scope | **PASS** — no Core, storage, infrastructure, or mobile source changes |
| Git history/write operations | **PASS** — none performed |
| Live media mutations | **NOT RUN** — no approved authenticated fixture was available |

The protected Vite configuration, local media proxy, Core transport, operator
MI adapter, and Product Integration sources remain byte-identical to the
protected manifest. `plan.md` is the only task-planning file outside
`apps/web`.

## 2. Implemented deterministic compatibility

- Media capabilities are accepted only when they are HTTPS, credential-free,
  fragment-free, operation-specific, signed, and scoped to the expected
  meeting/media object namespace. The original signed path and query bytes are
  preserved. Development capabilities for the approved `storage.internal`
  origin resolve through `/__local-media`; direct access requires an explicit
  public HTTPS origin.
- Upload declarations support WAV, MP3, and AAC in M4A using Core's canonical
  content types and aliases. WebM, Ogg, FLAC, unsafe filenames, empty files,
  mismatched declarations, and oversized files are rejected before intent
  creation. The browser declaration does not replace Core's codec/container
  inspection.
- An upload operation uses one caller-held idempotency key, at most one signed
  PUT, and at most one finalization request. `AVAILABLE` intent replays with
  nullable capability fields are read back without another PUT. Only an
  authoritative `AVAILABLE` media record is returned as success.
- Definite storage failures do not finalize. Ambiguous storage/finalization
  outcomes are reconciled with a Core read and are not automatically retried.
- Browser recording is limited to explicit AAC-in-M4A `MediaRecorder`
  declarations, remains local until Submit, and stops microphone tracks on
  completion, error, and cleanup.
- Processing admission and retry operations accept caller-held keys and use
  authoritative reads after ambiguous responses without posting a second
  mutation. Playback requests require `AVAILABLE` media, omit credentials,
  suppress referrers, refuse redirects, and use a temporary object URL that is
  revoked on replacement/unmount.

## 3. Deterministic verification

The focused browser suite passed:

```text
pnpm exec vitest run --browser.headless \
  src/features/meetings/media/media-api.test.ts \
  src/features/meetings/media/processing-api.test.ts \
  src/features/meetings/media/processing-panel.test.tsx \
  src/features/meetings/media/recording-panel.test.tsx \
  src/features/meetings/media/upload-panel.test.tsx
PASS — 5 files, 48 tests
```

The suite covers capability parsing and local rewrite, signed path/query
preservation, unsafe destinations, Core format declarations, upload replay and
failure states, one-PUT/one-finalize behavior, uncertain read-back, signed GET
transport, caller-held processing keys, duplicate-submit protection, recording
fallback/cleanup/explicit submit, and selected-file retention.

```text
pnpm run lint
PASS

pnpm run format:check
PASS

pnpm run build
PASS — TypeScript and Vite production build
```

The protected-file comparison used the repository's
`apps/web/docs/PHASE1_PROTECTED_FILES.txt` manifest and computed 20 current
blob identities with zero mismatches.

## 4. Live evidence and blocker

Deterministic tests do not substitute for a live authenticated media mutation.
The following live checks were not executed:

| Live gate | Classification | Reason |
| --- | --- | --- |
| Approved authenticated Core identity | **BLOCKED** | INT-04 has no approved synthetic identity and password available |
| Authorized meeting/member and media fixture | **BLOCKED** | Depends on the unavailable authenticated identity |
| Signed PUT to object storage | **BLOCKED / NOT RUN** | No authorized live mutation was permitted |
| Core finalization and authoritative `AVAILABLE` read-back | **BLOCKED / NOT RUN** | Depends on the live PUT and identity |
| Signed GET/playback | **BLOCKED / NOT RUN** | Depends on an authorized available media fixture |
| Live processing admission/completion | **BLOCKED / NOT RUN** | Outside deterministic Web-only evidence and requires the live fixture |

The existing INT-03 transport report provides accepted deterministic and
trusted-browser evidence for the HTTPS/Core boundary and protected local
proxy. It does not establish this INT-05 live media acceptance. No credentials,
cookies, signed capabilities, or live media mutations were recorded or
executed for this task.

## 5. Acceptance classification

| Criterion | Result |
| --- | --- |
| Core-compatible WAV/MP3/AAC-M4A declarations | **PASS** deterministic |
| Signed capability scheme, namespace, identity, query, and origin boundary | **PASS** deterministic |
| Credential-free upload/access transport and redirect/referrer controls | **PASS** deterministic |
| One PUT/finalization and `AVAILABLE` replay behavior | **PASS** deterministic |
| Truthful finalization and uncertain-outcome reconciliation | **PASS** deterministic |
| Recording policy and microphone cleanup | **PASS** deterministic |
| Bounded processing idempotency | **PASS** deterministic |
| Live signed PUT/finalize/GET acceptance | **BLOCKED** — INT-04 identity prerequisite |

The remaining blocker is an environment/authorization prerequisite, not a
replacement mock or an unimplemented Web contract.

## 6. Corrective follow-up — React lifecycle and processing reconciliation

The corrective review began from INT-05 commit
`f78898287813d25f036a02d94d713d237e37177e`.

### 6.1 Findings and root causes

- **Recording lifecycle:** `RecordingPanel` initialized its mounted ref as
  active, then effect cleanup marked it inactive without restoring that state
  during React StrictMode effect setup. Permission results and recorder
  callbacks also used shared mutable stream/recorder refs, so stale work could
  affect a newer recording.
- **Processing reconciliation:** ordinary Core processing-job reads do not
  expose the initiating idempotency key. Matching media/reprocess fields, job
  status, retryability, retry count, or stage changes therefore could not prove
  that a timed-out admission or retry was the specific operation that
  succeeded.

### 6.2 Corrective behavior

- Recording effect setup now establishes an active lifecycle generation and
  cleanup invalidates it. Microphone permission requests carry both lifecycle
  and request identities; stale results release their tracks without creating
  a recorder. Each recorder owns its stream and captured chunks, callbacks
  verify ownership before changing state, and stream release is idempotent.
  StrictMode replay, genuine unmount, startup failure, recorder error, and
  late callbacks cannot create an abandoned active recorder or upload
  automatically. AAC-in-M4A declarations and explicit Submit behavior are
  unchanged.
- A direct Core admission/retry response remains confirmed success. After an
  uncertain response, the Web may read the current job view for
  observability, but it never attributes any returned job or state to the
  timed-out idempotency key. Admission returns
  `PROCESSING_ADMISSION_UNCERTAIN`; retry returns
  `PROCESSING_RETRY_UNCERTAIN`; neither path posts a second mutation.
- Processing UI success toasts are reserved for resolved mutation responses.
  Uncertain admission/retry outcomes receive distinct messages, retain their
  caller-held operation keys, keep current jobs visible, and block a different
  admission until the uncertain operation is understood.

### 6.3 Corrective regression evidence

The historical INT-05 baseline above remains **48 tests**; it is not rewritten
to claim coverage that did not exist at that time. The corrective recording and
processing run added or revised 30 focused tests:

```text
pnpm exec vitest run --browser.headless \
  src/features/meetings/media/recording-panel.test.tsx \
  src/features/meetings/media/processing-api.test.ts \
  src/features/meetings/media/processing-panel.test.tsx
PASS — 3 files, 30 tests
```

The complete affected INT-05 media regression suite also passed:

```text
pnpm exec vitest run --browser.headless \
  src/features/meetings/media/media-api.test.ts \
  src/features/meetings/media/processing-api.test.ts \
  src/features/meetings/media/processing-panel.test.tsx \
  src/features/meetings/media/recording-panel.test.tsx \
  src/features/meetings/media/upload-panel.test.tsx
PASS — 5 files, 68 tests
```

The corrective tests cover StrictMode effect replay, stale permission
resolution, genuine unmount and late callbacks, recorder startup failure,
pre-existing/multiple/unrelated admission jobs, unchanged and changed retry
states, failed read-back, no duplicate POST, stable operation keys, and
truthful confirmed/uncertain processing-panel feedback.

```text
pnpm run lint
PASS

pnpm run format:check
PASS

pnpm run build
PASS — TypeScript and Vite production build
```

### 6.4 Corrective acceptance classification

| Corrective criterion | Result |
| --- | --- |
| StrictMode recording lifecycle | **PASS** deterministic |
| Recording resource ownership and stale async cleanup | **PASS** deterministic |
| Processing admission reconciliation | **PASS** deterministic — unsupported inference remains uncertain |
| Processing retry reconciliation | **PASS** deterministic — unsupported inference remains uncertain |
| Caller-held idempotency and duplicate prevention | **PASS** deterministic |
| Truthful processing UI feedback | **PASS** deterministic |
| Existing signed media/upload/playback behavior | **PASS** — 68-test affected regression |
| Protected-source integrity | **PASS** — 20 checked, 0 mismatches |
| Live signed PUT/finalize/GET acceptance | **BLOCKED** — approved INT-04 identity and media fixtures remain unavailable |

No Core, storage, infrastructure, transport, authentication, or protected
Product Integration source was changed. No live media mutation was performed.
