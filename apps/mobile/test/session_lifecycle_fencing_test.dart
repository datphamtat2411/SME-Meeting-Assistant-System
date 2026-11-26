import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/features/auth/account_flow.dart';
import 'package:sme_meeting_assistant/features/auth/credential_workflow.dart';

import 'support/http_test_support.dart';

const _baseUri = 'https://api.example.test/api/v1';
const _userA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const _userB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

void main() {
  for (final resetStatus in [200, 503]) {
    for (final identityStatus in [200, 401, 403, 503]) {
      test(
        'reset $resetStatus and verification $identityStatus stay independent',
        () async {
          final client = _SessionRaceClient()
            ..delaySecondIdentity = true
            ..resetStatus = resetStatus;
          final api = _api(client);
          addTearDown(api.dispose);
          await _signIn(api);
          final oldScope = api.authenticatedSessionScope!;
          final owner = CredentialWorkflowOwner(api);
          addTearDown(owner.dispose);
          final attempt = owner.begin(AccountOperation.reset);
          final submission = AccountSubmissionController(AccountOperation.reset);
          addTearDown(submission.dispose);
          await owner.submit(attempt, submission, 'opaque', 'new password 123');
          await client.delayedIdentityStarted.future;
          expect(api.authenticatedSessionScope, isNull);
          expect(api.isCurrentAuthenticatedSession(oldScope), isFalse);
          final kind = resetStatus == 200
              ? CredentialOutcomeKind.completed
              : CredentialOutcomeKind.uncertain;
          expect(owner.outcome?.kind, kind);
          final verificationFinished = Completer<void>();
          void observe() {
            if (api.sessionState.phase != AuthSessionPhase.verifyingIdentity &&
                !verificationFinished.isCompleted) {
              verificationFinished.complete();
            }
          }

          api.addListener(observe);
          client.delayedIdentityResponse.complete(
            identityStatus == 200
                ? jsonResponse(200, successEnvelope(_identity(_userA)))
                : jsonResponse(
                    identityStatus,
                    errorEnvelope(
                      identityStatus == 401
                          ? 'AUTH_REQUIRED'
                          : identityStatus == 403
                          ? 'AUTHZ_FORBIDDEN'
                          : 'SERVICE_UNAVAILABLE',
                      'Unavailable.',
                    ),
                  ),
          );
          await verificationFinished.future;
          api.removeListener(observe);
          expect(owner.outcome?.kind, kind);
          expect(api.sessionState.isAuthenticated, identityStatus == 200);
          if (identityStatus == 503) {
            expect(api.sessionState.canRetryIdentityVerification, isTrue);
            await api.retryIdentityVerification();
            expect(api.sessionState.isAuthenticated, isTrue);
            expect(owner.outcome?.kind, kind);
          }
          expect(client.loginCount, 1);
          expect(client.resetCount, 1);
        },
      );
    }
  }

  test('abandoned reset still gates the current session', () async {
    final client = _SessionRaceClient()
      ..delayReset = true
      ..delaySecondIdentity = true;
    final api = _api(client);
    addTearDown(api.dispose);
    await _signIn(api);
    final owner = CredentialWorkflowOwner(api);
    addTearDown(owner.dispose);
    final attempt = owner.begin(AccountOperation.reset);
    final submission = AccountSubmissionController(AccountOperation.reset);
    final pending = owner.submit(attempt, submission, 'opaque', 'password');
    await client.resetStarted.future;
    owner.abandon(attempt);
    submission.dispose();
    client.resetResponse.complete(
      jsonResponse(200, successEnvelope({'message': 'acknowledged'})),
    );
    await pending;
    await client.delayedIdentityStarted.future;
    expect(api.authenticatedSessionScope, isNull);
    expect(owner.outcome, isNull);
    client.completeDelayedIdentity();
    final finished = Completer<void>();
    void observe() {
      if (api.sessionState.isAuthenticated && !finished.isCompleted) {
        finished.complete();
      }
    }

    api.addListener(observe);
    observe();
    await finished.future;
    api.removeListener(observe);
    expect(owner.outcome, isNull);
    expect(client.resetCount, 1);
  });

  test('setup and rejected reset do not reconcile an unrelated session', () async {
    final client = _SessionRaceClient()..resetStatus = 422;
    final api = _api(client);
    addTearDown(api.dispose);
    await _signIn(api);
    final scope = api.authenticatedSessionScope;
    final owner = CredentialWorkflowOwner(api);
    addTearDown(owner.dispose);
    final reset = owner.begin(AccountOperation.reset);
    final resetSubmission = AccountSubmissionController(AccountOperation.reset);
    addTearDown(resetSubmission.dispose);
    await owner.submit(reset, resetSubmission, 'opaque', 'password');
    expect(resetSubmission.failure?.kind, AccountFailureKind.rejected);
    expect(owner.outcome, isNull);
    owner.abandon(reset);
    final setup = owner.begin(AccountOperation.setup);
    final setupSubmission = AccountSubmissionController(AccountOperation.setup);
    addTearDown(setupSubmission.dispose);
    await owner.submit(setup, setupSubmission, 'opaque', 'password');
    expect(owner.outcome?.kind, CredentialOutcomeKind.completed);
    expect(api.authenticatedSessionScope, scope);
    expect(client.identityCount, 1);
    expect(client.loginCount, 1);
  });

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

  test(
    'reconciliation permanently fences an earlier protected request',
    () async {
      final client = _SessionRaceClient()..delaySecondIdentity = true;
      final api = _api(client);
      addTearDown(api.dispose);
      await _signIn(api);
      final previousScope = api.sessionCoordinator.authenticatedSessionScope!;
      final response = api.get('/slow');
      final rejected = expectLater(
        response,
        throwsA(isA<AuthSessionException>()),
      );
      await client.slowRequestStarted.future;

      final reconciliation = api.reconcileSession();
      expect(api.sessionState.isAuthenticated, isFalse);
      expect(api.sessionCoordinator.authenticatedSessionScope, isNull);
      await expectLater(api.get('/blocked'), throwsA(isA<ApiFailure>()));
      await client.delayedIdentityStarted.future;
      client.completeDelayedIdentity();
      expect(await reconciliation, AuthReconciliationOutcome.verified);
      final nextScope = api.sessionCoordinator.authenticatedSessionScope!;
      expect(nextScope.lifecycleEpoch, previousScope.lifecycleEpoch);
      expect(nextScope, isNot(previousScope));
      expect(client.loginCount, 1);

      client.completeSlowRequest(status: 200);
      await rejected;
      expect(api.sessionState.identity!.userId.value, _userA);
    },
  );

  test('a newer reconciliation requires a newer identity probe', () async {
    final client = _SessionRaceClient()
      ..delaySecondIdentity = true
      ..delayThirdIdentity = true;
    final api = _api(client);
    addTearDown(api.dispose);
    await _signIn(api);

    final first = api.reconcileSession();
    await client.delayedIdentityStarted.future;
    final second = api.reconcileSession();
    client.completeDelayedIdentity();
    await client.thirdIdentityStarted.future;
    expect(api.sessionState.isAuthenticated, isFalse);
    client.completeThirdIdentity();

    expect(await first, AuthReconciliationOutcome.verified);
    expect(await second, AuthReconciliationOutcome.verified);
    expect(client.identityCount, 3);
    expect(client.loginCount, 1);
  });

  test(
    'ordinary identity reload cannot reopen the reconciliation gate',
    () async {
      final client = _SessionRaceClient()
        ..delaySecondIdentity = true
        ..delayThirdIdentity = true;
      final api = _api(client);
      addTearDown(api.dispose);
      await _signIn(api);

      final reload = api.loadIdentity();
      final rejected = expectLater(
        reload,
        throwsA(isA<AuthSessionException>()),
      );
      await client.delayedIdentityStarted.future;
      final reconciliation = api.reconcileSession();
      await client.thirdIdentityStarted.future;
      client.completeDelayedIdentity();
      await rejected;
      expect(api.sessionState.isAuthenticated, isFalse);

      client.completeThirdIdentity();
      expect(await reconciliation, AuthReconciliationOutcome.verified);
    },
  );

  test('unavailable verification stays closed and can be retried', () async {
    final client = _SessionRaceClient()..delaySecondIdentity = true;
    final api = _api(client);
    addTearDown(api.dispose);
    await _signIn(api);
    final previousScope = api.sessionCoordinator.authenticatedSessionScope!;

    final result = api.reconcileSession();
    await client.delayedIdentityStarted.future;
    client.delayedIdentityResponse.complete(
      jsonResponse(503, errorEnvelope('SERVICE_UNAVAILABLE', 'Unavailable.')),
    );
    expect(await result, AuthReconciliationOutcome.unavailable);
    expect(api.sessionState.canRetryIdentityVerification, isTrue);
    expect(api.sessionState.isAuthenticated, isFalse);
    expect(await api.reconcileSession(), AuthReconciliationOutcome.verified);
    expect(
      api.sessionCoordinator.authenticatedSessionScope,
      isNot(previousScope),
    );
    expect(client.loginCount, 1);
  });

  test('identity mismatch invalidates the retained session', () async {
    final client = _SessionRaceClient()..delaySecondIdentity = true;
    final api = _api(client);
    addTearDown(api.dispose);
    await _signIn(api);
    final result = api.reconcileSession();
    await client.delayedIdentityStarted.future;
    client.delayedIdentityResponse.complete(
      jsonResponse(200, successEnvelope(_identity(_userB))),
    );
    expect(await result, AuthReconciliationOutcome.invalidated);
    expect(api.sessionState.phase, AuthSessionPhase.reauthenticationRequired);
    expect(api.sessionCoordinator.authenticatedSessionScope, isNull);
  });

  test('revoked session during reconciliation clears credentials', () async {
    final client = _SessionRaceClient()..delaySecondIdentity = true;
    final storage = InMemoryCredentialStorage();
    final api = ApiClient(
      baseUri: Uri.parse(_baseUri),
      httpClient: client,
      credentialStorage: storage,
    );
    addTearDown(api.dispose);
    await _signIn(api);
    final result = api.reconcileSession();
    await client.delayedIdentityStarted.future;
    client.delayedIdentityResponse.complete(
      jsonResponse(401, errorEnvelope('AUTH_REQUIRED', 'Revoked.')),
    );
    expect(await result, AuthReconciliationOutcome.invalidated);
    expect(api.sessionState.phase, AuthSessionPhase.reauthenticationRequired);
    expect(api.authenticatedSessionScope, isNull);
    expect(client.refreshCount, 1);
    expect(client.loginCount, 1);
    final stored = await TokenStore(
      storage: storage,
      baseUri: Uri.parse(_baseUri),
    ).read();
    expect(stored.refreshToken, isNull);
  });

  test('denied reconciliation never reopens protected access', () async {
    final client = _SessionRaceClient()..delaySecondIdentity = true;
    final api = _api(client);
    addTearDown(api.dispose);
    await _signIn(api);
    final result = api.reconcileSession();
    await client.delayedIdentityStarted.future;
    client.delayedIdentityResponse.complete(
      jsonResponse(403, errorEnvelope('AUTHZ_FORBIDDEN', 'Denied.')),
    );
    expect(await result, AuthReconciliationOutcome.denied);
    expect(api.sessionState.phase, AuthSessionPhase.reauthenticationRequired);
    expect(api.authenticatedSessionScope, isNull);
    expect(client.refreshCount, 0);
    await expectLater(api.get('/blocked'), throwsA(isA<ApiFailure>()));
  });

  test('same user with a different server session is rejected', () async {
    final client = _SessionRaceClient()..delaySecondIdentity = true;
    final api = _api(client);
    addTearDown(api.dispose);
    await _signIn(api);
    final result = api.reconcileSession();
    await client.delayedIdentityStarted.future;
    final identity = _identity(_userA);
    (identity['session'] as Map<String, dynamic>)['id'] =
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    client.delayedIdentityResponse.complete(
      jsonResponse(200, successEnvelope(identity)),
    );
    expect(await result, AuthReconciliationOutcome.invalidated);
    expect(api.authenticatedSessionScope, isNull);
    expect(api.sessionState.phase, AuthSessionPhase.reauthenticationRequired);
  });

  test('changed authorization context uses a fresh protected scope', () async {
    final client = _SessionRaceClient()..delaySecondIdentity = true;
    final api = _api(client);
    addTearDown(api.dispose);
    await _signIn(api);
    final previous = api.authenticatedSessionScope!;
    final result = api.reconcileSession();
    await client.delayedIdentityStarted.future;
    final identity = _identity(_userA)
      ..['globalRole'] = 'DEPARTMENT_MANAGER'
      ..['primaryOrgUnitId'] = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
      ..['directoryManagementScope'] = <String, dynamic>{
        'allUnits': false,
        'unitIds': ['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'],
      };
    client.delayedIdentityResponse.complete(
      jsonResponse(200, successEnvelope(identity)),
    );
    expect(await result, AuthReconciliationOutcome.verified);
    expect(api.isCurrentAuthenticatedSession(previous), isFalse);
    expect(api.authenticatedSessionScope, isNot(previous));
    expect(
      api.sessionState.identity!.globalRole,
      AuthGlobalRole.departmentManager,
    );
    expect(
      api.sessionState.identity!.primaryOrgUnitId!.value,
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    );
    expect(client.loginCount, 1);
    expect(client.refreshCount, 0);
  });

  test('logout supersedes an in-flight reconciliation', () async {
    final client = _SessionRaceClient()..delaySecondIdentity = true;
    final api = _api(client);
    addTearDown(api.dispose);
    await _signIn(api);
    final result = api.reconcileSession();
    await client.delayedIdentityStarted.future;
    await api.signOut();
    expect(await result, AuthReconciliationOutcome.noSession);
    await api.signIn('user-b@example.test', 'password');
    client.completeDelayedIdentity();
    await Future<void>.delayed(Duration.zero);
    expect(api.sessionState.identity!.userId.value, _userB);
  });

  test('reconciliation without a session never dispatches identity', () async {
    final client = _SessionRaceClient();
    final api = _api(client);
    addTearDown(api.dispose);
    await api.initialize();
    expect(await api.reconcileSession(), AuthReconciliationOutcome.noSession);
    expect(client.identityCount, 0);
  });

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
  bool delayThirdIdentity = false;
  final thirdIdentityStarted = Completer<void>();
  final thirdIdentityResponse = Completer<http.StreamedResponse>();
  int loginCount = 0;
  int refreshCount = 0;
  int identityCount = 0;
  int resetStatus = 200;
  int resetCount = 0;
  bool delayReset = false;
  final resetStarted = Completer<void>();
  final resetResponse = Completer<http.StreamedResponse>();

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    requests.add(request);
    final path = request.url.path;
    if (path.endsWith('/auth/password-reset')) {
      resetCount++;
      expect(request.headers['Authorization'], isNull);
      if (delayReset) {
        resetStarted.complete();
        return resetResponse.future;
      }
      return resetStatus == 200
          ? jsonResponse(200, successEnvelope({'message': 'acknowledged'}))
          : jsonResponse(
              resetStatus,
              errorEnvelope(
                resetStatus == 422
                    ? 'VALIDATION_FAILED'
                    : 'SERVICE_UNAVAILABLE',
                'Rejected.',
              ),
            );
    }
    if (path.endsWith('/auth/account-setup')) {
      expect(request.headers['Authorization'], isNull);
      return jsonResponse(200, successEnvelope(null));
    }
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
      if (delayThirdIdentity && identityCount == 3) {
        thirdIdentityStarted.complete();
        return thirdIdentityResponse.future;
      }
      return jsonResponse(
        200,
        successEnvelope(_identity(loginCount == 1 ? _userA : _userB)),
      );
    }
    if (path.endsWith('/auth/refresh')) {
      refreshCount++;
      return jsonResponse(401, errorEnvelope('AUTH_REQUIRED', 'Revoked.'));
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

  void completeThirdIdentity() {
    thirdIdentityResponse.complete(
      jsonResponse(200, successEnvelope(_identity(_userA))),
    );
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
