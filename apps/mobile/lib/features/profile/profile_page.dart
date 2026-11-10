import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import '../../core/app_theme.dart';
import '../../core/widgets.dart';

class ProfilePage extends StatefulWidget {
  final ApiClient api;
  final ThemeMode themeMode;
  final ValueChanged<ThemeMode> onThemeChanged;
  const ProfilePage({super.key, required this.api,
    required this.themeMode, required this.onThemeChanged});

  @override
  State<ProfilePage> createState() => _ProfilePageState();
}

class _ProfilePageState extends State<ProfilePage> {
  late Future<ApiResult> profile;
  late Future<Map<String, dynamic>> preferences;
  final name = TextEditingController();
  bool busy = false;

  @override
  void initState() {
    super.initState();
    reload();
  }

  void reload() => setState(() {
    profile = widget.api.get('/me/profile');
    preferences = widget.api.get('/me/preferences')
      .then((v) => objectOf(v.data));
  });

  @override
  void dispose() {
    name.dispose();
    super.dispose();
  }

  Future<void> editName(ApiResult current) async {
    name.text = (objectOf(current.data)['displayName'] ?? '').toString();
    final confirmed = await showDialog<bool>(context: context,
      builder: (dialog) => AlertDialog(
        title: const Text('Chỉnh sửa hồ sơ'),
        content: TextField(controller: name, maxLength: 200,
          decoration: const InputDecoration(labelText: 'Tên hiển thị')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialog, false),
            child: const Text('Hủy')),
          FilledButton(onPressed: () => Navigator.pop(dialog, true),
            child: const Text('Lưu')),
        ]));
    if (confirmed != true || name.text.trim().isEmpty) return;
    setState(() => busy = true);
    try {
      await widget.api.patch('/me/profile',
        {'displayName': name.text.trim()},
        headers: {if (current.etag != null) 'If-Match': current.etag!});
      await widget.api.loadIdentity();
      if (mounted) { reload(); showSuccess(context, 'Đã cập nhật hồ sơ.'); }
    } catch (error) {
      if (mounted) showFailure(context, error);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> setPreference(String field, dynamic value) async {
    setState(() => busy = true);
    try {
      await widget.api.patch('/me/preferences', {field: value});
      if (mounted) { reload(); showSuccess(context, 'Đã lưu thiết lập.'); }
    } catch (error) {
      if (mounted) showFailure(context, error);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> logout() async {
    try {
      await widget.api.signOut();
    } catch (error) {
      if (mounted) showFailure(context,
        const ApiFailure(0, 'LOGOUT_UNCONFIRMED',
          'Đã đăng xuất trên thiết bị. Không xác nhận được phiên phía máy chủ.'));
    }
  }

  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(18),
    children: [
      const SectionHeading('Tài khoản & cài đặt',
        subtitle: 'Hồ sơ, thông báo và giao diện ứng dụng'),
      AsyncContent<ApiResult>(future: profile, retry: reload,
        builder: (response) {
          final data = objectOf(response.data);
          return ContentCard(child: Column(
            crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                CircleAvatar(radius: 25,
                  child: Text((widget.api.displayName.isEmpty ? 'U'
                    : widget.api.displayName[0]).toUpperCase())),
                const SizedBox(width: 12),
                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(widget.api.displayName,
                      style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
                    Text(widget.api.email, style:
                      const TextStyle(color: Palette.muted, fontSize: 12)),
                    Text((data['globalRole'] ?? '').toString(),
                      style: const TextStyle(color: Palette.muted, fontSize: 12)),
                  ])),
                IconButton(onPressed: busy ? null : () => editName(response),
                  icon: const Icon(Icons.edit_outlined)),
              ]),
              const Divider(height: 26),
              Text('Trạng thái tài khoản: ' + (data['accountStatus'] ?? '').toString(),
                style: const TextStyle(color: Palette.muted)),
            ]));
        }),
      const SectionHeading('Thông báo từ hệ thống'),
      AsyncContent<Map<String, dynamic>>(future: preferences,
        retry: reload, builder: (prefs) => ContentCard(
          child: Column(children: [
            SwitchListTile.adaptive(
              contentPadding: EdgeInsets.zero,
              title: const Text('Email lịch họp'),
              subtitle: const Text('Thông báo thay đổi lịch và mời họp'),
              value: prefs['meetingEmailEnabled'] == true,
              onChanged: busy ? null : (v) => setPreference('meetingEmailEnabled', v)),
            const Divider(),
            SwitchListTile.adaptive(
              contentPadding: EdgeInsets.zero,
              title: const Text('Email công việc'),
              subtitle: const Text('Thông báo phân công và cập nhật đầu việc'),
              value: prefs['actionItemEmailEnabled'] == true,
              onChanged: busy ? null : (v) => setPreference('actionItemEmailEnabled', v)),
            const Divider(),
            ListTile(contentPadding: EdgeInsets.zero,
              title: const Text('Múi giờ'),
              subtitle: Text((prefs['timezone'] ?? 'Theo thiết bị').toString()),
              trailing: const Icon(Icons.public),
              onTap: () => setPreference('timezone', 'Asia/Ho_Chi_Minh')),
          ]))),
      const SectionHeading('Giao diện'),
      ContentCard(child: Column(
        crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('Chế độ màu',
            style: TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 12),
          SegmentedButton<ThemeMode>(
            segments: const [
              ButtonSegment(value: ThemeMode.system, label: Text('Tự động')),
              ButtonSegment(value: ThemeMode.light, label: Text('Sáng')),
              ButtonSegment(value: ThemeMode.dark, label: Text('Tối')),
            ],
            selected: {widget.themeMode},
            onSelectionChanged: (v) => widget.onThemeChanged(v.first)),
        ])),
      const SizedBox(height: 12),
      OutlinedButton.icon(onPressed: logout,
        icon: const Icon(Icons.logout), label: const Text('Đăng xuất')),
      const SizedBox(height: 24),
      const Text('SME Meeting Assistant · Flutter',
        textAlign: TextAlign.center,
        style: TextStyle(color: Palette.muted, fontSize: 12)),
    ],
  );
}
