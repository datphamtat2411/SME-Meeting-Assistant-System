# AIMI-T03: Evidence Context Engine and structured LLM adapter

## Consumer interface (T04 / T05 / T06)

`meeting_intelligence.composition.prepare_context(stage_context, task, settings)`
accepts the **verified T02 StageContext**, prepares immutable evidence and returns a
complete `PreparedContext`. It performs no network requests and requires no API key.
Use this only inside an injected T02 processor, after T02 snapshot verification.
Do not construct snapshots from arbitrary model-selected objects or revisions.

```python
from sme_meeting_ai.meeting_intelligence.composition import prepare_context
from sme_meeting_ai.meeting_intelligence.contracts import ResponseSchema, TaskSpec

# Schema and instructions belong to the consuming feature, not T03.
task = TaskSpec(trusted_instructions, "feature-prompt-v1",
                ResponseSchema("feature_response", "feature-schema-v1", feature_schema))

def processor(stage_context):
    prepared = prepare_context(stage_context, task, settings)
    for window in prepared.plan.windows:
        response = prepared.execute(adapter, window.index)
        # Resolve references against the COMPLETE verified source, then apply the
        # feature's evidence/uncertainty policy. This is not claim verification.
        # prepared.plan.source.resolve(segment_id, char_start, char_end)
        # Feature owns combining windows and mapping to its canonical candidate.
    return feature_owned_candidate
```

The example intentionally leaves feature aggregation and candidate construction to
T04–T06. Do not register it as a production processor. T03 adds no processors to the
registry and changes no T02 claims, delivery reconciliation, lease handling, result
serialization or acceptance schemas. Action Item canonical handoff remains T06's.

Instantiate one shared `OpenRouterIntelligenceAdapter(settings)` for the owning
processor composition, close it during teardown, and inject it explicitly.
`ModelAdapter.complete(ModelRequest) -> ModelResult` also accepts deterministic fake
implementations. `PreparedContext.request(index)` retains the original monotonic
deadline and cancellation event; never replace them with a fresh authority budget.
The synchronous adapter is for T02 worker threads; calling it on an async event loop
fails explicitly. It creates scoped async HTTP connections, cancels/awaits in-flight
I/O on fence/deadline/close, and leaves no detached provider thread. Closing the
adapter signals active requests; their owning calls finish cleanup before returning.

## Source and reference guarantees

- Core's `TranscriptViews` projection is the schema: transcript header, ordered
  segments, coverage regions and speaker mappings. There is no assumed ASR warning
  array, confidence score or original-audio provenance in this snapshot version.
- Source identity retains snapshot ID, transcript ID, content revision and the
  **original verified-byte SHA-256**, never a checksum of reserialized JSON.
- Exact text and canonical IDs are preserved; duplicate IDs, invalid order, invalid
  types/control characters and conflicting speaker/timeline evidence fail closed.
  Concurrent/overlapping speech is allowed; known start times cannot go backwards.
- Nullable/missing timing and speaker fields stay unknown; `missing_fields` records
  absence separately from explicit null. No timing is interpolated for subdivisions.
- `source.resolve(segment_id)` returns the original segment as an evidence unit;
  optional offsets are **half-open Python Unicode code-point offsets**, not UTF-8
  bytes, tokens, timestamps or JavaScript UTF-16 indices. Subranges keep the original
  segment ID and original segment timing. Resolve overlap to the same source evidence.
- Full speaker mappings, source header and coverage are retained locally. Provider
  projection includes only window evidence, relevant coverage, labels, anonymity and
  source quality signals. Mapped user IDs/display names and unrelated segment text
  are not transmitted. Labels are untrusted, including labels that resemble names.
- Quality flags map only explicit statuses or missing metadata:
  `INCOMPLETE_COVERAGE`, `UNRESOLVED_EVIDENCE`, `SUSPICIOUS_EVIDENCE`,
  `SOURCE_QUALITY_WARNING`, `UNKNOWN_SEGMENT_QUALITY`, `UNKNOWN_SPEAKERS`,
  `ANONYMOUS_SPEAKERS`, `MISSING_TIMING`, `COVERAGE_UNKNOWN`.
  Empty coverage is unknown, not evidence of full acoustic coverage. Readable text
  does not erase source warnings. Empty unresolved/suspicious segments remain in
  the source and plan; `has_usable_evidence` distinguishes available text.

## Planning and budgets

Plans cover **every source segment/subrange**, in source order, or raise an explicit
`CONTEXT_BUDGET` failure. They never return a falsely complete partial plan. Completeness
means coverage of the authorized snapshot, not full coverage of actual meeting speech.
An individual window reports `contains_entire_source`; multi-window consumers must
handle partial meeting context explicitly. No summary, sampling or map/reduce occurs.

Packing prefers complete segments. Oversized segments are losslessly split into
code-point subranges; optional adjacent-unit overlap is best effort and can shrink
to leave room for new evidence. It never adds independent evidence or blocks progress.
Window IDs depend on source identity, boundaries/order, task, model, planning version
and limits. `plan.to_json()` deterministically exposes provenance and all window
reference mappings; it is sensitive local data, **not a log payload**.

The estimator is deliberately conservative: **one token per byte of the actual
canonical UTF-8 request JSON, plus 256 framing tokens, multiplied by 1.2 (rounded up)**.
It includes JSON escaping, trusted instructions, metadata, identifiers and response
schema. This overestimates typical byte-level Vietnamese/English tokenization; it is
not an exact tokenizer or provider-confirmed usage. Reserved output tokens (including
reasoning) are added separately and must fit the configured context window. Model
context limits must be reviewed explicitly when changing the configured model.

Limits bound source bytes, source/subdivided units, per-window input, windows and
total estimated input volume **including overlap and repeated request overhead**.
Preparation checks authority throughout normalization, subdivision and packing.
Configuration and task/schema changes require a new plan, not reusing old windows.

## Strict responses and privacy

The adapter always sends non-streaming Chat Completions to the fixed OpenRouter HTTPS
endpoint with a named strict `response_format.type=json_schema`,
`provider.require_parameters=true` and `allow_fallbacks=false`. There are no alternative
models, tools, response-healing plugins or automatic JSON repairs. Instructions occupy
the system message; evidence occupies a separately classified untrusted JSON user
message. Prompt injection resistance is an execution-policy boundary, not proof that
the model's semantic proposals are correct. Features must validate grounding.

The supported schema subset has a root object, closed nested objects with all keys
required, bounded arrays (<=500), bounded strings (<=20,000 code points), scalar
types, scalar enums, numeric minimum/maximum and nullable scalar types (`[type,"null"]`).
Descriptions are allowed. Unsupported keywords, references/unions, excessive schema
depth/size and unbounded strings/arrays fail before network access. Use required
nullable scalar properties instead of optional properties. Local validation rejects
duplicate keys, malformed JSON, extra/missing keys, wrong types (including boolean
as integer), invalid enums, oversized structures, tools, refusals and incomplete
finish reasons. No model-generated text is authoritative business evidence.

`ModelResult` contains validated output, requested/reported model and provider,
prompt/schema versions and schema hash, source/window/planning provenance, estimates,
provider-reported usage/cost where available, duration, attempts and preceding safe
failure categories. Estimated usage is never substituted for missing reported usage.
Reported model aliases are recorded, not assumed to identify immutable weights.

Failures expose only `IntelligenceError.category` and a content-free message. They
do not include raw input, raw provider responses or sensitive exception chains. T03
does not log or persist prompts/outputs. Never log `output`, evidence JSON or source
metadata. Safe telemetry can use result provenance, numeric usage, duration and
failure category. StageContext contains no service/claim credentials, and the adapter
does not serialize runtime context, storage/broker configuration or credential headers
into prompts. Feature instructions must likewise contain no credentials/private URLs.

Important categories: `INVALID_SOURCE`, `INVALID_REFERENCE`, `CONTEXT_BUDGET`,
`UNSUPPORTED_SCHEMA`, `CONFIGURATION`, `INFERENCE_DISABLED`, `AUTHENTICATION`,
`UNSUPPORTED_PARAMETERS`, `TIMEOUT`, `TRANSPORT`, `RATE_LIMIT`, `PROVIDER`,
`MALFORMED_OUTPUT`, `SCHEMA_MISMATCH`, `INCOMPLETE_OUTPUT`, `REFUSAL`, `RESOURCE`,
`CANCELLED`, `DEADLINE`. Consumers own mapping failures to existing T02 failure
categories; do not alter the worker protocol. No retry of schema/input/authentication
or unsupported-parameter failures. At most two transient HTTP/transport/timeout
attempts share the original deadline, fence and finite provider timeout.

## Configuration

All names below have the `AI_MEETING_INTELLIGENCE_` prefix. Values are independent
from the existing `WORKER_ENABLED` flag. No credentials are needed to import, prepare
contexts, construct a disabled adapter, or run deterministic qualification.

| Suffix | Default | Purpose |
| --- | --- | --- |
| `INFERENCE_ENABLED` | false | Explicit provider-call authorization |
| `MODEL` | openai/gpt-5-mini | Candidate; no implicit model substitution |
| `CONTEXT_WINDOW_TOKENS` | 32768 | Total input plus reserved output |
| `MAX_INPUT_TOKENS` | 24000 | Estimated per-window request ceiling |
| `MAX_OUTPUT_TOKENS` | 4096 | Completion including reasoning reserve |
| `OVERLAP_UNITS` | 1 | Best-effort overlap, range 0–8 |
| `MAX_WINDOWS` | 64 | Complete plan limit |
| `MAX_TOTAL_CONTEXT_TOKENS` | 1000000 | Sum of estimated window input |
| `MAX_SOURCE_BYTES` | 8388608 | Encoded projection ceiling (at most T02's 8 MiB) |
| `MAX_EVIDENCE_UNITS` | 16384 | Source segments/metadata and subdivided-unit bound |
| `PROVIDER_TIMEOUT_SECONDS` | 60 | Per-attempt wall/network time, at most stage deadline |
| `MAX_ATTEMPTS` | 2 | Transient attempts only; range 1–2 |
| `MAX_RESPONSE_BYTES` | 1048576 | Provider envelope byte ceiling |
| `MAX_CONCURRENT_REQUESTS` | 1 | Per-adapter concurrency, range 1–4 |

Use the existing `OPENROUTER_API_KEY` secret only for requested enabled execution.
The adapter disables environment proxies and redirects. Share one adapter per owning
composition to enforce its concurrency limit. Queue waits retain stage authority.

## Lightweight Vietnamese qualification

Four public synthetic fixtures cover ordinary discussion, mixed technical language,
anonymous speakers/ambiguity and incomplete evidence with participant prompt injection.
`meeting_intelligence.qualification.qualify(adapter, settings)` runs reference-echo
probes with strict output schemas and validates references against each source.
Deterministic fake responses verify formatting, validation and execution invariants;
they **do not establish real model quality**. This is not T07's labeled evaluation.

During PLAN, OpenRouter's public model endpoint metadata advertised `response_format`
and `structured_outputs` support for `openai/gpt-5-mini` (checked 2026-11-09).
Sources: https://openrouter.ai/docs/guides/features/structured-outputs and
https://openrouter.ai/api/v1/models/openai/gpt-5-mini/endpoints . Routing support is
required on every call; endpoint support can change and unsupported calls fail.
**Live compatibility qualification is pending** until an authorized operator runs:

```sh
RUN_OPENROUTER_LIVE_INTELLIGENCE=1 AI_MEETING_INTELLIGENCE_INFERENCE_ENABLED=true \
  .venv/bin/python -m pytest tests/integration/test_intelligence_context_live.py -m live_provider
```

Supply `OPENROUTER_API_KEY` through the process environment/secret mechanism. The live
test never reads dotenv, skips before constructing a provider without opt-in, and
requires both explicit enablement and credentials. It sends only synthetic fixtures.
A successful live probe establishes lightweight request/reference compatibility for
the recorded model, not production semantic quality or immutable model behavior.
