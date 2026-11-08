# Product

## Purpose

SME Meeting Assistant Web is the desktop-oriented management workspace for organizational meetings. It helps authorized users plan meetings, manage participants and rooms, review recordings and transcripts, turn meeting outcomes into follow-up work, and retrieve authorized meeting knowledge.

This file provides **Web agent context**, not a replacement for the canonical product and feature requirements in `../../../requirement-docs/`.

## Users and Authority

- Global roles: `EMPLOYEE`, `DEPARTMENT_MANAGER`, `ADMINISTRATOR`. Department management is scope-limited; administration does not automatically grant access to every meeting's sensitive content.
- Meeting Organizer, Meeting Participant, and Action Item Assignee are meeting-specific relationships, not global roles.
- Current account, session, meeting membership, and resource permissions determine what the user may access. Frontend visibility is never proof of authorization.

## Main Web Areas

- **Dashboard:** upcoming meetings, follow-up work, and authorized operational overviews.
- **Meetings / Meeting Workspace:** create and manage meetings; review occurrence details, participants, media, processing, transcript, summary, decisions, and action items.
- **Calendar / Rooms / Members:** scheduling views and authorized resource/member management.
- **Action Items:** track assigned and permitted post-meeting work.
- **AI Assistant:** ask evidence-grounded questions about accessible meeting knowledge.
- **Settings / Account / Export:** profile and preferences, account flows, and authorized meeting-minutes output.

These are product areas, not a promise that every current mock screen is integrated or complete.

## Core Concepts

A Meeting is the central business record linking an organizer, optional scheduling resources, participants, source media, and post-meeting artifacts.

Meeting execution states are `DRAFT`, `SCHEDULED`, `IN_PROGRESS`, `ENDED`, and `CANCELLED`. **AI processing is a separate lifecycle**: an ended meeting does not imply that transcription or summaries are ready.

The committed AI baseline is **offline/post-recording Vietnamese meeting processing**: accepted media → transcription and speaker mapping → reviewable summary/decision/action-item outputs → eligible knowledge retrieval. Near-real-time transcription is deferred, even though the prototype contains a live-meeting experience.

AI results are derived, evidence-dependent, and reviewable. Proposed decisions/action items must not silently become confirmed business records. Source references and current authorization matter for Assistant answers.

## Working With the Prototype

Existing Web screens and demo flows are a useful interaction baseline, not the definition of product behavior. Prefer adapting them during API integration; build missing UI only where needed. Real backend outcomes, visible failures, and human review take precedence over simulated completion.

Canonical details: `RE07-PRODUCT.md`, `RE06-FEATURES.md`, `RE04-BUSINESS_RULES.md`, and `RE01-AI.md` under `requirement-docs/`.
