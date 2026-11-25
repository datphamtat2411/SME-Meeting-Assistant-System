import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/meeting_models.dart';
import 'package:sme_meeting_assistant/core/models.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_invalidation.dart';
import 'package:sme_meeting_assistant/features/results/results_invalidation.dart';
import 'package:sme_meeting_assistant/features/results/results_models.dart';
import 'package:sme_meeting_assistant/features/results/results_mutation_coordinator.dart';
import 'package:sme_meeting_assistant/features/results/results_repository.dart';
import 'package:sme_meeting_assistant/features/results/results_workspace_controller.dart';

import 'support/meeting_test_support.dart';

class _Repository extends ResultsRepository {
  _Repository(super.api);
  int reads = 0;
  bool access = true;
  Completer<Transcript>? pending;
  ApiFailure? readFailure;
  String? submittedTag;
  Completer<ApiResult>? mutation;

  @override
  Future<Transcript> currentTranscript({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
  }) async {
    reads++;
    final failure = readFailure;
    if (failure != null) throw failure;
    return pending == null ? _transcript : await pending!.future;
  }

  @override
  Future<bool> verifyReadAccess({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
  }) async => access;

  @override
  Future<ApiResult> mapSpeaker({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
    required String clusterId,
    required String transcriptEtag,
    required String? userId,
  }) async {
    submittedTag = transcriptEtag;
    return mutation == null
        ? const ApiResult({}, {}, '"mapped"')
        : await mutation!.future;
  }
}

const _transcript = Transcript(
  id: 'transcript-1',
  meetingId: testMeetingId,
  sourceMediaId: null,
  processingJobId: null,
  versionNumber: 1,
  languageCode: 'vi',
  status: 'READY',
  durationMs: null,
  finalizedAt: null,
  contentRevision: 1,
  segments: [],
  etag: '"transcript-reviewed"',
);

const _speaker = SpeakerCluster(
  id: 'speaker-1', label: 'SPEAKER_01', userId: null, displayName: null,
);

const _review = SpeakerReviewSnapshot(
  transcriptId: 'transcript-1',
  etag: '"old-reviewed-token"',
  clusters: [_speaker],
);

Future<({ResultsWorkspaceController workspace, _Repository repository})> _setup() async {
  final api = createMeetingTestApi(MeetingTestHttpClient((request) async {
    throw StateError('Unexpected request ${request.url.path}');
  }));
  await signInMeetingTestApi(api);
  final meetings = MeetingInvalidationSignal(api);
  final invalidation = ResultsInvalidationSignal(api: api, meetingInvalidation: meetings);
  final repository = _Repository(api);
  final workspace = ResultsWorkspaceController(
    api: api,
    repository: repository,
    meetingId: testMeetingId,
    meeting: Meeting.fromJson(meetingTestJson()),
    capabilities: const ResultsCapabilities(canRead: true, canMutate: true),
    invalidation: invalidation,
  );
  addTearDown(() {
    workspace.dispose();
    invalidation.dispose();
    meetings.dispose();
    api.dispose();
  });
  return (workspace: workspace, repository: repository);
}

void main() {
  test('read revocation fences a delayed successful response', () async {
    final (:workspace, :repository) = await _setup();
    repository.pending = Completer<Transcript>();
    final loading = workspace.loadTranscript();
    workspace.updateCapabilities(const ResultsCapabilities(canRead: false, canMutate: false));
    repository.pending!.complete(_transcript);
    await loading;
    expect(workspace.transcript.data, isNull);
    expect(workspace.transcript.phase, ResultsResourcePhase.forbidden);
  });

  test('read denial drops cached protected data', () async {
    final (:workspace, :repository) = await _setup();
    await workspace.loadTranscript();
    expect(workspace.transcript.data, isNotNull);
    repository.readFailure = const ApiFailure(403, 'FORBIDDEN', 'Denied');
    await workspace.loadTranscript(force: true);
    expect(workspace.transcript.data, isNull);
    expect(workspace.capabilities.canRead, isFalse);
  });

  test('concealed not-found rechecks access instead of retaining data', () async {
    final (:workspace, :repository) = await _setup();
    await workspace.loadTranscript();
    repository.readFailure = const ApiFailure(404, 'NOT_FOUND', 'Unavailable');
    repository.access = false;
    await workspace.loadTranscript(force: true);
    expect(workspace.transcript.data, isNull);
    expect(workspace.capabilities.canRead, isFalse);
  });

  test('authorized not-found remains absent and does not revoke other access', () async {
    final (:workspace, :repository) = await _setup();
    repository.readFailure = const ApiFailure(404, 'NOT_FOUND', 'Unavailable');
    await workspace.loadTranscript();
    expect(workspace.transcript.phase, ResultsResourcePhase.notReady);
    expect(workspace.capabilities.canRead, isTrue);
  });

  test('empty loaded resources are reused until explicit refresh', () async {
    final (:workspace, :repository) = await _setup();
    await workspace.loadTranscript();
    await workspace.loadTranscript();
    expect(repository.reads, 1);
    await workspace.loadTranscript(force: true);
    expect(repository.reads, 2);
  });

  test('inactive invalidated resource reloads on next access', () async {
    final (:workspace, :repository) = await _setup();
    await workspace.loadTranscript();
    workspace.invalidation.invalidate(
      sessionScope: workspace.sessionScope, meetingId: testMeetingId,
      resources: {ResultsResourceKind.transcript},
    );
    expect(repository.reads, 1);
    await workspace.loadTranscript();
    expect(repository.reads, 2);
  });

  test('speaker command uses the reviewed token and rejects duplicate dispatch', () async {
    final (:workspace, :repository) = await _setup();
    await workspace.loadTranscript();
    repository.mutation = Completer<ApiResult>();
    final epoch = workspace.reviewEpoch;
    final first = workspace.mapSpeaker(_review, _speaker.id, null, epoch: epoch);
    await expectLater(
      workspace.mapSpeaker(_review, _speaker.id, null, epoch: epoch),
      throwsA(isA<ApiFailure>()),
    );
    expect(repository.submittedTag, _review.etag);
    repository.mutation!.complete(const ApiResult({}, {}, '"mapped"'));
    await first;
  });

  test('old review epoch cannot dispatch after access is restored', () async {
    final (:workspace, :repository) = await _setup();
    final epoch = workspace.reviewEpoch;
    workspace.updateCapabilities(const ResultsCapabilities(canRead: false, canMutate: false));
    workspace.updateCapabilities(const ResultsCapabilities(canRead: true, canMutate: true));
    await expectLater(
      workspace.mapSpeaker(_review, _speaker.id, null, epoch: epoch),
      throwsA(isA<ApiFailure>()),
    );
    expect(repository.submittedTag, isNull);
  });

  test('uncertain regeneration retains key until admission is confirmed', () {
    final commands = ResultsMutationCoordinator();
    final key = commands.regenerationKey();
    commands.recordFailure(const ApiFailure(0, 'TIMEOUT', 'Unknown',
      remoteOutcomeAmbiguous: true));
    expect(commands.regenerationKey(), key);
    commands.recordFailure(const ApiFailure(429, 'RATE_LIMIT', 'Retry later'));
    expect(commands.regenerationKey(), key);
    commands.recordAdmission('job-1');
    expect(commands.acceptedRegenerationJobId, 'job-1');
    expect(commands.regenerationUncertain, isFalse);
    expect(commands.regenerationKey(), isNot(key));
  });
}
