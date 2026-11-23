# INT-03 — Secure HTTPS and transport-boundary verification

**Verification date:** 2026-11-23  
**Overall INT-03 status:** **BLOCKED** — deterministic transport verification
passes, but the approved trusted-browser runtime could not be established.

This report covers the Web transport boundary only. It does not claim
authentication, complete media compatibility, media finalization/playback,
Meeting Intelligence, RAG, or Phase-1 acceptance.

## 1. Source and protected-source result

| Item | Result |
| --- | --- |
| Branch | `web/integration-rush` |
| Git source checkpoint (HEAD) | `e5abb653f8ffd7b3ed0f97bd29c7bde53dadd1c2` |
| Develop baseline | `85ec885cbd1c38f4e1a17d95fc89f9b387f0f14e` |
| Protected manifest comparison | **PASS** — 20 checked, 0 mismatches |
| Changes outside Web scope | **PASS** — none introduced |
| History/commit operations | **PASS** — none performed |

The protected Vite configuration, local media proxy, environment example,
Core transport, and operator transport remain unchanged. No scope exception
was required.

## 2. Implemented boundary hardening

- `src/features/meetings/media/media-api.ts` now parses upload intents with a
  non-disclosing error, accepts only HTTPS capability URLs without userinfo or
  fragments, and returns the original URL so signed query bytes are not
  normalized.
- Signed PUT uses `credentials: 'omit'`, `redirect: 'error'`,
  `referrerPolicy: 'no-referrer'`, the Core-required content type, and no Core
  authorization or CSRF headers.
- Network errors and unsuccessful storage responses fail without finalization
  or automatic retry. Capability values are absent from user-facing transport
  errors and test results.
- Added browser coverage for safe capability use, insecure/malformed URLs,
  redirect responses, unsuccessful responses, and ambiguous network failure.
- Added a built-in Node test command using temporary isolated certificates and
  local HTTPS fixtures. It exercises the protected local proxy without
  changing it.
- Documented the secure local startup contract and fail-closed conditions in
  `apps/web/README.md`.

The normal Rush media path still does not implement the complete local
capability-rewrite/media compatibility workflow. That remains INT-05.

## 3. Effective local configuration

Sensitive values and filesystem paths are redacted here. The inspected
`.env.local` had:

| Setting | Observation |
| --- | --- |
| `VITE_CORE_API_BASE_URL` | `/api/v1` |
| `VITE_CORE_API_PROXY_TARGET` | approved loopback HTTP Core target |
| `WEB_DEV_HTTPS_KEY_FILE` | configured readable file |
| `WEB_DEV_HTTPS_CERT_FILE` | configured readable file |
| `VITE_LOCAL_MEDIA_STORAGE_ORIGIN` | approved `storage.internal` HTTPS origin |
| `LOCAL_MEDIA_STORAGE_CA_FILE` | configured readable file |
| Core listener | **unreachable** during runtime attempt |
| Storage listener | loopback TCP listener reachable |

No key, certificate private material, CA contents, credentials, cookies, or
signed capabilities were recorded.

## 4. Deterministic verification

All focused checks passed:

```text
pnpm exec vitest run --browser.headless \
  src/features/meetings/media/media-api.test.ts
PASS — 1 file, 8 tests

pnpm run test:transport:node
PASS — 7 Node tests

pnpm exec vitest run --browser.headless \
  src/lib/core-api.test.ts \
  src/features/meetings/data/operator-mi-e2e-workflow.test.ts
PASS — 2 files, 32 tests

pnpm run lint
PASS

pnpm run format:check
PASS

pnpm run build
PASS — TypeScript and Vite production build
```

The Node fixture results include:

- permitted signed PUT/GET behavior, exact signed path/query preservation,
  storage Host preservation, and browser-header filtering;
- rejection of unsupported paths, methods, signatures, content types, and
  request sizes;
- refusal of upstream redirects and unsupported upstream content;
- failure on an untrusted CA, missing CA, non-HTTPS storage, and non-loopback
  Web binding;
- Vite HTTPS key/certificate pairing failure for incomplete or unreadable
  configuration, valid HTTPS configuration loading, and same-origin `/api`
  proxy mapping.

## 5. Trusted runtime observations

Vite started with the approved local configuration and advertised:

```text
https://127.0.0.1:5173/
https://localhost:5173/
```

An actual Chromium navigation to both matching URLs failed with
`ERR_CERT_AUTHORITY_INVALID`. Certificate validation was not disabled and no
browser warning was bypassed. Consequently:

| Observation | Classification |
| --- | --- |
| HTTPS server started | **PASS** |
| Browser-trusted certificate chain | **BLOCKED** |
| Browser certificate/hostname acceptance | **BLOCKED** |
| `window.isSecureContext` on a trusted page | **NOT_RUN** |
| Trusted-page mixed-content observation | **NOT_RUN** |
| Same-origin Core path in browser | **BLOCKED** as trusted-runtime evidence |
| Server-side Core proxy reachability | **BLOCKED** — Core refused connection |
| Authenticated Core response | **NOT_RUN** |
| Real signed PUT/finalization/playback | **NOT_RUN** |

The browser/Vite observation did show an attempted same-origin
`/api/v1/auth/me` request. The Vite proxy reported
`ECONNREFUSED 127.0.0.1:8080` and returned 502. This confirms the configured
server-side target path, not a trusted HTTPS or authenticated Core acceptance.

## 6. Acceptance classification

| Criterion | Result |
| --- | --- |
| AC-01 source and architecture preserved | **PASS** |
| AC-02 HTTPS configuration and fail-closed checks | **PASS** deterministic; trusted runtime **BLOCKED** |
| AC-03 trusted browser HTTPS | **BLOCKED** |
| AC-04 same-origin Core boundary | **PASS** deterministic; live reachability **BLOCKED** |
| AC-05 restricted signed-media proxy | **PASS** deterministic; trusted runtime **BLOCKED** |
| AC-06 Rush signed-upload hardening | **PASS** |
| AC-07 no security disclosure | **PASS** for source/tests/report evidence |
| AC-08 focused regression verification | **PASS** |
| AC-09 local startup contract | **PASS** |
| AC-10 evidence-based completion | **BLOCKED** pending trusted HTTPS evidence |

The historical MI/RAG Live E2E evidence blocker remains unchanged and is not
treated as an INT-03 implementation failure. INT-04 still owns the real
authentication/session lifecycle. INT-05 owns the complete media compatibility
and capability workflow.
