# DE-07 — Safe, Deterministic Vietnamese Markdown Minutes Renderer

> **Engineering task gate:** DE-07 is CLOSED only when **full API CI succeeds on the final branch HEAD** with its renderer suite executed without failures/errors/skips. Product/Operations policies D08/D09/D11/D13 stay pending unless separately approved.
>
> **Branch:** api/module-dashboard-export. **Scope:** DE-07 only — pure Markdown rendering from DE-05 immutable MinutesSnapshot, ready for DE-09/10 storage integration. No public export endpoint, background worker, S3 write or Flyway migration is introduced.
>
> **Traceability:** RE06 FEAT-EXP-FILE-001/003/004, FEAT-EXP-MINUTES-001..003; RE03 ARCH-EXP-001/002/004; RE04 BR-EXP-001..004; RE08 SEC-DL-001/002/003, SEC-OBJ-*; RE02 API-EP-EXP-002..004; DE05_CANONICAL_MEETING_MINUTES.md; DE06_EXPORT_PERSISTENCE_STATE_MACHINE.md.

## 1. API and ownership

**Java renderer:** services/api/src/main/java/com/sme/meetingassistant/api/meetingexport/render/MarkdownMinutesRenderer.java.

- Method: RenderedMarkdown render(MinutesSnapshot snapshot).
- Spring bean: MarkdownMinutesRenderer, stateless singleton. May be used directly in unit tests without Spring initialization.
- Input: **only an already assembled, authorized, immutable DE-05 MinutesSnapshot**. No meetingId query, per-field repository call, JDBC, AI inference, network, disk, or S3 access in the renderer.
- Output: immutable RenderedMarkdown, with defensive-copy UTF-8 byte array, byte length, lowercase SHA-256 digest of exact byte payload, sourceFingerprint, rendererVersion, MIME type text/markdown; charset=UTF-8, extension md.
- Stable renderer version: **markdown-v1**. Change of layout/escaping/content requires incrementing version and assessing DE-11 artifact fingerprints and stored rendererVersion.
- Completeness, canonical statuses and sourceFingerprint are copied as provenance, not fabricated or reinterpreted into a new state; sourceFingerprint is a marker, not a signature or authorization capability.
- The renderer **does not recalculate the DE-05 source fingerprint**, because a different Jackson configuration could disagree with the original canonical serializer. DE-09 must verify the pinned original snapshot bytes/declared fingerprint before rendering; DE-10 must verify the persisted generated artifact's actual SHA/byte size before calling DE-06 publishReady.

There is no request timestamp, database clock call or current time in Markdown bytes: **assembledAt is intentionally omitted**. Rendering the same immutable snapshot twice with identical renderer version produces byte-identical output, regardless of when the underlying preview was requested. Timestamps from canonical business sources are formatted as UTC ISO-8601 instants.

## 2. Controlled document layout

Top-level stable heading: Biên bản cuộc họp. Sections appear in this exact order:

1. Thông tin cuộc họp — meeting title/description, ID, organizer, canonical meeting lifecycle status and schedule/actual start/end instants.
2. Mức độ đầy đủ và cảnh báo — snapshot completeness and all warning codes, plus explicit notice that AI proposals are not included and meeting ENDED is not proof AI succeeded.
3. Tóm tắt cuộc họp — current Summary only when present, source version, selectionEpoch, quality, transcript revision, stale flag, AI warnings and escaped content in a controlled multiline quote block.
4. Quyết định đã xác nhận — **CONFIRMED only**, content, reviewer/time, source/version/stale, transcript evidence IDs, AI uncertainty and warnings. No proposal masquerades as an official decision.
5. Công việc chính thức — **OPEN/IN_PROGRESS/DONE/CANCELLED** and manually sourced or human-confirmed only; ID, assignee, due DATE, creation/confirmation, source/version, escaped title/details. No proposed Action Item counts as a committed obligation.
6. Nguồn transcript và độ phủ — current Transcript reference and source revision, suspicious/unresolved segment and uncovered-region counts, with explicit text that transcript speech is not silently copied/generated.
7. Dấu vết dữ liệu và bản xuất — snapshot schema, DE-05 source fingerprint and renderer version.

Missing Summary or Transcript is explicitly marked as unavailable. Empty approved decisions or official actions have an explicit empty-population message rather than invented approved content. Stale Summary/Decision and suspicious/uncertain transcript evidence remain labeled even when approved content is shown.

**Output is Vietnamese-language Markdown**, not English-only or ASCII-converted. Accent marks, non-Latin script and emoji round-trip through UTF-8. Output uses canonical LF line endings and no UTF-8 BOM. There is no renderer-generated Markdown table: avoids ambiguity around user-controlled pipe characters and multiline field wrapping.

## 3. Safe Markdown text rules

All source text, including titles, descriptions, Summary, Decisions, Action Items, warning codes and metadata, must pass through SafeMarkdownText:

- Literal Markdown special characters are backslash-escaped; HTML tag brackets are entity-encoded. This prevents source input from introducing raw HTML, link/image syntax, headers, tables, nested blockquotes and fenced code blocks as document structure.
- Source-controlled line breaks in metadata are flattened to a space. Multiline content is normalized to LF and each line is prefixed with the renderer-owned blockquote marker after escaping; source input cannot terminate the blockquote and inject a new top-level heading.
- CRLF, CR, NEL, Unicode line/paragraph separators are normalized. Tabs become spaces. Control/ANSI and bidirectional spoofing characters are replaced by visible replacement characters; ordinary Vietnamese Unicode and emoji are preserved.
- Source text is NEVER used as a path, URL, filename, renderer template, raw HTML fragment, Markdown instruction, HTTP header, S3 key or SQL argument.
- The renderer makes **no external resource requests**. Downstream Markdown preview applications should still use safe HTML sanitization and disable remote image loading; merely emitting safely escaped Markdown does not make an arbitrary third-party Markdown viewer trustworthy.

Fail closed rather than silently truncate source evidence:
- Unsupported Minutes schemaVersion, invalid source fingerprint shape, inconsistent Summary/Transcript availability, proposal inclusion, unconfirmed Decisions, unconfirmed/proposed Action Items -> IllegalArgumentException.
- Individual input text field > 1,048,576 UTF-16 code units -> fail.
- Final rendered UTF-8 payload > 8 MiB -> fail.
- These are provisional technical safety limits, **not an approved Product export size policy**; D13 review remains pending.

## 4. Security boundaries

- This pure service does not authorize an HTTP user. It **cannot** be exposed as a public endpoint without DE-09 current content authorization, request validation, source snapshot pinning, and D09 incomplete-Minutes admission review.
- The generated bytes and their private object references are sensitive. DE-10 must write to private S3 and expose download capabilities only after current permission recheck; signed URL lifetime <= 5 minutes.
- The generated Markdown is a representation. Editing an exported copy must never mutate Summary, Decisions, Action Items or Transcript data.
- The renderer neither claims that PARTIAL / NEEDS_REVIEW is export-eligible nor hides incomplete content; **D09 remains pending**. The current internal renderer can produce a *labeled* representation for testing, but public policy remains separate.
- Proposals are excluded (DE-05 D08 conservative default). If D08 later approves optional proposed sections, implement them with explicit new section labels and a new renderer version; do not just drop the current guards.

## 5. Automated tests

MarkdownMinutesRendererTests runs without a database (pure formatting), while the DE-05 HTTP/Flyway suite and DE-06 PostgreSQL state machine remain in the full CI regression suite.

1. Long Vietnamese Unicode/emoji; all business sections, IDs, source provenance, warning codes, normalized UTC timestamps.
2. Identical canonical data but different assembledAt produces identical bytes/SHA and the same renderer version.
3. Adversarial human/AI content: injected Markdown headings, raw HTML/script/img, link and image syntax, fenced code, pipe table, CRLF; no new document sections.
4. Stale/uncertain source and incomplete Transcript warnings remain visible alongside confirmed content.
5. Missing Summary/Transcript and empty official collections render explicit unavailable, without hallucinating text.
6. PROPOSED Decision, PROPOSED or unconfirmed AI Action Item, proposalsIncluded=true rejected instead of silently promoting.
7. Unsupported snapshot schema, incorrect source digest shape, inconsistent availability fail closed.
8. ANSI controls, C0/C1 and bidi controls neutralized; Vietnamese and emoji preserved.
9. Rendered artifact byte[] is defensively copied; digest matches bytes.
10. Per-field and total UTF-8 size limits reject oversized inputs rather than silently truncating.

**CI closure:** GitHub API CI conclusion=success for the exact HEAD SHA, full Maven verify BUILD SUCCESS, 10/10 DE-07 tests without skips/failures/errors, previous DE-01..06 regression suite passes. CI green is not approval of open D08/D09/D11/D13 policy decisions.

## 6. Downstream handoff

DE-08 PDF rendering must consume the same approved snapshot and preserve its uncertainty and evidence. It can use this renderer as a Markdown textual view only if the chosen PDF pipeline is safe against external asset resolution, active HTML, remote fonts/images and template injection.

DE-09 calls this renderer on an immutable, pinned, internally validated MinutesSnapshot and persists the EXACT returned UTF-8 bytes using DE-10, with a comparison against its SHA-256 and size. DE-06 then records a READY transition only after proven storage. DE-11 tracks source freshness separately from ready artifact authenticity.
