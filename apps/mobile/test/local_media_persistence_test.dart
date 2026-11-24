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
          checkpoint: UploadOperationCheckpoint.intentConfirmed,
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
          operation,
          expectedVersion: operation.version,
        ),
        throwsA(isA<LocalMediaConflictException>()),
      );
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
}
