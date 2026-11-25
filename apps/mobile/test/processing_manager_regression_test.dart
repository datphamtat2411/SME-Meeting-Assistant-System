import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/features/recording/media_repository.dart';
import 'package:sme_meeting_assistant/features/recording/processing_manager.dart';
import 'package:sme_meeting_assistant/features/recording/processing_repository.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_repository.dart';

import 'support/meeting_test_support.dart';

void main() {
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
