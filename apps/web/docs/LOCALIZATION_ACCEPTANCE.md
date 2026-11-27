# LOC-05 localization acceptance

## Scope and baseline

Feature branch: `feat/vietnamese-ui`. The starting implementation was
`7c99411` (LOC-04). Web supports Vietnamese by default and English by explicit
selection. Mobile remains Vietnamese only. No server-side API, persistence,
AI, authorization, retry or idempotency contract is changed.

## Corrections and automated verification

| Area | Evidence |
| --- | --- |
| Member recovery | Role and primary-unit display use field-aware labels. The directory regression verifies the selected conflict choice and no duplicate patch across a language change. |
| Processing | Web and Mobile use consistent review terminology; known Core failure codes retain their distinct meanings. Public warning detail is retained, not translated by matching prose. |
| Default and preference | Preference tests cover absent, valid, invalid and unavailable storage; static HTML starts with Vietnamese and runtime updates the document language. |
| Coverage | Catalog parity, interpolation, pluralization, registered namespaces, literal mapping references and known dynamic status/source groups are checked by the existing localization suites. |
| Web layout | A browser test verifies that translated conflict actions fit a narrow viewport and retain keyboard focus across language switching. Shared dialog footers wrap long actions. |
| Mobile layout | The configuration failure widget test exercises a 320-logical-pixel viewport and increased text scaling, checks a Vietnamese explanation, and preserves the original diagnostic. |
| Business and security regression | Existing browser and Flutter suites, Web transport security verification, Flutter native checks and production/debug builds remain enabled. |

The final release gate is a successful Web CI and Mobile CI run on the
implementation commit being accepted. GitHub Actions logs and artifacts are
the authoritative evidence; do not infer a passing run from this document.

## Production startup and targeted layout checks

`pnpm run build` followed by `pnpm run test:localization:startup` runs
Chromium against the production bundle, independently of the English Vitest
setup. The gate checks fresh browser state, EN/VI persistence across reloads,
invalid preferences, HTML language metadata, sign-in controls and retained
input at 360, 768 and 1440 pixel widths. The Core API is an anonymous fixture;
external fonts are blocked for deterministic fallback coverage. CI uploads
representative screenshots for review. Mobile widget coverage includes the
Vietnamese login at 320 logical pixels and 2.0 text scale, and actual Flutter
schedule date/time dialogs with cancellation preserving the draft.

## Manual verification boundary

The automated suites exercise representative application flows and localized
presentation, not every visual state or every platform/font combination.
Before release, verify the actual application in both Web languages at
representative phone, tablet and desktop widths; check Inter, Manrope and
system fonts with Vietnamese accents, keyboard navigation and assistive
technology. On a real Android device verify Vietnamese glyph rendering,
larger text settings, keyboard, native file picker and microphone permission.
Native system dialogs may follow the device language. Record any remaining
visual limitations explicitly. These manual checks are not represented as
completed by automated CI.

Do not translate user-entered content, AI responses, transcript text, file
names, canonical values, or exports. Core public warning prose without stable
codes may remain in its original language with a Vietnamese warning label.
