# Assistant — Wave 03 product experience

The Web Assistant composes the Wave 01/02 conversation controller, protected history, turn workflow and meeting discovery rather than creating a second execution path. The desktop chat is a two-column workspace; narrow screens switch between the list and chat. Structured discovery remains a distinct view. New conversations require explicit creation using the existing meeting picker. Local conversation search covers loaded pages only; no per-conversation history fetch is used for previews.

The history viewport uses canonical message identities and relative offsets when loading older messages, and follows new messages only when near the newest end. The composer uses existing submission and Unicode validation. Suggested questions fill the draft, without sending a request.

Answer body, status, claims and references are rendered as untrusted plain text. Source unavailability takes precedence. Claim references open a responsive, message-scoped evidence inspector. Evidence is fetched only on inspection and stays in ephemeral state. The inspector is scoped to current session/resource access, history epoch, message and component lifetime; dismissal and invalidation abort or obsolete reads. Source navigation uses the existing typed Meeting Workspace search contract at SOURCE precision. Transcript segment focus and exact retrieved passages are not inferred.

The existing Core and AI contracts, synchronous inference, retry/recovery, and single-meeting authorization semantics are unchanged. This wave does not add backend endpoints, database migrations, or dependencies.

Verification: browser regressions have been adapted to the new interactions and expanded for on-demand evidence, late inspector results, and draft-only suggestions. Local build and rendered verification were unavailable in the MCP execution environment (GitHub DNS unavailable); CI and representative viewport/theme review are still required before Wave 03 acceptance.
