# SME Meeting Assistant System — Product Requirements

**Document:** `PRODUCT.md`  
**Status:** Draft — Product Baseline  
**Audience:** Product owner, frontend team, mobile team, backend/API team, AI team, QA, reviewers, and future contributors  
**Scope:** Whole-product requirements  
**Authority:** This document is the canonical product-level description of the SME Meeting Assistant System. Detailed business rules, feature behavior, architecture, database design, API baseline, and security controls are defined in their respective requirement documents.

---

## 1. Purpose of This Document

This document defines what the SME Meeting Assistant System is, why it exists, who it serves, which capabilities belong to the product, and how the major parts of the product fit together from a user and business perspective.

It is intended to create a shared product understanding across the entire team so that frontend, mobile, backend, AI, and QA do not independently reinterpret the product.

This document intentionally does **not** define:

- exact API request and response payloads;
- detailed endpoint contracts;
- database column-level schemas;
- implementation class names or source-file names;
- detailed security mechanisms such as token lifetime or cookie configuration;
- exact AI model parameters, chunk sizes, overlap windows, retry counts, or confidence thresholds;
- task-specific implementation plans.

Those details belong to the other requirement documents or to task specifications.

---

## 2. Product Vision

The SME Meeting Assistant System is an internal meeting-management and AI-assisted knowledge platform for organizations.

The product is designed to support the complete lifecycle of an internal meeting:

1. planning and scheduling;
2. selecting a room and participants;
3. recording or importing meeting audio;
4. converting speech into a structured transcript;
5. identifying speakers;
6. generating meeting summaries, decisions, and action items;
7. following up on work after the meeting;
8. retrieving knowledge from past meetings through natural-language questions.

The product must reduce the amount of manual note-taking required during meetings while preserving enough source information and processing traceability to make AI-generated outputs reviewable and recoverable.

The system is not intended to be a disposable demonstration. It is intended to be designed as a production-oriented application that can be deployed safely for real organizational use and can evolve toward larger enterprise deployments.

---

## 3. Product Problem

Organizations commonly lose valuable information after meetings because meeting knowledge is fragmented across:

- handwritten notes;
- chat messages;
- personal documents;
- calendar invitations;
- audio recordings;
- individual memory;
- manually maintained task lists.

This creates several recurring problems:

- participants spend significant time taking notes instead of focusing on discussion;
- decisions are forgotten or interpreted differently by different people;
- action items are not consistently assigned or followed up;
- employees who were not present have difficulty understanding what happened;
- old meeting information is difficult to search;
- audio recordings are difficult to reuse because they are not structured or indexed;
- manual meeting minutes are slow to produce and often inconsistent;
- important details can be lost when speech-recognition systems fail silently.

The SME Meeting Assistant System addresses these problems by creating a structured and searchable source of organizational meeting knowledge.

---

## 4. Product Goals

The product SHALL pursue the following goals.

### 4.1 Centralize meeting operations

The system SHALL provide a shared place for users to manage:

- meeting schedules;
- meeting rooms;
- participants;
- meeting records;
- recordings;
- transcripts;
- summaries;
- decisions;
- action items;
- historical meeting knowledge.

### 4.2 Reduce manual documentation effort

The system SHALL use AI-assisted processing to reduce the amount of manual work required to produce useful meeting records.

### 4.3 Preserve meeting knowledge

Meeting knowledge SHALL remain discoverable after the meeting instead of being limited to the memory or private notes of attendees.

### 4.4 Make AI output reviewable

The system SHALL not treat AI output as inherently correct.

Where meaningful, the product SHALL preserve source information, processing states, timestamps, confidence or quality indicators, and user-editable results so that uncertain output can be reviewed.

### 4.5 Avoid silent loss of spoken content

For offline transcription, successful model execution SHALL NOT by itself mean that the audio was successfully transcribed.

The product SHALL be designed so that detected speech that has not been represented in the transcript can be discovered and handled rather than silently ignored.

### 4.6 Support post-meeting execution

The value of the product SHALL continue after transcription. The system SHALL help users understand decisions and follow assigned work after the meeting.

### 4.7 Support organizational knowledge retrieval

Authorized users SHALL be able to ask natural-language questions over historical meeting knowledge and receive answers grounded in meeting data that they are permitted to access.

### 4.8 Be deployable as a real application

The product SHALL be designed with production-quality concerns in mind, including security, reliability, recoverability, observability, maintainability, controlled access, and future scalability.

---

## 5. Product Principles

The following principles guide product decisions across all features.

### 5.1 Human-controlled product intent

AI assists users and developers, but product intent, business policy, permissions, and final organizational rules remain human-owned.

### 5.2 Source data must remain recoverable

Where practical, original user-provided source data SHALL be retained according to the configured retention policy so that derived AI outputs can be regenerated or investigated.

For transcription, the original uploaded or recorded audio is the authoritative source from which transcripts are derived.

### 5.3 AI output is derived data

Transcripts, summaries, extracted decisions, extracted action items, embeddings, and RAG responses are derived from source data.

The system SHALL distinguish source data from derived AI output at the product level.

### 5.4 Failure must be explicit

The system SHOULD prefer an explicit incomplete, failed, unresolved, or needs-review state over silently presenting missing or low-quality output as complete.

### 5.5 Authorization applies to derived knowledge

A user who is not authorized to access a meeting SHALL NOT gain access to that meeting indirectly through search, AI Assistant, summaries, exports, or other derived representations.

### 5.6 Product behavior must be consistent across clients

Web and mobile clients MAY present different interaction patterns appropriate to their platforms, but they SHALL represent the same underlying product concepts and business state.

### 5.7 Product requirements must not be inferred from UI alone

Existing frontend mockups and flows are important product references, but they are not the sole source of truth.

If the UI conflicts with approved product requirements, the UI SHALL be revised.

---

## 6. Target Organizations

The primary target is an organization that conducts recurring internal meetings and needs better meeting documentation and follow-up.

Typical target environments include:

- small and medium enterprises;
- departments within larger enterprises;
- project teams;
- operational teams;
- management teams;
- internal cross-functional groups.

The system SHOULD remain suitable for larger organizational deployments even if the first implementation is tested with a smaller user population.

The product requirement does not assume that every deployment must use the same infrastructure scale.

---

## 7. Product Users and Actors

The product distinguishes between **system roles** and **meeting-context roles**.

### 7.1 System roles

#### Employee

An Employee is a regular authenticated organizational user.

Typical capabilities include:

- viewing meetings the user is allowed to access;
- participating in scheduled meetings;
- viewing permitted transcripts and summaries;
- viewing or updating permitted action items;
- using the AI Assistant within the user's authorization scope;
- managing the user's own account preferences.

Exact permissions are defined in `BUSINESS_RULES.md` and `SECURITY.md`.

#### Department Manager

A Department Manager is an authenticated organizational user with additional management responsibilities within an assigned organizational scope.

Typical responsibilities may include:

- organizing meetings;
- viewing department-level meeting information;
- assigning or reviewing action items;
- managing permitted members or meeting resources;
- viewing department-level dashboard information.

Exact scope and permissions are defined elsewhere and SHALL NOT be inferred solely from this description.

#### Administrator

An Administrator is an authenticated user responsible for system-level administration within the deployment's authorized scope.

Typical responsibilities include:

- managing users and roles;
- managing meeting resources such as rooms;
- reviewing system-level operational information;
- managing permitted system settings;
- supporting account and access administration.

Administrator access SHALL NOT imply unrestricted access to all sensitive information unless explicitly permitted by the approved authorization model.

### 7.2 Meeting-context roles

Meeting-context roles describe a user's relationship to a specific meeting and are independent from the user's global system role.

#### Meeting Organizer

The Meeting Organizer is the user responsible for creating or organizing a meeting.

A meeting SHALL have a clearly identifiable organizer or equivalent responsible owner.

#### Meeting Participant

A Meeting Participant is a user associated with a meeting as an attendee or invited participant.

The participant's exact rights depend on business and security rules.

#### Action Item Assignee

An Action Item Assignee is a user responsible for a specific post-meeting action item.

One user may hold multiple contextual roles within the same meeting.

---

## 8. Product Surfaces

The system is expected to provide multiple user-facing and service-facing surfaces.

### 8.1 Web application

The web application is the primary management interface for desktop-oriented use.

It is expected to support rich workflows such as:

- meeting management;
- calendar and schedule views;
- room management;
- member management where authorized;
- transcript review;
- summary and action-item review;
- AI Assistant interaction;
- dashboards and administration.

### 8.2 Mobile application

The mobile application provides access to the same core product from mobile devices.

The mobile experience is particularly relevant for:

- viewing schedules;
- participating in meetings;
- recording meeting audio;
- viewing transcripts and summaries;
- reviewing action items;
- asking questions through the AI Assistant.

The mobile application MAY offer a reduced or differently arranged feature set when a workflow is unsuitable for a mobile device, but business semantics SHALL remain consistent.

### 8.3 Core business backend

The core backend provides the authoritative application behavior for business entities such as users, meetings, rooms, participants, and action items.

Exact architectural ownership is defined in `ARCHITECTURE.md`.

### 8.4 AI processing service

The AI processing service provides specialized AI capabilities such as:

- speech recognition;
- speaker diarization;
- transcript processing;
- summarization;
- decision extraction;
- action-item extraction;
- embedding and retrieval processing;
- AI-assisted question answering.

The AI service is not the product authority for business authorization or meeting ownership unless explicitly defined by architecture requirements.

---

## 9. Major Product Capabilities

The following capabilities form the product baseline.

### 9.1 Authentication and account access

The system SHALL provide authenticated access for organizational users.

The product SHALL support at minimum:

- sign-in;
- authenticated session continuity;
- sign-out;
- session renewal;
- current-user identity retrieval;
- account recovery flows where enabled;
- disabled or restricted account handling.

Detailed token handling, cookie behavior, password policy, session lifetime, revocation, and other security controls are defined in `SECURITY.md`.

### 9.2 User, member, and role management

Authorized users SHALL be able to manage organizational users and role assignments according to approved permissions.

The product SHALL maintain enough identity and role information to support:

- meeting access control;
- organizer identity;
- participant identity;
- action-item assignment;
- dashboard grouping where required;
- auditability of user actions where required.

### 9.3 Meeting scheduling

Authorized users SHALL be able to create and manage meetings.

A meeting conceptually includes information such as:

- title;
- purpose or description;
- organizer;
- scheduled date and time;
- participants;
- meeting room or meeting location where applicable;
- lifecycle state;
- meeting-related outputs after processing.

Exact required fields and validation rules are defined in `FEATURES.md` and `BUSINESS_RULES.md`.

### 9.4 Calendar and schedule views

The system SHALL provide schedule-oriented views that allow users to understand upcoming, ongoing, and historical meeting activity within their access scope.

Calendar presentation is a client concern, but the underlying schedule semantics SHALL be consistent across clients.

### 9.5 Meeting room management

The system SHALL support organizational meeting rooms or equivalent reservable meeting resources.

Authorized users SHALL be able to view and manage meeting rooms according to their role.

Scheduling logic SHALL support room availability and conflict handling as defined by business rules.

### 9.6 Meeting participants

Meetings SHALL support multiple participants.

The product SHALL preserve the relationship between users and the meetings in which they participate so that permissions, transcripts, summaries, action items, and knowledge retrieval can be scoped correctly.

### 9.7 Audio import

The system SHALL support importing meeting audio for offline processing.

The product baseline SHALL support common audio formats appropriate to the implementation.

Video-container import MAY be supported when audio can be extracted from the uploaded file.

Exact supported formats, limits, and validation are defined in feature, security, and architecture requirements.

### 9.8 Meeting recording

The product SHALL support recording meeting audio through an appropriate client when permitted by platform capabilities and user permissions.

For the committed baseline, recorded audio SHALL be processed after recording has been completed and submitted to the backend.

From the AI pipeline perspective, imported audio and completed client recordings belong to the same offline/post-recording processing class.

### 9.9 Offline transcription

Offline/post-recording transcription is a **committed core capability**.

The system SHALL process stored audio into timestamped transcript data.

The offline transcription product behavior SHALL prioritize:

1. preserving spoken content;
2. transcript accuracy;
3. resilience to Whisper hallucination;
4. failure isolation;
5. detection of speech regions that have not been represented in the transcript;
6. recoverability through retained source audio.

The product SHALL NOT consider a transcription job successful merely because the speech-recognition provider returned a response.

Before transcript text becomes the persisted/current machine transcript, the reconciled ASR candidate transcript SHALL pass through an LLM-based contextual correction stage. For meetings within supported product limits, that correction stage SHALL receive the whole meeting transcript candidate in chronological order so spelling and lexical corrections can use conversation-wide context.

The LLM-corrected transcript SHALL become the initial persisted/current machine transcript. Raw Whisper transcript text SHALL NOT be retained as a competing persisted transcript representation. The original audio remains the recoverable source for reprocessing.

If contextual LLM correction cannot complete successfully, the system SHALL expose a retryable/failed processing outcome rather than silently persisting raw Whisper text as the final transcript.

The final processing flow SHALL be able to distinguish completed, suspicious, unresolved, and failed processing outcomes where appropriate.

Implementation parameters for VAD, energy detection, chunking, overlap, retries, and reconciliation belong to the AI architecture and package-level design rather than this document.

### 9.10 Speaker diarization

The system SHALL support identifying speaker turns in multi-speaker meeting audio.

Diarization results SHALL be associated with transcript timing information so that the product can display who spoke during different parts of the meeting.

The product MAY initially represent speakers using generated labels such as `Speaker 1`, `Speaker 2`, and similar identifiers before user-confirmed identity mapping is available.

Speaker identity correction or mapping SHOULD be supported where required by detailed feature requirements.

### 9.11 Transcript review

The system SHALL provide a transcript view organized around the meeting timeline.

A transcript SHOULD expose, where available:

- text;
- timestamps;
- speaker labels or identities;
- processing or quality state when useful;
- correction state when applicable.

The transcript SHALL remain connected to the meeting from which it was produced.

### 9.12 Meeting summary

The system SHALL support generation of a concise meeting summary from processed meeting content.

The summary is derived AI output and SHALL NOT replace the underlying transcript.

### 9.13 Decision extraction

The system SHALL support extraction of significant decisions made during the meeting when sufficient source evidence exists.

Decision output SHALL remain traceable to the meeting.

Detailed confirmation and editing behavior is defined in `FEATURES.md` and `BUSINESS_RULES.md`.

### 9.14 Action item extraction and management

The system SHALL support action items associated with meetings.

Action items MAY be:

- extracted automatically from meeting content;
- created or corrected by authorized users;
- assigned to responsible users;
- tracked after the meeting.

The product SHALL support status-based follow-up so that post-meeting work can be monitored.

### 9.15 AI Assistant and meeting knowledge retrieval

The system SHALL provide an AI Assistant that allows authorized users to ask natural-language questions about historical meeting information.

The assistant SHALL use retrieval over meeting knowledge rather than relying only on general model memory.

Responses SHOULD be grounded in authorized meeting content and SHOULD provide enough source context or citation information for users to understand where the answer came from when supported by the implementation.

The assistant SHALL NOT bypass normal meeting authorization.

### 9.16 Search and historical retrieval

The product SHOULD allow users to find previous meetings and relevant meeting information using structured filters, search, or AI-assisted retrieval.

Exact search surfaces are defined in detailed feature requirements.

### 9.17 Dashboard and follow-up visibility

The system SHALL provide dashboards or summary views that help users understand meeting activity and post-meeting execution.

Dashboard information MAY include approved metrics such as:

- meeting counts;
- upcoming meetings;
- completed meetings;
- action-item status;
- overdue work;
- participation or operational summaries where approved.

Exact metrics are defined in detailed feature requirements.

### 9.18 Transactional email notifications

The product SHALL support backend-controlled transactional email for selected workflows.

Typical uses include:

- account and password-recovery communication;
- meeting invitations or schedule notifications;
- meeting changes or cancellation notifications;
- action-item or reminder notifications when enabled.

The exact set of emails in the first release is defined in `FEATURES.md`.

Email delivery is a supporting product capability and SHALL NOT become the sole source of truth for core business state.

### 9.19 User settings

The system SHOULD allow users to manage relevant personal settings such as profile information, notification preferences, display preferences, or other approved settings.

Settings that affect security or organizational permissions remain subject to security and business rules.

---

## 10. Core Meeting Lifecycle

At the product level, a meeting moves through a lifecycle that separates planning, execution, AI processing, and historical use.

The exact state machine is defined in `BUSINESS_RULES.md`, but the product SHALL support the following conceptual phases:

```text
Planning
  ↓
Scheduled
  ↓
Meeting Occurs
  ↓
Audio Available
  ↓
AI Processing
  ↓
Transcript / Summary / Decisions / Action Items
  ↓
Post-Meeting Follow-Up
  ↓
Historical Knowledge / Retrieval
```

A meeting MAY also enter exceptional paths such as:

- cancellation;
- processing failure;
- partially completed AI processing;
- reprocessing;
- archived or retained historical state.

No client SHALL invent its own lifecycle independent of the approved business rules.

---

## 11. Core Offline Audio Processing Product Flow

The baseline product flow for imported or completed recorded audio is:

```text
Audio File / Completed Recording
        ↓
Upload / Ingestion
        ↓
Validation and Normalization
        ↓
Speech Detection / Speech Map
        ↓
Independent Speech-Recognition Processing
        ↓
Transcript Coverage Validation
        ↓
Recovery of Unresolved Speech Regions
        ↓
Transcript Reconciliation
        ↓
Whole-Meeting LLM Transcript Correction
        ↓
Speaker Diarization / Speaker Mapping
        ↓
Final Transcript
        ↓
Summary / Decisions / Action Items
        ↓
Knowledge Indexing for Authorized Retrieval
```

The product-level invariant is that a localized speech-recognition failure SHALL NOT silently cause later spoken content to disappear from the final result.

If recovery cannot resolve a detected speech region, the system SHALL represent that condition explicitly instead of silently treating the region as complete.

---

## 12. Near-Real-Time Transcription Status

Near-real-time transcription is part of the long-term product direction but is **not part of the initial committed ASR baseline**.

The current product development priority is to build and validate the offline/post-recording transcription pipeline first.

Near-real-time transcription is intentionally deferred because it introduces additional product and technical concerns, including:

- continuous audio streaming;
- partial transcript updates;
- chunk overlap while audio is still arriving;
- speaker continuity across chunks;
- reconnect behavior;
- latency constraints;
- provisional versus final transcript reconciliation;
- streaming error recovery;
- resource scheduling for concurrent sessions.

When implemented, near-real-time output SHOULD be treated as provisional unless and until the product explicitly defines it as final.

The product SHOULD retain the ability to run a more robust post-meeting pass over the complete audio to produce a final transcript.

Detailed requirements for near-real-time transcription SHALL be written later, after the offline pipeline is validated.

---

## 13. End-to-End User Journeys

### 13.1 Schedule and complete a meeting

A typical user journey is:

```text
Organizer signs in
    ↓
Creates meeting
    ↓
Selects schedule
    ↓
Selects room if applicable
    ↓
Adds participants
    ↓
Meeting occurs
    ↓
Audio is recorded or later imported
    ↓
Audio is processed
    ↓
Transcript becomes available
    ↓
Summary / decisions / action items are generated
    ↓
Participants review results
    ↓
Action items are followed until completion
```

### 13.2 Import an existing recording

```text
Authorized user selects meeting
    ↓
Uploads audio or supported media
    ↓
System validates input
    ↓
Processing job begins
    ↓
User can observe processing state
    ↓
Transcript becomes available or an explicit error is reported
    ↓
Derived meeting insights are generated
```

### 13.3 Record first, process later

```text
User starts recording through supported client
    ↓
Audio is captured locally or through the approved recording mechanism
    ↓
Recording ends
    ↓
Completed recording is submitted
    ↓
Same offline processing pipeline as imported audio
```

### 13.4 Review meeting knowledge

```text
User opens completed meeting
    ↓
Reviews transcript and speakers
    ↓
Reviews summary and decisions
    ↓
Reviews action items
    ↓
Makes permitted corrections or updates
```

### 13.5 Ask the AI Assistant

```text
Authorized user asks a question
    ↓
System determines accessible meeting knowledge
    ↓
Relevant content is retrieved
    ↓
Assistant generates grounded answer
    ↓
User can identify supporting meeting context where available
```

### 13.6 Follow up on action items

```text
Meeting produces action items
    ↓
Items are assigned
    ↓
Assignees review their work
    ↓
Status changes over time
    ↓
Managers / authorized users monitor follow-up
```

---

## 14. Product Data Categories

The product handles several categories of information.

### 14.1 Identity data

Examples include:

- user profile information;
- role information;
- organizational membership;
- account status.

### 14.2 Meeting metadata

Examples include:

- title;
- schedule;
- organizer;
- participants;
- room;
- meeting state.

### 14.3 Source media

Examples include:

- imported audio;
- recorded audio;
- supported media from which audio is extracted.

### 14.4 Transcript data

Examples include:

- LLM-corrected transcript segments;
- timestamps;
- speaker labels;
- corrected speaker identity;
- human transcript revisions;
- quality or processing metadata.

### 14.5 Derived AI data

Examples include:

- summaries;
- decisions;
- extracted action items;
- embeddings;
- retrieval metadata;
- AI Assistant responses.

### 14.6 Operational data

Examples include:

- processing state;
- retry metadata;
- failure state;
- audit information;
- notification state;
- observability metadata.

Detailed storage and retention decisions belong to `DATABASE.md`, `ARCHITECTURE.md`, and `SECURITY.md`.

---

## 15. Product Trust Model

The product SHALL visibly distinguish between different levels of trust where meaningful.

Examples include:

- raw source audio;
- LLM-corrected machine transcript;
- human-corrected transcript;
- AI-generated summary;
- AI-extracted action item;
- human-confirmed action item;
- AI Assistant response.

The system SHOULD avoid presenting all derived data as equally authoritative.

A future implementation MAY expose additional review or confirmation workflows without changing this product principle.

---

## 16. Product Quality Expectations

This document does not define exact service-level objectives, but the product is expected to be designed with the following qualities.

### 16.1 Security

The system SHALL protect organizational meeting data and enforce access control consistently across source and derived information.

### 16.2 Reliability

A temporary failure in an AI model, email provider, or other external dependency SHOULD NOT corrupt authoritative business state.

### 16.3 Recoverability

The system SHOULD retain enough state to retry or recover from failed asynchronous processing where appropriate.

### 16.4 Observability

Important workflows SHOULD expose enough operational state to support debugging and administration.

### 16.5 Maintainability

Product concepts SHALL have clear ownership and consistent naming so that multiple team members can implement different parts without redefining the same behavior differently.

### 16.6 Scalability

The product SHALL avoid design assumptions that make future scale-out unnecessarily difficult.

### 16.7 Usability

Complex AI processing states SHOULD be presented to users in understandable terms rather than leaking implementation details.

### 16.8 Data integrity

Authoritative business state and derived AI state SHALL be distinguishable so that failure in AI processing does not invalidate core meeting records.

---

## 17. Product Scope Baseline

The following capability groups are considered part of the product baseline unless later requirement decisions explicitly change them.

| Capability | Baseline Status |
|---|---|
| Authentication and account access | Committed |
| User/member/role management | Committed |
| Meeting scheduling | Committed |
| Calendar views | Committed |
| Meeting rooms | Committed |
| Meeting participants | Committed |
| Audio import | Committed |
| Record-then-process audio | Committed |
| Offline/post-recording ASR | Committed |
| Hallucination/failure-resilient transcript processing | Committed |
| Speaker diarization | Committed |
| Transcript review | Committed |
| Meeting summary | Committed |
| Decision extraction | Committed |
| Action-item extraction and management | Committed |
| AI Assistant / RAG | Committed |
| Dashboard | Committed |
| Transactional email notifications | Committed |
| Near-real-time transcription | Late phase / Deferred baseline |
| Streaming diarization | Late phase / Deferred baseline |
| Provisional streaming transcript protocol | Late phase / Deferred baseline |

---

## 18. Product Boundaries

### 18.1 The system is a meeting assistant, not a general collaboration suite

The product MAY integrate with other communication or productivity tools in the future, but its primary responsibility remains meeting management, meeting intelligence, and post-meeting knowledge.

It is not intended to replace all chat, document, project-management, or video-conferencing tools.

### 18.2 The system does not treat AI as an unquestioned authority

AI-generated content SHALL remain derived content and MAY require review, correction, or confirmation depending on the feature.

### 18.3 The system does not define product behavior from one client implementation

The current web UI is a product reference, not the final authority for business behavior.

### 18.4 The product baseline does not require real-time transcription first

Near-real-time transcription SHALL NOT block delivery of the offline/post-recording product baseline.

---

## 19. Release-Oriented Product Priorities

The current product-development priority SHOULD follow this order unless a later approved project decision changes it.

### Priority 1 — Product and business foundation

- identity and access;
- users, members, roles;
- meeting scheduling;
- meeting rooms;
- participants;
- reliable business state.

### Priority 2 — Offline meeting intelligence

- audio import;
- record-then-process workflow;
- offline ASR;
- hallucination/failure isolation;
- coverage validation and recovery;
- speaker diarization;
- transcript review.

### Priority 3 — Post-meeting intelligence

- summaries;
- decisions;
- action items;
- notifications;
- dashboard follow-up.

### Priority 4 — Organizational knowledge

- indexing;
- retrieval;
- AI Assistant;
- grounded answers;
- authorization-aware meeting knowledge.

### Priority 5 — Near-real-time enhancement

- streaming audio;
- provisional transcript;
- low-latency processing;
- streaming speaker continuity;
- final reconciliation with post-meeting processing.

This ordering exists to reduce project risk and to ensure that difficult streaming work does not prevent completion of the core system.

---

## 20. Product Terminology

### Meeting

A scheduled or historical organizational meeting represented by the system.

### Organizer

The user responsible for organizing a specific meeting.

### Participant

A user associated with a meeting as an attendee or invited member.

### Meeting Room

A reservable physical or logical meeting resource managed by the system.

### Recording

Audio captured for a meeting and submitted for processing.

### Imported Audio

Existing audio or supported media uploaded to the system for processing.

### Raw Audio

The retained source representation from which transcription processing can be repeated or recovered.

### Transcript

Timestamped textual representation of spoken meeting content. In the baseline offline pipeline, the initial persisted machine transcript is the LLM-corrected result produced from the reconciled Whisper candidate using whole-meeting context; raw Whisper transcript text is not retained as a separate persisted transcript.

### Transcript Segment

A time-bounded portion of a transcript associated with text and potentially speaker and processing metadata.

### Speaker Diarization

The process of identifying speaker turns in audio without necessarily knowing the real-world identity of each speaker.

### Speaker Mapping

Association of a generated speaker label with a known meeting participant or identity.

### Summary

AI-generated concise representation of the meeting's main content.

### Decision

A significant conclusion or agreed outcome identified from meeting content.

### Action Item

A piece of follow-up work associated with the meeting and potentially assigned to a responsible user.

### Speech Map

A processing representation describing where speech is believed to exist in the audio independently of the transcript.

### Transcript Coverage

A measure or state describing whether detected speech regions are represented by transcript output.

### Suspicious Region

An audio/transcript region whose processing evidence indicates that its transcript may be incomplete or unreliable.

### Unresolved Region

A region containing expected speech for which the processing pipeline has not produced acceptable transcript coverage.

### Recovery

Additional processing intended to recover transcript content from an unresolved region.

### AI Assistant

The conversational product capability that answers questions using authorized meeting knowledge.

### RAG

Retrieval-Augmented Generation: retrieval of relevant stored meeting knowledge before generating an AI answer.

### Derived Data

Information produced from source data, such as transcripts, summaries, embeddings, or extracted action items.

---

## 21. Relationship to Other Requirement Documents

This document owns product-level intent only.

The remaining requirement documents SHALL refine it as follows.

### `BUSINESS_RULES.md`

Defines canonical business rules, lifecycle transitions, permissions at business level, validation, ownership, conflict rules, and cross-feature invariants.

### `FEATURES.md`

Defines detailed functional behavior and user-facing feature requirements.

### `ARCHITECTURE.md`

Defines system boundaries, service responsibilities, communication model, async processing architecture, package structure baselines, and technical architecture decisions.

### `DATABASE.md`

Defines canonical data-model and persistence baseline.

### `API.md`

Defines global API conventions, common response format, and the baseline API surface.

### `SECURITY.md`

Defines authentication, session security, authorization, secrets, data protection, rate limiting, file security, RAG access control, and related security requirements.

If two documents appear to conflict, the conflict SHALL be resolved explicitly rather than silently choosing one interpretation.

---

## 22. Open Product Decisions

The following areas may require additional explicit decisions while the remaining requirement documents are prepared.

An open product decision MUST NOT be silently filled by individual implementation preference.

Current areas that may require later clarification include:

- exact organization/department hierarchy and management scope;
- exact invitation semantics for meeting participants;
- whether external/non-employee participants are supported in the baseline;
- exact notification set for the first release;
- whether extracted decisions require human confirmation;
- exact action-item confirmation behavior after AI extraction;
- exact export formats beyond the already intended meeting-minutes output;
- final scope of mobile administration features;
- final near-real-time transcription behavior;
- final organizational tenancy/deployment model.

These items SHOULD be resolved in the appropriate requirement document before implementation depends on them.

---

## 23. Product Acceptance at a High Level

The product baseline can be considered functionally coherent when an authorized organization user can complete the following end-to-end scenario:

1. authenticate successfully;
2. create or access a meeting;
3. schedule it and associate participants and an available room where required;
4. conduct the meeting;
5. record the meeting or import an existing recording;
6. submit the audio for offline processing;
7. observe processing progress and explicit failure states;
8. receive a timestamped transcript without silently skipped detected speech;
9. review speaker-separated transcript content;
10. review summary, decisions, and action items;
11. track permitted action items after the meeting;
12. later retrieve the meeting and its knowledge;
13. ask the AI Assistant a question that is answered only from content the user is authorized to access.

The product is not considered complete merely because individual screens or endpoints exist. The end-to-end workflow must remain internally consistent across clients, backend services, AI processing, persistence, and authorization.

---

## 24. Final Product Principle

The SME Meeting Assistant System SHALL be designed around the following principle:

> **A meeting is not finished when the audio stops. The system must preserve what was said, turn it into trustworthy structured knowledge, make follow-up work visible, and keep that knowledge safely retrievable for the people who are allowed to use it.**

