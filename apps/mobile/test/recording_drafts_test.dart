import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sqflite/sqflite.dart' as sqflite;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_database.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_models.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_persistence.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_repository.dart';
import 'package:sme_meeting_assistant/features/recording/recording_drafts.dart';
import 'package:sme_meeting_assistant/features/recording/managed_media_storage.dart';

import 'support/http_test_support.dart';

const _apiUri = 'https://api.example.test/api/v1';
const _otherApiUri = 'https://other-api.example.test/api/v1';
const _userA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const _userB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

void main() {
  setUpAll(() {
    sqfliteFfiInit();
    sqflite.databaseFactory = databaseFactoryFfi;
  });

  test(
    'recording drafts remain scoped by deployment and verified user',
    () async {
      final storage = InMemoryCredentialStorage();
      final client = _DraftAuthClient(<String>[_userA, _userB, _userA]);
      final api = _api(client, storage: storage);
      addTearDown(api.dispose);
      final drafts = RecordingDrafts(storage: storage);
      final directory = await Directory.systemTemp.createTemp(
        'sme-recording-drafts-',
      );
      addTearDown(() => directory.delete(recursive: true));
      final audioA = File('${directory.path}/a.wav')
        ..writeAsBytesSync(<int>[1, 2, 3]);
      final audioB = File('${directory.path}/b.wav')
        ..writeAsBytesSync(<int>[4, 5, 6]);

      await api.initialize();
      await api.signIn('user-a@example.test', 'password');
      final scopeA = api.authenticatedSessionScope!;
      await drafts.remember('meeting-shared', audioA, session: scopeA);
      expect(
        (await drafts.list(
          'meeting-shared',
          api: api,
        )).map((draft) => draft.path),
        <String>[audioA.path],
      );

      await api.signOut();
      await api.signIn('user-b@example.test', 'password');
      await drafts.remember(
        'meeting-shared',
        audioB,
        session: api.authenticatedSessionScope!,
      );
      expect(
        (await drafts.list(
          'meeting-shared',
          api: api,
        )).map((draft) => draft.path),
        <String>[audioB.path],
      );
      expect(await audioA.exists(), isTrue);
      expect(await audioB.exists(), isTrue);

      await api.signOut();
      await api.signIn('user-a@example.test', 'password');
      expect(
        (await drafts.list(
          'meeting-shared',
          api: api,
        )).map((draft) => draft.path),
        <String>[audioA.path],
      );
      expect(await audioA.exists(), isTrue);
      expect(await audioB.exists(), isTrue);

      final otherDeployment = _api(
        _DraftAuthClient(<String>[_userA]),
        storage: InMemoryCredentialStorage(),
        baseUri: Uri.parse(_otherApiUri),
      );
      addTearDown(otherDeployment.dispose);
      await otherDeployment.initialize();
      await otherDeployment.signIn('user-a@example.test', 'password');
      expect(
        await drafts.list('meeting-shared', api: otherDeployment),
        isEmpty,
      );
    },
  );

  test(
    'legacy unscoped metadata is quarantined without deleting audio',
    () async {
      final storage = InMemoryCredentialStorage();
      final directory = await Directory.systemTemp.createTemp(
        'sme-recording-legacy-',
      );
      addTearDown(() => directory.delete(recursive: true));
      final audio = File('${directory.path}/legacy.wav')
        ..writeAsBytesSync(<int>[7, 8, 9]);
      await storage.write(
        key: RecordingDrafts.legacyStorageKey,
        value: jsonEncode(<Map<String, dynamic>>[
          <String, dynamic>{
            'meetingId': 'meeting-shared',
            'path': audio.path,
            'name': 'legacy.wav',
            'createdAt': '2026-11-24T12:00:00Z',
          },
        ]),
      );

      final api = _api(_DraftAuthClient(<String>[_userB]), storage: storage);
      addTearDown(api.dispose);
      await api.initialize();
      await api.signIn('user-b@example.test', 'password');

      expect(
        await RecordingDrafts(storage: storage)
            .list('meeting-shared', api: api),
        isEmpty,
      );
      expect(await audio.exists(), isTrue);
      expect(await storage.read(key: RecordingDrafts.legacyStorageKey), isNull);
      expect(
        await storage.read(key: RecordingDrafts.legacyQuarantineKey),
        isNotNull,
      );
    },
  );

  test('draft listing requires a currently verified session', () async {
    final storage = InMemoryCredentialStorage();
    final api = _api(_DraftAuthClient(<String>[_userA]), storage: storage);
    addTearDown(api.dispose);
    await api.initialize();

    await expectLater(
      RecordingDrafts(storage: storage).list('meeting', api: api),
      throwsA(isA<AuthSessionException>()),
    );
  });

  test('managed drafts expose stable asset identity and incomplete files stay recoverable', () async {
    final storage = InMemoryCredentialStorage();
    final api = _api(_DraftAuthClient(<String>[_userA]), storage: storage);
    addTearDown(api.dispose);
    final directory = await Directory.systemTemp.createTemp(
      'sme-recording-managed-drafts-',
    );
    addTearDown(() => directory.delete(recursive: true));
    final database = await LocalMediaDatabase.open(
      databasePath: '${directory.path}/media.db',
      databaseFactory: databaseFactoryFfi,
    );
    addTearDown(database.close);
    final managedStorage = ManagedMediaStorage(
      root: Directory('${directory.path}/managed'),
    );
    final repository = LocalMediaRepository(
      persistence: LocalMediaPersistence(database),
      storage: managedStorage,
      legacyStorage: storage,
    );
    addTearDown(repository.dispose);
    final drafts = RecordingDrafts(storage: storage, repository: repository);

    await api.initialize();
    await api.signIn('user-a@example.test', 'password');
    final scope = api.authenticatedSessionScope!;
    final reserved = await repository.reserveAsset(
      scope: scope,
      meetingId: 'reservation-meeting',
      sourceType: LocalMediaSourceType.recording,
      originalFilename: 'reserved.wav',
      contentType: 'audio/wav',
    );
    final repeatedReservation = await repository.reserveAsset(
      scope: scope,
      meetingId: 'reservation-meeting',
      sourceType: LocalMediaSourceType.recording,
      originalFilename: 'reserved.wav',
      contentType: 'audio/wav',
    );
    expect(repeatedReservation.id, reserved.id);
    final source = File('${directory.path}/source.wav')
      ..writeAsBytesSync(<int>[1, 2, 3]);
    final asset = await repository.rememberSourceFile(
      scope: scope,
      meetingId: 'meeting-shared',
      source: source,
      sourceType: LocalMediaSourceType.recording,
      originalFilename: 'source.wav',
      contentType: 'audio/wav',
      expectedSizeBytes: 3,
    );

    final listed = await drafts.list('meeting-shared', api: api);
    expect(listed.single.assetId, asset.id);
    expect(listed.single.meetingId, 'meeting-shared');

    await managedStorage.fileFor(asset.managedRelativePath).writeAsBytes(<int>[
      9,
      8,
      7,
    ]);
    expect(await drafts.list('meeting-shared', api: api), hasLength(1));
    await expectLater(
      repository.fileFor(scope: scope, asset: asset),
      throwsA(isA<LocalMediaUnavailableException>()),
    );
    await managedStorage.fileFor(asset.managedRelativePath).writeAsBytes(<int>[
      1,
      2,
      3,
    ]);

    final incompleteId = 'b' * 32;
    final incompletePaths = managedStorage.allocatePaths(incompleteId);
    await managedStorage.writeStreamToStaging(
      incompletePaths.stagedRelativePath,
      Stream<List<int>>.value(<int>[9]),
    );
    await LocalMediaPersistence(database).insertAsset(
      LocalMediaAsset(
        id: incompleteId,
        deploymentScope: scope.deploymentScope,
        ownerUserId: scope.userId,
        meetingId: 'meeting-shared',
        sourceType: LocalMediaSourceType.recording,
        managedRelativePath: incompletePaths.managedRelativePath,
        stagedRelativePath: incompletePaths.stagedRelativePath,
        originalFilename: 'incomplete.wav',
        contentType: 'audio/wav',
        sizeBytes: null,
        durationMs: null,
        sha256: null,
        lifecycle: LocalMediaLifecycle.staged,
        sourceProvenance: 'incomplete-source',
        quarantineReason: null,
        createdAt: DateTime.utc(2026, 11, 24, 12),
        updatedAt: DateTime.utc(2026, 11, 24, 12),
        readyAt: null,
        version: 0,
      ),
    );
    await repository.reconcile(scope: scope, meetingId: 'meeting-shared');
    final incomplete = await LocalMediaPersistence(database).findAsset(
      id: incompleteId,
      deploymentScope: scope.deploymentScope,
      ownerUserId: scope.userId,
    );
    expect(incomplete!.lifecycle, LocalMediaLifecycle.interrupted);
    expect(await drafts.list('meeting-shared', api: api), hasLength(1));
  });

  test(
    'an in-flight draft lookup is discarded after an account switch',
    () async {
      final storage = _DelayedDraftIndexStorage();
      final api = _api(
        _DraftAuthClient(<String>[_userA, _userB]),
        storage: storage,
      );
      addTearDown(api.dispose);
      final directory = await Directory.systemTemp.createTemp(
        'sme-recording-draft-race-',
      );
      addTearDown(() => directory.delete(recursive: true));
      final audio = File('${directory.path}/a.wav')
        ..writeAsBytesSync(<int>[1, 2, 3]);
      final drafts = RecordingDrafts(storage: storage);
      await api.initialize();
      await api.signIn('user-a@example.test', 'password');
      final scopeA = api.authenticatedSessionScope!;
      await drafts.remember('meeting-shared', audio, session: scopeA);

      storage.delayNextDraftIndexRead = true;
      final lookup = drafts.list('meeting-shared', api: api, session: scopeA);
      await storage.draftIndexReadStarted.future;
      await api.signOut();
      await api.signIn('user-b@example.test', 'password');
      storage.releaseDraftIndexRead.complete();

      await expectLater(lookup, throwsA(isA<AuthSessionException>()));
      expect(api.sessionState.identity!.userId.value, _userB);
    },
  );

  test('workspace recovery is scoped, single-flight, retryable, and protects writers', () async {
    final storage = _DelayedDraftIndexStorage();
    final api = _api(_DraftAuthClient(<String>[_userA]), storage: storage);
    addTearDown(api.dispose);
    final directory = await Directory.systemTemp.createTemp(
      'sme-recording-recovery-',
    );
    addTearDown(() => directory.delete(recursive: true));
    final database = await LocalMediaDatabase.open(
      databasePath: '${directory.path}/media.db',
      databaseFactory: databaseFactoryFfi,
    );
    addTearDown(database.close);
    final managedStorage = ManagedMediaStorage(
      root: Directory('${directory.path}/managed'),
    );
    final repository = LocalMediaRepository(
      persistence: LocalMediaPersistence(database),
      storage: managedStorage,
      legacyStorage: storage,
    );
    addTearDown(repository.dispose);

    await api.initialize();
    await api.signIn('user-a@example.test', 'password');
    final scope = api.authenticatedSessionScope!;

    storage.delayNextDraftIndexRead = true;
    final first = repository.recoverLocalState(
      scope: scope,
      meetingId: 'meeting-recovery',
      storage: storage,
    );
    await storage.draftIndexReadStarted.future;
    final second = repository.recoverLocalState(
      scope: scope,
      meetingId: 'meeting-recovery',
      storage: storage,
    );
    expect(identical(first, second), isTrue);
    storage.releaseDraftIndexRead.complete();
    await Future.wait(<Future<LocalMediaRecoveryReport>>[first, second]);

    final sourcePath = '${directory.path}/recovered.wav';
    await storage.write(
      key: LocalMediaRepository.legacyStorageKeyForScope(scope),
      value: jsonEncode(<Map<String, dynamic>>[
        <String, dynamic>{
          'deploymentScope': scope.deploymentScope,
          'userId': scope.userId,
          'meetingId': 'meeting-recovery',
          'path': sourcePath,
          'name': 'recovered.wav',
          'createdAt': '2026-11-24T12:00:00Z',
        },
      ]),
    );
    // The missing legacy source leaves migration STARTED rather than
    // permanently completing recovery.
    await repository.recoverLocalState(
      scope: scope,
      meetingId: 'meeting-recovery',
      storage: storage,
      retry: true,
    );
    await File(sourcePath).writeAsBytes(<int>[1, 2, 3]);
    await repository.recoverLocalState(
      scope: scope,
      meetingId: 'meeting-recovery',
      storage: storage,
    );
    expect(
      (await repository.listAssets(
        scope: scope,
        meetingId: 'meeting-recovery',
      )).single.isReady,
      isTrue,
    );

    final reserved = await repository.reserveAsset(
      scope: scope,
      meetingId: 'meeting-recovery',
      sourceType: LocalMediaSourceType.recording,
      originalFilename: 'active.wav',
      contentType: 'audio/wav',
    );
    final staging = await repository.stagingFileFor(
      scope: scope,
      asset: reserved,
    );
    await staging.writeAsBytes(<int>[9, 8, 7]);
    await repository.recoverLocalState(
      scope: scope,
      meetingId: 'meeting-recovery',
      storage: storage,
      retry: true,
    );
    final active = await LocalMediaPersistence(database).findAsset(
      id: reserved.id,
      deploymentScope: scope.deploymentScope,
      ownerUserId: scope.userId,
    );
    expect(active!.lifecycle, LocalMediaLifecycle.creating);
    expect(await staging.exists(), isTrue);
    await repository.recordInterruption(scope: scope, assetId: reserved.id);
  });

  test(
    'routine managed listing checks size without hashing ready files',
    () async {
      final storage = InMemoryCredentialStorage();
      final api = _api(_DraftAuthClient(<String>[_userA]), storage: storage);
      addTearDown(api.dispose);
      final directory = await Directory.systemTemp.createTemp(
        'sme-recording-listing-integrity-',
      );
      addTearDown(() => directory.delete(recursive: true));
      final database = await LocalMediaDatabase.open(
        databasePath: '${directory.path}/media.db',
        databaseFactory: databaseFactoryFfi,
      );
      addTearDown(database.close);
      final managedStorage = _CountingManagedMediaStorage(
        root: Directory('${directory.path}/managed'),
      );
      final repository = LocalMediaRepository(
        persistence: LocalMediaPersistence(database),
        storage: managedStorage,
      );
      addTearDown(repository.dispose);

      await api.initialize();
      await api.signIn('user-a@example.test', 'password');
      final scope = api.authenticatedSessionScope!;
      final validSource = File('${directory.path}/valid.wav')
        ..writeAsBytesSync(<int>[1, 2, 3]);
      final missingSource = File('${directory.path}/missing.wav')
        ..writeAsBytesSync(<int>[4, 5, 6]);
      final valid = await repository.rememberSourceFile(
        scope: scope,
        meetingId: 'meeting-listing',
        source: validSource,
        sourceType: LocalMediaSourceType.recording,
        originalFilename: 'valid.wav',
        contentType: 'audio/wav',
      );
      final missing = await repository.rememberSourceFile(
        scope: scope,
        meetingId: 'meeting-listing',
        source: missingSource,
        sourceType: LocalMediaSourceType.recording,
        originalFilename: 'missing.wav',
        contentType: 'audio/wav',
      );
      await managedStorage.fileFor(missing.managedRelativePath).delete();
      managedStorage.inspectCount = 0;

      final listed = await RecordingDrafts(
        storage: storage,
        repository: repository,
      ).list('meeting-listing', api: api);
      expect(listed.single.assetId, valid.id);
      expect(managedStorage.inspectCount, 0);
      expect(
        (await repository.listAssets(
          scope: scope,
          meetingId: 'meeting-listing',
        )).singleWhere((asset) => asset.id == missing.id).lifecycle,
        LocalMediaLifecycle.missing,
      );
    },
  );
}

ApiClient _api(
  _DraftAuthClient client, {
  required CredentialStorage storage,
  Uri? baseUri,
}) => ApiClient(
  baseUri: baseUri ?? Uri.parse(_apiUri),
  httpClient: client,
  credentialStorage: storage,
);

class _DraftAuthClient extends http.BaseClient {
  _DraftAuthClient(this.userIds);

  final List<String> userIds;
  int loginCount = 0;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final path = request.url.path;
    if (path.endsWith('/auth/login')) {
      loginCount++;
      final generation = loginCount;
      return jsonResponse(
        200,
        successEnvelope(_tokens(generation, 'refresh-$generation')),
      );
    }
    if (path.endsWith('/auth/me')) {
      return jsonResponse(
        200,
        successEnvelope(_identity(userIds[loginCount - 1])),
      );
    }
    if (path.endsWith('/auth/logout')) {
      return jsonResponse(200, successEnvelope(null));
    }
    throw StateError('Unexpected request $path');
  }
}

class _DelayedDraftIndexStorage extends InMemoryCredentialStorage {
  final draftIndexReadStarted = Completer<void>();
  final releaseDraftIndexRead = Completer<void>();
  bool delayNextDraftIndexRead = false;

  @override
  Future<String?> read({required String key}) async {
    if (delayNextDraftIndexRead &&
        key.startsWith('sme.mobile.recordings.v2.')) {
      delayNextDraftIndexRead = false;
      draftIndexReadStarted.complete();
      await releaseDraftIndexRead.future;
    }
    return super.read(key: key);
  }
}

class _CountingManagedMediaStorage extends ManagedMediaStorage {
  _CountingManagedMediaStorage({required super.root});

  int inspectCount = 0;

  @override
  Future<LocalMediaFileIntegrity> inspectFile(String relativePath) {
    inspectCount++;
    return super.inspectFile(relativePath);
  }
}

Map<String, dynamic> _tokens(int generation, String refresh) =>
    <String, dynamic>{
      'accessToken': 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln$generation',
      'refreshToken': refresh,
      'tokenType': 'Bearer',
      'expiresIn': 600,
    };

Map<String, dynamic> _identity(String userId) => <String, dynamic>{
  'userId': userId,
  'email': userId == _userA ? 'user-a@example.test' : 'user-b@example.test',
  'displayName': userId == _userA ? 'User A' : 'User B',
  'globalRole': 'EMPLOYEE',
  'accountStatus': 'ACTIVE',
  'primaryOrgUnitId': null,
  'directoryManagementScope': <String, dynamic>{
    'allUnits': false,
    'unitIds': <String>[],
  },
  'session': <String, dynamic>{
    'id': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'clientType': 'MOBILE',
    'createdAt': '2026-11-22T10:00:00Z',
    'lastSeenAt': null,
    'absoluteExpiresAt': '2026-12-22T10:00:00Z',
  },
};
