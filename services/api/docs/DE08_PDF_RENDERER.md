# DE-08 — Vietnamese PDF Minutes Renderer

> **Engineering gate:** DE-08 is CLOSED only after the latest GitHub API CI on the exact branch HEAD succeeds (Maven verify BUILD SUCCESS; new PDF tests not skipped). Product D08/D09/D11/D13 remain pending separate sign-off.
>
> **Branch:** api/module-dashboard-export. **Scope:** offline PDF rendering engine. No new public Export API, scheduled job, object storage, Flyway migration, database read or AI call.

## 1. Requirements and architecture

Traces to RE06 FEAT-EXP-FILE-002/003/004 and FEAT-EXP-MINUTES-001..003, RE04 BR-EXP-001..004, RE03 ARCH-EXP-001/002/003/004, RE08 SEC-AZ-*/SEC-OBJ-*/SEC-DL-*, and DE-05/06/07 engineering contracts.

**PdfMinutesRenderer.render(MinutesSnapshot)** accepts only the previously authorized, assembled, immutable DE-05 source. It calls the DE-07 MarkdownMinutesRenderer to obtain canonical, safely escaped official content, and draws a constrained text-only PDF with Apache PDFBox 3.0.8. PDF is not a new business-data source, and the renderer neither validates users nor creates new business facts.

There is no HTML engine, remote URI resolution, template scripting, JavaScript execution, image download, external document embedding, DB access, direct filesystem path, or OS-dependent font configuration.

- **Dependency**: org.apache.pdfbox:pdfbox:3.0.8 (core PDFBox 3.0.x).
- **Bundled font**: DejaVu Sans TrueType from net.sourceforge.jeuclid:dejavu-fonts:2.29, classpath loaded at startup and embedded with PDType0Font (subset) per PDF.
- The font is a Maven artifact dependency, NOT a user-provided URL and NOT a host machine font. DejaVu Sans provides Latin/extended Vietnamese Unicode coverage; normal NFC text is retained in PDF searchable text. A rare codepoint unsupported by that font, such as certain emoji, is emitted as a visible [U+HEX] marker rather than silently disappearing. No automatic font download/fallback.
- The output has A4 size, controlled heading hierarchy, quote/body spacing, word wrapping, long-word codepoint-safe splitting, automatically numbered pages, and footer separators.
- **Renderer version**: pdf-v1-markdown-v1-dejavu-2.29. This also pins the Markdown version because layout is based on that specific safe presentation contract. Changes affecting output should increment PDF renderer version.
- In-memory only; no temporary local files. No user-supplied filenames or object keys.

## 2. Content and uncertainty preservation

The PDF text comes from the exact DE-07 sections in this order:
1. Meeting core data / schedule / state
2. Completeness, warning codes, proposal exclusion
3. Current Summary with stale flag, source revision and selectionEpoch
4. CONFIRMED Decisions only with evidence, source attribution and warnings
5. Official Action Items only with assignment/due status
6. Transcript reference, quality and coverage counters (not raw transcript speech)
7. Snapshot schema, source fingerprint and renderer version

Content is the canonical source representation, not an AI-generated prettier description. Missing Summary/Transcript are explicitly marked unavailable, not invented. Suspicious/unresolved Transcript and stale Summary/Decision remain visibly labeled. Unconfirmed decisions/proposed tasks cannot be promoted: the DE-07 validation layer rejects them before a PDF document is started.

**Important:** Rendering a labeled PARTIAL or NEEDS_REVIEW snapshot internally does NOT imply public export eligibility; DE-01 D09 is still unresolved. DE-09 must block/admit public requests according to approved policy, rather than using PDF renderer success as policy approval.

## 3. PDF safety and resource controls

- A separate PDDocument, embedded PDType0Font and page content streams are created per render call; the service stores only the immutable font byte array and stateless Markdown renderer. Concurrent calls do not share mutable PDF state.
- Every source value reaches PDF as a PDFBox showText string from the DE-07 escaped official Markdown. Structural rendering only recognizes fixed heading/bullet/blockquote prefixes; it has no raw HTML/XML or Markdown HTML renderer and does not create PDF actions or annotations.
- The source text is NFC-normalized for Vietnamese diacritics. Unsupported glyphs are spelled out as codepoint markers instead of being silently discarded.
- The renderer closes page streams before saving, and closes PDDocument in all success/error paths. Font is classpath-loaded in bounded memory; no external font path is accepted.
- Output is capped at **300 A4 pages**, **20,000 written lines**, and **32 MiB** of PDF bytes. DE-07 already enforces source limits of 1 Mi text field and 8 MiB Markdown. Limits fail closed without truncating evidence and are engineering defaults pending DE-01 D13 policy sign-off.
- Produced RenderedPdf contains defensive-copy byte[], lowercase SHA-256 of exact bytes, byte length, page count, sourceFingerprint, rendererVersion, extension pdf and mediaType application/pdf. It is an internal artifact, not an HTTP DTO.
- Exact PDF byte identity across independent calls is not assumed, because PDFBox may change trailer IDs and font-subset metadata across saves. **Content/text/layout and provenance** are reproducible for the same canonical snapshot; the SHA-256 identifies the actual saved PDF bytes separately. Source fingerprint is not a cryptographic authorization capability.
- The PDFBox core dependency is pinned; reviewing dependency security updates and licensed font packaging remains part of DE-12.

## 4. Acceptance tests

PdfMinutesRendererTests creates actual PDF files in memory, reopens them with PDFBox Loader, and runs PDFTextStripper. It does NOT rely on mocks that cannot verify glyph embedding/page breaks.

1. Vietnamese Unicode accents, all official content sections, warning codes, fingerprint, font embedding, document metadata, page geometry and no annotations.
2. Long, fully populated Vietnamese Summary spanning multiple A4 pages, with page number X / N on every page, no lost final provenance.
3. Hostile HTML/script/image URL/Markdown injection remains literal extractable text. No PDF catalog OpenAction, external link annotations or image XObjects.
4. Same canonical source and different assembledAt produce the same extractable approved text/provenance.
5. Missing Transcript/Summary and empty official arrays retain warnings; no hallucinated details.
6. PROPOSED Decision or proposalsIncluded=true / unknown schema are rejected, preserving DE-07 official-content gate.
7. Defensive copy, length, SHA-256 of actual PDF bytes, MIME type and extension.
8. Concurrent PDF generation from one renderer instance creates independently parseable PDFs.

The full CI also runs the previous DE-05 Minutes integration tests, DE-06 state machine and DE-07 sanitizer/Markdown tests. A missing font jar or broken Unicode glyph MUST fail CI rather than falling back to WinAnsi or system fonts.

## 5. Downstream integration and open policy

- DE-09 must validate an immutable pinned DE-05 snapshot under approved admission rules, call PdfMinutesRenderer only for PDF export format and pass bytes to DE-10.
- DE-10 uploads to private object storage and verifies exact bytes/digest/size before invoking DE-06 publishReady; temporary object keys and signed URL issuance must not be based on user-provided paths.
- DE-11 compares current sourceFingerprint to the original frozen provenance separately from artifact SHA and renderer version.
- DE-01 D08 (AI proposals), D09 (incomplete Minutes export eligibility), D11 (artifact/snapshot retention), D13 (size/performance caps) remain Product/Security decisions, not silently approved by renderer implementation or CI.
