# Mobile Vietnamese presentation

The Mobile UI is Vietnamese only. The Web bilingual glossary in
[Web localization conventions](../../web/docs/LOCALIZATION.md) is the
terminology reference, not a runtime dependency. Do not introduce English
translation resources or a Mobile language switcher for this scope.

Both application entry points use Vietnamese Flutter Material/Widgets/Cupertino
localizations. System-owned permission dialogs and platform file pickers can
follow the device language. The saved account locale and timezone remain
independent preferences; existing device-local date/time behavior and canonical
date-only serialization are unchanged.

Use natural Vietnamese. Common terms such as AI, audio, email, chat, file,
timeline, PDF and Markdown can remain in English where appropriate. Prefer
Bản ghi lời thoại, Công việc, Tóm tắt, Quyết định, Biên bản, Bằng chứng,
Rà soát and Định dạng vùng for the corresponding product concepts.

Use domain presentation helpers for processing jobs/stages, transcript quality,
decision status, and action-item state. In particular, a meeting in progress
(Đang diễn ra) is distinct from work in progress (Đang thực hiện), a processing
job awaiting review is not completed, and an AI proposal is not an official
record. Unknown codes remain explicitly unknown rather than being treated as
success. Stable API codes, IDs, evidence fingerprints, user/AI content and
source metadata are never translated in place.

For user-facing failures use core or feature-specific presentation helpers.
Known authentication/authorization and server diagnostics are never echoed.
Structured public business conflict and validation details can remain available
under Core's safe public response contract; distinguish an uncertain mutation
outcome from a rejected operation and retain existing recovery controls.
Core-owned processing failure summaries have stable codes; use the matching
Vietnamese descriptions while retaining the original records and recovery
semantics.

Verify the pinned Flutter toolchain, enforced lockfile, Dart formatting,
analysis, complete Flutter tests and the Android verification/build steps in
Mobile CI. Check the Web carry-over corrections with Web CI. A passing CI run
does not replace real-device checks for text scaling, native system dialogs,
font rendering and microphone behavior.

## Final harmonization (LOC-05)

Processing review uses "Cần rà soát". The public processing warning summary
has no dedicated warning code in the current Core response, so preserve it
under the Vietnamese "Cảnh báo" label rather than guessing its meaning from
English prose. Configuration failures retain their original diagnostics in
the exception and present a specific Vietnamese explanation in the app. The
configuration error view is scrollable at increased text scaling.

See the [cross-client localization acceptance record](../../web/docs/LOCALIZATION_ACCEPTANCE.md)
for the automated verification scope and remaining manual device checks.
