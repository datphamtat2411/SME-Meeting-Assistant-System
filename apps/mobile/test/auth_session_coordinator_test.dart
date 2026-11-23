import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/core/api_client.dart';

import 'support/http_test_support.dart';

void main() {
  test(
    'sign-in transitions through verification before authenticated state',
    () async {
      final client = _AuthenticationClient();
      final api = ApiClient(
        baseUri: Uri.parse('https://api.example.test/api/v1'),
        httpClient: client,
        credentialStorage: InMemoryCredentialStorage(),
      );
      addTearDown(api.dispose);
      final observed = <AuthSessionPhase>[];
      var facadeNotifications = 0;
      api.sessionCoordinator.addListener(
        () => observed.add(api.sessionCoordinator.state.phase),
      );
      api.addListener(() => facadeNotifications++);

      await api.initialize();
      await expectLater(api.loadIdentity(), throwsStateError);
      await api.signIn('user@example.test', 'password');

      expect(observed, <AuthSessionPhase>[
        AuthSessionPhase.unauthenticated,
        AuthSessionPhase.signingIn,
        AuthSessionPhase.verifyingIdentity,
        AuthSessionPhase.authenticated,
      ]);
      expect(api.sessionCoordinator.state.isAuthenticated, isTrue);
      expect(
        api.sessionCoordinator.state.identity!.session.clientType,
        AuthClientType.mobile,
      );
      expect(api.identity, isA<Map<String, dynamic>>());
      expect(
        () => api.identity!['displayName'] = 'Changed',
        throwsUnsupportedError,
      );
      expect(api.identity!.containsKey('accessToken'), isFalse);
      expect(api.signedIn, isTrue);
      expect(api.displayName, 'Test User');
      expect(facadeNotifications, observed.length);
    },
  );

  test('a non-active or non-mobile identity cannot authenticate', () async {
    for (final identityChange in <Map<String, dynamic> Function()>[
      () => <String, dynamic>{'accountStatus': 'PENDING_SETUP'},
      () => <String, dynamic>{
        'session': <String, dynamic>{
          ..._identity()['session'] as Map<String, dynamic>,
          'clientType': 'WEB',
        },
      },
    ]) {
      final api = ApiClient(
        baseUri: Uri.parse('https://api.example.test/api/v1'),
        httpClient: _AuthenticationClient(identityChange: identityChange),
        credentialStorage: InMemoryCredentialStorage(),
      );
      addTearDown(api.dispose);

      await api.initialize();
      await expectLater(
        api.signIn('user@example.test', 'password'),
        throwsA(
          isA<ApiFailure>().having(
            (failure) => failure.invalidResponse,
            'invalid response',
            isTrue,
          ),
        ),
      );
      expect(api.sessionCoordinator.state.isAuthenticated, isFalse);
      expect(api.sessionCoordinator.state.identity, isNull);
    }
  });

  test(
    'startup restoration uses repository and reaches a verified session',
    () async {
      final credentials = InMemoryCredentialStorage();
      await credentials.write(key: 'sme.mobile.refresh', value: 'refresh-0');
      final client = _AuthenticationClient();
      final api = ApiClient(
        baseUri: Uri.parse('https://api.example.test/api/v1'),
        httpClient: client,
        credentialStorage: credentials,
      );
      addTearDown(api.dispose);
      final observed = <AuthSessionPhase>[];
      api.sessionCoordinator.addListener(
        () => observed.add(api.sessionCoordinator.state.phase),
      );

      await api.initialize();

      expect(observed, <AuthSessionPhase>[
        AuthSessionPhase.verifyingIdentity,
        AuthSessionPhase.authenticated,
      ]);
      expect(client.paths, <String>['/api/v1/auth/refresh', '/api/v1/auth/me']);
      expect(api.sessionCoordinator.state.isAuthenticated, isTrue);
      expect(await credentials.read(key: 'sme.mobile.refresh'), 'refresh-1');
    },
  );

  test(
    'recoverable refresh failures retain credentials and structured errors',
    () async {
      final credentials = InMemoryCredentialStorage();
      await credentials.write(key: 'sme.mobile.refresh', value: 'refresh-0');
      final api = ApiClient(
        baseUri: Uri.parse('https://api.example.test/api/v1'),
        httpClient: _AuthenticationClient(refreshStatus: 429),
        credentialStorage: credentials,
      );
      addTearDown(api.dispose);

      await api.initialize();

      expect(
        api.sessionCoordinator.state.phase,
        AuthSessionPhase.recoverableFailure,
      );
      expect(
        api.sessionCoordinator.state.failure?.category,
        AuthFailureCategory.rateLimited,
      );
      expect(
        api.sessionCoordinator.state.failure?.requestId,
        'test-request-id',
      );
      expect(
        api.sessionCoordinator.state.failure?.responseRequestId,
        'failure-request-id',
      );
      expect(api.hasRecoverableSession, isTrue);
      expect(await credentials.read(key: 'sme.mobile.refresh'), 'refresh-0');
      expect(api.signedIn, isFalse);
    },
  );

  test(
    'logout uses the auth repository and clears the local session',
    () async {
      final credentials = InMemoryCredentialStorage();
      final client = _AuthenticationClient();
      final api = ApiClient(
        baseUri: Uri.parse('https://api.example.test/api/v1'),
        httpClient: client,
        credentialStorage: credentials,
      );
      addTearDown(api.dispose);
      await api.initialize();
      await api.signIn('user@example.test', 'password');

      await api.signOut();

      expect(client.paths, <String>[
        '/api/v1/auth/login',
        '/api/v1/auth/me',
        '/api/v1/auth/logout',
      ]);
      expect(
        api.sessionCoordinator.state.phase,
        AuthSessionPhase.unauthenticated,
      );
      expect(api.sessionCoordinator.state.identity, isNull);
      expect(api.identity, isNull);
      expect(await credentials.read(key: 'sme.mobile.refresh'), isNull);
    },
  );

  test(
    'credential storage failures remain distinct from API failures',
    () async {
      final api = ApiClient(
        baseUri: Uri.parse('https://api.example.test/api/v1'),
        httpClient: _AuthenticationClient(),
        credentialStorage: _FailingWriteStorage(),
      );
      addTearDown(api.dispose);

      await api.initialize();
      await expectLater(
        api.signIn('user@example.test', 'password'),
        throwsA(
          isA<AuthSessionException>().having(
            (error) => error.failure.category,
            'category',
            AuthFailureCategory.credentialStorage,
          ),
        ),
      );
      expect(api.sessionCoordinator.state.isAuthenticated, isFalse);
      expect(
        api.sessionCoordinator.state.failure?.category,
        AuthFailureCategory.credentialStorage,
      );
    },
  );

  test(
    'secure-storage read failure blocks sign-in before any request',
    () async {
      final client = _AuthenticationClient();
      final api = ApiClient(
        baseUri: Uri.parse('https://api.example.test/api/v1'),
        httpClient: client,
        credentialStorage: _FailingReadStorage(),
      );
      addTearDown(api.dispose);
      await api.initialize();

      await expectLater(
        api.signIn('user@example.test', 'password'),
        throwsStateError,
      );

      expect(
        api.sessionCoordinator.state.failure?.category,
        AuthFailureCategory.credentialStorage,
      );
      expect(client.requests, isEmpty);
    },
  );

  test(
    'expired access token is renewed before current identity is reloaded',
    () async {
      var now = DateTime.utc(2026, 11, 23, 12);
      final credentials = InMemoryCredentialStorage();
      final client = _IdentityRenewalClient();
      final api = ApiClient(
        baseUri: Uri.parse('https://api.example.test/api/v1'),
        httpClient: client,
        credentialStorage: credentials,
        now: () => now,
      );
      addTearDown(api.dispose);
      await api.initialize();
      await api.signIn('user@example.test', 'password');

      now = now.add(const Duration(minutes: 11));
      await api.loadIdentity();

      expect(client.paths, <String>[
        '/api/v1/auth/login',
        '/api/v1/auth/me',
        '/api/v1/auth/refresh',
        '/api/v1/auth/me',
      ]);
      expect(api.signedIn, isTrue);
      expect(await credentials.read(key: 'sme.mobile.refresh'), 'refresh-2');
    },
  );

  test(
    'identity 401 refreshes once and retries only the identity GET',
    () async {
      final client = _IdentityReloadClient();
      final credentials = InMemoryCredentialStorage();
      final api = ApiClient(
        baseUri: Uri.parse('https://api.example.test/api/v1'),
        httpClient: client,
        credentialStorage: credentials,
      );
      addTearDown(api.dispose);
      await api.initialize();
      await api.signIn('user@example.test', 'password');

      await api.loadIdentity();

      expect(
        client.paths.where((path) => path.endsWith('/auth/me')),
        hasLength(3),
      );
      expect(
        client.paths.where((path) => path.endsWith('/auth/refresh')),
        hasLength(1),
      );
      expect(api.sessionCoordinator.state.isAuthenticated, isTrue);
      expect(await credentials.read(key: 'sme.mobile.refresh'), 'refresh-2');
    },
  );

  test(
    'identity still rejected after one retry requires reauthentication',
    () async {
      final client = _IdentityReloadClient(rejectRetry: true);
      final credentials = InMemoryCredentialStorage();
      final api = ApiClient(
        baseUri: Uri.parse('https://api.example.test/api/v1'),
        httpClient: client,
        credentialStorage: credentials,
      );
      addTearDown(api.dispose);
      await api.initialize();
      await api.signIn('user@example.test', 'password');

      await expectLater(
        api.loadIdentity(),
        throwsA(
          isA<ApiFailure>().having((failure) => failure.status, 'status', 401),
        ),
      );

      expect(
        client.paths.where((path) => path.endsWith('/auth/me')),
        hasLength(3),
      );
      expect(
        client.paths.where((path) => path.endsWith('/auth/refresh')),
        hasLength(1),
      );
      expect(
        api.sessionCoordinator.state.phase,
        AuthSessionPhase.reauthenticationRequired,
      );
      expect(api.sessionCoordinator.state.identity, isNull);
      expect(await credentials.read(key: 'sme.mobile.refresh'), isNull);
    },
  );

  test(
    'sign-in identity verification refreshes and retries one rejected GET',
    () async {
      final client = _InitialIdentityUnauthorizedClient();
      final credentials = InMemoryCredentialStorage();
      final api = ApiClient(
        baseUri: Uri.parse('https://api.example.test/api/v1'),
        httpClient: client,
        credentialStorage: credentials,
      );
      addTearDown(api.dispose);
      await api.initialize();

      await api.signIn('user@example.test', 'password');

      expect(client.paths, <String>[
        '/api/v1/auth/login',
        '/api/v1/auth/me',
        '/api/v1/auth/refresh',
        '/api/v1/auth/me',
      ]);
      expect(api.sessionCoordinator.state.isAuthenticated, isTrue);
      expect(await credentials.read(key: 'sme.mobile.refresh'), 'refresh-2');
    },
  );

  test('login rejection leaves no retained credentials and permits another sign-in', () async {
    final credentials = InMemoryCredentialStorage();
    final client = _AuthenticationClient(loginFailures: 1);
    final api = ApiClient(
      baseUri: Uri.parse('https://api.example.test/api/v1'),
      httpClient: client,
      credentialStorage: credentials,
    );
    addTearDown(api.dispose);
    await api.initialize();

    await expectLater(
      api.signIn('user@example.test', 'wrong-password'),
      throwsA(
        isA<ApiFailure>().having((failure) => failure.status, 'status', 401),
      ),
    );
    expect(
      api.sessionCoordinator.state.phase,
      AuthSessionPhase.unauthenticated,
    );
    expect(await credentials.read(key: 'sme.mobile.refresh'), isNull);

    await api.signIn('user@example.test', 'correct-password');

    expect(
      client.paths.where((path) => path.endsWith('/auth/login')),
      hasLength(2),
    );
    expect(api.signedIn, isTrue);
  });

  test(
    'sign-in is rejected while identity verification is in progress',
    () async {
      final identityStarted = Completer<void>();
      final identityResponse = Completer<http.StreamedResponse>();
      final client = RecordingHttpClient((request) async {
        if (request.url.path.endsWith('/auth/login')) {
          return jsonResponse(200, successEnvelope(_tokens()));
        }
        if (request.url.path.endsWith('/auth/me')) {
          identityStarted.complete();
          return identityResponse.future;
        }
        throw StateError('Unexpected auth request ${request.url.path}');
      });
      final api = ApiClient(
        baseUri: Uri.parse('https://api.example.test/api/v1'),
        httpClient: client,
        credentialStorage: InMemoryCredentialStorage(),
      );
      addTearDown(api.dispose);
      await api.initialize();

      final signingIn = api.signIn('user@example.test', 'password');
      await identityStarted.future;
      expect(
        api.sessionCoordinator.state.phase,
        AuthSessionPhase.verifyingIdentity,
      );
      await expectLater(
        api.signIn('other@example.test', 'password'),
        throwsStateError,
      );
      expect(
        client.requests.where(
          (request) => request.url.path.endsWith('/auth/login'),
        ),
        hasLength(1),
      );

      identityResponse.complete(
        jsonResponse(200, successEnvelope(_identity())),
      );
      await signingIn;
      expect(api.signedIn, isTrue);
    },
  );

  test('an active or recoverable session cannot be replaced without explicit discard', () async {
    final credentials = InMemoryCredentialStorage();
    final client = _AuthenticationClient();
    final api = ApiClient(
      baseUri: Uri.parse('https://api.example.test/api/v1'),
      httpClient: client,
      credentialStorage: credentials,
    );
    addTearDown(api.dispose);
    await api.initialize();
    await api.signIn('user@example.test', 'password');
    final originalIdentity = api.sessionCoordinator.state.identity;

    await expectLater(
      api.signIn('other@example.test', 'password'),
      throwsStateError,
    );
    await expectLater(api.retrySessionRestore(), throwsStateError);
    expect(api.sessionCoordinator.state.identity, same(originalIdentity));
    expect(await credentials.read(key: 'sme.mobile.refresh'), 'refresh-0');
    expect(
      client.paths.where((path) => path.endsWith('/auth/login')),
      hasLength(1),
    );

    final recoveringCredentials = InMemoryCredentialStorage();
    await recoveringCredentials.write(
      key: 'sme.mobile.refresh',
      value: 'refresh-0',
    );
    final recoveringClient = _AuthenticationClient(refreshStatus: 429);
    final recoveringApi = ApiClient(
      baseUri: Uri.parse('https://api.example.test/api/v1'),
      httpClient: recoveringClient,
      credentialStorage: recoveringCredentials,
    );
    addTearDown(recoveringApi.dispose);
    await recoveringApi.initialize();
    await expectLater(
      recoveringApi.signIn('other@example.test', 'password'),
      throwsStateError,
    );
    expect(
      recoveringApi.sessionCoordinator.state.canRetrySessionRestore,
      isTrue,
    );
    expect(
      await recoveringCredentials.read(key: 'sme.mobile.refresh'),
      'refresh-0',
    );
    await recoveringApi.discardLocalSession();
    await recoveringApi.signIn('other@example.test', 'password');
    expect(recoveringApi.signedIn, isTrue);
  });
}

class _AuthenticationClient extends RecordingHttpClient {
  _AuthenticationClient({
    this.identityChange,
    this.refreshStatus,
    this.loginFailures = 0,
  }) : super((_) async => throw StateError('handler initialized below'));

  final Map<String, dynamic> Function()? identityChange;
  final int? refreshStatus;
  int loginFailures;
  final List<String> paths = <String>[];

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    requests.add(request);
    paths.add(request.url.path);
    final path = request.url.path;
    expect(request.headers['X-Auth-Transport'], 'mobile');
    if (path.endsWith('/auth/login')) {
      expect(request.headers['Authorization'], isNull);
      if (loginFailures > 0) {
        loginFailures--;
        return jsonResponse(
          401,
          errorEnvelope('AUTH_REQUIRED', 'Sign-in rejected.'),
        );
      }
      return jsonResponse(200, successEnvelope(_tokens()));
    }
    if (path.endsWith('/auth/refresh')) {
      if (refreshStatus != null) {
        return streamedResponse(
          refreshStatus!,
          body: utf8.encode(
            jsonEncode(errorEnvelope('AUTH_RATE_LIMITED', 'Try again later.')),
          ),
          headers: const <String, String>{
            'x-request-id': 'failure-request-id',
            'retry-after': '30',
          },
        );
      }
      expect(request.headers['Authorization'], 'Bearer refresh-0');
      return jsonResponse(
        200,
        successEnvelope(_tokens(_accessToken(), 'refresh-1')),
      );
    }
    if (path.endsWith('/auth/me')) {
      expect(request.headers['Authorization'], 'Bearer ${_accessToken()}');
      final identity = _identity();
      final changes = identityChange?.call() ?? const <String, dynamic>{};
      identity.addAll(changes);
      if (changes['session'] is Map<String, dynamic>) {
        identity['session'] = <String, dynamic>{
          ..._identity()['session'] as Map<String, dynamic>,
          ...changes['session'] as Map<String, dynamic>,
        };
      }
      return jsonResponse(200, successEnvelope(identity));
    }
    if (path.endsWith('/auth/logout')) {
      expect(request.headers['Authorization'], 'Bearer ${_accessToken()}');
      return jsonResponse(200, successEnvelope(null));
    }
    throw StateError('Unexpected auth request $path');
  }
}

Map<String, dynamic> _tokens([
  String access = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln',
  String refresh = 'refresh-0',
]) => <String, dynamic>{
  'accessToken': access,
  'refreshToken': refresh,
  'tokenType': 'Bearer',
  'expiresIn': 600,
};

String _accessToken() => 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln';

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

class _FailingWriteStorage extends InMemoryCredentialStorage {
  @override
  Future<void> write({required String key, required String value}) =>
      Future<void>.error(StateError('private platform details'));
}

class _FailingReadStorage implements CredentialStorage {
  @override
  Future<String?> read({required String key}) =>
      Future<String?>.error(StateError('private platform details'));

  @override
  Future<void> write({required String key, required String value}) async {}

  @override
  Future<void> delete({required String key}) async {}
}

class _InitialIdentityUnauthorizedClient extends RecordingHttpClient {
  _InitialIdentityUnauthorizedClient()
    : super((_) async => throw StateError('handler initialized below'));

  final List<String> paths = <String>[];

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    requests.add(request);
    final path = request.url.path;
    paths.add(path);
    if (path.endsWith('/auth/login')) {
      return jsonResponse(
        200,
        successEnvelope(_tokensForGeneration(1, 'refresh-1')),
      );
    }
    if (path.endsWith('/auth/me') &&
        paths.where((item) => item.endsWith('/auth/me')).length == 1) {
      expect(
        request.headers['Authorization'],
        'Bearer ${_accessTokenForGeneration(1)}',
      );
      return jsonResponse(
        401,
        errorEnvelope('AUTH_REQUIRED', 'Access token rejected.'),
      );
    }
    if (path.endsWith('/auth/refresh')) {
      expect(request.headers['Authorization'], 'Bearer refresh-1');
      return jsonResponse(
        200,
        successEnvelope(_tokensForGeneration(2, 'refresh-2')),
      );
    }
    if (path.endsWith('/auth/me')) {
      expect(
        request.headers['Authorization'],
        'Bearer ${_accessTokenForGeneration(2)}',
      );
      return jsonResponse(200, successEnvelope(_identity()));
    }
    throw StateError('Unexpected request $path');
  }
}

class _IdentityRenewalClient extends RecordingHttpClient {
  _IdentityRenewalClient()
    : super((_) async => throw StateError('handler initialized below'));

  final List<String> paths = <String>[];
  int identityRequests = 0;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    requests.add(request);
    final path = request.url.path;
    paths.add(path);
    if (path.endsWith('/auth/login')) {
      return jsonResponse(
        200,
        successEnvelope(_tokensForGeneration(1, 'refresh-1')),
      );
    }
    if (path.endsWith('/auth/refresh')) {
      expect(request.headers['Authorization'], 'Bearer refresh-1');
      return jsonResponse(
        200,
        successEnvelope(_tokensForGeneration(2, 'refresh-2')),
      );
    }
    if (path.endsWith('/auth/me')) {
      identityRequests++;
      expect(
        request.headers['Authorization'],
        'Bearer ${_accessTokenForGeneration(identityRequests <= 1 ? 1 : 2)}',
      );
      return jsonResponse(200, successEnvelope(_identity()));
    }
    throw StateError('Unexpected request $path');
  }
}

class _IdentityReloadClient extends RecordingHttpClient {
  _IdentityReloadClient({this.rejectRetry = false})
    : super((_) async => throw StateError('handler initialized below'));

  final bool rejectRetry;
  final List<String> paths = <String>[];
  int identityRequests = 0;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    requests.add(request);
    final path = request.url.path;
    paths.add(path);
    if (path.endsWith('/auth/login')) {
      return jsonResponse(
        200,
        successEnvelope(_tokensForGeneration(1, 'refresh-1')),
      );
    }
    if (path.endsWith('/auth/refresh')) {
      expect(request.headers['Authorization'], 'Bearer refresh-1');
      return jsonResponse(
        200,
        successEnvelope(_tokensForGeneration(2, 'refresh-2')),
      );
    }
    if (path.endsWith('/auth/me')) {
      identityRequests++;
      final generation = identityRequests <= 2 ? 1 : 2;
      expect(
        request.headers['Authorization'],
        'Bearer ${_accessTokenForGeneration(generation)}',
      );
      if (identityRequests == 2 || rejectRetry && identityRequests >= 3) {
        return jsonResponse(
          401,
          errorEnvelope('AUTH_REQUIRED', 'Access token rejected.'),
        );
      }
      return jsonResponse(200, successEnvelope(_identity()));
    }
    throw StateError('Unexpected request $path');
  }
}

String _accessTokenForGeneration(int generation) =>
    'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln$generation';

Map<String, dynamic> _tokensForGeneration(int generation, String refresh) =>
    <String, dynamic>{
      'accessToken': _accessTokenForGeneration(generation),
      'refreshToken': refresh,
      'tokenType': 'Bearer',
      'expiresIn': 600,
    };
