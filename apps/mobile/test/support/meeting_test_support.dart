import 'dart:async';
import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/core/api_client.dart';

import 'http_test_support.dart';

const testMeetingId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const testUserId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const testRoomId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const testMeetingEtag = '"meeting-test-v1"';

String meetingRecoveryStorageKey(Uri deployment, String accountId) {
  final normalized = deployment.replace(
    scheme: deployment.scheme.toLowerCase(),
    host: deployment.host.toLowerCase().replaceFirst(RegExp(r'\.$'), ''),
    fragment: null,
    query: null,
  );
  final deploymentScope = sha256
      .convert(
        utf8.encode(normalized.toString().replaceFirst(RegExp(r'/+$'), '')),
      )
      .toString();
  final scope = sha256.convert(utf8.encode('$deploymentScope|$accountId'));
  return 'sme.mobile.meeting-create.v1.$scope';
}

typedef MeetingRequestHandler = Future<http.StreamedResponse> Function(
  http.BaseRequest request,
);

class MeetingTestHttpClient extends http.BaseClient {
  MeetingTestHttpClient(this.onMeetingRequest);

  final MeetingRequestHandler onMeetingRequest;
  final List<http.BaseRequest> requests = <http.BaseRequest>[];
  int _loginCount = 0;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    requests.add(request);
    if (request.url.path.endsWith('/auth/login')) {
      _loginCount++;
      return jsonResponse(
        200,
        meetingSuccessEnvelope(<String, dynamic>{
          'accessToken':
              'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln$_loginCount',
          'refreshToken': 'meeting-refresh-$_loginCount',
          'tokenType': 'Bearer',
          'expiresIn': 600,
        }),
      );
    }
    if (request.url.path.endsWith('/auth/me')) {
      return jsonResponse(200, meetingSuccessEnvelope(meetingTestIdentity()));
    }
    if (request.url.path.endsWith('/auth/logout')) {
      return jsonResponse(200, meetingSuccessEnvelope(null));
    }
    if (request.url.path.endsWith('/auth/refresh')) {
      _loginCount++;
      return jsonResponse(
        200,
        meetingSuccessEnvelope(<String, dynamic>{
          'accessToken':
              'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln$_loginCount',
          'refreshToken': 'meeting-refresh-$_loginCount',
          'tokenType': 'Bearer',
          'expiresIn': 600,
        }),
      );
    }
    return onMeetingRequest(request);
  }
}

ApiClient createMeetingTestApi(
  MeetingTestHttpClient client, {
  DateTime Function()? now,
  CredentialStorage? credentialStorage,
}) => ApiClient(
  baseUri: Uri.parse('https://api.example.test/api/v1'),
  httpClient: client,
  credentialStorage: credentialStorage ?? InMemoryCredentialStorage(),
  now: now,
);

Future<void> signInMeetingTestApi(ApiClient api) async {
  await api.initialize();
  await api.signIn('user@example.test', 'password');
}

Map<String, dynamic> meetingSuccessEnvelope(
  dynamic data, {
  Map<String, dynamic>? meta,
}) => <String, dynamic>{
  'success': true,
  'code': 'SUCCESS',
  'message': 'Request completed.',
  'data': data,
  'meta': meta ?? meetingTestMeta,
};

Map<String, dynamic> meetingErrorEnvelope(
  String code,
  String message, {
  List<Map<String, dynamic>>? errors,
}) => <String, dynamic>{
  'success': false,
  'code': code,
  'message': message,
  'data': null,
  'meta': meetingTestMeta,
  if (errors != null) 'errors': errors,
};

const meetingTestMeta = <String, dynamic>{
  'requestId': '11111111-1111-4111-8111-111111111111',
  'timestamp': '2026-11-24T12:00:00Z',
};

Map<String, dynamic> meetingTestIdentity({String userId = testUserId}) =>
    <String, dynamic>{
      'userId': userId,
      'email': 'user@example.test',
      'displayName': 'Test User',
      'globalRole': 'ADMINISTRATOR',
      'accountStatus': 'ACTIVE',
      'primaryOrgUnitId': null,
      'directoryManagementScope': <String, dynamic>{
        'allUnits': true,
        'unitIds': <String>[],
      },
      'session': <String, dynamic>{
        'id': 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        'clientType': 'MOBILE',
        'createdAt': '2026-11-22T10:00:00Z',
        'lastSeenAt': null,
        'absoluteExpiresAt': '2026-12-22T10:00:00Z',
      },
    };

Map<String, dynamic> meetingTestJson({
  String status = 'SCHEDULED',
  String? scheduledStartAt = '2026-11-24T09:00:00Z',
  String? scheduledEndAt = '2026-11-24T10:00:00Z',
  String? title = 'Weekly review',
  String? roomId,
}) => <String, dynamic>{
  'id': testMeetingId,
  'title': title,
  'description': null,
  'organizerUserId': testUserId,
  'roomId': roomId,
  'scheduledStartAt': scheduledStartAt,
  'scheduledEndAt': scheduledEndAt,
  'status': status,
  'startedAt': null,
  'endedAt': null,
  'cancelledAt': null,
  'cancellationReason': null,
  'createdByUserId': testUserId,
  'createdAt': '2026-11-20T10:15:00Z',
  'updatedAt': '2026-11-20T10:15:00Z',
};

Future<http.StreamedResponse> meetingJsonResponse(
  int status,
  Map<String, dynamic> body, {
  Map<String, String> headers = const <String, String>{},
}) async => http.StreamedResponse(
  Stream<List<int>>.value(utf8.encode(jsonEncode(body))),
  status,
  headers: <String, String>{'content-type': 'application/json', ...headers},
);

Future<http.StreamedResponse> meetingApiSuccess(
  dynamic data, {
  Map<String, String> headers = const <String, String>{},
  Map<String, dynamic>? meta,
  int status = 200,
}) => meetingJsonResponse(
  status,
  meetingSuccessEnvelope(data, meta: meta),
  headers: headers,
);

Future<http.StreamedResponse> meetingApiFailure(
  int status,
  String code, {
  String message = 'Request rejected.',
  Map<String, String> headers = const <String, String>{},
  List<Map<String, dynamic>>? errors,
}) => meetingJsonResponse(
  status,
  meetingErrorEnvelope(code, message, errors: errors),
  headers: headers,
);

Map<String, dynamic> decodeRequestBody(http.BaseRequest request) {
  if (request is! http.Request) {
    throw ArgumentError.value(
      request,
      'request',
      'Expected a buffered request.',
    );
  }
  return jsonDecode(request.body) as Map<String, dynamic>;
}

Future<void> completeRequestAfter(
  Completer<http.StreamedResponse> completer, {
  required int status,
  required Map<String, dynamic> body,
  Map<String, String> headers = const <String, String>{},
}) async {
  completer.complete(await meetingJsonResponse(status, body, headers: headers));
}

class ControllableMeetingCredentialStorage implements CredentialStorage {
  ControllableMeetingCredentialStorage()
    : _delegate = InMemoryCredentialStorage();

  final InMemoryCredentialStorage _delegate;
  Completer<void>? _durabilityGate;
  Completer<void>? _durabilityStarted;

  void holdNextDurabilityConfirmation() {
    if (_durabilityGate != null) {
      throw StateError('A durability confirmation is already held.');
    }
    _durabilityGate = Completer<void>();
    _durabilityStarted = Completer<void>();
  }

  Future<void> waitForDurabilityConfirmation() =>
      _durabilityStarted?.future ?? Future<void>.value();

  void releaseDurabilityConfirmation() {
    final gate = _durabilityGate;
    _durabilityGate = null;
    _durabilityStarted = null;
    gate?.complete();
  }

  @override
  Future<String?> read({required String key}) => _delegate.read(key: key);

  @override
  Future<void> write({required String key, required String value}) =>
      _delegate.write(key: key, value: value);

  @override
  Future<void> delete({required String key}) => _delegate.delete(key: key);

  @override
  Future<void> confirmDurable() async {
    final gate = _durabilityGate;
    final started = _durabilityStarted;
    _durabilityStarted = null;
    started?.complete();
    if (gate != null) await gate.future;
  }
}
