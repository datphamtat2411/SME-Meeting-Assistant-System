# MI-PM-06 — Vietnamese Multiline AI Result Contract Hardening

**Scope:** Core API strict result v1 consumer/parser and its published API-owned JSON Schema. No changes to AI Core models, inference, prompts, producer credentials or result envelope shape.

## Decision and trade-offs

- The existing universal `string()` validator remains **strict** for UUIDs, result type, producer metadata, warning enums, uncertainty and candidate IDs. Do not turn it into a generic text sanitizer.
- Only `result.content` (Summary and Decision candidate) uses `contentText()`: accepts UTF-8 Vietnamese paragraphs, LF (`\\n`), tab (`\\t`) and Windows CRLF (`\\r\\n`); normalizes CRLF to LF for canonical persistence. It rejects standalone CR, ASCII/C1 controls, blank content and content above the **pre-normalization** 20,000/5,000 Unicode-code-point limit. It never trims ordinary text or normalizes Unicode NFC/NFD, which could otherwise change a user's spelling/evidence mapping.
- JSON Schema v1 retains the same required fields, strict `additionalProperties: false`, sizes, fixed warning enum, evidence bounds and producer metadata shape. The two content properties now have a portable anchored regular expression for permitted line breaks and disallowed C0/C1 controls. Model/promptVersion/provider patterns now explicitly forbid C0/C1 controls, matching the existing Java metadata validator.
- No new framework dependency or schema version is needed: this clarifies what previously valid multiline JSON string values mean, without adding or removing fields. Java parser and schema pattern behavior are checked on shared fixtures in `IntelligenceResultMultilineContractTests`.
- The existing 4 MiB immutable result-object boundary, sha256 digest, Media stage fencing, canonical receipt/audit and Meeting-level authorization remain unchanged. The AI producer contract remains a **cross-team review gate** (G2), not an assertion of AI team sign-off.

## Required acceptance

- LF, CRLF and TAB in valid Vietnamese Summary and Decision content are ingested with correct whitespace semantics; CRLF is stored/read back as LF.
- Empty/whitespace-only, oversize, standalone CR, null, ESC/BS/FF, DEL and C1 controls are rejected; metadata cannot gain a newline, tab, CRLF, or control character.
- Strict v1 rejects extra fields, wrong schema version, duplicate candidate keys/evidence IDs, invalid warnings and source IDs (existing regression suite).
- Full CI `./mvnw -B -ntp verify` **must succeed at final branch HEAD**, including PostgreSQL integration and direct schema contract fixtures.

**Deferred:** authenticated worker integration and AI-owned producer implementation remain MI-PM-07 / AI team scope.
