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
