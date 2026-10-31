# 05-preprocessing-quality-evaluation-and-regression.md

Read `AGENTS.md`.

Plan Preprocessing Quality Evaluation & Regression for `services/ai` in `module-audio-preprocessing`.

Start discovery around:
- existing preprocessing workflow, result contracts, and quality evidence;
- normalization, VAD, and speech-map configuration/provenance;
- current focused tests, fixtures, and evaluation conventions.

Use these as entry points, not an exhaustive file list. Follow only task-related source dependencies.

Read only:
- `docs/PROCESSING.md`;
- `docs/TESTING.md`.

Plan these capabilities:
- establish reproducible, annotated audio fixtures representing Vietnamese meeting conditions;
- evaluate normalization integrity, speech detection quality, timing accuracy, and boundary protection;
- measure speech coverage, missed-speech regions, false positives, and uncertainty handling;
- add focused end-to-end preprocessing regression tests and traceable evaluation results.

Task-specific constraints:
- Cover silence, weak/distant speech, background noise, music, continuous speech, recording boundaries, and long audio.
- Use independently labeled speech intervals; never treat VAD predictions as ground truth.
- Evaluate actual VAD inference on approved fixtures, not exclusively mocked outputs.
- Verify normalized audio integrity, sample-based timing, and preservation of leading/trailing content.
- Detect material speech omissions; uncertain regions must not silently become confirmed silence.
- Evaluate conservative detection against false positives, especially noise and music.
- Include speech-map evidence relevant to known silent-speech-loss regressions without invoking ASR.
- Keep datasets privacy-approved and legally usable; prohibit implicit fixture/model downloads.
- Record dataset, pipeline, model, and configuration versions alongside evaluation metrics.
- Keep quality thresholds evidence-based; report unestablished gates explicitly rather than inventing passing criteria.
- Ensure deterministic checks remain reproducible; distinguish probabilistic model evaluation from unit tests.
- Reuse existing processing capabilities without redesigning algorithms or introducing unrelated dependencies.

Out of scope:
- ASR execution, transcript coverage validation, recovery, and reconciliation;
- model training, broad hyperparameter optimization, or algorithm redesign;
- a general-purpose evaluation platform, external infrastructure, or production deployment.

Return `plan.md` with exactly:
- Task Plan
- Repository Findings
- Proposed Changes
- API Surface
- Configuration
- File Delta
- Focused Tests
- Out of Scope

Keep `plan.md` within roughly 150 lines. Organize Proposed Changes by capability, not file. Keep File Delta to Modify / Add / Remove inventory only. Specify focused regression and evaluation commands. Do not modify repository files.
