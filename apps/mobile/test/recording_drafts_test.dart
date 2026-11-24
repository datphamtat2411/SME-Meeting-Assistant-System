import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/features/recording/recording_drafts.dart';

import 'support/http_test_support.dart';

const _apiUri = 'https://api.example.test/api/v1';
const _otherApiUri = 'https://other-api.example.test/api/v1';
const _userA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const _userB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

void main() {
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
