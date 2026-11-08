# UI

## Baseline and Change Policy

The existing SME Meeting Assistant mock UI is the default **visual and interaction baseline**. Work primarily converts its useful flows into real, API-backed behavior; design work is driven by a concrete product gap, not by a blanket desire to modernize the template.

- **Existing screen, appropriate flow:** preserve layout, controls, visual language, and route; integrate its real behavior.
- **Existing screen, missing or incorrect behavior:** adapt the relevant section, validation, status, dialog, navigation, or interaction in place. A task may change UI when required by canonical product behavior.
- **Required capability without a suitable screen/flow:** design only the missing experience, consistent with the shared shell and component system.
- Avoid unrelated redesign, duplicated UI patterns, sweeping template cleanup, and replacement of working page structure unless explicitly in scope.

## Product-Facing UX Principles

- Keep navigation predictable across Dashboard, Meetings, Calendar, Action Items, Assistant, Rooms, Members, and account/settings areas. Preserve responsive behavior, keyboard navigation, focus management, and accessible labels.
- Prefer existing shared UI primitives and app layout; put feature-specific interaction logic in its feature. Do not introduce a second design system for a single task.
- Forms should show useful field feedback while reflecting backend validation, permissions, optionality, schedule conflicts, and concurrency outcomes—not arbitrary mock restrictions.
- Distinguish initial loading, refreshing, genuine empty results, unauthorized/forbidden, not found, failed, retryable, and partially available data. An empty list must not disguise a failed API request.
- Never simulate an authoritative success after a failed request or pretend a timer equals actual AI progress. Show upload progress, processing warnings, retry/recovery, and a clear difference between **meeting ended** and **AI output ready** where the feature needs it.
- Treat AI summaries, extracted decisions/action items, transcript uncertainty, and Assistant citations as reviewable derived information. Make human confirmation or correction explicit when the workflow requires it.
- Format time in the user's presentation context without changing the canonical instant; do not hardcode a timezone offset into integration behavior.
- UI role visibility may improve usability, but it is not a permission boundary. Protected content must rely on Core API authorization.

## Scope of UI Documentation

This file establishes consistency principles only. It does not specify page wireframes, a component inventory, acceptance tests, or redesign tasks. The active Task Specification identifies the specific screen and exact behavior to build or adjust.

Canonical behavior: `RE07-PRODUCT.md`, `RE06-FEATURES.md`, `RE04-BUSINESS_RULES.md`, and `RE08-SECURITY.md` in `requirement-docs/`.
