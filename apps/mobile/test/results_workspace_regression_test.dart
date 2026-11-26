import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/core/app_dependencies.dart';
import 'package:sme_meeting_assistant/core/appearance_preferences.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_create_sheet.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_creation.dart';
import 'package:sme_meeting_assistant/features/action_items/action_item_models.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_detail_page.dart';
import 'package:sme_meeting_assistant/features/results/minutes_panel.dart';
import 'package:sme_meeting_assistant/features/recording/processing_timeline_panel.dart';
import 'package:sme_meeting_assistant/features/results/summary_history_controller.dart';
import 'package:sme_meeting_assistant/features/results/transcript_evidence_navigation.dart';
import 'package:sme_meeting_assistant/features/results/results_presentation.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/meeting_models.dart';
import 'package:sme_meeting_assistant/core/models.dart';
import 'package:sme_meeting_assistant/core/paged_collection.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_invalidation.dart';
import 'package:sme_meeting_assistant/features/results/results_invalidation.dart';
import 'package:sme_meeting_assistant/features/results/decision_review_state.dart';
import 'package:sme_meeting_assistant/features/results/decisions_review_panel.dart';
import 'package:sme_meeting_assistant/features/results/results_models.dart';
import 'package:sme_meeting_assistant/features/results/results_mutation_coordinator.dart';
import 'package:sme_meeting_assistant/features/results/results_repository.dart';
import 'package:sme_meeting_assistant/features/results/results_panel.dart';
import 'package:sme_meeting_assistant/features/results/results_workspace_controller.dart';

import 'action_item_foundation_test.dart' show itemId, itemJson, pageMeta;
import 'support/meeting_test_support.dart';
import 'support/widget_test_support.dart';

class _Repository extends ResultsRepository {
  _Repository(super.api);
  int reads = 0;
  int minutesReads = 0;
  List<MinutesAction> minutesActions = [];
  ApiFailure? historyFailure;
  int historyReads = 0;
  final List<PagedCollection<SummaryVersion>> historyPages = [];
  Transcript? transcriptValue;
  TranscriptCoverage? coverageValue;
  SpeakerReviewSnapshot? speakerValue;
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
  int decisionReviews = 0;
  final List<String?> decisionFilters = [];
  ApiFailure? decisionReadFailure;

  @override
  Future<Transcript> currentTranscript({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
  }) async {
    reads++;
    final failure = readFailure;
    if (failure != null) throw failure;
    return pending == null
        ? transcriptValue ?? _transcript
        : await pending!.future;
  }

  @override
  Future<TranscriptCoverage> currentTranscriptCoverage({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
    bool Function()? stillAuthorized,
  }) async =>
      coverageValue ??
      const TranscriptCoverage(
        transcriptId: 'transcript-1',
        transcriptEtag: '"transcript-reviewed"',
        regions: [],
      );

  @override
  Future<SpeakerReviewSnapshot> speakerReview({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
    required bool Function() stillAuthorized,
  }) async =>
      speakerValue ??
      const SpeakerReviewSnapshot(
        transcriptId: 'transcript-1',
        etag: '"transcript-reviewed"',
        clusters: [],
      );

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
    historyReads++;
    final failure = historyFailure;
    if (failure != null) throw failure;
    if (historyPages.isNotEmpty) return historyPages[page];
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
    String? status,
  }) async {
    decisionFilters.add(status);
    if (decisionReadFailure != null) throw decisionReadFailure!;
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
    List<String> evidenceSegmentIds = const [],
    Transcript? reviewedTranscript,
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
  Future<ApiResult> reviewDecision({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
    required MeetingDecision snapshot,
    required bool confirm,
  }) async {
    decisionReviews++;
    submittedTag = snapshot.etag;
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
  }) async {
    minutesReads++;
    return MeetingMinutes(
      completeness: 'PARTIAL',
      assembledAt: _createdAt,
      meeting: const MinutesMeeting(
        id: testMeetingId,
        title: 'Meeting',
        description: null,
        organizerUserId: 'user-1',
        status: 'ENDED',
        scheduledStartAt: null,
        scheduledEndAt: null,
        startedAt: null,
        endedAt: null,
      ),
      summary: const MinutesSummary(
        availability: 'AVAILABLE',
        id: 'summary-1',
        versionNumber: 1,
        content: 'Summary',
        sourceType: 'AI',
        qualityStatus: 'READY',
        transcriptId: 'transcript-1',
        contentRevision: 1,
        selectionEpoch: 1,
        isStale: false,
        aiWarnings: [],
      ),
      confirmedDecisions: <MinutesDecision>[],
      officialActionItems: minutesActions,
      transcript: const MinutesTranscript(
        availability: 'AVAILABLE',
        id: 'transcript-1',
        processingJobId: null,
        versionNumber: 1,
        languageCode: 'vi',
        status: 'READY',
        contentRevision: 1,
        durationMs: 1000,
        suspiciousSegments: 0,
        unresolvedSegments: 0,
        unresolvedCoverageRegions: 0,
      ),
      warnings: <String>[],
      proposalsIncluded: false,
      schemaVersion: 1,
      sourceFingerprint: 'test',
    );
  }

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

const _creationTranscript = Transcript(
  id: 'transcript-creation',
  meetingId: testMeetingId,
  sourceMediaId: null,
  processingJobId: null,
  versionNumber: 1,
  languageCode: 'vi',
  status: 'READY',
  durationMs: 1000,
  finalizedAt: null,
  contentRevision: 4,
  segments: [
    SpeechSegment(
      id: 'segment-creation',
      ordinal: 0,
      text: 'Reviewed evidence',
      startMs: 0,
      endMs: 1000,
      speakerLabel: 'SPEAKER_01',
      speakerClusterId: null,
      quality: 'ACCEPTED',
      version: 1,
      etag: '"segment-creation"',
    ),
  ],
  etag: '"transcript-creation"',
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

MeetingDecision _decision(String status) => MeetingDecision(
  id: 'decision-1',
  meetingId: testMeetingId,
  content: 'Decision under review',
  status: status,
  version: 1,
  stale: false,
  createdAt: _createdAt,
  confirmedAt: null,
  rejectedAt: null,
  etag: '"decision-reviewed"',
  sourceType: 'AI_EXTRACTED',
);

PagedCollection<MeetingDecision> _decisionPage(MeetingDecision decision) =>
    PagedCollection(
      items: [decision],
      page: 0,
      size: 20,
      totalElements: 1,
      totalPages: 1,
      hasNext: false,
      hasPrevious: false,
    );

Future<
  ({
    AppDependencies dependencies,
    ResultsWorkspaceController workspace,
    _Repository repository,
  })
>
_mountActionResults(
  WidgetTester tester,
  MeetingTestHttpClient client, {
  ResultsSection section = ResultsSection.actionItems,
  List<MinutesAction> minutesActions = const [],
}) async {
  tester.view.physicalSize = const Size(1000, 1400);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final api = createMeetingTestApi(client);
  await tester.runAsync(() => signInMeetingTestApi(api));
  final dependencies = AppDependencies(
    api: api,
    appearancePreferences: InMemoryAppearancePreferences(),
    httpClient: client,
  );
  final repository = _Repository(api)..minutesActions = minutesActions;
  final workspace = ResultsWorkspaceController(
    api: api,
    repository: repository,
    meetingId: testMeetingId,
    meeting: Meeting.fromJson(meetingTestJson()),
    capabilities: const ResultsCapabilities(canRead: true, canMutate: true),
    invalidation: dependencies.resultsInvalidation,
  );
  addTearDown(() async {
    workspace.dispose();
    await dependencies.shutdown();
  });
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: ResultsPanel(
          workspace: workspace,
          dependencies: dependencies,
          initialSection: section,
        ),
      ),
    ),
  );
  return (
    dependencies: dependencies,
    workspace: workspace,
    repository: repository,
  );
}

Map<String, dynamic> _creationMeeting(String id) => {
  'id': id,
  'title': id == testMeetingId ? 'Current meeting' : 'Other meeting',
  'canReadMeetingContext': true,
};

Future<void> _fillContextualCreation(WidgetTester tester) async {
  await pumpUntil(
    tester,
    () => find.byType(ActionItemCreatePage).evaluate().isNotEmpty,
    reason: 'contextual creation route',
  );
  await pumpUntil(
    tester,
    () => find.widgetWithText(OutlinedButton, 'Current meeting')
        .evaluate()
        .isNotEmpty,
    reason: 'verified contextual meeting',
  );
  final meeting = find.widgetWithText(OutlinedButton, 'Current meeting');
  expect(tester.widget<OutlinedButton>(meeting).onPressed, isNull);
  await tester.enterText(find.byType(TextFormField).first, 'Contextual task');
  tester.testTextInput.receiveAction(TextInputAction.done);
  await tester.pumpAndSettle();
  final assignee = find.text('Chọn người phụ trách *');
  await tester.ensureVisible(assignee);
  await tester.tap(assignee);
  await tester.pumpAndSettle();
  await tester.tap(find.textContaining('Giao cho tôi'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('Results creates work only in the verified locked meeting', (
    tester,
  ) async {
    final writes = <Map<String, dynamic>>[];
    final pages = <int>[];
    final client = MeetingTestHttpClient((request) async {
      if (request.url.path.endsWith('/creation-meetings')) {
        expect(request.url.queryParameters['q'], testMeetingId);
        final page = int.parse(request.url.queryParameters['page']!);
        pages.add(page);
        return meetingApiSuccess(
          page == 0
              ? List.generate(
                  20,
                  (index) => _creationMeeting(
                    '00000000-0000-4000-8000-${index.toString().padLeft(12, '0')}',
                  ),
                )
              : [_creationMeeting(testMeetingId)],
          meta: {
            ...meetingTestMeta,
            'pagination': {
              'page': page,
              'size': 20,
              'totalElements': 21,
              'totalPages': 2,
              'hasNext': page == 0,
              'hasPrevious': page > 0,
            },
          },
        );
      }
      if (request.method == 'POST') {
        writes.add(decodeRequestBody(request));
        expect(request.headers['Idempotency-Key'], isNotNull);
        return meetingApiSuccess(
          {...itemJson(), 'title': 'Contextual task'},
          headers: {'etag': '"created"'},
          status: 201,
        );
      }
      expect(request.url.path, endsWith('/action-items'));
      expect(request.url.queryParameters['meetingId'], testMeetingId);
      return meetingApiSuccess(
        [
          if (writes.isNotEmpty) {...itemJson(), 'title': 'Contextual task'},
        ],
        meta: pageMeta(total: writes.isEmpty ? 0 : 1),
      );
    });
    await _mountActionResults(tester, client);
    final create = find.byTooltip('Tạo công việc');
    await pumpUntil(
      tester,
      () => create.evaluate().isNotEmpty,
      reason: 'eligible contextual creation',
    );
    await tester.tap(create);
    await _fillContextualCreation(tester);
    final submit = find.widgetWithText(FilledButton, 'Tạo công việc');
    await tester.ensureVisible(submit);
    await tester.tap(submit);
    await pumpUntil(tester, () => writes.length == 1, reason: 'creation POST');
    await pumpUntil(
      tester,
      () => find.byType(ActionItemCreatePage).evaluate().isEmpty,
      reason: 'return to Results',
    );
    expect(writes.single['meetingId'], testMeetingId);
    expect(writes.single['assigneeUserId'], testUserId);
    expect(pages, [0, 1, 0, 1, 0, 1]);
    await pumpUntil(
      tester,
      () => find.text('Contextual task').evaluate().isNotEmpty,
      reason: 'canonical collection revalidation',
    );
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('Results revocation fences pending creation verification', (
    tester,
  ) async {
    final pending = Completer<http.StreamedResponse>();
    var reads = 0;
    var writes = 0;
    final client = MeetingTestHttpClient((request) async {
      if (request.url.path.endsWith('/creation-meetings')) {
        reads++;
        if (reads == 3) return pending.future;
        return meetingApiSuccess(
          [_creationMeeting(testMeetingId)],
          meta: pageMeta(),
        );
      }
      if (request.method == 'POST') {
        writes++;
        return meetingApiFailure(500, 'UNEXPECTED_WRITE');
      }
      return meetingApiSuccess([], meta: pageMeta(total: 0));
    });
    final (:dependencies, :workspace, repository: _) =
        await _mountActionResults(tester, client);
    final create = find.byTooltip('Tạo công việc');
    await pumpUntil(
      tester,
      () => create.evaluate().isNotEmpty,
      reason: 'creation eligibility',
    );
    await tester.tap(create);
    await _fillContextualCreation(tester);
    final submit = find.widgetWithText(FilledButton, 'Tạo công việc');
    await tester.ensureVisible(submit);
    await tester.tap(submit);
    await pumpUntil(tester, () => reads == 3, reason: 'pending verification');
    workspace.updateCapabilities(
      const ResultsCapabilities(canRead: false, canMutate: false),
    );
    pending.complete(
      await meetingApiSuccess(
        [_creationMeeting(testMeetingId)],
        meta: pageMeta(),
      ),
    );
    await pumpUntil(
      tester,
      () =>
          !dependencies.actionItemWorkflows.creation.busy &&
          find.byType(ActionItemCreatePage).evaluate().isEmpty,
      reason: 'revoked creation disposed without dispatch',
    );
    expect(writes, 0);
    expect(dependencies.actionItemWorkflows.creation.unresolvedIntent, isNull);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('Results recovers the original request from another meeting', (
    tester,
  ) async {
    final writes = <Map<String, dynamic>>[];
    final keys = <String?>[];
    final client = MeetingTestHttpClient((request) async {
      if (request.url.path.endsWith('/creation-meetings')) {
        final id = request.url.queryParameters['q']!;
        return meetingApiSuccess([_creationMeeting(id)], meta: pageMeta());
      }
      if (request.method == 'POST') {
        writes.add(decodeRequestBody(request));
        keys.add(request.headers['Idempotency-Key']);
        if (writes.length == 1) {
          return meetingApiFailure(500, 'INTERNAL_ERROR');
        }
        return meetingApiSuccess(
          {
            ...itemJson(),
            'meetingId': testRoomId,
            'meetingContext': {'id': testRoomId, 'title': 'Other meeting'},
          },
          headers: {'etag': '"recovered"'},
          status: 201,
        );
      }
      return meetingApiSuccess([], meta: pageMeta(total: 0));
    });
    final (:dependencies, workspace: _, repository: _) =
        await _mountActionResults(tester, client);
    final creation = dependencies.actionItemWorkflows.creation;
    await tester.runAsync(() async {
      await creation.submit(
        input: ActionItemCreateInput(
          meetingId: testRoomId,
          title: 'Other pending task',
          assigneeUserId: testUserId,
        ),
        meeting: ActionItemCreationMeeting.fromJson(
          _creationMeeting(testRoomId),
        ),
        assignee: dependencies.actionItems.selfCandidate(
          dependencies.actionItems.captureSession(),
        ),
      );
    });
    expect(creation.phase, ActionItemCreationPhase.unresolved);
    await pumpUntil(
      tester,
      () => find
          .text('Có yêu cầu tạo công việc chưa xác định ở cuộc họp khác.')
          .evaluate()
          .isNotEmpty,
      reason: 'cross-meeting recovery warning',
    );
    await tester.tap(find.text('Tiếp tục yêu cầu tạo chưa xác định'));
    await pumpUntil(
      tester,
      () => find.text('Cuộc họp: Other meeting').evaluate().isNotEmpty,
      reason: 'original meeting recovery context',
    );
    expect(find.byType(TextFormField), findsNothing);
    expect(writes.length, 1);
    await tester.tap(find.text('Thử lại cùng yêu cầu'));
    await pumpUntil(
      tester,
      () => creation.unresolvedIntent == null && writes.length == 2,
      reason: 'verified recovery of the original request',
    );
    expect(writes.first, writes.last);
    expect(writes.last['meetingId'], testRoomId);
    expect(keys.first, isNotNull);
    expect(keys.first, keys.last);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('Minutes opens a fresh meeting-owned Action Item snapshot', (
    tester,
  ) async {
    var reads = 0;
    final client = MeetingTestHttpClient((request) async {
      expect(request.method, 'GET');
      expect(request.url.path, endsWith('/action-items/$itemId'));
      reads++;
      return meetingApiSuccess(
        {...itemJson(), 'title': 'Current Action Item'},
        headers: {'etag': '"fresh"'},
      );
    });
    await _mountActionResults(
      tester,
      client,
      section: ResultsSection.minutes,
      minutesActions: [
        MinutesAction(
          id: itemId,
          title: 'Older Minutes title',
          details: null,
          status: 'OPEN',
          sourceType: 'MANUAL',
          assigneeUserId: testUserId,
          dueDate: null,
          version: 0,
          createdAt: _createdAt,
          confirmedByUserId: null,
          confirmedAt: null,
        ),
      ],
    );
    await pumpUntil(
      tester,
      () => find.byType(CustomScrollView).evaluate().isNotEmpty,
      reason: 'Minutes projection',
    );
    final detail = find.text('Xem chi tiết công việc');
    await tester.scrollUntilVisible(
      detail,
      250,
      scrollable: find
          .descendant(
            of: find.byType(MinutesPanel),
            matching: find.byType(Scrollable),
          )
          .first,
    );
    await tester.tap(detail);
    await pumpUntil(
      tester,
      () => find.text('Current Action Item').evaluate().isNotEmpty,
      reason: 'fresh Action Item detail',
    );
    expect(reads, 1);
    expect(find.text('Older Minutes title'), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('Results Action Items use meeting scope and revoke the route', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1000, 1400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    var listReads = 0;
    var detailReads = 0;
    final client = MeetingTestHttpClient((request) async {
      expect(request.method, 'GET');
      if (request.url.path.endsWith('/action-items/creation-meetings')) {
        return meetingApiSuccess([], meta: pageMeta(total: 0));
      }
      if (request.url.path.endsWith('/action-items/$itemId')) {
        detailReads++;
        return meetingApiSuccess(itemJson(), headers: {'etag': '"v1"'});
      }
      if (request.url.path.endsWith('/action-items')) {
        listReads++;
        expect(request.url.queryParameters['meetingId'], testMeetingId);
        expect(request.url.queryParameters.containsKey('assignee'), isFalse);
        return meetingApiSuccess([itemJson()], meta: pageMeta());
      }
      throw StateError('Unexpected request ${request.url.path}');
    });
    final api = createMeetingTestApi(client);
    await tester.runAsync(() => signInMeetingTestApi(api));
    final dependencies = AppDependencies(
      api: api,
      appearancePreferences: InMemoryAppearancePreferences(),
      httpClient: client,
    );
    final workspace = ResultsWorkspaceController(
      api: api,
      repository: _Repository(api),
      meetingId: testMeetingId,
      meeting: Meeting.fromJson(meetingTestJson()),
      capabilities: const ResultsCapabilities(canRead: true, canMutate: true),
      invalidation: dependencies.resultsInvalidation,
    );
    addTearDown(() async {
      workspace.dispose();
      await dependencies.shutdown();
    });

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ResultsPanel(
            workspace: workspace,
            dependencies: dependencies,
            initialSection: ResultsSection.actionItems,
          ),
        ),
      ),
    );
    await pumpUntil(
      tester,
      () => find.text('Send report').evaluate().isNotEmpty,
      reason: 'meeting-scoped Action Item',
    );
    expect(listReads, greaterThanOrEqualTo(1));
    await tester.tap(find.text('Send report').first);
    await pumpUntil(tester, () => detailReads == 1, reason: 'detail read');
    await tester.pumpAndSettle();
    expect(find.text('Send report'), findsWidgets);
    expect(find.text('Mở cuộc họp'), findsNothing);
    final complete = find.widgetWithText(OutlinedButton, 'Hoàn thành');
    await tester.ensureVisible(complete);
    await tester.tap(complete);
    await tester.pumpAndSettle();
    expect(find.byType(AlertDialog), findsOneWidget);

    workspace.updateCapabilities(
      const ResultsCapabilities(canRead: false, canMutate: false),
    );
    await tester.pumpAndSettle();
    expect(find.byType(AlertDialog), findsNothing);
    expect(find.text('Send report'), findsNothing);
    expect(find.text('Công việc'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('Results revocation removes the nested assignment picker', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1000, 1400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    var listReads = 0;
    var detailReads = 0;
    final client = MeetingTestHttpClient((request) async {
      expect(request.method, 'GET');
      if (request.url.path.endsWith('/action-items/creation-meetings')) {
        return meetingApiSuccess([], meta: pageMeta(total: 0));
      }
      if (request.url.path.endsWith('/action-items/$itemId')) {
        detailReads++;
        return meetingApiSuccess(itemJson(), headers: {'etag': '"v1"'});
      }
      if (request.url.path.endsWith('/action-items')) {
        listReads++;
        expect(request.url.queryParameters['meetingId'], testMeetingId);
        expect(request.url.queryParameters.containsKey('assignee'), isFalse);
        return meetingApiSuccess([itemJson()], meta: pageMeta());
      }
      throw StateError('Unexpected request ${request.url.path}');
    });
    final api = createMeetingTestApi(client);
    await tester.runAsync(() => signInMeetingTestApi(api));
    final dependencies = AppDependencies(
      api: api,
      appearancePreferences: InMemoryAppearancePreferences(),
      httpClient: client,
    );
    final workspace = ResultsWorkspaceController(
      api: api,
      repository: _Repository(api),
      meetingId: testMeetingId,
      meeting: Meeting.fromJson(meetingTestJson()),
      capabilities: const ResultsCapabilities(canRead: true, canMutate: true),
      invalidation: dependencies.resultsInvalidation,
    );
    addTearDown(() async {
      workspace.dispose();
      await dependencies.shutdown();
    });

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ResultsPanel(
            workspace: workspace,
            dependencies: dependencies,
            initialSection: ResultsSection.actionItems,
          ),
        ),
      ),
    );
    await pumpUntil(
      tester,
      () => find.text('Send report').evaluate().isNotEmpty,
      reason: 'meeting-scoped Action Item',
    );
    expect(listReads, greaterThanOrEqualTo(1));
    await tester.tap(find.text('Send report').first);
    await pumpUntil(tester, () => detailReads == 1, reason: 'detail read');
    await tester.pumpAndSettle();
    expect(find.text('Send report'), findsWidgets);
    expect(find.text('Mở cuộc họp'), findsNothing);
    final edit = find.widgetWithText(OutlinedButton, 'Chỉnh sửa');
    await tester.ensureVisible(edit);
    await tester.tap(edit);
    await tester.pumpAndSettle();
    final assignee = find.widgetWithText(OutlinedButton, 'Test User');
    await tester.ensureVisible(assignee);
    await tester.tap(assignee);
    await tester.pumpAndSettle();
    expect(find.textContaining('Giao cho tôi'), findsOneWidget);

    workspace.updateCapabilities(
      const ResultsCapabilities(canRead: false, canMutate: false),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('Giao cho tôi'), findsNothing);
    expect(find.text('Send report'), findsNothing);
    expect(find.text('Công việc'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  test('decision command validates response identity and status', () async {
    var returnedId = 'wrong-decision';
    var returnedStatus = 'REJECTED';
    final client = MeetingTestHttpClient((request) async {
      expect(request.method, 'POST');
      expect(request.url.path, endsWith('/decisions/decision-1/reject'));
      expect(request.headers['if-match'], '"decision-reviewed"');
      return meetingApiSuccess(
        {
          'id': returnedId,
          'meetingId': testMeetingId,
          'content': 'Decision under review',
          'status': returnedStatus,
          'version': 2,
          'isStale': false,
          'createdAt': '2026-11-24T00:00:00Z',
          'etag': '"decision-new"',
        },
        headers: {'etag': '"decision-new"'},
      );
    });
    final api = createMeetingTestApi(client);
    addTearDown(api.dispose);
    await signInMeetingTestApi(api);
    final repository = ResultsRepository(api);
    Future<ApiResult> submit() => repository.reviewDecision(
      sessionScope: api.authenticatedSessionScope!,
      meetingId: testMeetingId,
      snapshot: _decision('PROPOSED'),
      confirm: false,
    );
    await expectLater(submit(), throwsA(isA<ApiFailure>()));
    returnedId = 'decision-1';
    returnedStatus = 'CONFIRMED';
    await expectLater(submit(), throwsA(isA<ApiFailure>()));
    returnedStatus = 'REJECTED';
    expect((await submit()).etag, '"decision-new"');
  });

  test(
    'uncertain rejection is reconciled independently of status filter',
    () async {
      final (:workspace, :repository) = await _setup();
      final proposal = _decision('PROPOSED');
      repository.decisionPages.add(_decisionPage(proposal));
      await workspace.selectDecisionStatus('PROPOSED');
      final epoch = workspace.reviewEpoch;
      await expectLater(
        workspace.reviewDecision(proposal, confirm: false, epoch: epoch),
        throwsA(isA<ApiFailure>()),
      );
      expect(repository.submittedTag, proposal.etag);
      expect(workspace.unresolvedDecision?.command, DecisionCommand.reject);
      expect(workspace.unresolvedDecision?.snapshot?.id, proposal.id);
      await expectLater(
        workspace.reviewDecision(proposal, confirm: false, epoch: epoch),
        throwsA(isA<ApiFailure>()),
      );
      expect(repository.decisionReviews, 1);
      repository.decisionPages[0] = _decisionPage(_decision('REJECTED'));
      final observed = await workspace.reconcileUnknownDecision(epoch: epoch);
      expect(repository.decisionFilters.last, isNull);
      expect(observed?.single.status, 'REJECTED');
      expect(workspace.decisionOutcomeUnknown, isTrue);
      workspace.acknowledgeUnknownDecision(epoch: epoch, reviewed: observed!);
      expect(workspace.decisionOutcomeUnknown, isFalse);
    },
  );

  test(
    'uncertain manual creation keeps recovery context and blocks replay',
    () async {
      final (:workspace, :repository) = await _setup();
      const source = Transcript(
        id: 'transcript-creation',
        meetingId: testMeetingId,
        sourceMediaId: null,
        processingJobId: null,
        versionNumber: 1,
        languageCode: 'vi',
        status: 'READY',
        durationMs: 1000,
        finalizedAt: null,
        contentRevision: 4,
        segments: [
          SpeechSegment(
            id: 'segment-creation',
            ordinal: 0,
            text: 'Reviewed evidence',
            startMs: 0,
            endMs: 1000,
            speakerLabel: 'SPEAKER_01',
            speakerClusterId: null,
            quality: 'ACCEPTED',
            version: 1,
            etag: '"segment-creation"',
          ),
        ],
        etag: '"transcript-creation"',
      );
      repository.transcriptValue = source;
      final epoch = workspace.reviewEpoch;
      await expectLater(
        workspace.createDecision(
          'Uncertain manual decision',
          epoch: epoch,
          reviewedTranscript: source,
          evidenceSegmentIds: const ['segment-creation'],
        ),
        throwsA(isA<ApiFailure>()),
      );

      expect(workspace.decisionOutcomeUnknown, isTrue);
      expect(workspace.unresolvedManualDecisionContext?.evidence, {
        'segment-creation',
      });
      expect(
        workspace.unresolvedManualDecisionContext?.source?.contentRevision,
        4,
      );
      expect(workspace.manualDecisionDraft, isNull);
      expect(repository.decisionCreates, 1);
      expect(
        () => workspace.acknowledgeUnknownDecision(
          epoch: epoch,
          reviewed: const [],
        ),
        throwsA(isA<ApiFailure>()),
      );
      expect(workspace.decisionOutcomeUnknown, isTrue);
      expect(repository.decisionCreates, 1);
    },
  );

  test('manual creation recovery disposition is explicit and reuse forgets evidence', () async {
    final (:workspace, :repository) = await _setup();
    final epoch = workspace.reviewEpoch;
    await expectLater(
      workspace.createDecision('Keep this content', epoch: epoch),
      throwsA(isA<ApiFailure>()),
    );
    final review = await workspace.reconcileUnknownDecision(epoch: epoch);
    expect(review, isNotNull);

    workspace.resolveUnknownManualCreation(
      epoch: epoch,
      reviewed: review!,
      disposition: ManualDecisionRecoveryDisposition.reuse,
    );

    expect(workspace.decisionOutcomeUnknown, isFalse);
    expect(workspace.manualDecisionDraft?.content, 'Keep this content');
    expect(workspace.manualDecisionDraft?.source, isNull);
    expect(workspace.manualDecisionDraft?.evidence, isEmpty);
    expect(workspace.manualDecisionDraft?.requiresFreshEvidenceReview, isFalse);
    // Acknowledgment is only a disposition; it never dispatches a second
    // create request.
    expect(repository.decisionCreates, 1);
  });

  test('reused manual evidence is marked for fresh review', () async {
    final (:workspace, :repository) = await _setup();
    final epoch = workspace.reviewEpoch;
    repository.transcriptValue = _creationTranscript;
    workspace.keepManualDecisionDraft(
      const ManualDecisionDraft(
        'Keep content and review evidence',
        true,
        source: _creationTranscript,
        evidence: {'segment-creation'},
      ),
      epoch,
    );
    await expectLater(
      workspace.createDecision(
        'Keep content and review evidence',
        epoch: epoch,
        reviewedTranscript: _creationTranscript,
        evidenceSegmentIds: const ['segment-creation'],
      ),
      throwsA(isA<ApiFailure>()),
    );
    final review = await workspace.reconcileUnknownDecision(epoch: epoch);
    workspace.resolveUnknownManualCreation(
      epoch: epoch,
      reviewed: review!,
      disposition: ManualDecisionRecoveryDisposition.reuse,
    );

    expect(workspace.manualDecisionDraft?.source, isNull);
    expect(workspace.manualDecisionDraft?.evidence, isEmpty);
    expect(workspace.manualDecisionDraft?.requiresFreshEvidenceReview, isTrue);
    expect(repository.decisionCreates, 1);
  });

  test(
    'conditional recovery acknowledgment preserves an unrelated manual draft',
    () async {
      final (:workspace, :repository) = await _setup();
      final epoch = workspace.reviewEpoch;
      workspace.keepManualDecisionDraft(
        const ManualDecisionDraft('Unrelated draft', false),
        epoch,
      );
      final proposal = _decision('PROPOSED');
      repository.decisionPages.add(_decisionPage(proposal));
      await expectLater(
        workspace.reviewDecision(proposal, confirm: false, epoch: epoch),
        throwsA(isA<ApiFailure>()),
      );
      repository.decisionPages[0] = _decisionPage(_decision('REJECTED'));
      final review = await workspace.reconcileUnknownDecision(epoch: epoch);
      workspace.acknowledgeUnknownDecision(epoch: epoch, reviewed: review!);

      expect(workspace.manualDecisionDraft?.content, 'Unrelated draft');
      expect(repository.decisionCreates, 0);
    },
  );

  testWidgets(
    'manual creation recovery requires an explicit draft disposition',
    (tester) async {
      final setup = await tester.runAsync(_setup);
      final (:workspace, :repository) = setup!;
      await expectLater(
        workspace.createDecision(
          'Widget recovery content',
          epoch: workspace.reviewEpoch,
        ),
        throwsA(isA<ApiFailure>()),
      );
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: DecisionsReviewPanel(workspace: workspace)),
        ),
      );
      await tester.tap(find.text('Kiểm tra thao tác chưa rõ kết quả'));
      await tester.pumpAndSettle();
      expect(find.text('Bỏ bản nháp, tạo trống'), findsOneWidget);
      expect(find.text('Giữ nội dung, tạo mới'), findsOneWidget);

      await tester.tap(find.text('Hủy, để nguyên trạng thái'));
      await tester.pumpAndSettle();
      expect(workspace.decisionOutcomeUnknown, isTrue);
      expect(repository.decisionCreates, 1);

      await tester.tap(find.text('Kiểm tra thao tác chưa rõ kết quả'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Bỏ bản nháp, tạo trống'));
      await tester.pumpAndSettle();
      expect(workspace.decisionOutcomeUnknown, isFalse);
      expect(workspace.manualDecisionDraft, isNull);
      expect(repository.decisionCreates, 1);
    },
  );

  test('evidence review cannot adopt a stamp after invalidation', () async {
    final (:workspace, :repository) = await _setup();
    final proposal = MeetingDecision(
      id: 'decision-1',
      meetingId: testMeetingId,
      content: 'Decision under review',
      status: 'PROPOSED',
      version: 1,
      stale: false,
      createdAt: _createdAt,
      confirmedAt: null,
      rejectedAt: null,
      etag: '"decision-reviewed"',
      sourceType: 'AI_EXTRACTED',
      transcriptId: _transcript.id,
      contentRevision: _transcript.contentRevision,
    );
    repository.decisionPages.add(_decisionPage(proposal));
    await workspace.loadDecisions();
    repository.pending = Completer<Transcript>();
    final loading = workspace.loadStampedDecisionEvidence(proposal);
    await _eventually(() => repository.reads == 1);
    workspace.invalidation.invalidate(
      sessionScope: workspace.sessionScope,
      meetingId: testMeetingId,
      resources: {ResultsResourceKind.transcript},
    );
    repository.pending!.complete(_transcript);
    final review = await loading;
    expect(workspace.decisionReviewIsCurrent(proposal, review.stamp), isFalse);
    expect(review.stamp, isNot(workspace.decisionReviewStamp));
  });

  test('decision recovery tickets fence overlapping reviews', () {
    final state = DecisionReviewState();
    const intent = DecisionCommandIntent(DecisionCommand.create, 'Decision');
    state.recordUnresolved(intent);
    final first = state.beginRecovery();
    final second = state.beginRecovery();
    final records = List<MeetingDecision>.unmodifiable([]);
    expect(state.publishRecovery(first, intent, records, 1), isFalse);
    expect(state.publishRecovery(second, intent, records, 1), isTrue);
    expect(state.matchesRecovery(records, 1), isTrue);
    state.invalidateRecovery();
    expect(state.matchesRecovery(records, 1), isFalse);
    expect(state.unresolved, same(intent));
  });

  test('decision review stamp is invalidated by transcript changes', () async {
    final (:workspace, :repository) = await _setup();
    final proposal = _decision('PROPOSED');
    repository.decisionPages.add(_decisionPage(proposal));
    await workspace.loadDecisions();
    final stamp = workspace.decisionReviewStamp;
    expect(workspace.decisionReviewIsCurrent(proposal, stamp), isTrue);
    workspace.invalidation.invalidate(
      sessionScope: workspace.sessionScope,
      meetingId: testMeetingId,
      resources: {ResultsResourceKind.transcript},
    );
    expect(workspace.decisionReviewIsCurrent(proposal, stamp), isFalse);
  });

  testWidgets(
    'manual decision content survives cancelling evidence selection',
    (tester) async {
      final setup = await tester.runAsync(_setup);
      final (:workspace, :repository) = setup!;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: DecisionsReviewPanel(workspace: workspace)),
        ),
      );
      await tester.tap(find.byTooltip('Tạo quyết định'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'Retain this draft');
      await tester.tap(find.text('Đính kèm bằng chứng transcript'));
      await tester.pump();
      await tester.tap(find.text('Tiếp tục'));
      await tester.pumpAndSettle();
      expect(find.text('Chọn bằng chứng (0/50)'), findsOneWidget);
      await tester.tap(find.text('Hủy'));
      await tester.pumpAndSettle();
      expect(repository.decisionCreates, 0);
      await tester.tap(find.byTooltip('Tạo quyết định'));
      await tester.pumpAndSettle();
      expect(find.text('Retain this draft'), findsOneWidget);
      workspace.updateCapabilities(
        const ResultsCapabilities(canRead: false, canMutate: false),
      );
      await tester.pumpAndSettle();
      expect(find.text('Retain this draft'), findsNothing);
      expect(workspace.manualDecisionDraft, isNull);
    },
  );

  test('decision pages survive navigation and recoverable failures', () async {
    final (:workspace, :repository) = await _setup();
    for (var page = 0; page < 2; page++) {
      repository.decisionPages.add(
        PagedCollection<MeetingDecision>(
          items: [
            MeetingDecision(
              id: 'decision-$page',
              meetingId: testMeetingId,
              content: 'Decision $page',
              status: 'PROPOSED',
              version: 1,
              stale: false,
              createdAt: _createdAt.subtract(Duration(days: page)),
              confirmedAt: null,
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
    await workspace.selectDecisionStatus('PROPOSED');
    await workspace.loadMoreDecisions();
    expect(workspace.decisions.data?.items.length, 2);
    expect(repository.decisionFilters, ['PROPOSED', 'PROPOSED']);
    workspace.deactivate();
    await workspace.loadDecisions();
    expect(workspace.decisions.data?.items.length, 2);
    repository.decisionReadFailure = const ApiFailure(
      503,
      'UNAVAILABLE',
      'Retry',
    );
    await workspace.loadDecisions(force: true);
    expect(workspace.decisions.data?.items.length, 2);
    expect(workspace.decisions.phase, ResultsResourcePhase.failed);
    workspace.updateCapabilities(
      const ResultsCapabilities(canRead: false, canMutate: false),
    );
    expect(workspace.decisions.data, isNull);
  });

  testWidgets('evidence opens the transcript and focuses a distant segment', (
    tester,
  ) async {
    final setup = await tester.runAsync(_setup);
    final (:workspace, :repository) = setup!;
    repository.transcriptValue = Transcript(
      id: 'transcript-1',
      meetingId: testMeetingId,
      sourceMediaId: null,
      processingJobId: null,
      versionNumber: 1,
      languageCode: 'vi',
      status: 'READY',
      durationMs: 100000,
      finalizedAt: _createdAt,
      contentRevision: 1,
      segments: [
        for (var index = 0; index < 100; index++)
          SpeechSegment(
            id: 'segment-$index',
            ordinal: index,
            text: 'Segment $index',
            startMs: index * 1000,
            endMs: (index + 1) * 1000,
            speakerLabel: 'SPEAKER_01',
            speakerClusterId: 'speaker-1',
            quality: 'ACCEPTED',
            version: 1,
            etag: '"segment-$index"',
          ),
      ],
      etag: '"transcript-reviewed"',
    );
    repository.speakerValue = const SpeakerReviewSnapshot(
      transcriptId: 'transcript-1',
      etag: '"transcript-reviewed"',
      clusters: [
        SpeakerCluster(
          id: 'speaker-1',
          label: 'SPEAKER_01',
          userId: 'user-1',
          displayName: 'Nguyễn Văn A',
        ),
      ],
    );
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: ResultsPanel(workspace: workspace)),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Transcript').first);
    await tester.pumpAndSettle();
    expect(
      find.text('Chưa có bằng chứng để đánh giá độ bao phủ.'),
      findsOneWidget,
    );
    expect(find.text('Nguyễn Văn A'), findsWidgets);
    expect(find.text('Segment 90'), findsNothing);
    await tester.enterText(find.byType(TextField).first, 'does not exist');
    await tester.pumpAndSettle();
    final opening = TranscriptEvidenceNavigationBoundary(workspace).locate(
      const TranscriptEvidenceReference(
        transcriptId: 'transcript-1',
        segmentId: 'segment-90',
        contentRevision: 1,
      ),
    );
    await tester.pumpAndSettle();
    expect((await opening).status, TranscriptEvidenceNavigationStatus.opened);
    expect(find.text('Segment 90'), findsOneWidget);
    expect(find.text('Đoạn đang tham chiếu'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  test(
    'history retains pages across sections and recoverable failures',
    () async {
      final (:workspace, :repository) = await _setup();
      SummaryVersion version(int number) => SummaryVersion(
        id: 'summary-$number',
        versionNumber: number,
        content: 'Version $number',
        sourceType: 'AI',
        qualityStatus: 'READY',
        isStale: false,
        isCurrent: number == 1,
        createdAt: _createdAt,
      );
      repository.historyPages.addAll([
        PagedCollection<SummaryVersion>(
          items: [for (var number = 21; number >= 2; number--) version(number)],
          page: 0,
          size: 20,
          totalElements: 21,
          totalPages: 2,
          hasNext: true,
          hasPrevious: false,
        ),
        PagedCollection<SummaryVersion>(
          items: [version(1)],
          page: 1,
          size: 20,
          totalElements: 21,
          totalPages: 2,
          hasNext: false,
          hasPrevious: true,
        ),
      ]);
      final history = workspace.summaryHistory;
      await history.load();
      await history.loadMore();
      expect(history.items, hasLength(21));
      history.setActive(false);
      history.setActive(true);
      expect(repository.historyReads, 2);
      repository.historyFailure = const ApiFailure(503, 'UNAVAILABLE', 'Retry');
      await history.load(refresh: true);
      expect(history.phase, SummaryHistoryPhase.failed);
      expect(history.items, hasLength(21));
      history.setActive(false);
      workspace.invalidation.invalidate(
        sessionScope: workspace.sessionScope,
        meetingId: testMeetingId,
        resources: {ResultsResourceKind.summaryVersions},
      );
      expect(repository.historyReads, 3);
      repository.historyFailure = null;
      history.setActive(true);
      await _eventually(() => history.phase == SummaryHistoryPhase.available);
      expect(history.items, hasLength(20));
    },
  );

  test('evidence lookup rejects a read revoked during loading', () async {
    final (:workspace, :repository) = await _setup();
    repository.pending = Completer<Transcript>();
    final result = TranscriptEvidenceNavigationBoundary(workspace).locate(
      const TranscriptEvidenceReference(
        transcriptId: 'transcript-1',
        segmentId: 'segment-1',
      ),
    );
    workspace.updateCapabilities(
      const ResultsCapabilities(canRead: false, canMutate: false),
    );
    repository.pending!.complete(_transcript);
    expect((await result).status, TranscriptEvidenceNavigationStatus.forbidden);
    expect(workspace.transcriptFocus, isNull);
  });

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

  test('Action Item changes reload only affected Minutes', () async {
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
    final repository = _Repository(api);
    final workspace = ResultsWorkspaceController(
      api: api,
      repository: repository,
      meetingId: testMeetingId,
      meeting: Meeting.fromJson(meetingTestJson()),
      capabilities: const ResultsCapabilities(canRead: true, canMutate: true),
      invalidation: dependencies.resultsInvalidation,
    );
    addTearDown(() async {
      workspace.dispose();
      await dependencies.shutdown();
    });
    await workspace.loadMinutes();
    await workspace.loadTranscript();
    final scope = workspace.sessionScope;
    final actions = dependencies.actionItemInvalidation;

    actions.invalidate(sessionScope: scope, meetingId: testRoomId);
    await workspace.loadMinutes();
    expect(repository.minutesReads, 1);

    actions.invalidate(sessionScope: scope, meetingId: testMeetingId);
    expect(repository.minutesReads, 1);
    await workspace.loadMinutes();
    expect(repository.minutesReads, 2);
    await workspace.loadTranscript();
    expect(repository.reads, 1);

    workspace.activateResources({ResultsResourceKind.minutes});
    actions.invalidate(sessionScope: scope);
    await workspace.loadMinutes();
    expect(repository.minutesReads, 3);
    expect(repository.reads, 1);
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
    const jobId = '11111111-1111-4111-8111-111111111111';
    final pending = Completer<http.StreamedResponse>();
    final regenerationRequests = <http.BaseRequest>[];
    final pendingDecision = Completer<http.StreamedResponse>();
    final decisionRequests = <http.BaseRequest>[];
    var decisionSaved = false;
    var minutesReads = 0;
    Map<String, dynamic> decisionJson() => {
      'id': 'decision-1',
      'meetingId': testMeetingId,
      'content': 'Canonical decision',
      'status': 'CONFIRMED',
      'sourceType': 'MANUAL',
      'version': 0,
      'isStale': false,
      'createdAt': '2026-11-24T12:00:00Z',
      'confirmedAt': '2026-11-24T12:00:00Z',
      'createdByUserId': testUserId,
      'confirmedByUserId': testUserId,
      'evidenceSegmentIds': <String>[],
      'aiWarnings': <String>[],
      'etag': '"decision-v1"',
    };
    final client = MeetingTestHttpClient((request) async {
      final path = request.url.path;
      if (path.endsWith('/summary/regenerate')) {
        expect(request.method, 'POST');
        regenerationRequests.add(request);
        return pending.future;
      }
      if (path.endsWith('/decisions')) {
        if (request.method == 'POST') {
          decisionRequests.add(request);
          return pendingDecision.future;
        }
        return meetingApiSuccess(
          decisionSaved ? [decisionJson()] : const <dynamic>[],
          meta: {
            ...meetingTestMeta,
            'pagination': {
              'page': 0,
              'size': 20,
              'totalElements': decisionSaved ? 1 : 0,
              'totalPages': decisionSaved ? 1 : 0,
              'hasNext': false,
              'hasPrevious': false,
            },
          },
        );
      }
      if (path.endsWith('/minutes')) {
        minutesReads++;
        return meetingApiSuccess({
          'completeness': 'PARTIAL',
          'schemaVersion': 1,
          'sourceFingerprint': decisionSaved ? 'after-decision' : 'before',
          'assembledAt': '2026-11-24T12:00:00Z',
          'meeting': {
            'id': testMeetingId,
            'title': 'Meeting',
            'organizerUserId': testUserId,
            'status': 'ENDED',
          },
          'summary': {
            'availability': 'AVAILABLE',
            'id': 'summary-1',
            'versionNumber': 1,
            'content': 'Summary',
            'sourceType': 'AI',
            'qualityStatus': 'CONFIRMED',
            'selectionEpoch': 1,
            'isStale': false,
            'aiWarnings': <String>[],
          },
          'confirmedDecisions': decisionSaved
              ? [decisionJson()]
              : const <dynamic>[],
          'officialActionItems': <dynamic>[],
          'transcript': {
            'availability': 'NOT_AVAILABLE',
            'suspiciousSegments': 0,
            'unresolvedSegments': 0,
            'unresolvedCoverageRegions': 0,
          },
          'warnings': <String>['TRANSCRIPT_NOT_AVAILABLE'],
          'proposalsIncluded': false,
        });
      }
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
    bool commandCompleted = false;
    Object? commandFailure;
    bool decisionCompleted = false;
    Object? decisionFailure;
    bool shutdownCompleted = false;
    Object? shutdownFailure;

    // Keep the HTTP response, command completion and dependency shutdown in
    // the widget test's scheduling context. Pump until explicit milestones:
    // a pending command or a processing observer need not become idle.
    Future<void> releaseAdmission() async {
      if (pending.isCompleted) return;
      pending.complete(
        await meetingApiSuccess({
          'meetingId': testMeetingId,
          'processingJobId': jobId,
          'status': 'QUEUED',
          'transcriptId': '22222222-2222-4222-8222-222222222222',
          'contentRevision': 1,
        }, status: 202),
      );
    }

    Future<void> releaseDecision() async {
      if (pendingDecision.isCompleted) return;
      decisionSaved = true;
      pendingDecision.complete(
        await meetingApiSuccess(
          decisionJson(),
          headers: const {'etag': '"decision-v1"'},
          status: 201,
        ),
      );
    }

    try {
      await tester.pumpWidget(
        MaterialApp(
          home: MeetingDetailPage(dependencies: deps, meetingId: testMeetingId),
        ),
      );
      await pumpUntil(
        tester,
        () => find.text('Biên bản AI').evaluate().isNotEmpty,
        reason: 'Meeting Detail to load its canonical meeting',
      );
      final resultsTab = find.text('Biên bản AI');
      await tester.ensureVisible(resultsTab);
      await tester.tap(resultsTab);
      await pumpUntil(
        tester,
        () =>
            find.byType(ResultsPanel).evaluate().isNotEmpty &&
            find.text('Summary').evaluate().isNotEmpty,
        reason: 'Results to load the existing summary',
      );
      final workspace = tester
          .widget<ResultsPanel>(find.byType(ResultsPanel))
          .workspace;
      // Observe the command outcome without awaiting a fake-clock Future
      // before the test has pumped the response and its continuations.
      unawaited(
        workspace
            .regenerateSummary(epoch: workspace.reviewEpoch)
            .then<void>(
              (_) => commandCompleted = true,
              onError: (Object error, StackTrace stack) {
                commandFailure = error;
                commandCompleted = true;
              },
            ),
      );
      await pumpUntil(
        tester,
        () => regenerationRequests.isNotEmpty || commandCompleted,
        reason: 'the regeneration HTTP request to reach the held response',
      );
      expect(commandFailure, isNull);
      expect(regenerationRequests, hasLength(1));
      expect(
        regenerationRequests.single.headers['idempotency-key'],
        isNotEmpty,
      );
      expect(commandCompleted, isFalse);
      expect(workspace.mutationBusy(ResultsMutationGroup.summary), isTrue);

      final processingTab = find.text('Xử lý');
      await tester.ensureVisible(processingTab);
      await tester.tap(processingTab);
      await pumpUntil(
        tester,
        () =>
            find.byType(ProcessingTimelinePanel).evaluate().isNotEmpty &&
            find.byType(ResultsPanel).evaluate().isEmpty,
        reason: 'Processing to replace the Results widget',
      );
      expect(commandCompleted, isFalse);
      expect(workspace.mutationBusy(ResultsMutationGroup.summary), isTrue);

      await releaseAdmission();
      await pumpUntil(
        tester,
        () => commandCompleted,
        reason: 'the held HTTP 202 to complete the original Results command',
      );
      expect(commandFailure, isNull);
      expect(workspace.mutationBusy(ResultsMutationGroup.summary), isFalse);
      expect(workspace.acceptedRegenerationJobId, jobId);

      await tester.ensureVisible(resultsTab);
      await tester.tap(resultsTab);
      await pumpUntil(
        tester,
        () =>
            find.byType(ResultsPanel).evaluate().isNotEmpty &&
            find.text('Summary').evaluate().isNotEmpty,
        reason: 'the same Results workspace to be rendered after navigation',
      );
      final restored = tester
          .widget<ResultsPanel>(find.byType(ResultsPanel))
          .workspace;
      expect(restored, same(workspace));
      expect(restored.acceptedRegenerationJobId, jobId);
      expect(regenerationRequests, hasLength(1));
      expect(tester.takeException(), isNull);

      final minutesTab = find.widgetWithText(ChoiceChip, 'Biên bản');
      await tester.ensureVisible(minutesTab);
      await tester.tap(minutesTab);
      await pumpUntil(
        tester,
        () => workspace.minutes.data?.sourceFingerprint == 'before',
        reason: 'the original canonical Minutes to load',
      );
      final initialMinutesReads = minutesReads;
      final decisionsTab = find.widgetWithText(ChoiceChip, 'Quyết định');
      await tester.ensureVisible(decisionsTab);
      await tester.tap(decisionsTab);
      await pumpUntil(
        tester,
        () => workspace.decisions.phase == ResultsResourcePhase.empty,
        reason: 'the empty canonical Decision collection to load',
      );
      unawaited(
        workspace
            .createDecision('Canonical decision', epoch: workspace.reviewEpoch)
            .then<void>(
              (_) => decisionCompleted = true,
              onError: (Object error, StackTrace stack) {
                decisionFailure = error;
                decisionCompleted = true;
              },
            ),
      );
      await pumpUntil(
        tester,
        () => decisionRequests.isNotEmpty || decisionCompleted,
        reason: 'the Decision creation request to reach the held response',
      );
      expect(decisionFailure, isNull);
      expect(decisionRequests, hasLength(1));
      expect(workspace.mutationBusy(ResultsMutationGroup.decisions), isTrue);
      await tester.ensureVisible(processingTab);
      await tester.tap(processingTab);
      await pumpUntil(
        tester,
        () => find.byType(ResultsPanel).evaluate().isEmpty,
        reason: 'the pending Decision to outlive the Results presentation',
      );
      await releaseDecision();
      await pumpUntil(
        tester,
        () => decisionCompleted,
        reason: 'the original Decision creation to finish',
      );
      expect(decisionFailure, isNull);
      expect(workspace.mutationBusy(ResultsMutationGroup.decisions), isFalse);
      expect(minutesReads, initialMinutesReads);

      await tester.ensureVisible(resultsTab);
      await tester.tap(resultsTab);
      await pumpUntil(
        tester,
        () => find.byType(ResultsPanel).evaluate().isNotEmpty,
        reason: 'Results to return after Decision creation',
      );
      expect(
        tester.widget<ResultsPanel>(find.byType(ResultsPanel)).workspace,
        same(workspace),
      );
      await tester.ensureVisible(minutesTab);
      await tester.tap(minutesTab);
      await pumpUntil(
        tester,
        () => workspace.minutes.data?.sourceFingerprint == 'after-decision',
        reason: 'the updated canonical Minutes to load',
      );
      expect(minutesReads, greaterThan(initialMinutesReads));
      expect(
        workspace.minutes.data!.confirmedDecisions.single.id,
        'decision-1',
      );
      expect(decisionRequests, hasLength(1));
      expect(tester.takeException(), isNull);
    } finally {
      // Even a failed assertion must release the held response, unmount the
      // real page and drain its shared observers without crossing clock zones.
      await releaseAdmission();
      await releaseDecision();
      await tester.pumpWidget(const SizedBox.shrink());
      unawaited(
        deps.shutdown().then<void>(
          (_) => shutdownCompleted = true,
          onError: (Object error, StackTrace stack) {
            shutdownFailure = error;
            shutdownCompleted = true;
          },
        ),
      );
      await pumpUntil(
        tester,
        () => shutdownCompleted,
        reason: 'application dependencies to finish shutdown',
      );
      expect(shutdownFailure, isNull);
    }
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

  test('resume verifies access before reusing inactive Results data', () async {
    final (:workspace, :repository) = await _setup();
    await workspace.loadTranscript();
    final epoch = workspace.readEpoch;
    expect(workspace.transcript.data, isNotNull);
    repository.pendingVerification = Completer<bool>();
    final verification = workspace.revalidateOnResume();
    await _eventually(() => workspace.isAuthorizationVerificationPending);
    expect(workspace.capabilities.canRead, isFalse);
    expect(workspace.transcript.data, isNull);
    expect(workspace.ownsRead(epoch), isFalse);
    repository.pendingVerification!.complete(true);
    await verification;
    expect(workspace.capabilities.canRead, isTrue);
    expect(repository.reads, 1);
    await workspace.loadTranscript();
    expect(repository.reads, 2);
    expect(workspace.transcript.data, isNotNull);
    repository.pendingVerification = null;
    repository.access = false;
    await workspace.revalidateOnResume();
    expect(workspace.capabilities.canRead, isFalse);
    expect(workspace.transcript.data, isNull);
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
              createdAt: _createdAt.subtract(Duration(seconds: page)),
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
    workspace.resolveUnknownManualCreation(
      epoch: epoch,
      reviewed: fresh!,
      disposition: ManualDecisionRecoveryDisposition.discard,
    );
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
