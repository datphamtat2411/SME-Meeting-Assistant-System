# SME Meeting Assistant

## Product

SME Meeting Assistant is an internal meeting-management workspace designed to help teams organize meetings and turn meeting conversations into structured, searchable knowledge.

The product combines meeting management with AI-assisted meeting intelligence.

## Core Capabilities

The product is centered around:

* meeting scheduling and lifecycle management;
* meeting rooms and participants;
* Vietnamese meeting transcription;
* speaker identification and diarization;
* AI-generated meeting summaries;
* key decision extraction;
* action-item extraction and tracking;
* meeting minutes;
* and AI-assisted retrieval over previous meeting knowledge.

## Main Product Areas

The primary frontend areas are:

```text
Dashboard
Meetings
Calendar
Action Items
AI Assistant
Meeting Rooms
Members
```

Meeting Detail acts as the main workspace for an individual meeting and contains meeting information, transcript, decisions, action items, and AI-assisted meeting knowledge.

## Meeting Lifecycle

The main meeting lifecycle is:

```text
Scheduled
→ In Progress
→ Processing
→ Completed
```

A completed meeting can provide:

```text
Transcript
AI Summary
Key Decisions
Action Items
Meeting Minutes
AI/RAG Sources
```

## AI Context

The intended AI pipeline includes:

```text
Meeting Audio
→ Speech Recognition
→ Speaker Diarization
→ Transcript
→ Summary / Decisions / Action Items
→ Meeting Knowledge Index
→ AI Assistant
```

Vietnamese meetings are a primary use case.

The AI Assistant is focused on meeting knowledge rather than acting as a general-purpose chatbot.

## Current Frontend Phase

The current goal is to build a coherent frontend prototype from the existing Shadcn Admin-based application.

The prototype should make the intended product structure and end-to-end meeting workflow understandable.

Visual design does not need to be final or pixel-perfect.

Prefer the existing frontend design language and reusable components so the prototype can be refined later without rebuilding the application structure.
