# Task 09 — Cross-Meeting AI Assistant

## Goal

Turn the AI Assistant route into a meeting-focused knowledge assistant that can answer questions across previous meetings.

The feature should demonstrate:

* meeting-focused conversations;
* cross-meeting question answering;
* source-grounded responses;
* navigation back to source meetings;
* and lightweight retrieval-style behavior using existing shared mock data.

Do not implement real RAG, embeddings, vector search, LLM calls, or backend AI integration.

## Context

Before implementation, read:

```text
PRODUCT.md
```

Then inspect the current repository state and reuse the shared:

* meetings;
* transcripts;
* summaries;
* decisions;
* action items;
* members;
* assistant conversations;
* and RAG/source-reference data

established by previous tasks.

Reuse the existing AI/source presentation from the Meeting Workspace where practical.

Do not create a second assistant knowledge dataset.

## Core Principle

This page answers:

```text
What do we know across previous meetings?
```

The assistant should remain focused on organizational meeting knowledge.

It is not a general-purpose chatbot.

## Route

Implement:

```text
/assistant
```

Replace any placeholder introduced by earlier tasks.

If useful, repurpose existing Chats-style implementation patterns from the original template.

## Assistant Layout

Use a clean chat-style workspace suitable for meeting knowledge retrieval.

A desktop layout may include:

```text
Recent Conversations
        +
Current Conversation
```

Reuse existing chat layout patterns when they fit naturally.

Do not attempt to recreate ChatGPT or another external product pixel-for-pixel.

## Conversation List

Display a small set of realistic meeting-focused conversations from shared mock data.

Examples may include:

```text
Product launch decisions
Payment integration responsibilities
Q4 deadlines
Outstanding action items
```

Selecting a conversation should display its messages.

Do not create unrelated social/chat conversations.

## New Conversation State

Provide a useful empty or new-conversation state.

It should communicate that the assistant works over meeting knowledge.

For example:

```text
Ask about your meeting knowledge
```

Suggested prompts may include:

```text
Những quyết định quan trọng được đưa ra trong tuần này là gì?

Ai đang phụ trách các đầu việc liên quan đến thanh toán?

Những deadline nào được thống nhất gần đây?

Tôi còn những action item nào chưa hoàn thành?
```

Prefer realistic Vietnamese prompts for the primary demo experience.

## Question Input

Provide a lightweight chat composer.

Users may:

* select a suggested question;
* or enter a supported demo question.

The interaction should remain frontend-only.

Do not introduce API clients, streaming protocols, or backend request models.

## Mock Answer Behavior

Use deterministic frontend behavior.

A supported question may be resolved through:

```text
known question / intent
→ shared meeting data
→ prepared or derived response
→ shared source references
```

A combination of predefined demo answers and simple derived answers is acceptable.

Do not build a natural-language-processing engine.

## Derived Answers

Where simple and useful, derive answers directly from existing shared data.

Examples:

```text
responsibility question
→ Action Items + Members

deadline question
→ Action Item due dates

open-work question
→ current demo user + Action Items

decision question
→ shared Key Decisions

meeting-topic question
→ summaries / transcript sources
```

Keep this logic small and deterministic.

## Unsupported Questions

If a question does not match the supported prototype behavior, provide a lightweight fallback.

For example:

```text
This prototype supports meeting-related questions based on the available demo knowledge.

Try one of the suggested questions.
```

Do not fabricate arbitrary knowledge.

## Cross-Meeting Behavior

This feature must clearly differ from the meeting-scoped Ask AI tab created earlier.

Meeting Workspace Ask AI:

```text
one meeting
→ meeting-specific knowledge
```

Global AI Assistant:

```text
multiple meetings
→ cross-meeting knowledge
```

At least one supported answer must combine evidence from more than one meeting.

For example:

```text
What important decisions were made this week?
```

may return decisions and sources from multiple completed meetings.

## AI Answers

Answers should be concise and useful.

Where relevant, they may summarize:

* decisions;
* responsibilities;
* deadlines;
* action items;
* discussed topics;
* previous meeting outcomes.

Keep answers grounded in the shared demo data.

Do not generate unsupported facts.

## Source References

Meaningful answers should expose supporting meeting evidence.

Reuse the shared `RagSource` or equivalent source model established earlier.

Source references may represent:

```text
Transcript
Summary
Decision
Action Item
```

A source presentation should communicate useful information such as:

```text
Meeting title
Source type
Timestamp when available
Excerpt
```

## Source Grounding

The user should be able to understand why an answer was produced.

Example:

```text
Answer

Trần Hoàng Nam phụ trách hoàn thành API thanh toán
trước ngày 20/09.

Sources

Họp kế hoạch sản phẩm Quý IV
Transcript · 12:34

Họp kế hoạch sản phẩm Quý IV
Action Item
```

Do not present sources as decorative metadata.

They should correspond to the meeting knowledge supporting the answer.

## Source Navigation

Allow users to navigate from a source to its meeting:

```text
/meetings/$meetingId
```

If the existing Meeting Workspace already supports transcript-source navigation cleanly, reuse it when practical.

For example:

```text
Transcript Source
→ Meeting Workspace
→ Transcript
→ relevant segment
```

Do not build complex deep-linking infrastructure solely for this task.

Opening the source meeting is sufficient when deeper navigation is not already available.

## Current Demo User Questions

Support at least one useful question from the perspective of the existing current demo user.

For example:

```text
Tôi còn những action item nào chưa hoàn thành?
```

Use the same current demo user convention established by earlier tasks.

Derive the answer from shared action-item and meeting data where practical.

Do not introduce authentication or user-profile infrastructure.

## Meeting Knowledge Scope

The assistant may answer questions involving:

```text
previous meetings
summaries
key decisions
responsibilities
deadlines
action items
discussed topics
meeting outcomes
```

Keep all assistant knowledge inside the meeting domain.

## Existing Chat Template Reuse

Inspect the existing generic Chats feature if still present.

Reuse useful patterns such as:

```text
conversation list
chat layout
message bubbles
composer
scroll behavior
```

Repurpose those patterns into the Meeting Assistant domain.

Do not preserve irrelevant generic chat semantics.

## Shared Component Reuse

Reuse source-reference and meeting-intelligence components from earlier tasks where appropriate.

For example:

```text
SourceReference
MeetingStatusBadge
ParticipantAvatar
message presentation
```

A small refactor to share existing source-reference behavior between:

```text
Meeting Workspace Ask AI
Global AI Assistant
```

is acceptable when it directly reduces duplication.

Do not perform unrelated component refactoring.

## Optional Interaction Polish

A lightweight temporary state such as:

```text
Thinking...
```

may be shown before a mock answer appears.

This is optional.

Do not implement:

* token streaming;
* streaming text animation;
* request cancellation;
* retry infrastructure;
* conversation persistence.

## New Conversation

A frontend-only New Conversation action may be implemented if it fits naturally.

Expected behavior may be:

```text
New Conversation
→ empty assistant state
→ ask supported question
→ response appears
```

Persistence across refreshes is not required.

This is secondary to source-grounded question answering.

## No Separate Knowledge Base

Do not introduce new primary product areas such as:

```text
Knowledge Base
RAG
Semantic Search
Vector Search
Documents
```

Completed meetings remain the knowledge archive.

The AI Assistant is the natural-language retrieval layer over that knowledge.

## Explicitly Excluded

Do not implement:

* LLM API calls;
* FastAPI AI integration;
* embeddings;
* BGE-M3;
* BM25;
* vector search;
* Qdrant;
* ChromaDB;
* reranking;
* real retrieval pipelines;
* WebSocket or streaming responses;
* internet search;
* external document search;
* code assistance;
* image generation;
* autonomous agents;
* general-purpose ChatGPT behavior.

## Scope Boundaries

This task owns:

```text
/assistant

meeting-focused assistant layout
conversation list
suggested questions
frontend-only Q&A
cross-meeting answers
source-grounded responses
source cards/references
source → Meeting navigation
optional New Conversation
unsupported-question fallback
```

This task does **not** own:

* real RAG;
* backend AI integration;
* Meeting Workspace implementation;
* global Action Items management;
* Calendar;
* Meeting Rooms;
* Members;
* external knowledge sources;
* general chatbot behavior.

## Expected Result

The prototype should support a walkthrough such as:

```text
Open AI Assistant
→ Review meeting-focused suggested questions
→ Ask a question
→ Receive a grounded answer
→ Inspect meeting sources
→ Open a source meeting
```

It must also demonstrate at least one cross-meeting flow:

```text
Ask a cross-meeting question
→ Answer combines knowledge from multiple meetings
→ Sources reference multiple meetings
```

The feature should make the intended RAG product experience understandable without requiring any real AI infrastructure.

## Acceptance Criteria

* `/assistant` is no longer a placeholder.
* The page clearly presents itself as a meeting-knowledge assistant.
* Existing shared assistant/conversation data is reused where available.
* Existing shared meeting, transcript, decision, action-item, and source data is reused.
* Suggested meeting-focused questions are available.
* Users can submit or select supported demo questions.
* Supported questions return deterministic frontend-only answers.
* At least one answer is derived from or grounded in action-item/member data.
* At least one answer combines knowledge from multiple meetings.
* Meaningful answers display supporting source references.
* Source references resolve to valid existing meetings.
* Users can navigate from a source to the existing Meeting Workspace.
* Transcript source navigation is reused where already practical.
* Unsupported questions receive a clear lightweight fallback rather than fabricated information.
* No duplicate assistant knowledge dataset is introduced.
* The feature does not behave like a general-purpose chatbot.
* No real RAG, vector database, LLM, or backend AI integration is introduced.
* Existing theme and responsive behavior remain functional.
* The frontend production build succeeds.

## Verification

Run the existing frontend production build.

Resolve errors introduced by this task.

Verify at minimum:

```text
assistant landing/new state
conversation selection
suggested question
supported question response
current-user action-item question
cross-meeting answer
source rendering
source → Meeting navigation
unsupported-question fallback
```

Do not broaden the task to fix unrelated pre-existing issues.

## Stop Condition

Stop when the AI Assistant convincingly demonstrates meeting-focused cross-meeting knowledge retrieval with visible source evidence.

Do not expand it into a general chatbot, standalone knowledge-management system, external search product, or real AI/RAG integration.
