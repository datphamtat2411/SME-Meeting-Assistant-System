# SME Meeting Assistant System — Business Rules

**Document:** `BUSINESS_RULES.md`  
**Status:** Draft — Canonical Business Rule Baseline  
**Audience:** Product owner, frontend team, mobile team, backend/API team, AI team, QA, reviewers, and future contributors  
**Scope:** Whole-product business behavior and invariants  
**Authority:** This document is the canonical source for business rules that must remain consistent across clients, services, AI processing, persistence, and task implementations.

---

## 1. Purpose of This Document

This document defines the business rules of the SME Meeting Assistant System.

Its purpose is to remove ambiguity between team members so that the same product behavior is implemented consistently across:

- Web;
- Mobile;
- Spring Boot business API;
- AI processing service;
- database design;
- background jobs;
- email notifications;
- tests;
- future integrations.

A business rule defines **what must remain true from the product/business point of view**.

This document intentionally does **not** define:

- HTTP request or response schemas;
- endpoint implementation details;
- database column-level schemas;
- Java/Python/Dart/TypeScript class names;
- exact cryptographic or token settings;
- exact AI chunk sizes, thresholds, retry counts, or model parameters;
- package-specific coding conventions;
- task-specific implementation plans.

Those concerns belong to `API.md`, `DATABASE.md`, `SECURITY.md`, `ARCHITECTURE.md`, package-level `docs/`, or Task Specifications.

---

## 2. Normative Language

The words **MUST**, **MUST NOT**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

- **MUST / SHALL** — mandatory behavior.
- **MUST NOT / SHALL NOT** — prohibited behavior.
- **SHOULD** — expected behavior unless a documented exception is approved.
- **SHOULD NOT** — discouraged behavior unless a documented exception is approved.
- **MAY** — optional behavior.

A rule identifier such as `BR-MTG-001` is stable and SHOULD be referenced by feature requirements, task specifications, tests, and review notes.

---

## 3. Rule Ownership and Conflict Resolution

### BR-GEN-001 — One canonical owner per rule

A business fact defined in this document MUST NOT be independently redefined with different semantics in another requirement document.

Other documents MAY reference the rule.

### BR-GEN-002 — UI is not a business-rule authority

Existing Web or Mobile behavior MUST NOT override a business rule in this document.

If a client mock conflicts with an approved business rule, the client MUST be changed.

### BR-GEN-003 — Implementation is not allowed to silently redefine product behavior

An implementation convenience MUST NOT change a business rule without an explicit requirement update.

### BR-GEN-004 — Explicit unresolved state is preferable to false success

When the system cannot confidently determine that a business operation or AI-processing outcome succeeded, it SHOULD expose an explicit incomplete, failed, unresolved, or needs-review state instead of silently presenting success.

### BR-GEN-005 — Derived data must remain distinguishable from source data

The system MUST distinguish user/source data from AI-derived or computed data when the distinction affects reviewability, trust, permissions, or regeneration.

### BR-GEN-006 — Cross-client consistency

Web and Mobile MAY use different interaction designs, but they MUST operate on the same underlying business states and rules.

### BR-GEN-007 — Historical integrity

Historical records MUST NOT be silently rewritten in a way that destroys the ability to understand what occurred, who changed it, or which source produced a derived artifact when that information is business-relevant.

### BR-GEN-008 — No silent business-data loss

A recoverable error in one component MUST NOT silently cause unrelated valid business data to disappear.

---

# 4. Identity, Account, and Membership Rules

## 4.1 User Identity

### BR-ID-001 — Unique organizational user identity

An active organizational user MUST have one unique account identity within the applicable organizational boundary.

### BR-ID-002 — Email uniqueness

An email address used as an account login identifier MUST NOT belong to more than one active account within the same organizational boundary.

Email comparison SHOULD be normalized consistently so that casing differences do not create duplicate identities.

### BR-ID-003 — Account status controls access

Only accounts in an approved active state MAY authenticate and use protected product capabilities.

A disabled, suspended, deactivated, or otherwise restricted account MUST NOT be allowed to establish or renew an authenticated product session.

Exact authentication mechanisms are defined in `SECURITY.md`.

### BR-ID-004 — Deactivation preserves historical references

Deactivating a user MUST NOT destroy historical references such as:

- meeting organizer identity;
- participant history;
- action-item ownership history;
- transcript corrections;
- confirmed decisions;
- audit-relevant actions.

Where necessary, the product MAY display a deactivated-user marker instead of treating the historical record as ownerless.

### BR-ID-005 — Account deletion is not ordinary UI deletion

Permanent deletion of an organizational user MUST be treated as a controlled administrative or retention/privacy operation.

Normal account management SHOULD prefer deactivation over destructive deletion when historical business records reference the user.

---

## 4.2 System Roles

The baseline system roles are:

- `EMPLOYEE`;
- `DEPARTMENT_MANAGER`;
- `ADMINISTRATOR`.

Meeting-context roles such as Organizer, Participant, and Action Item Assignee are separate from global system roles.

### BR-ROLE-001 — Global role and meeting role are independent

A user's global system role MUST NOT automatically determine the user's role inside every meeting.

For example, an Administrator is not automatically a Meeting Organizer or Meeting Participant.

### BR-ROLE-002 — Least business privilege

A user MUST receive only the business capabilities granted by the user's global role, organizational scope, meeting relationship, and explicit content-access rules.

### BR-ROLE-003 — Administrator does not imply unrestricted meeting-content access

Administrator status MUST NOT, by itself, imply unrestricted permission to read all meeting audio, transcripts, summaries, decisions, or AI Assistant knowledge.

Administrative operational access and meeting-content access MUST be treated as separate concerns.

### BR-ROLE-004 — Manager scope is bounded

A Department Manager's management capabilities MUST be limited to the manager's approved organizational scope.

A manager MUST NOT gain management authority over unrelated organizational units merely because the global role is `DEPARTMENT_MANAGER`.

### BR-ROLE-005 — Role changes affect future authorization

When a user's role or organizational scope changes, future authorization decisions MUST use the new role/scope.

Historical attribution MUST remain intact.

---

# 5. Meeting Core Rules

## 5.1 Meeting Identity and Ownership

### BR-MTG-001 — Every meeting has one organizer

Every meeting MUST have exactly one current Meeting Organizer.

### BR-MTG-002 — Organizer must be an active organizational user at creation time

A new meeting MUST NOT be created with a nonexistent or inactive organizer.

### BR-MTG-003 — Organizer remains historically identifiable

If the organizer later becomes inactive, the meeting MUST preserve the organizer's historical identity.

### BR-MTG-004 — Meeting title is required

A meeting MUST have a non-empty title before it can become `SCHEDULED`.

### BR-MTG-005 — Meeting occurrence time must be valid

For a scheduled meeting, the scheduled end time MUST be later than the scheduled start time.

### BR-MTG-006 — Meeting business state is independent from AI state

Meeting lifecycle state MUST NOT be overloaded to represent transcription, summarization, indexing, or other AI-processing states.

A meeting MAY be `ENDED` while AI processing is still queued, processing, partially complete, failed, or awaiting review.

### BR-MTG-007 — Cancellation is not deletion

Cancelling a meeting MUST preserve the meeting record and its relevant history.

Cancellation MUST NOT be implemented as deletion.

### BR-MTG-008 — Historical meeting records must remain attributable

When a meeting has ended, cancellation, archival, user deactivation, or later edits MUST NOT silently erase its historical participants, organizer, timestamps, or derived artifacts that are required by retention policy.

### BR-MTG-009 — Meeting access applies transitively to derived content

A user who is not authorized to access a meeting's protected content MUST NOT gain that content through:

- transcript pages;
- summary pages;
- decision pages;
- action-item details containing protected context;
- exported minutes;
- search;
- AI Assistant / RAG;
- notifications containing protected content.

### BR-MTG-010 — Meeting content and operational metadata may have different access scopes

The system MAY allow authorized operational roles to see limited meeting metadata without granting access to full meeting content.

Seeing that a meeting exists MUST NOT automatically imply permission to read its audio or transcript.

---

# 6. Meeting Lifecycle Rules

The baseline meeting lifecycle is intentionally separate from AI-processing lifecycle.

Canonical meeting execution states:

```text
DRAFT
SCHEDULED
IN_PROGRESS
ENDED
CANCELLED
```

Archival is treated separately from meeting execution state.

## 6.1 Draft

### BR-MTG-LC-001 — Draft is editable planning state

A `DRAFT` meeting MAY be edited by authorized users before scheduling.

### BR-MTG-LC-002 — Draft is not considered a committed reservation

A `DRAFT` meeting MUST NOT reserve a physical meeting room unless explicitly converted to a committed scheduled state.

### BR-MTG-LC-003 — Draft may be removed before becoming historical

A draft that has never become scheduled, started, or associated with retained meeting artifacts MAY be deleted by an authorized user according to feature requirements.

---

## 6.2 Scheduled

### BR-MTG-LC-004 — Scheduled meeting requires valid schedule

A meeting MUST have a valid scheduled start and end time before entering `SCHEDULED`.

### BR-MTG-LC-005 — Scheduled room reservation becomes authoritative

If a physical room is assigned when the meeting becomes `SCHEDULED`, the room reservation MUST participate in room-conflict validation.

### BR-MTG-LC-006 — Scheduled meeting may be modified before start

An authorized organizer or equivalent manager MAY modify a `SCHEDULED` meeting subject to room, participant, notification, and permission rules.

### BR-MTG-LC-007 — Material schedule changes must be treated as meeting changes

Changes to meeting time, room, cancellation state, or other approved material scheduling attributes MUST be recognizable as meeting changes for notification and audit purposes.

---

## 6.3 In Progress

### BR-MTG-LC-008 — Only a non-cancelled meeting may start

A `CANCELLED` meeting MUST NOT transition to `IN_PROGRESS`.

### BR-MTG-LC-009 — A meeting cannot be simultaneously scheduled and in progress

`SCHEDULED` and `IN_PROGRESS` are mutually exclusive meeting execution states.

### BR-MTG-LC-010 — In-progress schedule edits are restricted

Changes that would invalidate historical execution semantics SHOULD NOT be freely allowed after a meeting enters `IN_PROGRESS`.

Corrections to metadata MAY still be permitted where they do not rewrite what actually occurred.

---

## 6.4 Ended

### BR-MTG-LC-011 — Ended means meeting execution ended, not AI processing completed

A meeting enters `ENDED` when the meeting occurrence has finished or a historical/imported meeting record is finalized as having occurred.

`ENDED` MUST NOT imply that transcript, diarization, summary, decisions, action items, or RAG indexing have completed.

### BR-MTG-LC-012 — Ended meetings are historical records

Once a meeting has entered `ENDED`, destructive edits to occurrence history SHOULD be restricted.

Corrections MAY be made by authorized users, but the system SHOULD preserve meaningful historical attribution.

### BR-MTG-LC-013 — Historical import may establish an ended meeting

An authorized user MAY create or finalize a meeting record for an already-occurred meeting when importing existing meeting audio.

Such a flow MAY enter `ENDED` without passing through a live `IN_PROGRESS` application state, provided required historical metadata is valid.

---

## 6.5 Cancelled

### BR-MTG-LC-014 — Cancellation is terminal for occurrence

A `CANCELLED` meeting MUST NOT transition to `IN_PROGRESS` or `ENDED` as though the cancelled occurrence took place.

A replacement occurrence SHOULD be represented by rescheduling before cancellation or by a new meeting record according to feature behavior.

### BR-MTG-LC-015 — Cancellation releases future room reservation

When a scheduled meeting is cancelled, its future physical-room reservation MUST no longer block another meeting.

### BR-MTG-LC-016 — Cancellation preserves history

A cancelled meeting MUST preserve sufficient information to show that it was scheduled and later cancelled.

---

## 6.6 Allowed Baseline Transitions

The baseline allowed transitions are:

```text
DRAFT      → SCHEDULED
DRAFT      → CANCELLED
DRAFT      → ENDED        # historical/import flow when permitted

SCHEDULED  → IN_PROGRESS
SCHEDULED  → CANCELLED

IN_PROGRESS → ENDED
```

Any additional transition MUST be explicitly approved in this document or in a future version of the business rules.

### BR-MTG-LC-017 — Invalid transitions must be rejected

A client or service request that attempts an invalid meeting-state transition MUST be rejected rather than silently coerced into another state.

---

# 7. Meeting Scheduling and Calendar Rules

### BR-SCH-001 — Time is represented as a real interval

A scheduled meeting occupies the interval from its scheduled start time up to, but not including, its scheduled end time for conflict calculations.

This means two meetings MAY be adjacent where one ends exactly when another begins.

### BR-SCH-002 — Room conflict is a hard conflict

Two active scheduled/in-progress meetings MUST NOT reserve the same physical room for overlapping time intervals.

### BR-SCH-003 — Participant conflict is not a hard scheduling blocker by default

A participant being invited to overlapping meetings SHOULD produce a warning or visibility signal but MUST NOT automatically prevent meeting creation unless a later approved policy requires it.

### BR-SCH-004 — Cancellation removes scheduling conflict contribution

A cancelled meeting MUST NOT continue to block room availability.

### BR-SCH-005 — Draft meetings do not block availability

A draft meeting MUST NOT block physical-room availability.

### BR-SCH-006 — Schedule change requires conflict revalidation

If a scheduled meeting's time or room changes, room conflict validation MUST be performed against the new interval/resource.

### BR-SCH-007 — Calendar views are projections of canonical meeting data

Calendar views MUST NOT maintain an independent meeting status or schedule truth separate from the meeting record.

### BR-SCH-008 — Time-zone presentation must not change the instant

Different clients MAY display meeting times in different configured time zones, but the represented meeting occurrence MUST refer to the same absolute scheduled instant.

Exact storage format is defined in `DATABASE.md`.

---

# 8. Meeting Room Rules

### BR-ROOM-001 — Room identity is stable

A physical meeting room MUST have a stable identity independent of its display name.

### BR-ROOM-002 — Inactive room cannot be newly reserved

A room marked inactive/unavailable MUST NOT be assigned to a new scheduled meeting.

### BR-ROOM-003 — Historical room references are preserved

Deactivating a room MUST NOT remove its association from historical meetings.

### BR-ROOM-004 — Referenced rooms should be deactivated, not destructively removed

A room referenced by historical meeting records SHOULD NOT be hard-deleted through ordinary room-management operations.

### BR-ROOM-005 — Room capacity is an advisory or enforced rule only when configured

If room capacity is configured as an enforced organizational policy, participant count MUST NOT exceed the approved capacity.

If capacity enforcement is not enabled, room capacity MAY be shown as guidance without blocking scheduling.

### BR-ROOM-006 — Room conflict resolution must be atomic at business level

Concurrent requests that attempt to reserve the same room for overlapping intervals MUST NOT both succeed.

At most one conflicting reservation MAY become authoritative.

---

# 9. Meeting Participant Rules

### BR-PART-001 — Organizer is associated with the meeting

The Meeting Organizer MUST be associated with the meeting and MUST retain organizer access even if the participant-list UI represents organizers separately.

### BR-PART-002 — Participant must be an eligible organizational identity

An internal participant MUST reference a valid organizational user.

External/anonymous participants are not part of the baseline unless explicitly introduced in a future requirement.

### BR-PART-003 — Participant relationship is historical

Removing a participant before a meeting occurs MAY remove future access according to policy.

After a meeting has ended, changes to participant records MUST NOT falsify historical attendance/association when that history has already been established.

### BR-PART-004 — Participant removal affects future authorization

When a user is legitimately removed from a meeting before protected content becomes available, future content access MUST be recalculated according to the approved authorization model.

### BR-PART-005 — Past access does not guarantee permanent future access

A user who once had access to a meeting does not automatically retain access forever if organizational policy or explicit access changes revoke that permission.

### BR-PART-006 — Content access must be evaluated when content is requested

Meeting-content authorization MUST be evaluated against current business/security rules when protected content is requested.

A stale client state MUST NOT be treated as proof of continued authorization.

### BR-PART-007 — Invitation email is not the source of participation truth

Email delivery or non-delivery MUST NOT determine whether a user is officially associated with a meeting.

The meeting participant record is authoritative.

### BR-PART-008 — RSVP workflow is not a baseline business dependency

The baseline system MAY schedule meetings and associate participants without requiring a calendar-style RSVP acceptance workflow.

If RSVP is later introduced, it MUST use explicit participant-response states rather than redefining participant association.

---

# 10. Meeting Recording and Imported Media Rules

### BR-MEDIA-001 — Imported audio and completed recording share the same post-recording processing class

Once a recording has finished and been submitted to the backend, it MUST be eligible for the same offline processing pipeline as imported audio, subject to validation.

### BR-MEDIA-002 — Source media belongs to a meeting record

A source audio/video asset accepted for meeting processing MUST be associated with a meeting record or a controlled meeting-import flow that creates one.

### BR-MEDIA-003 — Original source must remain recoverable

The original accepted source media MUST be retained according to the configured retention policy for as long as it is required to support reprocessing, investigation, or approved export behavior.

### BR-MEDIA-004 — Derived normalized audio is not the sole source of truth

A normalized processing representation MUST NOT replace the original accepted source asset as the only recoverable source.

### BR-MEDIA-005 — Re-upload must not silently overwrite provenance

Uploading a replacement or alternate source for the same meeting MUST NOT silently destroy the provenance of an earlier processed source when that earlier source is required for traceability.

### BR-MEDIA-006 — Unsupported or invalid media must fail explicitly

Media that cannot be validated, decoded, or accepted under current feature/security constraints MUST produce an explicit failure instead of entering AI processing as though valid.

### BR-MEDIA-007 — Recording must not start invisibly

A client recording flow MUST require an explicit user action or approved meeting-recording action before microphone capture begins.

Legal/organizational consent requirements are deployment policy and MUST be respected where applicable.

### BR-MEDIA-008 — Recording stop does not mean transcript exists

Stopping a recording only makes the recorded media available for submission/processing.

It MUST NOT be represented as completed transcription.

---

# 11. Offline Transcription and Speech-Coverage Rules

These rules are core product invariants for the committed offline/post-recording ASR pipeline.

## 11.1 Source and Coverage

### BR-ASR-001 — Raw audio is authoritative source data

The accepted source audio is the authoritative source from which transcript data is derived.

### BR-ASR-002 — Model response is not equivalent to successful coverage

A successful response from Whisper or another ASR provider MUST NOT, by itself, mark an audio region as successfully processed.

### BR-ASR-003 — Speech coverage is validated independently

The pipeline MUST maintain an independent mechanism for determining where speech exists and whether that speech is represented in transcript output.

### BR-ASR-004 — Detected speech cannot be silently skipped

Every detected speech region that falls within the accepted processing scope MUST eventually resolve to an explicit result such as:

- covered;
- suspicious / needs review;
- unresolved after bounded recovery;
- failed with explicit error.

It MUST NOT disappear silently.

### BR-ASR-005 — Hallucination tolerance does not imply coverage tolerance

The system MAY temporarily retain suspicious or hallucinatory text for evaluation, but a hallucination MUST NOT be allowed to hide or invalidate a later real-speech region without detection.

### BR-ASR-006 — Localized failure must remain localized

Failure, hallucination, timeout, or malformed output for one bounded audio region MUST NOT prevent later independent audio regions from being processed.

### BR-ASR-007 — Recovery must be bounded

Automatic recovery/retry MUST have a finite policy.

If recovery is exhausted, the affected region MUST enter an explicit unresolved/error state.

### BR-ASR-008 — Recovery may alter processing context

When retrying a suspicious/uncovered region, the system MAY change segmentation, boundaries, overlap, provider parameters, or another approved processing context instead of repeating the identical failed request.

Exact retry strategy is an AI-architecture concern.

### BR-ASR-009 — Boundary processing must not knowingly discard words

The processing strategy MUST account for speech that crosses chunk boundaries so that segmentation does not knowingly cause content loss.

### BR-ASR-010 — Coverage must be evaluated on timeline semantics

Transcript completeness MUST be evaluated against time-aligned speech evidence, not only by comparing text length or checking whether a non-empty string was returned.

### BR-ASR-011 — Processing failure state must be visible to downstream logic

Downstream summary, decision, action-item, and knowledge-indexing logic MUST be able to determine whether the transcript is fully covered, contains warnings, or has unresolved regions.

### BR-ASR-012 — Offline pipeline quality takes priority over low latency

For committed offline/post-recording transcription, correctness, recoverability, and coverage MAY take precedence over minimal processing latency.

### BR-ASR-013 — Near-real-time rules are not inferred from offline rules

The offline pipeline MUST NOT be treated as a complete specification for near-real-time transcription.

Near-real-time behavior remains a separate late-phase capability until explicitly specified.

---

## 11.2 Suspicious and Unresolved Speech

### BR-ASR-014 — Suspicion is evidence-based

A region SHOULD be marked suspicious based on multiple relevant signals rather than a single hard-coded phrase blacklist.

### BR-ASR-015 — Known hallucination phrases are signals, not absolute truth

A phrase associated with common ASR hallucinations MUST NOT be deleted solely because the phrase matches a blacklist or heuristic.

### BR-ASR-016 — Unresolved speech must remain traceable

An unresolved speech region MUST retain enough timeline/source information to allow later review or reprocessing.

### BR-ASR-017 — Unresolved speech prevents false completeness

A transcript containing unresolved detected speech MUST NOT be represented as fully complete without an explicit warning/quality state.

### BR-ASR-018 — Regression failures become retained quality cases

A real audio sample that exposes a serious transcription failure SHOULD be retained, where legally and operationally permitted, as a regression test or reproducible test fixture.

The known silence → hallucination → missing-following-speech scenario is a mandatory regression behavior for the offline pipeline.

---

# 12. Transcript Rules

## 12.1 Transcript Provenance

### BR-TRN-001 — Raw ASR transcript text is transient processing data

Raw Whisper/ASR transcript text MAY exist transiently inside the active AI processing job for coverage validation, recovery, reconciliation, and contextual correction, but it MUST NOT be durably retained in PostgreSQL, Qdrant, object storage, routine logs, or another persisted transcript/debug representation.

The system SHALL retain the original source audio and sufficient non-text processing provenance so the transcript can be investigated or regenerated without depending on persisted raw Whisper text.

### BR-TRN-001A — LLM-corrected text is the initial persisted machine transcript

After ASR reconciliation and successful contextual correction, the LLM-corrected transcript SHALL become the initial persisted/current machine transcript used by normal user-facing and downstream behavior.

### BR-TRN-002 — Final transcript is time-aligned

The final transcript MUST preserve timeline information sufficient to associate transcript segments with source audio regions.

### BR-TRN-003 — Transcript belongs to its source meeting

A transcript MUST be associated with exactly one meeting context for authorization and historical retrieval purposes.

### BR-TRN-004 — Transcript provenance is retained

The system SHOULD retain sufficient provenance to determine which processing run, source media, recovery path, LLM model/configuration, and correction prompt version produced a transcript segment when required for debugging or trust. Persisting the raw Whisper text itself is not required and is prohibited by `BR-TRN-001` as a separate canonical transcript representation.

### BR-TRN-005 — Transcript editing does not rewrite source media

Correcting transcript text MUST NOT alter the underlying audio source.

### BR-TRN-006 — Transcript correction must be attributable

Material human corrections to transcript content SHOULD be attributable to the user and time of correction.

### BR-TRN-007 — Correction permission is limited

Only the Meeting Organizer or another user with explicit meeting-content edit authority MAY directly correct transcript text or speaker mapping.

Ordinary read access MUST NOT imply transcript-edit permission.

### BR-TRN-008 — Human-corrected text takes precedence for user-facing finalized content

The LLM-corrected transcript is the baseline machine transcript. When an authorized human correction exists, downstream user-facing finalized transcript views and future derived processing SHOULD use the human-corrected value while retaining revision and processing provenance.

### BR-TRN-009 — Suspicious text must remain distinguishable

A transcript segment marked suspicious or low-confidence MUST remain distinguishable from accepted/finalized transcript content until resolved or explicitly accepted.

### BR-TRN-010 — Transcript completion is not summary completion

A finalized transcript does not automatically imply that summary, decisions, action items, or RAG indexing are complete.

### BR-TRN-011 — Automatic contextual correction uses meeting-wide context

For meetings within the supported transcript/context limit, automatic LLM transcript correction MUST receive the complete reconciled meeting transcript candidate in chronological order rather than correcting isolated sentences independently.

The correction contract SHALL preserve transcript timing/segment identity and SHALL correct text without intentionally summarizing, omitting, or inventing meeting content.

If the complete transcript cannot be processed under the configured model/provider limit, the system MUST use an explicitly approved overflow strategy or fail/retry the correction stage; it MUST NOT silently degrade to context-free per-sentence correction.

### BR-TRN-012 — Raw Whisper text is not fallback transcript authority

If the contextual LLM correction stage fails, raw Whisper/ASR text MUST NOT be promoted to the persisted/current transcript merely to report successful completion.

---

# 13. Speaker Diarization and Speaker Mapping Rules

### BR-DIAR-001 — Speaker diarization is derived data

Diarization labels are AI-derived and MUST NOT be treated as verified human identity by default.

### BR-DIAR-002 — Anonymous speaker labels are allowed

The system MAY represent diarized speakers using labels such as `Speaker 1`, `Speaker 2`, and similar identifiers when identity is unknown.

### BR-DIAR-003 — Speaker identity mapping requires authorized confirmation

Mapping an anonymous speaker label to a known organizational user MUST require an authorized action or approved identity-resolution process.

### BR-DIAR-004 — Speaker correction preserves transcript text unless text is separately corrected

Changing a speaker mapping MUST NOT silently change the spoken text of the associated segments.

### BR-DIAR-005 — One person may own multiple diarization clusters before reconciliation

The system MAY temporarily contain multiple diarization labels that later map to the same real person.

### BR-DIAR-006 — One diarization label must not silently map to different people in the same finalized context

A finalized speaker label mapping within a meeting MUST be internally consistent unless the system explicitly supports time-bounded remapping.

### BR-DIAR-007 — Diarization failure must not erase transcript text

Failure to identify speakers MUST NOT cause otherwise valid transcript text to be discarded.

The system MAY present transcript text with unknown speaker labels.

---

# 14. Summary Rules

### BR-SUM-001 — Summary is derived from meeting evidence

An AI-generated meeting summary MUST be derived from authorized meeting content, primarily the processed transcript and approved contextual metadata.

### BR-SUM-002 — Summary does not replace transcript

A summary MUST NOT be treated as the authoritative replacement for the underlying transcript/source evidence.

### BR-SUM-003 — Summary quality follows transcript quality

If the transcript contains unresolved or suspicious regions that could materially affect the summary, the system MUST be able to represent the summary as incomplete, provisional, or generated-with-warning.

### BR-SUM-004 — Human-edited summary is distinguishable from raw AI generation

If authorized users edit an AI-generated summary, the system SHOULD preserve enough state/provenance to distinguish edited content from the original generation.

### BR-SUM-005 — Regeneration must not silently overwrite reviewed content

Regenerating an AI summary MUST NOT silently replace a human-reviewed or human-edited summary without explicit user intent.

### BR-SUM-006 — Summary access follows meeting-content access

A user without permission to read the protected meeting content MUST NOT gain the meeting summary as an indirect disclosure.

---

# 15. Decision Extraction Rules

Canonical decision states:

```text
PROPOSED
CONFIRMED
REJECTED
```

### BR-DEC-001 — AI-extracted decisions start as proposed

A decision extracted automatically by AI MUST initially be treated as `PROPOSED` rather than as an official confirmed business decision.

### BR-DEC-002 — Confirmation requires authorized human action

Only the Meeting Organizer or another user with explicit decision-confirmation authority MAY transition an AI-proposed decision to `CONFIRMED`.

### BR-DEC-003 — Rejection preserves provenance where required

Rejecting an AI-proposed decision SHOULD preserve enough provenance to understand that the extraction occurred and was rejected, when required for quality/audit purposes.

### BR-DEC-004 — User-created confirmed decision is allowed

An authorized user MAY create a confirmed meeting decision directly without AI extraction.

### BR-DEC-005 — Confirmed decision must remain tied to meeting context

A confirmed decision MUST remain associated with the meeting from which it originates.

### BR-DEC-006 — Suspicious transcript evidence cannot silently become a confirmed decision

AI MUST NOT automatically convert content from unresolved or suspicious transcript regions into an official confirmed decision.

### BR-DEC-007 — Decision edits are controlled

Material edits to a confirmed decision MUST be restricted to authorized users and SHOULD preserve meaningful change history.

### BR-DEC-008 — Decision access follows meeting-content access

Meeting decisions MUST NOT reveal protected meeting content to unauthorized users.

---

# 16. Action Item Rules

Canonical action-item states:

```text
PROPOSED
OPEN
IN_PROGRESS
DONE
CANCELLED
```

`OVERDUE` is a derived condition, not a canonical workflow state.

## 16.1 Creation and Confirmation

### BR-ACT-001 — AI-extracted action items start as proposed

An action item extracted automatically by AI MUST start in `PROPOSED` state.

### BR-ACT-002 — Proposed action item is not yet an official obligation

A `PROPOSED` AI action item MUST NOT be treated as a confirmed assignment until an authorized human confirms it.

### BR-ACT-003 — Authorized user may create an action item directly

An authorized user MAY create an action item directly as `OPEN` without AI extraction.

### BR-ACT-004 — Confirming proposed item creates official follow-up work

Transitioning an AI-proposed action item to `OPEN` represents human acceptance that the item is legitimate follow-up work.

### BR-ACT-005 — Confirmed/open action item requires one primary assignee

An action item in `OPEN` or `IN_PROGRESS` MUST have exactly one primary responsible assignee.

Future collaboration features MAY introduce contributors without changing the primary responsibility rule.

### BR-ACT-006 — Proposed item may be temporarily unassigned

An AI-proposed action item MAY remain without an assignee when extraction cannot confidently determine responsibility.

It MUST NOT become `OPEN` until required ownership is valid.

### BR-ACT-007 — Due date is optional unless the business context requires it

An action item MAY exist without a due date.

If a due date is present, it MUST be a valid date/time according to feature semantics.

---

## 16.2 Action Item Lifecycle

### BR-ACT-008 — Allowed baseline transitions

The baseline allowed transitions are:

```text
PROPOSED   → OPEN
PROPOSED   → CANCELLED

OPEN       → IN_PROGRESS
OPEN       → DONE
OPEN       → CANCELLED

IN_PROGRESS → DONE
IN_PROGRESS → CANCELLED

DONE       → OPEN          # reopen by authorized user
```

### BR-ACT-009 — Invalid transitions are rejected

A client or service MUST NOT silently coerce an invalid action-item transition into another state.

### BR-ACT-010 — Overdue is computed

An action item is considered overdue when:

- it has a due date;
- the due date has passed;
- its canonical state is not `DONE` or `CANCELLED`.

The system SHOULD compute overdue status from authoritative time and state rather than use `OVERDUE` as an independently editable workflow state.

### BR-ACT-011 — Completion is attributable

When an action item is marked `DONE`, the system SHOULD retain who performed the transition and when.

### BR-ACT-012 — Cancellation is not deletion

Cancelling an action item MUST preserve its historical relationship to the meeting.

### BR-ACT-013 — Reassignment is controlled

Changing the primary assignee of an `OPEN` or `IN_PROGRESS` action item MUST be performed by an authorized user and SHOULD be historically attributable.

### BR-ACT-014 — Assignee deactivation does not delete the action item

If an assignee becomes inactive, the action item MUST remain in the system and SHOULD require reassignment or explicit resolution according to management policy.

### BR-ACT-015 — Action-item visibility follows both meeting and assignment context

An assignee MAY be allowed to view the action item needed to perform assigned work, but access to broader protected meeting content MUST still follow meeting-content authorization rules.

### BR-ACT-016 — Suspicious transcript evidence cannot become official work automatically

AI MUST NOT automatically convert an unresolved/suspicious transcript segment into an official `OPEN` action item without authorized human confirmation.

---

# 17. AI-Derived Content General Rules

### BR-AI-001 — AI output is never inherently authoritative

AI-generated transcript interpretations, summaries, decisions, action items, speaker identities, and assistant answers MUST be treated as derived output rather than unquestionable business truth.

### BR-AI-002 — Human confirmation overrides AI proposal

When the product supports explicit human confirmation/correction, the confirmed human value takes precedence for finalized user-facing behavior while raw AI provenance is retained where appropriate.

### BR-AI-003 — AI output must not invent state changes

An AI model MUST NOT directly perform authoritative business-state transitions solely because generated text suggests that a transition should occur.

For example, an LLM extraction MUST NOT directly mark an action item `DONE` or a decision `CONFIRMED` without an approved product action.

### BR-AI-004 — AI regeneration is controlled

Regeneration of derived AI artifacts MUST NOT silently discard human-reviewed edits or confirmations.

### BR-AI-005 — Failed AI processing does not rewrite meeting occurrence

AI failure MUST NOT change an `ENDED` meeting back into an execution state or make the historical meeting appear not to have occurred.

### BR-AI-006 — AI processing may be retried without duplicating business entities

Reprocessing the same source SHOULD NOT create duplicate official decisions, action items, or final transcript records without reconciliation or explicit versioning behavior.

### BR-AI-007 — AI provider success is not business success

A successful external AI API response MUST still be validated against the relevant product rules before its output becomes finalized product data.

---

# 18. AI Processing Lifecycle Rules

AI processing status is separate from meeting lifecycle.

A processing job or stage MAY use states such as:

```text
QUEUED
PROCESSING
COMPLETED
COMPLETED_WITH_WARNINGS
FAILED
```

Detailed persistence is defined in `DATABASE.md` and detailed workflow in `FEATURES.md` / `ARCHITECTURE.md`.

### BR-AIP-001 — Processing starts only from accepted source data

AI processing MUST NOT start on a source media asset that has failed required media validation.

### BR-AIP-002 — Processing completion requires stage-specific success

A processing job MUST NOT be marked `COMPLETED` merely because all external requests returned transport-level success.

### BR-AIP-003 — Partial warnings remain visible

If required output is produced but known unresolved/suspicious conditions remain, the result SHOULD use a warning/incomplete quality state rather than unconditional success.

### BR-AIP-004 — Failure of optional downstream stage need not destroy upstream outputs

If summary generation fails after a valid transcript was produced, the transcript MUST remain available according to permissions.

Likewise, failure of decision extraction, action-item extraction, or RAG indexing MUST NOT erase a valid transcript.

### BR-AIP-005 — Stage dependencies are respected

A downstream stage MUST NOT be treated as finalized when its required upstream evidence is unavailable or invalid.

### BR-AIP-006 — Retrying downstream AI does not require rerunning unrelated stages

Where technically possible, a failed downstream stage MAY be retried independently if its required upstream artifacts remain valid.

### BR-AIP-007 — Reprocessing must preserve provenance

When a source is reprocessed, the system SHOULD retain enough run/version provenance to determine which output is currently authoritative and which output came from earlier runs.

---

# 19. Search and Historical Retrieval Rules

### BR-SEARCH-001 — Search never expands authorization

Finding a result through search MUST NOT grant access to content that the user is otherwise unauthorized to read.

### BR-SEARCH-002 — Search result detail is permission-aware

Search MAY return limited metadata for an accessible resource, but it MUST NOT expose protected transcript/audio/summary content beyond the user's permission scope.

### BR-SEARCH-003 — Historical state remains distinguishable

Cancelled, ended, archived, and processing-failed meetings SHOULD be distinguishable in historical search/filtering where relevant.

### BR-SEARCH-004 — Search does not become a parallel source of truth

Search indexes are derived projections and MUST NOT override canonical meeting/business data.

---

# 20. AI Assistant / RAG Rules

### BR-RAG-001 — Retrieval authorization is mandatory

The AI Assistant MUST retrieve only from meeting knowledge the requesting user is authorized to access.

### BR-RAG-002 — Authorization applies before answer generation

Unauthorized chunks/documents MUST NOT be supplied to the answer-generation model with the expectation that the model will hide them afterward.

Access filtering MUST occur before or during retrieval at a trusted system boundary.

### BR-RAG-003 — Conversation history does not expand authorization

A previous AI Assistant conversation MUST NOT grant access to meeting content that the user can no longer access.

### BR-RAG-004 — RAG response is derived, not official record

An AI Assistant answer MUST NOT automatically become an official meeting decision, transcript correction, or action item.

### BR-RAG-005 — Lack of evidence must not be hidden by fabrication

When authorized meeting evidence is insufficient to answer a question, the assistant SHOULD explicitly indicate insufficient evidence rather than fabricate a meeting fact.

### BR-RAG-006 — Answers should be traceable to meeting evidence

When supported by the implementation, an answer SHOULD provide meeting/source references sufficient for a user to inspect the basis of the answer.

### BR-RAG-007 — Suspicious/unreviewed transcript content has reduced authority

Transcript segments marked unresolved, suspicious, or not accepted SHOULD NOT be indexed as fully trusted meeting knowledge.

If such content is used, the resulting answer MUST preserve an appropriate uncertainty signal.

### BR-RAG-008 — Human corrections supersede stale indexed text

When finalized transcript content changes, search/RAG indexes SHOULD be updated so that stale pre-correction text does not remain the preferred authoritative representation.

### BR-RAG-009 — Deleted or access-revoked meeting content must become unavailable

When business/security policy removes a user's access to a meeting, future AI Assistant retrieval for that user MUST exclude that meeting even if embeddings or cached retrieval artifacts still physically exist.

### BR-RAG-010 — Global model knowledge must not masquerade as meeting evidence

When the AI Assistant is answering a meeting-specific factual question, general model knowledge MUST NOT be presented as though it came from the organization's meeting records.

---

# 21. Transactional Email and Notification Rules

### BR-NOTIF-001 — Business state is authoritative over email delivery

Email delivery MUST NOT be the source of truth for whether a business operation occurred.

For example, a meeting is cancelled when the canonical meeting state changes, not when Gmail SMTP confirms delivery.

### BR-NOTIF-002 — Email failure must not normally roll back committed core state

Failure to send a transactional email SHOULD NOT roll back an already committed valid meeting, action-item, or account-state change unless a specific feature explicitly requires atomic delivery.

### BR-NOTIF-003 — Notification intent is created from business events

Notifications SHOULD be triggered by authoritative business events such as:

- meeting scheduled;
- material meeting change;
- meeting cancelled;
- action item assigned;
- password recovery requested;
- other approved events.

### BR-NOTIF-004 — Duplicate delivery should be avoided

Retries of the same notification intent SHOULD NOT intentionally produce uncontrolled duplicate emails.

### BR-NOTIF-005 — Notification content respects authorization

An email MUST NOT include meeting-sensitive content that the recipient is not authorized to access.

### BR-NOTIF-006 — Optional notification preferences do not suppress mandatory security communication

User preferences MAY disable optional product notifications where supported, but they MUST NOT suppress mandatory security/account communications required for safe account operation.

### BR-NOTIF-007 — Email address destination must use current approved identity data

Transactional emails SHOULD be sent to the current approved address for the intended organizational account, subject to security rules.

### BR-NOTIF-008 — SMTP outage is an operational failure, not a meeting-state failure

Temporary Gmail SMTP unavailability MUST be represented as notification-delivery failure/retry state and MUST NOT corrupt meeting lifecycle state.

---

# 22. Dashboard and Metrics Rules

### BR-DASH-001 — Dashboard metrics are derived from canonical state

Dashboard counts and summaries MUST be computed from canonical business data or approved projections of that data.

A dashboard MUST NOT maintain independent authoritative meeting or action-item state.

### BR-DASH-002 — Dashboard visibility follows authorization scope

Users MUST see dashboard metrics only for the organizational/meeting/action-item scope they are authorized to view.

### BR-DASH-003 — Overdue action metrics follow the canonical overdue rule

Any dashboard count of overdue action items MUST use the same overdue definition as `BR-ACT-010`.

### BR-DASH-004 — Processing failure metrics distinguish meeting completion

AI-processing failure metrics MUST NOT imply that the corresponding meeting did not occur.

### BR-DASH-005 — Derived percentages must use a documented denominator

Any completion rate, participation rate, action-item rate, or similar percentage introduced into the product MUST define its numerator and denominator consistently in detailed feature requirements.

---

# 23. Archival, Retention, and Deletion Business Rules

Detailed retention duration and deletion security controls are defined in `SECURITY.md` and deployment policy.

### BR-RET-001 — Archive is different from cancel

Archiving a meeting MUST NOT change whether the meeting occurred or was cancelled.

Archive status is a visibility/retention concern, not an execution-state transition.

### BR-RET-002 — Archive is different from delete

Archived content remains part of retained history and MUST NOT be treated as permanently deleted.

### BR-RET-003 — Hard deletion is controlled

Hard deletion of ended meeting source media, transcript, decisions, or other protected historical records MUST occur only through an approved retention/privacy/administrative process.

### BR-RET-004 — Deleting a derived artifact must not automatically delete source media

Removing/regenerating a summary or other derived AI artifact MUST NOT automatically delete the underlying meeting audio or transcript unless a separate retention operation requires it.

### BR-RET-005 — Source deletion constrains regeneration

If retention policy permanently deletes the original source media, the system MUST NOT claim that future full reprocessing remains possible from that source.

### BR-RET-006 — Retention operations preserve referential consistency

A retention/deletion operation MUST NOT leave business entities in an invalid state with broken required ownership or historical references.

---

# 24. Concurrency and Consistency Rules

### BR-CON-001 — Concurrent edits must not silently corrupt authoritative state

When two operations conflict on authoritative business state, the system MUST resolve or reject the conflict rather than silently lose a valid update.

Exact concurrency-control implementation is defined in architecture/database/API requirements.

### BR-CON-002 — Room booking is conflict-safe under concurrency

Concurrent room reservations MUST uphold `BR-ROOM-006` even when requests are processed by different server instances.

### BR-CON-003 — Business-state transition is atomic

A canonical state transition such as meeting cancellation, action-item completion, or decision confirmation MUST be committed as one authoritative state change rather than partially applied across multiple conflicting states.

### BR-CON-004 — Retry must not create duplicate official entities

Retrying an operation after a timeout or transient failure SHOULD NOT create duplicate meetings, duplicate official action items, duplicate confirmed decisions, or duplicate notification intents when the original operation already succeeded.

Detailed idempotency contracts are defined in `API.md` / `ARCHITECTURE.md`.

---

# 25. Business Authorization Baseline

This section defines product-level authorization expectations. Detailed technical enforcement belongs to `SECURITY.md`.

Legend:

- **Yes** — baseline business capability.
- **Scoped** — allowed only within approved organizational/meeting scope.
- **No by default** — not granted solely by this role; may require explicit content permission or meeting relationship.

| Capability | Employee | Department Manager | Administrator |
|---|---:|---:|---:|
| Sign in with active account | Yes | Yes | Yes |
| View own permitted meetings | Yes | Yes | Yes |
| Create a meeting | Yes | Yes | Yes |
| Edit own organized meeting | Yes | Yes | Yes |
| Edit another user's meeting | No by default | Scoped | Scoped/admin policy |
| Manage room catalog | No by default | Scoped if granted | Yes/Scoped |
| Manage organization users | No | Scoped | Yes/Scoped |
| Assign system roles | No | No by default | Yes/Scoped |
| View protected meeting content | By meeting access | By meeting access / approved scope | No by default solely because admin |
| Correct transcript | Organizer/explicit editor | Scoped/explicit editor | Explicit content authority required |
| Confirm AI decisions | Organizer/explicit authority | Scoped | Explicit authority required |
| Confirm AI action items | Organizer/explicit authority | Scoped | Explicit authority required |
| View own assigned action items | Yes | Yes | Yes |
| View team/department action items | No by default | Scoped | Scoped |
| Use AI Assistant | Within authorized knowledge scope | Within authorized knowledge scope | Within authorized knowledge scope |
| Access operational administration | No | Limited | Yes/Scoped |

### BR-AUTHZ-001 — Business capability and content access are separate

The ability to administer a resource category MUST NOT automatically imply access to all sensitive content inside every resource.

### BR-AUTHZ-002 — Organizer has management authority over own meeting subject to global policy

The Meeting Organizer MAY manage the meeting, participants, meeting content review, and post-meeting confirmation actions within the approved feature/security limits.

### BR-AUTHZ-003 — Participant read access is not edit access

A Meeting Participant MAY receive read access to permitted meeting content, but participation alone MUST NOT grant permission to edit transcript, confirm decisions, or change other users' action items.

### BR-AUTHZ-004 — Assignee authority is action-item specific

Being assigned an action item MAY allow the assignee to update that item's execution status according to feature rules, but it MUST NOT grant general meeting-management authority.

### BR-AUTHZ-005 — Authorization failure does not reveal protected data

When access is denied, the system MUST NOT return protected business content merely to explain why access was denied.

---

# 26. Validation Rules Shared Across Features

### BR-VAL-001 — Required business identifiers must reference existing valid entities

A business operation that references users, meetings, rooms, action items, or other entities MUST reject invalid references rather than silently create unrelated placeholders.

### BR-VAL-002 — User-provided text is not trusted as structured authority

Free-form meeting text, transcript content, prompts, summaries, and AI output MUST NOT directly control privileged business behavior without validated parsing/authorization.

### BR-VAL-003 — Server-side/business-layer validation is authoritative

Client-side validation MAY improve UX but MUST NOT be the only enforcement of business rules.

### BR-VAL-004 — Unknown enum/state values must not be silently interpreted

An unknown meeting state, action-item state, processing state, or other canonical status MUST be rejected or handled explicitly rather than guessed.

### BR-VAL-005 — Invalid timestamps must be rejected

Invalid or impossible schedule intervals, malformed historical times, and inconsistent ordering required by business semantics MUST be rejected or explicitly corrected before becoming authoritative.

---

# 27. Export and Meeting Minutes Rules

### BR-EXP-001 — Export respects current authorization

A user MAY export meeting information only if the user is authorized to access the exported content.

### BR-EXP-002 — Export is a representation, not a separate source of truth

Markdown, PDF, or other meeting-minute exports are derived representations of canonical meeting data.

Editing an exported file outside the system MUST NOT automatically modify canonical meeting data.

### BR-EXP-003 — Export must preserve uncertainty where material

If the exported content includes unresolved/suspicious transcript-derived information that materially affects interpretation, the export SHOULD indicate that the relevant content is incomplete or unverified.

### BR-EXP-004 — Confirmed and proposed content must not be confused

If proposed AI decisions/action items are included in an export, they MUST remain distinguishable from confirmed decisions/action items.

---

# 28. Near-Real-Time Transcription Business Boundary

### BR-NRT-001 — Near-real-time transcription is not required for initial ASR acceptance

The initial production-oriented baseline MAY be considered complete without near-real-time transcription if the committed offline/post-recording pipeline satisfies approved requirements.

### BR-NRT-002 — Future near-real-time output is preliminary unless finalized

When near-real-time transcription is introduced, partial/live transcript output SHOULD be treated as preliminary until reconciled/finalized against the completed audio pipeline or another approved finalization mechanism.

### BR-NRT-003 — Live preview must not replace final source-backed transcript by default

A live partial transcript MUST NOT automatically become the authoritative final transcript if a higher-quality final processing stage is configured.

### BR-NRT-004 — Near-real-time feature must preserve offline reliability invariants

Future near-real-time implementation MUST NOT weaken the core product guarantees around source retention, explicit failure, authorization, and final transcript integrity.

---

# 29. Rule Traceability by Domain

The following mapping is intended to help other requirement documents reference the canonical business-rule families.

| Rule Prefix | Domain |
|---|---|
| `BR-GEN-*` | Cross-product invariants |
| `BR-ID-*` | User identity/account |
| `BR-ROLE-*` | Global roles |
| `BR-MTG-*` | Meeting core |
| `BR-MTG-LC-*` | Meeting lifecycle |
| `BR-SCH-*` | Scheduling/calendar |
| `BR-ROOM-*` | Meeting rooms |
| `BR-PART-*` | Participants |
| `BR-MEDIA-*` | Recording/imported media |
| `BR-ASR-*` | Offline transcription/coverage |
| `BR-TRN-*` | Transcript |
| `BR-DIAR-*` | Speaker diarization/mapping |
| `BR-SUM-*` | Summary |
| `BR-DEC-*` | Decisions |
| `BR-ACT-*` | Action items |
| `BR-AI-*` | General AI-derived content |
| `BR-AIP-*` | AI processing lifecycle |
| `BR-SEARCH-*` | Search |
| `BR-RAG-*` | AI Assistant/RAG |
| `BR-NOTIF-*` | Email/notifications |
| `BR-DASH-*` | Dashboard/metrics |
| `BR-RET-*` | Archive/retention/deletion |
| `BR-CON-*` | Concurrency/consistency |
| `BR-AUTHZ-*` | Business authorization |
| `BR-VAL-*` | Shared validation |
| `BR-EXP-*` | Export/minutes |
| `BR-NRT-*` | Future near-real-time boundary |

---

# 30. Relationship to Other Requirement Documents

## `PRODUCT.md`

Defines product vision, users, scope, major capabilities, and high-level product flows.

This file (`BUSINESS_RULES.md`) makes those product concepts behaviorally precise where a consistent rule is required.

## `FEATURES.md`

Defines detailed user-visible feature behavior, flows, preconditions, edge cases, and expected outcomes.

Feature requirements MUST reference applicable `BR-*` rules instead of redefining them.

## `ARCHITECTURE.md`

Defines system/service boundaries, processing topology, feature-first organization, and technical structural decisions.

Architecture MUST provide a design capable of enforcing the business rules in this file.

## `DATABASE.md`

Defines the data model needed to persist and enforce these rules.

Database constraints SHOULD enforce critical invariants where appropriate, but the database schema MUST NOT redefine business semantics differently.

## `API.md`

Defines API conventions and baseline endpoint surface.

API behavior MUST expose and preserve the business states defined here without inventing alternate state semantics.

## `SECURITY.md`

Defines technical authentication, session, authorization, data-protection, secrets, rate-limit, and security controls.

Security controls MUST enforce the content-access and authorization invariants defined here.

---

# 31. Explicitly Deferred / Non-Baseline Business Areas

The following areas are not required as baseline business behavior unless introduced by a later approved requirement:

- external anonymous meeting participants;
- public share links for meeting content;
- calendar-provider synchronization such as Google Calendar or Microsoft 365;
- mandatory RSVP workflow;
- recurring-meeting series semantics;
- multiple organizations sharing the same meeting;
- external customer/guest portals;
- automatic business-state changes performed solely by LLM reasoning;
- near-real-time transcript as the sole final transcript;
- unrestricted administrator access to all private meeting content.

Deferring these features does not prevent future implementation, but a future implementation MUST add explicit requirements rather than infer behavior ad hoc.

---

# 32. Business Rule Acceptance Principles

A feature is not business-rule compliant merely because its happy-path UI works.

The implementation MUST demonstrate, where applicable, that:

1. invalid state transitions are rejected;
2. unauthorized access is blocked consistently across direct and derived surfaces;
3. room conflicts cannot occur under concurrent requests;
4. cancelled records remain historically distinguishable;
5. AI output remains distinguishable from confirmed human-approved business data;
6. detected speech cannot be silently dropped by offline transcription;
7. downstream AI failure does not destroy successful upstream artifacts;
8. AI Assistant retrieval cannot bypass meeting authorization;
9. email-delivery failure does not corrupt committed meeting state;
10. retry and concurrency do not create uncontrolled duplicate official entities;
11. human corrections do not destroy raw source provenance;
12. derived dashboards/search/indexes do not become alternate sources of truth.

---

# 33. Final Business Principle

The SME Meeting Assistant System SHALL apply the following rule across all product areas:

> **Canonical business state must be explicit, protected, and traceable. AI may assist in creating derived knowledge, but no model response, client behavior, integration failure, or implementation shortcut may silently redefine what actually happened in the meeting or what the organization has officially accepted.**
