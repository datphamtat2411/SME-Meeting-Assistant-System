# INT-03 transport boundary plan

## Repository Findings

- `apps/web/vite.config.ts` preserves the single same-origin `/api` proxy and
  explicit key/certificate HTTPS configuration.
- `apps/web/config/local-media-proxy.ts` is a protected local-only adapter that
  pins `storage.internal` HTTPS, resolves only to loopback, verifies the
  configured CA, allowlists signed media paths/methods/content types, omits
  browser credentials, and refuses unsafe upstream responses.
- `src/features/meetings/media/media-api.ts` is the imported Rush upload
  consumer. It already omits credentials and referrers but does not refuse
  redirects or reject insecure capability URLs before finalization.
- The 20-file Phase-1 manifest makes the Vite config, local proxy, environment
  example, and operator workflow protected; no protected source change is
  authorized.

## Affected Files

- `apps/web/src/features/meetings/media/media-api.ts`
- focused normal-media browser regression test
- focused Node transport-boundary regression test
- `apps/web/README.md`
- `apps/web/docs/PHASE1_INT03_TRANSPORT.md`
- `apps/web/package.json` only if a dedicated Node test command is needed

## Proposed Changes

1. Validate Core-issued upload capabilities as credential-free, hash-free HTTPS
   URLs, retain the existing exact content type, omitted credentials, and
   no-referrer policy, add explicit redirect refusal, and finalize only after
   one successful upload response.
2. Test success and failure behavior for malformed/insecure capabilities,
   redirects, network errors, unsuccessful storage responses, credential/header
   omission, and absence of capability disclosure.
3. Exercise the protected local proxy in Node with isolated local HTTPS
   fixtures: valid signed PUT/GET, method/path/query/content limits, header
   filtering, CA/configuration failure, TLS failure, upstream redirects, and
   unsupported responses.
4. Document server-only HTTPS/Core/storage variables, browser-visible
   same-origin settings, fail-closed conditions, and the runtime evidence
   procedure without recording secrets or signed URLs.
5. Record source/protected-file integrity, deterministic results, and any
   unavailable trusted-browser/runtime evidence in the INT-03 report.

## Focused Verification

- `pnpm exec vitest run --browser.headless src/features/meetings/media/media-api.test.ts`
- `pnpm run test:transport:node`
- `pnpm run lint`
- `pnpm run format:check`
- `pnpm run build`
- final protected-blob comparison against the Phase-1 manifest and
  `git status --short`
