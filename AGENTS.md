# Agent Rules

Keep changes within the active task. Avoid unrelated refactoring, speculative
abstractions, unnecessary dependencies, and unrequested features.

## Context Routing

Read only the active package's rules:

- API: `services/api/RULES.md`
- AI: `services/ai/RULES.md`
- Web: `apps/web/RULES.md`
- Mobile: `apps/mobile/RULES.md`

Do not read another package's `RULES.md` or `docs/`.
Cross-package source code and contracts may be inspected when required,
without loading that package's rules or docs.

Do not read docs by default. The Task Specification routes PLAN to specific
docs in the active package; `plan.md` routes BUILD to any docs it needs.
Do not scan entire documentation directories.
For explicitly cross-package tasks, apply each package's rules only to its work.

## PLAN

Follow the Task Specification's locked scope and contracts.
Discover only task-related code, tests, config, migrations, and dependencies.

Keep `plan.md` concise. Prefer:

- Repository Findings
- Affected Files
- Proposed Changes
- Focused Verification

## BUILD

BUILD owns implementation, not discovery or review.

Read `plan.md` and the files directly affected by it before editing.
Do not repeat PLAN discovery.
Expand only for necessary dependencies or direct conflicts.
Write or update focused tests before changing production code.

After implementation, run only the narrowest relevant tests.
Do not run full suites, full builds, startup, or manual checks unless the task
or plan explicitly justifies them.

If tests pass, run `git status --short`, report, and stop.
If they fail, investigate only the related failure, make one corrective pass,
and rerun the same test command once. If it still fails, report and stop.

## Git

Do not perform Git write operations unless explicitly requested.
PLAN may inspect relevant history; REVIEW may inspect relevant diffs.
BUILD does not inspect history or diffs unless required by the task or plan.

Report only changes, focused test results, and blockers or deviations.

