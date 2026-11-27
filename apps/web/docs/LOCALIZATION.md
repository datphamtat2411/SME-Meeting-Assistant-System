# UI localization

LOC-01 establishes a Web-only presentation layer. English remains the default
until LOC-05; Vietnamese is available through the header and authentication
layout. Language preference is local to the browser and separate from regional
preferences, timezone, and backend account data.

## Implementation

Use `useUiTranslation()` from `@/lib/i18n` in React components and
`i18n.t()` in non-React presentation code. Keep stable semantic keys in
`src/lib/i18n/locales/{en,vi}/`, adding feature namespaces to resources as
needed. Use interpolation and language-specific plurals rather than concatenating
translated fragments. Both language catalogs must have matching semantic
coverage; do not pass arbitrary user or server content to the translator.
Use the existing stable API codes for presentation mapping, without changing
transport, authentication, permissions, or lifecycle behavior.

## Natural Vietnamese glossary

| English | Vietnamese |
| --- | --- |
| Dashboard | Tổng quan |
| Meetings | Cuộc họp |
| Calendar | Lịch |
| Meeting Rooms | Phòng họp |
| Members | Thành viên |
| Action Items | Công việc |
| AI Assistant | Trợ lý AI |
| Settings | Cài đặt |
| Profile | Hồ sơ |
| Account | Tài khoản |
| Organizer | Người tổ chức |
| Participant | Người tham gia |
| Transcript | Bản ghi lời thoại |
| Summary | Tóm tắt |
| Minutes | Biên bản |
| Decisions | Quyết định |
| Speaker | Người nói |
| Employee | Nhân viên |
| Department Manager | Trưởng phòng |
| Administrator | Quản trị viên |

Use natural Vietnamese, not literal word-for-word translations. AI, Chat,
Email, audio, video, file, timeline, link, PDF, Markdown, online/offline, and
format identifiers may remain English where familiar and concise. Examples:
"Tải lên file audio", "Chat với AI", "Sao chép link", "Xuất Markdown".
Do not put English in parentheses after every label. Preserve the distinction
between meeting state, processing state, AI proposals, and confirmed records.

Keep meeting titles, names, transcripts, summaries, assistant messages, file
names, identifiers, canonical values and payloads unchanged. Mobile should
reuse this terminology in its Vietnamese UI without requiring bilingual
support or importing Web source code.

## Verification

Verify switching without remounting, reload persistence, invalid storage
values, catalog coverage, permission-sensitive navigation, command search,
keyboard accessibility, responsive layout, and Vietnamese accents in Inter,
Manrope, and System fonts. Run the focused browser tests and existing Web CI.
Feature-local strings remain the responsibility of LOC-02 and LOC-03.

Shared date-only controls format the selected civil day with the resolved
regional locale without converting it to a different timezone. Calendar
control labels follow UI language. Shared errors map canonical API and
transport codes. For unrecognized or absent codes, a localized HTTP category
can accompany a distinct public client-error message without replacing it.
Generic validation and conflict codes may retain actionable public business
detail. Authentication, authorization, concealed resources, stale requests,
network failures, and all HTTP 5xx responses (including gateway failures)
do not expose raw diagnostic detail. Shared request, form and toast
presentation must preserve this boundary. Public client-error messages depend
on the Core API safe-response contract; do not infer safety from message text.
Keep feature-specific validation and recovery guidance at the owning feature.
Use `REQUIRED_VALIDATION_MESSAGE`, `INVALID_EMAIL_VALIDATION_MESSAGE` and
`lengthValidationMessage` from the presentation module for shared form
validation; markers are translated at render time, including after a language
switch. Catalog tests compare semantic keys, interpolation parameters and
the plural categories required by each language.

Feature-specific form validation and persisted presentation errors can use
`featureValidationMessage` with an owned catalog key; resolve these through
`localizedValidationMessage` at render time rather than storing a translated
sentence. `requestErrorFormMessage` preserves actionable public API messages
or returns a stable localized category marker. Never use human-readable error
text to decide permissions, retry behavior, or mutation outcomes.

LOC-02 also extends stable presentation messages with feature-owned keys and
optional interpolation values. Retained form/recovery messages are resolved at
render time; server response classifications, ETags and idempotency keys remain
canonical. Local UI-only exceptions can use `UiPresentationError` so feedback
retains its translation key without being mistaken for a transport failure.
Raw public conflict and validation details remain available when distinct from
the localized category. Authentication and authorization failures retain their
safe presentation; request/field errors are not translated as arbitrary prose.
