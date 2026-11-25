import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:sqflite/sqflite.dart' as sqflite;
import 'package:sme_meeting_assistant/core/models.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_foundation.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_database.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_models.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_persistence.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_repository.dart';
import 'package:sme_meeting_assistant/features/recording/media_repository.dart';
import 'package:sme_meeting_assistant/features/recording/processing_repository.dart';
import 'package:sme_meeting_assistant/features/recording/submission_coordinator.dart';
import 'package:sme_meeting_assistant/features/recording/managed_media_storage.dart';

import 'support/http_test_support.dart';
import 'support/meeting_test_support.dart';

void main() {
  setUpAll(() {
    sqfliteFfiInit();
    sqflite.databaseFactory = databaseFactoryFfi;
  });

  test(
    'an unrelated API notification does not cancel an active submission',
    () async {
      final intentStarted = Completer<void>();
      final intentResponse = Completer<http.StreamedResponse>();
      final client = MeetingTestHttpClient((request) async {
        final path = request.url.path;
        if (path.endsWith('/media/uploads')) {
          intentStarted.complete();
          return intentResponse.future;
        }
        if (request.method == 'PUT') {
          await request.finalize().drain<void>();
          return streamedResponse(200);
        }
        if (path.endsWith('/finalize')) {
          return meetingApiSuccess(_availableMediaJson());
        }
        throw StateError('Unexpected request $path');
      });
      final api = createMeetingTestApi(client);
      await signInMeetingTestApi(api);
      final directory = await Directory.systemTemp.createTemp('sme-submit-');
      final database = await LocalMediaDatabase.open(
        databasePath: '${directory.path}/media.db',
        databaseFactory: databaseFactoryFfi,
      );
      final repository = LocalMediaRepository(
        persistence: LocalMediaPersistence(database),
        storage: ManagedMediaStorage(
          root: Directory('${directory.path}/managed'),
        ),
      );
      final coordinator = SubmissionCoordinator(
        api: api,
        localMedia: repository,
        mediaRepository: MediaRepository(api: api),
        processingRepository: ProcessingRepository(api: api),
      );
      addTearDown(() async {
        coordinator.dispose();
        await repository.dispose();
        await directory.delete(recursive: true);
        api.dispose();
      });

      final source = File('${directory.path}/meeting.wav')
        ..writeAsBytesSync(<int>[1, 2, 3]);
      final meeting = Meeting.fromJson(meetingTestJson(status: 'IN_PROGRESS'));
      final capabilities = MeetingCapabilityPolicy.evaluate(
        callerId: testUserId,
        meeting: meeting,
      );
      final asset = await repository.rememberSourceFile(
        scope: api.requireAuthenticatedSessionScope(),
        meetingId: testMeetingId,
        source: source,
        sourceType: LocalMediaSourceType.recording,
        originalFilename: 'meeting.wav',
        contentType: 'audio/wav',
        expectedSizeBytes: 3,
      );

      final submission = coordinator.submit(
        asset: asset,
        capabilities: capabilities,
        admitProcessing: false,
      );
      await intentStarted.future;
      // ApiClient notifications are also emitted by unrelated authenticated
      // state changes. The execution must remain tied to its original scope.
      api.notifyListeners();
      intentResponse.complete(
        await meetingApiSuccess(<String, dynamic>{
          'mediaId': testMediaId,
          'status': 'PENDING_UPLOAD',
          'uploadUrl': 'https://storage.example.test/object',
          'expiresAt': DateTime.now()
              .toUtc()
              .add(const Duration(minutes: 10))
              .toIso8601String(),
          'requiredContentType': 'audio/wav',
        }),
      );

      final result = await submission;
      expect(result.lifecycle, SubmissionLifecycleState.mediaAvailable);
      expect(result.uploadOperation?.remoteMediaId, testMediaId);
    },
  );

  test(
    'resume executes the requested durable operation instead of latest state',
    () async {
      final requestedMediaId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      final newerMediaId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
      final client = MeetingTestHttpClient((request) async {
        final path = request.url.path;
        if (path.contains('/media/') && !path.endsWith('/finalize')) {
          final mediaId = path.split('/').last;
          return meetingApiSuccess(_availableMediaJson(id: mediaId));
        }
        throw StateError('Unexpected request $path');
      });
      final api = createMeetingTestApi(client);
      await signInMeetingTestApi(api);
      final directory = await Directory.systemTemp.createTemp('sme-resume-');
      final database = await LocalMediaDatabase.open(
        databasePath: '${directory.path}/media.db',
        databaseFactory: databaseFactoryFfi,
      );
      final repository = LocalMediaRepository(
        persistence: LocalMediaPersistence(database),
        storage: ManagedMediaStorage(
          root: Directory('${directory.path}/managed'),
        ),
      );
      final coordinator = SubmissionCoordinator(
        api: api,
        localMedia: repository,
        mediaRepository: MediaRepository(api: api),
        processingRepository: ProcessingRepository(api: api),
      );
      addTearDown(() async {
        coordinator.dispose();
        await repository.dispose();
        await directory.delete(recursive: true);
        api.dispose();
      });

      final source = File('${directory.path}/meeting.wav')
        ..writeAsBytesSync(<int>[1, 2, 3]);
      final scope = api.requireAuthenticatedSessionScope();
      final asset = await repository.rememberSourceFile(
        scope: scope,
        meetingId: testMeetingId,
        source: source,
        sourceType: LocalMediaSourceType.recording,
        originalFilename: 'meeting.wav',
        contentType: 'audio/wav',
        expectedSizeBytes: 3,
      );
      final capabilities = MeetingCapabilityPolicy.evaluate(
        callerId: testUserId,
        meeting: Meeting.fromJson(meetingTestJson(status: 'IN_PROGRESS')),
      );
      final first = await repository.beginUploadOperation(
        scope: scope,
        asset: asset,
        idempotencyKey: 'resume-old-operation',
      );
      await repository.beginUploadOperation(
        scope: scope,
        asset: asset,
        idempotencyKey: 'resume-new-operation',
      );
      final operations = await repository.listUploadOperations(
        scope: scope,
        assetId: asset.id,
      );
      final target = operations.lastWhere((item) => item.id == first.id);
      await repository.updateUploadOperation(
        target,
        scope: scope,
        checkpoint: UploadOperationCheckpoint.intentConfirmed,
        remoteMediaId: requestedMediaId,
        attemptCount: 1,
        attemptOutcome: OperationAttemptOutcome.succeeded,
      );
      final other = operations.firstWhere((item) => item.id != target.id);
      await repository.updateUploadOperation(
        other,
        scope: scope,
        checkpoint: UploadOperationCheckpoint.intentConfirmed,
        remoteMediaId: newerMediaId,
        attemptCount: 1,
        attemptOutcome: OperationAttemptOutcome.succeeded,
      );

      final result = await coordinator.resume(
        operationId: target.id,
        scope: scope,
        capabilities: capabilities,
        admitProcessing: false,
      );

      expect(result.lifecycle, SubmissionLifecycleState.mediaAvailable);
      expect(result.media?.id, requestedMediaId);
      expect(
        client.requests.any(
          (request) => request.url.path.endsWith('/media/$requestedMediaId'),
        ),
        isTrue,
      );
      expect(
        client.requests.any(
          (request) => request.url.path.endsWith('/media/$newerMediaId'),
        ),
        isFalse,
      );
    },
  );

  for (final checkpoint in <UploadOperationCheckpoint>[
    UploadOperationCheckpoint.intentConfirmed,
    UploadOperationCheckpoint.binaryTransferConfirmed,
  ]) {
    test('resume reconciles $checkpoint without local audio', () async {
      final admit =
          checkpoint == UploadOperationCheckpoint.binaryTransferConfirmed;
      final admissionStarted = Completer<void>();
      final admissionResponse = Completer<http.StreamedResponse>();
      var admissionRequests = 0;
      final client = MeetingTestHttpClient((request) async {
        if (request.method == 'GET' &&
            request.url.path.endsWith('/media/$testMediaId')) {
          return meetingApiSuccess(_availableMediaJson());
        }
        if (request.method == 'POST' &&
            request.url.path.endsWith('/processing-jobs')) {
          admissionRequests++;
          if (!admissionStarted.isCompleted) admissionStarted.complete();
          return admissionResponse.future;
        }
        throw StateError('Unexpected request ${request.url.path}');
      });
      final api = createMeetingTestApi(client);
      await signInMeetingTestApi(api);
      final directory = await Directory.systemTemp.createTemp('sme-resume-');
      final database = await LocalMediaDatabase.open(
        databasePath: '${directory.path}/media.db',
        databaseFactory: databaseFactoryFfi,
      );
      final repository = LocalMediaRepository(
        persistence: LocalMediaPersistence(database),
        storage: ManagedMediaStorage(
          root: Directory('${directory.path}/managed'),
        ),
      );
      final coordinator = SubmissionCoordinator(
        api: api,
        localMedia: repository,
        mediaRepository: MediaRepository(api: api),
        processingRepository: ProcessingRepository(api: api),
      );
      addTearDown(() async {
        coordinator.dispose();
        await repository.dispose();
        await directory.delete(recursive: true);
        api.dispose();
      });

      final scope = api.requireAuthenticatedSessionScope();
      final source = File('${directory.path}/meeting.wav')
        ..writeAsBytesSync(<int>[1, 2, 3]);
      final asset = await repository.rememberSourceFile(
        scope: scope,
        meetingId: testMeetingId,
        source: source,
        sourceType: LocalMediaSourceType.recording,
        originalFilename: 'meeting.wav',
        contentType: 'audio/wav',
        expectedSizeBytes: 3,
      );
      final operation = await repository.beginUploadOperation(
        scope: scope,
        asset: asset,
        idempotencyKey: 'remote-first-resume',
      );
      await repository.updateUploadOperation(
        operation,
        scope: scope,
        checkpoint: checkpoint,
        remoteMediaId: testMediaId,
        confirmedBytes:
            checkpoint == UploadOperationCheckpoint.binaryTransferConfirmed
            ? 3
            : 0,
        attemptCount: 2,
        attemptOutcome: OperationAttemptOutcome.cancelled,
        recoveryRequired: true,
      );
      await repository.discard(scope: scope, assetId: asset.id);
      final capabilities = MeetingCapabilityPolicy.evaluate(
        callerId: testUserId,
        meeting: Meeting.fromJson(meetingTestJson(status: 'ENDED')),
      );

      final resumed = coordinator.resume(
        operationId: operation.id,
        scope: scope,
        capabilities: capabilities,
        admitProcessing: admit,
      );
      if (admit) {
        await admissionStarted.future.timeout(const Duration(seconds: 5));
        try {
          final competing = await coordinator
              .admitAvailableMedia(
                meetingId: testMeetingId,
                mediaId: testMediaId,
                scope: scope,
                capabilities: capabilities,
              )
              .timeout(const Duration(seconds: 5));
          expect(competing.failure, isA<SubmissionBusyException>());
          expect(admissionRequests, 1);
          final operations = await repository.listProcessingOperations(
            scope: scope,
            meetingId: testMeetingId,
            sourceMediaId: testMediaId,
          );
          expect(operations, hasLength(1));
          expect(operations.single.attemptCount, 1);
        } finally {
          admissionResponse.complete(
            await meetingApiSuccess(_admittedJobJson()),
          );
        }
      }
      final result = await resumed;

      expect(
        result.lifecycle,
        admit
            ? SubmissionLifecycleState.processingAccepted
            : SubmissionLifecycleState.mediaAvailable,
      );
      expect(result.media?.id, testMediaId);
      expect(result.uploadOperation?.id, operation.id);
      final persisted = await repository.findUploadOperationById(
        scope: scope,
        operationId: operation.id,
      );
      expect(
        persisted?.checkpoint,
        UploadOperationCheckpoint.finalizationConfirmed,
      );
      expect(persisted?.idempotencyKey, operation.idempotencyKey);
      expect(persisted?.confirmedBytes, 3);
      expect(
        client.requests
            .where((request) => request.url.path.contains('/media/'))
            .map((request) => request.method),
        admit ? <String>['GET', 'GET'] : <String>['GET'],
      );
      if (admit) {
        final operations = await repository.listProcessingOperations(
          scope: scope,
          meetingId: testMeetingId,
          sourceMediaId: testMediaId,
        );
        expect(operations, hasLength(1));
        expect(
          operations.single.checkpoint,
          ProcessingOperationCheckpoint.admissionConfirmed,
        );
        expect(operations.single.resultingJobId, testJobId);
        expect(operations.single.attemptCount, 1);
        expect(admissionRequests, 1);
      }
    });
  }

  test(
    'retained transfer uncertainty is not hidden by a cancelled recovery',
    () async {
      var intentRequests = 0;
      var putRequests = 0;
      var finalizeRequests = 0;
      final client = MeetingTestHttpClient((request) async {
        final path = request.url.path;
        if (request.method == 'GET' && path.endsWith('/media/$testMediaId')) {
          return meetingApiSuccess(_pendingMediaJson());
        }
        if (request.method == 'POST' && path.endsWith('/media/uploads')) {
          intentRequests++;
          return meetingApiSuccess(<String, dynamic>{
            'mediaId': testMediaId,
            'status': 'PENDING_UPLOAD',
            'uploadUrl': 'https://storage.example.test/object',
            'expiresAt': DateTime.now()
                .toUtc()
                .add(const Duration(minutes: 10))
                .toIso8601String(),
            'requiredContentType': 'audio/wav',
          });
        }
        if (request.method == 'PUT') {
          putRequests++;
          await request.finalize().drain<void>();
          return streamedResponse(200);
        }
        if (request.method == 'POST' && path.endsWith('/finalize')) {
          finalizeRequests++;
          return meetingApiSuccess(_availableMediaJson());
        }
        throw StateError('Unexpected request $path');
      });
      final api = createMeetingTestApi(client);
      await signInMeetingTestApi(api);
      final directory = await Directory.systemTemp.createTemp('sme-r01-');
      final database = await LocalMediaDatabase.open(
        databasePath: '${directory.path}/media.db',
        databaseFactory: databaseFactoryFfi,
      );
      final repository = LocalMediaRepository(
        persistence: LocalMediaPersistence(database),
        storage: ManagedMediaStorage(
          root: Directory('${directory.path}/managed'),
        ),
      );
      final coordinator = SubmissionCoordinator(
        api: api,
        localMedia: repository,
        mediaRepository: MediaRepository(api: api),
        processingRepository: ProcessingRepository(api: api),
      );
      addTearDown(() async {
        coordinator.dispose();
        await repository.dispose();
        await directory.delete(recursive: true);
        api.dispose();
      });

      final scope = api.requireAuthenticatedSessionScope();
      final source = File('${directory.path}/meeting.wav')
        ..writeAsBytesSync(<int>[1, 2, 3]);
      final asset = await repository.rememberSourceFile(
        scope: scope,
        meetingId: testMeetingId,
        source: source,
        sourceType: LocalMediaSourceType.recording,
        originalFilename: 'meeting.wav',
        contentType: 'audio/wav',
        expectedSizeBytes: 3,
      );
      final operation = await repository.beginUploadOperation(
        scope: scope,
        asset: asset,
        idempotencyKey: 'r01-uncertain-transfer',
      );
      await repository.updateUploadOperation(
        operation,
        scope: scope,
        checkpoint: UploadOperationCheckpoint.intentConfirmed,
        remoteMediaId: testMediaId,
        attemptCount: 2,
        attemptOutcome: OperationAttemptOutcome.cancelled,
        recoveryRequired: true,
      );
      final capabilities = MeetingCapabilityPolicy.evaluate(
        callerId: testUserId,
        meeting: Meeting.fromJson(meetingTestJson(status: 'IN_PROGRESS')),
      );

      final result = await coordinator.resume(
        operationId: operation.id,
        scope: scope,
        capabilities: capabilities,
        admitProcessing: false,
      );

      expect(result.lifecycle, SubmissionLifecycleState.mediaAvailable);
      expect(result.media?.id, testMediaId);
      expect(result.uploadOperation?.id, operation.id);
      expect(intentRequests, 0);
      expect(putRequests, 0);
      expect(finalizeRequests, 1);
      final persisted = await repository.findUploadOperationById(
        scope: scope,
        operationId: operation.id,
      );
      expect(persisted?.id, operation.id);
      expect(persisted?.remoteMediaId, testMediaId);
      expect(
        persisted?.checkpoint,
        UploadOperationCheckpoint.finalizationConfirmed,
      );
      expect(persisted?.recoveryRequired, isFalse);
    },
  );

  for (final interruption in <String>['cancelled', 'rejected', 'deferred']) {
    test(
      'uncertain PUT survives $interruption recovery and database reopen',
      () async {
        var intentRequests = 0;
        var putRequests = 0;
        var finalizeRequests = 0;
        var interruptRecovery = true;
        late SubmissionCoordinator coordinator;
        late LocalMediaAsset asset;
        final client = MeetingTestHttpClient((request) async {
          final path = request.url.path;
          if (request.method == 'POST' && path.endsWith('/media/uploads')) {
            intentRequests++;
            return meetingApiSuccess(<String, dynamic>{
              'mediaId': testMediaId,
              'status': 'PENDING_UPLOAD',
              'uploadUrl': 'https://storage.example.test/object',
              'expiresAt': DateTime.now()
                  .toUtc()
                  .add(const Duration(minutes: 10))
                  .toIso8601String(),
              'requiredContentType': 'audio/wav',
            });
          }
          if (request.method == 'PUT') {
            putRequests++;
            await request.finalize().drain<void>();
            throw http.ClientException('Acknowledgement lost');
          }
          if (request.method == 'GET' && path.endsWith('/media/$testMediaId')) {
            if (interruptRecovery) {
              switch (interruption) {
                case 'cancelled':
                  coordinator.cancel(asset.id);
                  break;
                case 'rejected':
                  return meetingApiFailure(403, 'AUTHZ_FORBIDDEN');
                case 'deferred':
                  return meetingApiFailure(
                    429,
                    'RATE_LIMIT_EXCEEDED',
                    headers: const <String, String>{'retry-after': '60'},
                  );
              }
            }
            return meetingApiSuccess(_pendingMediaJson());
          }
          if (request.method == 'POST' && path.endsWith('/finalize')) {
            finalizeRequests++;
            return meetingApiSuccess(_availableMediaJson());
          }
          throw StateError('Unexpected request $path');
        });
        final api = createMeetingTestApi(client);
        await signInMeetingTestApi(api);
        final directory = await Directory.systemTemp.createTemp('sme-chain-');
        Future<LocalMediaRepository> openRepository() async {
          final database = await LocalMediaDatabase.open(
            databasePath: '${directory.path}/media.db',
            databaseFactory: databaseFactoryFfi,
          );
          return LocalMediaRepository(
            persistence: LocalMediaPersistence(database),
            storage: ManagedMediaStorage(
              root: Directory('${directory.path}/managed'),
            ),
          );
        }

        var repository = await openRepository();
        SubmissionCoordinator createCoordinator() => SubmissionCoordinator(
          api: api,
          localMedia: repository,
          mediaRepository: MediaRepository(api: api),
          processingRepository: ProcessingRepository(api: api),
        );
        coordinator = createCoordinator();
        addTearDown(() async {
          coordinator.dispose();
          await repository.dispose();
          await directory.delete(recursive: true);
          api.dispose();
        });

        final scope = api.requireAuthenticatedSessionScope();
        final source = File('${directory.path}/meeting.wav')
          ..writeAsBytesSync(<int>[1, 2, 3]);
        asset = await repository.rememberSourceFile(
          scope: scope,
          meetingId: testMeetingId,
          source: source,
          sourceType: LocalMediaSourceType.recording,
          originalFilename: 'meeting.wav',
          contentType: 'audio/wav',
          expectedSizeBytes: 3,
        );
        final capabilities = MeetingCapabilityPolicy.evaluate(
          callerId: testUserId,
          meeting: Meeting.fromJson(meetingTestJson(status: 'IN_PROGRESS')),
        );

        final first = await coordinator.submit(
          asset: asset,
          capabilities: capabilities,
          admitProcessing: false,
        );
        final operation = first.uploadOperation!;
        expect(
          operation.checkpoint,
          UploadOperationCheckpoint.intentConfirmed,
        );
        expect(operation.attemptOutcome, OperationAttemptOutcome.uncertain);
        expect(operation.recoveryRequired, isTrue);
        expect(intentRequests, 1);
        expect(putRequests, 1);

        final interrupted = await coordinator.resume(
          operationId: operation.id,
          scope: scope,
          capabilities: capabilities,
          admitProcessing: false,
        );
        expect(
          interrupted.uploadOperation?.attemptOutcome,
          interruption == 'cancelled'
              ? OperationAttemptOutcome.cancelled
              : OperationAttemptOutcome.rejected,
        );
        expect(interrupted.uploadOperation?.recoveryRequired, isTrue);
        expect(finalizeRequests, 0);

        coordinator.dispose();
        await repository.dispose();
        repository = await openRepository();
        coordinator = createCoordinator();
        interruptRecovery = false;

        final recovered = await coordinator.recoverDurableState(
          scope: scope,
          meetingId: testMeetingId,
        );
        expect(recovered.single.uploadOperation?.id, operation.id);
        expect(
          recovered.single.lifecycle,
          SubmissionLifecycleState.reconciliationRequired,
        );
        final result = await coordinator.resume(
          operationId: operation.id,
          scope: scope,
          capabilities: capabilities,
          admitProcessing: false,
        );
        expect(result.lifecycle, SubmissionLifecycleState.mediaAvailable);
        expect(intentRequests, 1);
        expect(putRequests, 1);
        expect(finalizeRequests, 1);
        final persisted = await repository.findUploadOperationById(
          scope: scope,
          operationId: operation.id,
        );
        expect(persisted?.id, operation.id);
        expect(persisted?.idempotencyKey, operation.idempotencyKey);
        expect(persisted?.remoteMediaId, testMediaId);
        expect(
          persisted?.checkpoint,
          UploadOperationCheckpoint.finalizationConfirmed,
        );
        expect(persisted?.recoveryRequired, isFalse);
      },
    );
  }

  test('a failed remote read does not invent transfer uncertainty', () async {
    var failRead = true;
    var intentRequests = 0;
    var putRequests = 0;
    var finalizeRequests = 0;
    final client = MeetingTestHttpClient((request) async {
      final path = request.url.path;
      if (request.method == 'GET' && path.endsWith('/media/$testMediaId')) {
        if (failRead) throw http.ClientException('Read connection lost');
        return meetingApiSuccess(_pendingMediaJson());
      }
      if (request.method == 'POST' && path.endsWith('/media/uploads')) {
        intentRequests++;
        expect(request.headers['Idempotency-Key'], 'known-pending-intent');
        return meetingApiSuccess(<String, dynamic>{
          'mediaId': testMediaId,
          'status': 'PENDING_UPLOAD',
          'uploadUrl': 'https://storage.example.test/object',
          'expiresAt': DateTime.now()
              .toUtc()
              .add(const Duration(minutes: 10))
              .toIso8601String(),
          'requiredContentType': 'audio/wav',
        });
      }
      if (request.method == 'PUT') {
        putRequests++;
        await request.finalize().drain<void>();
        return streamedResponse(200);
      }
      if (request.method == 'POST' && path.endsWith('/finalize')) {
        finalizeRequests++;
        return meetingApiSuccess(_availableMediaJson());
      }
      throw StateError('Unexpected request $path');
    });
    final api = createMeetingTestApi(client);
    await signInMeetingTestApi(api);
    final directory = await Directory.systemTemp.createTemp('sme-read-fail-');
    final database = await LocalMediaDatabase.open(
      databasePath: '${directory.path}/media.db',
      databaseFactory: databaseFactoryFfi,
    );
    final repository = LocalMediaRepository(
      persistence: LocalMediaPersistence(database),
      storage: ManagedMediaStorage(
        root: Directory('${directory.path}/managed'),
      ),
    );
    final coordinator = SubmissionCoordinator(
      api: api,
      localMedia: repository,
      mediaRepository: MediaRepository(api: api),
      processingRepository: ProcessingRepository(api: api),
      automaticRetries: 0,
    );
    addTearDown(() async {
      coordinator.dispose();
      await repository.dispose();
      await directory.delete(recursive: true);
      api.dispose();
    });

    final scope = api.requireAuthenticatedSessionScope();
    final source = File('${directory.path}/meeting.wav')
      ..writeAsBytesSync(<int>[1, 2, 3]);
    final asset = await repository.rememberSourceFile(
      scope: scope,
      meetingId: testMeetingId,
      source: source,
      sourceType: LocalMediaSourceType.recording,
      originalFilename: 'meeting.wav',
      contentType: 'audio/wav',
      expectedSizeBytes: 3,
    );
    final operation = await repository.beginUploadOperation(
      scope: scope,
      asset: asset,
      idempotencyKey: 'known-pending-intent',
    );
    await repository.updateUploadOperation(
      operation,
      scope: scope,
      checkpoint: UploadOperationCheckpoint.intentConfirmed,
      remoteMediaId: testMediaId,
      attemptCount: 1,
      attemptOutcome: OperationAttemptOutcome.succeeded,
    );
    final capabilities = MeetingCapabilityPolicy.evaluate(
      callerId: testUserId,
      meeting: Meeting.fromJson(meetingTestJson(status: 'IN_PROGRESS')),
    );
    final interrupted = await coordinator.resume(
      operationId: operation.id,
      scope: scope,
      capabilities: capabilities,
      admitProcessing: false,
    );
    expect(interrupted.uploadOperation?.recoveryRequired, isFalse);
    expect(interrupted.uploadOperation?.attemptCount, 1);
    expect(
      interrupted.uploadOperation?.attemptOutcome,
      OperationAttemptOutcome.failed,
    );
    expect(intentRequests, 0);
    expect(putRequests, 0);
    expect(finalizeRequests, 0);

    failRead = false;
    final resumed = await coordinator.resume(
      operationId: operation.id,
      scope: scope,
      capabilities: capabilities,
      admitProcessing: false,
    );
    expect(resumed.lifecycle, SubmissionLifecycleState.mediaAvailable);
    expect(resumed.uploadOperation?.id, operation.id);
    expect(intentRequests, 1);
    expect(putRequests, 1);
    expect(finalizeRequests, 1);
  });

  test(
    'workspace recovery projects durable upload operations before retrying',
    () async {
      final api = createMeetingTestApi(
        MeetingTestHttpClient(
          (_) => throw StateError('No remote recovery request is expected.'),
        ),
      );
      await signInMeetingTestApi(api);
      final directory = await Directory.systemTemp.createTemp('sme-recovery-');
      final database = await LocalMediaDatabase.open(
        databasePath: '${directory.path}/media.db',
        databaseFactory: databaseFactoryFfi,
      );
      final repository = LocalMediaRepository(
        persistence: LocalMediaPersistence(database),
        storage: ManagedMediaStorage(
          root: Directory('${directory.path}/managed'),
        ),
      );
      final coordinator = SubmissionCoordinator(
        api: api,
        localMedia: repository,
        mediaRepository: MediaRepository(api: api),
        processingRepository: ProcessingRepository(api: api),
      );
      addTearDown(() async {
        coordinator.dispose();
        await repository.dispose();
        await directory.delete(recursive: true);
        api.dispose();
      });

      final source = File('${directory.path}/meeting.wav')
        ..writeAsBytesSync(<int>[1, 2, 3]);
      final scope = api.requireAuthenticatedSessionScope();
      final asset = await repository.rememberSourceFile(
        scope: scope,
        meetingId: testMeetingId,
        source: source,
        sourceType: LocalMediaSourceType.recording,
        originalFilename: 'meeting.wav',
        contentType: 'audio/wav',
        expectedSizeBytes: 3,
      );
      final operation = await repository.beginUploadOperation(
        scope: scope,
        asset: asset,
        idempotencyKey: 'workspace-recovery-operation',
      );

      final recovered = await coordinator.recoverDurableState(
        scope: scope,
        meetingId: testMeetingId,
      );

      expect(recovered.single.assetId, asset.id);
      expect(
        recovered.single.lifecycle,
        SubmissionLifecycleState.recoverableFailure,
      );
      expect(recovered.single.uploadOperation?.id, operation.id);
      expect(coordinator.stateFor(asset.id)?.uploadOperation?.id, operation.id);
    },
  );
}

const testMediaId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const testJobId = '11111111-1111-4111-8111-111111111111';

Map<String, dynamic> _admittedJobJson() => <String, dynamic>{
  'id': testJobId,
  'meetingId': testMeetingId,
  'sourceMediaId': testMediaId,
  'jobType': 'OFFLINE_MEETING_PROCESSING',
  'status': 'QUEUED',
  'requestedByUserId': testUserId,
  'currentStage': null,
  'queuedAt': '2026-11-24T12:00:00Z',
  'startedAt': null,
  'completedAt': null,
  'errorCode': null,
  'errorSummary': null,
  'warningSummary': null,
  'createdAt': '2026-11-24T12:00:00Z',
  'updatedAt': '2026-11-24T12:00:00Z',
  'reprocessOfJobId': null,
  'retryable': false,
  'retryCount': 0,
  'stageRuns': <Map<String, dynamic>>[],
};

Map<String, dynamic> _availableMediaJson({
  String id = testMediaId,
}) => <String, dynamic>{
  'id': id,
  'meetingId': testMeetingId,
  'sourceType': 'RECORDING',
  'status': 'AVAILABLE',
  'originalFilename': 'meeting.wav',
  'contentType': 'audio/wav',
  'sizeBytes': 3,
  'durationMs': 1000,
  'sha256': '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
  'createdAt': '2026-11-24T12:00:00Z',
  'availableAt': '2026-11-24T12:01:00Z',
  'failureCode': null,
};

Map<String, dynamic> _pendingMediaJson({String id = testMediaId}) =>
    <String, dynamic>{
      ..._availableMediaJson(id: id),
      'status': 'PENDING_UPLOAD',
      'availableAt': null,
    };
