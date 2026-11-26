import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'api_client.dart';
import 'models.dart';
import 'appearance_preferences.dart';

import 'package:sme_meeting_assistant/features/action_items/action_item_invalidation.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_repository.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_workflows.dart';
import 'package:sme_meeting_assistant/features/assistant/assistant_repository.dart';
import 'package:sme_meeting_assistant/features/assistant/assistant_workspace_controller.dart';
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
import 'package:sme_meeting_assistant/features/results/results_invalidation.dart';
import 'package:sme_meeting_assistant/features/results/results_repository.dart';

/// The application-scoped dependency holder and resource owner.
///
/// The HTTP client is created once, passed to the API service, and closed here.
/// ApiClient deliberately does not close the shared client.
class AppDependencies {
  final ApiClient api;
  final AppearancePreferences appearancePreferences;
  final http.Client httpClient;
  late final ActionItemInvalidationSignal actionItemInvalidation;
  late final ActionItemRepository actionItems;
  late final AssistantRepository assistant;
  AssistantWorkspaceController? _assistantWorkspace;

  AssistantWorkspaceController get assistantWorkspace {
    if (_disposed) throw StateError('Application dependencies disposed.');
    final existing = _assistantWorkspace;
    if (existing != null && existing.current) return existing;
    existing?.dispose();
    return _assistantWorkspace = AssistantWorkspaceController(
      assistant,
      verifyMeetingReadAccess: results.verifyReadAccess,
    );
  }

  /// Purge a known inaccessible meeting without creating a new workspace.
  void forgetAssistantMeeting(AuthenticatedSessionScope scope, String meetingId) {
    final owner = _assistantWorkspace;
    if (owner != null && owner.scope == scope && owner.current) {
      owner.forgetMeeting(meetingId);
    }
  }

  late final ActionItemWorkflowOwner actionItemWorkflows;
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
  late final ResultsRepository results;
  late final ResultsInvalidationSignal resultsInvalidation;
  AuthenticatedSessionScope? _processingOutcomeScope;
  final Map<(String, String), String> _processingOutcomes = {};
  bool _disposed = false;
  bool _resourcesClosed = false;
  Future<void>? _shutdownFuture;

  AppDependencies({
    required this.api,
    required this.appearancePreferences,
    required this.httpClient,
    LocalMediaRepository? localMedia,
    RecordingCoordinator? recording,
    SubmissionCoordinator? submissions,
    ProcessingManager? processingManager,
  }) {
    assistant = AssistantRepository(api: api);
    this.localMedia = localMedia ?? LocalMediaRepository.lazyDefault();
    meetingInvalidation = MeetingInvalidationSignal(api);
    resultsInvalidation = ResultsInvalidationSignal(
      api: api,
      meetingInvalidation: meetingInvalidation,
      processingMinutesHandledExternally: true,
    );
    meetings = MeetingRepository(api: api, invalidation: meetingInvalidation);
    roomScheduling = RoomSchedulingRepository(api);
    participantCandidates = ParticipantCandidateRepository(api);
    actionItemInvalidation = ActionItemInvalidationSignal(api);
    actionItemInvalidation.addListener(_invalidateActionItemMinutes);
    actionItems = ActionItemRepository(
      api: api,
      invalidation: actionItemInvalidation,
      participantCandidates: participantCandidates,
    );
    actionItemWorkflows = ActionItemWorkflowOwner(actionItems);
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
    results = ResultsRepository(
      api,
      meetings: meetings,
      membership: meetingMembership,
    );
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
    this.processingManager.addListener(_observeActionItemProcessing);
    api.sessionCoordinator.addListener(_resetProcessingOutcomeScope);
    meetingInvalidation.addListener(_invalidateAssistantMeeting);
    resultsInvalidation.addListener(_invalidateAssistantResults);
    actionItemInvalidation.addListener(_invalidateAssistantActionItem);
    _observeActionItemProcessing();
  }

  void _invalidateAssistantMeeting() {
    final owner = _assistantWorkspace;
    if (owner != null && meetingInvalidation.sessionScope == owner.scope) {
      owner.invalidateMeeting(meetingInvalidation.lastMeetingId);
    }
  }

  void _invalidateAssistantResults() {
    final owner = _assistantWorkspace;
    if (owner != null && resultsInvalidation.sessionScope == owner.scope) {
      owner.invalidateMeeting(resultsInvalidation.meetingId);
    }
  }

  void _invalidateAssistantActionItem() {
    final owner = _assistantWorkspace;
    if (owner != null && actionItemInvalidation.sessionScope == owner.scope) {
      owner.invalidateMeeting(actionItemInvalidation.lastMeetingId);
    }
  }

  void _resetProcessingOutcomeScope() {
    final scope = api.authenticatedSessionScope;
    if (scope == _processingOutcomeScope) return;
    _processingOutcomeScope = scope;
    _processingOutcomes.clear();
  }

  void _observeActionItemProcessing() {
    if (_disposed) return;
    _resetProcessingOutcomeScope();
    final scope = _processingOutcomeScope;
    if (scope == null) return;
    final affected = <String>{};
    for (final state in processingManager.currentStates) {
      if (state.sessionScope != scope ||
          state.failure != null ||
          state.isRefreshing) {
        continue;
      }
      for (final job in state.jobs) {
        if (!job.status.isTerminal && !job.isWaitingForReview) continue;
        final key = (state.meetingId.toLowerCase(), job.id);
        final outcome = '${job.status.wireValue}:${job.retryCount}';
        if (_processingOutcomes[key] == outcome) continue;
        _processingOutcomes[key] = outcome;
        affected.add(state.meetingId);
      }
    }
    for (final meetingId in affected) {
      actionItemInvalidation.invalidate(
        sessionScope: scope,
        meetingId: meetingId,
      );
    }
  }

  void _invalidateActionItemMinutes() {
    final scope = actionItemInvalidation.sessionScope;
    if (_disposed || scope == null || actionItemInvalidation.revision == 0) {
      return;
    }
    resultsInvalidation.invalidate(
      sessionScope: scope,
      meetingId: actionItemInvalidation.lastMeetingId,
      resources: const {ResultsResourceKind.minutes},
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
    processingManager.removeListener(_observeActionItemProcessing);
    api.sessionCoordinator.removeListener(_resetProcessingOutcomeScope);
    _processingOutcomes.clear();
    meetingInvalidation.removeListener(_invalidateAssistantMeeting);
    resultsInvalidation.removeListener(_invalidateAssistantResults);
    actionItemInvalidation.removeListener(_invalidateAssistantActionItem);
    _assistantWorkspace?.dispose();
    _assistantWorkspace = null;
    actionItemWorkflows.dispose();
    actionItemInvalidation.removeListener(_invalidateActionItemMinutes);
    actionItemInvalidation.dispose();
    // Fence every producer before releasing shared transport or local
    // persistence. If nothing is active, the close path runs synchronously
    // through the first await so Flutter's existing State.dispose contract
    // remains compatible; active work uses the awaitable shutdown path.
    recording.beginShutdown();
    submissions.beginShutdown();
    processingManager.beginShutdown();
    if (!recording.hasActiveWork &&
        !submissions.hasActiveWork &&
        !processingManager.hasActiveWork) {
      _shutdownFuture = _closeResources();
      return;
    }
    _shutdownFuture = _finishShutdown();
  }

  Future<void> shutdown() {
    if (!_disposed) {
      dispose();
    }
    return _shutdownFuture ?? Future<void>.value();
  }

  Future<void> _finishShutdown() async {
    try {
      await Future.wait(<Future<void>>[
        recording.shutdown(),
        submissions.shutdown(),
        processingManager.shutdown(),
      ]);
    } finally {
      // A timed-out Future still runs. Capture actual command ownership before
      // disposing the coordinators (which can clear their in-flight maps).
      final hasPendingCleanup =
          recording.hasActiveWork ||
          submissions.hasActiveWork ||
          processingManager.hasActiveWork;
      final drain = hasPendingCleanup
          ? Future.wait<void>([
              recording.drainActiveWork(),
              submissions.drainActiveWork(),
              processingManager.drainActiveWork(),
            ]).then<void>((_) {})
          : null;
      await _closeResources(drain: drain);
    }
  }

  Future<void> _closeResources({Future<void>? drain}) async {
    if (_resourcesClosed) return;
    _resourcesClosed = true;
    resultsInvalidation.dispose();
    meetingInvalidation.dispose();
    processingManager.dispose();
    submissions.dispose();
    recording.dispose();
    try {
      api.dispose();
    } finally {
      httpClient.close();
    }
    if (drain == null) {
      await localMedia.dispose();
      return;
    }
    // Network closure is bounded, but persistence must remain available to
    // original owned cleanup until it settles. The owner is already fenced.
    unawaited(
      drain.then<void>((_) => localMedia.dispose()).catchError((
        Object error,
        StackTrace stack,
      ) {
        FlutterError.reportError(
          FlutterErrorDetails(exception: error, stack: stack),
        );
      }),
    );
  }
}
