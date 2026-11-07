# Offline diarization result — version 1.0 (SPK-06)

This is a standalone successful-result contract owned by processing stage
`DIARIZING`. Its exact discriminator values are `contractVersion: "1.0"`,
`resultType: "DIARIZATION_RESULT"`, and `status: "COMPLETED"`. Incompatible
semantics require a new version; validators do not reinterpret versions.

The accompanying [shape schema](DIARIZATION_RESULT_V1.schema.json), semantic
rules below, and [shared fixture vectors](DIARIZATION_RESULT_V1.fixtures.json)
define one logical contract. JSON Schema alone cannot enforce strict integer
tokens, duplicate-key rejection, snapshot authority, or cross-field rules.

## Required envelope

Every field below is required. Objects reject unknown and duplicate keys,
including duplicates expressed with escaped JSON key characters.

| Field | Exact type / constraint |
| --- | --- |
| `contractVersion` | String, exactly `1.0` |
| `resultType` | String, exactly `DIARIZATION_RESULT` |
| `processingJobId` | Full hyphenated UUID |
| `sourceMediaId` | Full hyphenated UUID |
| `sourceRevision` | Lowercase 64-character hexadecimal SHA-256 |
| `transcriptId` | Full hyphenated UUID |
| `transcriptRevision` | Nonnegative integer |
| `producerStageRunId` | Full hyphenated UUID identifying the producing attempt |
| `modelId` | Safe model identifier, 1–256 ASCII characters; grammar below |
| `status` | String, exactly `COMPLETED` |
| `speakerLabels` | Array of at most 1,000 canonical strings |
| `turns` | Array of at most 100,000 exact turn objects |
| `assignments` | Array of at most 16,384 exact assignment objects |
| `diagnostics` | Exact object containing only `unknownAssignmentCount` |

UUID strings use 8-4-4-4-12 hexadecimal groups. Either letter case is accepted;
bindings compare UUID values. Python serialization emits lowercase UUIDs.
SHA-256 strings are always lowercase. The artifact contains no transcript
text, correction metadata, participant identifiers, provider credentials,
storage locations, or free-form diagnostics. There is no `processingStage`
wire field: `DIARIZING` is a contract constant for future integration.

## Independent trusted context

Both validators require a `ValidationContext` supplied independently of the
artifact. It contains the expected processing job UUID, source media UUID and
revision, transcript UUID and revision, authorized producer-stage-run UUID,
trusted audio duration in milliseconds, and ordered expected segment ordinals.
All six identity/revision bindings must match exactly. Stale revisions and
results from another attempt/job/source/transcript are rejected.

Core must obtain transcript identity, revision, ordinals, and duration from an
authenticated, Core-authoritative pinned transcript-processing snapshot. The
future producer must receive that authorized snapshot, rather than inventing
values from an untrusted queue message. The producing attempt must likewise be
authorized independently. A matching self-asserted identity or digest is not
authorization. These pure contract classes cannot establish context origin.

Contexts reject missing identities, malformed source revisions, negative
revision/duration/ordinals, duplicate expected ordinals, and more than 16,384
expected segments. Context collections are immutable/defensively copied.

## Speakers, turns, and assignments

- Labels must be exactly the ordered sequence `SPEAKER_01`, `SPEAKER_02`, …,
  `SPEAKER_99`, `SPEAKER_100`, …, `SPEAKER_1000`. Numbering uses a minimum of
  two digits, no additional zero padding, duplicates, or gaps. The serializer
  validates existing numbering; it does not assign or renumber clusters.
- These are anonymous transcript-local clusters, not verified participants or
  organizational users.
- A turn has exactly `startMs`, `endMs`, and `speakerLabel`. Timestamps are
  integer milliseconds and satisfy `0 <= startMs < endMs <= trustedDurationMs`.
  Turns are ordered by nondecreasing start, with equal starts allowed. Overlaps
  are preserved; validation imposes no disjointness, merging, or tie ordering.
- Every turn references a declared label, and every declared label has at least
  one turn. Assignment labels do not substitute for turn evidence.
- An assignment has exactly `ordinal` and `speakerLabel`; the latter is a
  declared string or explicit JSON `null`. There must be exactly one assignment
  for each expected segment, in precisely the snapshot order. Ordinals are
  unique and nonnegative but need not be consecutive or numerically sorted.
- Null assignments remain unknown. Validation does not rerun alignment or
  manufacture evidence. SPK-02 coverage/dominance semantics remain in the
  alignment service, with no changed thresholds.
- `diagnostics.unknownAssignmentCount` is an integer from 0 through 16,384,
  exactly equal to the number of null assignment labels. No other keys exist.

Completed inference may find zero speakers: empty labels and turns with all
expected assignments explicitly null is valid. An empty snapshot can have
empty assignments. `failed` and `skipped` service outcomes, or a completed
response containing an error category, cannot be adapted to this artifact.
Future stage-specific failure reporting is a separate lifecycle mechanism.

## Model provenance

Preserve the existing configured provider identity, currently:

```text
konieshadow/speaker-diarization:c58b6b038f6de30f93eaccd6aecb59d1b9a48ac13b22be000bcffe853efb2c20
```

Identifiers follow this ASCII full-match grammar and contain no `..`:

```text
[A-Za-z0-9][A-Za-z0-9_.-]*(?:/[A-Za-z0-9][A-Za-z0-9_.-]*)*(?::[A-Za-z0-9][A-Za-z0-9_.-]*)?
```

This admits a model name, optional namespace components, and an optional
provider-established version suffix. No suffix is fabricated or required by
the contract. Whitespace, controls, Unicode format/surrogate characters,
URLs, query strings, credentials with `@`/`=`, and malformed paths fail.

Additionally, split on `/` and `:` and compare components case-insensitively:

- Reject exact reserved credential names `api_key`, `api-key`, `apikey`,
  `access_token`, `access-token`, `authorization`, `bearer`, `password`,
  `secret`, `token`.
- Reject components beginning with `sk-`, `sk_`, `r8_`, `hf_`, `ghp_`, `gho_`,
  `ghu_`, `ghs_`, `ghr_`, `github_pat_`, `xoxb-`, `xoxp-`, `xoxa-`, `xoxr-`,
  `xoxs-`, `akia`, `asia`, or `eyj` (common credential/JWT forms).

These deterministic rejection rules apply equally in both languages. Model
provenance supplies traceability; it does not authenticate a provider or confer
business authority. No other provider metadata is accepted.

## Bytes, limits, and integrity

- Artifacts are UTF-8 JSON objects, at most **16,777,216 bytes**, inclusive of
  whitespace. Reject oversized bytes before hashing, decoding, or parsing.
  Producers also bound output encoding and never truncate evidence.
- Reject invalid UTF-8, a leading BOM, duplicate keys at every object level,
  trailing JSON, malformed syntax, non-finite values, and unsupported types.
- Integers use integer JSON tokens only: `7.0`, `7e0`, `"7"`, and booleans
  are not integers. Python integers and Java `BigInteger` preserve exact
  values, including values beyond signed 64-bit range. To bound numeric parsing
  consistently, integer tokens/values have at most **4,300 decimal digits**.
  The parser nesting limit is **8**; the v1 shape needs only 3 containers.
- Collection limits are checked independently of the byte bound, including
  Python typed construction. Collections are never silently shortened.
- SHA-256 covers the **exact artifact bytes**, including whitespace, property
  order, and escape spelling. The expected lowercase digest is supplied by
  the trusted completion context and is not a field inside the envelope.
  Both parsers require this expected digest and reject mismatches.
- Java verifies the received bytes directly; it does not serialize a parsed
  result to check integrity or depend on Python JSON formatting.
- Python emits deterministic compact JSON in the documented envelope/child
  field order, no BOM or trailing newline. It returns immutable bytes and
  their external lowercase SHA-256 value. Equal validated inputs produce
  identical bytes. All turn/assignment values and array ordering survive.
- Validation failures expose one fixed message and no artifact/decoder cause.

## Implementation entry points

Python: `sme_meeting_ai.diarization.contract`

```python
result = DiarizationResultEnvelope.from_response(completed_response, trusted_context)
artifact = serialize_result(result, trusted_context)  # .data bytes, .sha256 string
validated = validate_result(artifact.data, trusted_context, artifact.sha256)
```

Direct typed envelope construction also checks structural semantics; snapshot
validation is mandatory when serializing or accepting bytes. `SpeakerTurn` and
`SpeakerAssignment` are the existing AI diarization evidence models.

Java: `com.sme.meetingassistant.api.diarization.contract.DiarizationResultContract`

```java
var result = DiarizationResultContract.validate(bytes, trustedContext, expectedSha256);
```

The returned `ValidatedResult` has immutable lists and exact identity,
provenance, turn, assignment, and aggregate-diagnostic values. It is data for
future canonical persistence, not a persistence command. Its validator uses a
contract-private strict Jackson configuration.

## Shared deterministic verification

`DIARIZATION_RESULT_V1.fixtures.json` contains fixed identities, the full base
JSON result, valid examples, and invalid vectors. Both suites independently
expand the same vectors and validate serialized JSON, not prevalidated DTOs.

- `set` / `contextSet`: replace/add values at slash-separated object/array
  paths; `remove`: remove a required key.
- `speakerCount`: generate ordered canonical labels and a unit turn per label.
  `turnCount`: repeat the base turn. `assignmentCount`: generate ordinals
  `0..N-1`, null assignments, and the matching context/count.
- `modelLength`: repeat `m`. `integerDigits`: set the context/result revision
  to `10^(N-1)` (oversized tokens are inserted as raw JSON).
- `rawReplace`: replace literal substrings in compact JSON. `raw` / `rawHex`:
  provide literal JSON/bytes. `paddedBytes`: right-pad serialized bytes with
  ASCII spaces to the exact size. `expectedDigest`: override the independently
  calculated digest for negative integrity cases.
- `canonicalBytes`: require Python serialization to match the shared literal
  artifact byte-for-byte; Java independently validates those same bytes.

Large limits are deterministic recipes rather than multi-megabyte checked-in
padding. Positive cases cover one/multiple/>9/>99 speakers, overlaps, unknown
assignments, empty completed inference, every inclusive collection/byte limit,
and large exact integers. Negative cases exercise malformed wire data, strict
types, every binding, references/order/completeness, diagnostics, model safety,
resource limits, and integrity. Python also tests service adaptation, typed
construction, bounded serialization, and preservation/determinism. Java checks
immutable validated data, exact turn preservation, and context copying.

Focused commands (repository root unless a working directory is noted):

```sh
# services/ai working directory
.venv/bin/ruff check src/sme_meeting_ai/diarization/contract.py tests/unit/test_diarization_contract.py
# repository root
services/ai/.venv/bin/python -m pytest services/ai/tests/unit/test_diarization_contract.py && services/api/mvnw -f services/api/pom.xml -Dtest=DiarizationResultContractTests test
```

## Integration boundary

SPK-06 adds no provider calls, inference/alignment/numbering changes, worker
execution, stage planning, messaging, HTTP endpoints, claims/leases/retries,
S3/storage, database writes/migrations/projections, participant mapping, or UI.
The `CORRECTED_TRANSCRIPT` schema and acceptance path are independent and are
not imported by this contract. Authorized snapshot delivery, stage lifecycle,
immutable storage, completion receipts, and canonical persistence belong to
later tasks. This implementation stops at SPK-06.
