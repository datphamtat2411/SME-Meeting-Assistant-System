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

PLAN owns discovery and task-specific decisions.
Follow the Task Specification's locked scope and contracts.
Inspect only task-related code, tests, config, migrations, and dependencies.

Avoid bare-minimum solutions or lazy shortcuts that only aim to get the task done with the least effort. 

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
Avoid bare-minimum solutions or lazy shortcuts that only aim to get the task done with the least effort. 

Implement the complete assigned scope and its acceptance criteria before final
verification. A passing test for a partial implementation is not permission to
stop while required work remains, unless the task explicitly defines that
increment as its deliverable.

Run only the narrowest focused tests needed to verify the affected behavior
and the assigned acceptance criteria. Do not run full suites, full builds,
startup, or unrelated manual checks unless the task or plan explicitly
justifies them.

For each failing focused test:

1. Identify the distinct task-related failure by its failing behavior and
   underlying cause, not incidental line numbers or changing error text.
2. Investigate that failure, make one targeted corrective pass, then rerun
   the same focused test command.
3. If the same failure persists after that corrective pass, report it as a
   blocker with the test evidence and stop. Do not repeatedly patch the same
   unresolved failure.
4. If that failure is fixed but a different failure is exposed, treat it as
   a new failure: investigate it, make its own single corrective pass, and
   rerun the same focused test command. There is no global one-fix or
   one-rerun limit across distinct failures.
5. If a previously corrected failure reappears, treat it as the same
   unresolved failure rather than resetting its corrective-pass allowance.

Do not label an unimplemented requirement or an untested assumption as a
blocker. Report genuine external or architectural blockers with concrete
evidence; do not invent an alternative architecture to bypass them.

When all focused verification required for the assigned scope passes, do not
run additional or broader tests. Run one final `git status --short`, report
the implemented scope, test results, and any remaining gaps, then stop.

## Git

Do not perform Git write operations unless explicitly requested.
PLAN may inspect relevant history; REVIEW may inspect relevant diffs.
BUILD does not inspect history or diffs unless required by the task or plan.

Report only changes, focused test results, and blockers or deviations.