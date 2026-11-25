import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/core/app_dependencies.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_detail_page.dart';
import 'package:sme_meeting_assistant/features/results/summary_history_controller.dart';
import 'package:sme_meeting_assistant/features/results/results_presentation.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/meeting_models.dart';
import 'package:sme_meeting_assistant/core/models.dart';
import 'package:sme_meeting_assistant/core/paged_collection.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_invalidation.dart';
import 'package:sme_meeting_assistant/features/results/results_invalidation.dart';
import 'package:sme_meeting_assistant/features/results/results_models.dart';
import 'package:sme_meeting_assistant/features/results/results_mutation_coordinator.dart';
import 'package:sme_meeting_assistant/features/results/results_repository.dart';
import 'package:sme_meeting_assistant/features/results/results_panel.dart';
import 'package:sme_meeting_assistant/features/results/results_workspace_controller.dart';

import 'support/meeting_test_support.dart';

class _Repository extends ResultsRepository {
  _Repository(super.api);
  int reads = 0;
  ApiFailure? historyFailure;
  bool access = true;
  Object? verificationFailure;
  Completer<bool>? pendingVerification;
  Completer<String>? pendingRegeneration;
  Completer<Transcript>? pending;
  ApiFailure? readFailure;
  String? submittedTag;
  Completer<ApiResult>? mutation;
  final List<String> regenerationKeys = <String>[];
  final List<PagedCollection<MeetingDecision>> decisionPages = [];
  int decisionCreates = 0;

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
  Future<ResultsSummary> currentSummary({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
  }) async => ResultsSummary(
    id: 'summary-1',
    meetingId: testMeetingId,
    versionNumber: 1,
    content: 'Summary',
    sourceType: 'AI',
    qualityStatus: 'CONFIRMED',
    processingJobId: null,
    transcriptId: null,
    contentRevision: 1,
    isStale: false,
    createdAt: _createdAt,
    createdByUserId: null,
    aiWarnings: <String>[],
    etag: '"summary-v1"',
  );

  @override
  Future<PagedCollection<SummaryVersion>> summaryVersions({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
    int page = 0,
    int size = 20,
  }) async {
    final failure = historyFailure;
    if (failure != null) throw failure;
    return const PagedCollection<SummaryVersion>(
      items: <SummaryVersion>[],
      page: 0,
      size: 20,
      totalElements: 0,
      totalPages: 0,
      hasNext: false,
      hasPrevious: false,
    );
  }

  @override
  Future<PagedCollection<MeetingDecision>> decisions({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
    int page = 0,
    int size = 20,
  }) async {
    if (decisionPages.isNotEmpty) return decisionPages[page];
    return const PagedCollection<MeetingDecision>(
      items: <MeetingDecision>[],
      page: 0,
      size: 20,
      totalElements: 0,
      totalPages: 0,
      hasNext: false,
      hasPrevious: false,
    );
  }

  @override
  Future<MeetingDecision> createDecision({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
    required String content,
  }) async {
    decisionCreates++;
    throw const ApiFailure(
      0,
      'TIMEOUT',
      'Unknown',
      remoteOutcomeAmbiguous: true,
    );
  }

  @override
  Future<MeetingMinutes> minutes({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
  }) async => MeetingMinutes(
    completeness: 'PARTIAL',
    assembledAt: _createdAt,
    summaryContent: 'Summary',
    confirmedDecisions: <MinutesDecision>[],
    officialActionItems: <MinutesAction>[],
    transcriptAvailability: 'AVAILABLE',
    transcriptStatus: 'READY',
    warnings: <String>[],
    meetingId: testMeetingId,
    schemaVersion: 1,
    sourceFingerprint: 'test',
  );

  @override
  Future<bool> verifyReadAccess({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
  }) async {
    final error = verificationFailure;
    if (error != null) throw error;
    final verification = pendingVerification;
    if (verification != null) return verification.future;
    return access;
  }

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

  @override
  Future<String> regenerateSummary({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
    required String idempotencyKey,
  }) async {
    regenerationKeys.add(idempotencyKey);
    if (pendingRegeneration != null) return pendingRegeneration!.future;
    if (regenerationKeys.length == 1) {
      throw const ApiFailure(
        0,
        'TIMEOUT',
        'Unknown',
        remoteOutcomeAmbiguous: true,
      );
    }
    return 'processing-job-1';
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

final _createdAt = DateTime.utc(2026, 11, 24);

const _speaker = SpeakerCluster(
  id: 'speaker-1',
  label: 'SPEAKER_01',
  userId: null,
  displayName: null,
);

const _review = SpeakerReviewSnapshot(
  transcriptId: 'transcript-1',
  etag: '"old-reviewed-token"',
  clusters: [_speaker],
);

Future<({ResultsWorkspaceController workspace, _Repository repository})>
_setup() async {
  final api = createMeetingTestApi(
    MeetingTestHttpClient((request) async {
      throw StateError('Unexpected request ${request.url.path}');
    }),
  );
  await signInMeetingTestApi(api);
  final meetings = MeetingInvalidationSignal(api);
  final invalidation = ResultsInvalidationSignal(
    api: api,
    meetingInvalidation: meetings,
  );
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
  test('history denial clears the shared protected workspace', () async {
    final (:workspace, :repository) = await _setup();
    await workspace.loadTranscript();
    final history = SummaryHistoryController(workspace);
    addTearDown(history.dispose);
    repository.historyFailure = const ApiFailure(403, 'FORBIDDEN', 'Denied');
    await history.load();
    expect(workspace.capabilities.canRead, isFalse);
    expect(workspace.transcript.data, isNull);
    expect(history.items, isEmpty);
  });

  test('history concealed absence suspends the shared workspace', () async {
    final (:workspace, :repository) = await _setup();
    await workspace.loadTranscript();
    final history = SummaryHistoryController(workspace);
    addTearDown(history.dispose);
    repository.historyFailure = const ApiFailure(404, 'NOT_FOUND', 'Absent');
    repository.pendingVerification = Completer<bool>();
    final loading = history.load();
    await _eventually(() => workspace.isAuthorizationVerificationPending);
    expect(workspace.capabilities.canRead, isFalse);
    expect(workspace.transcript.data, isNull);
    repository.pendingVerification!.complete(true);
    await loading;
    expect(workspace.capabilities.canRead, isTrue);
    expect(history.phase, SummaryHistoryPhase.failed);
  });

  test('read revocation fences a delayed successful response', () async {
    final (:workspace, :repository) = await _setup();
    repository.pending = Completer<Transcript>();
    final loading = workspace.loadTranscript();
    workspace.updateCapabilities(
      const ResultsCapabilities(canRead: false, canMutate: false),
    );
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

  test(
    'concealed not-found rechecks access instead of retaining data',
    () async {
      final (:workspace, :repository) = await _setup();
      await workspace.loadTranscript();
      repository.readFailure = const ApiFailure(
        404,
        'NOT_FOUND',
        'Unavailable',
      );
      repository.access = false;
      await workspace.loadTranscript(force: true);
      expect(workspace.transcript.data, isNull);
      expect(workspace.capabilities.canRead, isFalse);
    },
  );

  test(
    'authorized not-found remains absent and does not revoke other access',
    () async {
      final (:workspace, :repository) = await _setup();
      repository.readFailure = const ApiFailure(
        404,
        'NOT_FOUND',
        'Unavailable',
      );
      await workspace.loadTranscript();
      expect(workspace.transcript.phase, ResultsResourcePhase.notReady);
      expect(workspace.capabilities.canRead, isTrue);
    },
  );

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
      sessionScope: workspace.sessionScope,
      meetingId: testMeetingId,
      resources: {ResultsResourceKind.transcript},
    );
    expect(repository.reads, 1);
    await workspace.loadTranscript();
    expect(repository.reads, 2);
  });

  test(
    'speaker command uses the reviewed token and rejects duplicate dispatch',
    () async {
      final (:workspace, :repository) = await _setup();
      await workspace.loadTranscript();
      repository.mutation = Completer<ApiResult>();
      final epoch = workspace.reviewEpoch;
      final first = workspace.mapSpeaker(
        _review,
        _speaker.id,
        null,
        epoch: epoch,
      );
      await expectLater(
        workspace.mapSpeaker(_review, _speaker.id, null, epoch: epoch),
        throwsA(isA<ApiFailure>()),
      );
      expect(repository.submittedTag, _review.etag);
      repository.mutation!.complete(const ApiResult({}, {}, '"mapped"'));
      await first;
    },
  );

  test('old review epoch cannot dispatch after access is restored', () async {
    final (:workspace, :repository) = await _setup();
    final epoch = workspace.reviewEpoch;
    workspace.updateCapabilities(
      const ResultsCapabilities(canRead: false, canMutate: false),
    );
    workspace.updateCapabilities(
      const ResultsCapabilities(canRead: true, canMutate: true),
    );
    await expectLater(
      workspace.mapSpeaker(_review, _speaker.id, null, epoch: epoch),
      throwsA(isA<ApiFailure>()),
    );
    expect(repository.submittedTag, isNull);
  });

  test('uncertain regeneration retains key until admission is confirmed', () {
    final commands = ResultsMutationCoordinator();
    final key = commands.regenerationKey();
    commands.recordFailure(
      const ApiFailure(0, 'TIMEOUT', 'Unknown', remoteOutcomeAmbiguous: true),
    );
    expect(commands.regenerationKey(), key);
    commands.recordFailure(const ApiFailure(429, 'RATE_LIMIT', 'Retry later'));
    expect(commands.regenerationKey(), key);
    commands.recordAdmission('job-1');
    expect(commands.acceptedRegenerationJobId, 'job-1');
    expect(commands.regenerationUncertain, isFalse);
    expect(commands.regenerationKey(), isNot(key));
  });

  testWidgets('the Results workspace activates sections after the frame', (
    tester,
  ) async {
    final setup = await tester.runAsync(_setup);
    final (:workspace, :repository) = setup!;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            height: 700,
            child: ResultsPanel(workspace: workspace),
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.tap(find.byType(ChoiceChip).at(1));
    await tester.pump();
    await tester.tap(find.byType(ChoiceChip).at(2));
    await tester.pump();
    final minutesTab = find.byType(ChoiceChip).at(4);
    await tester.ensureVisible(minutesTab);
    await tester.tap(minutesTab);
    await tester.pump();

    expect(tester.takeException(), isNull);
    expect(repository.reads, greaterThanOrEqualTo(1));
  });

  testWidgets('disposing the workspace closes its protected dialog', (
    tester,
  ) async {
    final setup = await tester.runAsync(_setup);
    final workspace = setup!.workspace;
    bool? result;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () async {
                result = await showResultsReviewDialog<bool>(
                  context: context,
                  workspace: workspace,
                  epoch: workspace.reviewEpoch,
                  builder: (dialog) =>
                      const AlertDialog(content: Text('Protected draft')),
                );
              },
              child: const Text('Open protected dialog'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open protected dialog'));
    await tester.pumpAndSettle();
    expect(find.text('Protected draft'), findsOneWidget);
    workspace.dispose();
    await tester.pumpAndSettle();
    expect(find.text('Protected draft'), findsNothing);
    expect(result, isNull);
    expect(tester.takeException(), isNull);
  });

  testWidgets('revoking Results access closes its protected dialog', (
    tester,
  ) async {
    final setup = await tester.runAsync(_setup);
    final workspace = setup!.workspace;
    bool? result;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () async {
                result = await showResultsReviewDialog<bool>(
                  context: context,
                  workspace: workspace,
                  epoch: workspace.reviewEpoch,
                  builder: (dialog) =>
                      const AlertDialog(content: Text('Protected draft')),
                );
              },
              child: const Text('Open protected dialog'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open protected dialog'));
    await tester.pumpAndSettle();
    workspace.updateCapabilities(
      const ResultsCapabilities(canRead: false, canMutate: false),
    );
    await tester.pumpAndSettle();

    expect(find.text('Protected draft'), findsNothing);
    expect(result, isNull);
    expect(tester.takeException(), isNull);
  });

  testWidgets('Meeting Detail keeps pending Results commands across tabs', (
    tester,
  ) async {
    final pending = Completer<http.StreamedResponse>();
    final client = MeetingTestHttpClient((request) async {
      final path = request.url.path;
      if (path.endsWith('/summary/regenerate')) return pending.future;
      if (path.endsWith('/summary/versions')) {
        return meetingApiSuccess(
          const <dynamic>[],
          meta: {
            ...meetingTestMeta,
            'pagination': {
              'page': 0,
              'size': 20,
              'totalElements': 0,
              'totalPages': 0,
              'hasNext': false,
              'hasPrevious': false,
            },
          },
        );
      }
      if (path.endsWith('/summary')) {
        return meetingApiSuccess(
          {
            'id': 'summary-1',
            'meetingId': testMeetingId,
            'versionNumber': 1,
            'content': 'Summary',
            'sourceType': 'AI',
            'qualityStatus': 'CONFIRMED',
            'processingJobId': null,
            'transcriptId': null,
            'contentRevision': 1,
            'isStale': false,
            'createdAt': '2026-11-24T12:00:00Z',
            'createdByUserId': null,
            'aiWarnings': <String>[],
          },
          headers: const {'etag': '"summary-v1"'},
        );
      }
      if (path.endsWith('/participants') ||
          path.endsWith('/media') ||
          path.endsWith('/processing-jobs')) {
        return meetingApiSuccess(const <dynamic>[]);
      }
      if (path.endsWith('/meetings/$testMeetingId')) {
        return meetingApiSuccess(
          meetingTestJson(),
          headers: const {'etag': testMeetingEtag},
        );
      }
      return meetingApiFailure(404, 'NOT_FOUND');
    });
    final dependencies = await tester.runAsync(() async {
      final deps = AppDependencies.create(
        apiBaseUri: Uri.parse('https://api.example.test/api/v1'),
        httpClient: client,
        credentialStorage: InMemoryCredentialStorage(),
      );
      await signInMeetingTestApi(deps.api);
      return deps;
    });
    final deps = dependencies!;
    addTearDown(deps.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: MeetingDetailPage(dependencies: deps, meetingId: testMeetingId),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Biên bản AI'));
    await tester.pumpAndSettle();
    final workspace = tester
        .widget<ResultsPanel>(find.byType(ResultsPanel))
        .workspace;
    final command = workspace.regenerateSummary(epoch: workspace.reviewEpoch);
    await tester.pump();
    expect(workspace.mutationBusy(ResultsMutationGroup.summary), isTrue);
    final processingTab = find.text('Xử lý');
    await tester.ensureVisible(processingTab);
    await tester.tap(processingTab);
    await tester.pumpAndSettle();
    expect(find.byType(ResultsPanel), findsNothing);
    expect(workspace.mutationBusy(ResultsMutationGroup.summary), isTrue);
    pending.complete(
      await meetingApiSuccess({
        'meetingId': testMeetingId,
        'processingJobId': '11111111-1111-4111-8111-111111111111',
      }, status: 202),
    );
    await tester.pump();
    await command;
    final resultsTab = find.text('Biên bản AI');
    await tester.ensureVisible(resultsTab);
    await tester.tap(resultsTab);
    await tester.pumpAndSettle();
    final restored = tester
        .widget<ResultsPanel>(find.byType(ResultsPanel))
        .workspace;
    expect(restored, same(workspace));
    expect(restored.acceptedRegenerationJobId, isNotNull);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.runAsync(deps.shutdown);
  });

  test('pending Results commands survive section changes', () async {
    final (:workspace, :repository) = await _setup();
    repository.pendingRegeneration = Completer<String>();
    final command = workspace.regenerateSummary(epoch: workspace.reviewEpoch);

    expect(workspace.mutationBusy(ResultsMutationGroup.summary), isTrue);
    workspace.deactivate();
    workspace.activateResources({ResultsResourceKind.summary});
    expect(workspace.mutationBusy(ResultsMutationGroup.summary), isTrue);

    repository.pendingRegeneration!.complete('processing-job-1');
    await command;

    expect(workspace.acceptedRegenerationJobId, 'processing-job-1');
    expect(workspace.mutationBusy(ResultsMutationGroup.summary), isFalse);
  });

  test('authorization verification failure stays fail-closed', () async {
    final (:workspace, :repository) = await _setup();
    await workspace.loadTranscript();
    repository.readFailure = const ApiFailure(404, 'NOT_FOUND', 'Unavailable');
    repository.verificationFailure = const ApiFailure(
      0,
      'NETWORK_UNAVAILABLE',
      'Cannot verify access',
      isTransportFailure: true,
    );

    await workspace.loadTranscript(force: true);

    expect(
      workspace.transcript.phase,
      ResultsResourcePhase.authorizationVerificationFailed,
    );
    expect(workspace.transcript.data, isNull);
    expect(workspace.capabilities.canRead, isFalse);
    expect(workspace.authorizationVerificationFailure, isNotNull);
  });

  test('resource invalidation cannot strand access verification', () async {
    final (:workspace, :repository) = await _setup();
    repository.readFailure = const ApiFailure(404, 'NOT_FOUND', 'Unavailable');
    repository.pendingVerification = Completer<bool>();
    final loading = workspace.loadTranscript();
    await _eventually(() => workspace.isAuthorizationVerificationPending);
    workspace.invalidation.invalidate(
      sessionScope: workspace.sessionScope,
      meetingId: testMeetingId,
      resources: {ResultsResourceKind.transcript},
    );
    repository.readFailure = null;
    repository.pendingVerification!.complete(true);
    await loading;
    expect(workspace.isAuthorizationVerificationPending, isFalse);
    expect(workspace.capabilities.canRead, isTrue);
    await workspace.loadTranscript();
    expect(workspace.transcript.data, isNotNull);
  });

  test('metadata synchronization cannot restore suspended access', () async {
    final (:workspace, :repository) = await _setup();
    repository.readFailure = const ApiFailure(404, 'NOT_FOUND', 'Unavailable');
    repository.pendingVerification = Completer<bool>();
    final loading = workspace.loadTranscript();
    await _eventually(() => workspace.isAuthorizationVerificationPending);
    workspace.updateCapabilities(
      const ResultsCapabilities(canRead: true, canMutate: true),
    );
    expect(workspace.capabilities.canRead, isFalse);
    repository.pendingVerification!.complete(false);
    await loading;
    workspace.updateCapabilities(
      const ResultsCapabilities(canRead: true, canMutate: true),
    );
    expect(workspace.capabilities.canRead, isFalse);
    expect(workspace.transcript.data, isNull);
  });

  test('admission survives temporary authorization suspension', () async {
    final (:workspace, :repository) = await _setup();
    repository.pendingRegeneration = Completer<String>();
    final epoch = workspace.reviewEpoch;
    final command = workspace.regenerateSummary(epoch: epoch);
    final outcome = expectLater(command, throwsA(isA<ApiFailure>()));
    repository.readFailure = const ApiFailure(404, 'NOT_FOUND', 'Unavailable');
    repository.pendingVerification = Completer<bool>();
    final loading = workspace.loadTranscript();
    await _eventually(() => workspace.isAuthorizationVerificationPending);
    repository.pendingRegeneration!.complete('accepted-job');
    await outcome;
    expect(workspace.capabilities.canRead, isFalse);
    repository.pendingVerification!.complete(true);
    await loading;
    expect(workspace.acceptedRegenerationJobId, 'accepted-job');
    expect(workspace.ownsReview(epoch), isFalse);
    await expectLater(
      workspace.regenerateSummary(epoch: workspace.reviewEpoch),
      throwsA(isA<ApiFailure>()),
    );
    expect(repository.regenerationKeys, hasLength(1));
  });

  test('uncertain admission keeps its key through suspension', () async {
    final (:workspace, :repository) = await _setup();
    repository.pendingRegeneration = Completer<String>();
    final command = workspace.regenerateSummary(epoch: workspace.reviewEpoch);
    final outcome = expectLater(command, throwsA(isA<ApiFailure>()));
    repository.readFailure = const ApiFailure(404, 'NOT_FOUND', 'Unavailable');
    repository.pendingVerification = Completer<bool>();
    final loading = workspace.loadTranscript();
    await _eventually(() => workspace.isAuthorizationVerificationPending);
    repository.pendingRegeneration!.completeError(
      const ApiFailure(0, 'TIMEOUT', 'Unknown', remoteOutcomeAmbiguous: true),
    );
    await outcome;
    repository.pendingVerification!.complete(true);
    await loading;
    expect(workspace.regenerationUncertain, isTrue);
    repository.pendingRegeneration = null;
    await workspace.regenerateSummary(epoch: workspace.reviewEpoch);
    expect(repository.regenerationKeys, hasLength(2));
    expect(repository.regenerationKeys[0], repository.regenerationKeys[1]);
  });

  test('revocation fences a delayed authorization verification', () async {
    final (:workspace, :repository) = await _setup();
    repository.readFailure = const ApiFailure(404, 'NOT_FOUND', 'Unavailable');
    repository.pendingVerification = Completer<bool>();
    final loading = workspace.loadTranscript();
    await _eventually(() => workspace.isAuthorizationVerificationPending);
    workspace.updateCapabilities(
      const ResultsCapabilities(canRead: false, canMutate: false),
    );
    repository.pendingVerification!.complete(true);
    await loading;
    expect(workspace.capabilities.canRead, isFalse);
    expect(workspace.transcript.data, isNull);
  });

  test('decision recovery retains all pages and fences old reviews', () async {
    final (:workspace, :repository) = await _setup();
    final epoch = workspace.reviewEpoch;
    await expectLater(
      workspace.createDecision('Uncertain request', epoch: epoch),
      throwsA(isA<ApiFailure>()),
    );
    for (var page = 0; page < 2; page++) {
      repository.decisionPages.add(
        PagedCollection<MeetingDecision>(
          items: [
            MeetingDecision(
              id: 'decision-$page',
              meetingId: testMeetingId,
              content: 'Decision from page $page',
              status: 'CONFIRMED',
              version: 1,
              stale: false,
              createdAt: _createdAt,
              confirmedAt: _createdAt,
              rejectedAt: null,
              etag: '"decision-$page"',
            ),
          ],
          page: page,
          size: 1,
          totalElements: 2,
          totalPages: 2,
          hasNext: page == 0,
          hasPrevious: page > 0,
        ),
      );
    }
    final review = await workspace.reconcileUnknownDecision(epoch: epoch);
    final ids = review?.map((decision) => decision.id);
    expect(ids, ['decision-0', 'decision-1']);
    expect(workspace.decisionOutcomeUnknown, isTrue);
    workspace.invalidation.invalidate(
      sessionScope: workspace.sessionScope,
      meetingId: testMeetingId,
      resources: {ResultsResourceKind.decisions},
    );
    void acknowledgeOldReview() {
      workspace.acknowledgeUnknownDecision(epoch: epoch, reviewed: review!);
    }

    expect(acknowledgeOldReview, throwsA(isA<ApiFailure>()));
    expect(workspace.decisionOutcomeUnknown, isTrue);
    final fresh = await workspace.reconcileUnknownDecision(epoch: epoch);
    workspace.acknowledgeUnknownDecision(epoch: epoch, reviewed: fresh!);
    expect(workspace.decisionOutcomeUnknown, isFalse);
    expect(repository.decisionCreates, 1);
  });

  test('recovery drafts keep their reviewed version', () async {
    final (:workspace, :repository) = await _setup();
    final epoch = workspace.reviewEpoch;
    workspace.keepDraft(
      'summary:$testMeetingId',
      'preserved',
      epoch,
      resourceId: 'summary-1',
      reviewedToken: '"old"',
    );

    expect(
      workspace.draftFor(
        'summary:$testMeetingId',
        resourceId: 'summary-1',
        reviewedToken: '"old"',
        epoch: epoch,
      ),
      'preserved',
    );
    expect(
      workspace.draftFor(
        'summary:$testMeetingId',
        resourceId: 'summary-1',
        reviewedToken: '"new"',
        epoch: epoch,
      ),
      isNull,
    );
    expect(repository.reads, 0);
  });

  test(
    'workspace retries regeneration with the same idempotency key',
    () async {
      final (:workspace, :repository) = await _setup();
      final epoch = workspace.reviewEpoch;

      await expectLater(
        workspace.regenerateSummary(epoch: epoch),
        throwsA(isA<ApiFailure>()),
      );
      await workspace.regenerateSummary(epoch: epoch);

      expect(repository.regenerationKeys, hasLength(2));
      expect(repository.regenerationKeys[0], repository.regenerationKeys[1]);
      expect(workspace.acceptedRegenerationJobId, 'processing-job-1');
      workspace.deactivate();
      expect(workspace.acceptedRegenerationJobId, 'processing-job-1');
    },
  );

  test(
    'in-flight invalidation is followed by a newer canonical refresh',
    () async {
      final (:workspace, :repository) = await _setup();
      final pending = Completer<Transcript>();
      repository.pending = pending;
      workspace.activateResources({ResultsResourceKind.transcript});
      for (var turn = 0; turn < 20 && repository.reads == 0; turn++) {
        await Future<void>.value();
      }
      expect(repository.reads, 1);

      workspace.invalidation.invalidate(
        sessionScope: workspace.sessionScope,
        meetingId: testMeetingId,
        resources: {ResultsResourceKind.transcript},
      );
      pending.complete(_transcript);
      for (
        var turn = 0;
        turn < 100 &&
            (repository.reads < 2 ||
                workspace.transcript.phase != ResultsResourcePhase.available);
        turn++
      ) {
        await Future<void>.value();
      }

      expect(repository.reads, 2);
      expect(
        workspace.transcript.phase,
        isIn(<ResultsResourcePhase>[
          ResultsResourcePhase.available,
          ResultsResourcePhase.empty,
        ]),
      );
    },
  );
}

Future<void> _eventually(bool Function() condition) async {
  for (var attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await Future<void>.value();
  }
  fail('The expected state transition did not occur.');
}
