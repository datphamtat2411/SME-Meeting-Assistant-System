import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/app_config.dart';
import 'package:sme_meeting_assistant/core/app_dependencies.dart';
import 'package:sme_meeting_assistant/core/appearance_preferences.dart';
import 'package:sme_meeting_assistant/features/profile/preferences_panel.dart';
import 'package:sme_meeting_assistant/features/profile/profile_page.dart';
import 'package:sme_meeting_assistant/main.dart';

import 'support/http_test_support.dart';
import 'support/widget_test_support.dart';

const _testApiUri = 'https://api.example.test/api/v1';

Future<void> _writeRefreshCredential(CredentialStorage storage, String token) =>
    TokenStore(
      storage: storage,
      baseUri: Uri.parse(_testApiUri),
    ).storeLoginCredential(token);

Future<String?> _readRefreshCredential(CredentialStorage storage) async =>
    (await TokenStore(
      storage: storage,
      baseUri: Uri.parse(_testApiUri),
    ).read()).refreshToken;

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
    await _writeRefreshCredential(credentials, 'refresh-0');
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
    await pumpUntil(
      tester,
      () => identityRequested.isCompleted,
      reason: 'the identity request to be dispatched',
    );
    await tester.pump();

    expect(harness.api.sessionState.phase, AuthSessionPhase.verifyingIdentity);
    expect(find.text('Đang xác minh danh tính...'), findsOneWidget);
    expect(find.text('Đăng nhập hệ thống'), findsNothing);
    expect(find.text('Tổng quan'), findsNothing);

    identityResponse.complete(
      await jsonResponse(200, successEnvelope(_identity())),
    );
    await pumpUntil(
      tester,
      () =>
          harness.api.sessionState.phase == AuthSessionPhase.authenticated &&
          find.text('Tổng quan').evaluate().isNotEmpty,
      reason: 'verified startup to reach the authenticated shell',
    );

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
      await pumpUntil(
        tester,
        () =>
            harness.api.sessionState.phase ==
                AuthSessionPhase.unauthenticated &&
            find.text('Đăng nhập hệ thống').evaluate().isNotEmpty,
        reason: 'startup to reach the login screen',
      );

      expect(harness.api.sessionState.phase, AuthSessionPhase.unauthenticated);
      expect(find.text('Đăng nhập hệ thống'), findsOneWidget);
    },
  );

  testWidgets('retained credentials keep recoverable sessions out of login', (
    tester,
  ) async {
    final credentials = InMemoryCredentialStorage();
    await _writeRefreshCredential(credentials, 'refresh-0');
    final harness = _Harness.create(
      _authClient(refreshStatus: 429),
      credentials,
    );

    await tester.pumpWidget(
      MeetingAssistantApp(dependencies: harness.dependencies),
    );
    await pumpUntil(
      tester,
      () =>
          harness.api.sessionState.phase ==
              AuthSessionPhase.recoverableFailure &&
          find.text('Không thể tiếp tục phiên đăng nhập').evaluate().isNotEmpty,
      reason: 'startup to show the recoverable session failure',
    );

    expect(harness.api.sessionState.phase, AuthSessionPhase.recoverableFailure);
    expect(find.text('Không thể tiếp tục phiên đăng nhập'), findsOneWidget);
    expect(find.text('Đăng nhập hệ thống'), findsNothing);
    expect(find.text('Thử kết nối lại'), findsOneWidget);
  });

  testWidgets('temporary identity failure offers a safe verification retry', (
    tester,
  ) async {
    final credentials = InMemoryCredentialStorage();
    await _writeRefreshCredential(credentials, 'refresh-0');
    final client = _authClient(identityFailures: 1);
    final harness = _Harness.create(client, credentials);

    await tester.pumpWidget(
      MeetingAssistantApp(dependencies: harness.dependencies),
    );
    await pumpUntil(
      tester,
      () =>
          harness.api.sessionState.canRetryIdentityVerification &&
          find.text('Thử xác minh lại').evaluate().isNotEmpty,
      reason: 'startup to show identity-verification recovery',
    );

    expect(harness.api.sessionState.canRetryIdentityVerification, isTrue);
    expect(find.textContaining('Không thể xác minh danh tính'), findsOneWidget);
    expect(find.text('Thử xác minh lại'), findsOneWidget);
    expect(find.text('Đăng nhập hệ thống'), findsNothing);

    await tester.tap(find.text('Thử xác minh lại'));
    await pumpUntil(
      tester,
      () =>
          harness.api.sessionState.isAuthenticated &&
          find.text('Tổng quan').evaluate().isNotEmpty,
      reason: 'identity retry to reach the authenticated shell',
    );

    expect(harness.api.sessionState.isAuthenticated, isTrue);
    expect(find.text('Tổng quan'), findsOneWidget);
    expect(
      client.requests.where(
        (request) => request.url.path.endsWith('/auth/refresh'),
      ),
      hasLength(1),
    );
  });

  testWidgets('login rejection displays a localized recoverable error', (
    tester,
  ) async {
    final harness = _Harness.create(
      _authClient(loginStatus: 401),
      InMemoryCredentialStorage(),
    );

    await tester.pumpWidget(
      MeetingAssistantApp(dependencies: harness.dependencies),
    );
    await pumpUntil(
      tester,
      () => find.text('Đăng nhập hệ thống').evaluate().isNotEmpty,
      reason: 'the login screen to render',
    );
    await tester.enterText(
      find.byType(TextFormField).at(0),
      'user@example.test',
    );
    await tester.enterText(find.byType(TextFormField).at(1), 'wrong-password');
    await tester.tap(find.widgetWithText(FilledButton, 'Đăng nhập'));
    await pumpUntil(
      tester,
      () =>
          harness.api.sessionState.phase == AuthSessionPhase.unauthenticated &&
          find
              .text('Email hoặc mật khẩu không chính xác.')
              .evaluate()
              .isNotEmpty,
      reason: 'the rejected-login message to render',
    );

    expect(harness.api.sessionState.phase, AuthSessionPhase.unauthenticated);
    expect(find.text('Email hoặc mật khẩu không chính xác.'), findsOneWidget);
    expect(find.text('Đăng nhập hệ thống'), findsOneWidget);
  });

  testWidgets('routes an invalidated stored session to reauthentication', (
    tester,
  ) async {
    final credentials = InMemoryCredentialStorage();
    await _writeRefreshCredential(credentials, 'refresh-0');
    final harness = _Harness.create(
      _authClient(refreshStatus: 401),
      credentials,
    );

    await tester.pumpWidget(
      MeetingAssistantApp(dependencies: harness.dependencies),
    );
    await pumpUntil(
      tester,
      () =>
          harness.api.sessionState.phase ==
              AuthSessionPhase.reauthenticationRequired &&
          find.text('Đăng nhập hệ thống').evaluate().isNotEmpty,
      reason: 'the invalidated session to require reauthentication',
    );

    expect(
      harness.api.sessionState.phase,
      AuthSessionPhase.reauthenticationRequired,
    );
    expect(find.text('Đăng nhập hệ thống'), findsOneWidget);
    expect(
      find.text('Phiên đăng nhập đã hết hiệu lực. Vui lòng đăng nhập lại.'),
      findsOneWidget,
    );
    expect(await _readRefreshCredential(credentials), isNull);
  });

  testWidgets('blocks normal login after secure-storage read failure', (
    tester,
  ) async {
    final harness = _Harness.create(_authClient(), _FailingReadStorage());

    await tester.pumpWidget(
      MeetingAssistantApp(dependencies: harness.dependencies),
    );
    await pumpUntil(
      tester,
      () =>
          harness.api.sessionState.failure?.category ==
              AuthFailureCategory.credentialStorage &&
          find.byType(StartupFailureView).evaluate().isNotEmpty,
      reason: 'the secure-storage failure view to render',
    );

    expect(
      harness.api.sessionState.failure?.category,
      AuthFailureCategory.credentialStorage,
    );
    expect(find.byType(StartupFailureView), findsOneWidget);
    expect(find.text('Đăng nhập hệ thống'), findsNothing);
    expect(find.text('Thử truy cập lại'), findsOneWidget);
    expect(
      find.textContaining(
        'Không thể truy cập thông tin đăng nhập được bảo vệ.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('interrupted logout blocks login until marker cleanup succeeds', (
    tester,
  ) async {
    final credentials = _FailingDeleteStorage();
    final store = TokenStore(
      storage: credentials,
      baseUri: Uri.parse(_testApiUri),
    );
    await store.storeLoginCredential('refresh-0');
    await store.persistLogoutIntent();
    final client = _authClient();
    final harness = _Harness.create(client, credentials);

    await tester.pumpWidget(
      MeetingAssistantApp(dependencies: harness.dependencies),
    );
    await pumpUntil(
      tester,
      () =>
          harness.api.sessionState.failure?.machineCode ==
              'LOGOUT_RECOVERY_CLEANUP_FAILED' &&
          find.text('Thử xóa phiên đã lưu lại').evaluate().isNotEmpty,
      reason: 'the incomplete logout-recovery state to render',
    );

    expect(
      harness.api.sessionState.failure?.machineCode,
      'LOGOUT_RECOVERY_CLEANUP_FAILED',
    );
    expect(
      find.text(
        'Phiên đăng xuất trước đó chưa được dọn dẹp hoàn tất. Vui lòng thử xóa thông tin phiên đã lưu.',
      ),
      findsOneWidget,
    );
    expect(find.text('Đăng nhập hệ thống'), findsNothing);
    expect(find.text('Thử xóa phiên đã lưu lại'), findsOneWidget);
    await expectLater(
      harness.api.signIn('other@example.test', 'password'),
      throwsStateError,
    );
    expect(
      client.requests.where(
        (request) =>
            request.url.path.endsWith('/auth/refresh') ||
            request.url.path.endsWith('/auth/me'),
      ),
      isEmpty,
    );

    await tester.tap(find.text('Thử xóa phiên đã lưu lại'));
    await pumpUntil(
      tester,
      () =>
          harness.api.sessionState.phase == AuthSessionPhase.unauthenticated &&
          find.text('Đăng nhập hệ thống').evaluate().isNotEmpty,
      reason: 'logout recovery to return to the login screen',
    );

    expect(harness.api.sessionState.phase, AuthSessionPhase.unauthenticated);
    expect(find.text('Đăng nhập hệ thống'), findsOneWidget);
    expect(
      client.requests.where(
        (request) =>
            request.url.path.endsWith('/auth/refresh') ||
            request.url.path.endsWith('/auth/me'),
      ),
      isEmpty,
    );
  });

  testWidgets('signing out hides protected content before logout completes', (
    tester,
  ) async {
    final credentials = InMemoryCredentialStorage();
    await _writeRefreshCredential(credentials, 'refresh-0');
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
    await pumpUntil(
      tester,
      () =>
          harness.api.sessionState.isAuthenticated &&
          find.text('Tổng quan').evaluate().isNotEmpty,
      reason: 'startup restoration to reach the authenticated shell',
    );
    expect(find.text('Tổng quan'), findsOneWidget);

    late Future<AuthLogoutOutcome> signOut;
    await tester.runAsync(() async {
      signOut = harness.api.signOut();
    });
    await pumpUntil(
      tester,
      () => logoutRequested.isCompleted,
      reason: 'the logout request to be dispatched',
    );
    await tester.pump();

    expect(harness.api.sessionState.phase, AuthSessionPhase.signingOut);
    expect(find.text('Tổng quan'), findsNothing);
    expect(find.text('Đăng nhập hệ thống'), findsNothing);
    expect(find.text('Đang đăng xuất...'), findsOneWidget);

    logoutResponse.complete(await jsonResponse(200, successEnvelope(null)));
    await pumpUntil(
      tester,
      () =>
          harness.api.sessionState.phase == AuthSessionPhase.unauthenticated &&
          find.text('Đăng nhập hệ thống').evaluate().isNotEmpty,
      reason: 'completed logout to return to the login screen',
    );
    await tester.runAsync(() => signOut);

    expect(harness.api.sessionState.phase, AuthSessionPhase.unauthenticated);
    expect(find.text('Đăng nhập hệ thống'), findsOneWidget);
  });

  testWidgets('session invalidation removes pushed protected routes', (
    tester,
  ) async {
    final credentials = InMemoryCredentialStorage();
    await _writeRefreshCredential(credentials, 'refresh-0');
    final logoutRequested = Completer<void>();
    final logoutResponse = Completer<http.StreamedResponse>();
    final harness = _Harness.create(
      _authClient(
        logoutRequested: logoutRequested,
        logoutResponse: logoutResponse,
      ),
      credentials,
    );

    await tester.pumpWidget(
      MeetingAssistantApp(dependencies: harness.dependencies),
    );
    await pumpUntil(
      tester,
      () =>
          harness.api.sessionState.isAuthenticated &&
          find.text('Tổng quan').evaluate().isNotEmpty,
      reason: 'authenticated navigation to become available',
    );
    final navigator = tester.state<NavigatorState>(find.byType(Navigator));
    unawaited(
      navigator.push<void>(
        MaterialPageRoute<void>(
          builder: (_) => const Scaffold(body: Text('Protected meeting')),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    expect(find.text('Protected meeting'), findsOneWidget);

    // An unrelated notification must not discard navigation in the same session.
    harness.api.notifyListeners();
    await tester.pump();
    expect(find.text('Protected meeting'), findsOneWidget);
    expect(
      tester.state<NavigatorState>(find.byType(Navigator)),
      same(navigator),
    );

    late Future<AuthLogoutOutcome> signOut;
    await tester.runAsync(() async {
      signOut = harness.api.signOut();
    });
    await pumpUntil(
      tester,
      () => logoutRequested.isCompleted,
      reason: 'logout to begin while a protected route is open',
    );
    await tester.pump();

    expect(find.text('Protected meeting', skipOffstage: false), findsNothing);
    expect(find.text('Đang đăng xuất...'), findsOneWidget);
    expect(
      tester.state<NavigatorState>(find.byType(Navigator)).canPop(),
      isFalse,
    );

    logoutResponse.complete(await jsonResponse(200, successEnvelope(null)));
    await pumpUntil(
      tester,
      () => find.text('Đăng nhập hệ thống').evaluate().isNotEmpty,
      reason: 'logout to finish without the previous route stack',
    );
    await tester.runAsync(() => signOut);

    await tester.runAsync(
      () => harness.api.signIn('user@example.test', 'password'),
    );
    await pumpUntil(
      tester,
      () => find.text('Tổng quan').evaluate().isNotEmpty,
      reason: 'the new authenticated session to reach its own shell',
    );
    expect(find.text('Protected meeting', skipOffstage: false), findsNothing);
    expect(
      tester.state<NavigatorState>(find.byType(Navigator)).canPop(),
      isFalse,
    );
  });

  testWidgets('failed credential deletion blocks login until safe retry', (
    tester,
  ) async {
    final credentials = _FailingDeleteStorage();
    await _writeRefreshCredential(credentials, 'refresh-0');
    final client = _authClient();
    final harness = _Harness.create(client, credentials);

    await tester.pumpWidget(
      MeetingAssistantApp(dependencies: harness.dependencies),
    );
    await pumpUntil(
      tester,
      () =>
          harness.api.sessionState.isAuthenticated &&
          find.text('Tổng quan').evaluate().isNotEmpty,
      reason: 'startup restoration to reach the authenticated shell',
    );
    expect(find.text('Tổng quan'), findsOneWidget);

    late Future<Object?> signOutResult;
    await tester.runAsync(() async {
      signOutResult = harness.api.signOut().then<Object?>(
        (result) => result,
        onError: (Object error, StackTrace stackTrace) => error,
      );
    });
    await pumpUntil(
      tester,
      () =>
          harness.api.sessionState.failure?.category ==
              AuthFailureCategory.credentialStorage &&
          find
              .text('Không thể xác nhận xóa phiên bảo mật')
              .evaluate()
              .isNotEmpty,
      reason: 'the failed credential-deletion state to render',
    );
    final signOutError = await tester.runAsync(() => signOutResult);
    expect(signOutError, isA<AuthSessionException>());
    expect(
      (signOutError! as AuthSessionException).failure.category,
      AuthFailureCategory.credentialStorage,
    );

    expect(find.text('Tổng quan'), findsNothing);
    expect(find.text('Đăng nhập hệ thống'), findsNothing);
    expect(find.text('Không thể xác nhận xóa phiên bảo mật'), findsOneWidget);
    expect(find.text('Thử xóa phiên đã lưu lại'), findsOneWidget);
    await expectLater(
      harness.api.signIn('other@example.test', 'password'),
      throwsStateError,
    );
    expect(
      client.requests.where(
        (request) => request.url.path.endsWith('/auth/logout'),
      ),
      hasLength(1),
    );

    await tester.tap(find.text('Thử xóa phiên đã lưu lại'));
    await pumpUntil(
      tester,
      () =>
          harness.api.sessionState.phase == AuthSessionPhase.unauthenticated &&
          find.text('Đăng nhập hệ thống').evaluate().isNotEmpty,
      reason: 'credential cleanup retry to return to the login screen',
    );

    expect(harness.api.sessionState.phase, AuthSessionPhase.unauthenticated);
    expect(find.text('Đăng nhập hệ thống'), findsOneWidget);
    expect(find.text('Đã đăng xuất khỏi thiết bị.'), findsOneWidget);
    expect(
      client.requests.where(
        (request) => request.url.path.endsWith('/auth/logout'),
      ),
      hasLength(1),
    );

    late Future<void> signIn;
    await tester.runAsync(() async {
      signIn = harness.api.signIn('other@example.test', 'password');
    });
    await pumpUntil(
      tester,
      () =>
          harness.api.sessionState.isAuthenticated &&
          find.text('Tổng quan').evaluate().isNotEmpty,
      reason: 'a successful sign-in to reach the authenticated shell',
    );
    await tester.runAsync(() => signIn);
    expect(find.text('Tổng quan'), findsOneWidget);
  });

  testWidgets(
    'unconfirmed remote logout is reported without claiming success',
    (tester) async {
      final credentials = InMemoryCredentialStorage();
      final client = _authClient(logoutStatus: 503);
      final harness = _Harness.create(client, credentials);
      await tester.pumpWidget(
        MeetingAssistantApp(dependencies: harness.dependencies),
      );
      await pumpUntil(
        tester,
        () => find.text('Đăng nhập hệ thống').evaluate().isNotEmpty,
        reason: 'the login screen to render',
      );
      late Future<void> signIn;
      await tester.runAsync(() async {
        signIn = harness.api.signIn('user@example.test', 'password');
      });
      await pumpUntil(
        tester,
        () =>
            harness.api.sessionState.isAuthenticated &&
            find.text('Tổng quan').evaluate().isNotEmpty,
        reason: 'sign-in to reach the authenticated shell',
      );
      await tester.runAsync(() => signIn);

      late Future<AuthLogoutOutcome> signOut;
      await tester.runAsync(() async {
        signOut = harness.api.signOut();
      });
      await pumpUntil(
        tester,
        () =>
            harness.api.sessionState.failure?.category ==
                AuthFailureCategory.logoutUnconfirmed &&
            find
                .text(
                  'Thiết bị đã đăng xuất, nhưng máy chủ chưa xác nhận việc thu hồi phiên.',
                )
                .evaluate()
                .isNotEmpty,
        reason: 'the unconfirmed-logout message to render',
      );
      final outcome = await tester.runAsync(() => signOut);

      expect(outcome, AuthLogoutOutcome.remoteRevocationUnconfirmed);
      expect(
        harness.api.sessionState.failure?.category,
        AuthFailureCategory.logoutUnconfirmed,
      );
      expect(
        find.text(
          'Thiết bị đã đăng xuất, nhưng máy chủ chưa xác nhận việc thu hồi phiên.',
        ),
        findsOneWidget,
      );
      expect(find.text('Đã đăng xuất khỏi thiết bị.'), findsNothing);
      expect(find.text('Tổng quan'), findsNothing);
    },
  );

  for (final scenario in ['confirmed', 'unconfirmed', 'storage']) {
    testWidgets('Account sign-out presents the $scenario outcome', (
      tester,
    ) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(600, 1000);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final credentials = scenario == 'storage'
          ? _FailingDeleteStorage()
          : InMemoryCredentialStorage();
      await _writeRefreshCredential(credentials, 'refresh-0');
      final client = _authClient(
        logoutStatus: scenario == 'unconfirmed' ? 503 : null,
      );
      final harness = _Harness.create(client, credentials);
      await tester.pumpWidget(
        MeetingAssistantApp(dependencies: harness.dependencies),
      );
      await pumpUntil(
        tester,
        () =>
            harness.api.signedIn &&
            find.byType(NavigationBar).evaluate().isNotEmpty,
        reason: 'authenticated Account navigation',
      );
      await tester.tap(find.text('Tài khoản'));
      await pumpUntil(
        tester,
        () => find.text('Test User').evaluate().isNotEmpty,
        reason: 'canonical profile to render',
      );
      final logout = find.text('Đăng xuất');
      await tester.scrollUntilVisible(
        logout,
        300,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.ensureVisible(logout);
      await tester.tap(logout);
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Đăng xuất'));
      final message = switch (scenario) {
        'confirmed' => 'Đã đăng xuất khỏi thiết bị.',
        'unconfirmed' => 'Thiết bị đã đăng xuất, nhưng máy chủ chưa xác nhận việc thu hồi phiên.',
        _ => 'Không thể xác nhận xóa phiên bảo mật',
      };
      await pumpUntil(
        tester,
        () => find.text(message).evaluate().isNotEmpty,
        reason: 'Account sign-out destination outcome',
      );
      expect(harness.api.signedIn, isFalse);
      expect(find.byType(AppShell), findsNothing);
      expect(
        client.requests.where(
          (request) => request.url.path.endsWith('/auth/logout'),
        ),
        hasLength(1),
      );
      await tester.pumpWidget(const SizedBox.shrink());
    });
  }

  testWidgets('device appearance survives Account theme changes and login', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(600, 1000);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final credentials = InMemoryCredentialStorage();
    await _writeRefreshCredential(credentials, 'refresh-0');
    var replacement = false;
    final client = _authClient(
      identityProvider: () => replacement
          ? _identity(
              userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              email: 'other@example.test',
              displayName: 'Other User',
              sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            )
          : _identity(),
    );
    final harness = _Harness.create(client, credentials);
    int accountRequests() {
      return client.requests.where((request) {
        final path = request.url.path;
        return path.endsWith('/me/profile') || path.endsWith('/me/preferences');
      }).length;
    }

    await tester.pumpWidget(
      MeetingAssistantApp(dependencies: harness.dependencies),
    );
    await pumpUntil(
      tester,
      () =>
          harness.api.signedIn &&
          find.byType(NavigationBar).evaluate().isNotEmpty,
      reason: 'authenticated navigation',
    );
    expect(accountRequests(), 0);
    await tester.tap(find.text('Tài khoản'));
    final panel = find.byType(PreferencesPanel);
    await pumpUntil(
      tester,
      () =>
          panel.evaluate().isNotEmpty &&
          tester.widget<PreferencesPanel>(panel).controller.snapshot != null,
      reason: 'initial Account preferences',
    );
    await tester.pumpAndSettle();
    expect(accountRequests(), 2);
    final workspace = find.byType(ProfilePage);
    final workspaceState = tester.state(workspace);
    final owner = tester.widget<PreferencesPanel>(panel).controller;

    final scroll = find.descendant(
      of: workspace,
      matching: find.byType(Scrollable),
    );
    final modes = find.byType(SegmentedButton<ThemeMode>);
    final darkMode = find.descendant(of: modes, matching: find.text('Tối'));
    await revealScrollableControl(
      tester,
      darkMode,
      scrollable: scroll,
      delta: 250,
    );
    await tester.tap(darkMode);
    await pumpUntil(
      tester,
      () =>
          tester.widget<MaterialApp>(find.byType(MaterialApp)).themeMode ==
          ThemeMode.dark,
      reason: 'application theme change',
    );
    await tester.pumpAndSettle();
    expect(
      await harness.dependencies.appearancePreferences.loadThemeMode(),
      ThemeMode.dark,
    );
    expect(tester.state(workspace), same(workspaceState));
    final meetingEmail = find.widgetWithText(SwitchListTile, 'Email cuộc họp');
    await tester.scrollUntilVisible(meetingEmail, -250, scrollable: scroll);
    await tester.pump();
    expect(tester.widget<PreferencesPanel>(panel).controller, same(owner));
    expect(accountRequests(), 2);

    final logout = find.text('Đăng xuất');
    await revealScrollableControl(
      tester,
      logout,
      scrollable: scroll,
      delta: 250,
    );
    await tester.tap(logout);
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Đăng xuất'));
    await pumpUntil(
      tester,
      () => find.text('Đăng nhập hệ thống').evaluate().isNotEmpty,
      reason: 'sign-out destination',
    );
    expect(owner.current, isFalse);
    expect(owner.snapshot, isNull);
    expect(find.byType(AppShell), findsNothing);
    expect(
      tester.widget<MaterialApp>(find.byType(MaterialApp)).themeMode,
      ThemeMode.dark,
    );

    replacement = true;
    // Logout originated in the widget test zone. Keep login in that same
    // zone: awaiting it inside runAsync can strand the token-store queue.
    await tester.enterText(
      find.byType(TextFormField).at(0),
      'other@example.test',
    );
    await tester.enterText(find.byType(TextFormField).at(1), 'password');
    final login = find.widgetWithText(FilledButton, 'Đăng nhập');
    await tester.ensureVisible(login);
    await tester.pump();
    expect(login.hitTestable(), findsOneWidget);
    await tester.tap(login);
    await pumpUntil(
      tester,
      () =>
          harness.api.signedIn &&
          find.byType(NavigationBar).evaluate().isNotEmpty,
      reason: 'replacement authenticated shell',
    );
    expect(
      harness.api.sessionState.identity?.userId.value,
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    );
    expect(
      client.requests.where(
        (request) => request.url.path.endsWith('/auth/login'),
      ),
      hasLength(1),
    );
    expect(
      tester.widget<MaterialApp>(find.byType(MaterialApp)).themeMode,
      ThemeMode.dark,
    );
    expect(accountRequests(), 2);
    await tester.tap(find.text('Tài khoản'));
    await pumpUntil(
      tester,
      () =>
          find.text('Other User').evaluate().isNotEmpty &&
          panel.evaluate().isNotEmpty &&
          tester.widget<PreferencesPanel>(panel).controller.snapshot != null,
      reason: 'fresh Account resources for the replacement identity',
    );
    expect(
      tester.widget<PreferencesPanel>(panel).controller,
      isNot(same(owner)),
    );
    expect(accountRequests(), 4);
    expect(find.text('Test User'), findsNothing);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('a fresh authenticated shell is created after logout and login', (
    tester,
  ) async {
    final credentials = InMemoryCredentialStorage();
    await _writeRefreshCredential(credentials, 'refresh-0');
    final harness = _Harness.create(_authClient(), credentials);

    await tester.pumpWidget(
      MeetingAssistantApp(dependencies: harness.dependencies),
    );
    await pumpUntil(
      tester,
      () =>
          harness.api.sessionState.isAuthenticated &&
          find.text('Tổng quan').evaluate().isNotEmpty,
      reason: 'startup restoration to reach the authenticated shell',
    );
    tester
        .widget<NavigationRail>(find.byType(NavigationRail))
        .onDestinationSelected!(3);
    await pumpUntil(
      tester,
      () =>
          find.byType(NavigationRail).evaluate().isNotEmpty &&
          tester
                  .widget<NavigationRail>(find.byType(NavigationRail))
                  .selectedIndex ==
              3,
      reason: 'the selected navigation destination to update',
    );
    expect(
      tester.widget<NavigationRail>(find.byType(NavigationRail)).selectedIndex,
      3,
    );

    await tester.runAsync(() => harness.api.signOut());
    await pumpUntil(
      tester,
      () =>
          harness.api.sessionState.phase == AuthSessionPhase.unauthenticated &&
          find.text('Đăng nhập hệ thống').evaluate().isNotEmpty,
      reason: 'logout to return to the login screen',
    );
    expect(find.text('Đăng nhập hệ thống'), findsOneWidget);

    await tester.runAsync(
      () => harness.api.signIn('user@example.test', 'password'),
    );
    await pumpUntil(
      tester,
      () =>
          harness.api.sessionState.isAuthenticated &&
          find.text('Tổng quan').evaluate().isNotEmpty &&
          tester
                  .widget<NavigationRail>(find.byType(NavigationRail))
                  .selectedIndex ==
              0,
      reason: 'a fresh authenticated shell to render after sign-in',
    );

    expect(find.text('Tổng quan'), findsOneWidget);
    expect(
      tester.widget<NavigationRail>(find.byType(NavigationRail)).selectedIndex,
      0,
    );
    expect(find.text('Đăng nhập hệ thống'), findsNothing);
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
  int identityFailures = 0,
  Map<String, dynamic> Function()? identityProvider,
  int? loginStatus,
  int? logoutStatus,
  Completer<void>? identityRequested,
  Completer<http.StreamedResponse>? identityResponse,
  Completer<void>? logoutRequested,
  Completer<http.StreamedResponse>? logoutResponse,
}) {
  return RecordingHttpClient((request) async {
    final path = request.url.path;
    expect(request.headers['X-Auth-Transport'], 'mobile');
    if (path.endsWith('/auth/refresh')) {
      if (refreshStatus != null) {
        if (refreshStatus == 429) {
          return streamedResponse(
            refreshStatus,
            body: utf8.encode(
              jsonEncode(
                errorEnvelope('RATE_LIMIT_EXCEEDED', 'Try again later.'),
              ),
            ),
            headers: const <String, String>{
              'content-type': 'application/json',
              'retry-after': '30',
            },
          );
        }
        return jsonResponse(
          refreshStatus,
          errorEnvelope('RATE_LIMIT_EXCEEDED', 'Try again later.'),
        );
      }
      expect(request.headers['Authorization'], 'Bearer refresh-0');
      return jsonResponse(
        200,
        successEnvelope(_tokens('access-1', 'refresh-1')),
      );
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
      if (identityFailures > 0) {
        identityFailures--;
        return jsonResponse(
          503,
          errorEnvelope('SERVICE_UNAVAILABLE', 'Try again later.'),
        );
      }
      return jsonResponse(
        200,
        successEnvelope(identityProvider?.call() ?? _identity()),
      );
    }
    if (path.endsWith('/auth/login')) {
      expect(request.headers['Authorization'], isNull);
      if (loginStatus != null) {
        return jsonResponse(
          loginStatus,
          errorEnvelope(
            loginStatus == 401 ? 'AUTH_REQUIRED' : 'SERVICE_UNAVAILABLE',
            'Authentication failed.',
          ),
        );
      }
      return jsonResponse(
        200,
        successEnvelope(_tokens('access-1', 'refresh-1')),
      );
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
      if (logoutStatus != null) {
        return jsonResponse(
          logoutStatus,
          errorEnvelope('SERVICE_UNAVAILABLE', 'Logout unavailable.'),
        );
      }
      return jsonResponse(200, successEnvelope(null));
    }
    if (path.endsWith('/me/profile')) {
      final identity = identityProvider?.call() ?? _identity();
      return streamedResponse(
        200,
        body: utf8.encode(
          jsonEncode(
            successEnvelope({
              'id': identity['userId'],
              'email': identity['email'],
              'displayName': identity['displayName'],
              'globalRole': identity['globalRole'],
              'accountStatus': identity['accountStatus'],
              'primaryOrgUnitId': identity['primaryOrgUnitId'],
            }),
          ),
        ),
        headers: {'content-type': 'application/json', 'etag': '"v1"'},
      );
    }
    if (path.endsWith('/me/preferences')) {
      return jsonResponse(
        200,
        successEnvelope({
          'timezone': null,
          'locale': null,
          'meetingEmailEnabled': true,
          'actionItemEmailEnabled': true,
        }),
      );
    }
    return jsonResponse(200, successEnvelope(<String, dynamic>{}));
  });
}

Map<String, dynamic> _tokens(String access, String refresh) =>
    <String, dynamic>{
      'accessToken': 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.$access',
      'refreshToken': refresh,
      'tokenType': 'Bearer',
      'expiresIn': 600,
    };

String _accessToken(String access) =>
    'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.$access';

Map<String, dynamic> _identity({
  String userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  String email = 'user@example.test',
  String displayName = 'Test User',
  String sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
}) => <String, dynamic>{
  'userId': userId,
  'email': email,
  'displayName': displayName,
  'globalRole': 'EMPLOYEE',
  'accountStatus': 'ACTIVE',
  'primaryOrgUnitId': null,
  'directoryManagementScope': <String, dynamic>{
    'allUnits': false,
    'unitIds': <String>[],
  },
  'session': <String, dynamic>{
    'id': sessionId,
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

  @override
  Future<void> confirmDurable() async {}
}

class _FailingDeleteStorage extends InMemoryCredentialStorage {
  bool failNextScopedDelete = true;

  @override
  Future<void> delete({required String key}) {
    if (failNextScopedDelete && key.startsWith('sme.mobile.token.v1.')) {
      failNextScopedDelete = false;
      return Future<void>.error(StateError('private storage details'));
    }
    return super.delete(key: key);
  }
}
