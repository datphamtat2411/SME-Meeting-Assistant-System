import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/features/profile/profile_controllers.dart';
import 'package:sme_meeting_assistant/features/profile/profile_models.dart';
import 'package:sme_meeting_assistant/features/profile/profile_repository.dart';

import 'support/http_test_support.dart';

const _userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

Map<String, dynamic> _profile(String name) => {
  'id': _userId,
  'email': 'user@example.test',
  'displayName': name,
  'globalRole': 'EMPLOYEE',
  'accountStatus': 'ACTIVE',
  'primaryOrgUnitId': null,
};

Map<String, dynamic> _preferences({bool meeting = true}) => {
  'timezone': null,
  'locale': 'fr-CA',
  'meetingEmailEnabled': meeting,
  'actionItemEmailEnabled': true,
};

Future<http.StreamedResponse> _profileResponse(String name, String etag) =>
    streamedResponse(
      200,
      body: utf8.encode(jsonEncode(successEnvelope(_profile(name)))),
      headers: {'content-type': 'application/json', 'etag': etag},
    );

Future<ApiClient> _authenticated(
  Future<http.StreamedResponse> Function(http.BaseRequest) handle, {
  Future<http.StreamedResponse> Function()? reloadIdentity,
  Future<http.StreamedResponse> Function()? refreshResponse,
  CredentialStorage? storage,
  DateTime Function()? now,
}) async {
  var identityReads = 0;
  final client = RecordingHttpClient((request) {
    final path = request.url.path;
    if (path.endsWith('/auth/login')) {
      return jsonResponse(
        200,
        successEnvelope({
          'accessToken': 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln1',
          'refreshToken': 'refresh-1',
          'tokenType': 'Bearer',
          'expiresIn': 600,
        }),
      );
    }
    if (path.endsWith('/auth/me')) {
      if (++identityReads > 1 && reloadIdentity != null) {
        return reloadIdentity();
      }
      return jsonResponse(
        200,
        successEnvelope({
          'userId': _userId,
          'email': 'user@example.test',
          'displayName': 'Test User',
          'globalRole': 'EMPLOYEE',
          'accountStatus': 'ACTIVE',
          'primaryOrgUnitId': null,
          'directoryManagementScope': {
            'allUnits': false,
            'unitIds': <String>[],
          },
          'session': {
            'id': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            'clientType': 'MOBILE',
            'createdAt': '2026-11-22T10:00:00Z',
            'lastSeenAt': null,
            'absoluteExpiresAt': '2026-12-22T10:00:00Z',
          },
        }),
      );
    }
    if (path.endsWith('/auth/refresh')) {
      if (refreshResponse != null) return refreshResponse();
      throw StateError('Unexpected credential refresh.');
    }
    if (path.endsWith('/auth/logout')) {
      return jsonResponse(200, successEnvelope(null));
    }
    return handle(request);
  });
  final api = ApiClient(
    baseUri: Uri.parse('https://api.example.test/api/v1'),
    httpClient: client,
    credentialStorage: storage ?? InMemoryCredentialStorage(),
    now: now ?? () => DateTime.utc(2026, 11, 24),
  );
  addTearDown(api.dispose);
  await api.initialize();
  await api.signIn('user@example.test', 'password');
  return api;
}

Future<http.StreamedResponse> _rateLimitResponse() => streamedResponse(
  429,
  body: utf8.encode(
    jsonEncode(errorEnvelope('RATE_LIMIT_EXCEEDED', 'Wait before retrying')),
  ),
  headers: {
    'content-type': 'application/json',
    'retry-after': '30',
    'x-request-id': 'rate-limit-request',
  },
);

class _FailingCredentialStorage extends InMemoryCredentialStorage {
  bool failWrites = false;

  @override
  Future<void> write({required String key, required String value}) async {
    if (failWrites) throw const CredentialDurabilityException();
    await super.write(key: key, value: value);
  }
}

void main() {
  test('preferences reject missing and malformed fields', () {
    final valid = _preferences();
    final decoded = UserPreferences.fromResult(ApiResult(valid, {}, null));
    expect(decoded.locale, 'fr-CA');
    expect(decoded.timezone, isNull);
    for (final raw in [
      {...valid}..remove('meetingEmailEnabled'),
      {...valid}..remove('timezone'),
      {...valid, 'meetingEmailEnabled': 'true'},
      {...valid, 'actionItemEmailEnabled': null},
      {...valid, 'timezone': 42},
    ]) {
      expect(
        () => UserPreferences.fromResult(ApiResult(raw, {}, null)),
        throwsA(isA<ApiFailure>()),
      );
    }
  });

  test('profile identity and version are required', () async {
    final api = await _authenticated(
      (_) => throw StateError('unexpected request'),
    );
    final scope = api.requireAuthenticatedSessionScope();
    final valid = _profile('Test User');
    expect(
      ProfileSnapshot.fromResult(ApiResult(valid, {}, '"v1"'), scope).etag,
      '"v1"',
    );
    for (final etag in <String?>[null, '', '*', 'W/"v1"']) {
      expect(
        () => ProfileSnapshot.fromResult(ApiResult(valid, {}, etag), scope),
        throwsA(isA<ApiFailure>()),
      );
    }
    expect(
      () => ProfileSnapshot.fromResult(
        ApiResult(
          {...valid, 'id': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'},
          {},
          '"v1"',
        ),
        scope,
      ),
      throwsA(isA<ApiFailure>()),
    );
  });

  test('profile patch uses original version and canonical response', () async {
    var requests = 0;
    final api = await _authenticated(
      (request) async {
        requests++;
        if (request.method == 'GET') {
          return _profileResponse('Old Name', '"v1"');
        }
        expect(request.method, 'PATCH');
        expect(request.headers['if-match'], '"v1"');
        expect(jsonDecode((request as http.Request).body), {
          'displayName': 'New Name',
        });
        return _profileResponse('Canonical Name', '"v2"');
      },
      reloadIdentity: () =>
          jsonResponse(503, errorEnvelope('INTERNAL_ERROR', 'Unavailable')),
    );
    final controller = ProfileController(ProfileRepository(api: api));
    addTearDown(controller.dispose);
    expect(requests, 0);
    await controller.refresh();
    final original = controller.snapshot!;
    expect(await controller.updateName(original, 'New Name'), isTrue);
    expect(controller.snapshot!.profile.displayName, 'Canonical Name');
    expect(controller.snapshot!.etag, '"v2"');
    expect(controller.outcome, ProfileMutationOutcome.confirmed);
    expect(controller.identityRefreshFailed, isTrue);
    expect(requests, 2);
  });

  test('nullable preference PATCH sends only the intended field', () async {
    final api = await _authenticated((request) async {
      expect(request.method, 'PATCH');
      expect(request.headers['if-match'], isNull);
      expect(jsonDecode((request as http.Request).body), {'timezone': null});
      return jsonResponse(200, successEnvelope(_preferences()));
    });
    final repository = ProfileRepository(api: api);
    final result = await repository.updateTimezone(
      api.requireAuthenticatedSessionScope(),
      null,
    );
    expect(result.preferences.timezone, isNull);
    expect(result.preferences.locale, 'fr-CA');
  });

  test('late reads cannot replace a confirmed preference mutation', () async {
    final started = Completer<void>();
    final delayed = Completer<http.StreamedResponse>();
    var reads = 0;
    final api = await _authenticated((request) async {
      if (request.method == 'GET') {
        if (++reads == 1) {
          return jsonResponse(200, successEnvelope(_preferences()));
        }
        started.complete();
        return delayed.future;
      }
      expect(jsonDecode((request as http.Request).body), {
        'meetingEmailEnabled': false,
      });
      return jsonResponse(200, successEnvelope(_preferences(meeting: false)));
    });
    final controller = PreferencesController(ProfileRepository(api: api));
    addTearDown(controller.dispose);
    await controller.refresh();
    final first = controller.refresh();
    final second = controller.refresh();
    expect(identical(first, second), isTrue);
    await started.future;
    expect(await controller.updateMeetingEmail(false), isTrue);
    delayed.complete(await jsonResponse(200, successEnvelope(_preferences())));
    await first;
    expect(controller.snapshot!.preferences.meetingEmailEnabled, isFalse);
    expect(reads, 2);
  });

  test('unknown outcomes require a successful refresh before reuse', () async {
    var patches = 0;
    final api = await _authenticated((request) async {
      if (request.method == 'GET') {
        return jsonResponse(200, successEnvelope(_preferences()));
      }
      patches++;
      return jsonResponse(503, errorEnvelope('INTERNAL_ERROR', 'Unavailable'));
    });
    final controller = PreferencesController(ProfileRepository(api: api));
    addTearDown(controller.dispose);
    await controller.refresh();
    expect(await controller.updateMeetingEmail(false), isFalse);
    expect(controller.outcome, ProfileMutationOutcome.unknown);
    expect(controller.needsReconciliation, isTrue);
    expect(await controller.updateMeetingEmail(false), isFalse);
    expect(patches, 1);
    await controller.refresh();
    expect(controller.canMutate, isTrue);
  });

  test('logout fences old controller even for the same user', () async {
    final started = Completer<void>();
    final delayed = Completer<http.StreamedResponse>();
    final api = await _authenticated((request) async {
      started.complete();
      return delayed.future;
    });
    final controller = PreferencesController(ProfileRepository(api: api));
    addTearDown(controller.dispose);
    final pending = controller.refresh();
    await started.future;
    await api.signOut();
    await api.signIn('user@example.test', 'password');
    delayed.complete(await jsonResponse(200, successEnvelope(_preferences())));
    await pending;
    expect(controller.current, isFalse);
    expect(controller.snapshot, isNull);
    expect(await controller.updateMeetingEmail(false), isFalse);
  });

  test('duplicate mutations are single-flight per resource', () async {
    final started = Completer<void>();
    final delayed = Completer<http.StreamedResponse>();
    var patches = 0;
    final api = await _authenticated((request) async {
      if (request.method == 'GET') {
        return jsonResponse(200, successEnvelope(_preferences()));
      }
      patches++;
      started.complete();
      return delayed.future;
    });
    final controller = PreferencesController(ProfileRepository(api: api));
    addTearDown(controller.dispose);
    await controller.refresh();
    final pending = controller.updateMeetingEmail(false);
    await started.future;
    expect(controller.saving, isTrue);
    expect(await controller.updateActionItemEmail(false), isFalse);
    expect(patches, 1);
    delayed.complete(
      await jsonResponse(200, successEnvelope(_preferences(meeting: false))),
    );
    expect(await pending, isTrue);
    expect(controller.saving, isFalse);
  });

  for (final status in [412, 428]) {
    test('profile $status requires reconciliation without replay', () async {
      var patches = 0;
      final api = await _authenticated((request) async {
        if (request.method == 'GET') {
          return _profileResponse('Original', '"v1"');
        }
        patches++;
        return jsonResponse(
          status,
          errorEnvelope('RESOURCE_PRECONDITION', 'Precondition failed'),
        );
      });
      final controller = ProfileController(ProfileRepository(api: api));
      addTearDown(controller.dispose);
      await controller.refresh();
      final original = controller.snapshot!;
      expect(await controller.updateName(original, 'New name'), isFalse);
      expect(controller.outcome, ProfileMutationOutcome.rejected);
      expect(
        controller.failure!.category,
        status == 412
            ? ProfileFailureCategory.conflict
            : ProfileFailureCategory.missingPrecondition,
      );
      expect(controller.snapshot, same(original));
      expect(controller.needsReconciliation, isTrue);
      expect(await controller.updateName(original, 'New name'), isFalse);
      expect(patches, 1);
      await controller.refresh();
      expect(controller.canMutate, isTrue);
      expect(patches, 1);
    });
  }

  test('resource denial clears only the denied resource', () async {
    var denied = false;
    final api = await _authenticated((request) async {
      if (request.url.path.endsWith('/me/profile')) {
        return _profileResponse('Original', '"v1"');
      }
      if (denied) {
        return jsonResponse(403, errorEnvelope('AUTHZ_FORBIDDEN', 'Denied'));
      }
      return jsonResponse(200, successEnvelope(_preferences()));
    });
    final repository = ProfileRepository(api: api);
    final profile = ProfileController(repository);
    final preferences = PreferencesController(repository);
    addTearDown(profile.dispose);
    addTearDown(preferences.dispose);
    await profile.refresh();
    await preferences.refresh();
    final original = profile.snapshot;
    denied = true;
    expect(await preferences.updateMeetingEmail(false), isFalse);
    expect(preferences.failure!.category, ProfileFailureCategory.authorization);
    expect(preferences.snapshot, isNull);
    expect(preferences.canMutate, isFalse);
    expect(profile.snapshot, same(original));
    expect(profile.canMutate, isTrue);
  });

  test('transient read failure retains the accessible snapshot', () async {
    var unavailable = false;
    final api = await _authenticated((request) async {
      if (unavailable) {
        return jsonResponse(
          503,
          errorEnvelope('INTERNAL_ERROR', 'Unavailable'),
        );
      }
      return jsonResponse(200, successEnvelope(_preferences()));
    });
    final controller = PreferencesController(ProfileRepository(api: api));
    addTearDown(controller.dispose);
    await controller.refresh();
    final original = controller.snapshot;
    unavailable = true;
    await controller.refresh();
    expect(controller.failure!.category, ProfileFailureCategory.server);
    expect(controller.snapshot, same(original));
    expect(controller.canMutate, isTrue);
    expect(controller.loading, isFalse);
  });

  test('resource rate limit preserves diagnostics', () async {
    final api = await _authenticated((request) async {
      if (request.method == 'GET') {
        return jsonResponse(200, successEnvelope(_preferences()));
      }
      return _rateLimitResponse();
    });
    final controller = PreferencesController(ProfileRepository(api: api));
    addTearDown(controller.dispose);
    await controller.refresh();
    expect(await controller.updateMeetingEmail(false), isFalse);
    final failure = controller.failure!;
    expect(failure.category, ProfileFailureCategory.rateLimited);
    expect(failure.outcome, ProfileMutationOutcome.rejected);
    expect(failure.status, 429);
    expect(failure.code, 'RATE_LIMIT_EXCEEDED');
    expect(failure.requestId, commonMeta['requestId']);
    expect(failure.responseRequestId, 'rate-limit-request');
    expect(failure.retryAfter, '30');
    expect(failure.retryAfterDuration(), const Duration(seconds: 30));
    expect(controller.needsReconciliation, isFalse);
  });

  test('malformed mutation success requires reconciliation', () async {
    final api = await _authenticated((request) async {
      if (request.method == 'GET') {
        return jsonResponse(200, successEnvelope(_preferences()));
      }
      return jsonResponse(
        200,
        successEnvelope({..._preferences(), 'meetingEmailEnabled': 'false'}),
      );
    });
    final controller = PreferencesController(ProfileRepository(api: api));
    addTearDown(controller.dispose);
    await controller.refresh();
    final original = controller.snapshot;
    expect(await controller.updateMeetingEmail(false), isFalse);
    expect(
      controller.failure!.category,
      ProfileFailureCategory.invalidResponse,
    );
    expect(controller.outcome, ProfileMutationOutcome.unknown);
    expect(controller.snapshot, same(original));
    expect(controller.needsReconciliation, isTrue);
    expect(controller.canMutate, isFalse);
  });

  test('late read failure cannot overwrite a confirmed mutation', () async {
    final started = Completer<void>();
    final delayed = Completer<http.StreamedResponse>();
    var reads = 0;
    final api = await _authenticated((request) async {
      if (request.method == 'GET') {
        if (++reads == 1) {
          return jsonResponse(200, successEnvelope(_preferences()));
        }
        started.complete();
        return delayed.future;
      }
      return jsonResponse(200, successEnvelope(_preferences(meeting: false)));
    });
    final controller = PreferencesController(ProfileRepository(api: api));
    addTearDown(controller.dispose);
    await controller.refresh();
    final pending = controller.refresh();
    await started.future;
    expect(await controller.updateMeetingEmail(false), isTrue);
    delayed.complete(
      await jsonResponse(403, errorEnvelope('AUTHZ_FORBIDDEN', 'Denied')),
    );
    await pending;
    expect(controller.failure, isNull);
    expect(controller.snapshot!.preferences.meetingEmailEnabled, isFalse);
  });

  test('refresh rate limit before PATCH means not dispatched', () async {
    var now = DateTime.utc(2026, 11, 24);
    var patches = 0;
    final api = await _authenticated(
      (request) async {
        if (request.method == 'GET') {
          return jsonResponse(200, successEnvelope(_preferences()));
        }
        patches++;
        return jsonResponse(200, successEnvelope(_preferences()));
      },
      now: () => now,
      refreshResponse: _rateLimitResponse,
    );
    final controller = PreferencesController(ProfileRepository(api: api));
    addTearDown(controller.dispose);
    await controller.refresh();
    now = now.add(const Duration(minutes: 10));
    expect(await controller.updateMeetingEmail(false), isFalse);
    expect(controller.outcome, ProfileMutationOutcome.notDispatched);
    expect(controller.failure!.category, ProfileFailureCategory.rateLimited);
    expect(controller.failure!.retryAfter, '30');
    expect(controller.needsReconciliation, isFalse);
    expect(controller.snapshot, isNotNull);
    expect(patches, 0);
  });

  test('failed renewal after a rejected PATCH does not imply commit', () async {
    var patches = 0;
    final api = await _authenticated((request) async {
      if (request.method == 'GET') {
        return jsonResponse(200, successEnvelope(_preferences()));
      }
      patches++;
      return jsonResponse(
        401,
        errorEnvelope('AUTH_SESSION_EXPIRED', 'Expired'),
      );
    }, refreshResponse: _rateLimitResponse);
    final controller = PreferencesController(ProfileRepository(api: api));
    addTearDown(controller.dispose);
    await controller.refresh();
    expect(await controller.updateMeetingEmail(false), isFalse);
    expect(controller.outcome, ProfileMutationOutcome.rejected);
    expect(controller.failure!.retryAfter, '30');
    expect(controller.needsReconciliation, isFalse);
    expect(patches, 1);
  });

  test('credential storage failure cannot escape the repository', () async {
    var now = DateTime.utc(2026, 11, 24);
    var patches = 0;
    final storage = _FailingCredentialStorage();
    final api = await _authenticated(
      (request) async {
        patches++;
        return jsonResponse(200, successEnvelope(_preferences()));
      },
      now: () => now,
      storage: storage,
    );
    final scope = api.requireAuthenticatedSessionScope();
    storage.failWrites = true;
    now = now.add(const Duration(minutes: 10));
    await expectLater(
      ProfileRepository(api: api).updateMeetingEmail(scope, false),
      throwsA(
        isA<ProfileFailure>().having(
          (failure) => failure.outcome,
          'outcome',
          ProfileMutationOutcome.notDispatched,
        ),
      ),
    );
    expect(api.sessionState.isAuthenticated, isFalse);
    expect(
      api.sessionState.failure!.category,
      AuthFailureCategory.credentialStorage,
    );
    expect(patches, 0);
  });

  test('identity storage failure cannot escape a confirmed PATCH', () async {
    final storage = _FailingCredentialStorage();
    var patches = 0;
    final api = await _authenticated(
      (request) async {
        if (request.method == 'GET') {
          return _profileResponse('Original', '"v1"');
        }
        patches++;
        storage.failWrites = true;
        return _profileResponse('New name', '"v2"');
      },
      storage: storage,
      reloadIdentity: () =>
          jsonResponse(401, errorEnvelope('AUTH_SESSION_EXPIRED', 'Expired')),
    );
    final controller = ProfileController(ProfileRepository(api: api));
    addTearDown(controller.dispose);
    await controller.refresh();
    final original = controller.snapshot!;
    await controller.updateName(original, 'New name');
    expect(patches, 1);
    expect(api.sessionState.isAuthenticated, isFalse);
    expect(controller.snapshot, isNull);
    expect(controller.saving, isFalse);
  });

  test('pending mutation cannot publish into a replacement session', () async {
    final started = Completer<void>();
    final delayed = Completer<http.StreamedResponse>();
    final api = await _authenticated((request) async {
      if (request.method == 'GET') {
        return jsonResponse(200, successEnvelope(_preferences()));
      }
      started.complete();
      return delayed.future;
    });
    final repository = ProfileRepository(api: api);
    final previous = PreferencesController(repository);
    addTearDown(previous.dispose);
    await previous.refresh();
    final pending = previous.updateMeetingEmail(false);
    await started.future;
    await api.signOut();
    await api.signIn('user@example.test', 'password');
    final current = PreferencesController(repository);
    addTearDown(current.dispose);
    await current.refresh();
    delayed.complete(
      await jsonResponse(200, successEnvelope(_preferences(meeting: false))),
    );
    expect(await pending, isFalse);
    expect(previous.snapshot, isNull);
    expect(previous.current, isFalse);
    expect(current.snapshot!.preferences.meetingEmailEnabled, isTrue);
    expect(current.failure, isNull);
  });
}
