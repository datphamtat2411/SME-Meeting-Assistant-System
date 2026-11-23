import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/core/api_client.dart';

import 'support/http_test_support.dart';

final Uri _baseUri = Uri.parse('https://api.example.test/api/v1');

Future<TokenStore> _storedToken(
  CredentialStorage storage, [
  String refreshToken = 'refresh_0',
]) async {
  final store = TokenStore(storage: storage, baseUri: _baseUri);
  await store.storeLoginCredential(refreshToken);
  return store;
}

void main() {
  test('login commits refresh credential before requesting identity', () async {
    final storage = _FaultStorage();
    final store = TokenStore(storage: storage, baseUri: _baseUri);
    final client = _LifecycleClient(
      onIdentity: () async {
        expect((await store.read()).state, TokenStoreCredentialState.committed);
        expect((await store.read()).refreshToken, 'refresh_0');
      },
    );
    final api = ApiClient(
      baseUri: _baseUri,
      httpClient: client,
      credentialStorage: storage,
    );
    addTearDown(api.dispose);
    await api.initialize();

    await api.signIn('user@example.test', 'password');

    expect(api.sessionState.isAuthenticated, isTrue);
    expect(client.paths, <String>['/api/v1/auth/login', '/api/v1/auth/me']);
  });

  test(
    'failed login persistence never publishes or verifies a session',
    () async {
      final storage = _FaultStorage()..failNextWriteBefore = true;
      final client = _LifecycleClient();
      final api = ApiClient(
        baseUri: _baseUri,
        httpClient: client,
        credentialStorage: storage,
      );
      addTearDown(api.dispose);
      await api.initialize();

      await expectLater(
        api.signIn('user@example.test', 'password'),
        throwsA(isA<AuthSessionException>()),
      );

      expect(api.sessionState.isAuthenticated, isFalse);
      expect(
        api.sessionState.failure?.category,
        AuthFailureCategory.credentialStorage,
      );
      expect(client.paths, <String>['/api/v1/auth/login']);
      expect(api.sessionState.canRetryCredentialStorage, isTrue);
    },
  );

  test('refresh is dispatched only after pending is durably stored', () async {
    final storage = _FaultStorage();
    final store = await _storedToken(storage);
    final client = _LifecycleClient(
      onRefresh: () async {
        final pending = await store.read();
        expect(pending.state, TokenStoreCredentialState.rotationPending);
        expect(pending.refreshToken, isNull);
      },
      onIdentity: () async {
        expect((await store.read()).refreshToken, 'refresh_1');
      },
    );
    final api = ApiClient(
      baseUri: _baseUri,
      httpClient: client,
      credentialStorage: storage,
    );
    addTearDown(api.dispose);

    await api.initialize();

    expect(api.sessionState.isAuthenticated, isTrue);
    expect(client.paths, <String>['/api/v1/auth/refresh', '/api/v1/auth/me']);
    expect((await store.read()).refreshToken, 'refresh_1');
  });

  test(
    'failed pending durability confirmation blocks refresh dispatch',
    () async {
      final storage = _FaultStorage();
      final store = await _storedToken(storage);
      storage.durabilityCalls = 0;
      storage.failOnDurabilityNumber = 1;
      final client = _LifecycleClient();
      final api = ApiClient(
        baseUri: _baseUri,
        httpClient: client,
        credentialStorage: storage,
      );
      addTearDown(api.dispose);

      await api.initialize();

      expect(client.paths, isEmpty);
      expect(
        api.sessionState.failure?.category,
        AuthFailureCategory.credentialStorage,
      );
      expect(api.sessionState.canRetryCredentialStorage, isTrue);
      expect(
        (await store.read()).state,
        TokenStoreCredentialState.rotationPending,
      );

      await api.retrySessionRestore();

      expect(api.sessionState.phase, AuthSessionPhase.reauthenticationRequired);
      expect(client.paths, isEmpty);
    },
  );

  test(
    'rotated credential is not used until its durability confirmation succeeds',
    () async {
      final storage = _FaultStorage();
      final store = await _storedToken(storage);
      storage.durabilityCalls = 0;
      storage.failOnDurabilityNumber = 2;
      final client = _LifecycleClient();
      final api = ApiClient(
        baseUri: _baseUri,
        httpClient: client,
        credentialStorage: storage,
      );
      addTearDown(api.dispose);

      await api.initialize();

      expect(client.paths, <String>['/api/v1/auth/refresh']);
      expect(
        api.sessionState.failure?.category,
        AuthFailureCategory.credentialStorage,
      );
      expect(api.sessionState.isAuthenticated, isFalse);
      expect((await store.read()).refreshToken, 'refresh_1');

      await api.retrySessionRestore();

      expect(api.sessionState.isAuthenticated, isTrue);
      expect(client.refreshCredentials, <String?>['refresh_0', 'refresh_1']);
      expect(client.paths, <String>[
        '/api/v1/auth/refresh',
        '/api/v1/auth/refresh',
        '/api/v1/auth/me',
      ]);
    },
  );

  test(
    'a second application instance restores using the committed rotation',
    () async {
      final storage = _FaultStorage();
      await _storedToken(storage);
      final firstClient = _LifecycleClient();
      final firstApi = ApiClient(
        baseUri: _baseUri,
        httpClient: firstClient,
        credentialStorage: storage,
      );
      await firstApi.initialize();
      expect(
        (await TokenStore(
          storage: storage,
          baseUri: _baseUri,
        ).read()).refreshToken,
        'refresh_1',
      );
      firstApi.dispose();

      final secondClient = _LifecycleClient();
      final secondApi = ApiClient(
        baseUri: _baseUri,
        httpClient: secondClient,
        credentialStorage: storage,
      );
      addTearDown(secondApi.dispose);

      await secondApi.initialize();

      expect(secondApi.sessionState.isAuthenticated, isTrue);
      expect(secondClient.refreshCredentials, <String?>['refresh_1']);
      expect(
        (await TokenStore(
          storage: storage,
          baseUri: _baseUri,
        ).read()).refreshToken,
        'refresh_2',
      );
    },
  );

  test(
    'restart with pending rotation requires sign-in without network access',
    () async {
      final storage = _FaultStorage();
      final store = await _storedToken(storage);
      await store.markRotationPending('refresh_0');
      final client = _LifecycleClient();
      final api = ApiClient(
        baseUri: _baseUri,
        httpClient: client,
        credentialStorage: storage,
      );
      addTearDown(api.dispose);

      await api.initialize();

      expect(api.sessionState.phase, AuthSessionPhase.reauthenticationRequired);
      expect(api.sessionState.failure?.machineCode, 'REFRESH_ROTATION_PENDING');
      expect(client.paths, isEmpty);
    },
  );

  test('uncertain refresh outcome stays pending and is never replayed after restart', () async {
    final storage = _FaultStorage();
    await _storedToken(storage);
    final firstClient = _LifecycleClient(throwOnRefresh: true);
    final firstApi = ApiClient(
      baseUri: _baseUri,
      httpClient: firstClient,
      credentialStorage: storage,
    );
    addTearDown(firstApi.dispose);

    await firstApi.initialize();

    expect(
      firstApi.sessionState.phase,
      AuthSessionPhase.reauthenticationRequired,
    );
    expect(
      firstApi.sessionState.failure?.category,
      AuthFailureCategory.rotationOutcomeUnknown,
    );
    expect(firstClient.refreshCredentials, <String?>['refresh_0']);
    expect(
      (await TokenStore(storage: storage, baseUri: _baseUri).read()).state,
      TokenStoreCredentialState.rotationPending,
    );

    final restartedClient = _LifecycleClient();
    final restartedApi = ApiClient(
      baseUri: _baseUri,
      httpClient: restartedClient,
      credentialStorage: storage,
    );
    addTearDown(restartedApi.dispose);

    await restartedApi.initialize();

    expect(restartedClient.paths, isEmpty);
    expect(
      restartedApi.sessionState.phase,
      AuthSessionPhase.reauthenticationRequired,
    );
  });

  test(
    'pre-rotation rate limit restores the old credential only after write',
    () async {
      final storage = _FaultStorage();
      final store = await _storedToken(storage);
      final client = _LifecycleClient(rateLimitRefreshes: 1);
      final api = ApiClient(
        baseUri: _baseUri,
        httpClient: client,
        credentialStorage: storage,
      );
      addTearDown(api.dispose);

      await api.initialize();

      expect(api.sessionState.phase, AuthSessionPhase.recoverableFailure);
      expect(api.sessionState.canRetrySessionRestore, isTrue);
      expect((await store.read()).refreshToken, 'refresh_0');
      expect(client.refreshCredentials, <String?>['refresh_0']);

      await api.retrySessionRestore();

      expect(api.sessionState.isAuthenticated, isTrue);
      expect(client.refreshCredentials, <String?>['refresh_0', 'refresh_0']);
      expect((await store.read()).refreshToken, 'refresh_1');
    },
  );

  test(
    'an unrecognized 429 does not restore or replay the old credential',
    () async {
      final storage = _FaultStorage();
      final store = await _storedToken(storage);
      final client = _LifecycleClient(
        rateLimitRefreshes: 1,
        rateLimitCode: 'AUTH_RATE_LIMITED',
      );
      final api = ApiClient(
        baseUri: _baseUri,
        httpClient: client,
        credentialStorage: storage,
      );
      addTearDown(api.dispose);

      await api.initialize();

      expect(api.sessionState.phase, AuthSessionPhase.reauthenticationRequired);
      expect(
        api.sessionState.failure?.category,
        AuthFailureCategory.rotationOutcomeUnknown,
      );
      expect(
        (await store.read()).state,
        TokenStoreCredentialState.rotationPending,
      );
      expect(client.refreshCredentials, <String?>['refresh_0']);
    },
  );

  test('403, unavailable backend, timeout, and malformed refresh outcomes stay pending', () async {
    final cases =
        <
          ({
            String name,
            AuthFailureCategory category,
            AuthFailureCategory? underlying,
            int? status,
            bool timeout,
            bool malformed,
          })
        >[
          (
            name: 'forbidden',
            category: AuthFailureCategory.authorizationDenied,
            underlying: null,
            status: 403,
            timeout: false,
            malformed: false,
          ),
          (
            name: 'service unavailable',
            category: AuthFailureCategory.rotationOutcomeUnknown,
            underlying: AuthFailureCategory.temporaryServiceFailure,
            status: 503,
            timeout: false,
            malformed: false,
          ),
          (
            name: 'timeout',
            category: AuthFailureCategory.rotationOutcomeUnknown,
            underlying: AuthFailureCategory.requestTimeout,
            status: null,
            timeout: true,
            malformed: false,
          ),
          (
            name: 'malformed response',
            category: AuthFailureCategory.rotationOutcomeUnknown,
            underlying: AuthFailureCategory.invalidResponse,
            status: null,
            timeout: false,
            malformed: true,
          ),
        ];

    for (final testCase in cases) {
      final storage = _FaultStorage();
      final store = await _storedToken(storage);
      final client = _LifecycleClient(
        refreshStatus: testCase.status,
        timeoutOnRefresh: testCase.timeout,
        malformedRefresh: testCase.malformed,
      );
      final api = ApiClient(
        baseUri: _baseUri,
        httpClient: client,
        credentialStorage: storage,
      );
      addTearDown(api.dispose);

      await api.initialize();

      final failure = api.sessionState.failure!;
      expect(
        api.sessionState.phase,
        AuthSessionPhase.reauthenticationRequired,
        reason: testCase.name,
      );
      expect(failure.category, testCase.category, reason: testCase.name);
      expect(
        failure.underlyingCategory,
        testCase.underlying,
        reason: testCase.name,
      );
      if (testCase.status != null) {
        expect(failure.status, testCase.status, reason: testCase.name);
      }
      expect(
        (await store.read()).state,
        TokenStoreCredentialState.rotationPending,
        reason: testCase.name,
      );
      expect(client.refreshCredentials, <String?>['refresh_0']);
    }
  });

  test('rotation commit failure leaves pending; retry reads rather than reuses old token', () async {
    final storage = _FaultStorage();
    final store = await _storedToken(storage);
    storage.writeCalls = 0;
    storage.failOnWriteNumber = 2;
    final client = _LifecycleClient();
    final api = ApiClient(
      baseUri: _baseUri,
      httpClient: client,
      credentialStorage: storage,
    );
    addTearDown(api.dispose);

    await api.initialize();

    expect(api.sessionState.isAuthenticated, isFalse);
    expect(
      api.sessionState.failure?.category,
      AuthFailureCategory.credentialStorage,
    );
    expect(
      (await store.read()).state,
      TokenStoreCredentialState.rotationPending,
    );

    await api.retrySessionRestore();

    expect(api.sessionState.phase, AuthSessionPhase.reauthenticationRequired);
    expect(client.refreshCredentials, <String?>['refresh_0']);
  });

  test('write failure after committed rotation is recoverable without old-token replay', () async {
    final storage = _FaultStorage();
    final store = await _storedToken(storage);
    storage.writeCalls = 0;
    storage.failOnWriteNumber = 2;
    storage.failAfterPersistence = true;
    final client = _LifecycleClient();
    final api = ApiClient(
      baseUri: _baseUri,
      httpClient: client,
      credentialStorage: storage,
    );
    addTearDown(api.dispose);

    await api.initialize();

    expect(api.sessionState.isAuthenticated, isFalse);
    expect(
      api.sessionState.failure?.category,
      AuthFailureCategory.credentialStorage,
    );
    expect((await store.read()).refreshToken, 'refresh_1');

    await api.retrySessionRestore();

    expect(api.sessionState.isAuthenticated, isTrue);
    expect(client.refreshCredentials, <String?>['refresh_0', 'refresh_1']);
  });

  test(
    'read and delete storage failures expose safe explicit retries',
    () async {
      final readStorage = _FaultStorage()..failNextRead = true;
      final readClient = _LifecycleClient();
      final readApi = ApiClient(
        baseUri: _baseUri,
        httpClient: readClient,
        credentialStorage: readStorage,
      );
      addTearDown(readApi.dispose);
      await readApi.initialize();

      expect(
        readApi.sessionState.failure?.category,
        AuthFailureCategory.credentialStorage,
      );
      expect(readApi.sessionState.canRetryCredentialStorage, isTrue);
      expect(readClient.paths, isEmpty);

      await readApi.retrySessionRestore();

      expect(readApi.sessionState.phase, AuthSessionPhase.unauthenticated);

      final deleteStorage = _FaultStorage();
      final deleteClient = _LifecycleClient();
      final deleteApi = ApiClient(
        baseUri: _baseUri,
        httpClient: deleteClient,
        credentialStorage: deleteStorage,
      );
      addTearDown(deleteApi.dispose);
      await deleteApi.initialize();
      await deleteApi.signIn('user@example.test', 'password');
      deleteStorage.failNextDelete = true;

      await expectLater(
        deleteApi.signOut(),
        throwsA(
          isA<AuthSessionException>().having(
            (error) => error.failure.category,
            'category',
            AuthFailureCategory.credentialStorage,
          ),
        ),
      );
      expect(deleteApi.sessionState.isAuthenticated, isFalse);
      expect(deleteApi.sessionState.phase, AuthSessionPhase.recoverableFailure);
      expect(deleteClient.paths.last, '/api/v1/auth/logout');

      await deleteApi.retrySessionRestore();

      expect(deleteApi.sessionState.phase, AuthSessionPhase.unauthenticated);
      expect(
        (await TokenStore(
          storage: deleteStorage,
          baseUri: _baseUri,
        ).read()).state,
        TokenStoreCredentialState.missing,
      );
    },
  );

  test('legacy credentials are retired, never submitted to the configured deployment', () async {
    final storage = InMemoryCredentialStorage();
    await storage.write(
      key: TokenStore.legacyStorageKey,
      value: 'refresh_legacy',
    );
    final client = _LifecycleClient();
    final api = ApiClient(
      baseUri: _baseUri,
      httpClient: client,
      credentialStorage: storage,
    );
    addTearDown(api.dispose);

    await api.initialize();

    expect(api.sessionState.phase, AuthSessionPhase.reauthenticationRequired);
    expect(api.sessionState.failure?.machineCode, 'LEGACY_CREDENTIAL_RETIRED');
    expect(client.paths, isEmpty);
    expect(await storage.read(key: TokenStore.legacyStorageKey), isNull);
  });
}

class _LifecycleClient extends RecordingHttpClient {
  _LifecycleClient({
    this.onRefresh,
    this.onIdentity,
    this.throwOnRefresh = false,
    this.timeoutOnRefresh = false,
    this.malformedRefresh = false,
    this.refreshStatus,
    this.rateLimitRefreshes = 0,
    this.rateLimitCode = 'RATE_LIMIT_EXCEEDED',
  }) : super((_) async => throw StateError('handler initialized below'));

  final Future<void> Function()? onRefresh;
  final Future<void> Function()? onIdentity;
  final bool throwOnRefresh;
  final bool timeoutOnRefresh;
  final bool malformedRefresh;
  final int? refreshStatus;
  int rateLimitRefreshes;
  final String rateLimitCode;
  final List<String> paths = <String>[];
  final List<String?> refreshCredentials = <String?>[];

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    requests.add(request);
    final path = request.url.path;
    paths.add(path);
    if (path.endsWith('/auth/login')) {
      return jsonResponse(200, successEnvelope(_tokens(1, 'refresh_0')));
    }
    if (path.endsWith('/auth/refresh')) {
      final authorization = request.headers['Authorization'];
      refreshCredentials.add(
        authorization?.startsWith('Bearer ') == true
            ? authorization!.substring(7)
            : null,
      );
      await onRefresh?.call();
      if (throwOnRefresh) {
        throw const SocketException('private transport detail');
      }
      if (timeoutOnRefresh) {
        throw TimeoutException('private timeout detail');
      }
      if (refreshStatus != null) {
        return jsonResponse(
          refreshStatus!,
          errorEnvelope(
            refreshStatus == 403 ? 'AUTHZ_FORBIDDEN' : 'SERVICE_UNAVAILABLE',
            'Try again later.',
          ),
        );
      }
      if (malformedRefresh) {
        return jsonResponse(
          200,
          successEnvelope(<String, dynamic>{'accessToken': 'malformed'}),
        );
      }
      if (rateLimitRefreshes > 0) {
        rateLimitRefreshes--;
        return jsonResponse(
          429,
          errorEnvelope(rateLimitCode, 'Try again later.'),
        );
      }
      final presented = refreshCredentials.last;
      final nextGeneration = presented == 'refresh_0' ? 2 : 3;
      final nextRefresh = presented == 'refresh_0' ? 'refresh_1' : 'refresh_2';
      return jsonResponse(
        200,
        successEnvelope(_tokens(nextGeneration, nextRefresh)),
      );
    }
    if (path.endsWith('/auth/me')) {
      await onIdentity?.call();
      return jsonResponse(200, successEnvelope(_identity()));
    }
    if (path.endsWith('/auth/logout')) {
      return jsonResponse(200, successEnvelope(null));
    }
    throw StateError('Unexpected authentication request $path');
  }
}

class _FaultStorage extends InMemoryCredentialStorage {
  bool failNextRead = false;
  bool failNextWriteBefore = false;
  bool failNextDelete = false;
  int writeCalls = 0;
  int durabilityCalls = 0;
  int? failOnWriteNumber;
  int? failOnDurabilityNumber;
  bool failAfterPersistence = false;

  @override
  Future<String?> read({required String key}) {
    if (failNextRead) {
      failNextRead = false;
      return Future<String?>.error(StateError('private storage detail'));
    }
    return super.read(key: key);
  }

  @override
  Future<void> write({required String key, required String value}) async {
    writeCalls++;
    final failNow = failOnWriteNumber == writeCalls;
    if (failNextWriteBefore || failNow && !failAfterPersistence) {
      failNextWriteBefore = false;
      failOnWriteNumber = null;
      throw StateError('private storage detail');
    }
    await super.write(key: key, value: value);
    if (failNow && failAfterPersistence) {
      failOnWriteNumber = null;
      throw StateError('private storage detail');
    }
  }

  @override
  Future<void> delete({required String key}) async {
    if (failNextDelete) {
      failNextDelete = false;
      throw StateError('private storage detail');
    }
    await super.delete(key: key);
  }

  @override
  Future<void> confirmDurable() async {
    durabilityCalls++;
    if (failOnDurabilityNumber == durabilityCalls) {
      failOnDurabilityNumber = null;
      throw StateError('private durability failure');
    }
    await super.confirmDurable();
  }
}

String _access(int generation) =>
    'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln$generation';

Map<String, dynamic> _tokens(int generation, String refresh) =>
    <String, dynamic>{
      'accessToken': _access(generation),
      'refreshToken': refresh,
      'tokenType': 'Bearer',
      'expiresIn': 600,
    };

Map<String, dynamic> _identity() => <String, dynamic>{
  'userId': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'email': 'user@example.test',
  'displayName': 'Test User',
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
