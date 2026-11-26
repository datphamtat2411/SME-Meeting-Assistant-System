import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import '../../core/appearance_controller.dart';
import '../../core/app_theme.dart';
import '../../core/command_actions.dart';
import '../../core/widgets.dart';
import 'appearance_panel.dart';
import 'preferences_panel.dart';
import 'profile_controllers.dart';
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

  Future<void> editName(ProfileSnapshot current) async {
    final name = TextEditingController(text: current.profile.displayName);
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialog) => AlertDialog(
        title: const Text('Cập nhật tên hiển thị'),
        content: TextField(
          controller: name,
          maxLength: 200,
          decoration: const InputDecoration(labelText: 'Tên hiển thị'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialog, false),
            child: const Text('Hủy'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialog, true),
            child: const Text('Lưu'),
          ),
        ],
      ),
    );
    final value = name.text.trim();
    name.dispose();
    if (ok != true || !mounted || !controller.current) return;
    if (value.isEmpty || value.length > 200) {
      showFailure(
        context,
        const ApiFailure(
          422,
          'PROFILE_INVALID_NAME',
          'Tên hiển thị không hợp lệ.',
        ),
      );
      return;
    }
    if (value == current.profile.displayName) return;
    final saved = await controller.updateName(current, value);
    if (!mounted || !controller.current) return;
    if (saved) {
      showSuccess(
        context,
        controller.identityRefreshFailed
            ? 'Đã lưu hồ sơ. Danh tính ứng dụng chưa đồng bộ.'
            : 'Đã cập nhật hồ sơ.',
      );
    } else if (controller.failure != null) {
      if (controller.outcome == ProfileMutationOutcome.unknown) {
        showFailure(
          context,
          const ApiFailure(
            0,
            'PROFILE_OUTCOME_UNKNOWN',
            'Chưa xác định được kết quả lưu. Vui lòng tải lại hồ sơ.',
          ),
        );
      } else {
        showFailure(context, controller.failure!);
      }
    } else {
      showFailure(
        context,
        const ApiFailure(
          412,
          'PROFILE_CHANGED',
          'Hồ sơ đã thay đổi. Vui lòng mở lại.',
        ),
      );
    }
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
          failure: controller.failure,
          needsReconciliation: controller.needsReconciliation,
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
                              : account.displayName
                                    .substring(0, 1)
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
                              style: const TextStyle(
                                fontSize: 12,
                                color: Palette.muted,
                              ),
                            ),
                          ],
                        ),
                      ),
                      IconButton(
                        onPressed: controller.canMutate
                            ? () => editName(response)
                            : null,
                        icon: const Icon(Icons.edit_outlined),
                      ),
                    ],
                  ),
                  const Divider(height: 26),
                  Text('Vai trò: ${account.globalRole.name}'),
                  const SizedBox(height: 6),
                  Text('Trạng thái: ${account.accountStatus.name}'),
                ],
              ),
            );
          },
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
