import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import '../../core/appearance_controller.dart';
import '../../core/app_theme.dart';
import '../../core/command_actions.dart';
import '../../core/widgets.dart';
import 'appearance_panel.dart';
import 'preferences_panel.dart';

class ProfilePage extends StatefulWidget {
  const ProfilePage({
    super.key,
    required this.api,
    required this.appearance,
  });
  final ApiClient api;
  final AppearanceController appearance;
  @override
  State<ProfilePage> createState() => _ProfilePageState();
}

class _ProfilePageState extends State<ProfilePage> {
  late Future<ApiResult> profile;
  bool busy = false;

  @override
  void initState() {
    super.initState();
    reload();
  }

  void reload() => setState(() {
    profile = widget.api.get('/me/profile');
  });

  Future<void> editName(ApiResult current) async {
    final name = TextEditingController(
      text: (current.objectData()['displayName'] ?? '').toString(),
    );
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
    if (ok != true || value.isEmpty || !mounted) return;
    setState(() => busy = true);
    try {
      await widget.api.patch(
        '/me/profile',
        {'displayName': value},
        headers: {'If-Match': requireEtag(current)},
      );
      await widget.api.loadIdentity();
      if (mounted) {
        showSuccess(context, 'Đã cập nhật hồ sơ.');
        reload();
      }
    } catch (error) {
      if (mounted) showFailure(context, error);
    } finally {
      if (mounted) setState(() => busy = false);
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
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(18),
    children: [
      const SectionHeading(
        'Tài khoản & cài đặt',
        subtitle: 'Quản lý hồ sơ, thông báo và giao diện.',
      ),
      AsyncContent<ApiResult>(
        future: profile,
        retry: reload,
        builder: (response) {
          final account = response.objectData();
          return ContentCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    CircleAvatar(
                      radius: 25,
                      child: Text(
                        widget.api.displayName.isEmpty
                            ? 'U'
                            : widget.api.displayName
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
                            widget.api.displayName,
                            style: const TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.w800,
                            ),
                          ),
                          Text(
                            widget.api.email,
                            style: const TextStyle(
                              fontSize: 12,
                              color: Palette.muted,
                            ),
                          ),
                        ],
                      ),
                    ),
                    IconButton(
                      onPressed: busy ? null : () => editName(response),
                      icon: const Icon(Icons.edit_outlined),
                    ),
                  ],
                ),
                const Divider(height: 26),
                Text('Vai trò: ' + (account['globalRole'] ?? '').toString()),
                const SizedBox(height: 6),
                Text(
                  'Trạng thái: ' + (account['accountStatus'] ?? '').toString(),
                ),
              ],
            ),
          );
        },
      ),
      const SectionHeading('Thông báo và khu vực'),
      PreferencesPanel(api: widget.api),
      const SizedBox(height: 12),
      const SectionHeading('Giao diện'),
      AppearancePanel(controller: widget.appearance),
      const SizedBox(height: 12),
      OutlinedButton.icon(
        onPressed: busy ? null : signOut,
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
  );
}
