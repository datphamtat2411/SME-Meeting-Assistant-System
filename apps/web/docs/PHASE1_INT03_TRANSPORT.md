# INT-03 — Secure HTTPS and transport-boundary verification

**Verification date:** 2026-11-23  
**Overall INT-03 status:** **PASS** — deterministic transport verification and
the approved trusted-browser runtime both pass.

This report covers the Web transport boundary only. It does not claim
authentication, complete media compatibility, media finalization/playback,
Meeting Intelligence, RAG, or Phase-1 acceptance.

## 1. Source and protected-source result

| Item | Result |
| --- | --- |
| Branch | `web/integration-rush` |
| Git source checkpoint (HEAD) | `4b746ae58ae5a9eaf3d2b242a48442200c6a6ce7` |
| Develop baseline | `85ec885cbd1c38f4e1a17d95fc89f9b387f0f14e` |
| Protected manifest comparison | **PASS** — 20 checked, 0 mismatches |
| Changes outside Web scope | **PASS** — no production/service changes; only the repository task plan is outside Web |
| History/commit operations | **PASS** — none performed |

The protected Vite configuration, local media proxy, environment example,
Core transport, and operator transport remain unchanged. No scope exception
was required. The follow-up corrected only ignored local runtime configuration:
the Web `.env.local` certificate path now points to a full chain assembled from
the existing approved valid leaf and intermediate; the existing matching key
was not replaced.

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
| Core listener | **reachable and ready** through `./dev.sh up` |
| Storage listener | loopback TCP listener reachable |

No key, certificate private material, CA contents, credentials, cookies, or
signed capabilities were recorded.

### 3.1 Approved Web certificate identity

The effective Web chain was inspected without recording private material:

| Property | Result |
| --- | --- |
| Browser URL used | `https://localhost:5173` |
| Leaf subject | `CN=ai-core` |
| Issuer | `O=SME Development CA, CN=SME Development CA Intermediate CA` |
| Validity | **2026-11-06 through 2027-02-04** |
| Subject Alternative Name | `DNS:localhost` |
| Key usage | `Digital Signature` |
| Extended key usage | `TLS Web Server Authentication` |
| Leaf SHA-256 fingerprint | `D5:C5:09:E9:4B:D0:0B:AC:36:C9:01:AE:FC:A4:E1:6F:82:BF:A8:97:83:4D:5E:81:28:34:BF:DC:9B:44:94:B9` |
| Approved root SHA-256 fingerprint | `D3:3A:6A:24:04:E0:DC:E4:2A:4C:52:5C:04:6E:EB:9F:33:82:7E:94:7E:67:7C:6F:02:B3:39:6F:CF:1D:75:B5` |
| Chain verification | **PASS** with the approved root and intermediate |
| Web key match | **PASS** — leaf public key matches the configured Web key |

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

### 5.1 Historical first attempt

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
This remains historical blocker evidence for the initial environment state.

### 5.2 Follow-up runtime

The expired Web leaf was not reissued or replaced. The runtime was corrected to
use the existing approved `ai-core` leaf, its approved intermediate, the
existing matching private key, and an isolated Chromium NSS database containing
only the approved public root. Chromium used normal certificate validation
(`ignoreHTTPSErrors: false`) and navigated to the SAN-matching hostname.

`./dev.sh up` started the existing local dependency and host-process workflow;
Core reported ready, its liveness endpoint returned 200, and the existing
database was already at the current migration version with no migration
needed. A browser navigation to `https://localhost:5173/sign-in` then
returned 200 and produced this observation:

```text
protocol=https:
origin=https://localhost:5173
window.isSecureContext=true
same-origin /api/v1/auth/me=401
http requests=0
certificate or mixed-content errors=0
failed requests=0
```

The 401 is the expected unauthenticated Core response, not a transport failure.
The same request was also observed in the Core request log with status 401; a
CA-validated direct probe through the HTTPS proxy likewise returned HTTP 401
without a curl transport error.

## 6. Acceptance classification

| Criterion | Result |
| --- | --- |
| AC-01 source and architecture preserved | **PASS** |
| AC-02 HTTPS configuration and fail-closed checks | **PASS** deterministic and runtime |
| AC-03 trusted browser HTTPS | **PASS** |
| AC-04 same-origin Core boundary | **PASS** deterministic and live; unauthenticated response verified |
| AC-05 restricted signed-media proxy | **PASS** deterministic; trusted HTTPS runtime boundary verified |
| AC-06 Rush signed-upload hardening | **PASS** |
| AC-07 no security disclosure | **PASS** for source/tests/report evidence |
| AC-08 focused regression verification | **PASS** |
| AC-09 local startup contract | **PASS** |
| AC-10 evidence-based completion | **PASS** for INT-03 transport scope |

The historical MI/RAG Live E2E evidence blocker remains unchanged and is not
treated as an INT-03 implementation failure. INT-04 still owns the real
authentication/session lifecycle. INT-05 owns the complete media compatibility
and capability workflow. This report does not claim INT-04, INT-05, or final
Phase-1 acceptance.
