import 'dart:async';

import 'package:flutter/material.dart';

import 'core/api_client.dart';
import 'core/app_config.dart';
import 'core/app_dependencies.dart';
import 'core/app_theme.dart';
import 'core/appearance_controller.dart';
import 'features/auth/auth_page.dart';
import 'features/dashboard/dashboard_page.dart';
import 'features/meetings/meetings_page.dart';
import 'features/action_items/action_items_page.dart';
import 'features/assistant/assistant_page.dart';
import 'features/profile/profile_page.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  try {
    final baseUri = AppConfig.resolve();
    final dependencies = AppDependencies.create(apiBaseUri: baseUri);
    runApp(MeetingAssistantApp(dependencies: dependencies));
  } on AppConfigException catch (error) {
    runApp(ConfigurationErrorApp(error: error));
  }
}

class ConfigurationErrorApp extends StatelessWidget {
  final AppConfigException error;

  const ConfigurationErrorApp({super.key, required this.error});

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'SME Meeting Assistant',
    debugShowCheckedModeBanner: false,
    theme: AppTheme.light(),
    home: Scaffold(
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 520),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.settings_outlined, size: 48),
                  const SizedBox(height: 16),
                  const Text(
                    'Cấu hình ứng dụng không hợp lệ',
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700),
                  ),
                  const SizedBox(height: 10),
                  Text(error.message, textAlign: TextAlign.center),
                  const SizedBox(height: 16),
                  const Text(
                    'Hãy kiểm tra API_BASE_URL và khởi động lại ứng dụng.',
                    textAlign: TextAlign.center,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

class MeetingAssistantApp extends StatefulWidget {
  final AppDependencies dependencies;

  const MeetingAssistantApp({super.key, required this.dependencies});

  @override
  State<MeetingAssistantApp> createState() => _MeetingAssistantAppState();
}

class _MeetingAssistantAppState extends State<MeetingAssistantApp> {
  late final ApiClient api = widget.dependencies.api;
  late final AppearanceController appearance = AppearanceController(
    preferences: widget.dependencies.appearancePreferences,
  );
  late final Listenable applicationState = Listenable.merge(<Listenable>[
    api,
    appearance,
  ]);

  @override
  void initState() {
    super.initState();
    unawaited(api.initialize());
    appearance.initialize();
  }

  void changeTheme(ThemeMode next) => appearance.setMode(next);

  @override
  void dispose() {
    appearance.dispose();
    widget.dependencies.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'SME Meeting Assistant',
    debugShowCheckedModeBanner: false,
    theme: AppTheme.light(),
    darkTheme: AppTheme.dark(),
    themeMode: appearance.mode,
    home: AnimatedBuilder(
      animation: applicationState,
      builder: (_, __) => _sessionHome(),
    ),
  );

  Widget _sessionHome() {
    final session = api.sessionState;
    return switch (session.phase) {
      AuthSessionPhase.initializing => const StartupProgressView(),
      AuthSessionPhase.verifyingIdentity => const StartupProgressView(
        message: 'Đang xác minh danh tính...',
      ),
      AuthSessionPhase.signingIn => const StartupProgressView(
        message: 'Đang đăng nhập...',
      ),
      AuthSessionPhase.signingOut => const StartupProgressView(
        message: 'Đang đăng xuất...',
      ),
      AuthSessionPhase.unauthenticated ||
      AuthSessionPhase.reauthenticationRequired => AuthPage(api: api),
      AuthSessionPhase.recoverableFailure => _recoverableSessionView(session),
      AuthSessionPhase.authenticated => AppShell(
        api: api,
        themeMode: appearance.mode,
        onThemeChanged: changeTheme,
      ),
    };
  }

  Widget _recoverableSessionView(AuthSessionState session) {
    if (session.failure?.category == AuthFailureCategory.credentialStorage) {
      return StartupFailureView(
        title: 'Không thể truy cập phiên bảo mật',
        message: session.failure?.message ?? 'Không thể truy cập thông tin đăng nhập được bảo vệ. Vui lòng thử lại.',
        onRetry: session.canRetryCredentialStorage
            ? api.retrySessionRestore
            : null,
      );
    }
    if (session.canRetrySessionRestore ||
        session.canRetryIdentityVerification) {
      return SessionRestoreFailureView(api: api);
    }
    return AuthPage(api: api);
  }
}

class StartupProgressView extends StatelessWidget {
  final String message;

  const StartupProgressView({
    super.key,
    this.message = 'Đang khôi phục phiên đăng nhập...',
  });

  @override
  Widget build(BuildContext context) => Scaffold(
    body: Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const CircularProgressIndicator(),
          const SizedBox(height: 16),
          const Text('Đang khởi tạo ứng dụng'),
          const SizedBox(height: 6),
          Text(message),
        ],
      ),
    ),
  );
}

class StartupFailureView extends StatelessWidget {
  final String title;
  final String message;
  final VoidCallback? onRetry;

  const StartupFailureView({
    super.key,
    this.title = 'Không thể khởi tạo ứng dụng',
    this.message = 'Vui lòng đóng ứng dụng và thử lại.',
    this.onRetry,
  });

  @override
  Widget build(BuildContext context) => Scaffold(
    body: Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, size: 48),
            const SizedBox(height: 16),
            Text(
              title,
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 10),
            Text(message, textAlign: TextAlign.center),
            if (onRetry != null) ...[
              const SizedBox(height: 16),
              FilledButton.icon(
                onPressed: onRetry,
                icon: const Icon(Icons.refresh),
                label: const Text('Thử truy cập lại'),
              ),
            ],
          ],
        ),
      ),
    ),
  );
}

class SessionRestoreFailureView extends StatelessWidget {
  final ApiClient api;

  const SessionRestoreFailureView({super.key, required this.api});

  @override
  Widget build(BuildContext context) => Scaffold(
    body: SafeArea(
      child: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.wifi_off_outlined, size: 46),
                const SizedBox(height: 16),
                const Text(
                  'Không thể tiếp tục phiên đăng nhập',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 19, fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 9),
                Text(
                  _recoveryMessage(api.sessionState),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 16),
                FilledButton.icon(
                  onPressed: () => _retry(context),
                  icon: const Icon(Icons.refresh),
                  label: Text(
                    api.sessionState.canRetryIdentityVerification
                        ? 'Thử xác minh lại'
                        : 'Thử kết nối lại',
                  ),
                ),
                TextButton(
                  onPressed: () => _discard(context),
                  child: const Text('Sử dụng tài khoản khác'),
                ),
              ],
            ),
          ),
        ),
      ),
    ),
  );

  Future<void> _retry(BuildContext context) async {
    try {
      if (api.sessionState.canRetryIdentityVerification) {
        await api.retryIdentityVerification();
      } else {
        await api.retrySessionRestore();
      }
    } catch (_) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(_recoveryMessage(api.sessionState))),
      );
    }
  }

  Future<void> _discard(BuildContext context) async {
    try {
      await api.discardLocalSession();
    } catch (_) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            api.sessionState.failure?.message ??
                'Không thể gỡ phiên đã lưu. Vui lòng thử lại.',
          ),
        ),
      );
    }
  }
}

String _recoveryMessage(AuthSessionState state) {
  final failure = state.failure;
  if (failure == null) return 'Không thể kết nối đến máy chủ.';
  if (failure.category != AuthFailureCategory.rateLimited) {
    if (state.canRetryIdentityVerification) {
      return 'Không thể xác minh danh tính với máy chủ. ${failure.message} Phiên bảo mật đã được giữ lại; hãy thử xác minh lại.';
    }
    return failure.message;
  }

  final retryNotBefore = state.retryNotBefore;
  final remaining = retryNotBefore?.difference(DateTime.now());
  if (remaining != null && remaining > Duration.zero) {
    final seconds =
        remaining.inSeconds + (remaining.inMilliseconds % 1000 == 0 ? 0 : 1);
    return '${failure.message} Vui lòng chờ ít nhất $seconds giây trước khi thử lại.';
  }
  final retryAfter = failure.retryAfter;
  return retryAfter == null
      ? failure.message
      : '${failure.message} Thời hạn do máy chủ cung cấp: $retryAfter.';
}

class AppShell extends StatefulWidget {
  final ApiClient api;
  final ThemeMode themeMode;
  final ValueChanged<ThemeMode> onThemeChanged;
  const AppShell({
    super.key,
    required this.api,
    required this.themeMode,
    required this.onThemeChanged,
  });

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  int index = 0;

  @override
  Widget build(BuildContext context) {
    final destinations = <NavigationDestination>[
      const NavigationDestination(
        icon: Icon(Icons.space_dashboard_outlined),
        selectedIcon: Icon(Icons.space_dashboard),
        label: 'Tổng quan',
      ),
      const NavigationDestination(
        icon: Icon(Icons.video_camera_front_outlined),
        selectedIcon: Icon(Icons.video_camera_front),
        label: 'Cuộc họp',
      ),
      const NavigationDestination(
        icon: Icon(Icons.checklist_rtl_outlined),
        selectedIcon: Icon(Icons.checklist_rtl),
        label: 'Công việc',
      ),
      const NavigationDestination(
        icon: Icon(Icons.smart_toy_outlined),
        selectedIcon: Icon(Icons.smart_toy),
        label: 'Trợ lý AI',
      ),
      const NavigationDestination(
        icon: Icon(Icons.person_outline),
        selectedIcon: Icon(Icons.person),
        label: 'Tài khoản',
      ),
    ];
    final pages = <Widget>[
      DashboardPage(
        api: widget.api,
        openMeetings: () => setState(() => index = 1),
        openActions: () => setState(() => index = 2),
      ),
      MeetingsPage(api: widget.api),
      ActionItemsPage(api: widget.api),
      AssistantPage(api: widget.api),
      ProfilePage(
        api: widget.api,
        themeMode: widget.themeMode,
        onThemeChanged: widget.onThemeChanged,
      ),
    ];
    final wide = MediaQuery.sizeOf(context).width >= 700;
    return Scaffold(
      body: SafeArea(
        child: Row(
          children: [
            if (wide)
              NavigationRail(
                extended: MediaQuery.sizeOf(context).width > 1000,
                selectedIndex: index,
                onDestinationSelected: (i) => setState(() => index = i),
                leading: const Padding(
                  padding: EdgeInsets.symmetric(vertical: 20),
                  child: Icon(Icons.graphic_eq_rounded, size: 32),
                ),
                destinations: destinations
                    .map(
                      (item) => NavigationRailDestination(
                        icon: item.icon,
                        selectedIcon: item.selectedIcon,
                        label: Text(item.label),
                      ),
                    )
                    .toList(),
              ),
            Expanded(
              child: IndexedStack(index: index, children: pages),
            ),
          ],
        ),
      ),
      bottomNavigationBar: wide
          ? null
          : NavigationBar(
              selectedIndex: index,
              onDestinationSelected: (i) => setState(() => index = i),
              destinations: destinations,
            ),
    );
  }
}
