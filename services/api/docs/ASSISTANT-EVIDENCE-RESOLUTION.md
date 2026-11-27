# Assistant evidence resolution (API-AST-S02)

`GET /api/v1/assistant/conversations/{conversationId}/messages/{messageId}/evidence`

Read-only, no-store. Authenticated conversation owner with current meeting
content access. The message must be an Assistant message in that conversation.
The server reads its persisted citations; no arbitrary source IDs are accepted.
There are at most 64 entries. Source resolution is deduplicated per source
type, canonical identity and revision within the request.

The standard response envelope contains `conversationId`, `messageId`,
`meetingId`, and `evidence`. Each entry has `citationId`, `sourceType`,
`sourceId`, `sourceRevision`, `label`, `meetingTitle`, nullable `preview`,
`claimIds`, and `navigation: { target, precision }`.

| Source | Revision | Target |
| --- | --- | --- |
| TRANSCRIPT | content revision | MEETING_TRANSCRIPT |
| SUMMARY | version number | MEETING_SUMMARY |
| DECISION | decision version | MEETING_DECISIONS |
| ACTION_ITEM | action-item version | MEETING_ACTION_ITEMS |

Precision is SOURCE. A preview is a canonical artifact preview bounded to 500
Unicode code points, not an exact retrieved passage. Transcript citations do
not retain verified segment identity, so transcript preview is null. No
invented timestamp or segment locator is returned.

A legitimate uncited answer returns an empty collection. A missing or
non-Assistant message returns ASSISTANT_MESSAGE_NOT_FOUND (404), distinct
from parent authorization denial. Stale or ineligible evidence returns
ASSISTANT_SOURCE_STALE (409) without any evidence projection. Database
unavailability follows the existing Assistant unavailable contract.

Core uses canonical source readers, current revision verification, and the
existing meeting evidence lock. No inference, storage migration or new
provenance store is involved. The Web adapter performs protected on-demand
reads and validates the result against the currently visible message's
citations. It invalidates history on a stale-source outcome. A future
evidence view must retain session/resource/history ownership until rendering
and discard its local result when its owning message or conversation changes.
