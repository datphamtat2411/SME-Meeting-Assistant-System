# Data

## Main Entities

```text
OrganizationalUnit
 └── User
      └── AuthSession → RefreshToken

Meeting
 ├── Organizer → User
 ├── Participants → MeetingParticipant → User
 ├── RoomReservation → Room
 ├── MeetingMedia → ProcessingJob
 ├── Transcript → TranscriptSegment
 ├── SummaryVersion
 ├── Decision
 └── ActionItem → User (Assignee)
```

Supporting records include processing attempts, transcript revisions, speaker mappings, decision/action-item evidence, and audit history.

## Relationships

```text
OrganizationalUnit 1:N User (primary unit)
User 1:N Meeting (organizer)
Meeting 1:N MeetingParticipant
User 1:N MeetingParticipant
Room 1:N RoomReservation
Meeting 0..1 active RoomReservation
Meeting 1:N MeetingMedia
MeetingMedia 1:N ProcessingJob
Meeting 1:N Transcript (versions)
Transcript 1:N TranscriptSegment
Meeting 1:N SummaryVersion
Meeting 1:N Decision
Meeting 1:N ActionItem
```

## Ownership

`Meeting` is the parent of meeting-specific records: participant membership, media metadata, transcripts, summaries, decisions, and action items.

`User`, `Room`, and `OrganizationalUnit` are shared records, referenced rather than copied into each meeting.

Organizer, participant, assignee, and editor attribution must remain traceable even when the referenced account or room becomes inactive.

A processing result remains linked to the source media and processing attempt that produced it.

## Important State

- Meeting lifecycle, room reservation, media availability, and processing progress are separate states.
- Transcripts and summaries preserve versions; one version of each may be current for a meeting.
- Human transcript corrections preserve revision history and editor attribution.
- Unresolved transcript quality or coverage warnings remain distinguishable from clean results.
- Decisions and action items preserve proposal, confirmation, and subsequent change history.
- Action-item overdue status is derived from its due date and lifecycle state.

## Persistence Rules

- Active room reservations for the same room cannot overlap; scheduling changes and reservation changes are atomic.
- Meeting participation does not replace the separately stored organizer relationship.
- Historical meetings, reservations, revisions, and business attribution are preserved rather than removed by routine deactivation.
- Mutable business records use concurrency control where simultaneous changes could cause lost updates.
- Processing retries and repeated deliveries must not create duplicate current results or confirmed business records.

## Important Constraints

- A meeting has one organizer.
- The same user cannot have duplicate active participation in one meeting.
- A meeting has at most one active room reservation, one current transcript, and one current summary.
- Transcript and summary version numbers are unique within their meeting.

This is a logical data map, not a physical schema. Exact tables, columns, indexes, and migration details are defined by task-specific implementation.

