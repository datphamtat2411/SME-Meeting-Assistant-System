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
  bool _sessionInitializationFailed = false;

  @override
  void initState() {
    super.initState();
    _initializeSession();
    appearance.initialize();
  }

  Future<void> _initializeSession() async {
    try {
      await api.initialize();
    } catch (_) {
      if (mounted) {
        setState(() => _sessionInitializationFailed = true);
      }
    }
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
      builder: (_, __) {
        if (_sessionInitializationFailed) {
          return const StartupFailureView();
        }
        if (!api.ready) {
          return const StartupProgressView();
        }
        if (api.hasRecoverableSession) {
          return SessionRestoreFailureView(api: api);
        }
        if (!api.signedIn) return AuthPage(api: api);
        return AppShell(
          api: api,
          themeMode: appearance.mode,
          onThemeChanged: changeTheme,
        );
      },
    ),
  );
}

class StartupProgressView extends StatelessWidget {
  const StartupProgressView({super.key});

  @override
  Widget build(BuildContext context) => const Scaffold(
    body: Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          CircularProgressIndicator(),
          SizedBox(height: 16),
          Text('Đang khởi tạo ứng dụng'),
          SizedBox(height: 6),
          Text('Đang khôi phục phiên đăng nhập...'),
        ],
      ),
    ),
  );
}

class StartupFailureView extends StatelessWidget {
  const StartupFailureView({super.key});

  @override
  Widget build(BuildContext context) => const Scaffold(
    body: Center(
      child: Padding(
        padding: EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.error_outline, size: 48),
            SizedBox(height: 16),
            Text(
              'Không thể khởi tạo ứng dụng',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700),
            ),
            SizedBox(height: 10),
            Text(
              'Vui lòng đóng ứng dụng và thử lại.',
              textAlign: TextAlign.center,
            ),
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
                  'Không thể khôi phục phiên đăng nhập',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 19, fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 9),
                Text(
                  api.sessionRestoreError ?? 'Không kết nối được với máy chủ.',
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 16),
                FilledButton.icon(
                  onPressed: api.retrySessionRestore,
                  icon: const Icon(Icons.refresh),
                  label: const Text('Thử kết nối lại'),
                ),
                TextButton(
                  onPressed: api.discardLocalSession,
                  child: const Text('Sử dụng tài khoản khác'),
                ),
              ],
            ),
          ),
        ),
      ),
    ),
  );
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
