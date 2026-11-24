import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/core/api_client.dart';

import 'support/http_test_support.dart';

final Uri _apiBaseUri = Uri.parse('https://api.example.test/api/v1');
final DateTime _start = DateTime.utc(2026, 11, 24, 12);

void main() {
  test('twenty expired-token requests share one proactive refresh', () async {
    var now = _start;
    final client = _ControlledAuthClient();
    final api = _api(client, now: () => now);
    addTearDown(api.dispose);
    await _signIn(api);
    now = now.add(const Duration(seconds: 40));

    final requests = List<Future<ApiResult>>.generate(
      20,
      (index) => api.get('/protected/$index'),
    );
    await client.refreshStarted.future;
    expect(client.refreshCalls, 1);

    client.completeRefresh();
    final results = await Future.wait(requests);

    expect(results, hasLength(20));
    expect(client.refreshCalls, 1);
    expect(client.authorizationFor('/protected/0'), <String>[
      'Bearer ${_access(2)}',
    ]);
    expect(client.authorizationFor('/protected/19'), <String>[
      'Bearer ${_access(2)}',
    ]);
  });

  test(
    'twenty 401 responses from one generation share a single refresh',
    () async {
      final client = _ControlledAuthClient(
        rejectGenerationOne: true,
        oldRequestCount: 20,
      );
      final api = _api(client);
      addTearDown(api.dispose);
      await _signIn(api);

      final requests = List<Future<ApiResult>>.generate(
        20,
        (index) => api.get('/protected/$index'),
      );
      await client.allOldGenerationRequests.future;
      await client.refreshStarted.future;
      expect(client.refreshCalls, 1);

      client.completeRefresh();
      final results = await Future.wait(requests);

      expect(results, hasLength(20));
      expect(client.refreshCalls, 1);
      for (var index = 0; index < 20; index++) {
        expect(client.pathCalls('/protected/$index'), 2);
        expect(client.authorizationFor('/protected/$index'), <String>[
          'Bearer ${_access(1)}',
          'Bearer ${_access(2)}',
        ]);
      }
    },
  );

  test(
    'a delayed old-generation 401 replays without another rotation',
    () async {
      final client = _ControlledAuthClient(
        rejectGenerationOne: true,
        delayPath: '/delayed',
      );
      final api = _api(client);
      addTearDown(api.dispose);
      await _signIn(api);

      final delayed = api.get('/delayed');
      await client.delayedRequestStarted.future;
      final fast = api.get('/fast');
      await client.refreshStarted.future;
      client.completeRefresh();
      await fast;

      client.completeDelayedUnauthorized();
      await delayed;

      expect(client.refreshCalls, 1);
      expect(client.authorizationFor('/delayed'), <String>[
        'Bearer ${_access(1)}',
        'Bearer ${_access(2)}',
      ]);
    },
  );

  test(
    'concurrent refresh failure is shared and does not retry the credential',
    () async {
      var now = _start;
      final client = _ControlledAuthClient();
      final api = _api(client, now: () => now);
      addTearDown(api.dispose);
      await _signIn(api);
      now = now.add(const Duration(seconds: 40));

      final requests = List<Future<ApiResult>>.generate(
        20,
        (index) => api.get('/protected/$index'),
      );
      await client.refreshStarted.future;
      client.completeRefresh(status: 429);

      final failures = await Future.wait(
        requests.map(
          (request) => request.then<ApiFailure>(
            (_) => fail('An expired-token request unexpectedly succeeded.'),
            onError: (Object error) {
              expect(error, isA<ApiFailure>());
              return error as ApiFailure;
            },
          ),
        ),
      );

      expect(failures, hasLength(20));
      expect(failures.every((failure) => failure.status == 429), isTrue);
      expect(failures.every((failure) => failure.retryAfter == '30'), isTrue);
      expect(client.refreshCalls, 1);
      expect(client.pathCalls('/auth/refresh'), 1);
      expect(client.protectedRequests, 0);
      expect(api.sessionState.isAuthenticated, isTrue);
      expect(
        api.sessionState.failure?.category,
        AuthFailureCategory.rateLimited,
      );
      expect(
        api.sessionState.retryNotBefore,
        now.add(const Duration(seconds: 30)),
      );

      await expectLater(
        api.get('/protected/after-rate-limit'),
        throwsA(
          isA<ApiFailure>().having((failure) => failure.status, 'status', 429),
        ),
      );
      expect(client.refreshCalls, 1);
    },
  );

  test(
    'session termination fences a pending refresh before durable deletion',
    () async {
      var now = _start;
      final storage = InMemoryCredentialStorage();
      final client = _ControlledAuthClient();
      final api = _api(client, storage: storage, now: () => now);
      addTearDown(api.dispose);
      await _signIn(api);
      now = now.add(const Duration(seconds: 40));

      final pendingRequest = api.get('/protected');
      final pendingRequestFailure = expectLater(
        pendingRequest,
        throwsA(isA<AuthSessionException>()),
      );
      await client.refreshStarted.future;
      await api.signOut();
      await pendingRequestFailure;
      expect(
        (await TokenStore(storage: storage, baseUri: _apiBaseUri).read()).state,
        TokenStoreCredentialState.missing,
      );

      client.completeRefresh();

      expect(api.sessionState.phase, AuthSessionPhase.unauthenticated);
      expect(
        (await TokenStore(storage: storage, baseUri: _apiBaseUri).read()).state,
        TokenStoreCredentialState.missing,
      );
    },
  );

  test(
    'logout during pending-record durability prevents refresh dispatch',
    () async {
      var now = _start;
      final storage = _RotationPendingGateCredentialStorage();
      final client = _ControlledAuthClient();
      final api = _api(client, storage: storage, now: () => now);
      addTearDown(api.dispose);
      await _signIn(api);
      now = now.add(const Duration(seconds: 40));

      final pendingRequestFailure = expectLater(
        api.get('/protected'),
        throwsA(isA<AuthSessionException>()),
      );
      await storage.rotationPendingStarted.future;

      final signOut = api.signOut();
      expect(api.sessionState.phase, AuthSessionPhase.signingOut);
      expect(client.refreshCalls, 0);

      storage.allowRotationPending.complete();
      await signOut;
      await pendingRequestFailure;

      expect(client.pathCalls('/auth/refresh'), 0);
      expect(
        (await TokenStore(storage: storage, baseUri: _apiBaseUri).read()).state,
        TokenStoreCredentialState.missing,
      );
      expect(api.sessionState.phase, AuthSessionPhase.unauthenticated);
    },
  );

  test(
    'session deletion wins when termination races durable rotation commit',
    () async {
      var now = _start;
      final storage = _CommitGateCredentialStorage();
      final client = _ControlledAuthClient();
      final api = _api(client, storage: storage, now: () => now);
      addTearDown(api.dispose);
      await _signIn(api);
      now = now.add(const Duration(seconds: 40));

      final pendingRequest = api.get('/protected');
      final pendingRequestFailure = expectLater(
        pendingRequest,
        throwsA(isA<AuthSessionException>()),
      );
      await client.refreshStarted.future;
      client.completeRefresh();
      await storage.rotationCommitStarted.future;

      final signOut = api.signOut();
      expect(api.sessionState.phase, AuthSessionPhase.signingOut);
      storage.allowRotationCommit.complete();
      await signOut;
      await pendingRequestFailure;

      expect(
        (await TokenStore(storage: storage, baseUri: _apiBaseUri).read()).state,
        TokenStoreCredentialState.missing,
      );
      expect(api.sessionState.phase, AuthSessionPhase.unauthenticated);
    },
  );

  test(
    'protected requests never dispatch without a verified session',
    () async {
      final client = _ControlledAuthClient();
      final api = _api(client);
      addTearDown(api.dispose);
      await api.initialize();

      await expectLater(
        api.get('/protected'),
        throwsA(
          isA<ApiFailure>()
              .having((failure) => failure.status, 'status', 401)
              .having(
                (failure) => failure.code,
                'code',
                'AUTH_SESSION_REQUIRED',
              ),
        ),
      );
      expect(client.pathCalls('/protected'), 0);
    },
  );

  test('disposing the coordinator prevents late refresh publication', () async {
    var now = _start;
    final storage = InMemoryCredentialStorage();
    final client = _ControlledAuthClient();
    final api = _api(client, storage: storage, now: () => now);
    await _signIn(api);
    now = now.add(const Duration(seconds: 40));
    final notifications = <AuthSessionPhase>[];
    api.sessionCoordinator.addListener(
      () => notifications.add(api.sessionState.phase),
    );

    final pendingRequest = api.get('/protected');
    await client.refreshStarted.future;
    final notificationsAtDispose = notifications.length;
    api.dispose();
    client.completeRefresh();

    await expectLater(pendingRequest, throwsA(isA<AuthSessionException>()));
    expect(notifications, hasLength(notificationsAtDispose));
    expect(
      (await TokenStore(storage: storage, baseUri: _apiBaseUri).read()).state,
      TokenStoreCredentialState.rotationPending,
    );
  });

  test('403, 429, and server failures are not refresh triggers', () async {
    for (final status in <int>[403, 429, 503]) {
      final client = _ControlledAuthClient(protectedStatus: status);
      final api = _api(client);
      addTearDown(api.dispose);
      await _signIn(api);

      await expectLater(
        api.get('/protected'),
        throwsA(
          isA<ApiFailure>().having(
            (failure) => failure.status,
            'status',
            status,
          ),
        ),
      );

      expect(client.refreshCalls, 0, reason: 'status $status');
      expect(client.pathCalls('/protected'), 1, reason: 'status $status');
      expect(
        api.sessionState.isAuthenticated,
        isTrue,
        reason: 'status $status',
      );
    }
  });

  test(
    'POST, PATCH, and DELETE mutations are never replayed after 401',
    () async {
      final methods = <String, Future<ApiResult> Function(ApiClient, String)>{
        'POST': (api, path) =>
            api.post(path, const <String, dynamic>{'value': 1}),
        'PATCH': (api, path) =>
            api.patch(path, const <String, dynamic>{'value': 1}),
        'DELETE': (api, path) => api.delete(path),
      };
      for (final entry in methods.entries) {
        final client = _ControlledAuthClient(protectedStatus: 401);
        final api = _api(client);
        addTearDown(api.dispose);
        await _signIn(api);

        final failedMutation = entry.value(api, '/mutation');
        await client.refreshStarted.future;
        client.completeRefresh();
        await expectLater(
          failedMutation,
          throwsA(
            isA<ApiFailure>().having(
              (failure) => failure.status,
              'status',
              401,
            ),
          ),
        );

        expect(client.pathCalls('/mutation'), 1, reason: entry.key);
        expect(client.refreshCalls, 1, reason: entry.key);
        expect(api.sessionState.isAuthenticated, isTrue, reason: entry.key);
      }
    },
  );
}

ApiClient _api(
  _ControlledAuthClient client, {
  CredentialStorage? storage,
  DateTime Function()? now,
}) => ApiClient(
  baseUri: _apiBaseUri,
  httpClient: client,
  credentialStorage: storage ?? InMemoryCredentialStorage(),
  now: now,
);

Future<void> _signIn(ApiClient api) async {
  await api.initialize();
  await api.signIn('user@example.test', 'password');
}

class _ControlledAuthClient extends http.BaseClient {
  _ControlledAuthClient({
    this.rejectGenerationOne = false,
    this.delayPath,
    this.protectedStatus,
    this.oldRequestCount = 0,
  });

  final bool rejectGenerationOne;
  final String? delayPath;
  final int? protectedStatus;
  final int oldRequestCount;
  final List<http.BaseRequest> requests = <http.BaseRequest>[];
  final Completer<void> refreshStarted = Completer<void>();
  final Completer<http.StreamedResponse> refreshResponse =
      Completer<http.StreamedResponse>();
  final Completer<void> delayedRequestStarted = Completer<void>();
  final Completer<http.StreamedResponse> delayedUnauthorized =
      Completer<http.StreamedResponse>();
  final Completer<void> allOldGenerationRequests = Completer<void>();

  int refreshCalls = 0;
  int protectedRequests = 0;
  int _oldRequestCount = 0;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    requests.add(request);
    final path = request.url.path;
    if (path.endsWith('/auth/login')) {
      return jsonResponse(200, successEnvelope(_tokens(1, 'refresh-1')));
    }
    if (path.endsWith('/auth/me')) {
      return jsonResponse(200, successEnvelope(_identity()));
    }
    if (path.endsWith('/auth/refresh')) {
      refreshCalls++;
      expect(request.headers['Authorization'], 'Bearer refresh-1');
      if (!refreshStarted.isCompleted) refreshStarted.complete();
      return refreshResponse.future;
    }
    if (path.endsWith('/auth/logout')) {
      return jsonResponse(200, successEnvelope(null));
    }

    protectedRequests++;
    if (protectedStatus != null) {
      return _failureResponse(protectedStatus!);
    }
    final isOldGeneration =
        request.headers['Authorization'] == 'Bearer ${_access(1)}';
    if (rejectGenerationOne && isOldGeneration) {
      _oldRequestCount++;
      if (oldRequestCount > 0 &&
          _oldRequestCount == oldRequestCount &&
          !allOldGenerationRequests.isCompleted) {
        allOldGenerationRequests.complete();
      }
      if (delayPath != null && path.endsWith(delayPath!)) {
        if (!delayedRequestStarted.isCompleted) {
          delayedRequestStarted.complete();
        }
        return delayedUnauthorized.future;
      }
      return _failureResponse(401);
    }
    return jsonResponse(200, successEnvelope(<String, dynamic>{'path': path}));
  }

  void completeRefresh({int status = 200}) {
    if (status == 200) {
      refreshResponse.complete(
        jsonResponse(200, successEnvelope(_tokens(2, 'refresh-2'))),
      );
    } else {
      refreshResponse.complete(
        streamedResponse(
          status,
          body: utf8.encode(
            jsonEncode(errorEnvelope('RATE_LIMIT_EXCEEDED', 'Try later.')),
          ),
          headers: const <String, String>{
            'content-type': 'application/json',
            'retry-after': '30',
          },
        ),
      );
    }
  }

  void completeDelayedUnauthorized() {
    delayedUnauthorized.complete(
      jsonResponse(401, errorEnvelope('AUTH_REQUIRED', 'Expired.')),
    );
  }

  Future<http.StreamedResponse> _failureResponse(int status) => jsonResponse(
    status,
    errorEnvelope(
      status == 403 ? 'AUTHZ_FORBIDDEN' : 'AUTH_REQUIRED',
      'Request rejected.',
    ),
  );

  int pathCalls(String suffix) =>
      requests.where((request) => request.url.path.endsWith(suffix)).length;

  List<String?> authorizationFor(String suffix) => requests
      .where((request) => request.url.path.endsWith(suffix))
      .map((request) => request.headers['Authorization'])
      .toList(growable: false);
}

class _CommitGateCredentialStorage extends InMemoryCredentialStorage {
  final Completer<void> rotationCommitStarted = Completer<void>();
  final Completer<void> allowRotationCommit = Completer<void>();
  int _durabilityCalls = 0;

  @override
  Future<void> confirmDurable() async {
    _durabilityCalls++;
    if (_durabilityCalls == 3) {
      rotationCommitStarted.complete();
      await allowRotationCommit.future;
    }
    await super.confirmDurable();
  }
}

class _RotationPendingGateCredentialStorage extends InMemoryCredentialStorage {
  final Completer<void> rotationPendingStarted = Completer<void>();
  final Completer<void> allowRotationPending = Completer<void>();
  int _durabilityCalls = 0;

  @override
  Future<void> confirmDurable() async {
    _durabilityCalls++;
    if (_durabilityCalls == 2) {
      rotationPendingStarted.complete();
      await allowRotationPending.future;
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
