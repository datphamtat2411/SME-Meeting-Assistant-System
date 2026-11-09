# AIMI-T07 Meeting Intelligence Evaluation

## Boundary and Evidence Levels

The T07 evaluator is test-local under `tests/evaluation/` and reuses the
existing evaluation foundation. It does not change the Summary, Decision, or
Action Item processors, invoke the Meeting Intelligence worker, write Core
business state, or add a provider.

Every report distinguishes:

- **Deterministic software evidence:** manifest/reference integrity, canonical
  parsing, matching, metric arithmetic, report generation, and controlled
  processor execution. Controlled adapters are not model-quality evidence.
- **Offline reference evaluation:** scoring of previously captured predictions
  whose source, model, prompt, processor, and dataset identities are retained.
- **Human-reviewed semantic quality:** claim-level support, omissions, evidence
  relevance, Vietnamese clarity, and adjudicated disagreement recorded in a
  review artifact. A template is not a completed review.
- **Approved live compatibility:** an explicitly authorized OpenRouter run with
  finite calls and budget. Provider success is not accuracy.
- **Production readiness:** outside T07 and remains `UNAVAILABLE` until the
  T08 security, privacy, operational, deployment, and quality approvals exist.

No real-model benchmark is claimed by the committed synthetic corpus. Without
reviewed references and authorized real predictions, model-quality status is
`UNESTABLISHED`, not `PASS` or `FAIL`.

## Dataset Contract

The committed corpus is
`tests/evaluation/fixtures/meeting-intelligence-manifest.json`. Its schema is
`meeting-intelligence-1`; the source files are the existing Core
TranscriptViews snapshot shape, not a second transcript representation.

Each manifest case records:

- stable `fixture_id`, dataset version, feature set, categories, and eligibility;
- source relative path, snapshot ID, transcript ID, content revision, language,
  byte size, and SHA-256;
- reference relative path, reference/annotation versions, SHA-256, and origin;
- dataset, guideline, scoring-policy, privacy, and approval identities.

`load_meeting_dataset()` rejects duplicate JSON keys, unsupported versions,
duplicate fixture IDs, path traversal, absolute or symlinked assets, source or
reference checksum changes, stale transcript revisions, invalid Core snapshots,
invalid Unicode ranges, duplicate labels, and conflicting semantic labels. It
validates annotation evidence with the same T03 source resolver used by
production processors. The immutable source bytes are shared by all features
in a case.

The committed data is synthetic and non-sensitive. It covers short routine
meetings, long multi-topic meetings, Vietnamese-English technical language,
multiple and anonymous speakers, accepted/proposed/rejected/revised and
conditional decisions, assignments and self-commitments, missing assignees,
relative deadlines, cancellation/reassignment, contradictions, historical
references, empty extractions, incomplete/unresolved coverage, cross-window
correction, and transcript prompt injection. It is regression coverage, not a
statistically representative Vietnamese corpus.

## Independent References

Reference files contain labels that are independent of processor output:

- `summary_facts` are important information units with explicit aliases,
  importance, early/middle/late region, required qualifications, uncertainty,
  and source ranges.
- `decisions` include valid final outcomes and negative events such as
  proposals, rejections, historical decisions, unresolved conflicts, and
  action-only statements. Only `ACCEPTED`, `REVISED`, and `CONDITIONAL` labels
  with `valid=true` are expected final decisions.
- `action_items` include active obligations and negative events such as
  suggestions, cancellations, historical work, decision-only statements, and
  unresolved responsibility. The reference keeps deliverable, party, due-date,
  state, null-field expectations, and evidence separate.
- `contradictions` specify the required qualification and prohibited consensus
  wording.
- `expected_warnings` records source-quality warnings without treating a
  warning as proof of model correctness.

`synthetic-independent` means independently authored from the processor
prediction and not human-reviewed. It must not be described as human ground
truth. `human-double-review` requires two reviewer identities;
`human-adjudicated` additionally requires an adjudication identity. Disagreement
is retained and an unadjudicated disagreement cannot establish a model gate.

## Vietnamese Annotation Guidance

Annotators should read the immutable source first and record evidence ranges as
half-open Unicode code-point offsets. Use the exact original segment ID and
content revision. Do not copy a model prediction into a reference label.

Summary facts:

- A factual unit must state information material to the meeting, not a generic
  greeting or a keyword.
- Mark a point as omitted only when it is independently important; a short
  summary with no unsupported claims can still have poor coverage.
- Preserve qualifiers such as `chưa chốt`, `có điều kiện`, `bác bỏ`, and
  `chưa có kết luận chung`. Do not rewrite a proposal as an agreement.
- Treat a later correction, rejection, or cancellation as a distinct source
  event and record the final state in the contradiction/revision labels.

Decision labels:

- `ACCEPTED` requires explicit adoption, for example “Nhóm thống nhất dùng
  PostgreSQL”.
- “Tôi đề xuất dùng Redis”, “Có lẽ nên đổi”, and “Để hôm sau quyết định” are
  proposals or unresolved discussion, not decisions.
- “MongoDB không phù hợp” is rejection evidence. A later explicit adoption of
  another option is a revised/final decision, not two active decisions.
- A conditional adoption retains the material condition and uncertainty.
- A historical statement such as “Tuần trước đã quyết định...” is not a new
  current-meeting decision.

Action Item labels:

- An actionable commitment has an explicit assignment or commitment, for
  example “Lan sẽ gửi báo cáo API” or “Anh Minh kiểm thử API”.
- “Chúng ta nên cải thiện hiệu năng” is a suggestion, not an obligation.
- Record `mentioned_party=null` when the source does not establish an owner;
  do not invent a user identity from `SPEAKER_00`.
- Keep relative expressions such as `trước thứ Sáu` as source evidence but set
  the normalized due date to null unless an explicit calendar date is present.
- A later “hủy ... không cần làm nữa” suppresses the active task. A supported
  reassignment or scope revision replaces the earlier obligation.
- Historical completion is not an active follow-up. A decision without work is
  not automatically an Action Item.

Prompt-injection text is transcript data. It is never an instruction and is not
annotated as a meeting fact, decision, owner, deadline, or task.

## Scoring

Scoring uses explicit annotation aliases/equivalence keys and deterministic
one-to-one matching. A prediction cannot match multiple references. Word
overlap, BLEU, ROUGE, embeddings, and an LLM judge are not substitutes for
reviewed semantic equivalence.

Summary metrics:

- `coverage_rate` = matched independently labeled facts / all labeled facts;
  `critical_coverage_rate` uses critical/material facts.
- `groundedness` = reviewed supported claims / reviewed claims. It is
  `UNESTABLISHED` when no claim review exists; automatic alias matches are only
  diagnostic.
- `material_omission_count` records important unmatched facts.
- `unsupported_factual_claim_count` and critical unsupported claims come from
  reviewed judgments, not from arbitrary similarity thresholds.
- `warning_recall`, qualification and uncertainty-term preservation,
  contradiction handling, and early/middle/late coverage are reported
  independently.
- Readability/usefulness review belongs in the review artifact and is not
  inferred from formatting or length.

Decision metrics:

- `precision = TP / predictions`, `recall = TP / valid references`, and
  `F1 = 2TP / (2TP + FP + FN)`.
- Rejected-proposal promotion, historical promotion, action-only promotion,
  duplicate candidates, conditional uncertainty, and evidence relevance are
  separate fields.
- Negative fixtures with no valid decisions retain a real false-positive
  denominator. Empty valid extraction is not a processor failure.

Action Item metrics:

- Precision, recall, F1, false-obligation rate, duplicate rate, and one-to-one
  deliverable matching are reported.
- Cancellation, historical work, and decision-only false positives are
  critical categories rather than being averaged away.
- Unsupported or incorrect dates, missing supported dates, and unsupported
  assignee implications are separate. Unknown assignee is acceptable when the
  source is unknown.

Evidence is scored separately from content: structural segment/range validity,
source snapshot/revision binding, relevant support, and multi-segment evidence
completeness. A valid UUID is not semantic support.

Zero denominators produce `null` and are listed in `undefined_metrics`; they do
not become perfect scores. Reports contain both per-case and aggregate data.

## Execution and Reports

`run_processor_case()` calls the actual production processor through an
injected adapter and validates the resulting candidate through
`serialize_result()` or `prepare_action_item_request()`. It records processor,
model, prompt, provider, source, configuration, timing, and provider-reported
usage/cost only when present. Failed processing retains a failure status and is
never converted to an empty result.

The normal deterministic command is:

```sh
uv run pytest tests/evaluation/test_meeting_intelligence_support.py \
  tests/evaluation/test_meeting_intelligence_runner.py
```

Previously captured outputs are loaded with `load_captured_run()` and scored by
`score_captured_run()` without model calls. Captured runs must retain dataset
identity, source revision, feature, status, and safe provenance. Raw prompts,
credentials, and unrestricted provider bodies do not belong in reports.

`build_evaluation_report()` emits schema-versioned JSON with dataset/run
identity, attempted/successful/failed counts, feature metrics, per-case safe
records, critical failures, timing/usage, gates, missing evidence, limitations,
and optional regression comparison. `render_evaluation_summary()` and
`write_evaluation_summary()` provide a concise Markdown review artifact with
gate status, aggregate metrics, critical-failure categories, limitations, and
regression status without transcript text or raw model output.
`write_evaluation_report()` and `write_evaluation_summary()` require explicit
existing parents and do not create implicit destinations.

`build_review_template()` is a pending, metadata-only reviewer template. A
completed review must be independently performed, retain disagreement, and be
adjudicated before it can support a model-quality gate.

## Gates and Regression

`GatePolicy` is versioned and must explicitly supply sample/reference coverage,
minimum case count, feature thresholds, critical-failure maximum, required
categories, and review policy. `evaluate_quality_gates()` reports:

- `software_gate`: deterministic contract/evaluator status;
- `model_quality_gate`: `PASS`/`FAIL` only for compatible approved evidence,
  otherwise `UNESTABLISHED` or `UNAVAILABLE`;
- `production_readiness_gate`: always outside T07 and `UNAVAILABLE` here.

`compare_reports()` refuses direct comparison when dataset, source manifest,
annotation, or scoring-policy identity differs. Compatible comparisons show
per-fixture metric deltas and critical failures added/resolved. A favorable
average cannot hide a newly fabricated deadline, obligation, or agreement.

## Live Provider Controls and Privacy

`run_live_evaluation()` is not used by CI. It requires all of:

- `RUN_MEETING_INTELLIGENCE_LIVE=1`;
- explicit operator opt-in and dataset/privacy authorization;
- a finite positive maximum-call count and budget;
- inference enabled, valid credentials, an approved dataset, and a new output
  path outside the repository and source assets.

It uses the existing `OpenRouterIntelligenceAdapter` and never enables the
production worker. No private production meeting is uploaded implicitly.
The live adapter enforces both limits before each provider request; the budget
is the caller-supplied upper bound on estimated input plus reserved output
tokens for the run. A sibling Markdown summary is written beside the JSON
report.
Synthetic committed fixtures contain no sensitive data. External private
datasets, completed reviews, and live artifacts must remain outside Git in
restricted directories. Retain only the minimum provenance needed for review,
and delete external transcripts, prompts, raw outputs, and provider artifacts
according to the owning privacy/retention approval.

## AIMI-T08 Handoff

T08 must add release and deployment controls, provider/privacy approval for any
external data, restricted artifact lifecycle, operational monitoring, rollback,
and production-readiness sign-off. T07 supplies the report identity, scoring
policy, review status, critical-failure inventory, and explicit evidence gap; it
does not authorize rollout or infer quality from deterministic tests.
