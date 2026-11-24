import 'package:http/http.dart' as http;

import 'api_client.dart';
import 'appearance_preferences.dart';

import 'package:sme_meeting_assistant/features/meetings/meeting_invalidation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_creation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_membership.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_repository.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_scheduling.dart';
import 'package:sme_meeting_assistant/features/meetings/participant_selection.dart';

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
  bool _disposed = false;

  AppDependencies({
    required this.api,
    required this.appearancePreferences,
    required this.httpClient,
  }) {
    meetingInvalidation = MeetingInvalidationSignal(api);
    meetingCreationRecovery = MeetingCreationRecoveryStore(
      storage: api.credentialStorage,
      deployment: api.baseUri,
    );
    meetings = MeetingRepository(api: api, invalidation: meetingInvalidation);
    roomScheduling = RoomSchedulingRepository(api);
    participantCandidates = ParticipantCandidateRepository(api);
    meetingMembership = MeetingMembershipRepository(
      api: api,
      meetings: meetings,
      invalidation: meetingInvalidation,
    );
  }

  factory AppDependencies.create({
    required Uri apiBaseUri,
    http.Client? httpClient,
    CredentialStorage? credentialStorage,
    AppearancePreferences? appearancePreferences,
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
    try {
      api.dispose();
    } finally {
      httpClient.close();
    }
  }
}
