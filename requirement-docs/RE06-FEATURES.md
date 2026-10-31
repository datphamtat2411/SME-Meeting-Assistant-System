# SME Meeting Assistant System — Feature Requirements

**Document type:** Global Project Requirement  
**Authority:** Canonical functional behavior specification  
**Audience:** Product, Web, Mobile, Spring Boot API, AI Core, QA, DevOps, Security  
**Related documents:** `PRODUCT.md`, `BUSINESS_RULES.md`, `ARCHITECTURE.md`, `DATABASE.md`, `API.md`, `SECURITY.md`

---

## 1. Purpose of This Document

This document defines the **detailed functional behavior** of the SME Meeting Assistant System.

It answers the question:

> **What must users and system components be able to do, and what observable behavior must occur when they do it?**

This document is intentionally more detailed than `PRODUCT.md` and intentionally less implementation-specific than `ARCHITECTURE.md`, `DATABASE.md`, `API.md`, or package-level technical documentation.

The purpose of this document is to ensure that Web, Mobile, Core API, AI Core, QA, and future contributors implement the **same product behavior** rather than independently inventing different interpretations of the same feature.

The UI currently present in the repository is an important product reference, but it is **not the authority** for functional behavior. If the UI conflicts with approved requirements, the UI must be changed.

---

## 2. Functional Requirement Ownership

This file owns:

- detailed feature behavior;
- user-visible workflows;
- feature preconditions and outcomes;
- feature-level success and failure behavior;
- asynchronous processing visibility;
- editing and confirmation workflows;
- cross-feature functional expectations;
- baseline feature availability across Web and Mobile;
- feature-level edge cases;
- which feature outcomes are official versus proposed/derived;
- which capabilities are baseline, optional, or explicitly deferred.

This file does **not** own:

- canonical business invariants already defined in `BUSINESS_RULES.md`;
- endpoint paths or HTTP methods, which belong to `API.md`;
- request/response DTO schemas;
- persistence table/column definitions, which belong to `DATABASE.md`;
- token lifetime, cookie flags, password hashing, CSRF, CORS, and other security mechanisms, which belong to `SECURITY.md`;
- service topology, queues, worker models, storage technology, or package/file layout, which belong to `ARCHITECTURE.md`;
- model thresholds, VAD thresholds, chunk sizes, overlap duration, or retry parameters, which belong to AI architecture/package design and task specifications.

When a functional requirement depends on a canonical business rule, this document references the applicable `BR-*` rule rather than redefining it.

---

## 3. Normative Language

The key words **MUST**, **MUST NOT**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

- **MUST / SHALL** — mandatory baseline behavior.
- **MUST NOT / SHALL NOT** — prohibited baseline behavior.
- **SHOULD** — expected behavior unless a documented reason justifies otherwise.
- **SHOULD NOT** — normally prohibited unless a documented reason justifies otherwise.
- **MAY** — optional behavior that is allowed but not mandatory.

A developer or AI agent MUST NOT reinterpret `MAY` as mandatory or ignore a `MUST` because another implementation appears easier.

---

## 4. Requirement Identification and Traceability

Feature requirements use IDs in the form:

```text
FEAT-<DOMAIN>-<CAPABILITY>-<NUMBER>
```

Examples:

```text
FEAT-AUTH-LOGIN-001
FEAT-MTG-CREATE-001
FEAT-ASR-COVERAGE-003
FEAT-RAG-ASK-002
```

The IDs are stable references for:

- Task Specifications;
- QA test cases;
- implementation plans;
- API baseline mapping;
- database mapping;
- security mapping;
- future requirement changes.

Removing or materially redefining an existing feature requirement SHOULD be treated as a requirement change rather than a silent edit.

---

## 5. Feature-Wide Functional Principles

### FEAT-GEN-001 — Protected capabilities require authenticated product context

Protected product features MUST require an authenticated active organizational user unless a feature is explicitly public.

The current baseline does not define public meeting-content access.

Applicable rules: `BR-ID-003`, `BR-AUTHZ-005`.

### FEAT-GEN-002 — Server-side behavior is authoritative

Clients MAY perform validation and optimistic presentation for user experience, but authoritative acceptance or rejection MUST come from backend business behavior.

Applicable rules: `BR-VAL-003`.

### FEAT-GEN-003 — Cross-client semantic consistency

When Web and Mobile expose the same business capability, both clients MUST represent the same canonical states and outcomes.

A meeting MUST NOT be considered cancelled on one client and scheduled on another because each client implemented its own semantics.

Applicable rules: `BR-GEN-006`.

### FEAT-GEN-004 — Asynchronous work exposes state

A long-running operation MUST NOT appear complete while required backend or AI work is still in progress.

Where processing is asynchronous, the product SHALL expose an appropriate status such as pending, queued, processing, completed, completed with warnings, or failed.

Applicable rules: `BR-GEN-004`, `BR-AIP-002`, `BR-AIP-003`.

### FEAT-GEN-005 — Failures must be actionable

When a user-initiated operation fails, the user SHOULD receive enough information to understand whether the operation:

- was rejected before any authoritative change;
- succeeded but a secondary side effect failed;
- is still processing;
- partially succeeded;
- can be retried;
- requires administrator or support intervention.

Sensitive implementation information MUST NOT be exposed merely to make an error message more detailed.

### FEAT-GEN-006 — Retry must not imply duplicate business intent

When a client retries an operation because of timeout or temporary failure, product behavior SHOULD avoid creating duplicate official business entities where the original operation already succeeded.

Applicable rules: `BR-CON-004`.

### FEAT-GEN-007 — Derived AI content remains identifiable

Where product behavior exposes AI-derived content, the user interface MUST preserve the distinction between:

- raw/source-backed content;
- AI-generated proposals;
- human-confirmed or human-corrected content.

Applicable rules: `BR-GEN-005`, `BR-AI-001`, `BR-AI-002`.

### FEAT-GEN-008 — Current authorization is evaluated at access time

A user who previously had access MUST NOT be assumed to retain access forever.

Features that read protected meeting content SHALL evaluate current authorization when protected content is requested.

Applicable rules: `BR-PART-004`, `BR-PART-005`, `BR-PART-006`.

### FEAT-GEN-009 — Empty state is different from failed state

The product MUST distinguish between:

- no data exists;
- data exists but is not yet processed;
- processing failed;
- the user is not authorized;
- data was intentionally removed or archived where relevant.

### FEAT-GEN-010 — Historical attribution is preserved

When users, roles, assignments, speaker mappings, or other relationships change, historical meeting information SHOULD continue to identify the historically relevant actor or value where required by business rules.

Applicable rules: `BR-ID-004`, `BR-GEN-007`.

---

# 6. Authentication and Session Features

## 6.1 Sign-In

### FEAT-AUTH-LOGIN-001 — Organizational user sign-in

The system SHALL allow an active organizational user to authenticate using the approved login identifier and password.

The baseline login identifier is the user's organizational email address.

A successful sign-in SHALL establish an authenticated product session and make the current user's permitted capabilities available.

Applicable rules: `BR-ID-001`, `BR-ID-002`, `BR-ID-003`.

### FEAT-AUTH-LOGIN-002 — Invalid credentials

If credentials are invalid, sign-in SHALL fail without revealing whether the email address or password was the incorrect component.

The feature SHALL NOT create a partial authenticated session.

Detailed brute-force protection and rate-limiting requirements belong to `SECURITY.md`.

### FEAT-AUTH-LOGIN-003 — Restricted account behavior

A disabled, suspended, deactivated, or otherwise restricted account SHALL NOT establish a new authenticated session.

The user MAY receive a generic account-unavailable message appropriate to security policy.

Applicable rules: `BR-ID-003`.

### FEAT-AUTH-LOGIN-004 — Already-authenticated access

If a valid authenticated session already exists, the client SHOULD restore the user's authenticated context without requiring the user to manually sign in again until the session can no longer be renewed under security policy.

The exact access-token and refresh-token mechanics belong to `SECURITY.md`.

## 6.2 Session Continuity and Renewal

### FEAT-AUTH-SESSION-001 — Session continuity

The product SHALL support authenticated session continuity across normal navigation and page/application reloads according to the approved security model.

Web clients MUST NOT depend on localStorage or sessionStorage as the source of authentication tokens.

The exact browser credential transport is defined in `SECURITY.md`.

### FEAT-AUTH-SESSION-002 — Transparent session renewal

When an authenticated session can be renewed safely, the client and backend SHOULD renew it without forcing an unnecessary interactive sign-in.

A renewal failure SHALL eventually result in an unauthenticated state rather than an infinite retry loop.

### FEAT-AUTH-SESSION-003 — Renewal after account restriction

Session renewal SHALL fail if the account is no longer eligible to authenticate.

Applicable rules: `BR-ID-003`, `BR-ROLE-005`.

### FEAT-AUTH-SESSION-004 — Expired authentication state

When authentication expires and cannot be renewed, protected client surfaces SHALL stop presenting the session as authenticated and SHALL route the user to an appropriate authentication flow.

Unsaved local UI state MAY be preserved when safe and practical, but protected server data MUST NOT remain accessible solely because it was previously displayed.

## 6.3 Current User Context

### FEAT-AUTH-ME-001 — Current identity retrieval

An authenticated client SHALL be able to obtain the current user's identity and product-relevant account context.

The returned context SHOULD include enough information for clients to display profile identity, global role, account status, and authorized navigation without requiring clients to infer security policy themselves.

### FEAT-AUTH-ME-002 — Current permissions are not permanently cached as truth

Clients MAY cache presentation-level permission information for UX, but backend authorization remains authoritative.

Role or scope changes SHALL affect subsequent protected operations according to current authorization.

Applicable rules: `BR-ROLE-005`, `BR-AUTHZ-001`.

## 6.4 Sign-Out

### FEAT-AUTH-LOGOUT-001 — User sign-out

An authenticated user SHALL be able to sign out from the current session.

After sign-out completes, the client SHALL remove the authenticated application state and MUST NOT continue calling protected features as if the user remained authenticated.

### FEAT-AUTH-LOGOUT-002 — Sign-out failure handling

If the client cannot confirm server-side sign-out because of a temporary connectivity failure, the client SHOULD still stop presenting protected UI locally while reporting that server-side session invalidation may require retry.

Exact revocation semantics belong to `SECURITY.md`.

## 6.5 Password Recovery

### FEAT-AUTH-RECOVERY-001 — Request password recovery

The product SHALL support a password-recovery request using the account email address.

The feature SHALL produce a neutral user-facing response that does not expose whether an arbitrary address corresponds to an active account when security policy requires account-enumeration resistance.

### FEAT-AUTH-RECOVERY-002 — Recovery email

When the request corresponds to an eligible account, the backend SHALL create a password-recovery flow and request a transactional recovery email.

Email delivery SHALL be performed by the backend through the approved email infrastructure.

Applicable rules: `BR-NOTIF-003`, `BR-NOTIF-007`.

### FEAT-AUTH-RECOVERY-003 — Reset password

A user with a valid recovery authorization SHALL be able to establish a new password that satisfies the current password policy.

The recovery authorization SHALL be separate from ordinary access and refresh tokens.

Exact token security, expiration, single-use behavior, and password requirements belong to `SECURITY.md`.

### FEAT-AUTH-RECOVERY-004 — Invalid or expired recovery

If the recovery authorization is invalid, expired, already used, revoked, or otherwise unacceptable, password reset SHALL fail explicitly and SHALL NOT change the account password.

### FEAT-AUTH-RECOVERY-005 — Recovery completion

After a successful password reset, the user SHALL receive a clear completion outcome and SHALL be able to return to sign-in.

Whether existing sessions are revoked is defined in `SECURITY.md`.

---

# 7. User, Member, and Role Management Features

## 7.1 User Directory

### FEAT-USER-LIST-001 — Authorized user directory access

Users with approved organizational-management capability SHALL be able to view a directory of organizational accounts within their authorized scope.

The directory SHOULD support practical filtering or search by identity attributes such as name, email, role, department/scope, and account status when those attributes exist in the approved model.

### FEAT-USER-LIST-002 — Scope-limited visibility

A Department Manager SHALL NOT automatically receive visibility into unrelated organizational scopes.

An Administrator's operational ability to manage accounts SHALL NOT imply access to protected meeting content owned by those users.

Applicable rules: `BR-ROLE-003`, `BR-ROLE-004`, `BR-AUTHZ-001`.

## 7.2 Account Creation and Maintenance

### FEAT-USER-CREATE-001 — Create organizational account

An authorized administrator or approved manager SHALL be able to create an organizational account within the actor's permitted management scope.

The feature SHALL collect the identity and organizational attributes required by the approved data model and SHALL enforce unique account identity constraints.

Applicable rules: `BR-ID-001`, `BR-ID-002`, `BR-VAL-001`.

### FEAT-USER-CREATE-002 — Initial credential establishment

The product SHALL provide an approved way for a newly created user to establish credentials.

The exact mechanism MAY be administrator-assigned initial credentials, secure activation/recovery-style setup, or another security-approved process.

The chosen mechanism MUST be defined before implementation in `SECURITY.md`; clients MUST NOT invent separate credential-establishment flows.

### FEAT-USER-EDIT-001 — Edit managed profile attributes

Authorized account managers SHALL be able to update approved organizational attributes such as display name, department/scope association, or other managed profile fields.

Security-sensitive identity changes MAY require additional controls defined in `SECURITY.md`.

### FEAT-USER-STATUS-001 — Deactivate account

Authorized account managers SHALL be able to deactivate an account without destroying historical business references.

Applicable rules: `BR-ID-004`, `BR-ID-005`.

### FEAT-USER-STATUS-002 — Reactivate account

Where organizational policy permits, an authorized account manager MAY reactivate a previously deactivated account if the account identity remains valid and no conflicting active identity exists.

Reactivation SHALL NOT rewrite historical activity.

## 7.3 Role Management

### FEAT-ROLE-001 — Assign supported global role

Authorized administrators SHALL be able to assign a supported global role to an eligible user within the approved scope.

Baseline global roles are:

```text
EMPLOYEE
DEPARTMENT_MANAGER
ADMINISTRATOR
```

Applicable rules: `BR-ROLE-001` through `BR-ROLE-005`.

### FEAT-ROLE-002 — Role assignment does not create meeting membership

Changing a user's global role SHALL NOT automatically add the user to existing meetings, make the user an organizer, or grant access to every meeting transcript.

### FEAT-ROLE-003 — Role changes affect future behavior

Once a role change becomes authoritative, subsequent management and authorization behavior SHALL use the current role and scope.

Historical attribution SHALL remain unchanged.

---

# 8. Meeting Management Features

## 8.1 Meeting Creation

### FEAT-MTG-CREATE-001 — Create meeting

An authenticated user with meeting-creation capability SHALL be able to create a meeting.

The creation experience SHALL support the product fields necessary to establish a valid meeting record, including at minimum:

- title;
- organizer;
- planned date/time when scheduling immediately;
- optional description/purpose;
- optional room where applicable;
- optional participants.

The exact persistence schema belongs to `DATABASE.md`.

### FEAT-MTG-CREATE-002 — Draft creation

The product MAY allow a meeting to be created as `DRAFT` before the schedule is finalized.

A draft SHALL be visibly distinguishable from a committed scheduled meeting.

Applicable rules: `BR-MTG-LC-001`, `BR-MTG-LC-002`, `BR-MTG-LC-003`.

### FEAT-MTG-CREATE-003 — Organizer assignment

Every meeting SHALL have exactly one organizer at creation or before the meeting becomes a committed scheduled record.

The baseline organizer is the creating user unless an authorized actor explicitly creates a meeting on behalf of another eligible organizer.

Applicable rules: `BR-MTG-001`, `BR-MTG-002`.

## 8.2 Meeting Detail

### FEAT-MTG-VIEW-001 — View meeting detail

An authorized user SHALL be able to view the meeting metadata permitted by the user's access scope.

Depending on meeting state and content availability, the meeting detail experience MAY include:

- title and description;
- organizer;
- participants;
- schedule;
- room/location;
- meeting lifecycle state;
- recording/media state;
- AI processing state;
- transcript availability;
- summary;
- decisions;
- action items;
- export actions;
- history/audit-relevant information where exposed.

### FEAT-MTG-VIEW-002 — Metadata access and content access are distinct

The ability to view operational metadata such as that a meeting exists MUST NOT automatically imply permission to view protected audio, transcript, summary, decisions, or RAG content.

Applicable rules: `BR-MTG-010`, `BR-AUTHZ-001`.

## 8.3 Meeting Update

### FEAT-MTG-EDIT-001 — Edit editable meeting fields

The organizer or another authorized actor SHALL be able to edit meeting fields while the meeting is in an editable lifecycle state.

The feature SHALL revalidate any affected business constraints before accepting the update.

### FEAT-MTG-EDIT-002 — Material schedule changes

Changing meeting start time, end time, room, or other schedule-critical information SHALL be treated as a material meeting change.

The system SHALL revalidate room availability and other applicable scheduling rules before committing the change.

Applicable rules: `BR-MTG-LC-007`, `BR-SCH-006`.

### FEAT-MTG-EDIT-003 — In-progress restrictions

When a meeting is already `IN_PROGRESS`, the product SHALL prevent or restrict changes that would contradict the occurrence currently taking place.

Applicable rules: `BR-MTG-LC-010`.

### FEAT-MTG-EDIT-004 — Historical meeting protection

After a meeting is `ENDED`, ordinary schedule editing SHALL NOT rewrite the historical occurrence as if it happened at another time.

Permitted corrections to historical metadata MUST remain consistent with approved historical-integrity rules.

Applicable rules: `BR-MTG-LC-012`, `BR-GEN-007`.

## 8.4 Meeting Lifecycle Actions

### FEAT-MTG-SCHEDULE-001 — Commit a scheduled meeting

A valid draft or newly created meeting SHALL be able to become `SCHEDULED` after required schedule validation succeeds.

If a room is selected, room reservation semantics become authoritative when the meeting becomes scheduled.

Applicable rules: `BR-MTG-LC-004`, `BR-MTG-LC-005`.

### FEAT-MTG-START-001 — Start meeting occurrence

An authorized supported client MAY provide an explicit start action for a scheduled meeting where the product workflow requires it.

A cancelled meeting SHALL NOT be startable.

If the implementation derives start/end occurrence from recording or another approved event, that behavior MUST remain consistent with the canonical lifecycle.

Applicable rules: `BR-MTG-LC-008`, `BR-MTG-LC-009`.

### FEAT-MTG-END-001 — End meeting occurrence

An in-progress meeting SHALL be able to transition to `ENDED` through an approved occurrence-completion action.

Ending the meeting SHALL NOT imply that AI processing has completed.

Applicable rules: `BR-MTG-LC-011`.

### FEAT-MTG-CANCEL-001 — Cancel scheduled meeting

The organizer or another authorized actor SHALL be able to cancel a cancellable meeting.

Cancellation SHALL:

- transition the meeting to the canonical cancelled state;
- release future room-conflict contribution;
- preserve the meeting as historical business data;
- trigger approved notification intent for affected users.

Applicable rules: `BR-MTG-007`, `BR-MTG-LC-014`, `BR-MTG-LC-015`, `BR-MTG-LC-016`, `BR-NOTIF-003`.

### FEAT-MTG-CANCEL-002 — Cancelled meeting is not deleted

A cancelled meeting SHALL remain distinguishable from a deleted or archived record and SHALL continue to preserve historically relevant organizer, participant, and schedule information.

## 8.5 Meeting Listing

### FEAT-MTG-LIST-001 — List accessible meetings

An authenticated user SHALL be able to retrieve or view meetings that are within the user's authorized scope.

The baseline list experience SHOULD support practical filtering by attributes such as:

- lifecycle state;
- date/time range;
- organizer;
- participation relationship;
- room;
- text search over approved meeting metadata.

Exact query parameters belong to `API.md`.

### FEAT-MTG-LIST-002 — Upcoming and historical grouping

Clients SHOULD be able to distinguish upcoming, active, cancelled, and historical meetings without inventing separate local state.

---

# 9. Calendar and Scheduling Features

## 9.1 Calendar Views

### FEAT-CAL-VIEW-001 — Schedule visualization

The product SHALL provide calendar/schedule-oriented views of accessible meetings.

Web SHOULD support at least a practical date-based meeting view suitable for organizational scheduling.

Mobile SHOULD provide a mobile-appropriate schedule view even if the visual arrangement differs from Web.

### FEAT-CAL-VIEW-002 — Canonical data projection

Calendar entries SHALL be projections of canonical meeting schedule data and MUST NOT become separately editable copies with independent state.

Applicable rules: `BR-SCH-007`.

### FEAT-CAL-VIEW-003 — Time-zone-safe presentation

Clients SHALL display meeting time in the appropriate user/product context without changing the underlying instant.

Applicable rules: `BR-SCH-008`.

## 9.2 Schedule Validation

### FEAT-CAL-VALIDATE-001 — Valid time interval

The product SHALL reject a schedule whose end is not later than its start or whose timestamp representation is otherwise invalid.

Applicable rules: `BR-MTG-005`, `BR-SCH-001`, `BR-VAL-005`.

### FEAT-CAL-VALIDATE-002 — Room conflict validation

When a physical room is selected for a scheduled meeting, the system SHALL reject an authoritative reservation that overlaps another authoritative reservation for the same room.

Applicable rules: `BR-SCH-002`, `BR-ROOM-006`, `BR-CON-002`.

### FEAT-CAL-VALIDATE-003 — Participant conflict warning

If invited participants have overlapping accessible meetings, the product MAY warn the organizer but SHALL NOT reject the meeting solely for participant conflict in the baseline.

Applicable rules: `BR-SCH-003`.

### FEAT-CAL-VALIDATE-004 — Revalidation on schedule change

A material schedule edit SHALL perform the same conflict checks that would apply to a new authoritative schedule.

Applicable rules: `BR-SCH-006`.

---

# 10. Meeting Room Features

## 10.1 Room Catalog

### FEAT-ROOM-LIST-001 — View room catalog

Authorized users SHALL be able to view active meeting rooms or reservable physical meeting resources that are relevant to their scope.

The room list MAY expose capacity, location, description, equipment, active status, and availability-supporting information where configured.

### FEAT-ROOM-MANAGE-001 — Create room

An authorized room manager SHALL be able to create a room with the metadata required by the approved data model.

### FEAT-ROOM-MANAGE-002 — Edit room

An authorized room manager SHALL be able to edit approved room metadata without changing the room's historical identity.

Applicable rules: `BR-ROOM-001`.

### FEAT-ROOM-MANAGE-003 — Deactivate room

An authorized room manager SHALL be able to deactivate a room so that it cannot be selected for new reservations.

Historical meetings SHALL continue to identify the room where applicable.

Applicable rules: `BR-ROOM-002`, `BR-ROOM-003`, `BR-ROOM-004`.

### FEAT-ROOM-MANAGE-004 — Room deletion protection

The ordinary room-management flow SHOULD prefer deactivation rather than destructive deletion when historical meetings reference the room.

## 10.2 Room Availability

### FEAT-ROOM-AVAIL-001 — Check room availability

Meeting creation and editing experiences SHOULD allow users to understand whether a room is available for the selected time interval before or during final submission.

The authoritative conflict check SHALL still occur at commit time.

### FEAT-ROOM-AVAIL-002 — Capacity signal

If room capacity is configured, clients SHOULD surface capacity relative to participant count.

Whether capacity is advisory or enforced SHALL follow the configured business rule.

Applicable rules: `BR-ROOM-005`.

---

# 11. Meeting Participant Features

## 11.1 Participant Management

### FEAT-PART-ADD-001 — Add organizational participant

The organizer or another authorized meeting manager SHALL be able to add eligible organizational users as participants before or during the permitted meeting-management window.

Applicable rules: `BR-PART-002`, `BR-VAL-001`.

### FEAT-PART-ADD-002 — Organizer association

The organizer SHALL remain associated with the meeting even if the general participant list is edited.

Applicable rules: `BR-PART-001`.

### FEAT-PART-REMOVE-001 — Remove participant

An authorized meeting manager SHALL be able to remove a participant when business rules permit.

Removal SHALL affect future access decisions but SHALL NOT erase historical participation records that the system is required to preserve.

Applicable rules: `BR-PART-003`, `BR-PART-004`, `BR-PART-005`.

### FEAT-PART-VIEW-001 — View participant list

Users who are authorized to view meeting metadata SHALL be able to view the participant information allowed by the authorization model.

The product MUST NOT expose unrelated organizational data merely because a participant selector exists.

## 11.2 Participation and Invitation Semantics

### FEAT-PART-INVITE-001 — Participant association is authoritative in the system

The canonical participant relationship SHALL be stored by the system and SHALL NOT depend on successful email delivery.

Applicable rules: `BR-PART-007`.

### FEAT-PART-INVITE-002 — Baseline does not require RSVP

The baseline product SHALL NOT require participants to accept or decline an invitation before a meeting can be scheduled.

An RSVP workflow MAY be added later through explicit requirements.

Applicable rules: `BR-PART-008`.

### FEAT-PART-INVITE-003 — External anonymous guests are deferred

The baseline participant selector SHALL target organizational identities.

External anonymous guest participation is not baseline functionality.

---

# 12. Meeting Recording Features

## 12.1 Recording Start and Stop

### FEAT-REC-START-001 — Explicit recording start

A supported client SHALL allow an authorized user to explicitly start recording meeting audio when device/platform capability and user permission allow it.

Recording MUST NOT begin invisibly merely because a user opened a meeting page.

Applicable rules: `BR-MEDIA-007`.

### FEAT-REC-START-002 — Recording state visibility

While recording is active, the client SHALL clearly indicate that recording is in progress.

The recording state SHOULD survive ordinary in-screen navigation where technically appropriate, or the client SHALL prevent navigation that would silently terminate recording.

### FEAT-REC-START-003 — Device permission failure

If microphone permission is denied, unavailable, revoked, or the device cannot record, the feature SHALL fail explicitly and SHALL NOT present the meeting as successfully recorded.

### FEAT-REC-STOP-001 — Stop recording

The recording user SHALL be able to stop recording explicitly.

Stopping recording SHALL finalize the locally captured recording or approved capture stream sufficiently for subsequent submission.

Stopping recording SHALL NOT imply transcription completion.

Applicable rules: `BR-MEDIA-008`.

## 12.2 Recorded Audio Submission

### FEAT-REC-SUBMIT-001 — Submit completed recording

After recording is completed, the client SHALL be able to submit the completed audio to the backend as meeting source media.

The backend SHALL treat the submitted recording as post-recording source media subject to the same core processing requirements as imported audio.

Applicable rules: `BR-MEDIA-001`.

### FEAT-REC-SUBMIT-002 — Submission progress

For recordings large enough to require noticeable upload time, the client SHOULD expose upload progress or an equivalent pending state.

### FEAT-REC-SUBMIT-003 — Submission failure

If the completed recording cannot be uploaded, the client SHOULD preserve the recording locally where platform capability permits so that the user can retry rather than silently lose the captured meeting audio.

Exact offline/mobile persistence behavior belongs to Mobile architecture and package requirements.

### FEAT-REC-SUBMIT-004 — Duplicate submission awareness

Retrying upload of the same completed recording SHOULD NOT silently create multiple authoritative source-media records for the same intended submission without provenance or user-visible distinction.

Applicable rules: `BR-MEDIA-005`, `BR-CON-004`.

---

# 13. Audio and Media Import Features

## 13.1 Import Source Media

### FEAT-MEDIA-UPLOAD-001 — Upload meeting media

An authorized user SHALL be able to import a supported audio file for a meeting.

The product MAY support video containers when the backend can extract the audio stream through the approved ingestion pipeline.

### FEAT-MEDIA-UPLOAD-002 — Meeting association

Imported media SHALL be associated with an identifiable meeting record before it becomes authoritative source media for processing.

Applicable rules: `BR-MEDIA-002`.

### FEAT-MEDIA-UPLOAD-003 — Supported media validation

Before AI processing begins, the system SHALL validate that the uploaded media is acceptable according to configured requirements such as:

- supported format/container;
- readable media stream;
- usable audio track;
- allowed size/duration limits;
- security validation defined in `SECURITY.md`.

Invalid media SHALL fail explicitly.

Applicable rules: `BR-MEDIA-006`, `BR-AIP-001`.

### FEAT-MEDIA-UPLOAD-004 — Upload progress and completion

Clients SHOULD display upload progress or pending state for large media.

The UI SHALL distinguish:

- upload still in progress;
- upload completed but processing not started;
- processing started;
- upload failed.

### FEAT-MEDIA-UPLOAD-005 — Preserve source provenance

When a new source media file is uploaded to a meeting that already has source media, the feature MUST NOT silently overwrite the previous provenance.

The product SHALL either:

- reject the operation when replacement is not permitted; or
- create an explicit replacement/reprocessing path that preserves enough provenance to distinguish versions.

Applicable rules: `BR-MEDIA-003`, `BR-MEDIA-005`, `BR-AIP-007`.

## 13.2 Source Media Access

### FEAT-MEDIA-VIEW-001 — Source media availability

Authorized users MAY be allowed to play or download source meeting media when product and security policy permit.

Access to source media SHALL follow meeting-content authorization and MUST NOT be inferred solely from administrative role.

Applicable rules: `BR-MTG-009`, `BR-ROLE-003`.

### FEAT-MEDIA-VIEW-002 — Media processing status

The meeting experience SHALL expose whether valid source media is:

- absent;
- uploaded/available;
- awaiting processing;
- processing;
- processed;
- failed or partially unresolved.

---

# 14. AI Processing Job Features

## 14.1 Processing Initiation

### FEAT-AIP-START-001 — Start post-recording processing

After valid source media is accepted, the system SHALL be able to initiate the approved post-recording AI processing flow.

The feature MAY start processing automatically after successful ingestion or through an explicit authorized action, depending on architecture and deployment policy.

Whichever mode is selected SHALL be consistent across clients.

### FEAT-AIP-START-002 — Invalid media does not enter AI pipeline

Source media that fails required ingestion validation SHALL NOT enter normal AI processing.

Applicable rules: `BR-AIP-001`.

## 14.2 Processing Status

### FEAT-AIP-STATUS-001 — Expose processing lifecycle

Users who can access the meeting SHALL be able to observe a meaningful processing status when meeting intelligence is not immediately available.

The baseline functional states MAY include:

```text
QUEUED
PROCESSING
COMPLETED
COMPLETED_WITH_WARNINGS
FAILED
```

Detailed persistence may use additional internal stage states.

### FEAT-AIP-STATUS-002 — Stage-aware user feedback

Where useful, the product SHOULD expose coarse processing stages such as:

- preparing media;
- transcribing;
- recovering/validating transcript;
- speaker processing;
- generating meeting insights;
- indexing knowledge.

The UI SHOULD avoid exposing low-level provider implementation details as if they were business concepts.

### FEAT-AIP-STATUS-003 — Completed with warnings

When usable output exists but unresolved or suspicious conditions remain, the product SHOULD represent a warning state rather than an unconditional success state.

Applicable rules: `BR-AIP-003`, `BR-ASR-017`.

### FEAT-AIP-STATUS-004 — Downstream failure preserves upstream success

If transcript creation succeeds but a downstream stage such as summary generation, action-item extraction, decision extraction, or knowledge indexing fails, users with permission SHALL retain access to the valid transcript.

Applicable rules: `BR-AIP-004`.

## 14.3 Retry and Reprocessing

### FEAT-AIP-RETRY-001 — Retry failed processing stage

An authorized workflow SHALL support retry of a failed or retryable processing stage when the required upstream input remains valid.

Where technically feasible, retrying one downstream stage SHOULD NOT rerun unrelated successful stages.

Applicable rules: `BR-AIP-006`.

### FEAT-AIP-RETRY-002 — Reprocessing provenance

If a meeting's media is processed again, the system SHALL preserve enough run/version provenance to distinguish new output from previous output and determine which output is currently authoritative.

Applicable rules: `BR-AIP-007`.

### FEAT-AIP-RETRY-003 — No duplicate official artifacts from retry

Retry or reprocessing SHALL NOT create duplicate official confirmed decisions or duplicate official action items solely because the AI extraction stage was executed more than once.

Applicable rules: `BR-AI-006`, `BR-CON-004`.

---

# 15. Offline Transcription Features

Offline/post-recording transcription is the committed ASR baseline.

Its most important product guarantee is not merely that Whisper returns text, but that **detected spoken content is not silently lost**.

## 15.1 Source Preparation

### FEAT-ASR-SOURCE-001 — Preserve recoverable source audio

The system SHALL retain recoverable source media or an approved lossless/recoverable source representation sufficient to reprocess the meeting when needed.

A normalized processing representation SHALL NOT become the only surviving source if doing so prevents required recovery or reprocessing.

Applicable rules: `BR-MEDIA-003`, `BR-MEDIA-004`, `BR-ASR-001`.

### FEAT-ASR-SOURCE-002 — Stable processing representation

The AI pipeline SHALL create an approved normalized audio representation suitable for speech detection, timestamp alignment, chunking, recovery, and reconciliation.

Exact codec/sample rate/channel decisions belong to AI architecture.

## 15.2 Speech Detection and Speech Map

### FEAT-ASR-SPEECH-001 — Detect speech independently of transcript output

The offline pipeline SHALL build an independent representation of probable speech regions before or alongside transcription.

This representation SHALL NOT depend solely on Whisper output.

Applicable rules: `BR-ASR-003`.

### FEAT-ASR-SPEECH-002 — Speech detection is evidence, not absolute truth

The pipeline MAY combine multiple audio signals for speech detection.

The product SHALL NOT assume that a single detector is infallible.

### FEAT-ASR-SPEECH-003 — Preserve speech timeline semantics

Detected speech regions SHALL retain timeline coordinates that can later be compared with transcript coverage.

Applicable rules: `BR-ASR-010`.

## 15.3 Independent Transcription Processing

### FEAT-ASR-TRANSCRIBE-001 — Process bounded audio regions

Long recordings SHALL be processable as bounded transcription units rather than depending on one monolithic provider request for the complete file.

The purpose is to isolate failures and preserve recoverability.

Applicable rules: `BR-ASR-006`.

### FEAT-ASR-TRANSCRIBE-002 — Independent failure domains

A failed or hallucinated transcription request for one bounded region SHALL NOT prevent later independent regions from being processed.

Applicable rules: `BR-ASR-006`.

### FEAT-ASR-TRANSCRIBE-003 — Boundary-safe processing

The processing strategy SHALL include an approved mechanism such as overlap or equivalent context handling to avoid knowingly discarding words at processing boundaries.

Applicable rules: `BR-ASR-009`.

### FEAT-ASR-TRANSCRIBE-004 — Vietnamese language optimization

For known Vietnamese meeting audio, the transcription flow SHOULD use the approved Vietnamese language configuration instead of unnecessary automatic language detection unless multilingual behavior is explicitly required.

Exact model/provider configuration belongs to AI package design.

## 15.4 Transcript Coverage Validation

### FEAT-ASR-COVERAGE-001 — Provider response is not completion

A successful ASR provider response SHALL NOT by itself mark the audio region as fully processed.

Applicable rules: `BR-ASR-002`.

### FEAT-ASR-COVERAGE-002 — Compare speech against transcript coverage

The pipeline SHALL compare the independent speech map against transcript time coverage to identify detected speech that has not been adequately represented in transcript output.

Applicable rules: `BR-ASR-003`, `BR-ASR-010`.

### FEAT-ASR-COVERAGE-003 — No silent uncovered speech

A detected speech region that lacks adequate transcript coverage SHALL NOT silently disappear from the processing result.

It SHALL become an explicit unresolved/suspicious/recovery candidate.

Applicable rules: `BR-ASR-004`, `BR-ASR-016`, `BR-ASR-017`.

### FEAT-ASR-COVERAGE-004 — Distinguish suspicious from complete

The product SHALL be able to represent transcript regions or processing output as suspicious when multiple quality signals indicate that output may not faithfully represent the audio.

Applicable rules: `BR-ASR-014`.

### FEAT-ASR-COVERAGE-005 — Hallucination phrase alone is insufficient

The pipeline MUST NOT reject text solely because it contains a phrase known to appear in hallucinations.

Known phrases MAY contribute to suspicion only together with other evidence.

Applicable rules: `BR-ASR-015`.

## 15.5 Automatic Recovery

### FEAT-ASR-RECOVERY-001 — Retry uncovered speech

The pipeline SHALL automatically attempt bounded recovery for detected speech regions that remain uncovered or suspicious according to the approved recovery policy.

Applicable rules: `BR-ASR-007`.

### FEAT-ASR-RECOVERY-002 — Recovery changes processing context

Recovery SHOULD be capable of changing processing context rather than blindly repeating an identical failed request.

The recovery strategy MAY alter region boundaries, region size, overlap, or other approved inference context.

Applicable rules: `BR-ASR-008`.

### FEAT-ASR-RECOVERY-003 — Recovery is bounded

Automatic recovery SHALL have a finite policy.

The system MUST NOT retry an unresolved region forever.

Applicable rules: `BR-ASR-007`.

### FEAT-ASR-RECOVERY-004 — Explicit unresolved result

If bounded recovery cannot produce acceptable coverage, the affected speech region SHALL remain traceable as unresolved/error rather than being silently marked complete.

Applicable rules: `BR-ASR-016`, `BR-ASR-017`.

## 15.6 Reconciliation and Finalization

### FEAT-ASR-MERGE-001 — Reconcile overlapping results

Results from overlapping or retried audio regions SHALL be reconciled using timeline and quality evidence rather than concatenating raw strings blindly.

### FEAT-ASR-MERGE-002 — Avoid duplicate overlap text

The reconciliation stage SHALL prevent the same spoken phrase from appearing multiple times merely because it occurred in overlapping processing regions.

### FEAT-ASR-MERGE-003 — Preserve best-supported content

Where overlapping results disagree, reconciliation SHOULD favor the result best supported by approved evidence such as timing consistency, distance from boundaries, confidence signals, repeated confirmation, and hallucination indicators.

Exact scoring belongs to AI design.

### FEAT-ASR-MERGE-004 — Produce timestamped reconciled candidate output

Successful ASR reconciliation SHALL produce candidate transcript segments aligned to the original meeting timeline so the contextual LLM correction stage can preserve timeline identity while correcting text.

Applicable rules: `BR-TRN-002`.

## 15.7 Offline ASR Acceptance Case

### FEAT-ASR-REGRESSION-001 — Retain hallucination-loss regression case

The known failure pattern in which a short silence triggers hallucinated text and causes approximately the following tens of seconds of real speech to disappear SHALL be retained as a mandatory regression case.

The expected product outcome is:

1. later speech is detected by the independent speech map;
2. missing transcript coverage is detected;
3. the region enters bounded recovery;
4. processing context changes for recovery attempts;
5. recovered text is reconciled into the final timeline when successful;
6. if recovery ultimately fails, the region remains explicitly unresolved.

Applicable rules: `BR-ASR-018`.

---

# 16. Speaker Diarization and Speaker Mapping Features

## 16.1 Speaker Diarization

### FEAT-DIAR-PROCESS-001 — Identify speaker turns

For multi-speaker meeting audio, the AI processing flow SHALL support diarization that associates transcript timing with speaker clusters or labels.

### FEAT-DIAR-PROCESS-002 — Anonymous labels are valid initial output

When a real person identity cannot be established safely, the product SHALL support anonymous labels such as:

```text
Speaker 1
Speaker 2
Speaker 3
```

Applicable rules: `BR-DIAR-002`.

### FEAT-DIAR-PROCESS-003 — Diarization failure does not erase transcript

If diarization fails while a valid transcript exists, the transcript SHALL remain available without speaker identity rather than being deleted or treated as wholly failed.

Applicable rules: `BR-DIAR-007`, `BR-AIP-004`.

## 16.2 Speaker Identity Mapping

### FEAT-DIAR-MAP-001 — Map speaker cluster to known participant

An authorized transcript editor SHOULD be able to map an anonymous speaker label or diarization cluster to an eligible known meeting participant when the identity is known.

Applicable rules: `BR-DIAR-003`.

### FEAT-DIAR-MAP-002 — Mapping does not rewrite speech text

Changing the speaker identity SHALL NOT automatically rewrite the transcript text itself.

Text correction is a separate action.

Applicable rules: `BR-DIAR-004`.

### FEAT-DIAR-MAP-003 — Reconcile multiple clusters

The product SHALL permit an authorized user to map multiple diarization clusters to the same person where diarization split one speaker into multiple clusters.

Applicable rules: `BR-DIAR-005`.

### FEAT-DIAR-MAP-004 — Mapping consistency

Within the finalized meeting context, the same diarization label SHALL NOT silently refer to different people.

Applicable rules: `BR-DIAR-006`.

---

# 17. Transcript Review and Correction Features

Automatic LLM transcript correction and later human transcript editing are separate concepts in this section. The automatic stage creates the initial persisted machine transcript; human editing may revise that transcript afterward.

## 17.0 Automatic Contextual Transcript Correction

### FEAT-TRN-AUTO-001 — LLM correction occurs before transcript persistence

After ASR coverage/recovery and timeline-aware reconciliation complete, the system SHALL run contextual LLM correction before transcript text becomes the persisted/current machine transcript.

### FEAT-TRN-AUTO-002 — Whole-meeting context is the baseline

For meetings within supported context limits, the LLM correction request SHALL include the complete reconciled transcript candidate in chronological order. Each candidate segment SHALL carry stable ordering/timing identity so the model can use conversation-wide context while returning corrected text that remains aligned to the meeting timeline.

### FEAT-TRN-AUTO-003 — Corrected result becomes the machine transcript

After validation, the LLM-corrected result SHALL become the transcript shown to users and used by downstream summary, extraction, and RAG workflows. Raw Whisper transcript text SHALL NOT be exposed or retained as a competing persisted transcript.

### FEAT-TRN-AUTO-004 — No raw-ASR fallback on correction failure

If LLM correction fails, times out, exceeds supported limits without an approved overflow path, or returns an invalid segment structure after bounded retry, the transcript processing stage SHALL remain retryable/failed rather than publishing raw Whisper text as a completed transcript.

## 17.1 Transcript Timeline

### FEAT-TRN-VIEW-001 — View timestamped transcript

An authorized user SHALL be able to view the meeting transcript as time-aligned segments.

Each segment SHOULD expose, when available:

- start time;
- end time;
- current display text;
- speaker label or mapped identity;
- quality/review indicator when material;
- provenance or correction information where appropriate.

### FEAT-TRN-VIEW-002 — Navigate by time

Where source audio playback is available, the transcript experience SHOULD allow the user to navigate between transcript segments and corresponding source-audio positions.

### FEAT-TRN-VIEW-003 — Suspicious/unresolved visibility

If transcript coverage contains unresolved or materially suspicious regions, the transcript experience SHALL indicate that the transcript is incomplete or uncertain rather than presenting unconditional completeness.

Applicable rules: `BR-TRN-009`, `BR-ASR-017`.

## 17.2 Transcript Correction

### FEAT-TRN-EDIT-001 — Authorized text correction

The Meeting Organizer or an explicitly authorized transcript editor SHALL be able to correct transcript text.

Ordinary participation alone SHALL NOT grant transcript-edit permission.

Applicable rules: `BR-TRN-007`, `BR-AUTHZ-003`.

### FEAT-TRN-EDIT-002 — Preserve source and revision provenance

Correcting transcript text SHALL update the current reviewed/display value without altering the source audio or destroying the transcript revision/provenance needed for audit, evaluation, or reprocessing. The workflow does not require persisted raw Whisper transcript text.

Applicable rules: `BR-TRN-001`, `BR-TRN-005`.

### FEAT-TRN-EDIT-003 — Correction attribution

A material transcript correction SHALL retain who performed the correction and when, according to approved audit requirements.

Applicable rules: `BR-TRN-006`.

### FEAT-TRN-EDIT-004 — Corrected value becomes user-facing authority

Once an authorized correction is committed, the corrected value SHALL be used for normal finalized user-facing transcript behavior and downstream regeneration where appropriate.

Applicable rules: `BR-TRN-008`.

### FEAT-TRN-EDIT-005 — No separate approval step for ordinary correction

The baseline transcript correction workflow does not require a second reviewer after an authorized editor commits a correction.

Organizations requiring multi-review approval MAY introduce it later through explicit requirements.

## 17.3 Transcript and Downstream AI

### FEAT-TRN-DOWNSTREAM-001 — Correction may invalidate derived artifacts

When a transcript correction materially changes evidence used by summaries, decisions, action items, or RAG indexing, the system SHOULD mark affected derived artifacts as stale or eligible for controlled regeneration rather than silently leaving known-inconsistent derived content as authoritative.

Exact invalidation strategy belongs to architecture/database requirements.

### FEAT-TRN-DOWNSTREAM-002 — Correction does not automatically confirm AI proposals

Correcting transcript text SHALL NOT automatically confirm proposed decisions or action items.

Applicable rules: `BR-AI-003`.

---

# 18. Meeting Summary Features

## 18.1 Summary Generation

### FEAT-SUM-GEN-001 — Generate meeting summary

After a sufficiently valid transcript is available, the system SHALL support generation of a concise meeting summary.

The summary SHALL be derived from available meeting evidence and SHALL NOT replace the transcript.

Applicable rules: `BR-SUM-001`, `BR-SUM-002`.

### FEAT-SUM-GEN-002 — Summary depends on transcript quality

If the transcript contains material unresolved or suspicious regions, the summary feature SHOULD indicate reduced confidence, incomplete evidence, or another approved warning rather than imply perfect completeness.

Applicable rules: `BR-SUM-003`.

### FEAT-SUM-GEN-002A — Visible advisory AI quality warnings

When accepted AI Summary output provides validated warning codes, authorized Summary and version-history views SHALL preserve and expose these warnings separately from authoritative Transcript evidence. A warning-bearing Summary SHALL NOT be presented as unconditionally READY without warnings. A human edit SHALL NOT silently erase its source warning lineage, nor acquire false AI-authored attribution.

### FEAT-SUM-GEN-003 — Summary generation failure

If summary generation fails after a valid transcript exists, the transcript SHALL remain available and the summary area SHALL expose a retryable/failed state.

Applicable rules: `BR-AIP-004`.

## 18.2 Summary Review and Editing

### FEAT-SUM-EDIT-001 — Authorized summary edit

The Meeting Organizer or another explicitly authorized content editor SHALL be able to edit the user-facing meeting summary.

### FEAT-SUM-EDIT-002 — Preserve AI provenance

When a human edits an AI-generated summary, the system SHOULD retain enough provenance to distinguish the reviewed version from the original generated output where required.

Applicable rules: `BR-SUM-004`, `BR-AI-002`.

### FEAT-SUM-EDIT-003 — Regeneration does not silently destroy reviewed summary

If the user requests summary regeneration after human edits exist, the product SHALL warn, version, compare, or otherwise preserve reviewed content rather than silently replacing it.

Applicable rules: `BR-SUM-005`, `BR-AI-004`.

### FEAT-SUM-VIEW-001 — Summary access follows meeting content access

Only users authorized to access protected meeting content SHALL be able to view the summary.

Applicable rules: `BR-SUM-006`.

### FEAT-SUM-REVIEW-001 — Discover generated Summary candidates

Authorized meeting-content readers SHALL be able to inspect paginated current and historical Summary versions, including non-current AI regeneration candidates, with source provenance, current/stale status and quality indicators. Candidate content MUST NOT be disclosed to users lacking current meeting-content access. History is read-only; viewing a candidate does not approve it.

### FEAT-SUM-REVIEW-002 — Explicit authorized version activation

The Meeting Organizer or another explicitly authorized Summary content editor SHALL be able to make an eligible, **fresh** existing Summary version current through a deliberate confirmation action. Activation SHALL use conditional concurrency against the current Summary, recheck authorization and source freshness, preserve historical content/source attribution and record a trusted audit event. A stale/foreign candidate SHALL NOT be silently activated. Selecting an AI candidate does not reclassify its origin as HUMAN_EDIT.

### FEAT-SUM-REVIEW-003 — Preserve current Summary on regeneration

A later generated candidate SHALL remain non-current until an authorized user explicitly activates it. Failed regeneration or an ineligible/stale candidate SHALL NOT erase the current Summary. The original successful AI publication when no current Summary exists follows the approved source freshness policy.

Applicable rules: `BR-SUM-004`, `BR-SUM-005`, `BR-SUM-006`. The associated HTTP additions are `API-EP-SUM-004/005`; implementation is scheduled for MI-PM-04, not assumed available yet.

---

# 19. Meeting Decision Features

## 19.1 AI Decision Extraction

### FEAT-DEC-EXTRACT-001 — Extract proposed decisions

The system SHALL support extraction of significant meeting decisions from sufficiently valid meeting evidence.

AI-extracted decisions SHALL enter the product as `PROPOSED`.

Applicable rules: `BR-DEC-001`.

### FEAT-DEC-EXTRACT-002 — Proposed decision presentation

A proposed decision SHALL be visibly distinguishable from a confirmed decision.

The UI MUST NOT present AI extraction as an official organizational decision before confirmation.

Applicable rules: `BR-DEC-001`, `BR-AI-001`.

### FEAT-DEC-EXTRACT-003 — Suspicious evidence handling

A decision extracted from suspicious or unresolved transcript evidence SHALL NOT become confirmed automatically.

The product SHOULD surface the underlying uncertainty or prevent confirmation until an authorized reviewer has sufficient evidence.

Applicable rules: `BR-DEC-006`.

### FEAT-DEC-EXTRACT-004 — Preserve advisory AI uncertainty and batch warnings

Authorized Decision readers SHALL be able to see validated NONE/LOW/MATERIAL uncertainty on AI-extracted proposals, alongside applicable batch warning codes and producer provenance. These are model-supplied advisory metadata, NOT independently verified transcript evidence or human confirmation. They SHALL remain attributable through later human review/correction without changing Decision authority. Manual Decisions SHALL NOT be incorrectly labeled with AI uncertainty.

## 19.2 Decision Confirmation

### FEAT-DEC-CONFIRM-001 — Confirm proposed decision

The Meeting Organizer or another user with explicit confirmation authority SHALL be able to confirm a proposed decision.

Confirmation SHALL transition the decision to `CONFIRMED` as one authoritative action.

Applicable rules: `BR-DEC-002`, `BR-CON-003`.

### FEAT-DEC-REJECT-001 — Reject proposed decision

An authorized reviewer SHALL be able to reject a proposed decision that is incorrect, irrelevant, duplicated, or unsupported.

The product SHOULD preserve sufficient provenance for quality evaluation where required.

Applicable rules: `BR-DEC-003`.

### FEAT-DEC-CREATE-001 — Create confirmed decision manually

An authorized user MAY create a meeting decision directly as `CONFIRMED` without AI extraction.

Applicable rules: `BR-DEC-004`.

### FEAT-DEC-EDIT-001 — Edit confirmed decision

An authorized user SHALL be able to make controlled corrections to a confirmed decision.

Meaningful edits SHOULD be attributable and SHALL remain associated with the originating meeting.

Applicable rules: `BR-DEC-005`, `BR-DEC-007`.

### FEAT-DEC-VIEW-001 — Decision access

Decision visibility SHALL follow meeting-content authorization.

Applicable rules: `BR-DEC-008`.

---

# 20. Action Item Features

## 20.1 AI Action-Item Extraction

### FEAT-ACT-EXTRACT-001 — Extract proposed action items

The system SHALL support extraction of candidate follow-up work from sufficiently valid meeting content.

AI-extracted items SHALL enter the system as `PROPOSED`.

Applicable rules: `BR-ACT-001`.

### FEAT-ACT-EXTRACT-002 — Proposed item is not assigned work yet

A proposed action item SHALL be clearly shown as awaiting human confirmation and SHALL NOT count as an official open obligation.

Applicable rules: `BR-ACT-002`.

### FEAT-ACT-EXTRACT-003 — Proposed item may lack assignee

If AI cannot reliably identify an assignee, the proposed item MAY remain temporarily unassigned.

It SHALL NOT become `OPEN` until required ownership is valid.

Applicable rules: `BR-ACT-006`.

### FEAT-ACT-EXTRACT-004 — Suspicious evidence requires human judgment

An item derived from suspicious or unresolved transcript evidence SHALL NOT automatically become official follow-up work.

Applicable rules: `BR-ACT-016`.

## 20.2 Action-Item Confirmation and Creation

### FEAT-ACT-CONFIRM-001 — Confirm proposed item

The Meeting Organizer or another user with explicit action-item confirmation authority SHALL be able to confirm a proposed item.

Before confirmation, the product SHALL require the fields necessary for an official `OPEN` action item, including exactly one primary assignee.

Applicable rules: `BR-ACT-004`, `BR-ACT-005`.

### FEAT-ACT-REJECT-001 — Reject/cancel proposed item

An authorized reviewer SHALL be able to reject a proposed item by moving it to the approved non-active outcome rather than leaving it ambiguous.

The baseline uses `CANCELLED` for a proposed item that will not become official work.

Applicable rules: `BR-ACT-008`.

### FEAT-ACT-CREATE-001 — Create action item manually

An authorized user SHALL be able to create an action item directly as `OPEN` without AI extraction.

The item SHALL be associated with a meeting when it represents meeting follow-up work.

Applicable rules: `BR-ACT-003`.

## 20.3 Action-Item Fields

### FEAT-ACT-FIELD-001 — Action-item description/title

An official action item SHALL contain enough descriptive information for the assignee to understand the expected follow-up work.

### FEAT-ACT-FIELD-002 — Primary assignee

An `OPEN` or `IN_PROGRESS` action item SHALL have exactly one primary assignee.

Applicable rules: `BR-ACT-005`.

### FEAT-ACT-FIELD-003 — Optional due date

The feature SHALL allow an action item to have no due date unless another approved business requirement makes a due date mandatory for that context.

Applicable rules: `BR-ACT-007`.

### FEAT-ACT-FIELD-004 — Meeting relationship

Meeting-derived action items SHALL preserve their relationship to the originating meeting so users can navigate back to the context that produced the work.

## 20.4 Action-Item Lifecycle

### FEAT-ACT-STATE-001 — Supported states

The user-facing action-item lifecycle SHALL use the canonical states:

```text
PROPOSED
OPEN
IN_PROGRESS
DONE
CANCELLED
```

The UI MUST NOT introduce `OVERDUE` as a separately editable workflow state.

Applicable rules: `BR-ACT-008`, `BR-ACT-010`.

### FEAT-ACT-STATE-002 — Start work

An authorized assignee or manager SHALL be able to move an `OPEN` action item to `IN_PROGRESS`.

### FEAT-ACT-STATE-003 — Complete work

An authorized assignee or manager SHALL be able to mark an `OPEN` or `IN_PROGRESS` action item as `DONE`.

The completion action SHOULD retain the actor and completion time.

Applicable rules: `BR-ACT-011`.

### FEAT-ACT-STATE-004 — Cancel work

An authorized manager/organizer SHALL be able to cancel an `OPEN` or `IN_PROGRESS` action item when it is no longer required.

Cancellation SHALL preserve history.

Applicable rules: `BR-ACT-012`.

### FEAT-ACT-STATE-005 — Reopen completed work

An authorized user SHALL be able to reopen a `DONE` item to `OPEN` when the work must continue.

Applicable rules: `BR-ACT-008`.

### FEAT-ACT-STATE-006 — Reject invalid transitions

Clients SHALL NOT silently reinterpret unsupported transitions.

Applicable rules: `BR-ACT-009`.

## 20.5 Assignment and Reassignment

### FEAT-ACT-ASSIGN-001 — Assign primary owner

An authorized user SHALL be able to assign the primary assignee required for official action items.

### FEAT-ACT-ASSIGN-002 — Reassign work

An authorized user SHALL be able to reassign an `OPEN` or `IN_PROGRESS` item.

The change SHOULD preserve meaningful attribution.

Applicable rules: `BR-ACT-013`.

### FEAT-ACT-ASSIGN-003 — Deactivated assignee handling

If an assignee becomes inactive, the action item SHALL remain visible and unresolved until it is reassigned, completed through an approved administrative action, or cancelled.

Applicable rules: `BR-ACT-014`.

## 20.6 Personal and Management Views

### FEAT-ACT-MY-001 — My action items

An authenticated user SHALL be able to view action items for which the user is the primary assignee.

The view SHOULD support filtering by canonical state, due date/overdue condition, and originating meeting.

### FEAT-ACT-MANAGE-001 — Team/department action items

A Department Manager or other authorized manager MAY view action items within the manager's approved scope.

The feature SHALL NOT use the manager role to reveal unrelated protected meeting content.

Applicable rules: `BR-ACT-015`, `BR-ROLE-004`.

### FEAT-ACT-OVERDUE-001 — Overdue indication

The product SHALL derive an overdue indicator when an item has a due date in the past and is neither `DONE` nor `CANCELLED`.

Applicable rules: `BR-ACT-010`.

---

# 21. Search and Historical Retrieval Features

## 21.1 Structured Meeting Search

### FEAT-SEARCH-MTG-001 — Search accessible meetings

An authenticated user SHOULD be able to search accessible historical and upcoming meetings using approved structured criteria.

Useful criteria MAY include:

- title/metadata text;
- date range;
- organizer;
- participant relationship;
- meeting state;
- room;
- presence of transcript/processing result.

Exact API filtering syntax belongs to `API.md`.

### FEAT-SEARCH-MTG-002 — Search respects access scope

Search SHALL only return meeting information the user is authorized to discover.

Applicable rules: `BR-SEARCH-001`, `BR-SEARCH-002`.

### FEAT-SEARCH-MTG-003 — Search result state accuracy

Search results SHALL present current/historical canonical state and SHALL NOT rely on stale derived search documents as independent truth.

Applicable rules: `BR-SEARCH-003`, `BR-SEARCH-004`.

## 21.2 Historical Meeting Access

### FEAT-SEARCH-HISTORY-001 — Open historical meeting

An authorized user SHALL be able to open a historical meeting and access the currently permitted meeting artifacts.

### FEAT-SEARCH-HISTORY-002 — Archived/cancelled distinction

Where archival is exposed, clients SHALL distinguish archive/retention state from cancellation state.

Applicable rules: `BR-RET-001`, `BR-RET-002`.

---

# 22. AI Assistant and RAG Features

## 22.1 Ask Questions About Meeting Knowledge

### FEAT-RAG-ASK-001 — Natural-language question

An authorized user SHALL be able to submit a natural-language question to the AI Assistant about meeting knowledge the user is permitted to access.

### FEAT-RAG-ASK-002 — Authorized retrieval scope

Before answer generation, the system SHALL restrict retrieval to content the requesting user is currently authorized to access.

Authorization MUST apply to retrieval itself and not merely to the final display layer.

Applicable rules: `BR-RAG-001`, `BR-RAG-002`.

### FEAT-RAG-ASK-003 — Conversation history does not expand access

Previous assistant conversation content SHALL NOT grant access to newly unauthorized meetings or bypass current authorization.

Applicable rules: `BR-RAG-003`.

## 22.2 Grounded Answers

### FEAT-RAG-ANSWER-001 — Evidence-grounded answer

The Assistant SHOULD answer from retrieved meeting evidence and SHALL NOT present unsupported general-model fabrication as if it were an internal meeting fact.

Applicable rules: `BR-RAG-005`, `BR-RAG-010`.

### FEAT-RAG-ANSWER-002 — Source traceability

When the retrieval and model stack support it, Assistant answers SHOULD include source references sufficient to identify supporting meeting context, such as meeting identity and relevant transcript/knowledge segments.

Applicable rules: `BR-RAG-006`.

### FEAT-RAG-ANSWER-003 — Insufficient evidence

If authorized meeting evidence is insufficient, the Assistant SHALL be able to respond that the requested information could not be established from available meeting knowledge rather than inventing an answer.

Applicable rules: `BR-RAG-005`.

### FEAT-RAG-ANSWER-004 — Derived answer status

Assistant responses SHALL be presented as derived answers, not as replacements for official transcript, confirmed decisions, or official action items.

Applicable rules: `BR-RAG-004`.

### FEAT-RAG-ANSWER-005 — Suspicious evidence has reduced authority

The retrieval/answering flow SHOULD avoid treating unresolved or suspicious transcript content as equally authoritative to reviewed/final content.

If such evidence materially affects the answer, the Assistant SHOULD expose uncertainty or refrain from presenting the statement as confirmed.

Applicable rules: `BR-RAG-007`.

## 22.3 Knowledge Refresh

### FEAT-RAG-INDEX-001 — Index eligible meeting knowledge

After approved transcript/finalized meeting artifacts become available, the system SHALL support indexing eligible meeting knowledge for retrieval.

Exact embedding/index architecture belongs to `ARCHITECTURE.md`.

### FEAT-RAG-INDEX-002 — Corrections update retrievable knowledge

When an authoritative transcript correction or other approved content update supersedes previously indexed text, the system SHALL update or invalidate stale retrieval content so the Assistant does not indefinitely answer from known-obsolete text.

Applicable rules: `BR-RAG-008`.

### FEAT-RAG-INDEX-003 — Revoked/deleted content becomes unavailable

When meeting content becomes unavailable because of deletion, retention action, or access revocation, retrieval SHALL stop exposing that content according to approved policy.

Applicable rules: `BR-RAG-009`.

## 22.4 Assistant Conversation Experience

### FEAT-RAG-CHAT-001 — Conversation context

The Assistant MAY maintain conversation context to support follow-up questions, subject to security, privacy, and context-window constraints.

### FEAT-RAG-CHAT-002 — Context scope clarity

The client SHOULD make it understandable whether the Assistant is operating over:

- a specific meeting;
- a selected set of meetings;
- the user's authorized meeting knowledge more broadly.

The exact scopes exposed in V1 MAY be limited by implementation, but authorization guarantees remain mandatory.

---

# 23. Dashboard Features

## 23.1 Personal Dashboard

### FEAT-DASH-PERSONAL-001 — Personal meeting overview

The system SHALL provide an authenticated dashboard or equivalent summary surface showing useful meeting activity within the user's access scope.

The baseline SHOULD include some combination of:

- upcoming meetings;
- recent meetings;
- meetings awaiting processing/review;
- assigned action items;
- overdue action items.

### FEAT-DASH-PERSONAL-002 — Canonical state projection

Dashboard cards and counts SHALL derive from canonical meeting/action-item state and SHALL NOT maintain independent manually editable counters.

Applicable rules: `BR-DASH-001`.

## 23.2 Management Dashboard

### FEAT-DASH-MGMT-001 — Scoped management metrics

Department Managers and other authorized users MAY see management-level metrics within their approved organizational scope.

Possible baseline metrics include:

- meeting counts by selected period/state;
- action items by state;
- overdue action items;
- completion ratio where denominator is defined;
- processing failure/warning counts.

### FEAT-DASH-MGMT-002 — Permission-aware aggregation

Aggregated metrics SHALL NOT expose protected meeting content or unauthorized detail merely because the user can see a numeric aggregate.

Applicable rules: `BR-DASH-002`.

### FEAT-DASH-MGMT-003 — Overdue metric semantics

Any overdue metric SHALL use the canonical overdue condition rather than a separately maintained `OVERDUE` state.

Applicable rules: `BR-DASH-003`.

### FEAT-DASH-MGMT-004 — Meeting completion and AI completion are distinct

Dashboard reporting SHALL distinguish a meeting that ended successfully from an AI processing job that failed or remains incomplete.

Applicable rules: `BR-DASH-004`, `BR-MTG-006`.

### FEAT-DASH-MGMT-005 — Documented metric denominator

Any percentage, rate, or completion metric used by the product SHALL have a defined denominator so different clients do not calculate incompatible values.

Applicable rules: `BR-DASH-005`.

---

# 24. Transactional Email and Notification Features

The baseline email delivery provider is Gmail SMTP at infrastructure level. Feature behavior is provider-independent and is triggered by authoritative business events.

## 24.1 Baseline V1 Transactional Emails

### FEAT-NOTIF-EMAIL-001 — Password recovery email

Password recovery SHALL use transactional email to deliver the approved recovery action to an eligible account.

This communication is a mandatory security/account communication and SHALL NOT be suppressible by optional notification preferences.

Applicable rules: `BR-NOTIF-006`.

### FEAT-NOTIF-EMAIL-002 — Meeting scheduled/invitation email

When a meeting becomes authoritatively scheduled with participants, the system SHOULD request an email notification for affected participants.

The meeting remains scheduled even if email delivery fails.

Applicable rules: `BR-NOTIF-001`, `BR-NOTIF-002`, `BR-PART-007`.

### FEAT-NOTIF-EMAIL-003 — Material meeting-change email

When an already scheduled meeting receives a material change such as time or room modification, the system SHOULD request an updated meeting notification for affected participants.

Applicable rules: `BR-MTG-LC-007`, `BR-NOTIF-003`.

### FEAT-NOTIF-EMAIL-004 — Meeting cancellation email

When a scheduled meeting is cancelled, the system SHOULD request a cancellation notification for affected participants.

Email failure SHALL NOT restore the cancelled meeting.

Applicable rules: `BR-NOTIF-001`, `BR-NOTIF-002`, `BR-NOTIF-008`.

### FEAT-NOTIF-EMAIL-005 — Action-item assignment email

When an official action item is assigned or materially reassigned to a user, the system SHOULD request an email informing the responsible user.

The assignment remains authoritative even if email delivery fails.

### FEAT-NOTIF-EMAIL-006 — Reminder email is optional baseline extension

Due-date reminders MAY be introduced when the notification scheduling mechanism is implemented and approved.

They are not required for the minimum initial functional acceptance of action-item management.

## 24.2 Email Delivery Behavior

### FEAT-NOTIF-DELIVERY-001 — Backend-controlled delivery

User-facing clients SHALL NOT directly connect to Gmail SMTP or store SMTP credentials.

Clients trigger business actions; backend notification behavior handles email delivery.

### FEAT-NOTIF-DELIVERY-002 — Delivery status is secondary state

Where operational UI exposes notification status, it SHALL distinguish notification delivery state from the underlying meeting/account/action-item business state.

Applicable rules: `BR-NOTIF-001`.

### FEAT-NOTIF-DELIVERY-003 — Retry transient email failure

The backend SHOULD support controlled retry of transient email delivery failures without creating uncontrolled duplicate messages.

Applicable rules: `BR-NOTIF-004`, `BR-NOTIF-008`.

### FEAT-NOTIF-DELIVERY-004 — Sensitive content minimization

Email content SHALL contain only information appropriate for the recipient and MUST NOT expose meeting-sensitive content the recipient is not authorized to access.

Applicable rules: `BR-NOTIF-005`.

---

# 25. User Settings Features

## 25.1 Personal Profile

### FEAT-SET-PROFILE-001 — View own profile

An authenticated user SHALL be able to view the user's own approved profile information.

### FEAT-SET-PROFILE-002 — Edit self-service profile fields

The product MAY allow users to edit non-privileged profile fields such as display name or avatar where supported.

A user SHALL NOT be able to grant themselves a higher organizational role or expand their management scope through self-service settings.

### FEAT-SET-PROFILE-003 — Managed identity fields

Fields controlled by organization administration MAY be read-only in self-service settings.

Exact editable fields belong to the approved data/security model.

## 25.2 Notification Preferences

### FEAT-SET-NOTIF-001 — Optional notification preferences

Where optional product email notifications are supported, the user MAY configure approved preferences.

Mandatory account/security communications SHALL ignore opt-out settings when required for safe account operation.

Applicable rules: `BR-NOTIF-006`.

### FEAT-SET-NOTIF-002 — Preference does not change business membership

Disabling optional meeting email SHALL NOT remove the user from the meeting or alter the canonical participant relationship.

## 25.3 Display Preferences

### FEAT-SET-DISPLAY-001 — Client display preferences

Web and Mobile MAY support appearance, layout, locale, or similar personal display preferences.

Display preferences SHALL NOT change canonical business state.

---

# 26. Meeting Minutes and Export Features

## 26.1 Meeting Minutes View

### FEAT-EXP-MINUTES-001 — Consolidated meeting minutes

For a processed meeting, the product SHALL be able to present a consolidated meeting-minutes representation containing approved available content such as:

- meeting metadata;
- summary;
- confirmed decisions;
- official action items;
- transcript reference or selected transcript content where approved;
- processing/review warnings when material.

The minutes view is a representation of canonical system data, not an independent source of truth.

Applicable rules: `BR-EXP-002`.

### FEAT-EXP-MINUTES-002 — Proposed content remains distinguishable

If proposed AI decisions or proposed action items are included in a minutes view, they SHALL be visibly separated from confirmed/official content.

Applicable rules: `BR-EXP-004`.

### FEAT-EXP-MINUTES-003 — Uncertainty is preserved

If unresolved transcript coverage materially limits the reliability of the minutes, the view SHOULD indicate the limitation.

Applicable rules: `BR-EXP-003`.

## 26.2 Export Formats

### FEAT-EXP-FILE-001 — Markdown export

The baseline SHALL support exporting meeting minutes in Markdown format for authorized users.

### FEAT-EXP-FILE-002 — PDF export

The baseline SHALL support exporting meeting minutes in PDF format for authorized users.

### FEAT-EXP-FILE-003 — Export authorization

Export SHALL be allowed only for content the requesting user is authorized to access.

Applicable rules: `BR-EXP-001`.

### FEAT-EXP-FILE-004 — Export does not mutate canonical data

Editing a downloaded Markdown/PDF file SHALL have no automatic effect on the system's meeting data.

Applicable rules: `BR-EXP-002`.

---

# 27. Web Application Functional Baseline

The Web application is the primary rich management surface.

The following capabilities are baseline Web responsibilities unless a later product decision explicitly changes them.

### FEAT-WEB-001 — Authentication

Web SHALL support sign-in, session continuity, sign-out, password recovery, and current-user context.

### FEAT-WEB-002 — Meeting management

Web SHALL support meeting list/detail, create, schedule, edit, cancel, participant management, and calendar views within authorization scope.

### FEAT-WEB-003 — Room management

Web SHALL support room viewing and authorized room administration.

### FEAT-WEB-004 — User administration

Web SHALL support authorized user/member and role-management workflows.

### FEAT-WEB-005 — Audio import

Web SHALL support importing approved source media and observing upload/processing status.

### FEAT-WEB-006 — Transcript review

Web SHALL provide the richest baseline transcript review experience, including timeline display, speaker mapping, authorized transcript correction, and quality/warning visibility.

### FEAT-WEB-007 — Meeting intelligence review

Web SHALL support summary, proposed/confirmed decisions, proposed/official action items, and appropriate review/confirmation flows.

### FEAT-WEB-008 — AI Assistant

Web SHALL support AI Assistant interaction over the user's authorized meeting knowledge.

### FEAT-WEB-009 — Dashboard

Web SHALL support personal dashboard behavior and authorized management dashboard behavior.

### FEAT-WEB-010 — Export

Web SHALL support approved meeting-minutes export functionality.

---

# 28. Mobile Application Functional Baseline

The Mobile application SHALL share the same business semantics as Web but MAY expose a focused feature set optimized for mobile usage.

### FEAT-MOB-001 — Authentication

Mobile SHALL support sign-in, authenticated session continuity, sign-out, password recovery navigation as appropriate, and current-user context.

### FEAT-MOB-002 — Schedule access

Mobile SHALL allow users to view their accessible upcoming and historical meetings through a mobile-appropriate schedule/list experience.

### FEAT-MOB-003 — Meeting detail

Mobile SHALL allow authorized users to view meeting metadata, participant information, meeting state, and available post-meeting artifacts appropriate to the device.

### FEAT-MOB-004 — Meeting recording

Mobile SHALL be a supported primary surface for capturing meeting audio when device permissions permit.

Completed recording SHALL use the committed post-recording processing pipeline.

### FEAT-MOB-005 — Upload status and recovery UX

Mobile SHOULD preserve a completed local recording long enough to retry upload after transient connectivity failure where platform constraints allow.

### FEAT-MOB-006 — Transcript and summary review

Mobile SHALL allow authorized users to view transcripts and summaries.

Advanced transcript correction MAY initially remain Web-focused if mobile editing quality would be inadequate, provided business semantics remain consistent.

### FEAT-MOB-007 — Action-item follow-up

Mobile SHALL allow users to view assigned action items and perform permitted execution-status updates such as starting or completing work.

### FEAT-MOB-008 — AI Assistant

Mobile SHOULD provide AI Assistant access within the same authorization and grounding rules as Web.

### FEAT-MOB-009 — Administrative scope

Full user administration, room administration, complex dashboard administration, and advanced transcript review MAY be Web-only in the initial release.

The absence of those Mobile screens SHALL NOT create alternate business semantics.

---

# 29. Near-Real-Time Transcription — Deferred Feature Boundary

Near-real-time transcription is a planned late-phase capability and is intentionally not fully specified in the initial baseline.

### FEAT-NRT-001 — Offline pipeline is sufficient for initial ASR acceptance

The product MAY reach initial production-oriented ASR acceptance without near-real-time transcription when the offline/post-recording pipeline satisfies the approved quality requirements.

Applicable rules: `BR-NRT-001`.

### FEAT-NRT-002 — Future live transcript is preliminary

When implemented, live/partial transcript output SHOULD be presented as preliminary unless an explicit finalization rule says otherwise.

Applicable rules: `BR-NRT-002`.

### FEAT-NRT-003 — Final transcript remains source-backed

A future live transcript SHALL NOT automatically replace the higher-quality final source-backed transcript when a post-meeting finalization pass is configured.

Applicable rules: `BR-NRT-003`.

### FEAT-NRT-004 — No weakening of core guarantees

Future streaming implementation MUST preserve source retention, authorization, explicit failure, and final transcript integrity.

Applicable rules: `BR-NRT-004`.

### FEAT-NRT-005 — Detailed streaming requirements intentionally deferred

The following are intentionally not baseline requirements yet:

- WebSocket/SSE transport selection;
- audio frame/chunk protocol;
- partial hypothesis replacement semantics;
- streaming diarization continuity;
- reconnect buffering;
- maximum live latency target;
- live-vs-final reconciliation algorithm;
- concurrent live-session capacity targets.

These SHALL be specified only when near-real-time implementation becomes an active project phase.

---

# 30. Explicitly Deferred or Non-Baseline Features

The following capabilities are not part of the current baseline unless added by later approved requirements:

- external anonymous meeting participants;
- public meeting share links;
- public transcript links;
- recurring meeting-series management;
- mandatory RSVP acceptance/decline workflow;
- Google Calendar synchronization;
- Microsoft 365/Outlook Calendar synchronization;
- direct Zoom/Google Meet/Microsoft Teams conferencing integration;
- cross-organization shared meetings;
- external customer/guest portal;
- automatic LLM-driven authoritative business-state transitions;
- live transcript as the sole final transcript;
- full Mobile administration parity with Web;
- arbitrary user-defined workflow automation;
- unrestricted Administrator access to all protected meeting content.

A deferred feature MUST NOT be partially invented inside an implementation task without first adding approved requirements.

---

# 31. Cross-Feature Functional Flows

## 31.1 Schedule-to-Knowledge Flow

The baseline system SHALL support the following coherent flow:

```text
Authenticated user
    ↓
Create or schedule meeting
    ↓
Validate time / room
    ↓
Add organizational participants
    ↓
Meeting occurs
    ↓
Record or import audio
    ↓
Accept source media
    ↓
Offline AI processing
    ↓
Coverage validation / recovery
    ↓
Timestamped transcript
    ↓
Diarization / speaker mapping
    ↓
Summary
    ↓
Proposed decisions
    ↓
Proposed action items
    ↓
Human review / confirmation
    ↓
Knowledge indexing
    ↓
Search / RAG / follow-up
```

No implementation should require users to manually re-enter the same authoritative meeting identity between these stages.

## 31.2 Historical Import Flow

The system SHALL support a workflow in which an authorized user creates or selects an appropriate historical meeting record, imports an existing recording, and obtains the same post-recording intelligence pipeline without requiring a live meeting session.

Applicable rules: `BR-MTG-LC-013`, `BR-MEDIA-001`.

## 31.3 Processing Failure Flow

If an AI stage fails:

1. the meeting occurrence remains historically valid;
2. successful upstream artifacts remain available;
3. failure/warning state becomes visible;
4. retry may be offered when allowed;
5. the user is not shown false completion;
6. unrelated official business entities are not duplicated by retry.

Applicable rules: `BR-AI-005`, `BR-AIP-003`, `BR-AIP-004`, `BR-AIP-006`.

## 31.4 Authorization Change Flow

If a user's role, participant relationship, or meeting-content permission changes:

1. future protected requests use current authorization;
2. previously cached client presentation does not override backend authorization;
3. RAG retrieval uses the new authorization scope;
4. historical attribution remains intact.

Applicable rules: `BR-ROLE-005`, `BR-PART-004`, `BR-RAG-001` through `BR-RAG-003`.

---

# 32. Feature Traceability Summary

| Feature Area | Primary Business Rules |
|---|---|
| Authentication / account access | `BR-ID-*`, `BR-ROLE-*`, `BR-NOTIF-*` |
| User / role management | `BR-ID-*`, `BR-ROLE-*`, `BR-AUTHZ-*` |
| Meetings | `BR-MTG-*`, `BR-MTG-LC-*`, `BR-CON-*` |
| Calendar / scheduling | `BR-SCH-*`, `BR-ROOM-*`, `BR-CON-*` |
| Rooms | `BR-ROOM-*`, `BR-SCH-*` |
| Participants | `BR-PART-*`, `BR-AUTHZ-*` |
| Recording / media import | `BR-MEDIA-*` |
| AI processing lifecycle | `BR-AI-*`, `BR-AIP-*` |
| Offline ASR | `BR-ASR-*`, `BR-TRN-*` |
| Diarization | `BR-DIAR-*` |
| Transcript review | `BR-TRN-*`, `BR-AI-*` |
| Summary | `BR-SUM-*`, `BR-AI-*` |
| Decisions | `BR-DEC-*`, `BR-AI-*` |
| Action items | `BR-ACT-*`, `BR-CON-*` |
| Search | `BR-SEARCH-*` |
| AI Assistant / RAG | `BR-RAG-*`, `BR-AUTHZ-*` |
| Notifications | `BR-NOTIF-*` |
| Dashboard | `BR-DASH-*` |
| Export | `BR-EXP-*` |
| Near-real-time future work | `BR-NRT-*` |

---

# 33. Baseline Functional Acceptance Scenarios

The following scenarios SHALL be usable as cross-team acceptance anchors.

## 33.1 Authentication scenario

1. Active user signs in with valid credentials.
2. Authenticated context becomes available.
3. User navigates protected product features.
4. Session can be renewed according to security policy.
5. User signs out.
6. Protected capabilities are no longer available in that session.

## 33.2 Password recovery scenario

1. User requests password recovery.
2. Product returns a non-enumerating response appropriate to security policy.
3. Eligible account receives a backend-generated recovery email.
4. User opens a valid recovery action.
5. User establishes a compliant new password.
6. Used/invalid recovery authorization cannot change the password again.

## 33.3 Meeting scheduling scenario

1. Authorized user creates a meeting.
2. User enters a valid schedule.
3. User selects an available room.
4. User adds organizational participants.
5. System validates authoritative room availability.
6. Meeting becomes scheduled.
7. Notification intents are created for affected participants.
8. Email failure, if any, does not invalidate the scheduled meeting.

## 33.4 Room-conflict scenario

1. Meeting A reserves Room X for an interval.
2. Another user attempts to schedule Meeting B in Room X with an overlapping interval.
3. The system rejects the conflicting authoritative reservation even if requests are concurrent.
4. Meeting B may be rescheduled or assigned another room.

## 33.5 Recording scenario

1. User opens an authorized meeting on a supported recording client.
2. User explicitly starts recording.
3. Recording state is clearly visible.
4. User stops recording.
5. Completed audio is preserved and submitted.
6. Upload failure does not silently destroy recoverable local audio where platform capability permits.
7. Submitted audio enters the same post-recording pipeline as imported audio.

## 33.6 Offline transcription recovery scenario

1. Valid audio is accepted.
2. Independent speech evidence identifies speech regions.
3. Bounded ASR processing produces transcript results.
4. A region contains hallucinated/suspicious output and later real speech is missing from ASR output.
5. Coverage validation detects the missing speech.
6. Recovery retries the region using changed processing context.
7. Successful recovered segments are reconciled into the final transcript.
8. An unrecoverable region remains explicitly unresolved rather than silently disappearing.

## 33.7 Transcript correction scenario

1. ASR coverage/recovery produces a reconciled timestamped candidate transcript.
2. The contextual correction stage sends the whole meeting candidate to the approved LLM when it fits supported limits.
3. The validated LLM-corrected result becomes the initial persisted/current transcript; raw Whisper text is not stored as a competing transcript.
4. An authorized editor later opens the transcript and identifies incorrect text or speaker mapping.
5. The editor corrects text and/or mapping through the appropriate separate actions.
6. Source-audio, processing, and human revision provenance remain intact.
7. The human-corrected value becomes the normal user-facing transcript value.
8. Affected derived artifacts may become stale or eligible for regeneration.

## 33.8 Decision confirmation scenario

1. AI extracts a proposed decision.
2. UI clearly shows `PROPOSED` state.
3. Authorized reviewer checks meeting evidence.
4. Reviewer confirms or rejects the proposal.
5. Only confirmed decision is treated as official decision data.

## 33.9 Action-item follow-up scenario

1. AI extracts proposed action item or authorized user creates one manually.
2. Proposed item is reviewed and receives valid assignee before confirmation.
3. Confirmed item becomes `OPEN`.
4. Assignee can view the item.
5. Assignee starts work, moving it to `IN_PROGRESS`.
6. Assignee completes work, moving it to `DONE`.
7. Completion remains attributable.
8. If due date passed before completion, UI derives overdue indication rather than changing canonical state.

## 33.10 RAG authorization scenario

1. User can access Meeting A but not Meeting B.
2. Both meetings have indexed knowledge.
3. User asks an Assistant question whose possible answer exists in both meetings.
4. Retrieval excludes Meeting B before answer generation.
5. Assistant answer uses only authorized evidence.
6. If Meeting A does not provide sufficient evidence, Assistant reports insufficient evidence rather than leaking Meeting B or fabricating the answer.

## 33.11 Downstream AI failure scenario

1. Transcript is completed successfully.
2. Summary generation fails.
3. Transcript remains accessible.
4. Meeting remains historically ended/completed as an occurrence.
5. Summary area shows failed/retryable state.
6. Retry does not require re-uploading source media or recreating the meeting.

## 33.12 Cancellation scenario

1. Scheduled meeting exists with room and participants.
2. Authorized user cancels meeting.
3. Meeting becomes `CANCELLED`.
4. Room reservation no longer blocks future scheduling.
5. Meeting history remains available according to authorization.
6. Notification intent is created.
7. SMTP failure does not restore the meeting to `SCHEDULED`.

---

# 34. Functional Definition of Done

A feature is not considered complete merely because a screen renders or one happy-path endpoint succeeds.

For a baseline feature to be considered functionally complete, the team SHOULD be able to demonstrate as applicable that:

1. authorized users can perform the intended action;
2. unauthorized users cannot obtain the protected outcome;
3. canonical states match `BUSINESS_RULES.md`;
4. invalid business transitions are rejected;
5. clients represent pending, success, warning, and failure states accurately;
6. retries do not produce uncontrolled duplicate official entities;
7. cross-client behavior remains semantically consistent;
8. historical provenance required by the feature is preserved;
9. AI-derived content is not confused with confirmed business truth;
10. long-running AI work does not falsely appear synchronous or complete;
11. offline transcription does not silently discard detected speech;
12. failure in downstream AI does not destroy valid upstream artifacts;
13. notification failure does not corrupt core business state;
14. RAG and search do not bypass authorization;
15. tests cover the feature's critical happy path, failure path, and applicable regression cases.

---

# 35. Relationship to Other Requirement Documents

## `PRODUCT.md`

Defines why the feature exists, who it serves, product scope, product principles, and high-level end-to-end journeys.

This file refines those capabilities into detailed functional behavior.

## `BUSINESS_RULES.md`

Defines canonical invariants, states, allowed transitions, ownership, conflict rules, and business authorization.

This file MUST reference those rules instead of creating alternate semantics.

## `ARCHITECTURE.md`

Will define which application/service owns each capability, synchronous/asynchronous boundaries, integration patterns, feature-first package baselines, processing topology, and technical failure isolation.

Architecture MUST make the behaviors in this file implementable without changing their meaning.

## `DATABASE.md`

Will define the canonical persistence model required to represent these features, state machines, provenance, versions, assignments, source media, transcript segments, and derived artifacts.

## `API.md`

Will define common API conventions and the baseline endpoint catalog needed to expose these feature capabilities.

`API.md` is not expected to restate all functional behavior from this file.

## `SECURITY.md`

Will define the technical controls required for authentication, access/refresh tokens, Secure HttpOnly cookies on Web, password security, session revocation, CSRF/CORS, authorization enforcement, SMTP credentials, file security, RAG isolation, rate limiting, secrets, logging, and data protection.

---

# 36. Final Functional Principle

The SME Meeting Assistant System SHALL implement features according to the following principle:

> **A feature is complete only when its user-visible behavior, authoritative business state, AI-derived outputs, failure handling, authorization, and downstream effects agree on what happened. The system must not rely on a screen, a model response, or a successful network call as a substitute for coherent product behavior.**
