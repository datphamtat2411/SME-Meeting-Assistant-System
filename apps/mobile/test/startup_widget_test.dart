import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
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

  testWidgets('shows initialization while session restoration is pending', (
    tester,
  ) async {
    final restore = Completer<void>();
    final api = FakeApiClient(onInitialize: () => restore.future);
    final dependencies = createDependencies(api);

    await tester.pumpWidget(MeetingAssistantApp(dependencies: dependencies));

    expect(find.text('Đang khởi tạo ứng dụng'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(api.initializeCalls, 1);

    restore.complete();
    await tester.pumpAndSettle();

    expect(find.text('Đăng nhập hệ thống'), findsOneWidget);
  });

  testWidgets('shows the unauthenticated state after restoration', (
    tester,
  ) async {
    final api = FakeApiClient();

    await tester.pumpWidget(
      MeetingAssistantApp(dependencies: createDependencies(api)),
    );
    await tester.pumpAndSettle();

    expect(find.text('Đăng nhập hệ thống'), findsOneWidget);
    expect(api.initializeCalls, 1);
  });

  testWidgets('shows the authenticated application shell', (tester) async {
    final api = FakeApiClient(signedIn: true);

    await tester.pumpWidget(
      MeetingAssistantApp(dependencies: createDependencies(api)),
    );
    await tester.pumpAndSettle();

    expect(find.text('Tổng quan'), findsOneWidget);
    expect(find.text('Cuộc họp'), findsOneWidget);
    expect(find.text('Công việc'), findsOneWidget);
    expect(find.text('Tài khoản'), findsOneWidget);
  });

  testWidgets('preserves recoverable session presentation', (tester) async {
    final api = FakeApiClient(
      recoverableSession: true,
      restoreError: 'Máy chủ hiện không khả dụng.',
    );

    await tester.pumpWidget(
      MeetingAssistantApp(dependencies: createDependencies(api)),
    );
    await tester.pumpAndSettle();

    expect(find.text('Không thể khôi phục phiên đăng nhập'), findsOneWidget);
    expect(find.text('Máy chủ hiện không khả dụng.'), findsOneWidget);
    expect(find.text('Thử kết nối lại'), findsOneWidget);
    expect(find.text('Sử dụng tài khoản khác'), findsOneWidget);
  });

  testWidgets('surfaces an unexpected initialization failure', (tester) async {
    final api = FakeApiClient(
      onInitialize: () => Future<void>.error(StateError('test failure')),
    );

    await tester.pumpWidget(
      MeetingAssistantApp(dependencies: createDependencies(api)),
    );
    await tester.pumpAndSettle();

    expect(find.text('Không thể khởi tạo ứng dụng'), findsOneWidget);
    expect(find.text('Vui lòng đóng ứng dụng và thử lại.'), findsOneWidget);
  });
}

AppDependencies createDependencies(
  FakeApiClient api, {
  AppearancePreferences? appearance,
}) {
  return AppDependencies(
    api: api,
    appearancePreferences: appearance ?? InMemoryAppearancePreferences(),
    httpClient: api.client,
  );
}

class FakeApiClient extends ApiClient {
  factory FakeApiClient({
    Future<void> Function()? onInitialize,
    bool signedIn = false,
    bool recoverableSession = false,
    String? restoreError,
  }) => FakeApiClient._(
    onInitialize: onInitialize,
    signedInValue: signedIn,
    recoverableSessionValue: recoverableSession,
    restoreErrorValue: restoreError,
    client: NoNetworkHttpClient(),
  );

  FakeApiClient._({
    required this.onInitialize,
    required this.signedInValue,
    required this.recoverableSessionValue,
    required this.restoreErrorValue,
    required this.client,
  }) : super(
         baseUri: Uri.parse('https://api.example.test/api/v1'),
         httpClient: client,
         credentialStorage: InMemoryCredentialStorage(),
       );

  final Future<void> Function()? onInitialize;
  final bool signedInValue;
  final bool recoverableSessionValue;
  final String? restoreErrorValue;
  final NoNetworkHttpClient client;
  int initializeCalls = 0;

  @override
  bool get signedIn => signedInValue;

  @override
  bool get hasRecoverableSession => recoverableSessionValue;

  @override
  String? get sessionRestoreError => restoreErrorValue;

  @override
  String get displayName => 'Test User';

  @override
  String get email => 'test@example.test';

  @override
  Future<void> initialize() async {
    initializeCalls++;
    await onInitialize?.call();
    ready = true;
    notifyListeners();
  }

  @override
  Future<ApiResult> get(String path, {Map<String, String>? query}) async =>
      const ApiResult(<String, dynamic>{}, <String, dynamic>{}, null);
}
