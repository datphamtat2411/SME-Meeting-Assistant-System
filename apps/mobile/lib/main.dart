import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';

import 'core/api_client.dart';
import 'core/app_config.dart';
import 'core/app_dependencies.dart';
import 'core/app_theme.dart';
import 'core/appearance_controller.dart';
import 'features/auth/account_forms.dart';
import 'features/auth/account_flow.dart';
import 'features/auth/account_link.dart';
import 'features/auth/account_link_coordinator.dart';
import 'features/auth/account_link_views.dart';
import 'features/auth/auth_form_widgets.dart';
import 'features/auth/auth_page.dart';
import 'features/auth/credential_workflow.dart';
import 'features/dashboard/dashboard_page.dart';
import 'features/meetings/meetings_page.dart';
import 'features/meetings/meeting_detail_page.dart';
import 'features/results/results_panel.dart';
import 'features/action_items/action_items_page.dart';
import 'features/action_items/action_item_collection.dart';
import 'features/assistant/assistant_page.dart';
import 'features/profile/profile_page.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  try {
    final baseUri = AppConfig.resolve();
    final AccountLinkParser parser;
    try {
      parser = AccountLinkParser(AccountLinkParser.configuredHost);
    } on FormatException {
      throw const AppConfigException('ACCOUNT_LINK_HOST không hợp lệ.');
    }
    final dependencies = AppDependencies.create(apiBaseUri: baseUri);
    runApp(
      MeetingAssistantApp(
        dependencies: dependencies,
        accountLinkParser: parser,
        receiveNativeAccountLinks: Platform.isAndroid,
      ),
    );
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
                    'Hãy kiểm tra cấu hình và khởi động lại ứng dụng.',
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

  /// An application host may supply the owner when it also owns capability
  /// dispatch. Otherwise this app creates and disposes its own owner.
  final CredentialWorkflowOwner? credentialWorkflowOwner;
  final AccountLinkParser? accountLinkParser;
  final bool receiveNativeAccountLinks;

  const MeetingAssistantApp({
    super.key,
    required this.dependencies,
    this.credentialWorkflowOwner,
    this.accountLinkParser,
    this.receiveNativeAccountLinks = false,
  });

  @override
  State<MeetingAssistantApp> createState() => _MeetingAssistantAppState();
}

class _MeetingAssistantAppState extends State<MeetingAssistantApp> {
  GlobalKey<NavigatorState> _navigatorKey = GlobalKey<NavigatorState>();
  AuthenticatedSessionScope? _navigationScope;
  bool _openingRecording = false;
  bool _pasteOpen = false;
  bool _autoOpenInitial = false;
  bool _entryScheduled = false;
  int _publicAuthRevision = 0;
  AccountLinkTicket? _activeLink;
  AccountLinkReceiver? _linkReceiver;
  final _retryDeadlines = AccountRetryDeadlines();
  late final _accountLinks = AccountLinkCoordinator(
    widget.accountLinkParser ??
        AccountLinkParser(AccountLinkParser.configuredHost),
  );
  late final ApiClient api = widget.dependencies.api;
  late final bool _ownsCredentialWorkflows =
      widget.credentialWorkflowOwner == null;
  late final CredentialWorkflowOwner _credentialWorkflows =
      widget.credentialWorkflowOwner ?? CredentialWorkflowOwner(api);
  late final AppearanceController appearance = AppearanceController(
    preferences: widget.dependencies.appearancePreferences,
  );
  late final Listenable shellState = Listenable.merge(<Listenable>[
    api,
    appearance,
  ]);
  late final Listenable applicationState = Listenable.merge(<Listenable>[
    api,
    appearance,
    widget.dependencies.recording,
    widget.dependencies.submissions,
    _credentialWorkflows,
    _accountLinks,
    _retryDeadlines,
  ]);

  @override
  void initState() {
    super.initState();
    final suppliedOwner = widget.credentialWorkflowOwner;
    if (suppliedOwner != null && !identical(suppliedOwner.api, api)) {
      throw ArgumentError(
        'The credential workflow owner must use this app ApiClient.',
      );
    }
    api.addListener(_scheduleInitialEntry);
    _credentialWorkflows.addListener(_observeCredentialOutcome);
    if (widget.receiveNativeAccountLinks) {
      _linkReceiver = AccountLinkReceiver(
        onLink: (raw, initial) {
          final result = _accountLinks.receive(raw);
          if (result == AccountLinkReception.accepted) {
            _autoOpenInitial = initial && !api.signedIn;
            _scheduleInitialEntry();
          }
        },
        onFailure: _accountLinks.reportDeliveryFailure,
      )..start();
    }
    unawaited(api.initialize());
    appearance.initialize();
  }

  void changeTheme(ThemeMode next) => appearance.setMode(next);

  @override
  void dispose() {
    _linkReceiver?.dispose();
    api.removeListener(_scheduleInitialEntry);
    _credentialWorkflows.removeListener(_observeCredentialOutcome);
    _accountLinks.dispose();
    _retryDeadlines.dispose();
    if (_ownsCredentialWorkflows) _credentialWorkflows.dispose();
    appearance.dispose();
    widget.dependencies.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: shellState,
    builder: (context, _) {
      final scope = api.authenticatedSessionScope;
      if (scope != _navigationScope) {
        // A protected route stack belongs to exactly one authenticated epoch.
        // Replacing only the home widget leaves pushed routes and dialogs alive.
        final previousScope = _navigationScope;
        final previousLink = _activeLink;
        _activeLink = null;
        _pasteOpen = false;
        _navigationScope = scope;
        _navigatorKey = GlobalKey<NavigatorState>();
        if (previousScope != null || previousLink != null) {
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (!mounted) return;
            if (previousLink != null) _accountLinks.finish(previousLink);
            if (_accountLinks.hasPending) {
              _accountLinks.discardPending(
                notice: 'Phiên đăng nhập đã thay đổi. Hãy mở lại email.',
              );
            }
          });
        }
        _openingRecording = false;
      }
      return MaterialApp(
        key: ValueKey(scope),
        title: 'SME Meeting Assistant',
        debugShowCheckedModeBanner: false,
        theme: AppTheme.light(),
        darkTheme: AppTheme.dark(),
        themeMode: appearance.mode,
        navigatorKey: _navigatorKey,
        builder: (context, child) => AnimatedBuilder(
          animation: applicationState,
          builder: (context, _) => _recordingOverlay(child),
        ),
        home: AnimatedBuilder(
          animation: applicationState,
          builder: (_, __) => _sessionHome(),
        ),
      );
    },
  );

  Widget _recordingOverlay(Widget? child) {
    final capture = widget.dependencies.recording.state;
    final scope = capture.sessionScope;
    final meetingId = capture.meetingId;
    return Column(
      children: [
        if (capture.isCapturing &&
            scope != null &&
            meetingId != null &&
            api.isCurrentAuthenticatedSession(scope))
          SafeArea(
            bottom: false,
            child: _ActiveRecordingBanner(
              key: ValueKey((scope, meetingId)),
              dependencies: widget.dependencies,
              meetingId: meetingId,
              elapsed: capture.elapsed,
              onOpen: () => _openRecording(meetingId, scope),
            ),
          ),
        if (_accountLinks.hasPending || _accountLinks.notice != null)
          _accountLinkBanner(),
        Expanded(child: child ?? const SizedBox.shrink()),
      ],
    );
  }

  Future<void> _openRecording(
    String meetingId,
    AuthenticatedSessionScope scope,
  ) async {
    if (_openingRecording || !api.isCurrentAuthenticatedSession(scope)) {
      return;
    }
    final capture = widget.dependencies.recording.state;
    if (!capture.isCapturing ||
        capture.meetingId != meetingId ||
        capture.sessionScope != scope) {
      return;
    }
    final navigatorKey = _navigatorKey;
    final navigator = navigatorKey.currentState;
    if (navigator == null) return;
    _openingRecording = true;
    try {
      await navigator.push<void>(
        MaterialPageRoute<void>(
          builder: (_) => MeetingDetailPage(
            dependencies: widget.dependencies,
            meetingId: meetingId,
            openRecording: true,
          ),
        ),
      );
    } finally {
      if (identical(_navigatorKey, navigatorKey)) {
        _openingRecording = false;
      }
    }
  }

  bool get _sessionReady => switch (api.sessionState.phase) {
    AuthSessionPhase.authenticated ||
    AuthSessionPhase.unauthenticated ||
    AuthSessionPhase.reauthenticationRequired => true,
    _ => false,
  };

  bool get _meetingWorkActive =>
      widget.dependencies.recording.hasActiveWork ||
      widget.dependencies.submissions.hasActiveWork;

  bool get _canOpenAccountLink =>
      _sessionReady &&
      !_meetingWorkActive &&
      !_pasteOpen &&
      !_accountLinks.hasActive &&
      !_credentialWorkflows.hasInFlight &&
      !_retryDeadlines.hasActiveSubmission &&
      _credentialWorkflows.outcome == null;

  void _observeCredentialOutcome() {
    final ticket = _activeLink;
    if (ticket != null && _credentialWorkflows.outcome != null) {
      _accountLinks.markTerminal(ticket);
    }
  }

  void _scheduleInitialEntry() {
    if (!_autoOpenInitial || _entryScheduled || !_sessionReady) return;
    _entryScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _entryScheduled = false;
      if (!mounted || !_autoOpenInitial) return;
      _autoOpenInitial = false;
      if (!api.signedIn && _canOpenAccountLink) {
        unawaited(_continueAccountLink());
      }
    });
  }

  Widget _accountLinkBanner() {
    final pending = _accountLinks.hasPending;
    final message = !pending
        ? _accountLinks.notice!
        : _meetingWorkActive
        ? 'Hãy hoàn tất ghi âm, nhập hoặc gửi âm thanh trước khi mở liên kết.'
        : _accountLinks.hasActive
        ? 'Có liên kết khác. Hãy hoàn tất hoặc hủy biểu mẫu hiện tại trước.'
        : !_sessionReady
        ? 'Hãy hoàn tất xác minh phiên đăng nhập trước khi tiếp tục.'
        : api.signedIn
        ? 'Liên kết có thể thuộc tài khoản khác. Phiên hiện tại được giữ '
              'cho đến khi cần xác minh bảo mật.'
        : 'Đã nhận liên kết tài khoản. Hãy tiếp tục khi bạn sẵn sàng.';
    return Material(
      child: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 6, 12, 4),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  pending && _accountLinks.notice != null
                      ? '${_accountLinks.notice}\n$message'
                      : message,
                ),
              ),
              if (pending)
                TextButton(
                  onPressed: _canOpenAccountLink ? _continueAccountLink : null,
                  child: const Text('Tiếp tục'),
                ),
              TextButton(
                onPressed: pending
                    ? () {
                        _autoOpenInitial = false;
                        _accountLinks.discardPending();
                      }
                    : _accountLinks.clearNotice,
                child: Text(pending ? 'Bỏ qua' : 'Đóng'),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _openAccountLinkPaste() async {
    if (!_canOpenAccountLink) {
      _accountLinks.reportDeliveryFailure();
      return;
    }
    final key = _navigatorKey;
    final navigator = key.currentState;
    if (navigator == null) return;
    setState(() => _pasteOpen = true);
    bool? accepted;
    try {
      accepted = await navigator.push<bool>(
        MaterialPageRoute<bool>(
          builder: (_) => AccountLinkPasteView(
            accept: (raw) {
              final result = _accountLinks.receive(raw, pasted: true);
              if (result == AccountLinkReception.rejected) {
                final message = _accountLinks.notice;
                _accountLinks.clearNotice();
                return message ?? 'Liên kết không hợp lệ.';
              }
              return null;
            },
          ),
        ),
      );
    } finally {
      if (mounted && identical(key, _navigatorKey)) {
        setState(() => _pasteOpen = false);
      }
    }
    if (mounted &&
        identical(key, _navigatorKey) &&
        accepted == true &&
        !api.signedIn &&
        _canOpenAccountLink) {
      await _continueAccountLink();
    }
  }

  Future<void> _continueAccountLink() async {
    if (!_canOpenAccountLink) return;
    final key = _navigatorKey;
    final navigator = key.currentState;
    if (navigator == null) return;
    final scope = api.authenticatedSessionScope;
    final ticket = _accountLinks.claim();
    if (ticket == null) return;
    setState(() => _activeLink = ticket);
    AccountLinkExit? exit;
    try {
      exit = await navigator.push<AccountLinkExit>(
        MaterialPageRoute<AccountLinkExit>(
          builder: (_) => AccountLinkEntryView(
            ticket: ticket,
            api: api,
            owner: _credentialWorkflows,
            retryDeadlines: _retryDeadlines,
            canDispatch: () =>
                mounted &&
                identical(key, _navigatorKey) &&
                identical(ticket, _activeLink) &&
                _sessionReady &&
                api.authenticatedSessionScope == scope &&
                !_meetingWorkActive &&
                !_credentialWorkflows.hasInFlight &&
                !_retryDeadlines.hasActiveSubmission,
          ),
        ),
      );
    } finally {
      if (mounted && identical(ticket, _activeLink)) {
        setState(() {
          _activeLink = null;
          if (exit == AccountLinkExit.signIn &&
              identical(key, _navigatorKey) &&
              _sessionReady &&
              !api.signedIn) {
            // Terminal continuation is not a return to an old recovery form.
            _publicAuthRevision++;
          }
        });
        _accountLinks.finish(ticket);
      }
    }
  }

  Widget _publicAuthPage() => AuthPage(
    key: ValueKey(_publicAuthRevision),
    api: api,
    credentialWorkflows: _credentialWorkflows,
    retryDeadlines: _retryDeadlines,
    onOpenLink: _openAccountLinkPaste,
    showOutcome: _activeLink == null,
  );

  Widget _sessionHome() {
    final session = api.sessionState;
    final outcome = _credentialWorkflows.outcome;
    if (session.isAuthenticated && outcome != null && _activeLink == null) {
      return AuthLayout(
        child: CredentialOutcomeView(
          outcome: outcome,
          authenticated: true,
          onContinue: _credentialWorkflows.dismiss,
        ),
      );
    }
    return switch (session.phase) {
      AuthSessionPhase.initializing => const StartupProgressView(),
      AuthSessionPhase.verifyingIdentity || AuthSessionPhase.signingIn =>
        api.sessionCoordinator.isInteractiveSignIn
            ? _publicAuthPage()
            : const StartupProgressView(message: 'Đang xác minh danh tính...'),
      AuthSessionPhase.signingOut => const StartupProgressView(
        message: 'Đang đăng xuất...',
      ),
      AuthSessionPhase.unauthenticated ||
      AuthSessionPhase.reauthenticationRequired => _publicAuthPage(),
      AuthSessionPhase.recoverableFailure => _recoverableSessionView(session),
      AuthSessionPhase.authenticated => AppShell(
        key: ValueKey(api.authenticatedSessionScope),
        dependencies: widget.dependencies,
        api: api,
        themeMode: appearance.mode,
        onThemeChanged: changeTheme,
        onOpenAccountLink: _openAccountLinkPaste,
      ),
    };
  }

  Widget _recoverableSessionView(AuthSessionState session) {
    if (session.failure?.category == AuthFailureCategory.credentialStorage) {
      final cleanupCode = session.failure?.machineCode;
      final cleanupFailed =
          cleanupCode == 'CREDENTIAL_STORAGE_DELETE_FAILED' ||
          cleanupCode?.startsWith('LOGOUT_') == true;
      return StartupFailureView(
        title: cleanupFailed
            ? 'Không thể xác nhận xóa phiên bảo mật'
            : 'Không thể truy cập phiên bảo mật',
        message: session.failure?.message ?? 'Không thể truy cập thông tin đăng nhập được bảo vệ. Vui lòng thử lại.',
        onRetry: session.canRetryCredentialStorage
            ? api.retrySessionRestore
            : null,
        retryLabel: cleanupFailed
            ? 'Thử xóa phiên đã lưu lại'
            : 'Thử truy cập lại',
      );
    }
    if (session.canRetrySessionRestore ||
        session.canRetryIdentityVerification) {
      final outcome = _credentialWorkflows.outcome;
      return SessionRestoreFailureView(
        api: api,
        mutationNotice: switch (outcome?.kind) {
          CredentialOutcomeKind.completed => 'Mật khẩu đã được cập nhật. Không gửi lại yêu cầu này. Vùng bảo vệ đang khóa cho đến khi máy chủ xác minh lại phiên đăng nhập hiện tại.',
          CredentialOutcomeKind.uncertain => 'Yêu cầu đặt lại mật khẩu có thể đã được xử lý. Không gửi lại yêu cầu này; vùng bảo vệ vẫn khóa cho đến khi xác minh lại phiên hiện tại.',
          _ => null,
        },
      );
    }
    return _publicAuthPage();
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
  final String retryLabel;

  const StartupFailureView({
    super.key,
    this.title = 'Không thể khởi tạo ứng dụng',
    this.message = 'Vui lòng đóng ứng dụng và thử lại.',
    this.onRetry,
    this.retryLabel = 'Thử truy cập lại',
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
                label: Text(retryLabel),
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
  final String? mutationNotice;

  const SessionRestoreFailureView({
    super.key,
    required this.api,
    this.mutationNotice,
  });

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
                if (mutationNotice != null) ...[
                  const SizedBox(height: 12),
                  Text(mutationNotice!, textAlign: TextAlign.center),
                ],
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
  final AppDependencies dependencies;
  final ApiClient api;
  final ThemeMode themeMode;
  final ValueChanged<ThemeMode> onThemeChanged;
  final VoidCallback? onOpenAccountLink;
  const AppShell({
    super.key,
    required this.dependencies,
    required this.api,
    required this.themeMode,
    required this.onThemeChanged,
    this.onOpenAccountLink,
  });

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  int index = 0;
  ActionItemNavigationIntent? _actionNavigation;

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
        invalidation: widget.dependencies.actionItemInvalidation,
        active: index == 0,
        openMeetings: () => setState(() => index = 1),
        openActions: (destination) => setState(() {
          _actionNavigation = ActionItemNavigationIntent(destination);
          index = 2;
        }),
      ),
      MeetingsPage(dependencies: widget.dependencies),
      ActionItemsPage(
        dependencies: widget.dependencies,
        active: index == 2,
        navigationIntent: _actionNavigation,
        openMeeting: (context, meetingId) => Navigator.push<void>(
          context,
          MaterialPageRoute<void>(
            builder: (_) => MeetingDetailPage(
              dependencies: widget.dependencies,
              meetingId: meetingId,
              initialResultsSection: ResultsSection.actionItems,
            ),
          ),
        ),
      ),
      AssistantPage(dependencies: widget.dependencies, active: index == 3),
      ProfilePage(
        api: widget.api,
        themeMode: widget.themeMode,
        onThemeChanged: widget.onThemeChanged,
        onOpenAccountLink: widget.onOpenAccountLink,
      ),
    ];
    final wide = MediaQuery.sizeOf(context).width >= 700;
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
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

class _ActiveRecordingBanner extends StatefulWidget {
  const _ActiveRecordingBanner({
    super.key,
    required this.dependencies,
    required this.meetingId,
    required this.elapsed,
    required this.onOpen,
  });

  final AppDependencies dependencies;
  final String meetingId;
  final Duration elapsed;
  final VoidCallback onOpen;

  @override
  State<_ActiveRecordingBanner> createState() => _ActiveRecordingBannerState();
}

class _ActiveRecordingBannerState extends State<_ActiveRecordingBanner> {
  late final Future<String> _title = widget.dependencies.meetings
      .detail(widget.meetingId)
      .then((snapshot) => snapshot.meeting.title);

  @override
  Widget build(BuildContext context) => Material(
    color: Colors.red.withValues(alpha: 0.08),
    child: InkWell(
      onTap: widget.onOpen,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 10, 8, 10),
        child: Row(
          children: [
            const Icon(Icons.fiber_manual_record, color: Colors.red, size: 16),
            const SizedBox(width: 8),
            Expanded(
              child: FutureBuilder<String>(
                future: _title,
                builder: (context, snapshot) => Text(
                  'Đang ghi âm · ${widget.elapsed.toString().split('.').first}'
                  ' · ${snapshot.data ?? 'Cuộc họp hiện tại'}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ),
            TextButton(onPressed: widget.onOpen, child: const Text('Mở')),
          ],
        ),
      ),
    ),
  );
}
