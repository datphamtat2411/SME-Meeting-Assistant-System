import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite/sqflite.dart' as sqflite;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_database.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_models.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_persistence.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_repository.dart';
import 'package:sme_meeting_assistant/features/recording/managed_media_storage.dart';

import 'support/meeting_test_support.dart';

void main() {
  setUpAll(() {
    sqfliteFfiInit();
    sqflite.databaseFactory = databaseFactoryFfi;
  });

  test(
    'successful recording completion releases its writer lease for discard',
    () async {
      final fixture = await _Fixture.create();
      addTearDown(fixture.dispose);

      final asset = await fixture.repository.reserveAsset(
        scope: fixture.scope,
        meetingId: 'meeting-a',
        sourceType: LocalMediaSourceType.recording,
        originalFilename: 'recording.wav',
        contentType: 'audio/wav',
      );
      final staging = await fixture.repository.stagingFileFor(
        scope: fixture.scope,
        asset: asset,
      );
      await staging.writeAsBytes(<int>[1, 2, 3]);

      final completed = await fixture.repository.confirmFileCompletion(
        scope: fixture.scope,
        assetId: asset.id,
        expectedSizeBytes: 3,
      );
      expect(completed.lifecycle, LocalMediaLifecycle.ready);

      final discarded = await fixture.repository.discard(
        scope: fixture.scope,
        assetId: asset.id,
      );
      expect(discarded.lifecycle, LocalMediaLifecycle.discarded);
    },
  );

  test(
    'a second staging acquisition cannot become a competing writer',
    () async {
      final fixture = await _Fixture.create();
      addTearDown(fixture.dispose);

      final asset = await fixture.repository.reserveAsset(
        scope: fixture.scope,
        meetingId: 'meeting-a',
        sourceType: LocalMediaSourceType.recording,
        originalFilename: 'recording.wav',
        contentType: 'audio/wav',
      );
      await fixture.repository.stagingFileFor(
        scope: fixture.scope,
        asset: asset,
      );

      await expectLater(
        fixture.repository.stagingFileFor(scope: fixture.scope, asset: asset),
        throwsA(isA<LocalMediaBusyException>()),
      );
      await fixture.repository.recordInterruption(
        scope: fixture.scope,
        assetId: asset.id,
      );
    },
  );

  test('two readers protect until both owned actions release', () async {
    final fixture = await _Fixture.create();
    addTearDown(fixture.dispose);
    final asset = await fixture.readyAsset();
    final firstEntered = Completer<void>();
    final secondEntered = Completer<void>();
    final releaseFirst = Completer<void>();
    final releaseSecond = Completer<void>();

    final first = fixture.repository.withAssetProtection(
      scope: fixture.scope,
      assetId: asset.id,
      action: () async {
        firstEntered.complete();
        await releaseFirst.future;
      },
    );
    final second = fixture.repository.withAssetProtection(
      scope: fixture.scope,
      assetId: asset.id,
      action: () async {
        secondEntered.complete();
        await releaseSecond.future;
      },
    );
    await Future.wait(<Future<void>>[
      firstEntered.future,
      secondEntered.future,
    ]);

    await expectLater(
      fixture.repository.discard(scope: fixture.scope, assetId: asset.id),
      throwsA(isA<LocalMediaBusyException>()),
    );
    releaseFirst.complete();
    await first;
    await expectLater(
      fixture.repository.discard(scope: fixture.scope, assetId: asset.id),
      throwsA(isA<LocalMediaBusyException>()),
    );
    releaseSecond.complete();
    await second;

    expect(
      (await fixture.repository.discard(
        scope: fixture.scope,
        assetId: asset.id,
      )).lifecycle,
      LocalMediaLifecycle.discarded,
    );
  });

  test('failed completion releases only its writer protection', () async {
    final fixture = await _Fixture.create();
    addTearDown(fixture.dispose);
    final asset = await fixture.repository.reserveAsset(
      scope: fixture.scope,
      meetingId: 'meeting-a',
      sourceType: LocalMediaSourceType.recording,
      originalFilename: 'recording.wav',
      contentType: 'audio/wav',
    );
    final staging = await fixture.repository.stagingFileFor(
      scope: fixture.scope,
      asset: asset,
    );
    await staging.writeAsBytes(<int>[]);

    final completed = await fixture.repository.confirmFileCompletion(
      scope: fixture.scope,
      assetId: asset.id,
      expectedSizeBytes: 3,
    );
    expect(completed.lifecycle, LocalMediaLifecycle.interrupted);
    expect(
      (await fixture.repository.discard(
        scope: fixture.scope,
        assetId: asset.id,
      )).lifecycle,
      LocalMediaLifecycle.discarded,
    );
  });

  test('stale interruption cannot downgrade a completed asset', () async {
    final fixture = await _Fixture.create();
    addTearDown(fixture.dispose);
    final asset = await fixture.readyAsset();

    final interrupted = await fixture.repository.recordInterruption(
      scope: fixture.scope,
      assetId: asset.id,
      reason: 'STALE_CALLBACK',
    );
    expect(interrupted.lifecycle, LocalMediaLifecycle.ready);
  });

  test(
    'an unowned interruption cannot release an explicit writer lease',
    () async {
      final fixture = await _Fixture.create();
      addTearDown(fixture.dispose);
      final asset = await fixture.repository.reserveAsset(
        scope: fixture.scope,
        meetingId: 'meeting-a',
        sourceType: LocalMediaSourceType.recording,
        originalFilename: 'recording.wav',
        contentType: 'audio/wav',
      );
      final lease = await fixture.repository.stagingLeaseFor(
        scope: fixture.scope,
        asset: asset,
      );

      await expectLater(
        fixture.repository.recordInterruption(
          scope: fixture.scope,
          assetId: asset.id,
          reason: 'STALE_CALLBACK',
        ),
        throwsA(isA<LocalMediaBusyException>()),
      );
      await lease.release();
      expect(
        (await fixture.repository.recordInterruption(
          scope: fixture.scope,
          assetId: asset.id,
        )).lifecycle,
        LocalMediaLifecycle.interrupted,
      );
    },
  );
}

class _Fixture {
  _Fixture({
    required this.api,
    required this.database,
    required this.repository,
  }) : scope = api.requireAuthenticatedSessionScope();

  final ApiClient api;
  final LocalMediaDatabase database;
  final LocalMediaRepository repository;
  final AuthenticatedSessionScope scope;

  static Future<_Fixture> create() async {
    final api = createMeetingTestApi(
      MeetingTestHttpClient((_) => meetingApiFailure(404, 'NOT_USED')),
    );
    await signInMeetingTestApi(api);
    final directory = await Directory.systemTemp.createTemp('sme-leases-');
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
    return _Fixture(api: api, database: database, repository: repository)
      .._temporaryDirectory = directory;
  }

  Directory? _temporaryDirectory;

  Future<LocalMediaAsset> readyAsset() async {
    final asset = await repository.reserveAsset(
      scope: scope,
      meetingId: 'meeting-a',
      sourceType: LocalMediaSourceType.recording,
      originalFilename:
          'recording-${DateTime.now().microsecondsSinceEpoch}.wav',
      contentType: 'audio/wav',
    );
    final staging = await repository.stagingFileFor(scope: scope, asset: asset);
    await staging.writeAsBytes(<int>[1, 2, 3]);
    return repository.confirmFileCompletion(
      scope: scope,
      assetId: asset.id,
      expectedSizeBytes: 3,
    );
  }

  Future<void> dispose() async {
    await repository.dispose();
    await _temporaryDirectory?.delete(recursive: true);
    api.dispose();
  }
}
