# Mobile delivery and integration readiness

This is the execution map for the Flutter app shipped in the mobile/rush-mobile
branch. It distinguishes implemented client capabilities from server-owned
business behavior and from work that still needs end-to-end validation.

## How to run

From the repository root:

    cd apps/mobile
    bash tool/bootstrap.sh
    flutter analyze lib
    flutter run --dart-define=API_BASE_URL=https://YOUR-API-HOST/api/v1

The bootstrap script generates Android/iOS runner templates for the selected
Flutter SDK and configures the device microphone permission. An Android emulator
can use http://10.0.2.2:8080/api/v1 for local development. A physical phone
needs a routable host or tunnel address. Production must use HTTPS. Provide a
running and authorized Core API; the app does not contain an offline mock server.

GitHub Actions publishes the debug Android APK as an artifact of successful
Mobile Flutter build runs. A debug APK is not a release signing, store submission,
or real-device acceptance result.

## Functional integration map

| Feature area | Mobile behavior | Required API |
| --- | --- | --- |
| Foundation | Responsive navigation, page states, light/dark, safe error reporting | Core API |
| Auth/session | Email sign-in, refresh rotation, session restore retry, logout, setup and recovery forms | auth endpoints; auth transport feature enabled |
| Profile | Self profile update with ETag, notification email flags, locale and timezone | me/profile, me/preferences |
| Meetings | Search/filter/list/calendar, create, edit, lifecycle, attendee list/edit | meetings, users/meeting-candidates |
| Room booking | Availability suggestions and non-binding conflict previews | rooms/availability, meeting-schedule-checks |
| Recordings | Explicit microphone start/stop, file selection, recoverable local drafts, signed upload progress | media uploads/finalize, object storage |
| Processing | Async job admissions, retry, stage information and automatic status polling | processing-jobs |
| Results | Transcript corrections, speaker mapping, summary version control, regenerate admission, decision review | transcript, speaker-clusters, summary, decisions |
| Minutes | Canonical official minutes, quality warnings, official actions | meetings/{id}/minutes |
| Action items | Paginated filters, assignee lookup, manual create/edit, lifecycle transitions | action-items, meeting-candidates |
| Assistant | Conversation selection, message display, citation list and protected request UI | assistant/conversations (not yet present in checked Core backend) |

Server authorization is authoritative for every call. The mobile UI never
converts AI proposals into official decisions/actions without authorized
server commands. A 202 processing response is only admission; the app continues
to display durable job state and warnings.

## API and data integrity

- Public Core API envelope uses success/code/message/data/meta and
  meta.pagination for zero-based paginated lists.
- Strong If-Match is passed for meeting, action-item, summary, speaker and
  transcript changes. Conflicts must be refetched rather than overwritten.
- Mobile X-Auth-Transport is set only for Core API calls. Bearer access stays
  in process memory; rotating refresh credentials use platform secure storage.
  A transient network outage during restore does not erase those credentials.
- Media upload URLs are short-lived capabilities: direct PUT sends only the
  specified Content-Type, never bearer tokens or cookies.
- Local microphone recordings are preserved in the app documents directory;
  a bounded encrypted index records their private paths for recoverability.
  This is **not** an encrypted audio vault. Device encryption and appropriate
  endpoint data-handling policies remain necessary.
- Times submitted to Core API are offset-qualified UTC ISO 8601 instants;
  visual labels are localized to the current device time zone.
- The currently checked backend does not expose Assistant conversation
  endpoints. Mobile must show an unsupported state; AI responses and evidence
  must never be faked. Some export/recovery features remain backend gated.

## Before treating this as production-ready

1. Test on a physical Android device with live backend, network loss and
   microphone permission denied/revoked; verify retained recording recovery.
2. Validate live Spring Boot user role/meeting policies, action-item transitions,
   ETag revisions, pagination, participant assignments and schedule conflicts.
3. Test long recordings (size cap, network interruption, signed upload expiry,
   corrupted format, background handling) against the configured S3 adapter.
4. Verify transcript speaker and correction permissions, Summary state,
   provenance, AI quality warnings and official Minutes consistency.
5. Complete and expose the authenticated Assistant API if that product feature
   must work end to end; validate source access and citations.
6. Review TLS, credential rotation, device storage, PII retention, audio consent
   policy, audit logging, and accessibility with stakeholders.
7. Perform device and iOS compilation/signing checks. CI currently confirms
   Flutter analyze + Android debug APK, not iOS release certification.
8. Run formal acceptance and regression validation before real user rollout.

No additional test cases were committed, as requested in the original scope.
