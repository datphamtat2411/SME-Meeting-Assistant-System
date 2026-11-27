import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:flutter/material.dart';
import 'package:sme_meeting_assistant/core/models.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_foundation.dart';
import 'package:sme_meeting_assistant/features/recording/processing_timeline_panel.dart';
import 'package:sme_meeting_assistant/features/recording/media_contracts.dart';
import 'package:sme_meeting_assistant/features/results/summary_regeneration_tracker.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/features/meetings/meeting_invalidation.dart';
import 'package:sme_meeting_assistant/features/results/results_invalidation.dart';
import 'package:sme_meeting_assistant/features/recording/media_repository.dart';
import 'package:sme_meeting_assistant/features/recording/processing_manager.dart';
import 'package:sme_meeting_assistant/features/recording/processing_repository.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_repository.dart';

import 'support/meeting_test_support.dart';

void main() {
  test('regeneration tracks the exact job and retains terminal outcomes', () {
    final tracker = SummaryRegenerationTracker();
    tracker.begin();
    expect(tracker.admitting, isTrue);
    tracker.admit(firstJobId);
    expect(tracker.pendingJobId, firstJobId);
    expect(
      tracker.observe(ProcessingJobRecord.fromJson(_jobJson(secondJobId))),
      isFalse,
    );
    final running = ProcessingJobRecord.fromJson(_jobJson(firstJobId));
    expect(tracker.observe(running), isTrue);
    expect(tracker.pendingJobId, firstJobId);
    final failed = ProcessingJobRecord.fromJson({
      ..._jobJson(firstJobId),
      'status': 'FAILED',
      'completedAt': '2026-11-24T12:02:00Z',
      'updatedAt': '2026-11-24T12:02:00Z',
      'errorSummary': 'Processing failed',
    });
    expect(tracker.observe(failed), isTrue);
    expect(tracker.pendingJobId, isNull);
    expect(tracker.job?.status, ProcessingJobStatus.failed);
    expect(tracker.observe(running), isFalse);
    expect(tracker.job, same(failed));
    tracker.clear();
    expect(tracker.job, isNull);
  });

  testWidgets(
    'processing notifications cannot republish jobs after access loss',
    (tester) async {
      final setup = await tester.runAsync(() async {
        final api = createMeetingTestApi(
          MeetingTestHttpClient((request) async {
            if (request.url.path.endsWith('/media')) {
              return meetingApiSuccess(const <dynamic>[]);
            }
            if (request.url.path.endsWith('/processing-jobs')) {
              return meetingApiSuccess([_jobJson(firstJobId)]);
            }
            throw StateError('Unexpected request ${request.url.path}');
          }),
        );
        await signInMeetingTestApi(api);
        final scope = api.requireAuthenticatedSessionScope();
        final manager = ProcessingManager(
          api: api,
          mediaRepository: MediaRepository(api: api),
          processingRepository: ProcessingRepository(api: api),
          localMedia: LocalMediaRepository.lazyDefault(),
        );
        final observation = manager.startObserving(testMeetingId, scope: scope);
        await manager.refresh(testMeetingId, scope: scope, explicit: true);
        return (
          api: api,
          manager: manager,
          observation: observation,
          scope: scope,
        );
      });
      final (:api, :manager, :observation, :scope) = setup!;
      addTearDown(() {
        observation.dispose();
        manager.dispose();
        api.dispose();
      });
      final meeting = Meeting.fromJson(meetingTestJson());
      Widget panel(bool allowed) => MaterialApp(
        home: Scaffold(
          body: ProcessingTimelinePanel(
            api: api,
            meetingId: testMeetingId,
            processingManager: manager,
            capabilities: MeetingCapabilityPolicy.evaluate(
              callerId: allowed ? meeting.organizerId : null,
              meeting: meeting,
            ),
          ),
        ),
      );
      await tester.pumpWidget(panel(true));
      await tester.pumpAndSettle();
      expect(find.text('Job ID: $firstJobId'), findsOneWidget);
      await tester.pumpWidget(panel(false));
      await tester.runAsync(
        () => manager.refresh(testMeetingId, scope: scope, explicit: true),
      );
      await tester.pumpAndSettle();
      expect(find.text('Job ID: $firstJobId'), findsNothing);
      expect(
        find.text('Bạn không có quyền xem tiến trình xử lý'),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    },
  );

  test('Results catches outcomes across an observation gap', () async {
    var completed = false;
    final client = MeetingTestHttpClient((request) async {
      if (request.url.path.endsWith('/media')) {
        return meetingApiSuccess(const <dynamic>[]);
      }
      if (request.url.path.endsWith('/processing-jobs')) {
        final job = _jobJson(firstJobId);
        if (completed) {
          job['status'] = 'COMPLETED';
          job['currentStage'] = null;
          job['completedAt'] = '2026-11-24T12:02:00Z';
          job['updatedAt'] = '2026-11-24T12:02:00Z';
        }
        return meetingApiSuccess([job]);
      }
      throw StateError('Unexpected request ${request.url.path}');
    });
    final api = createMeetingTestApi(client);
    await signInMeetingTestApi(api);
    final scope = api.requireAuthenticatedSessionScope();
    final meetings = MeetingInvalidationSignal(api);
    final invalidation = ResultsInvalidationSignal(
      api: api,
      meetingInvalidation: meetings,
    );
    final manager = ProcessingManager(
      api: api,
      mediaRepository: MediaRepository(api: api),
      processingRepository: ProcessingRepository(api: api),
      localMedia: LocalMediaRepository.lazyDefault(),
    );
    addTearDown(() {
      manager.dispose();
      invalidation.dispose();
      meetings.dispose();
      api.dispose();
    });
    final outcomes = <String, String>{};
    final other = manager.startObserving(testMeetingId, scope: scope);
    await manager.refresh(testMeetingId, scope: scope, explicit: true);
    final first = ResultsProcessingBridge(
      manager: manager,
      invalidation: invalidation,
      api: api,
      meetingId: testMeetingId,
      scope: scope,
      seenOutcomes: outcomes,
    );
    first.dispose();
    completed = true;
    await manager.refresh(testMeetingId, scope: scope, explicit: true);
    final before = invalidation.revision;
    final resumed = ResultsProcessingBridge(
      manager: manager,
      invalidation: invalidation,
      api: api,
      meetingId: testMeetingId,
      scope: scope,
      seenOutcomes: outcomes,
      publishInitial: true,
    );
    expect(invalidation.revision, before + 1);
    expect(invalidation.resources, contains(ResultsResourceKind.summary));
    expect(
      invalidation.resources,
      isNot(contains(ResultsResourceKind.transcript)),
    );
    resumed.reconcileCurrent();
    expect(invalidation.revision, before + 1);
    resumed.dispose();
    other.dispose();
  });

  test('explicit refreshes within one generation share one request', () async {
    final mediaResponse = Completer<http.StreamedResponse>();
    final jobsResponse = Completer<http.StreamedResponse>();
    var requests = 0;
    final client = MeetingTestHttpClient((request) async {
      if (request.url.path.endsWith('/media')) {
        return mediaResponse.future;
      }
      if (request.url.path.endsWith('/processing-jobs')) {
        requests++;
        return jobsResponse.future;
      }
      throw StateError('Unexpected request ${request.url.path}');
    });
    final api = createMeetingTestApi(client);
    await signInMeetingTestApi(api);
    final scope = api.requireAuthenticatedSessionScope();
    final manager = ProcessingManager(
      api: api,
      mediaRepository: MediaRepository(api: api),
      processingRepository: ProcessingRepository(api: api),
      localMedia: LocalMediaRepository.lazyDefault(),
    );
    addTearDown(() {
      manager.dispose();
      api.dispose();
    });

    final first = manager.refresh(testMeetingId, scope: scope, explicit: true);
    final second = manager.refresh(testMeetingId, scope: scope, explicit: true);
    expect(identical(first, second), isTrue);

    mediaResponse.complete(await meetingApiSuccess(const <dynamic>[]));
    jobsResponse.complete(await meetingApiSuccess(const <dynamic>[]));
    await Future.wait(<Future<void>>[first, second]);
    expect(requests, 1);
  });

  test(
    'a later observation generation wins over an earlier in-flight response',
    () async {
      final firstJobs = Completer<http.StreamedResponse>();
      final secondJobs = Completer<http.StreamedResponse>();
      var processingRequests = 0;
      final secondRequestStarted = Completer<void>();
      final client = MeetingTestHttpClient((request) async {
        if (request.url.path.endsWith('/media')) {
          return meetingApiSuccess(const <dynamic>[]);
        }
        if (request.url.path.endsWith('/processing-jobs')) {
          processingRequests++;
          if (processingRequests == 1) return firstJobs.future;
          secondRequestStarted.complete();
          return secondJobs.future;
        }
        throw StateError('Unexpected request ${request.url.path}');
      });
      final api = createMeetingTestApi(client);
      await signInMeetingTestApi(api);
      final scope = api.requireAuthenticatedSessionScope();
      final manager = ProcessingManager(
        api: api,
        mediaRepository: MediaRepository(api: api),
        processingRepository: ProcessingRepository(api: api),
        localMedia: LocalMediaRepository.lazyDefault(),
      );
      addTearDown(() {
        manager.dispose();
        api.dispose();
      });

      final firstObservation = manager.startObserving(
        testMeetingId,
        scope: scope,
      );
      await _eventually(() => processingRequests == 1);
      firstObservation.dispose();

      final stateChanged = Completer<void>();
      manager.addListener(() {
        final jobs = manager.stateFor(testMeetingId)?.jobs;
        if (jobs?.length == 1 &&
            jobs!.single.id == secondJobId &&
            !stateChanged.isCompleted) {
          stateChanged.complete();
        }
      });
      final secondObservation = manager.startObserving(
        testMeetingId,
        scope: scope,
      );
      await secondRequestStarted.future;
      secondJobs.complete(
        await meetingApiSuccess(<Map<String, dynamic>>[_jobJson(secondJobId)]),
      );
      await stateChanged.future;

      firstJobs.complete(
        await meetingApiSuccess(<Map<String, dynamic>>[_jobJson(firstJobId)]),
      );
      await Future<void>.value();

      expect(manager.stateFor(testMeetingId)?.jobs.single.id, secondJobId);
      secondObservation.dispose();
    },
  );
}

const firstJobId = '11111111-1111-4111-8111-111111111111';
const secondJobId = '22222222-2222-4222-8222-222222222222';

Map<String, dynamic> _jobJson(String id) => <String, dynamic>{
  'id': id,
  'meetingId': testMeetingId,
  'sourceMediaId': null,
  'jobType': 'DERIVED_STAGE_PROCESSING',
  'status': 'RUNNING',
  'requestedByUserId': null,
  'currentStage': 'TRANSCRIBING',
  'queuedAt': '2026-11-24T12:00:00Z',
  'startedAt': '2026-11-24T12:01:00Z',
  'completedAt': null,
  'errorCode': null,
  'errorSummary': null,
  'warningSummary': null,
  'createdAt': '2026-11-24T12:00:00Z',
  'updatedAt': '2026-11-24T12:01:00Z',
  'reprocessOfJobId': null,
  'retryable': false,
  'retryCount': 0,
  'stageRuns': <Map<String, dynamic>>[],
};

Future<void> _eventually(bool Function() condition) async {
  for (var attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await Future<void>.value();
  }
  fail('The expected request was not started.');
}
