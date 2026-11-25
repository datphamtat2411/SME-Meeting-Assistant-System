import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite/sqflite.dart' as sqflite;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:sme_meeting_assistant/core/credential_storage.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_database.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_models.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_persistence.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_repository.dart';
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

      final initialCandidates = <ProcessingOperation>[
        ProcessingOperation(
          id: 'm' * 32,
          deploymentScope: asset.deploymentScope,
          ownerUserId: asset.ownerUserId,
          meetingId: asset.meetingId!,
          idempotencyKey: 'processing-initial-a',
          requestFingerprint: '3' * 64,
          operationType: ProcessingOperationType.admission,
          sourceMediaId: 'source-media',
          targetJobId: null,
          resultingJobId: null,
          reprocessOfJobId: null,
          stageCode: null,
          checkpoint: ProcessingOperationCheckpoint.admissionNotConfirmed,
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
        ProcessingOperation(
          id: 'n' * 32,
          deploymentScope: asset.deploymentScope,
          ownerUserId: asset.ownerUserId,
          meetingId: asset.meetingId!,
          idempotencyKey: 'processing-initial-b',
          requestFingerprint: '4' * 64,
          operationType: ProcessingOperationType.admission,
          sourceMediaId: 'source-media',
          targetJobId: null,
          resultingJobId: null,
          reprocessOfJobId: null,
          stageCode: null,
          checkpoint: ProcessingOperationCheckpoint.admissionNotConfirmed,
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
      final initialResults = await Future.wait(
        initialCandidates.map(persistence.getOrCreateInitialAdmission),
      );
      expect(initialResults[0].id, initialResults[1].id);
      final initialRows = await database.database.query(
        'processing_operations',
        where:
            'deployment_scope = ? AND owner_user_id = ? AND meeting_id = ? '
            'AND operation_type = ? AND source_media_id = ? '
            'AND reprocess_of_job_id IS NULL',
        whereArgs: <Object?>[
          asset.deploymentScope,
          asset.ownerUserId,
          asset.meetingId,
          ProcessingOperationType.admission.wireValue,
          'source-media',
        ],
      );
      expect(initialRows, hasLength(1));
      final indexes = await database.database.rawQuery(
        "PRAGMA index_list('processing_operations')",
      );
      expect(
        indexes.any((row) => row['name'] == 'ux_processing_initial_admission'),
        isTrue,
      );

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
          remoteMediaId: null,
          checkpoint: UploadOperationCheckpoint.intentNotConfirmed,
          confirmedBytes: 0,
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
      // Seed a row using the v4 representation. ignore_check_constraints is
      // limited to this fixture because v5 deliberately rejects these
      // obsolete checkpoint values for ordinary writes.
      await database.database.execute('PRAGMA ignore_check_constraints = ON');
      await database.database.update(
        'upload_operations',
        <String, Object?>{
          'remote_media_id': 'm' * 32,
          'confirmed_checkpoint': 'FAILED',
          'confirmed_bytes': 3,
        },
        where: 'id = ?',
        whereArgs: <Object?>['k' * 32],
      );
      await database.database.execute('PRAGMA ignore_check_constraints = OFF');
      await database.database.execute('PRAGMA user_version = 4');
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
        UploadOperationCheckpoint.binaryTransferConfirmed,
      );
      expect(operation.confirmedBytes, 3);
      expect(operation.attemptOutcome, OperationAttemptOutcome.failed);
      expect(operation.recoveryRequired, isTrue);
    },
  );

  test('schema v5 normalizes historical upload and processing evidence '
      'without erasing attempt outcomes', () async {
    final directory = await Directory.systemTemp.createTemp('sme-media-v5-');
    addTearDown(() => directory.delete(recursive: true));
    final databasePath = '${directory.path}/media.db';
    final database = await LocalMediaDatabase.open(
      databasePath: databasePath,
      databaseFactory: databaseFactoryFfi,
    );
    final persistence = LocalMediaPersistence(database);
    final now = DateTime.utc(2026, 11, 24, 12);
    final asset = LocalMediaAsset(
      id: 'v' * 32,
      deploymentScope: 'deployment-a',
      ownerUserId: 'user-a',
      meetingId: 'meeting-v5',
      sourceType: LocalMediaSourceType.recording,
      managedRelativePath: 'assets/${'v' * 32}.audio',
      stagedRelativePath: 'staging/${'v' * 32}.part',
      originalFilename: 'meeting.wav',
      contentType: 'audio/wav',
      sizeBytes: 3,
      durationMs: null,
      sha256: 'a' * 64,
      lifecycle: LocalMediaLifecycle.ready,
      sourceProvenance: 'v5-source',
      quarantineReason: null,
      createdAt: now,
      updatedAt: now,
      readyAt: now,
      version: 0,
    );
    await persistence.insertAsset(asset);
    await database.database.execute(
      'DROP TRIGGER IF EXISTS trg_processing_target_job_immutable',
    );
    await database.database.execute('PRAGMA ignore_check_constraints = ON');

    Future<void> seedUpload(
      String id,
      String key, {
      required String checkpoint,
      required String? remoteMediaId,
      required int confirmedBytes,
      required String outcome,
      required bool recoveryRequired,
    }) async {
      await persistence.insertUploadOperation(
        UploadOperation(
          id: id,
          assetId: asset.id,
          deploymentScope: asset.deploymentScope,
          ownerUserId: asset.ownerUserId,
          meetingId: asset.meetingId!,
          idempotencyKey: key,
          requestFingerprint: '$id-fingerprint',
          sourceType: asset.sourceType,
          originalFilename: asset.originalFilename,
          contentType: asset.contentType,
          expectedSizeBytes: 3,
          remoteMediaId: null,
          checkpoint: UploadOperationCheckpoint.intentNotConfirmed,
          confirmedBytes: 0,
          attemptCount: 1,
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
      await database.database.update(
        'upload_operations',
        <String, Object?>{
          'confirmed_checkpoint': checkpoint,
          'remote_media_id': remoteMediaId,
          'confirmed_bytes': confirmedBytes,
          'attempt_outcome': outcome,
          'recovery_required': recoveryRequired ? 1 : 0,
        },
        where: 'id = ?',
        whereArgs: <Object?>[id],
      );
    }

    await seedUpload(
      '1' * 32,
      'failed-with-remote',
      checkpoint: 'FAILED',
      remoteMediaId: 'm' * 32,
      confirmedBytes: 0,
      outcome: 'FAILED',
      recoveryRequired: false,
    );
    await seedUpload(
      '2' * 32,
      'ambiguous-full-transfer',
      checkpoint: 'REMOTE_RECONCILIATION_REQUIRED',
      remoteMediaId: null,
      confirmedBytes: 3,
      outcome: 'UNCERTAIN',
      recoveryRequired: true,
    );
    await seedUpload(
      '3' * 32,
      'insufficient-evidence',
      checkpoint: 'FAILED',
      remoteMediaId: null,
      confirmedBytes: 0,
      outcome: 'NONE',
      recoveryRequired: false,
    );
    await seedUpload(
      '4' * 32,
      'failed-finalization',
      checkpoint: 'FINALIZATION_CONFIRMED',
      remoteMediaId: 'n' * 32,
      confirmedBytes: 3,
      outcome: 'FAILED',
      recoveryRequired: true,
    );
    await seedUpload(
      '5' * 32,
      'uncertain-confirmed',
      checkpoint: 'INTENT_CONFIRMED',
      remoteMediaId: 'o' * 32,
      confirmedBytes: 0,
      outcome: 'UNCERTAIN',
      recoveryRequired: true,
    );

    Future<void> seedProcessing(
      String id,
      String key, {
      required ProcessingOperationType type,
      required String checkpoint,
      String? targetJobId,
      String? resultingJobId,
      String? reprocessOfJobId,
      required String outcome,
    }) async {
      await persistence.insertProcessingOperation(
        ProcessingOperation(
          id: id,
          deploymentScope: asset.deploymentScope,
          ownerUserId: asset.ownerUserId,
          meetingId: asset.meetingId!,
          idempotencyKey: key,
          requestFingerprint: '$id-fingerprint',
          operationType: type,
          sourceMediaId: 'source-media',
          targetJobId: targetJobId,
          resultingJobId: null,
          reprocessOfJobId: reprocessOfJobId,
          stageCode: 'TRANSCRIBE',
          checkpoint: switch (type) {
            ProcessingOperationType.admission =>
              ProcessingOperationCheckpoint.admissionNotConfirmed,
            ProcessingOperationType.retry =>
              ProcessingOperationCheckpoint.retryNotConfirmed,
            ProcessingOperationType.reprocess =>
              ProcessingOperationCheckpoint.reprocessNotConfirmed,
          },
          attemptCount: 1,
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
      await database.database.update(
        'processing_operations',
        <String, Object?>{
          'confirmed_checkpoint': checkpoint,
          'target_job_id': targetJobId,
          'resulting_job_id': resultingJobId,
          'reprocess_of_job_id': reprocessOfJobId,
          'attempt_outcome': outcome,
        },
        where: 'id = ?',
        whereArgs: <Object?>[id],
      );
    }

    await seedProcessing(
      '6' * 32,
      'historical-admission',
      type: ProcessingOperationType.admission,
      checkpoint: 'ADMISSION_CONFIRMED',
      targetJobId: 'job-admission',
      outcome: 'FAILED',
    );
    await seedProcessing(
      '7' * 32,
      'historical-retry',
      type: ProcessingOperationType.retry,
      checkpoint: 'FAILED',
      targetJobId: 'job-retry-target',
      outcome: 'FAILED',
    );
    await seedProcessing(
      '8' * 32,
      'historical-reprocess',
      type: ProcessingOperationType.reprocess,
      checkpoint: 'REPROCESS_CONFIRMED',
      reprocessOfJobId: 'job-original',
      outcome: 'NONE',
    );
    await database.database.execute('PRAGMA ignore_check_constraints = OFF');
    await database.database.execute('PRAGMA user_version = 4');
    await database.close();

    final upgraded = await LocalMediaDatabase.open(
      databasePath: databasePath,
      databaseFactory: databaseFactoryFfi,
    );
    final upgradedPersistence = LocalMediaPersistence(upgraded);
    addTearDown(upgraded.close);

    final failedWithRemote = (await upgradedPersistence.findUploadOperation(
      deploymentScope: 'deployment-a',
      ownerUserId: 'user-a',
      idempotencyKey: 'failed-with-remote',
    ))!;
    expect(
      failedWithRemote.checkpoint,
      UploadOperationCheckpoint.intentConfirmed,
    );
    expect(failedWithRemote.attemptOutcome, OperationAttemptOutcome.failed);
    expect(failedWithRemote.remoteMediaId, 'm' * 32);
    expect(failedWithRemote.recoveryRequired, isTrue);

    final fullTransfer = (await upgradedPersistence.findUploadOperation(
      deploymentScope: 'deployment-a',
      ownerUserId: 'user-a',
      idempotencyKey: 'ambiguous-full-transfer',
    ))!;
    expect(
      fullTransfer.checkpoint,
      UploadOperationCheckpoint.intentNotConfirmed,
    );
    expect(fullTransfer.confirmedBytes, 0);
    expect(fullTransfer.attemptOutcome, OperationAttemptOutcome.uncertain);
    expect(fullTransfer.recoveryRequired, isTrue);
    expect(
      fullTransfer.lastFailureCode,
      'HISTORICAL_TRANSFER_EVIDENCE_UNCONFIRMED',
    );

    final insufficient = (await upgradedPersistence.findUploadOperation(
      deploymentScope: 'deployment-a',
      ownerUserId: 'user-a',
      idempotencyKey: 'insufficient-evidence',
    ))!;
    expect(
      insufficient.checkpoint,
      UploadOperationCheckpoint.intentNotConfirmed,
    );
    expect(insufficient.attemptOutcome, OperationAttemptOutcome.failed);
    expect(insufficient.recoveryRequired, isTrue);

    final failedFinalization = (await upgradedPersistence.findUploadOperation(
      deploymentScope: 'deployment-a',
      ownerUserId: 'user-a',
      idempotencyKey: 'failed-finalization',
    ))!;
    expect(
      failedFinalization.checkpoint,
      UploadOperationCheckpoint.finalizationConfirmed,
    );
    expect(failedFinalization.attemptOutcome, OperationAttemptOutcome.failed);

    final uncertainConfirmed = (await upgradedPersistence.findUploadOperation(
      deploymentScope: 'deployment-a',
      ownerUserId: 'user-a',
      idempotencyKey: 'uncertain-confirmed',
    ))!;
    expect(
      uncertainConfirmed.attemptOutcome,
      OperationAttemptOutcome.uncertain,
    );
    expect(uncertainConfirmed.recoveryRequired, isTrue);

    final admission = (await upgradedPersistence.findProcessingOperation(
      deploymentScope: 'deployment-a',
      ownerUserId: 'user-a',
      idempotencyKey: 'historical-admission',
    ))!;
    expect(admission.targetJobId, isNull);
    expect(admission.resultingJobId, 'job-admission');
    expect(admission.attemptOutcome, OperationAttemptOutcome.failed);

    final retry = (await upgradedPersistence.findProcessingOperation(
      deploymentScope: 'deployment-a',
      ownerUserId: 'user-a',
      idempotencyKey: 'historical-retry',
    ))!;
    expect(retry.targetJobId, 'job-retry-target');
    expect(retry.checkpoint, ProcessingOperationCheckpoint.retryNotConfirmed);
    expect(retry.attemptOutcome, OperationAttemptOutcome.failed);
    expect(retry.recoveryRequired, isTrue);

    final reprocess = (await upgradedPersistence.findProcessingOperation(
      deploymentScope: 'deployment-a',
      ownerUserId: 'user-a',
      idempotencyKey: 'historical-reprocess',
    ))!;
    expect(
      reprocess.checkpoint,
      ProcessingOperationCheckpoint.reprocessNotConfirmed,
    );
    expect(reprocess.reprocessOfJobId, 'job-original');
    expect(reprocess.attemptOutcome, OperationAttemptOutcome.uncertain);
    expect(reprocess.recoveryRequired, isTrue);

    final reopened = await LocalMediaDatabase.open(
      databasePath: databasePath,
      databaseFactory: databaseFactoryFfi,
    );
    addTearDown(reopened.close);
    final reopenedOperation = (await LocalMediaPersistence(reopened)
        .findUploadOperation(
          deploymentScope: 'deployment-a',
          ownerUserId: 'user-a',
          idempotencyKey: 'ambiguous-full-transfer',
        ))!;
    expect(reopenedOperation.checkpoint, fullTransfer.checkpoint);
    expect(reopenedOperation.attemptOutcome, fullTransfer.attemptOutcome);
    expect(reopenedOperation.version, fullTransfer.version);
  });

  test('schema v6 preserves historical admission conflicts while fencing new writes', () async {
    final directory = await Directory.systemTemp.createTemp(
      'sme-media-v6-admission-',
    );
    addTearDown(() => directory.delete(recursive: true));
    final databasePath = '${directory.path}/media.db';
    final database = await LocalMediaDatabase.open(
      databasePath: databasePath,
      databaseFactory: databaseFactoryFfi,
    );
    final persistence = LocalMediaPersistence(database);
    final now = DateTime.utc(2026, 11, 24, 12);
    await database.database.execute(
      'DROP INDEX ux_processing_initial_admission',
    );
    await database.database.execute(
      'DROP TRIGGER trg_processing_initial_admission_unique_insert',
    );
    await database.database.execute(
      'DROP TRIGGER trg_processing_initial_admission_unique_update',
    );

    ProcessingOperation operation(String id, String key) => ProcessingOperation(
      id: id,
      deploymentScope: 'deployment-a',
      ownerUserId: 'user-a',
      meetingId: 'meeting-a',
      idempotencyKey: key,
      requestFingerprint: '$id-fingerprint',
      operationType: ProcessingOperationType.admission,
      sourceMediaId: 'source-a',
      targetJobId: null,
      resultingJobId: null,
      reprocessOfJobId: null,
      stageCode: null,
      checkpoint: ProcessingOperationCheckpoint.admissionNotConfirmed,
      attemptCount: 0,
      attemptOutcome: OperationAttemptOutcome.none,
      recoveryRequired: false,
      lastFailureCode: null,
      lastFailureStatus: null,
      lastFailureMessage: null,
      createdAt: now,
      updatedAt: now,
      version: 0,
    );

    await persistence.insertProcessingOperation(
      operation('o' * 32, 'historical-a'),
    );
    await persistence.insertProcessingOperation(
      operation('p' * 32, 'historical-b'),
    );
    await database.database.execute('PRAGMA user_version = 5');
    await database.close();

    final upgraded = await LocalMediaDatabase.open(
      databasePath: databasePath,
      databaseFactory: databaseFactoryFfi,
    );
    addTearDown(upgraded.close);
    final upgradedPersistence = LocalMediaPersistence(upgraded);
    final historical = await upgradedPersistence.listProcessingOperations(
      deploymentScope: 'deployment-a',
      ownerUserId: 'user-a',
      meetingId: 'meeting-a',
      sourceMediaId: 'source-a',
    );
    expect(historical, hasLength(2));
    await expectLater(
      upgradedPersistence.getOrCreateInitialAdmission(
        operation('q' * 32, 'new-attempt'),
      ),
      throwsA(isA<LocalMediaLogicalOperationConflictException>()),
    );
    await expectLater(
      upgraded.database.insert('processing_operations', <String, Object?>{
        'id': 'r' * 32,
        'deployment_scope': 'deployment-a',
        'owner_user_id': 'user-a',
        'meeting_id': 'meeting-a',
        'idempotency_key': 'direct-duplicate',
        'request_fingerprint': 'direct-fingerprint',
        'operation_type': 'ADMISSION',
        'source_media_id': 'source-a',
        'target_job_id': null,
        'resulting_job_id': null,
        'reprocess_of_job_id': null,
        'stage_code': null,
        'confirmed_checkpoint': 'ADMISSION_NOT_CONFIRMED',
        'attempt_count': 0,
        'attempt_outcome': 'NONE',
        'recovery_required': 0,
        'last_failure_code': null,
        'last_failure_status': null,
        'last_failure_message': null,
        'created_at': now.toIso8601String(),
        'updated_at': now.toIso8601String(),
        'version': 0,
      }),
      throwsA(isA<sqflite.DatabaseException>()),
    );
  });
}
