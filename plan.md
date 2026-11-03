# E2E-04 recovery closure planning snapshot

## Repository Findings
- Initial branch: `feat/e2e-transcription-integration`, HEAD
  `3dba2e3e678b5cd45792e6b47bb69f6c51b14686`; 3 tracked modifications and
  20 untracked recovery files, including the original recovery plan.
- During read-only audit, an external commit created
  `de4d3a5678445e2dd98f93eb42fe55dd83eb2029` with 22 campaign files and removed
  the untracked plan. Preserve that commit; this is a new closure snapshot.
- Contract: `contracts/CORE_API_AI_TRANSCRIPTION_WORKER_V1.md`, revision
  `F02-2026-11-04`, wire/schema companions; existing R-A0/R01 and Level A fixtures.
- Original recovery design: R02 post-commit response discard; R03 pre-ACK
  SIGKILL/redelivery; R04 actual lease expiry/stale-command rejection; R05 valid
  immutable reuse/invalid conflict; R06 real classification and Core generations
  0–3; R07 same-state Core outage; R08 in-flight Worker crash/fencing/orphan
  cleanup; R09 overlapping real claims witnessed by two PostgreSQL waiters.
- Archived final-run logs remain locally available. The prior ledger records
  122 focused passes and 11 real passes, zero skips; no new live replay is needed
  for a documentation-only closure with no discovered acceptance defect.

## Affected Files
- Audited recovery implementation: the 22 paths in external commit `de4d3a5`.
- Closure write set: `campaign-ledger.md` audit addendum and this `plan.md`.

## Proposed Changes
- Preserve historical evidence. Append the actual inventory reconciliation,
  security findings, independent archived-observation review and limitations.
- Make one scoped closure commit; inspect the full staged diff and scan staged
  bytes without exposing sensitive values. No push or amendment.
- Keep transcription algorithms, prompts, validators, V1 contracts, production
  sources, audio and defaults frozen. Controlled recovery data is not evidence
  of real-provider inference.

## Focused Verification
- Manual review of all 23 initially present recovery files, all added file
  contents and the three tracked diffs; value-free scan of the 22 committed files.
- Read-only archived-log checks across R01–R09 and original Level A: 14 logs,
  matching identities, fault/classification/claim behavior and bound HTTP
  confirmation before ACK. Database/broker snapshots remain historical ledger
  evidence; this audit does not recreate deleted isolated databases.
- Full relevant Ruff, baseline-to-HEAD whitespace/protected-source diff, isolated
  container/process cleanup inspection, staged-path/count and staged-secret scan.
- Root `AGENTS.md` BUILD stop rules remain governing; the requested autonomous
  multi-phase continuation cannot override them. Future BUILD must read a
  task-specific plan and stop after its passing focused test, or after its one
  corrective rerun still fails.
