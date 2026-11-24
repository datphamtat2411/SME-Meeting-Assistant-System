import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/core/api_client.dart';

import 'support/http_test_support.dart';

const _baseUri = 'https://api.example.test/api/v1';
const _userA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const _userB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

void main() {
  for (final status in <int>[200, 503]) {
    test(
      'a response from session A cannot reach session B (HTTP $status)',
      () async {
        final client = _SessionRaceClient();
        final api = _api(client);
        addTearDown(api.dispose);
        await _signIn(api);

        final response = api.get('/slow');
        await client.slowRequestStarted.future;
        await api.signOut();
        await api.signIn('user-b@example.test', 'password');

        client.completeSlowRequest(status: status);
        await expectLater(
          response,
          throwsA(
            isA<AuthSessionException>().having(
              (error) => error.failure.category,
              'category',
              AuthFailureCategory.sessionInvalidated,
            ),
          ),
        );
        expect(api.sessionState.identity!.userId.value, _userB);
        expect(api.sessionState.isAuthenticated, isTrue);
      },
    );
  }

  test('a delayed identity response cannot replace the next session', () async {
    final client = _SessionRaceClient()..delaySecondIdentity = true;
    final api = _api(client);
    addTearDown(api.dispose);
    await _signIn(api);

    final identityReload = api.loadIdentity();
    await client.delayedIdentityStarted.future;
    await api.signOut();
    await api.signIn('user-b@example.test', 'password');

    client.completeDelayedIdentity();
    await expectLater(
      identityReload,
      throwsA(
        isA<AuthSessionException>().having(
          (error) => error.failure.category,
          'category',
          AuthFailureCategory.sessionInvalidated,
        ),
      ),
    );
    expect(api.sessionState.identity!.userId.value, _userB);
    expect(api.sessionState.isAuthenticated, isTrue);
  });
}

ApiClient _api(_SessionRaceClient client) => ApiClient(
  baseUri: Uri.parse(_baseUri),
  httpClient: client,
  credentialStorage: InMemoryCredentialStorage(),
);

Future<void> _signIn(ApiClient api) async {
  await api.initialize();
  await api.signIn('user-a@example.test', 'password');
}

class _SessionRaceClient extends http.BaseClient {
  final requests = <http.BaseRequest>[];
  final slowRequestStarted = Completer<void>();
  final slowResponse = Completer<http.StreamedResponse>();
  final delayedIdentityStarted = Completer<void>();
  final delayedIdentityResponse = Completer<http.StreamedResponse>();
  bool delaySecondIdentity = false;
  int loginCount = 0;
  int identityCount = 0;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    requests.add(request);
    final path = request.url.path;
    if (path.endsWith('/auth/login')) {
      loginCount++;
      return jsonResponse(
        200,
        successEnvelope(_tokens(loginCount, 'refresh-$loginCount')),
      );
    }
    if (path.endsWith('/auth/me')) {
      identityCount++;
      if (delaySecondIdentity && identityCount == 2) {
        delayedIdentityStarted.complete();
        return delayedIdentityResponse.future;
      }
      return jsonResponse(
        200,
        successEnvelope(_identity(loginCount == 1 ? _userA : _userB)),
      );
    }
    if (path.endsWith('/auth/logout')) {
      return jsonResponse(200, successEnvelope(null));
    }
    if (path.endsWith('/slow')) {
      slowRequestStarted.complete();
      return slowResponse.future;
    }
    throw StateError('Unexpected request $path');
  }

  void completeSlowRequest({required int status}) {
    if (status == 200) {
      slowResponse.complete(
        jsonResponse(200, successEnvelope(<String, dynamic>{'user': _userA})),
      );
    } else {
      slowResponse.complete(
        jsonResponse(503, errorEnvelope('SERVICE_UNAVAILABLE', 'Unavailable.')),
      );
    }
  }

  void completeDelayedIdentity() {
    delayedIdentityResponse.complete(
      jsonResponse(200, successEnvelope(_identity(_userA))),
    );
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
