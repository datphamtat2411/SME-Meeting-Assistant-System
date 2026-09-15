# Task 05 — Meeting Workspace

## Goal

Turn the individual meeting route into the central workspace for understanding one meeting.

The workspace should expose the main outputs of a completed meeting:

* meeting overview;
* AI-style summary;
* key decisions;
* speaker-aware transcript;
* meeting-scoped action items;
* and meeting-scoped AI questions with source references.

Use the shared domain types and mock data established by earlier tasks.

Do not implement Live Meeting or the processing pipeline in this task.

## Context

Before implementation, read:

```text id="k64qf3"
PRODUCT.md
```

Then inspect the current repository state and reuse the shared meeting, transcript, summary, decision, action-item, member, room, and source data already established by previous tasks.

Use the completed Vietnamese hero meeting from the shared mock dataset as the primary rich demonstration case.

Do not create a parallel Meeting Detail dataset.

## Core Principle

This workspace answers:

```text id="ji6tqt"
What happened in this meeting?
```

Keep all meeting intelligence scoped to the currently opened meeting.

Cross-meeting management and retrieval belong to later tasks.

## Route

Implement the meeting workspace at the existing individual meeting route:

```text id="s4qkhk"
/meetings/$meetingId
```

Replace any placeholder introduced by an earlier task.

Resolve the current meeting using the route ID and shared meeting data.

## Meeting Header

Display the primary meeting context above the workspace.

Include useful information such as:

```text id="7k0686"
Meeting title
Status
Date / time
Room
Participants
```

Reuse shared member and room data to resolve related entities.

Keep header actions focused.

For completed meetings, expose:

```text id="25xmxs"
Export Minutes
```

For an in-progress meeting, a navigation action such as:

```text id="xl0uv4"
Join Live Meeting
```

may be shown if the intended live route already exists or can be linked without implementing the live feature itself.

Do not add broad meeting-management actions such as delete, duplicate, sharing, or advanced editing unless already trivially required by existing UI structure.

## Workspace Navigation

Use a tabbed or equivalent contained workspace with:

```text id="cfk8jy"
Overview
Transcript
Action Items
Ask AI
```

Overview should be the default view for completed meetings.

Do not create separate routes for Summary, Decisions, Transcript, or meeting-scoped AI.

## Overview

The Overview tab should communicate the main meeting intelligence at a glance.

Include:

```text id="v02ylm"
AI Summary
Key Decisions
Meeting Information
Participants
```

Use shared completed-meeting data.

### AI Summary

Render the summary already associated with the current meeting.

For the primary Vietnamese demo meeting, preserve realistic Vietnamese content.

Do not generate new summaries at runtime.

### Key Decisions

Render the decisions associated with the current meeting.

Each decision should remain connected to the meeting and, where available, its source transcript segment.

A lightweight source action such as:

```text id="ix0j5p"
View in transcript
```

is encouraged when it can be implemented cleanly from existing `sourceSegmentId` data.

Do not introduce a separate Decisions page.

### Meeting Information

Show relevant metadata such as:

```text id="11zaic"
Date
Time
Room
Organizer
Status
```

Keep this concise.

### Participants

Display meeting participants using shared member data.

Reuse existing avatar or participant presentation patterns where appropriate.

## Transcript

The Transcript tab should clearly demonstrate Vietnamese ASR output and speaker diarization concepts using shared transcript segments.

Each transcript segment should communicate:

```text id="n16dsd"
Speaker identity
Timestamp
Text
```

When `participantId` exists, display the mapped participant.

When a segment does not yet have a mapped participant, fall back to the detected `speakerLabel`.

Example concept:

```text id="06nvep"
Nguyễn Minh Anh                         12:34
Chúng ta cần chốt phương án tích hợp thanh toán
trước cuối tuần này.
```

or:

```text id="g0aexl"
Speaker 2                               12:34
...
```

Do not replace shared transcript data with page-local transcript fixtures.

## Speaker Mapping

Provide a lightweight representation of detected speakers and participant mapping.

For example:

```text id="e19y5s"
Speaker 1 → Nguyễn Minh Anh
Speaker 2 → Trần Hoàng Nam
Speaker 3 → Lê Thu Hà
```

If an existing Select pattern makes it straightforward, mappings may be adjusted using frontend-only state.

Interactive remapping is optional.

The important requirement is that the UI clearly represents the relationship between detected speaker labels and known meeting participants.

Do not implement real diarization.

## Transcript Navigation

If key decisions or action items contain `sourceSegmentId`, support lightweight navigation to the corresponding transcript segment when practical.

An acceptable interaction is:

```text id="grqdrg"
View source
→ switch to Transcript
→ scroll to the source segment
```

A brief visual highlight may be used if simple.

Do not introduce complex deep-linking infrastructure solely for this behavior.

## Transcript Search

Transcript search is optional.

Add it only if it can be implemented simply using the existing shared transcript data and existing UI patterns.

Do not expand the task into a transcript editing or playback system.

## Action Items Tab

Display only action items belonging to the current meeting.

Useful columns or fields include:

```text id="a3tfkg"
Task
Assignee
Due Date
Priority
Status
```

Resolve assignees from shared member data.

Where `sourceSegmentId` exists, a lightweight action may navigate back to the relevant transcript segment.

This tab is a meeting-scoped view only.

Do not implement global Action Items management, advanced filtering, or cross-meeting task workflows in this task.

## Ask AI Tab

Provide a lightweight meeting-scoped AI interaction.

The purpose is to demonstrate questions about the currently opened meeting.

Example questions may include:

```text id="wbm7n1"
Cuộc họp đã chốt những quyết định nào?
Ai phụ trách API thanh toán?
Deadline tích hợp frontend là khi nào?
```

Use shared assistant/source mock data where available.

Keep the interaction simple.

A user may select a suggested question or enter a supported demo question.

Responses should remain limited to the current meeting.

## AI Source References

Useful mock AI answers should expose supporting meeting evidence where available.

Examples:

```text id="ahozc9"
Transcript · 12:34
Decision
Action Item
```

Use the shared `RagSource` or equivalent source-reference data established earlier.

Do not implement real retrieval, embeddings, or LLM behavior.

Do not turn this tab into a general-purpose chatbot.

## Meeting Minutes Export

Completed meetings should expose an `Export Minutes` action.

Support:

```text id="00bjhs"
Export Markdown
Export PDF
```

### Markdown

Prefer implementing a simple frontend-generated Markdown export if it can be done without unnecessary dependencies.

The exported content should include:

```text id="a74f0i"
Meeting Information
Summary
Key Decisions
Action Items
```

### PDF

PDF export may remain a lightweight prototype interaction.

Do not add a large PDF-generation dependency solely for this feature.

If real PDF generation is not already simple within the existing project, use a clear simulated action or another lightweight frontend representation.

The UI should communicate that PDF meeting minutes are an intended product capability.

## Lifecycle Handling

The route should remain coherent for meetings that are not completed.

### Scheduled

Show meeting metadata and a simple state indicating that the meeting has not started yet.

Do not fabricate transcript or AI outputs.

### In Progress

Show meeting metadata and indicate that the meeting is currently live.

A `Join Live Meeting` navigation action may be exposed.

Do not implement the live meeting experience here.

### Processing

Show meeting metadata and a simple indication that meeting intelligence is being generated.

Do not implement the detailed processing pipeline here.

### Completed

Expose the full Meeting Workspace defined by this task.

### Cancelled

If supported by the shared lifecycle model, show a simple cancelled state without generating completed-meeting content.

## Meeting Not Found

Handle an invalid meeting ID gracefully.

A minimal state is sufficient:

```text id="92d5xb"
Meeting not found

Back to Meetings
```

Do not introduce a new global error framework.

## Reuse

Prefer existing reusable components such as:

* Tabs;
* Cards;
* Badges;
* Avatar;
* Select;
* ScrollArea;
* Dropdown menus;
* Tables;
* Sonner/toast feedback.

Create meeting-specific reusable components only when they directly improve this task.

Reasonable examples may include:

```text id="gugrrf"
MeetingStatusBadge
TranscriptSegmentRow
SourceReference
ParticipantAvatarStack
```

Do not create abstractions purely for future tasks.

## Explicitly Excluded

Do not implement:

* microphone capture;
* recording controls;
* audio playback;
* audio waveform;
* word-level audio synchronization;
* real ASR;
* real speaker diarization;
* Live Meeting UI;
* recording upload;
* detailed AI processing pipeline;
* global Action Items management;
* Calendar implementation;
* Meeting Rooms management;
* Members management;
* cross-meeting AI Assistant;
* backend or AI-service integration.

## Scope Boundaries

This task owns:

* `/meetings/$meetingId`;
* meeting header and metadata;
* meeting lifecycle-aware detail states;
* Overview;
* AI Summary presentation;
* Key Decisions presentation;
* Transcript;
* speaker-aware transcript presentation;
* lightweight speaker mapping representation;
* meeting-scoped Action Items;
* meeting-scoped Ask AI;
* meeting source references;
* Meeting Minutes export representation;
* meeting-not-found handling.

This task does **not** own the systems that produce or globally manage those outputs.

## Expected Result

A completed meeting should support the following walkthrough:

```text id="8ycagq"
Open Meetings
→ Open completed meeting
→ Review AI Summary
→ Review Key Decisions
→ Read Vietnamese speaker-aware Transcript
→ Review meeting Action Items
→ Ask a question about the meeting
→ Inspect supporting source evidence
→ Export Meeting Minutes
```

The page should make the main value of SME Meeting Assistant understandable without requiring a real AI backend.

## Acceptance Criteria

* `/meetings/$meetingId` resolves the selected meeting from shared data.
* Completed meetings expose Overview, Transcript, Action Items, and Ask AI.
* Overview renders shared summary and key-decision data.
* Meeting metadata and participants resolve from shared entities.
* The primary completed demo meeting renders its Vietnamese transcript.
* Transcript segments show participant identity when mapped and detected speaker labels when not mapped.
* Speaker-to-participant mapping is clearly represented.
* Meeting-scoped action items are derived from shared action-item data.
* Meeting-scoped AI responses use shared mock knowledge/source data.
* AI source references visibly ground supported answers in meeting data.
* Source navigation to transcript segments works where implemented.
* Completed meetings expose Markdown and PDF meeting-minutes actions.
* Scheduled, in-progress, processing, and cancelled meetings do not incorrectly display completed-meeting intelligence.
* Invalid meeting IDs produce a clear not-found state.
* No parallel meeting/transcript/action-item dataset is introduced.
* No Live Meeting or detailed processing implementation is added.
* Existing theme and responsive behavior remain functional.
* The frontend production build succeeds.

## Verification

Run the existing frontend production build.

Resolve errors introduced by this task.

Verify at minimum:

* the rich completed Vietnamese demo meeting;
* one non-completed meeting state;
* an invalid meeting ID;
* tab navigation;
* meeting-scoped data filtering;
* source references where implemented.

Do not broaden the task to fix unrelated pre-existing issues.

## Stop Condition

Stop when an individual completed meeting provides a coherent workspace for understanding its summary, decisions, transcript, action items, and meeting-scoped AI evidence.

Do not continue into Live Meeting, recording/upload processing, global Action Items, Calendar, Rooms, Members, or cross-meeting AI Assistant implementation.
