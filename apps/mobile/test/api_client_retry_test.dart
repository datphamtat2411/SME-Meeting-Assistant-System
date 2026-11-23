import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/core/api_client.dart';

import 'support/http_test_support.dart';

void main() {
  test(
    'preserves transport failure classification without an HTTP response',
    () async {
      final api = ApiClient(
        baseUri: Uri.parse('https://api.example.test/api/v1'),
        httpClient: UnavailableHttpClient(),
        credentialStorage: InMemoryCredentialStorage(),
      );

      await expectLater(
        api.get('/unavailable'),
        throwsA(
          isA<ApiFailure>()
              .having((failure) => failure.status, 'status', 0)
              .having((failure) => failure.code, 'code', 'NETWORK_UNAVAILABLE')
              .having(
                (failure) => failure.transportFailure,
                'transport',
                isTrue,
              )
              .having((failure) => failure.invalidResponse, 'invalid', isFalse),
        ),
      );
    },
  );

  test('refreshes once and replays a GET after a 401', () async {
    final client = AuthScenarioClient();
    final api = ApiClient(
      baseUri: Uri.parse('https://api.example.test/api/v1'),
      httpClient: client,
      credentialStorage: InMemoryCredentialStorage(),
    );

    await api.initialize();
    await api.signIn('user@example.test', 'password');
    final result = await api.get('/protected');

    expect(result.data, <String, dynamic>{'value': 'fresh'});
    expect(client.pathCalls('/protected'), 2);
    expect(client.pathCalls('/auth/refresh'), 1);
    expect(client.authorizationFor('/protected'), <String>[
      'Bearer ${_accessToken(1)}',
      'Bearer ${_accessToken(2)}',
    ]);
    expect(api.signedIn, isTrue);
  });

  test(
    'does not refresh or discard credentials for a malformed 401 response',
    () async {
      final client = AuthScenarioClient();
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
        api.get('/malformed'),
        throwsA(
          isA<ApiFailure>().having(
            (failure) => failure.invalidResponse,
            'invalid response',
            isTrue,
          ),
        ),
      );

      expect(client.pathCalls('/malformed'), 1);
      expect(client.pathCalls('/auth/refresh'), 0);
      expect(api.signedIn, isTrue);
      expect(
        (await TokenStore(
          storage: credentials,
          baseUri: Uri.parse('https://api.example.test/api/v1'),
        ).read()).refreshToken,
        'refresh-1',
      );
    },
  );

  test('refreshes a mutation credential without replaying or discarding the session', () async {
    final client = AuthScenarioClient();
    final api = ApiClient(
      baseUri: Uri.parse('https://api.example.test/api/v1'),
      httpClient: client,
      credentialStorage: InMemoryCredentialStorage(),
    );

    await api.initialize();
    await api.signIn('user@example.test', 'password');

    await expectLater(
      api.post('/mutate', <String, dynamic>{'value': 'once'}),
      throwsA(
        isA<ApiFailure>()
            .having((failure) => failure.status, 'status', 401)
            .having((failure) => failure.code, 'code', 'AUTH_REQUIRED'),
      ),
    );

    expect(client.pathCalls('/mutate'), 1);
    expect(client.pathCalls('/auth/refresh'), 1);
    expect(api.signedIn, isTrue);
    expect(api.displayName, 'Test User');

    await api.get('/after-mutation');
    expect(client.authorizationFor('/after-mutation'), <String>[
      'Bearer ${_accessToken(2)}',
    ]);
  });
}

class AuthScenarioClient extends http.BaseClient {
  final List<http.BaseRequest> requests = <http.BaseRequest>[];
  int refreshCount = 0;
  int protectedCount = 0;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    requests.add(request);
    final path = request.url.path;
    switch (path) {
      case '/api/v1/auth/login':
        expect(request.headers['Authorization'], isNull);
        return jsonResponse(200, successEnvelope(_tokens(1, 'refresh-1')));
      case '/api/v1/auth/me':
        expect(request.headers['Authorization'], 'Bearer ${_accessToken(1)}');
        return jsonResponse(200, successEnvelope(_validIdentity()));
      case '/api/v1/auth/refresh':
        refreshCount++;
        expect(
          request.headers['Authorization'],
          refreshCount == 1 ? 'Bearer refresh-1' : 'Bearer refresh-2',
        );
        return jsonResponse(
          200,
          successEnvelope(
            _tokens(
              refreshCount + 1,
              refreshCount == 1 ? 'refresh-2' : 'refresh-3',
            ),
          ),
        );
      case '/api/v1/protected':
        protectedCount++;
        if (protectedCount == 1) {
          return jsonResponse(
            401,
            errorEnvelope('AUTH_REQUIRED', 'Token expired.'),
          );
        }
        return jsonResponse(
          200,
          successEnvelope(<String, dynamic>{'value': 'fresh'}),
        );
      case '/api/v1/mutate':
        expect(request.headers['Authorization'], 'Bearer ${_accessToken(1)}');
        return jsonResponse(
          401,
          errorEnvelope('AUTH_REQUIRED', 'Token expired.'),
        );
      case '/api/v1/after-mutation':
        expect(request.headers['Authorization'], 'Bearer ${_accessToken(2)}');
        return jsonResponse(200, successEnvelope(<String, dynamic>{}));
      case '/api/v1/malformed':
        return jsonResponse(401, <String, dynamic>{'invalid': 'envelope'});
    }
    throw StateError('Unexpected request path $path');
  }

  int pathCalls(String suffix) =>
      requests.where((request) => request.url.path.endsWith(suffix)).length;

  List<String?> authorizationFor(String suffix) => requests
      .where((request) => request.url.path.endsWith(suffix))
      .map((request) => request.headers['Authorization'])
      .toList(growable: false);
}

Map<String, dynamic> _validIdentity() => <String, dynamic>{
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

String _accessToken(int generation) =>
    'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln$generation';

Map<String, dynamic> _tokens(int generation, String refresh) =>
    <String, dynamic>{
      'accessToken': _accessToken(generation),
      'refreshToken': refresh,
      'tokenType': 'Bearer',
      'expiresIn': 600,
    };

class UnavailableHttpClient extends http.BaseClient {
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) =>
      Future<http.StreamedResponse>.error(
        const SocketException('private network details'),
      );
}
