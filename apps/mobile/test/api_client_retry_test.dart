import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/core/api_client.dart';

void main() {
  test('refreshes once and replays a GET after a 401', () async {
    final client = AuthScenarioClient();
    final api = ApiClient(
      baseUri: Uri.parse('https://api.example.test/api/v1'),
      httpClient: client,
      credentialStorage: InMemoryCredentialStorage(),
    );

    await api.signIn('user@example.test', 'password');
    final result = await api.get('/protected');

    expect(result.data, <String, dynamic>{'value': 'fresh'});
    expect(client.pathCalls('/protected'), 2);
    expect(client.pathCalls('/auth/refresh'), 1);
    expect(client.authorizationFor('/protected'), <String>[
      'Bearer access-1',
      'Bearer access-2',
    ]);
    expect(api.signedIn, isTrue);
  });

  test('refreshes a mutation credential without replaying or discarding the session', () async {
    final client = AuthScenarioClient();
    final api = ApiClient(
      baseUri: Uri.parse('https://api.example.test/api/v1'),
      httpClient: client,
      credentialStorage: InMemoryCredentialStorage(),
    );

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
      'Bearer access-2',
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
        return jsonResponse(200, <String, dynamic>{
          'success': true,
          'data': <String, dynamic>{
            'accessToken': 'access-1',
            'refreshToken': 'refresh-1',
            'expiresIn': 600,
          },
          'meta': <String, dynamic>{},
        });
      case '/api/v1/auth/me':
        expect(request.headers['Authorization'], 'Bearer access-1');
        return jsonResponse(200, <String, dynamic>{
          'success': true,
          'data': <String, dynamic>{
            'userId': 'user-1',
            'displayName': 'Test User',
            'email': 'user@example.test',
          },
          'meta': <String, dynamic>{},
        });
      case '/api/v1/auth/refresh':
        refreshCount++;
        expect(
          request.headers['Authorization'],
          refreshCount == 1 ? 'Bearer refresh-1' : 'Bearer refresh-2',
        );
        return jsonResponse(200, <String, dynamic>{
          'success': true,
          'data': <String, dynamic>{
            'accessToken': refreshCount == 1 ? 'access-2' : 'access-3',
            'refreshToken': refreshCount == 1 ? 'refresh-2' : 'refresh-3',
            'expiresIn': 600,
          },
          'meta': <String, dynamic>{},
        });
      case '/api/v1/protected':
        protectedCount++;
        if (protectedCount == 1) {
          return jsonResponse(401, <String, dynamic>{
            'success': false,
            'code': 'AUTH_REQUIRED',
            'message': 'Token expired.',
          });
        }
        return jsonResponse(200, <String, dynamic>{
          'success': true,
          'data': <String, dynamic>{'value': 'fresh'},
          'meta': <String, dynamic>{},
        });
      case '/api/v1/mutate':
        expect(request.headers['Authorization'], 'Bearer access-1');
        return jsonResponse(401, <String, dynamic>{
          'success': false,
          'code': 'AUTH_REQUIRED',
          'message': 'Token expired.',
        });
      case '/api/v1/after-mutation':
        expect(request.headers['Authorization'], 'Bearer access-2');
        return jsonResponse(200, <String, dynamic>{
          'success': true,
          'data': <String, dynamic>{},
          'meta': <String, dynamic>{},
        });
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

Future<http.StreamedResponse> jsonResponse(
  int statusCode,
  Map<String, dynamic> value,
) async => http.StreamedResponse(
  Stream<List<int>>.value(utf8.encode(jsonEncode(value))),
  statusCode,
  headers: const <String, String>{'content-type': 'application/json'},
);
