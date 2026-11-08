# Testing

## Approach

Use focused, deterministic frontend verification for the behavior changed by the active task. The Web project currently provides Vitest with Playwright-backed browser testing; follow the repository-root `AGENTS.md` PLAN/BUILD testing sequence rather than running broad suites by default.

- **Pure logic / mapping:** test API-envelope handling, state mapping, date/timeline conversion, validation helpers, and other deterministic feature logic.
- **UI behavior:** test the relevant component's rendering, form interactions, accessibility-critical controls, and loading/empty/error/retry states.
- **Feature integration:** exercise query/mutation handling with controlled API fixtures or request interception; verify correct HTTP status/code interpretation, pagination, invalidation, and successful/failed transitions.
- **Security-sensitive UI:** verify session-expired behavior, CSRF transport expectations when applicable, guarded presentation, and the absence of JavaScript-stored bearer tokens. UI tests do not replace server authorization tests.
- **Media / AI workflows:** distinguish requested, accepted, processing, warning, failure, and completed states. Do not use fake timers or stubbed success as evidence of real upload, recording, transcription, or grounded answers.

## Regression and Boundaries

- Preserve the existing screen/route and interaction path when replacing mock data with API-backed behavior; focus regression tests on what was touched.
- Use representative success, empty, validation, unauthorized, forbidden, conflict, partial, and failure fixtures **as applicable to the task**, not as an obligatory universal test matrix.
- Keep tests isolated from real user accounts, external AI providers, live media, and unavailable backend environments unless the task explicitly authorizes an integration environment.
- Favor a targeted Vitest/browser test invocation for affected files. Run broader build, lint, end-to-end, or full-suite checks only when the task/plan justifies them.
- Exact test cases, fixtures, commands, and acceptance criteria are selected by the Task Specification and `plan.md`. Report what was actually verified, not what the UI appears to demonstrate.

Relevant context: `RE06-FEATURES.md`, `RE02-API.md`, and `RE08-SECURITY.md` in `requirement-docs/`.

## Web CI Merge Gate

The `Web CI` GitHub Actions workflow is the long-term verification gate for Web changes. It runs on pull requests targeting `develop` or `main`, pushes to `develop`, `main`, and `web/**`, and manual dispatch. Pull requests are intentionally not path-filtered: changes outside `apps/web/` still receive both stable checks so required status checks cannot remain pending.

The checks are **Web / static checks** (lint, formatting, and TypeScript/Vite build) and **Web / browser tests** (the full Vitest browser suite in headless Chromium). The browser suite includes router-fallback integration coverage. These checks validate the Web package independently; mock and fixture-based UI tests do not verify backend or AI behavior.

### Supported Toolchain

- Node.js `26.13.0` (LTS), pinned in `.node-version`.
- pnpm `11.24.0`, pinned by the `packageManager` field in `package.json`.
- Dependencies are installed only from the committed `pnpm-lock.yaml` with `pnpm install --frozen-lockfile`.

pnpm `11.24.0` is pinned because it accepts the existing lockfile format without rewriting it. pnpm `12.18.0` was tested against the same frozen dependency graph but adds a pnpm package-manager boot document and platform-specific pnpm entries to this lockfile. That migration is not required for Web verification, so CI uses the compatible exact pnpm 11 pin instead.

Use the Node version selected by `.node-version` and the pnpm version selected by `packageManager` locally. Verify the active versions with `node --version` and `pnpm --version` before running the gate. Keep these pins aligned with CI when updating the toolchain; do not regenerate the lockfile as part of CI.

### Run the CI Checks Locally

From `apps/web/`, run:

```bash
pnpm install --frozen-lockfile
pnpm run lint
pnpm run format:check
pnpm run build
pnpm run test:browser:install
pnpm test
```

`test:browser:install` installs the project-pinned Playwright Chromium and required Linux browser dependencies. It may require administrator privileges on Linux. `pnpm test` runs the complete headless browser suite and fails if no tests are discovered.

### Diagnosing CI Failures

- **Static checks:** open the failed `Web / static checks` job and inspect the lint, formatting, or build step that failed. The build includes TypeScript project checking and Vite bundling.
- **Browser provisioning:** check the Playwright installation step for browser downloads or missing Linux dependencies.
- **Browser tests:** inspect the `pnpm test` logs and GitHub annotations. The `web-browser-test-report` JUnit artifact is uploaded when available and retained for 14 days, including when test assertions fail.
- Workflow runs cancel older runs for the same PR or branch. A cancelled run is not a passing check; use the latest run’s result.

The report contains test results only. CI does not upload browser screenshots, traces, credentials, or sensitive fixtures, and it does not access backend or AI services.

### Required Checks

After both checks pass in an actual hosted run, configure **Web / static checks** and **Web / browser tests** as required status checks for `develop` in repository rulesets or branch protection, if repository permissions and governance allow. This repository-settings step is manual; committing the workflow does not configure merge protection.
