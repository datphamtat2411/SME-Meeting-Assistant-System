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

When a focused test command fails, treat its complete failure output as one
failure batch:

1. Collect and identify ALL distinct task-related failures reported by that
   test run before making corrections. Track failure identity by behavior and
   underlying cause, not incidental line numbers or changing error text.
2. Make ONE corrective pass addressing every failure in the batch. Do not rerun
   the focused test after fixing only one of several reported failures.
3. Rerun the SAME focused test command once after the batch has been addressed.
4. If ANY previously observed failure persists or reappears in the new run,
   report it as a blocker with the relevant evidence and stop. Do not start
   another corrective pass for a previously addressed failure.
5. If all previously observed failures are gone but NEW distinct failures
   appear, treat those new failures as a new batch: correct ALL of them in
   one pass and rerun the same focused test command.
6. Repeat this batch-based process only while each rerun exposes exclusively
   new failures. There is no global limit of one corrective pass or one rerun
   across distinct failure batches.

Example: if the first run reports A, B, C, and D, correct all four before
rerunning. If the next run is green, continue to completion. If A, B, C, or D
appears again, stop and report the recurring failure. If only new failures
E and F appear, correct both before rerunning.
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