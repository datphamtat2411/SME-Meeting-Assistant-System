import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import '../../core/appearance_controller.dart';
import '../../core/command_actions.dart';
import '../../core/widgets.dart';
import 'account_resource_view.dart';
import 'appearance_panel.dart';
import 'preferences_panel.dart';
import 'profile_controllers.dart';
import 'profile_edit_dialog.dart';
import 'profile_models.dart';
import 'profile_repository.dart';

class ProfilePage extends StatefulWidget {
  const ProfilePage({
    super.key,
    required this.api,
    required this.repository,
    required this.appearance,
    this.active = true,
    this.onOpenAccountLink,
  });
  final ApiClient api;
  final ProfileRepository repository;
  final AppearanceController appearance;
  final bool active;
  final VoidCallback? onOpenAccountLink;
  @override
  State<ProfilePage> createState() => _ProfilePageState();
}

class _ProfilePageState extends State<ProfilePage> with WidgetsBindingObserver {
  late final ProfileController controller;
  late final PreferencesController preferences;
  bool _foreground = true;
  bool _routeVisible = false;
  bool _refreshRequested = false;
  bool _refreshScheduled = false;
  bool _confirmingLogout = false;

  @override
  void initState() {
    super.initState();
    controller = ProfileController(widget.repository);
    preferences = PreferencesController(widget.repository);
    final lifecycle = WidgetsBinding.instance.lifecycleState;
    _foreground = lifecycle == null || lifecycle == AppLifecycleState.resumed;
    WidgetsBinding.instance.addObserver(this);
    _refreshRequested = widget.active;
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _routeVisible = ModalRoute.isCurrentOf(context) ?? true;
    _scheduleRefresh();
  }

  @override
  void didUpdateWidget(covariant ProfilePage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!widget.active) {
      _refreshRequested = false;
    } else if (!oldWidget.active) {
      _refreshRequested = true;
    }
    _scheduleRefresh();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final wasForeground = _foreground;
    _foreground = state == AppLifecycleState.resumed;
    if (!wasForeground && _foreground && widget.active) {
      _refreshRequested = true;
      _scheduleRefresh();
    }
  }

  bool get _eligible =>
      widget.active && _foreground && _routeVisible && controller.current;

  void _scheduleRefresh() {
    if (!_refreshRequested || !_eligible || _refreshScheduled) return;
    _refreshScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _refreshScheduled = false;
      if (!mounted || !_refreshRequested || !_eligible) return;
      if (ModalRoute.of(context)?.isCurrent == false) return;
      _refreshRequested = false;
      unawaited(_refresh());
    });
    WidgetsBinding.instance.ensureVisualUpdate();
  }

  Future<void> _refresh() async {
    if (!_eligible) return;
    await Future.wait<void>([
      controller.refreshWorkspace(),
      preferences.refresh(),
    ]);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    preferences.dispose();
    controller.dispose();
    super.dispose();
  }

  Future<void> editName(ProfileSnapshot original, {String? draft}) async {
    if (!controller.current) return;
    await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (_) => ProfileEditDialog(
        controller: controller,
        original: original,
        initialName: draft ?? original.profile.displayName,
      ),
    );
  }

  Future<void> signOut() async {
    if (_confirmingLogout || !controller.current) return;
    final scope = controller.scope;
    final pending =
        controller.saving ||
        preferences.saving ||
        controller.needsReconciliation ||
        preferences.needsReconciliation;
    setState(() => _confirmingLogout = true);
    try {
      final confirmed = await confirmCommand(
        context,
        title: 'Đăng xuất khỏi thiết bị?',
        description:
            'Ứng dụng sẽ kết thúc phiên trên thiết bị và yêu cầu máy chủ '
            'thu hồi phiên đăng nhập.'
            '${pending ? ' Thay đổi đã gửi có thể chưa được xác nhận.' : ''}',
        confirmLabel: 'Đăng xuất',
        destructive: true,
      );
      if (!confirmed ||
          !mounted ||
          !widget.api.isCurrentAuthenticatedSession(scope)) {
        return;
      }
      await widget.api.signOut();
    } on AuthSessionException catch (error) {
      // The authentication destination owns logout and recovery outcomes.
      if (mounted && widget.api.isCurrentAuthenticatedSession(scope)) {
        showFailure(context, error);
      }
    } finally {
      if (mounted) setState(() => _confirmingLogout = false);
    }
  }

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) => RefreshIndicator(
      onRefresh: _refresh,
      child: _accountList(
        constraints.maxWidth > 796 ? (constraints.maxWidth - 760) / 2 : 18,
      ),
    ),
  );

  Widget _accountList(double horizontalPadding) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) => ListView(
      padding: EdgeInsets.symmetric(
        horizontal: horizontalPadding,
        vertical: 18,
      ),
      physics: const AlwaysScrollableScrollPhysics(),
      children: [
        SectionHeading(
          'Tài khoản & cài đặt',
          subtitle: 'Quản lý hồ sơ, thông báo và giao diện.',
          trailing: ListenableBuilder(
            listenable: preferences,
            builder: (context, _) => IconButton(
              tooltip: 'Tải lại tài khoản',
              onPressed: controller.canRefresh || preferences.canRefresh
                  ? _refresh
                  : null,
              icon: const Icon(Icons.refresh),
            ),
          ),
        ),
        Semantics(header: true, child: const SectionHeading('Hồ sơ cá nhân')),
        AccountResourceView<ProfileSnapshot>(
          snapshot: controller.snapshot,
          loading: controller.loading,
          saving: controller.saving,
          failure: controller.pendingEdit == null ? controller.failure : null,
          needsReconciliation:
              controller.pendingEdit == null && controller.needsReconciliation,
          retry: controller.refreshWorkspace,
          canRetry: controller.canRefresh,
          retryNotBefore: controller.retryNotBefore,
          builder: (response) {
            final account = response.profile;
            return ContentCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      CircleAvatar(
                        radius: 25,
                        child: Text(
                          account.displayName.isEmpty
                              ? 'U'
                              : account.displayName.characters.first
                                    .toUpperCase(),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              account.displayName,
                              style: const TextStyle(
                                fontSize: 16,
                                fontWeight: FontWeight.w800,
                              ),
                            ),
                            Text(
                              account.email,
                              style: TextStyle(
                                fontSize: 12,
                                color: Theme.of(context)
                                    .colorScheme
                                    .onSurfaceVariant,
                              ),
                            ),
                          ],
                        ),
                      ),
                      IconButton(
                        tooltip: 'Chỉnh sửa tên hiển thị',
                        onPressed: controller.canMutate
                            ? () => editName(response)
                            : null,
                        icon: const Icon(Icons.edit_outlined),
                      ),
                    ],
                  ),
                  const Divider(height: 26),
                  Text('Vai trò: ${profileRoleLabel(account.globalRole)}'),
                  const SizedBox(height: 6),
                  Text(
                    'Trạng thái: ${profileStatusLabel(account.accountStatus)}',
                  ),
                ],
              ),
            );
          },
        ),
        if (controller.pendingEdit case final pending?)
          ContentCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  controller.needsReconciliation
                      ? 'Cần kiểm tra lại dữ liệu hồ sơ từ máy chủ.'
                      : 'Cần xác nhận lại thay đổi hồ sơ.',
                ),
                Text('Tên dự định lưu: ${pending.name}'),
                TextButton(
                  onPressed: controller.saving
                      ? null
                      : () => editName(pending.original, draft: pending.name),
                  child: const Text('Xem và xử lý'),
                ),
              ],
            ),
          ),
        if (controller.reconciled)
          const Text('Tên máy chủ tại lần kiểm tra gần nhất đã khớp.'),
        if (controller.identityStatus == IdentitySyncStatus.synchronizing)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 8),
            child: Text('Đang đồng bộ danh tính ứng dụng...'),
          ),
        if (controller.identityRefreshFailed)
          ContentCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Hồ sơ hiện tại được lấy từ máy chủ. '
                  'Danh tính ứng dụng chưa đồng bộ. Hãy thử đồng bộ lại '
                  'hoặc tải lại hồ sơ nếu thông tin đã thay đổi.',
                ),
                if (controller.identityRetryNotBefore case final deadline?)
                  AccountRetryNotice(deadline: deadline),
                TextButton(
                  onPressed: controller.canRetryIdentity
                      ? controller.retryIdentity
                      : null,
                  child: const Text('Thử đồng bộ lại'),
                ),
              ],
            ),
          ),
        Semantics(
          header: true,
          child: const SectionHeading('Thiết lập tài khoản'),
        ),
        PreferencesPanel(controller: preferences),
        const SizedBox(height: 12),
        Semantics(header: true, child: const SectionHeading('Giao diện')),
        AppearancePanel(controller: widget.appearance),
        const SizedBox(height: 12),
        if (widget.onOpenAccountLink != null)
          OutlinedButton.icon(
            onPressed:
                _confirmingLogout ||
                    !controller.current ||
                    controller.saving ||
                    preferences.saving
                ? null
                : widget.onOpenAccountLink,
            icon: const Icon(Icons.link),
            label: const Text('Mở liên kết tài khoản'),
          ),
        OutlinedButton.icon(
          onPressed: _confirmingLogout || !controller.current ? null : signOut,
          icon: const Icon(Icons.logout),
          label: const Text('Đăng xuất'),
        ),
        const SizedBox(height: 24),
        Text(
          'SME Meeting Assistant · Internal mobile client',
          textAlign: TextAlign.center,
          style: TextStyle(
            color: Theme.of(context).colorScheme.onSurfaceVariant,
            fontSize: 12,
          ),
        ),
      ],
    ),
  );
}

String profileRoleLabel(AuthGlobalRole role) => switch (role) {
  AuthGlobalRole.employee => 'Nhân viên',
  AuthGlobalRole.departmentManager => 'Trưởng bộ phận',
  AuthGlobalRole.administrator => 'Quản trị viên',
};

String profileStatusLabel(AuthAccountStatus status) => switch (status) {
  AuthAccountStatus.pendingSetup => 'Chờ thiết lập',
  AuthAccountStatus.active => 'Đang hoạt động',
  AuthAccountStatus.inactive => 'Không hoạt động',
};
