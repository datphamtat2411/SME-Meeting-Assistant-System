import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/core/api_client.dart';

import 'support/http_test_support.dart';

const _baseUri = 'https://api.example.test/api/v1';

void main() {
  test('public authentication operations work without a session', () async {
    final storage = InMemoryCredentialStorage();
    final client = _PublicAuthenticationClient();
    final api = _api(client, storage: storage);
    addTearDown(api.dispose);
    await api.initialize();

    expect(api.sessionState.phase, AuthSessionPhase.unauthenticated);
    expect(
      (await TokenStore(
        storage: storage,
        baseUri: Uri.parse(_baseUri),
      ).read()).state,
      TokenStoreCredentialState.missing,
    );

    await api.requestPasswordRecovery(' user@example.test ');
    await api.resetPassword('recovery-token', 'new-password');
    await api.completeAccountSetup('invitation-token', 'setup-password');

    expect(client.publicRequests, hasLength(3));
    expect(client.publicRequests.map((request) => request.url.path), <String>[
      '/api/v1/auth/password-recovery',
      '/api/v1/auth/password-reset',
      '/api/v1/auth/account-setup',
    ]);
    expect(
      client.publicRequests.map((request) => request.method),
      everyElement('POST'),
    );
    expect(_requestBody(client.publicRequests[0]), <String, dynamic>{
      'email': 'user@example.test',
    });
    expect(_requestBody(client.publicRequests[1]), <String, dynamic>{
      'token': 'recovery-token',
      'password': 'new-password',
    });
    expect(_requestBody(client.publicRequests[2]), <String, dynamic>{
      'token': 'invitation-token',
      'password': 'setup-password',
    });
    _expectNoAuthenticationHeaders(client.publicRequests);
    expect(client.refreshCalls, 0);
    expect(api.sessionState.phase, AuthSessionPhase.unauthenticated);
    expect(
      (await TokenStore(
        storage: storage,
        baseUri: Uri.parse(_baseUri),
      ).read()).state,
      TokenStoreCredentialState.missing,
    );
  });

  test('public operations bypass credential acquisition even for an expiring session', () async {
    var now = DateTime.utc(2026, 11, 24, 12);
    final storage = InMemoryCredentialStorage();
    final client = _PublicAuthenticationClient();
    final api = _api(client, storage: storage, now: () => now);
    addTearDown(api.dispose);
    await api.initialize();
    await api.signIn('user@example.test', 'password');

    final authenticatedIdentity = api.sessionState.identity;
    final credentialBefore = await TokenStore(
      storage: storage,
      baseUri: Uri.parse(_baseUri),
    ).read();
    now = now.add(const Duration(seconds: 40));

    await api.requestPasswordRecovery('user@example.test');
    await api.resetPassword('recovery-token', 'new-password');
    await api.completeAccountSetup('invitation-token', 'setup-password');

    expect(client.publicRequests, hasLength(3));
    _expectNoAuthenticationHeaders(client.publicRequests);
    expect(client.refreshCalls, 0);
    expect(api.sessionState.phase, AuthSessionPhase.authenticated);
    expect(identical(api.sessionState.identity, authenticatedIdentity), isTrue);
    final credentialAfter = await TokenStore(
      storage: storage,
      baseUri: Uri.parse(_baseUri),
    ).read();
    expect(credentialAfter.state, credentialBefore.state);
    expect(credentialAfter.refreshToken, credentialBefore.refreshToken);
  });

  test('public authentication failures preserve structured errors and session state', () async {
    final scenarios = <({String path, int status, String code})>[
      (path: '/auth/password-recovery', status: 401, code: 'AUTH_REQUIRED'),
      (path: '/auth/password-reset', status: 403, code: 'AUTHZ_FORBIDDEN'),
      (path: '/auth/account-setup', status: 422, code: 'VALIDATION_FAILED'),
      (
        path: '/auth/password-recovery',
        status: 429,
        code: 'RATE_LIMIT_EXCEEDED',
      ),
    ];

    for (final scenario in scenarios) {
      final client = _PublicAuthenticationClient(
        failureStatusByPath: <String, int>{scenario.path: scenario.status},
      );
      final api = _api(client);
      addTearDown(api.dispose);
      await api.initialize();
      await api.signIn('user@example.test', 'password');
      final sessionIdentity = api.sessionState.identity;

      await expectLater(
        _invokePublicOperation(api, scenario.path),
        throwsA(
          isA<ApiFailure>()
              .having((failure) => failure.status, 'status', scenario.status)
              .having((failure) => failure.code, 'code', scenario.code)
              .having(
                (failure) => failure.requestId,
                'requestId',
                'test-request-id',
              )
              .having(
                (failure) =>
                    failure.errors.isEmpty ? null : failure.errors.single.field,
                'field error',
                scenario.status == 422 ? 'password' : isNull,
              )
              .having(
                (failure) => failure.retryAfter,
                'Retry-After',
                scenario.status == 429 ? '45' : isNull,
              ),
        ),
      );

      expect(client.pathCalls(scenario.path), 1);
      expect(client.refreshCalls, 0);
      _expectNoAuthenticationHeaders(client.publicRequests);
      expect(api.sessionState.phase, AuthSessionPhase.authenticated);
      expect(identical(api.sessionState.identity, sessionIdentity), isTrue);
    }
  });

  test(
    'public transport failures do not invalidate an active session',
    () async {
      final client = _PublicAuthenticationClient(failWithSocketException: true);
      final api = _api(client);
      addTearDown(api.dispose);
      await api.initialize();
      await api.signIn('user@example.test', 'password');
      final sessionIdentity = api.sessionState.identity;

      await expectLater(
        api.requestPasswordRecovery('user@example.test'),
        throwsA(
          isA<ApiFailure>()
              .having((failure) => failure.status, 'status', 0)
              .having((failure) => failure.code, 'code', 'NETWORK_UNAVAILABLE')
              .having(
                (failure) => failure.transportFailure,
                'transport',
                isTrue,
              ),
        ),
      );

      expect(client.pathCalls('/auth/password-recovery'), 1);
      expect(client.refreshCalls, 0);
      expect(api.sessionState.phase, AuthSessionPhase.authenticated);
      expect(identical(api.sessionState.identity, sessionIdentity), isTrue);
    },
  );

  test('generic feature requests cannot make public or protected auth routes anonymous', () async {
    final client = _PublicAuthenticationClient();
    final api = _api(client);
    addTearDown(api.dispose);
    await api.initialize();

    for (final operation in <Future<ApiResult> Function()>[
      () => api.post('/auth/password-recovery', const <String, dynamic>{}),
      () => api.post('/auth/password-reset', const <String, dynamic>{}),
      () => api.post('/auth/account-setup', const <String, dynamic>{}),
      () => api.get('/auth/me'),
      () => api.post('/auth/logout', const <String, dynamic>{}),
      () => api.get('/business/data'),
    ]) {
      await expectLater(
        operation(),
        throwsA(
          isA<ApiFailure>().having(
            (failure) => failure.code,
            'code',
            'AUTH_SESSION_REQUIRED',
          ),
        ),
      );
    }

    expect(client.requests, isEmpty);
    expect(client.refreshCalls, 0);
  });
}

ApiClient _api(
  _PublicAuthenticationClient client, {
  CredentialStorage? storage,
  DateTime Function()? now,
}) => ApiClient(
  baseUri: Uri.parse(_baseUri),
  httpClient: client,
  credentialStorage: storage ?? InMemoryCredentialStorage(),
  now: now,
);

Future<ApiResult> _invokePublicOperation(
  ApiClient api,
  String path,
) => switch (path) {
  '/auth/password-recovery' => api.requestPasswordRecovery('user@example.test'),
  '/auth/password-reset' => api.resetPassword('recovery-token', 'new-password'),
  '/auth/account-setup' => api.completeAccountSetup(
    'invitation-token',
    'setup-password',
  ),
  _ => throw StateError('Unexpected public path $path'),
};

Map<String, dynamic> _requestBody(http.BaseRequest request) =>
    jsonDecode((request as http.Request).body) as Map<String, dynamic>;

void _expectNoAuthenticationHeaders(Iterable<http.BaseRequest> requests) {
  for (final request in requests) {
    expect(request.headers['Authorization'], isNull);
    expect(request.headers['Cookie'], isNull);
    expect(request.headers['X-Auth-Transport'], isNull);
  }
}

class _PublicAuthenticationClient extends http.BaseClient {
  _PublicAuthenticationClient({
    this.failureStatusByPath = const <String, int>{},
    this.failWithSocketException = false,
  });

  final Map<String, int> failureStatusByPath;
  final bool failWithSocketException;
  final List<http.BaseRequest> requests = <http.BaseRequest>[];
  int refreshCalls = 0;

  List<http.BaseRequest> get publicRequests => requests
      .where(
        (request) => <String>[
          '/api/v1/auth/password-recovery',
          '/api/v1/auth/password-reset',
          '/api/v1/auth/account-setup',
        ].contains(request.url.path),
      )
      .toList(growable: false);

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    requests.add(request);
    final path = request.url.path;
    switch (path) {
      case '/api/v1/auth/login':
        expect(request.headers['Authorization'], isNull);
        return jsonResponse(200, successEnvelope(_tokens()));
      case '/api/v1/auth/me':
        expect(request.headers['Authorization'], 'Bearer ${_accessToken()}');
        return jsonResponse(200, successEnvelope(_identity()));
      case '/api/v1/auth/refresh':
        refreshCalls++;
        return jsonResponse(200, successEnvelope(_tokens()));
      case '/api/v1/auth/password-recovery':
      case '/api/v1/auth/password-reset':
      case '/api/v1/auth/account-setup':
        if (failWithSocketException) {
          return Future<http.StreamedResponse>.error(
            const SocketException('private network details'),
          );
        }
        final status = failureStatusByPath[path.replaceFirst('/api/v1', '')];
        if (status != null) {
          return _failureResponse(status);
        }
        return jsonResponse(
          200,
          successEnvelope(<String, dynamic>{'accepted': true}),
        );
    }
    throw StateError('Unexpected request path $path');
  }

  Future<http.StreamedResponse> _failureResponse(int status) async {
    final code = switch (status) {
      401 => 'AUTH_REQUIRED',
      403 => 'AUTHZ_FORBIDDEN',
      422 => 'VALIDATION_FAILED',
      429 => 'RATE_LIMIT_EXCEEDED',
      _ => throw StateError('Unexpected status $status'),
    };
    final errorEnvelopeWithDetails = <String, dynamic>{
      ...errorEnvelope(code, 'The public operation was rejected.'),
      if (status == 422)
        'errors': <Map<String, String>>[
          <String, String>{
            'field': 'password',
            'code': 'PASSWORD_POLICY',
            'message': 'The password does not meet policy.',
          },
        ],
    };
    return streamedResponse(
      status,
      body: utf8.encode(jsonEncode(errorEnvelopeWithDetails)),
      headers: <String, String>{
        'content-type': 'application/json',
        if (status == 429) 'retry-after': '45',
      },
    );
  }

  int pathCalls(String suffix) =>
      requests.where((request) => request.url.path.endsWith(suffix)).length;
}

String _accessToken() => 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln1';

Map<String, dynamic> _tokens() => <String, dynamic>{
  'accessToken': _accessToken(),
  'refreshToken': 'refresh-1',
  'tokenType': 'Bearer',
  'expiresIn': 60,
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
