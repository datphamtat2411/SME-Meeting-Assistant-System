import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite/sqflite.dart' as sqflite;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:sme_meeting_assistant/core/credential_storage.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_database.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_models.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_persistence.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_repository.dart'
    hide LocalMediaIdempotencyConflictException;
import 'package:sme_meeting_assistant/features/recording/managed_media_storage.dart';

void main() {
  setUpAll(() {
    sqfliteFfiInit();
    sqflite.databaseFactory = databaseFactoryFfi;
  });

  test(
    'persists scoped assets and upload checkpoints with optimistic fencing',
    () async {
      final directory = await Directory.systemTemp.createTemp('sme-media-db-');
      addTearDown(() => directory.delete(recursive: true));
      final database = await LocalMediaDatabase.open(
        databasePath: '${directory.path}/media.db',
        databaseFactory: databaseFactoryFfi,
      );
      final persistence = LocalMediaPersistence(database);
      addTearDown(database.close);
      final now = DateTime.utc(2026, 11, 24, 12);
      final asset = LocalMediaAsset(
        id: 'a' * 32,
        deploymentScope: 'deployment-a',
        ownerUserId: 'user-a',
        meetingId: 'meeting-a',
        sourceType: LocalMediaSourceType.recording,
        managedRelativePath: 'assets/${'a' * 32}.audio',
        stagedRelativePath: 'staging/${'a' * 32}.part',
        originalFilename: 'meeting.wav',
        contentType: 'audio/wav',
        sizeBytes: 3,
        durationMs: null,
        sha256: 'b' * 64,
        lifecycle: LocalMediaLifecycle.ready,
        sourceProvenance: 'source-a',
        quarantineReason: null,
        createdAt: now,
        updatedAt: now,
        readyAt: now,
        version: 0,
      );
      await persistence.insertAsset(asset);
      final operation = await persistence.insertUploadOperation(
        UploadOperation(
          id: 'c' * 32,
          assetId: asset.id,
          deploymentScope: asset.deploymentScope,
          ownerUserId: asset.ownerUserId,
          meetingId: asset.meetingId!,
          idempotencyKey: 'upload-a',
          requestFingerprint: 'd' * 64,
          sourceType: asset.sourceType,
          originalFilename: asset.originalFilename,
          contentType: asset.contentType,
          expectedSizeBytes: 3,
          remoteMediaId: null,
          checkpoint: UploadOperationCheckpoint.intentNotConfirmed,
          confirmedBytes: 0,
          attemptCount: 0,
          attemptOutcome: OperationAttemptOutcome.none,
          recoveryRequired: false,
          lastFailureCode: null,
          lastFailureStatus: null,
          lastFailureMessage: null,
          createdAt: now,
          updatedAt: now,
          version: 0,
        ),
      );

      final ready = await persistence.listAssets(
        deploymentScope: 'deployment-a',
        ownerUserId: 'user-a',
        meetingId: 'meeting-a',
      );
      expect(ready.single.id, asset.id);
      expect(
        await persistence.listAssets(
          deploymentScope: 'deployment-a',
          ownerUserId: 'user-b',
        ),
        isEmpty,
      );

      final checkpointed = await persistence.updateUploadOperation(
        operation.copyWith(
          checkpoint: UploadOperationCheckpoint.binaryTransferConfirmed,
          remoteMediaId: 'media-a',
          confirmedBytes: 3,
          updatedAt: now.add(const Duration(seconds: 1)),
        ),
        expectedVersion: operation.version,
      );
      expect(checkpointed.version, 1);
      expect(checkpointed.confirmedBytes, 3);
      await expectLater(
        persistence.updateUploadOperation(
          checkpointed.copyWith(
            checkpoint: UploadOperationCheckpoint.intentConfirmed,
            confirmedBytes: 3,
          ),
          expectedVersion: checkpointed.version,
        ),
        throwsA(isA<ArgumentError>()),
      );
      await expectLater(
        persistence.updateUploadOperation(
          operation,
          expectedVersion: operation.version,
        ),
        throwsA(isA<LocalMediaConflictException>()),
      );

      final concurrentCandidates = <UploadOperation>[
        for (final id in <String>['e', 'f'])
          UploadOperation(
            id: id * 32,
            assetId: asset.id,
            deploymentScope: asset.deploymentScope,
            ownerUserId: asset.ownerUserId,
            meetingId: asset.meetingId!,
            idempotencyKey: 'upload-concurrent',
            requestFingerprint: '1' * 64,
            sourceType: asset.sourceType,
            originalFilename: asset.originalFilename,
            contentType: asset.contentType,
            expectedSizeBytes: asset.sizeBytes!,
            remoteMediaId: null,
            checkpoint: UploadOperationCheckpoint.intentNotConfirmed,
            confirmedBytes: 0,
            attemptCount: 0,
            attemptOutcome: OperationAttemptOutcome.none,
            recoveryRequired: false,
            lastFailureCode: null,
            lastFailureStatus: null,
            lastFailureMessage: null,
            createdAt: now,
            updatedAt: now,
            version: 0,
          ),
      ];
      final concurrentResults = await Future.wait(
        concurrentCandidates.map(persistence.getOrCreateUploadOperation),
      );
      expect(concurrentResults[0].id, concurrentResults[1].id);
      await expectLater(
        persistence.getOrCreateUploadOperation(
          UploadOperation(
            id: 'g' * 32,
            assetId: asset.id,
            deploymentScope: asset.deploymentScope,
            ownerUserId: asset.ownerUserId,
            meetingId: asset.meetingId!,
            idempotencyKey: 'upload-concurrent',
            requestFingerprint: '2' * 64,
            sourceType: asset.sourceType,
            originalFilename: asset.originalFilename,
            contentType: asset.contentType,
            expectedSizeBytes: asset.sizeBytes!,
            remoteMediaId: null,
            checkpoint: UploadOperationCheckpoint.intentNotConfirmed,
            confirmedBytes: 0,
            attemptCount: 0,
            attemptOutcome: OperationAttemptOutcome.none,
            recoveryRequired: false,
            lastFailureCode: null,
            lastFailureStatus: null,
            lastFailureMessage: null,
            createdAt: now,
            updatedAt: now,
            version: 0,
          ),
        ),
        throwsA(isA<LocalMediaIdempotencyConflictException>()),
      );

      final processing = await persistence.insertProcessingOperation(
        ProcessingOperation(
          id: 'h' * 32,
          deploymentScope: asset.deploymentScope,
          ownerUserId: asset.ownerUserId,
          meetingId: asset.meetingId!,
          idempotencyKey: 'processing-a',
          requestFingerprint: '2' * 64,
          operationType: ProcessingOperationType.retry,
          sourceMediaId: null,
          targetJobId: 'target-job',
          resultingJobId: null,
          reprocessOfJobId: null,
          stageCode: null,
          checkpoint: ProcessingOperationCheckpoint.retryNotConfirmed,
          attemptCount: 0,
          attemptOutcome: OperationAttemptOutcome.none,
          recoveryRequired: false,
          lastFailureCode: null,
          lastFailureStatus: null,
          lastFailureMessage: null,
          createdAt: now,
          updatedAt: now,
          version: 0,
        ),
      );
      final processingConfirmed = await persistence.updateProcessingOperation(
        processing.copyWith(
          checkpoint: ProcessingOperationCheckpoint.retryConfirmed,
          resultingJobId: 'result-job',
        ),
        expectedVersion: processing.version,
      );
      expect(processingConfirmed.targetJobId, 'target-job');
      expect(processingConfirmed.resultingJobId, 'result-job');

      final uncertain = await persistence.updateUploadOperation(
        checkpointed.copyWith(
          attemptOutcome: OperationAttemptOutcome.uncertain,
          recoveryRequired: true,
          lastFailureCode: 'NETWORK_TIMEOUT',
          lastFailureStatus: null,
          lastFailureMessage: 'The upload outcome is unknown.',
        ),
        expectedVersion: checkpointed.version,
      );
      expect(
        uncertain.checkpoint,
        UploadOperationCheckpoint.binaryTransferConfirmed,
      );
      expect(uncertain.attemptOutcome, OperationAttemptOutcome.uncertain);
      expect(uncertain.recoveryRequired, isTrue);
    },
  );

  test('managed storage promotes streams and rejects path escape', () async {
    final directory = await Directory.systemTemp.createTemp('sme-media-fs-');
    addTearDown(() => directory.delete(recursive: true));
    final storage = ManagedMediaStorage(root: directory);
    await storage.ensureDirectories();
    final paths = storage.allocatePaths('e' * 32);
    final integrity = await storage.writeStreamToStaging(
      paths.stagedRelativePath,
      Stream<List<int>>.value(<int>[1, 2, 3]),
      expectedSizeBytes: 3,
    );
    await storage.promote(paths.stagedRelativePath, paths.managedRelativePath);
    expect(integrity.sizeBytes, 3);
    expect(
      (await storage.inspectFile(paths.managedRelativePath)).sha256,
      integrity.sha256,
    );
    expect(storage.contains('../outside'), isFalse);
    expect(() => storage.fileFor('../outside'), throwsA(isA<ArgumentError>()));
  });

  test(
    'upgrades version two provenance and operation rows without losing them',
    () async {
      final directory = await Directory.systemTemp.createTemp('sme-media-v2-');
      addTearDown(() => directory.delete(recursive: true));
      final databasePath = '${directory.path}/media.db';
      final legacy = await databaseFactoryFfi.openDatabase(
        databasePath,
        options: sqflite.OpenDatabaseOptions(
          version: 2,
          onConfigure: (db) async {
            await db.execute('PRAGMA foreign_keys = ON');
          },
          onCreate: (db, _) async {
            await db.execute('''
              CREATE TABLE local_media_assets (
                id TEXT PRIMARY KEY,
                deployment_scope TEXT NOT NULL,
                owner_user_id TEXT NOT NULL,
                meeting_id TEXT,
                source_type TEXT NOT NULL,
                managed_relative_path TEXT NOT NULL UNIQUE,
                staged_relative_path TEXT,
                original_filename TEXT NOT NULL,
                content_type TEXT NOT NULL,
                size_bytes INTEGER,
                duration_ms INTEGER,
                sha256 TEXT,
                lifecycle_state TEXT NOT NULL,
                source_provenance TEXT,
                quarantine_reason TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                ready_at TEXT,
                version INTEGER NOT NULL DEFAULT 0,
                UNIQUE (deployment_scope, owner_user_id, source_provenance)
              )
            ''');
            await db.execute('''
              CREATE TABLE upload_operations (
                id TEXT PRIMARY KEY,
                asset_id TEXT NOT NULL REFERENCES local_media_assets(id),
                deployment_scope TEXT NOT NULL,
                owner_user_id TEXT NOT NULL,
                idempotency_key TEXT NOT NULL,
                request_fingerprint TEXT NOT NULL,
                source_type TEXT NOT NULL,
                original_filename TEXT NOT NULL,
                content_type TEXT NOT NULL,
                expected_size_bytes INTEGER NOT NULL,
                remote_media_id TEXT,
                confirmed_checkpoint TEXT NOT NULL,
                confirmed_bytes INTEGER NOT NULL,
                attempt_count INTEGER NOT NULL,
                last_failure_code TEXT,
                last_failure_status INTEGER,
                last_failure_message TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                version INTEGER NOT NULL,
                UNIQUE (deployment_scope, owner_user_id, idempotency_key)
              )
            ''');
            await db.execute('''
              CREATE TABLE processing_operations (
                id TEXT PRIMARY KEY,
                deployment_scope TEXT NOT NULL,
                owner_user_id TEXT NOT NULL,
                meeting_id TEXT NOT NULL,
                idempotency_key TEXT NOT NULL,
                request_fingerprint TEXT NOT NULL,
                operation_type TEXT NOT NULL,
                source_media_id TEXT,
                target_job_id TEXT,
                reprocess_of_job_id TEXT,
                stage_code TEXT,
                confirmed_checkpoint TEXT NOT NULL,
                attempt_count INTEGER NOT NULL,
                last_failure_code TEXT,
                last_failure_status INTEGER,
                last_failure_message TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                version INTEGER NOT NULL,
                UNIQUE (deployment_scope, owner_user_id, idempotency_key)
              )
            ''');
            await db.execute('''
              CREATE TABLE local_media_migrations (
                id TEXT PRIMARY KEY,
                migration_key TEXT NOT NULL UNIQUE,
                deployment_scope TEXT,
                owner_user_id TEXT,
                source_description TEXT NOT NULL,
                state TEXT NOT NULL,
                detail TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
              )
            ''');
          },
        ),
      );
      final now = DateTime.utc(2026, 11, 24, 12).toIso8601String();
      await legacy.insert('local_media_assets', <String, Object?>{
        'id': 'a' * 32,
        'deployment_scope': 'deployment-a',
        'owner_user_id': 'user-a',
        'meeting_id': 'meeting-a',
        'source_type': 'RECORDING',
        'managed_relative_path': 'assets/${'a' * 32}.audio',
        'staged_relative_path': 'staging/${'a' * 32}.part',
        'original_filename': 'meeting.wav',
        'content_type': 'audio/wav',
        'size_bytes': 3,
        'duration_ms': null,
        'sha256': 'b' * 64,
        'lifecycle_state': 'READY',
        'source_provenance': 'same-source',
        'quarantine_reason': null,
        'created_at': now,
        'updated_at': now,
        'ready_at': now,
        'version': 0,
      });
      await legacy.insert('upload_operations', <String, Object?>{
        'id': 'c' * 32,
        'asset_id': 'a' * 32,
        'deployment_scope': 'deployment-a',
        'owner_user_id': 'user-a',
        'idempotency_key': 'upload-a',
        'request_fingerprint': 'd' * 64,
        'source_type': 'RECORDING',
        'original_filename': 'meeting.wav',
        'content_type': 'audio/wav',
        'expected_size_bytes': 3,
        'remote_media_id': null,
        'confirmed_checkpoint': 'INTENT_NOT_CONFIRMED',
        'confirmed_bytes': 0,
        'attempt_count': 0,
        'last_failure_code': null,
        'last_failure_status': null,
        'last_failure_message': null,
        'created_at': now,
        'updated_at': now,
        'version': 0,
      });
      await legacy.close();

      final database = await LocalMediaDatabase.open(
        databasePath: databasePath,
        databaseFactory: databaseFactoryFfi,
      );
      addTearDown(database.close);
      final persistence = LocalMediaPersistence(database);
      final assets = await persistence.listAssets(
        deploymentScope: 'deployment-a',
        ownerUserId: 'user-a',
      );
      expect(assets.single.sourceProvenance, 'same-source');
      expect(
        (await persistence.findUploadOperation(
          deploymentScope: 'deployment-a',
          ownerUserId: 'user-a',
          idempotencyKey: 'upload-a',
        ))!.meetingId,
        'meeting-a',
      );

      final second = assets.single.copyWith(
        lifecycle: LocalMediaLifecycle.creating,
        sizeBytes: null,
        sha256: null,
        readyAt: null,
        updatedAt: DateTime.utc(2026, 11, 24, 12, 1),
        version: 0,
      );
      await persistence.insertAsset(
        LocalMediaAsset(
          id: 'e' * 32,
          deploymentScope: second.deploymentScope,
          ownerUserId: second.ownerUserId,
          meetingId: 'meeting-b',
          sourceType: second.sourceType,
          managedRelativePath: 'assets/${'e' * 32}.audio',
          stagedRelativePath: 'staging/${'e' * 32}.part',
          originalFilename: second.originalFilename,
          contentType: second.contentType,
          sizeBytes: null,
          durationMs: null,
          sha256: null,
          lifecycle: LocalMediaLifecycle.creating,
          sourceProvenance: second.sourceProvenance,
          quarantineReason: null,
          createdAt: second.createdAt,
          updatedAt: second.updatedAt,
          readyAt: null,
          version: 0,
        ),
      );
      expect(
        await persistence.findAssetByProvenance(
          deploymentScope: 'deployment-a',
          ownerUserId: 'user-a',
          meetingId: 'meeting-b',
          sourceProvenance: 'same-source',
        ),
        isNotNull,
      );
    },
  );

  test(
    'legacy unscoped metadata is durably quarantined without deleting audio',
    () async {
      final directory = await Directory.systemTemp.createTemp(
        'sme-media-migrate-',
      );
      addTearDown(() => directory.delete(recursive: true));
      final database = await LocalMediaDatabase.open(
        databasePath: '${directory.path}/media.db',
        databaseFactory: databaseFactoryFfi,
      );
      final storage = ManagedMediaStorage(
        root: Directory('${directory.path}/managed'),
      );
      final credentials = InMemoryCredentialStorage();
      final audio = File('${directory.path}/legacy.wav')
        ..writeAsBytesSync(<int>[1, 2, 3]);
      await credentials.write(
        key: 'sme.mobile.recordings.v1',
        value: jsonEncode(<Map<String, dynamic>>[
          <String, dynamic>{
            'meetingId': 'meeting-a',
            'path': audio.path,
            'name': 'legacy.wav',
            'createdAt': '2026-11-24T12:00:00Z',
          },
        ]),
      );
      final repository = LocalMediaRepository(
        persistence: LocalMediaPersistence(database),
        storage: storage,
        legacyStorage: credentials,
      );
      addTearDown(repository.dispose);

      final migration = await repository.migrateLegacyMetadata();
      expect(migration?.state, LocalMediaMigrationState.quarantined);
      expect(await credentials.read(key: 'sme.mobile.recordings.v1'), isNull);
      expect(await audio.exists(), isTrue);
    },
  );

  test(
    'schema v4 keeps failed remote outcomes recoverable during correction',
    () async {
      final directory = await Directory.systemTemp.createTemp('sme-media-v4-');
      addTearDown(() => directory.delete(recursive: true));
      final databasePath = '${directory.path}/media.db';
      final database = await LocalMediaDatabase.open(
        databasePath: databasePath,
        databaseFactory: databaseFactoryFfi,
      );
      final persistence = LocalMediaPersistence(database);
      final now = DateTime.utc(2026, 11, 24, 12);
      final asset = LocalMediaAsset(
        id: 'i' * 32,
        deploymentScope: 'deployment-a',
        ownerUserId: 'user-a',
        meetingId: 'meeting-a',
        sourceType: LocalMediaSourceType.recording,
        managedRelativePath: 'assets/${'i' * 32}.audio',
        stagedRelativePath: 'staging/${'i' * 32}.part',
        originalFilename: 'meeting.wav',
        contentType: 'audio/wav',
        sizeBytes: 3,
        durationMs: null,
        sha256: 'a' * 64,
        lifecycle: LocalMediaLifecycle.ready,
        sourceProvenance: 'v4-source',
        quarantineReason: null,
        createdAt: now,
        updatedAt: now,
        readyAt: now,
        version: 0,
      );
      await persistence.insertAsset(asset);
      await persistence.insertUploadOperation(
        UploadOperation(
          id: 'k' * 32,
          assetId: asset.id,
          deploymentScope: asset.deploymentScope,
          ownerUserId: asset.ownerUserId,
          meetingId: asset.meetingId!,
          idempotencyKey: 'v4-upload',
          requestFingerprint: 'l' * 64,
          sourceType: asset.sourceType,
          originalFilename: asset.originalFilename,
          contentType: asset.contentType,
          expectedSizeBytes: 3,
          remoteMediaId: 'm' * 32,
          checkpoint: UploadOperationCheckpoint.failed,
          confirmedBytes: 3,
          attemptCount: 1,
          attemptOutcome: OperationAttemptOutcome.none,
          recoveryRequired: false,
          lastFailureCode: 'NETWORK_TIMEOUT',
          lastFailureStatus: null,
          lastFailureMessage: 'The previous attempt ended ambiguously.',
          createdAt: now,
          updatedAt: now,
          version: 0,
        ),
      );
      await database.database.execute('PRAGMA user_version = 3');
      await database.close();

      final upgraded = await LocalMediaDatabase.open(
        databasePath: databasePath,
        databaseFactory: databaseFactoryFfi,
      );
      addTearDown(upgraded.close);
      final operation = (await LocalMediaPersistence(upgraded)
          .findUploadOperation(
            deploymentScope: 'deployment-a',
            ownerUserId: 'user-a',
            idempotencyKey: 'v4-upload',
          ))!;
      expect(
        operation.checkpoint,
        UploadOperationCheckpoint.remoteReconciliationRequired,
      );
      expect(operation.confirmedBytes, 3);
      expect(operation.attemptOutcome, OperationAttemptOutcome.failed);
      expect(operation.recoveryRequired, isTrue);
    },
  );
}
