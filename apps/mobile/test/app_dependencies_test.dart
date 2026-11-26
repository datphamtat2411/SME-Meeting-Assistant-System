import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/app_dependencies.dart';
import 'package:sme_meeting_assistant/core/appearance_preferences.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_repository.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_repository.dart';
import 'package:sme_meeting_assistant/features/recording/media_repository.dart';
import 'package:sme_meeting_assistant/features/recording/media_contracts.dart';
import 'package:sme_meeting_assistant/features/recording/processing_manager.dart';
import 'package:sme_meeting_assistant/features/recording/processing_repository.dart';
import 'package:sme_meeting_assistant/features/results/results_invalidation.dart';

import 'support/http_test_support.dart';
import 'support/meeting_test_support.dart';

void main() {
  test('processing outcomes invalidate once per meeting and session', () async {
    final client = MeetingTestHttpClient((request) async {
      throw StateError('Unexpected request ${request.url.path}');
    });
    final api = createMeetingTestApi(client);
    await signInMeetingTestApi(api);
    final manager = _ObservedProcessingManager(api);
    final dependencies = AppDependencies(
      api: api,
      appearancePreferences: InMemoryAppearancePreferences(),
      httpClient: client,
      processingManager: manager,
    );
    addTearDown(dependencies.shutdown);
    final actions = dependencies.actionItemInvalidation;
    final scope = api.requireAuthenticatedSessionScope();
    ProcessingMeetingState state(ProcessingJobStatus status) {
      final now = DateTime.utc(2026, 11, 26);
      return ProcessingMeetingState(
        meetingId: testMeetingId,
        sessionScope: scope,
        jobs: [
          ProcessingJobRecord(
            id: 'job-1',
            meetingId: testMeetingId,
            sourceMediaId: null,
            jobType: ProcessingJobType.offlineMeetingProcessing,
            status: status,
            requestedByUserId: null,
            currentStage: null,
            warningSummary: null,
            errorSummary: null,
            errorCode: null,
            retryable: false,
            retryCount: 0,
            reprocessOfJobId: null,
            queuedAt: null,
            startedAt: null,
            completedAt: null,
            createdAt: now,
            updatedAt: now,
            stageRuns: const [],
          ),
        ],
      );
    }

    manager.publish(state(ProcessingJobStatus.running));
    expect(actions.revision, 0);
    manager.publish(state(ProcessingJobStatus.waitingForReview));
    expect(actions.revision, 1);
    expect(actions.lastMeetingId, testMeetingId);
    manager.publish(state(ProcessingJobStatus.waitingForReview));
    expect(actions.revision, 1);
    manager.publish(state(ProcessingJobStatus.completed));
    expect(actions.revision, 2);
    expect(dependencies.resultsInvalidation.resources, {
      ResultsResourceKind.minutes,
    });

    await api.signOut();
    await api.signIn('user@example.test', 'password');
    final revision = actions.revision;
    manager.publish(state(ProcessingJobStatus.completed));
    expect(actions.revision, revision);
  });

  test('the dependency holder closes owned resources exactly once', () {
    final client = NoNetworkHttpClient();
    final api = TrackingApiClient(client);
    final dependencies = AppDependencies(
      api: api,
      appearancePreferences: InMemoryAppearancePreferences(),
      httpClient: client,
    );

    dependencies.dispose();
    dependencies.dispose();

    expect(api.disposeCalls, 1);
    expect(client.closeCalls, 1);
    expect(dependencies.meetings, isA<MeetingRepository>());
    expect(dependencies.meetingInvalidation.isDisposed, isTrue);
    expect(dependencies.isDisposed, isTrue);
  });

  test('Action Item invalidation scopes Minutes and session', () async {
    final client = MeetingTestHttpClient((request) async {
      throw StateError('Unexpected request ${request.url.path}');
    });
    final api = createMeetingTestApi(client);
    await signInMeetingTestApi(api);
    final dependencies = AppDependencies(
      api: api,
      appearancePreferences: InMemoryAppearancePreferences(),
      httpClient: client,
    );
    addTearDown(dependencies.shutdown);
    final actions = dependencies.actionItemInvalidation;
    final results = dependencies.resultsInvalidation;
    final scope = api.requireAuthenticatedSessionScope();
    final initial = results.revision;

    expect(
      actions.invalidate(sessionScope: scope, meetingId: testMeetingId),
      isTrue,
    );
    expect(results.revision, initial + 1);
    expect(results.meetingId, testMeetingId);
    expect(results.resources, {ResultsResourceKind.minutes});
    expect(actions.revision, 1);

    expect(actions.invalidate(sessionScope: scope), isTrue);
    expect(results.revision, initial + 2);
    expect(results.meetingId, isNull);
    expect(results.resources, {ResultsResourceKind.minutes});

    await api.signOut();
    await api.signIn('user@example.test', 'password');
    final nextRevision = results.revision;
    expect(
      actions.invalidate(sessionScope: scope, meetingId: testMeetingId),
      isFalse,
    );
    expect(results.revision, nextRevision);
    expect(results.resources, isEmpty);
  });

  test('the production composition factory injects its dependencies', () {
    final client = NoNetworkHttpClient();
    final credentials = InMemoryCredentialStorage();
    final preferences = InMemoryAppearancePreferences();
    final dependencies = AppDependencies.create(
      apiBaseUri: Uri.parse('https://api.example.test/api/v1'),
      httpClient: client,
      credentialStorage: credentials,
      appearancePreferences: preferences,
    );

    expect(
      dependencies.api.baseUri,
      Uri.parse('https://api.example.test/api/v1'),
    );
    expect(dependencies.appearancePreferences, same(preferences));
    expect(dependencies.meetings, isA<MeetingRepository>());
    expect(dependencies.recording.capabilityResolver, isNotNull);
    expect(dependencies.submissions.capabilityResolver, isNotNull);
    expect(dependencies.processingManager.capabilityResolver, isNotNull);

    dependencies.dispose();
    expect(client.closeCalls, 1);
  });

  test(
    'composes meeting repositories over one API and invalidation signal',
    () {
      final client = NoNetworkHttpClient();
      final api = ApiClient(
        baseUri: Uri.parse('https://api.example.test/api/v1'),
        httpClient: client,
        credentialStorage: InMemoryCredentialStorage(),
      );
      final dependencies = AppDependencies(
        api: api,
        appearancePreferences: InMemoryAppearancePreferences(),
        httpClient: client,
      );

      expect(dependencies.meetings.api, same(api));
      expect(dependencies.roomScheduling.api, same(api));
      expect(dependencies.participantCandidates.api, same(api));
      expect(dependencies.meetingMembership.api, same(api));
      expect(
        dependencies.meetingMembership.meetings,
        same(dependencies.meetings),
      );
      expect(
        dependencies.meetingMembership.invalidation,
        same(dependencies.meetingInvalidation),
      );
      dependencies.dispose();
    },
  );

  test(
    'shutdown keeps shared transport open until processing observation drains',
    () async {
      final mediaResponse = Completer<http.StreamedResponse>();
      final processingResponse = Completer<http.StreamedResponse>();
      final client = _ClosingMeetingHttpClient((request) {
        if (request.url.path.endsWith('/media')) return mediaResponse.future;
        if (request.url.path.endsWith('/processing-jobs')) {
          return processingResponse.future;
        }
        throw StateError('Unexpected request ${request.url.path}');
      });
      final api = createMeetingTestApi(client);
      await signInMeetingTestApi(api);
      final manager = ProcessingManager(
        api: api,
        mediaRepository: MediaRepository(api: api),
        processingRepository: ProcessingRepository(api: api),
        localMedia: LocalMediaRepository.lazyDefault(),
      );
      final dependencies = AppDependencies(
        api: api,
        appearancePreferences: InMemoryAppearancePreferences(),
        httpClient: client,
        processingManager: manager,
      );
      addTearDown(dependencies.shutdown);

      final refresh = manager.refresh(
        testMeetingId,
        scope: api.requireAuthenticatedSessionScope(),
        explicit: true,
      );
      await _eventually(
        () =>
            client.requests.any(
              (request) => request.url.path.endsWith('/media'),
            ) &&
            client.requests.any(
              (request) => request.url.path.endsWith('/processing-jobs'),
            ),
      );

      dependencies.dispose();
      expect(client.closeCalls, 0);

      mediaResponse.complete(await meetingApiSuccess(const <dynamic>[]));
      processingResponse.complete(await meetingApiSuccess(const <dynamic>[]));
      await refresh;
      await dependencies.shutdown();

      expect(client.closeCalls, 1);
    },
  );

  test(
    'bounded shutdown defers persistence close until actual drain',
    () async {
      final client = NoNetworkHttpClient();
      final api = TrackingApiClient(client);
      final localMedia = _TrackingLocalMedia();
      final manager = _DelayedDrainManager(api, localMedia);
      final dependencies = AppDependencies(
        api: api,
        appearancePreferences: InMemoryAppearancePreferences(),
        httpClient: client,
        localMedia: localMedia,
        processingManager: manager,
      );

      await dependencies.shutdown();
      expect(client.closeCalls, 1);
      expect(localMedia.closeCalls, 0);

      manager.drained.complete();
      await localMedia.closed.future;
      expect(localMedia.closeCalls, 1);
    },
  );
}

Future<void> _eventually(bool Function() condition) async {
  for (var attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await Future<void>.value();
  }
  fail('The expected processing request was not started.');
}

class TrackingApiClient extends ApiClient {
  int disposeCalls = 0;

  TrackingApiClient(NoNetworkHttpClient client)
    : super(
        baseUri: Uri.parse('https://api.example.test/api/v1'),
        httpClient: client,
        credentialStorage: InMemoryCredentialStorage(),
      );

  @override
  void dispose() {
    disposeCalls++;
    super.dispose();
  }
}

class _ClosingMeetingHttpClient extends MeetingTestHttpClient {
  _ClosingMeetingHttpClient(super.onMeetingRequest);

  int closeCalls = 0;

  @override
  void close() {
    closeCalls++;
    super.close();
  }
}

class _TrackingLocalMedia extends LocalMediaRepository {
  _TrackingLocalMedia() : super.lazyDefault();

  int closeCalls = 0;
  final closed = Completer<void>();

  @override
  Future<void> dispose() async {
    closeCalls++;
    await super.dispose();
    closed.complete();
  }
}

class _DelayedDrainManager extends ProcessingManager {
  _DelayedDrainManager(ApiClient api, LocalMediaRepository localMedia)
    : super(
        api: api,
        localMedia: localMedia,
        mediaRepository: MediaRepository(api: api),
        processingRepository: ProcessingRepository(api: api),
      );

  final drained = Completer<void>();

  @override
  bool get hasActiveWork => !drained.isCompleted;

  @override
  Future<void> shutdown() async {}

  @override
  Future<void> drainActiveWork() => drained.future;
}

class _ObservedProcessingManager extends ProcessingManager {
  _ObservedProcessingManager(ApiClient api)
    : super(
        api: api,
        mediaRepository: MediaRepository(api: api),
        processingRepository: ProcessingRepository(api: api),
        localMedia: LocalMediaRepository.lazyDefault(),
      );

  List<ProcessingMeetingState> _observed = [];

  @override
  Iterable<ProcessingMeetingState> get currentStates => _observed;

  void publish(ProcessingMeetingState state) {
    _observed = [state];
    notifyListeners();
  }
}
