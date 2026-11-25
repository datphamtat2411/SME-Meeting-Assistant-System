import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/app_dependencies.dart';
import 'package:sme_meeting_assistant/core/appearance_preferences.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_repository.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_repository.dart';
import 'package:sme_meeting_assistant/features/recording/media_repository.dart';
import 'package:sme_meeting_assistant/features/recording/processing_manager.dart';
import 'package:sme_meeting_assistant/features/recording/processing_repository.dart';

import 'support/http_test_support.dart';
import 'support/meeting_test_support.dart';

void main() {
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
