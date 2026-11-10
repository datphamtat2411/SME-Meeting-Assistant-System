import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'core/api_client.dart';
import 'core/app_theme.dart';
import 'features/auth/auth_page.dart';
import 'features/dashboard/dashboard_page.dart';
import 'features/meetings/meetings_page.dart';
import 'features/action_items/action_items_page.dart';
import 'features/assistant/assistant_page.dart';
import 'features/profile/profile_page.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const MeetingAssistantApp());
}

class MeetingAssistantApp extends StatefulWidget {
  const MeetingAssistantApp({super.key});

  @override
  State<MeetingAssistantApp> createState() => _MeetingAssistantAppState();
}

class _MeetingAssistantAppState extends State<MeetingAssistantApp> {
  final ApiClient api = ApiClient();
  ThemeMode mode = ThemeMode.system;

  @override
  void initState() {
    super.initState();
    api.initialize();
    _loadAppearance();
  }

  Future<void> _loadAppearance() async {
    final prefs = await SharedPreferences.getInstance();
    if (!mounted) return;
    setState(() {
      mode = switch (prefs.getString('theme')) {
        'dark' => ThemeMode.dark,
        'light' => ThemeMode.light,
        _ => ThemeMode.system,
      };
    });
  }

  Future<void> changeTheme(ThemeMode next) async {
    setState(() => mode = next);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('theme', next.name);
  }

  @override
  void dispose() {
    api.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'SME Meeting Assistant',
    debugShowCheckedModeBanner: false,
    theme: AppTheme.light(),
    darkTheme: AppTheme.dark(),
    themeMode: mode,
    home: AnimatedBuilder(
      animation: api,
      builder: (_, __) {
        if (!api.ready) return const Scaffold(
          body: Center(child: CircularProgressIndicator()));
        if (api.hasRecoverableSession) {
          return Scaffold(body: SafeArea(child: Center(
            child: Padding(padding: const EdgeInsets.all(24),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 420),
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  const Icon(Icons.wifi_off_outlined, size: 46),
                  const SizedBox(height: 16),
                  const Text('Không thể khôi phục phiên đăng nhập',
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 19, fontWeight: FontWeight.w700)),
                  const SizedBox(height: 9),
                  Text(api.sessionRestoreError ?? 'Không kết nối được với máy chủ.',
                    textAlign: TextAlign.center),
                  const SizedBox(height: 16),
                  FilledButton.icon(onPressed: api.retrySessionRestore,
                    icon: const Icon(Icons.refresh),
                    label: const Text('Thử kết nối lại')),
                  TextButton(onPressed: api.discardLocalSession,
                    child: const Text('Sử dụng tài khoản khác')),
                ]),
              )),
          )));
        }
        if (!api.signedIn) return AuthPage(api: api);
        return AppShell(api: api, themeMode: mode, onThemeChanged: changeTheme);
      },
    ),
  );
}

class AppShell extends StatefulWidget {
  final ApiClient api;
  final ThemeMode themeMode;
  final ValueChanged<ThemeMode> onThemeChanged;
  const AppShell({super.key, required this.api, required this.themeMode,
    required this.onThemeChanged});

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  int index = 0;

  @override
  Widget build(BuildContext context) {
    final destinations = <NavigationDestination>[
      const NavigationDestination(icon: Icon(Icons.space_dashboard_outlined),
        selectedIcon: Icon(Icons.space_dashboard), label: 'Tổng quan'),
      const NavigationDestination(icon: Icon(Icons.video_camera_front_outlined),
        selectedIcon: Icon(Icons.video_camera_front), label: 'Cuộc họp'),
      const NavigationDestination(icon: Icon(Icons.checklist_rtl_outlined),
        selectedIcon: Icon(Icons.checklist_rtl), label: 'Công việc'),
      const NavigationDestination(icon: Icon(Icons.smart_toy_outlined),
        selectedIcon: Icon(Icons.smart_toy), label: 'Trợ lý AI'),
      const NavigationDestination(icon: Icon(Icons.person_outline),
        selectedIcon: Icon(Icons.person), label: 'Tài khoản'),
    ];
    final pages = <Widget>[
      DashboardPage(api: widget.api, openMeetings: () => setState(() => index = 1),
        openActions: () => setState(() => index = 2)),
      MeetingsPage(api: widget.api),
      ActionItemsPage(api: widget.api),
      AssistantPage(api: widget.api),
      ProfilePage(api: widget.api, themeMode: widget.themeMode,
        onThemeChanged: widget.onThemeChanged),
    ];
    final wide = MediaQuery.sizeOf(context).width >= 700;
    return Scaffold(
      body: SafeArea(
        child: Row(children: [
          if (wide) NavigationRail(
            extended: MediaQuery.sizeOf(context).width > 1000,
            selectedIndex: index,
            onDestinationSelected: (i) => setState(() => index = i),
            leading: const Padding(
              padding: EdgeInsets.symmetric(vertical: 20),
              child: Icon(Icons.graphic_eq_rounded, size: 32)),
            destinations: destinations.map((item) =>
              NavigationRailDestination(
                icon: item.icon, selectedIcon: item.selectedIcon,
                label: Text(item.label))).toList(),
          ),
          Expanded(child: IndexedStack(index: index, children: pages)),
        ]),
      ),
      bottomNavigationBar: wide ? null : NavigationBar(
        selectedIndex: index,
        onDestinationSelected: (i) => setState(() => index = i),
        destinations: destinations,
      ),
    );
  }
}
