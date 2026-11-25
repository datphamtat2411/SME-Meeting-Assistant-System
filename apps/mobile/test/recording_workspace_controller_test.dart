import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sqflite/sqflite.dart' as sqflite;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/models.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_foundation.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_database.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_models.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_persistence.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_repository.dart';
import 'package:sme_meeting_assistant/features/recording/managed_media_storage.dart';
import 'package:sme_meeting_assistant/features/recording/media_repository.dart';
import 'package:sme_meeting_assistant/features/recording/processing_manager.dart';
import 'package:sme_meeting_assistant/features/recording/processing_repository.dart';
import 'package:sme_meeting_assistant/features/recording/recording_coordinator.dart';
import 'package:sme_meeting_assistant/features/recording/recording_workspace_controller.dart';
import 'package:sme_meeting_assistant/features/recording/submission_coordinator.dart';

import 'support/meeting_test_support.dart';

void main() {
  setUpAll(() {
    sqfliteFfiInit();
    sqflite.databaseFactory = databaseFactoryFfi;
  });

  test(
    'projects one meeting and fences protected state on session change',
    () async {
      final client = MeetingTestHttpClient((request) async {
        if (request.url.path.endsWith('/media') ||
            request.url.path.endsWith('/processing-jobs')) {
          return meetingApiSuccess(const <dynamic>[]);
        }
        throw StateError('Unexpected request ${request.url.path}');
      });
      final api = createMeetingTestApi(client);
      await signInMeetingTestApi(api);
      final directory = await Directory.systemTemp.createTemp('sme-workspace-');
      final database = await LocalMediaDatabase.open(
        databasePath: '${directory.path}/media.db',
        databaseFactory: databaseFactoryFfi,
      );
      final localMedia = LocalMediaRepository(
        persistence: LocalMediaPersistence(database),
        storage: ManagedMediaStorage(
          root: Directory('${directory.path}/managed'),
        ),
      );
      final media = MediaRepository(api: api);
      final processing = ProcessingRepository(api: api);
      final recording = RecordingCoordinator(
        api: api,
        localMedia: localMedia,
        observeAppLifecycle: false,
      );
      final submissions = SubmissionCoordinator(
        api: api,
        localMedia: localMedia,
        mediaRepository: media,
        processingRepository: processing,
      );
      final manager = ProcessingManager(
        api: api,
        mediaRepository: media,
        processingRepository: processing,
        localMedia: localMedia,
      );
      final capabilities = MeetingCapabilityPolicy.evaluate(
        callerId: testUserId,
        meeting: Meeting.fromJson(meetingTestJson(status: 'IN_PROGRESS')),
      );
      final controller = RecordingWorkspaceController(
        api: api,
        meetingId: testMeetingId,
        capabilities: capabilities,
        meetingStatus: MeetingStatus.inProgress,
        localMedia: localMedia,
        recording: recording,
        submissions: submissions,
        processingManager: manager,
      );
      addTearDown(() async {
        controller.dispose();
        manager.dispose();
        submissions.dispose();
        recording.dispose();
        await localMedia.dispose();
        await directory.delete(recursive: true);
        api.dispose();
      });

      await controller.initialize();
      expect(controller.loadState, RecordingWorkspaceLoadState.ready);
      expect(controller.assets, isEmpty);
      expect(controller.canReadMedia, isTrue);

      final readOnly = MeetingCapabilityPolicy.evaluate(
        callerId: '99999999-9999-4999-8999-999999999999',
        meeting: Meeting.fromJson(meetingTestJson(status: 'IN_PROGRESS')),
        callerIsActiveParticipant: true,
      );
      controller.updateContext(
        meetingId: testMeetingId,
        capabilities: readOnly,
        meetingStatus: MeetingStatus.inProgress,
      );
      expect(controller.canUpload, isFalse);
      expect(controller.canReadMedia, isTrue);

      await api.signOut();
      expect(controller.isSessionFenced, isTrue);
      expect(controller.assets, isEmpty);
      expect(controller.remoteState, isNull);
    },
  );

  test('busy import remains cancellable through the workspace', () async {
    final entered = Completer<void>();
    final pickerResult = Completer<AudioImportSource?>();
    final fixture = await _workspace(
      picker: () {
        entered.complete();
        return pickerResult.future;
      },
    );
    final controller = fixture.controller;
    final action = controller.importAudio();
    await entered.future;
    expect(controller.isBusy, isTrue);
    expect(controller.canCancelImport, isTrue);
    controller.cancelImport();
    pickerResult.complete(
      AudioImportSource(
        name: 'cancelled.wav',
        sizeBytes: 3,
        bytes: Stream<List<int>>.value(<int>[1, 2, 3]),
      ),
    );
    await action;
    expect(controller.isBusy, isFalse);
    expect(controller.canCancelImport, isFalse);
    expect(controller.failure, isA<AudioImportException>());
    expect(controller.assets, isEmpty);
  });

  test('old import failure cannot overwrite another meeting', () async {
    final entered = Completer<void>();
    final pickerResult = Completer<AudioImportSource?>();
    final fixture = await _workspace(
      picker: () {
        entered.complete();
        return pickerResult.future;
      },
    );
    final controller = fixture.controller;
    final action = controller.importAudio();
    await entered.future;
    controller.updateContext(
      meetingId: '99999999-9999-4999-8999-999999999999',
      capabilities: fixture.capabilities,
      meetingStatus: MeetingStatus.inProgress,
    );
    await controller.load();
    expect(controller.canCancelImport, isFalse);
    expect(controller.isBusy, isFalse);
    pickerResult.completeError(StateError('Old picker failed'));
    await action;
    expect(controller.failure, isNull);
    expect(controller.assets, isEmpty);
    expect(controller.isBusy, isFalse);
  });

  test('active submission can be cancelled while workspace is busy', () async {
    final intentStarted = Completer<void>();
    final intentResponse = Completer<http.StreamedResponse>();
    var puts = 0;
    final fixture = await _workspace(
      handler: (request) async {
        if (request.url.path.endsWith('/media/uploads')) {
          intentStarted.complete();
          return intentResponse.future;
        }
        if (request.method == 'PUT') puts++;
        throw StateError('Unexpected mutation ${request.url.path}');
      },
    );
    final source = File('${fixture.directory.path}/recording.wav')
      ..writeAsBytesSync(<int>[1, 2, 3]);
    final asset = await fixture.localMedia.rememberSourceFile(
      scope: fixture.api.requireAuthenticatedSessionScope(),
      meetingId: testMeetingId,
      source: source,
      sourceType: LocalMediaSourceType.recording,
      originalFilename: 'recording.wav',
      contentType: 'audio/wav',
      expectedSizeBytes: 3,
    );
    final controller = fixture.controller;
    await controller.load();
    controller.selectAsset(asset);
    final submission = controller.submitSelected();
    await intentStarted.future;
    expect(controller.isBusy, isTrue);
    expect(controller.canCancelSubmission, isTrue);
    controller.cancelSubmission();
    intentResponse.complete(
      await meetingApiSuccess(<String, dynamic>{
        'mediaId': 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        'status': 'PENDING_UPLOAD',
        'uploadUrl': 'https://storage.example.test/object',
        'expiresAt': DateTime.now()
            .toUtc()
            .add(const Duration(minutes: 10))
            .toIso8601String(),
        'requiredContentType': 'audio/wav',
      }),
    );
    await submission;
    expect(puts, 0);
    expect(controller.isBusy, isFalse);
    expect(controller.canCancelSubmission, isFalse);
  });

  test('retry recovery works with target job and no source media', () async {
    const jobId = '11111111-1111-4111-8111-111111111111';
    var retryCalls = 0;
    String? requestKey;
    final fixture = await _workspace(
      handler: (request) async {
        if (request.url.path.endsWith('/retry')) {
          retryCalls++;
          requestKey = request.headers['Idempotency-Key'];
          return meetingApiSuccess(_retryJobJson(jobId, retryable: false));
        }
        if (request.url.path.endsWith('/processing-jobs/$jobId')) {
          return meetingApiSuccess(_retryJobJson(jobId, retryable: true));
        }
        throw StateError('Unexpected request ${request.url.path}');
      },
    );
    final scope = fixture.api.requireAuthenticatedSessionScope();
    final operation = await fixture.localMedia.beginProcessingOperation(
      scope: scope,
      meetingId: testMeetingId,
      idempotencyKey: 'retry-without-source-media',
      operationType: ProcessingOperationType.retry,
      targetJobId: jobId,
    );
    final controller = fixture.controller;
    await controller.load();
    final recovery = controller.recoverableOperations.single;
    expect(recovery.processingOperation?.sourceMediaId, isNull);
    expect(controller.canResumeRecovery(recovery), isTrue);
    await controller.resumeRecovery(recovery);
    final operations = await fixture.localMedia.listProcessingOperations(
      scope: scope,
      meetingId: testMeetingId,
    );
    expect(retryCalls, 1);
    expect(requestKey, operation.idempotencyKey);
    expect(operations.single.id, operation.id);
    expect(
      operations.single.checkpoint,
      ProcessingOperationCheckpoint.retryConfirmed,
    );
    expect(controller.recoverableOperations, isEmpty);
  });
}

Map<String, dynamic> _retryJobJson(String id, {required bool retryable}) =>
    <String, dynamic>{
      'id': id,
      'meetingId': testMeetingId,
      'sourceMediaId': null,
      'jobType': 'DERIVED_STAGE_PROCESSING',
      'status': retryable ? 'FAILED' : 'QUEUED',
      'requestedByUserId': null,
      'currentStage': null,
      'queuedAt': '2026-11-24T12:00:00Z',
      'startedAt': null,
      'completedAt': null,
      'errorCode': null,
      'errorSummary': null,
      'warningSummary': null,
      'createdAt': '2026-11-24T12:00:00Z',
      'updatedAt': '2026-11-24T12:01:00Z',
      'reprocessOfJobId': null,
      'retryable': retryable,
      'retryCount': retryable ? 0 : 1,
      'stageRuns': <Map<String, dynamic>>[],
    };

Future<
  ({
    ApiClient api,
    Directory directory,
    LocalMediaRepository localMedia,
    MeetingCapabilities capabilities,
    RecordingWorkspaceController controller,
  })
>
_workspace({
  AudioImportPicker? picker,
  Future<http.StreamedResponse> Function(http.BaseRequest)? handler,
}) async {
  final client = MeetingTestHttpClient((request) async {
    if (request.url.path.endsWith('/media') ||
        request.url.path.endsWith('/processing-jobs')) {
      return meetingApiSuccess(const <dynamic>[]);
    }
    if (handler != null) return handler(request);
    throw StateError('Unexpected request ${request.url.path}');
  });
  final api = createMeetingTestApi(client);
  await signInMeetingTestApi(api);
  final directory = await Directory.systemTemp.createTemp('sme-workspace-');
  final database = await LocalMediaDatabase.open(
    databasePath: '${directory.path}/media.db',
    databaseFactory: databaseFactoryFfi,
  );
  final localMedia = LocalMediaRepository(
    persistence: LocalMediaPersistence(database),
    storage: ManagedMediaStorage(root: Directory('${directory.path}/managed')),
  );
  final media = MediaRepository(api: api);
  final processing = ProcessingRepository(api: api);
  final recording = RecordingCoordinator(
    api: api,
    localMedia: localMedia,
    picker: picker,
    observeAppLifecycle: false,
  );
  final submissions = SubmissionCoordinator(
    api: api,
    localMedia: localMedia,
    mediaRepository: media,
    processingRepository: processing,
  );
  final manager = ProcessingManager(
    api: api,
    mediaRepository: media,
    processingRepository: processing,
    localMedia: localMedia,
  );
  final capabilities = MeetingCapabilityPolicy.evaluate(
    callerId: testUserId,
    meeting: Meeting.fromJson(meetingTestJson(status: 'IN_PROGRESS')),
  );
  final controller = RecordingWorkspaceController(
    api: api,
    meetingId: testMeetingId,
    capabilities: capabilities,
    meetingStatus: MeetingStatus.inProgress,
    localMedia: localMedia,
    recording: recording,
    submissions: submissions,
    processingManager: manager,
  );
  addTearDown(() async {
    controller.dispose();
    manager.dispose();
    submissions.dispose();
    recording.dispose();
    await localMedia.dispose();
    await directory.delete(recursive: true);
    api.dispose();
  });

  await controller.initialize();
  return (
    api: api,
    directory: directory,
    localMedia: localMedia,
    capabilities: capabilities,
    controller: controller,
  );
}
