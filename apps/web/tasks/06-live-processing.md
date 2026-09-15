# Task 06 — Live Meeting & Processing Simulation

## Goal

Simulate the path from an in-progress meeting to processed meeting intelligence.

This task should demonstrate how SME Meeting Assistant visually moves through:

```text
Live Meeting
→ Transcript Capture
→ Meeting Ends
→ AI Processing
→ Ready
→ Meeting Workspace
```

Also support a lightweight uploaded-recording path into the same processing flow.

Use frontend-only simulation.

Do not implement real audio capture, streaming, ASR, diarization, or AI processing.

## Context

Before implementation, read:

```text
PRODUCT.md
```

Then inspect the current repository state and reuse the shared meeting, member, transcript, processing-stage, and related data established by previous tasks.

Reuse existing Meeting Workspace components and meeting-domain presentation where appropriate.

Do not create a second transcript or processing domain model.

## Core Principle

This task answers:

```text
How does a meeting move from conversation or recording
to processed meeting intelligence?
```

The experience should feel believable while remaining entirely frontend-driven.

## Live Meeting Route

Implement or complete:

```text
/meetings/$meetingId/live
```

Use the route meeting ID to resolve the current meeting from shared data.

The Live Meeting page should primarily represent meetings whose lifecycle state is:

```text
in_progress
```

Do not turn the page into a video-conferencing application.

## Live Meeting Header

Display useful meeting context such as:

```text
Meeting title
Live status
Elapsed meeting time
Room
Participant count
```

Use existing shared meeting/member/room data.

Show a clear live-state indicator.

## Meeting Timer

Provide a simple frontend elapsed timer.

The timer may begin from a local session value or another simple demo state.

Persistence across refreshes is not required.

Do not introduce server-time synchronization infrastructure.

## Live Status

Represent frontend-only meeting capture state.

Useful status concepts include:

```text
Recording
Microphone
Speech Recognition
```

For example:

```text
Recording          Active
Microphone         On
Speech Recognition Listening
```

These are visual simulation states only.

Do not request microphone permissions or capture real audio.

## Participants

Show the current meeting participants using shared member data.

Keep the participant area lightweight.

Useful presentation may include:

```text
Avatar
Name
Optional speaking indicator
```

A simulated active-speaker indicator is optional.

Do not implement conferencing host controls, participant permissions, invitations, or removal actions.

## Live Transcript

Display a speaker-aware live transcript using shared transcript data.

Reuse the transcript presentation established by the Meeting Workspace where practical.

Transcript segments should continue to support:

```text
speakerLabel
participantId
timestamp
text
```

When a participant mapping exists, display the participant identity.

Otherwise display the detected speaker label.

## Transcript Simulation

Make transcript segments appear incrementally so the page feels like live speech recognition.

Use a simple scripted frontend approach.

For example:

```text
segment 1
→ segment 2
→ segment 3
→ ...
```

A timer or similarly small state mechanism is sufficient.

Do not build a generic streaming engine.

If existing transcript segments contain an `isFinal` state, partial/final presentation may be simulated if straightforward.

This is optional.

Do not implement word-by-word streaming.

## Simple Live Controls

Provide lightweight demo controls where useful.

At minimum, support an End Meeting action.

Optional local controls may include:

```text
Mute / Unmute
Pause / Resume Transcript
```

These controls affect frontend simulation state only.

They must not interact with real microphone or recording APIs.

Do not add unrelated conferencing controls such as:

* camera;
* screen sharing;
* reactions;
* raise hand;
* chat;
* participant administration.

## End Meeting

Ending a meeting should be the primary transition from the live experience.

Expected flow:

```text
End Meeting
→ Confirmation
→ Live simulation stops
→ Processing state begins
```

Use a lightweight confirmation dialog or existing pattern.

Do not add backend persistence for this transition.

## Processing Experience

Provide a clear processing state that communicates how meeting intelligence is produced.

Represent the pipeline as:

```text
Recording Received / Audio Uploaded
→ Transcribing
→ Speaker Diarization
→ Generating Summary
→ Extracting Decisions & Action Items
→ Indexing Meeting Knowledge
→ Ready
```

Reuse the shared processing-stage model if one already exists.

Do not merge these stages into the main Meeting lifecycle status model.

## Processing UI

Use a simple stepper, progress list, timeline, or equivalent pattern.

The user should be able to distinguish:

```text
Completed stage
Current stage
Pending stage
```

Keep the design consistent with the existing application.

Do not create a complex animation system.

## Processing Simulation

Advance through processing stages using frontend-only timing/state.

A deterministic sequence is preferred.

The goal is to demonstrate progression, not realistic processing duration.

Do not implement:

* file analysis;
* ASR;
* diarization;
* summarization;
* action-item extraction;
* embeddings;
* retrieval indexing.

## Ready State

When processing reaches:

```text
Ready
```

provide a clear action such as:

```text
View Meeting
```

Navigate back to:

```text
/meetings/$meetingId
```

The existing Meeting Workspace from Task 05 should remain responsible for presenting the completed intelligence.

Do not duplicate the completed Meeting Workspace inside the processing screen.

## Lifecycle-Aware Live Route

Handle meetings that are not currently live.

### Scheduled

Show a simple state indicating that the meeting has not started.

Provide navigation back to the meeting page where appropriate.

### Completed

Show that the meeting is no longer live.

Provide:

```text
View Meeting
```

rather than rendering the Live Meeting interface.

### Processing

Show or redirect into the processing experience as appropriate.

### Cancelled

Show a simple unavailable/cancelled state.

Do not fabricate a live session.

## Uploaded Recording

Provide a lightweight way to demonstrate the batch-audio workflow.

Prefer attaching this interaction to an existing meeting rather than creating a separate import product flow.

A simple action may open a dialog such as:

```text
Upload Meeting Recording
```

The dialog should support the frontend interaction concept:

```text
Drop audio file here
or
Choose File

Supported demo formats:
.mp3
.wav
```

## Recording Selection

The browser may be used only to select a local file for UI demonstration.

It is sufficient to display metadata such as:

```text
File name
File size
```

Do not upload or inspect the actual audio contents.

Keep file validation minimal.

## Uploaded Recording Flow

Expected flow:

```text
Choose .mp3 / .wav
→ Show selected file
→ Process Recording
→ Enter processing pipeline
→ Ready
→ View Meeting Workspace
```

Use the same processing experience as the Live Meeting completion path.

Do not create a second processing implementation.

## Data Behavior

Use existing shared deterministic data for the resulting meeting intelligence.

The processing simulation should visually lead to data already represented by the Meeting Workspace rather than attempting to generate new AI output dynamically.

Do not create a frontend AI-generation engine.

## State Management

This task may require transient state such as:

```text
elapsed timer
microphone state
paused state
visible transcript count
processing stage
selected recording
```

Use the simplest appropriate state mechanism already supported by the repository.

Local component state is acceptable.

Reuse existing state patterns when clearly useful.

Persistence across page refreshes is not required.

Do not introduce a new state-management architecture solely for this task.

## Reuse

Reuse components and patterns created in earlier tasks where appropriate.

Examples may include:

```text
MeetingStatusBadge
TranscriptSegmentRow
ParticipantAvatarStack
meeting header patterns
dialogs
buttons
badges
progress indicators
```

Do not duplicate transcript rendering if an existing reusable implementation already fits.

## Explicitly Excluded

Do not implement:

* `getUserMedia`;
* `MediaRecorder`;
* microphone permissions;
* real audio recording;
* audio blobs;
* real audio upload;
* audio playback;
* waveform visualization;
* WebSocket streaming;
* Server-Sent Events;
* real-time backend connections;
* Whisper;
* PyAnnote Audio;
* LLM calls;
* embedding generation;
* real knowledge indexing;
* real AI processing;
* video conferencing;
* camera controls;
* screen sharing;
* meeting chat;
* participant moderation.

## Scope Boundaries

This task owns:

* `/meetings/$meetingId/live`;
* live meeting presentation;
* meeting timer;
* live-state indicators;
* participant presentation;
* incremental transcript simulation;
* simple local live controls;
* End Meeting flow;
* processing pipeline presentation;
* processing-stage simulation;
* uploaded-recording selection;
* uploaded-recording processing simulation;
* transition back to the existing Meeting Workspace.

This task does **not** own:

* completed Meeting Workspace content;
* global Action Items;
* Calendar;
* Meeting Rooms management;
* Members management;
* cross-meeting AI Assistant;
* real audio or AI integration.

## Expected Result

The prototype should support two understandable demo flows.

### Live Meeting Flow

```text
Open in-progress meeting
→ Enter Live Meeting
→ Timer runs
→ Capture / ASR status is visible
→ Transcript appears incrementally
→ End Meeting
→ Processing stages advance
→ Ready
→ Open Meeting Workspace
```

### Uploaded Recording Flow

```text
Open an appropriate meeting
→ Upload Recording
→ Select a mock .mp3 or .wav
→ Start Processing
→ Processing stages advance
→ Ready
→ Open Meeting Workspace
```

Both flows should visually converge on the same existing completed-meeting experience.

## Acceptance Criteria

* `/meetings/$meetingId/live` renders the appropriate meeting from shared data.
* An in-progress meeting displays a clear Live Meeting experience.
* A frontend elapsed timer is visible and functional.
* Live capture/ASR state is represented visually.
* Participants are resolved from shared member data.
* Transcript segments appear incrementally using existing/shared transcript data.
* Speaker identity presentation is consistent with the Meeting Workspace.
* End Meeting transitions into the processing experience.
* Processing clearly represents transcription, diarization, summary generation, extraction, indexing, and Ready stages.
* Processing stages advance using frontend-only simulation.
* Ready provides navigation to the existing Meeting Workspace.
* The uploaded-recording interaction accepts a mock `.mp3` or `.wav` selection and reuses the same processing flow.
* Scheduled, completed, processing, and cancelled meetings do not incorrectly render the normal Live Meeting state.
* No second transcript or processing domain model is introduced.
* No real microphone, recording, upload, streaming, ASR, diarization, or AI integration is implemented.
* Existing theme and responsive behavior remain functional.
* The frontend production build succeeds.

## Verification

Run the existing frontend production build.

Resolve errors introduced by this task.

Verify at minimum:

```text
in-progress meeting → Live Meeting
Live Meeting → End Meeting → Processing
Processing → Ready → Meeting Workspace
uploaded recording → Processing
completed meeting opened on live route
scheduled meeting opened on live route
```

Do not broaden the task to fix unrelated pre-existing issues.

## Stop Condition

Stop when both the Live Meeting and uploaded-recording paths convincingly simulate the transition from meeting capture to processed meeting intelligence and hand the user back to the existing Meeting Workspace.

Do not continue into global Action Items, Calendar, Rooms, Members, or cross-meeting AI Assistant implementation.
