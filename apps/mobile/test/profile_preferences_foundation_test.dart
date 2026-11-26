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
    if (path.endsWith('/auth/logout')) {
      return jsonResponse(200, successEnvelope(null));
    }
    return handle(request);
  });
  final api = ApiClient(
    baseUri: Uri.parse('https://api.example.test/api/v1'),
    httpClient: client,
    credentialStorage: InMemoryCredentialStorage(),
    now: () => DateTime.utc(2026, 11, 24),
  );
  addTearDown(api.dispose);
  await api.initialize();
  await api.signIn('user@example.test', 'password');
  return api;
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
}
