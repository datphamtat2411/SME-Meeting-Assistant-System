import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import '../../core/appearance_controller.dart';
import '../../core/app_theme.dart';
import '../../core/command_actions.dart';
import '../../core/widgets.dart';
import 'appearance_panel.dart';
import 'preferences_panel.dart';
import 'profile_controllers.dart';
import 'profile_edit_dialog.dart';
import 'profile_models.dart';
import 'profile_repository.dart';
import 'account_resource_view.dart';

class ProfilePage extends StatefulWidget {
  const ProfilePage({
    super.key,
    required this.api,
    required this.repository,
    required this.appearance,
  });
  final ApiClient api;
  final ProfileRepository repository;
  final AppearanceController appearance;
  @override
  State<ProfilePage> createState() => _ProfilePageState();
}

class _ProfilePageState extends State<ProfilePage> {
  late final ProfileController controller;

  @override
  void initState() {
    super.initState();
    controller = ProfileController(widget.repository);
    controller.refresh();
  }

  @override
  void dispose() {
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
    if (!await confirmCommand(
      context,
      title: 'Đăng xuất khỏi thiết bị?',
      description: 'Phiên đăng nhập hiện tại sẽ bị thu hồi.',
      confirmLabel: 'Đăng xuất',
    ))
      return;
    try {
      await widget.api.signOut();
    } catch (error) {
      if (mounted) showFailure(context, error);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) => ListView(
      padding: const EdgeInsets.all(18),
      children: [
        const SectionHeading(
          'Tài khoản & cài đặt',
          subtitle: 'Quản lý hồ sơ, thông báo và giao diện.',
        ),
        AccountResourceView<ProfileSnapshot>(
          snapshot: controller.snapshot,
          loading: controller.loading,
          saving: controller.saving,
          failure: controller.pendingEdit == null ? controller.failure : null,
          needsReconciliation:
              controller.pendingEdit == null && controller.needsReconciliation,
          retry: controller.refresh,
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
                  'Hồ sơ đã được xác nhận trên máy chủ. '
                  'Danh tính ứng dụng chưa đồng bộ. Có thể tải lại hồ sơ '
                  'nếu thông tin đã thay đổi trên thiết bị khác.',
                ),
                TextButton(
                  onPressed: controller.retryIdentity,
                  child: const Text('Thử đồng bộ lại'),
                ),
              ],
            ),
          ),
        const SectionHeading('Thông báo và khu vực'),
        PreferencesPanel(repository: widget.repository),
        const SizedBox(height: 12),
        const SectionHeading('Giao diện'),
        AppearancePanel(controller: widget.appearance),
        const SizedBox(height: 12),
        OutlinedButton.icon(
          onPressed: controller.saving ? null : signOut,
          icon: const Icon(Icons.logout),
          label: const Text('Đăng xuất'),
        ),
        const SizedBox(height: 24),
        const Text(
          'SME Meeting Assistant · Internal mobile client',
          textAlign: TextAlign.center,
          style: TextStyle(color: Palette.muted, fontSize: 12),
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
