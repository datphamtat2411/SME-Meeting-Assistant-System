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

      await api.signIn('user@example.test', 'password');

      expect(observed, <AuthSessionPhase>[
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
}

class _AuthenticationClient extends RecordingHttpClient {
  _AuthenticationClient({this.identityChange, this.refreshStatus})
    : super((_) async => throw StateError('handler initialized below'));

  final Map<String, dynamic> Function()? identityChange;
  final int? refreshStatus;
  final List<String> paths = <String>[];

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    requests.add(request);
    paths.add(request.url.path);
    final path = request.url.path;
    expect(request.headers['X-Auth-Transport'], 'mobile');
    if (path.endsWith('/auth/login')) {
      expect(request.headers['Authorization'], isNull);
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
