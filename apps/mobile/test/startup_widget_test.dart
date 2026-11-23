import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/app_config.dart';
import 'package:sme_meeting_assistant/core/app_dependencies.dart';
import 'package:sme_meeting_assistant/core/appearance_preferences.dart';
import 'package:sme_meeting_assistant/main.dart';

import 'support/http_test_support.dart';

void main() {
  testWidgets('shows a safe configuration failure', (tester) async {
    await tester.pumpWidget(
      const ConfigurationErrorApp(
        error: AppConfigException(
          'API_BASE_URL is required. Configure an absolute API URL ending in '
          '/api/v1 before starting the app.',
        ),
      ),
    );

    expect(find.text('Cấu hình ứng dụng không hợp lệ'), findsOneWidget);
    expect(find.textContaining('API_BASE_URL is required'), findsOneWidget);
  });

  testWidgets('keeps startup loading through real identity verification', (
    tester,
  ) async {
    final credentials = InMemoryCredentialStorage();
    await credentials.write(key: 'sme.mobile.refresh', value: 'refresh-0');
    final identityRequested = Completer<void>();
    final identityResponse = Completer<http.StreamedResponse>();
    final client = _authClient(
      identityRequested: identityRequested,
      identityResponse: identityResponse,
    );
    final harness = _Harness.create(client, credentials);

    await tester.pumpWidget(
      MeetingAssistantApp(dependencies: harness.dependencies),
    );
    await identityRequested.future;
    await tester.pump();

    expect(harness.api.sessionState.phase, AuthSessionPhase.verifyingIdentity);
    expect(find.text('Đang xác minh danh tính...'), findsOneWidget);
    expect(find.text('Đăng nhập hệ thống'), findsNothing);
    expect(find.text('Tổng quan'), findsNothing);

    identityResponse.complete(
      await jsonResponse(200, successEnvelope(_identity())),
    );
    await tester.pumpAndSettle();

    expect(harness.api.sessionState.phase, AuthSessionPhase.authenticated);
    expect(find.text('Tổng quan'), findsOneWidget);
    expect(find.text('Đăng nhập hệ thống'), findsNothing);
  });

  testWidgets(
    'shows login only after verified unauthenticated initialization',
    (tester) async {
      final harness = _Harness.create(
        _authClient(),
        InMemoryCredentialStorage(),
      );

      await tester.pumpWidget(
        MeetingAssistantApp(dependencies: harness.dependencies),
      );
      await tester.pumpAndSettle();

      expect(harness.api.sessionState.phase, AuthSessionPhase.unauthenticated);
      expect(find.text('Đăng nhập hệ thống'), findsOneWidget);
    },
  );

  testWidgets('retained credentials keep recoverable sessions out of login', (
    tester,
  ) async {
    final credentials = InMemoryCredentialStorage();
    await credentials.write(key: 'sme.mobile.refresh', value: 'refresh-0');
    final harness = _Harness.create(
      _authClient(refreshStatus: 429),
      credentials,
    );

    await tester.pumpWidget(
      MeetingAssistantApp(dependencies: harness.dependencies),
    );
    await tester.pumpAndSettle();

    expect(harness.api.sessionState.phase, AuthSessionPhase.recoverableFailure);
    expect(find.text('Không thể khôi phục phiên đăng nhập'), findsOneWidget);
    expect(find.text('Đăng nhập hệ thống'), findsNothing);
    expect(find.text('Thử kết nối lại'), findsOneWidget);
  });

  testWidgets('routes an invalidated stored session to reauthentication', (
    tester,
  ) async {
    final credentials = InMemoryCredentialStorage();
    await credentials.write(key: 'sme.mobile.refresh', value: 'refresh-0');
    final harness = _Harness.create(
      _authClient(refreshStatus: 401),
      credentials,
    );

    await tester.pumpWidget(
      MeetingAssistantApp(dependencies: harness.dependencies),
    );
    await tester.pumpAndSettle();

    expect(
      harness.api.sessionState.phase,
      AuthSessionPhase.reauthenticationRequired,
    );
    expect(find.text('Đăng nhập hệ thống'), findsOneWidget);
    expect(
      find.text('Phiên đăng nhập đã hết hiệu lực. Vui lòng đăng nhập lại.'),
      findsOneWidget,
    );
    expect(await credentials.read(key: 'sme.mobile.refresh'), isNull);
  });

  testWidgets('blocks normal login after secure-storage read failure', (
    tester,
  ) async {
    final harness = _Harness.create(_authClient(), _FailingReadStorage());

    await tester.pumpWidget(
      MeetingAssistantApp(dependencies: harness.dependencies),
    );
    await tester.pumpAndSettle();

    expect(
      harness.api.sessionState.failure?.category,
      AuthFailureCategory.credentialStorage,
    );
    expect(find.byType(StartupFailureView), findsOneWidget);
    expect(find.text('Đăng nhập hệ thống'), findsNothing);
    expect(
      find.textContaining(
        'Không thể truy cập thông tin đăng nhập được bảo vệ.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('signing out hides protected content before logout completes', (
    tester,
  ) async {
    final credentials = InMemoryCredentialStorage();
    await credentials.write(key: 'sme.mobile.refresh', value: 'refresh-0');
    final logoutRequested = Completer<void>();
    final logoutResponse = Completer<http.StreamedResponse>();
    final client = _authClient(
      logoutRequested: logoutRequested,
      logoutResponse: logoutResponse,
    );
    final harness = _Harness.create(client, credentials);

    await tester.pumpWidget(
      MeetingAssistantApp(dependencies: harness.dependencies),
    );
    await tester.pumpAndSettle();
    expect(find.text('Tổng quan'), findsOneWidget);

    final signOut = harness.api.signOut();
    await logoutRequested.future;
    await tester.pump();

    expect(harness.api.sessionState.phase, AuthSessionPhase.signingOut);
    expect(find.text('Tổng quan'), findsNothing);
    expect(find.text('Đăng nhập hệ thống'), findsNothing);
    expect(find.text('Đang đăng xuất...'), findsOneWidget);

    logoutResponse.complete(await jsonResponse(200, successEnvelope(null)));
    await signOut;
    await tester.pumpAndSettle();

    expect(harness.api.sessionState.phase, AuthSessionPhase.unauthenticated);
    expect(find.text('Đăng nhập hệ thống'), findsOneWidget);
  });
}

class _Harness {
  _Harness._({
    required this.client,
    required this.api,
    required this.dependencies,
  });

  factory _Harness.create(
    RecordingHttpClient client,
    CredentialStorage credentials,
  ) {
    final api = ApiClient(
      baseUri: Uri.parse('https://api.example.test/api/v1'),
      httpClient: client,
      credentialStorage: credentials,
    );
    final dependencies = AppDependencies(
      api: api,
      appearancePreferences: InMemoryAppearancePreferences(),
      httpClient: client,
    );
    return _Harness._(client: client, api: api, dependencies: dependencies);
  }

  final RecordingHttpClient client;
  final ApiClient api;
  final AppDependencies dependencies;
}

RecordingHttpClient _authClient({
  int? refreshStatus,
  Completer<void>? identityRequested,
  Completer<http.StreamedResponse>? identityResponse,
  Completer<void>? logoutRequested,
  Completer<http.StreamedResponse>? logoutResponse,
}) => RecordingHttpClient((request) async {
  final path = request.url.path;
  expect(request.headers['X-Auth-Transport'], 'mobile');
  if (path.endsWith('/auth/refresh')) {
    if (refreshStatus != null) {
      return jsonResponse(
        refreshStatus,
        errorEnvelope('AUTH_RATE_LIMITED', 'Try again later.'),
      );
    }
    expect(request.headers['Authorization'], 'Bearer refresh-0');
    return jsonResponse(200, successEnvelope(_tokens('access-1', 'refresh-1')));
  }
  if (path.endsWith('/auth/me')) {
    expect(
      request.headers['Authorization'],
      'Bearer ${_accessToken('access-1')}',
    );
    if (identityRequested != null && !identityRequested.isCompleted) {
      identityRequested.complete();
    }
    if (identityResponse != null) return identityResponse.future;
    return jsonResponse(200, successEnvelope(_identity()));
  }
  if (path.endsWith('/auth/login')) {
    expect(request.headers['Authorization'], isNull);
    return jsonResponse(200, successEnvelope(_tokens('access-1', 'refresh-1')));
  }
  if (path.endsWith('/auth/logout')) {
    expect(
      request.headers['Authorization'],
      'Bearer ${_accessToken('access-1')}',
    );
    if (logoutRequested != null && !logoutRequested.isCompleted) {
      logoutRequested.complete();
    }
    if (logoutResponse != null) return logoutResponse.future;
    return jsonResponse(200, successEnvelope(null));
  }
  return jsonResponse(200, successEnvelope(<String, dynamic>{}));
});

Map<String, dynamic> _tokens(String access, String refresh) =>
    <String, dynamic>{
      'accessToken': 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.$access',
      'refreshToken': refresh,
      'tokenType': 'Bearer',
      'expiresIn': 600,
    };

String _accessToken(String access) =>
    'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.$access';

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

class _FailingReadStorage implements CredentialStorage {
  @override
  Future<String?> read({required String key}) =>
      Future<String?>.error(StateError('private storage details'));

  @override
  Future<void> write({required String key, required String value}) async {}

  @override
  Future<void> delete({required String key}) async {}
}
