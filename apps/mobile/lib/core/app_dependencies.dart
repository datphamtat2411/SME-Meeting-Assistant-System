import 'package:http/http.dart' as http;

import 'api_client.dart';
import 'models.dart';
import 'appearance_preferences.dart';

import 'package:sme_meeting_assistant/features/meetings/meeting_invalidation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_creation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_membership.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_repository.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_scheduling.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_foundation.dart';
import 'package:sme_meeting_assistant/features/meetings/participant_selection.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_repository.dart';
import 'package:sme_meeting_assistant/features/recording/media_repository.dart';
import 'package:sme_meeting_assistant/features/recording/processing_repository.dart';
import 'package:sme_meeting_assistant/features/recording/processing_manager.dart';
import 'package:sme_meeting_assistant/features/recording/recording_coordinator.dart';
import 'package:sme_meeting_assistant/features/recording/submission_coordinator.dart';

/// The application-scoped dependency holder and resource owner.
///
/// The HTTP client is created once, passed to the API service, and closed here.
/// ApiClient deliberately does not close the shared client.
class AppDependencies {
  final ApiClient api;
  final AppearancePreferences appearancePreferences;
  final http.Client httpClient;
  late final MeetingInvalidationSignal meetingInvalidation;
  late final MeetingRepository meetings;
  late final RoomSchedulingRepository roomScheduling;
  late final ParticipantCandidateRepository participantCandidates;
  late final MeetingMembershipRepository meetingMembership;
  late final MeetingCreationRecoveryStore meetingCreationRecovery;
  late final LocalMediaRepository localMedia;
  late final MediaRepository media;
  late final ProcessingRepository processing;
  late final RecordingCoordinator recording;
  late final SubmissionCoordinator submissions;
  late final ProcessingManager processingManager;
  bool _disposed = false;

  AppDependencies({
    required this.api,
    required this.appearancePreferences,
    required this.httpClient,
    LocalMediaRepository? localMedia,
    RecordingCoordinator? recording,
    SubmissionCoordinator? submissions,
    ProcessingManager? processingManager,
  }) {
    this.localMedia = localMedia ?? LocalMediaRepository.lazyDefault();
    meetingInvalidation = MeetingInvalidationSignal(api);
    meetings = MeetingRepository(api: api, invalidation: meetingInvalidation);
    roomScheduling = RoomSchedulingRepository(api);
    participantCandidates = ParticipantCandidateRepository(api);
    meetingMembership = MeetingMembershipRepository(
      api: api,
      meetings: meetings,
      invalidation: meetingInvalidation,
    );
    meetingCreationRecovery = MeetingCreationRecoveryStore(
      storage: api.credentialStorage,
      deployment: api.baseUri,
    );
    media = MediaRepository(api: api);
    processing = ProcessingRepository(api: api);
    this.recording =
        recording ??
        RecordingCoordinator(
          api: api,
          localMedia: this.localMedia,
          capabilityResolver: _resolveRecordingAuthorization,
        );
    this.submissions =
        submissions ??
        SubmissionCoordinator(
          api: api,
          localMedia: this.localMedia,
          mediaRepository: media,
          processingRepository: processing,
          capabilityResolver: _resolveRecordingAuthorization,
        );
    this.processingManager =
        processingManager ??
        ProcessingManager(
          api: api,
          mediaRepository: media,
          processingRepository: processing,
          localMedia: this.localMedia,
          capabilityResolver: _resolveProcessingCapability,
        );
  }

  Future<RecordingAuthorizationContext?> _resolveRecordingAuthorization(
    String meetingId,
    AuthenticatedSessionScope scope,
  ) async {
    if (!api.isCurrentAuthenticatedSession(scope)) return null;
    try {
      final snapshot = await meetings.detail(meetingId);
      if (!api.isCurrentAuthenticatedSession(scope) ||
          snapshot.sessionScope != scope ||
          snapshot.meeting.id.toLowerCase() != meetingId.toLowerCase()) {
        return null;
      }
      return RecordingAuthorizationContext(
        capabilities: MeetingCapabilityPolicy.evaluate(
          callerId: scope.userId,
          meeting: snapshot.meeting,
        ),
        status: snapshot.meeting.lifecycleStatus ?? MeetingStatus.cancelled,
      );
    } on Object {
      // A missing or stale verified meeting snapshot is fail-closed. The
      // backend remains the final authorization authority for mutations.
      return null;
    }
  }

  Future<MeetingCapabilities?> _resolveProcessingCapability(
    String meetingId,
    AuthenticatedSessionScope scope,
  ) async {
    final authorization = await _resolveRecordingAuthorization(
      meetingId,
      scope,
    );
    return authorization?.capabilities;
  }

  factory AppDependencies.create({
    required Uri apiBaseUri,
    http.Client? httpClient,
    CredentialStorage? credentialStorage,
    AppearancePreferences? appearancePreferences,
    LocalMediaRepository? localMedia,
  }) {
    final client = httpClient ?? http.Client();
    try {
      final api = ApiClient(
        baseUri: apiBaseUri,
        httpClient: client,
        credentialStorage: credentialStorage ?? const SecureCredentialStorage(),
      );
      return AppDependencies(
        api: api,
        appearancePreferences:
            appearancePreferences ?? SharedPreferencesAppearancePreferences(),
        httpClient: client,
        localMedia: localMedia,
      );
    } catch (_) {
      client.close();
      rethrow;
    }
  }

  bool get isDisposed => _disposed;

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    meetingInvalidation.dispose();
    processingManager.dispose();
    submissions.dispose();
    recording.dispose();
    localMedia.close();
    try {
      api.dispose();
    } finally {
      httpClient.close();
    }
  }
}
