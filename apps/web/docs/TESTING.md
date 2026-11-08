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
