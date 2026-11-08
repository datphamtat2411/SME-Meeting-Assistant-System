# 05 — Web CI Foundation (Long-Term Quality Gate)

Read `AGENTS.md` and `apps/web/RULES.md`.

Plan a **durable GitHub Actions CI solution** for `apps/web` on branch `web/module-product-shell`. This is a permanent engineering quality gate for future Web modules, **not** a one-off script designed merely to make the current Product Shell branch look green. Build upon the existing API/AI CI conventions without coupling Web verification to backend availability.

## Goal

Every relevant Web PR must receive reproducible, truthful, actionable automated verification of static checks, build, and browser tests. Contributors must be able to run equivalent commands locally and diagnose failures from GitHub Actions.

## Inspect First

- `.github/workflows/ai-ci.yml`, `api-ci.yml`, and existing repository CI patterns.
- `apps/web/package.json`, `pnpm-lock.yaml`, `vite.config.ts`, TypeScript configuration, test structure, and relevant scripts.
- Existing Node/pnpm version declarations (or lack thereof) and build-generated TanStack Router artifacts.
- `apps/web/docs/TESTING.md`, `docs/ARCHITECTURE.md`, and package rules.
- The new router-fallback integration tests from Task 04.

Inspect external GitHub Actions, Node/pnpm, and Playwright setup documentation when selecting action versions and runner capabilities. Avoid copying an outdated starter workflow without checking compatibility.

## Core CI Contract

1. **One owned workflow:** Add `.github/workflows/web-ci.yml` with a stable, recognizable workflow name and stable job/check names suitable for required PR status checks.
2. **Lifecycle:** Run automatically on PRs targeting `develop` (and `main` if used for normal integration), on pushes to integration branches `develop`/`main` and development branches `web/**` as appropriate, plus `workflow_dispatch` for manual verification. Make the trigger policy explicit in the plan.
3. **Required-check reliability:** Do not apply workflow-level `paths` filters to a workflow intended as a required PR check; such filtering can leave required checks pending. For this baseline, prefer a straightforward always-run PR gate. Any later monorepo optimization must keep a stable, truthful required check.
4. **Reproducible runtime:** Pin a maintained Node LTS release and a compatible pnpm major/exact version with a single discoverable project version policy (for example a committed Node version file and `packageManager` metadata). Avoid floating package-manager versions and competing local/CI versions.
5. **Dependency integrity:** Install via the committed `apps/web/pnpm-lock.yaml` using `pnpm install --frozen-lockfile`. Do not regenerate the lockfile in CI or rely on untracked global dependencies.
6. **Efficient cache:** Cache pnpm's package store with `actions/setup-node` and explicit `cache-dependency-path: apps/web/pnpm-lock.yaml`; do not cache `node_modules` as the primary approach. Keep caching an optimization, not a correctness dependency.
7. **Static verification:** Run `pnpm run lint`, `pnpm run format:check`, and `pnpm run build` (TypeScript + Vite). Fail the appropriate check when any required command fails. Resolve or explicitly reconcile pre-existing style problems rather than silently bypassing failures.
8. **Browser verification:** Install pinned project's Playwright Chromium and required Linux browser dependencies, then run the existing Vitest headless browser suite through `pnpm test`. Include Task 04's integration tests automatically. CI must fail on test failures or absence of expected tests.
9. **Clarity and performance:** Prefer separate, clearly named `Web / static checks` and `Web / browser tests` jobs if useful for diagnosis and parallel feedback. Use bounded job timeouts and workflow concurrency/cancellation for superseded runs. Avoid adding gratuitous matrices or services.
10. **Security:** Minimum `contents: read` permissions, checkout without retained credentials where supported, no `pull_request_target` for untrusted PR code, no long-lived secrets, no backend/AI access and no privileged deployment steps.
11. **Failure evidence:** Preserve readable step logs, actionable check names, and appropriate browser-test evidence (for example JUnit/report output or sanitized failure artifacts) with bounded retention when supported. Do not upload secrets or sensitive fixtures.
12. **Documentation:** Record local equivalents, supported Node/pnpm versions, CI triggers, required checks, browser provisioning, failure diagnosis, and deliberate boundaries in `apps/web/docs/TESTING.md` or a short package-owned CI document. Keep global requirements as canonical references rather than duplicating them.

## Important Design Decisions

- This workflow validates **Web independently**, even before real authentication and backend integration exist. Do not pretend that mock UI tests verify backend correctness.
- Reuse Vitest + Playwright as configured. Do not introduce Cypress, a second Playwright Test runner, Dockerized full-stack E2E, SonarQube, or unrelated tooling without an explicit requirement.
- Treat test flakiness as a defect. Fix shared-state isolation, browser provisioning, or resource configuration; never disguise failures with blanket retries, `continue-on-error`, or `|| true`.
- CI may execute the full Web browser suite and full static/build checks **because this task explicitly establishes a merge gate**. That is distinct from root `AGENTS.md`'s preference for narrow tests during iterative feature BUILD.
- Keep CI version/action upgrades deliberate and documented. A green badge alone is not proof of correct trigger or failure behavior.

## Scope

**In scope:** Web GitHub Actions workflow, explicit runtime version policy, required supporting test-reporter/config changes if justified, brief CI documentation, minimal fixes proven necessary for reliable CI.

**Out of scope:** Deployments/CD, production secrets, real backend/AI end-to-end tests, dependency modernization unrelated to CI, broad frontend refactors, API/AI CI rewrites, and general template cleanup.

## Acceptance Criteria

- A real GitHub Actions run completes on the Web branch/PR using a clean hosted runner (not just a local terminal).
- Static checks and headless browser tests both finish successfully, with clear independently identifiable outcomes.
- All commands are reproducible locally using the committed version policy and frozen lockfile.
- Changes to Web tests, lint, formatting or build cannot be falsely reported as successful. Check the failure-to-red behavior using safe CI validation, not by leaving deliberately broken code on the integration branch.
- A PR targeting `develop` gets the expected checks. No required check is permanently pending because of workflow-level path filtering.
- No server credentials or external backend/AI dependencies are required. Superseded runs cancel appropriately and job timeouts are bounded.
- `apps/web` documentation explains how to run and troubleshoot the same checks. CI logs/results are sufficient for future contributors to identify which gate failed.
- Once proven green, configure the relevant Web checks as required checks on `develop` in repository settings/rulesets if repository permissions and governance allow; **document any manual settings step rather than claiming it was done solely by committing YAML**.

## Suggested Verification Matrix

| Verification | Expected result |
|---|---|
| PR into `develop` changing `apps/web` | Web static + browser checks run |
| PR into `develop` changing only another package | Required Web checks are not left pending |
| Push to `web/**` | Branch validation runs according to documented trigger policy |
| Clean hosted-runner install | Frozen lockfile succeeds without prior cache |
| Intentional failed check in an isolated test branch | Relevant status reports failure, not success |
| Re-run with no dependency changes | Cached dependency fetch is faster but produces equivalent results |
| Browser test failure | CI shows a failing browser check and useful log/evidence |

## Return `plan.md` With

- Task Plan
- Repository/CI Findings
- Trigger and Required-Check Policy
- Runtime and Dependency Version Policy
- Job Design and Failure Evidence
- File Delta (Modify / Add / Remove)
- Verification Matrix
- Risks / Trade-offs
- Out of Scope

Organize by durable CI capability, not individual shell commands. Do not modify repository files during PLAN.
