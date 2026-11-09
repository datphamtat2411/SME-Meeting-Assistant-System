## Task Plan
- Implement the Web meeting list against authorized `GET /api/v1/meetings`.
- Preserve the existing route, table structure, responsive behavior, detail links, and visual language.
- Move search, filters, sorting, and pagination into URL-driven server state.
- Add metadata-aware Core API transport without changing existing `coreApi.get()` callers.
- Remove the page’s fake creation/local filtering path; meeting creation remains out of scope.
- Keep shared mock schemas/data unchanged for Calendar, Dashboard, live meeting, and workspace screens.
- Treat missing backend projection and organizer-candidate contracts as explicit blockers.

## Repository Findings
- `features/meetings/index.tsx` owns an in-memory list, client-side title/status filtering, mock lookups, and a fake create dialog.
- `data/schema.ts` uses legacy lowercase statuses and includes `processing`; these types are shared by unrelated screens.
- `meeting-status-badge.tsx` currently maps mock lifecycle and AI processing into one status set.
- The authenticated Meetings route has no search schema, loader, query state, or pagination.
- `core-api.ts` sends credentialed cookie requests and normalizes errors, but discards `meta`.
- `use-table-url-state.ts` supports URL filters and pagination but not server sorting or date-range controls.
- `GET /api/v1/meetings` applies visibility, filtering, sorting, and pagination in SQL.
- Current `MeetingView` lacks organizer names, room display fields, participant count, and participant preview.
- No approved meeting-candidates endpoint exists; `/api/v1/users` is restricted directory management and is not a valid substitute.
- Existing Web documentation requires Core API ownership, truthful states, canonical API enums, localized time presentation, and focused tests.

## Proposed Changes
**API transport and feature adapter**
- Add a backward-compatible metadata-aware request method, such as `coreApi.getWithMeta()`, returning `{ data, meta }`; retain existing data-only methods.
- Preserve credentialed cookie transport, authorization-header stripping, CSRF behavior, recovery replay, and normalized errors.
- Add a feature-owned `list-api.ts` containing canonical lifecycle types, list DTOs, pagination metadata, query serialization, and React Query options.
- Map one-based URL pages to the API’s zero-based `page`; omit unset filters and serialize only valid ISO date-times with offsets.
- Validate the expected response envelope and pagination shape; treat malformed responses as failures rather than manufacturing data.
- Use `/api/v1/rooms` only for room-filter options. Never use room lookups to decorate each meeting row.

**URL-driven discovery**
- Add route search validation for `q`, canonical `status`, `relationship`, `from`, `to`, `roomId`, `organizerId`, `sort`, `page`, and `pageSize`.
- Use backend-supported sort values: `createdAt`, `scheduledStartAt`, `title`, and `status`, with explicit direction.
- Reset the page whenever a filter, date range, sort, or page size changes.
- Make reset navigation remove all active filters and restore default sort and pagination.
- Ensure browser back/forward restores controls and refetches the matching server query.
- Use `meta.pagination` for page counts, totals, and range correction; never fetch all pages for client-side filtering.

**Meeting presentation**
- Display canonical `DRAFT`, `SCHEDULED`, `IN_PROGRESS`, `ENDED`, and `CANCELLED` values only for API-backed meetings.
- Keep legacy mock consumers compatible without adding `PROCESSING` to the canonical list status set.
- Render organizer, room, location, participant count, and a maximum two-person preview exclusively from the approved list projection.
- Render explicit unknown/unassigned states for null or unavailable values; never resolve names from mock data or issue per-meeting requests.
- Format scheduled times in the user’s presentation timezone. Render unscheduled drafts as `Unscheduled` without constructing dates from null values.
- Preserve meeting-detail links and show the live link only for `IN_PROGRESS`.
- Remove the fake create dialog, mock mutation, and demo-user creation behavior from the list page.

**State and failure handling**
- Show table skeletons during initial loading.
- Keep existing rows visible with a refreshing indicator while a query refetches.
- Distinguish no accessible meetings from no filter matches using whether filters are active.
- Render list-level `403` as an access failure, not an empty result.
- Render network, server, and retryable transport failures with an explicit retry action.
- Allow the existing auth/recovery transport to handle session loss and avoid turning failed requests into success states.

## Backend API Route
- Route: `GET /api/v1/meetings`.
- Supported parameters: `status`, `q`, `organizerId`, `roomId`, `relationship`, `from`, `to`, `page`, `size`, and `sort`.
- `status` values are `DRAFT`, `SCHEDULED`, `IN_PROGRESS`, `ENDED`, and `CANCELLED`.
- `relationship` values are `ORGANIZER` and `PARTICIPANT`.
- Dates use `OffsetDateTime`; date filtering is schedule-overlap filtering and excludes unscheduled drafts.
- API pages are zero-based; `size` is limited to `1..100`; default sorting is `createdAt,desc`.
- Successful responses expose authorization-filtered totals through `meta.pagination`.
- Current `MeetingView` does not contain `display.organizerName`, `roomName`, `roomLocation`, `participantCount`, or `participantPreview`.
- No approved meeting-candidates lookup exists. Do not call `/users`, use mock members, or add N+1 meeting requests.
- Organizer selection and real projection-backed row decoration remain blocked until those backend contracts are available.

## Existing UI Assessment
- Preserve `Header`, `Main`, card layout, horizontally scrollable table, row actions, and existing meeting routes.
- Replace the current two-control toolbar with search, status, relationship, date range, room, sort, pagination, and reset controls.
- Use `totalElements` for the list summary instead of local array counts.
- Keep shared `data.ts` and `schema.ts` unchanged because multiple mock screens consume them.
- Update only the list-specific status presentation so AI processing cannot appear as a lifecycle option on the real list.
- Remove only the fake list-page creation behavior required to prevent simulated authoritative data.

## File Delta
**Modify**
- `apps/web/src/lib/core-api.ts`
- `apps/web/src/lib/core-api.test.ts`
- `apps/web/src/features/meetings/index.tsx`
- `apps/web/src/features/meetings/components/meeting-status-badge.tsx`
- `apps/web/src/routes/_authenticated/meetings/index.tsx`

**Add**
- `apps/web/src/features/meetings/data/list-api.ts`
- `apps/web/src/features/meetings/data/list-api.test.ts`
- `apps/web/src/features/meetings/index.test.tsx`
- `apps/web/src/features/meetings/components/meeting-status-badge.test.tsx`

**Remove**
- None.

## Focused Tests
- Verify metadata-aware transport returns `data` and `meta.pagination` while existing data-only methods remain unchanged.
- Verify list query serialization, canonical status values, zero-based page conversion, omitted unset parameters, valid offset dates, and projection null handling.
- Verify successful rendering of organizer, room, location, participant count, two-person preview, unscheduled drafts, canonical statuses, and preserved links.
- Verify filter/sort/page-size changes reset pagination and produce server query parameters.
- Verify reset, browser navigation state restoration, out-of-range page correction, and pagination controls.
- Verify initial loading, refreshing, no accessible meetings, no filter matches, `403` access failure, and retryable failure states.
- Run from `apps/web/`: `pnpm test -- src/lib/core-api.test.ts src/features/meetings/data/list-api.test.ts src/features/meetings/components/meeting-status-badge.test.tsx src/features/meetings/index.test.tsx`.

## Out of Scope
- Meeting creation, editing, lifecycle mutations, participant mutations, and detail integration.
- Backend implementation of list projections or meeting-candidates lookup.
- Calendar, Rooms, Members, and administration changes.
- AI, media, transcript, workspace, and processing integrations.
- Client-side filtering, sorting, fetching all meeting pages, mock display-name manufacture, and per-meeting N+1 requests.
