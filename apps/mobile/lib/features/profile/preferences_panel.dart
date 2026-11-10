import 'package:flutter/material.dart';
import '../../core/api_client.dart';
import '../../core/app_theme.dart';
import '../../core/widgets.dart';

class PreferencesPanel extends StatefulWidget {
  const PreferencesPanel({super.key, required this.api});
  final ApiClient api;
  @override
  State<PreferencesPanel> createState() => _PreferencesPanelState();
}

class _PreferencesPanelState extends State<PreferencesPanel> {
  late Future<Map<String, dynamic>> current;
  bool saving = false;
  @override
  void initState() { super.initState(); reload(); }

  void reload() => setState(() {
    current = widget.api.get('/me/preferences')
        .then((response) => objectOf(response.data));
  });

  Future<void> change(String field, dynamic value) async {
    if (saving) return;
    setState(() => saving = true);
    try {
      await widget.api.patch('/me/preferences', {field: value});
      if (mounted) {
        showSuccess(context, 'Đã lưu thiết lập.');
        reload();
      }
    } catch (error) { if (mounted) showFailure(context, error); }
    finally { if (mounted) setState(() => saving = false); }
  }

  Future<void> choose({
    required String field,
    required String title,
    required Map<String, String> options,
  }) async {
    final selection = await showModalBottomSheet<String>(context: context,
      showDragHandle: true,
      builder: (sheet) => SafeArea(child: ListView(
        shrinkWrap: true, children: [
          ListTile(title: Text(title,
            style: const TextStyle(fontWeight: FontWeight.w800))),
          ...options.entries.map((option) => ListTile(
            title: Text(option.value),
            subtitle: Text(option.key),
            onTap: () => Navigator.pop(sheet, option.key),
          )),
        ],
      )));
    if (selection != null && mounted) await change(field, selection);
  }

  @override
  Widget build(BuildContext context) =>
      AsyncContent<Map<String, dynamic>>(future: current, retry: reload,
      builder: (prefs) => ContentCard(child: Column(children: [
        SwitchListTile.adaptive(
          contentPadding: EdgeInsets.zero,
          title: const Text('Email cuộc họp'),
          subtitle: const Text('Thông báo mời họp và thay đổi lịch'),
          value: prefs['meetingEmailEnabled'] == true,
          onChanged: saving ? null : (v) => change('meetingEmailEnabled', v),
        ),
        const Divider(),
        SwitchListTile.adaptive(
          contentPadding: EdgeInsets.zero,
          title: const Text('Email công việc'),
          subtitle: const Text('Thông báo phân công và thay đổi đầu việc'),
          value: prefs['actionItemEmailEnabled'] == true,
          onChanged: saving ? null : (v) => change('actionItemEmailEnabled', v),
        ),
        const Divider(),
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.public_outlined, color: Palette.muted),
          title: const Text('Múi giờ'),
          subtitle: Text((prefs['timezone'] ?? 'Theo hệ thống').toString()),
          trailing: const Icon(Icons.chevron_right),
          onTap: saving ? null : () => choose(
            field: 'timezone', title: 'Múi giờ hiển thị',
            options: const {
              'Asia/Ho_Chi_Minh': 'Việt Nam (GMT+7)',
              'Asia/Singapore': 'Singapore (GMT+8)',
              'Asia/Tokyo': 'Tokyo (GMT+9)',
              'Europe/London': 'London',
              'America/New_York': 'New York',
            }),
        ),
        const Divider(),
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.language_outlined, color: Palette.muted),
          title: const Text('Ngôn ngữ thông báo'),
          subtitle: Text((prefs['locale'] ?? 'Theo hệ thống').toString()),
          trailing: const Icon(Icons.chevron_right),
          onTap: saving ? null : () => choose(
            field: 'locale', title: 'Ngôn ngữ thông báo từ máy chủ',
            options: const {'vi-VN': 'Tiếng Việt', 'en-US': 'English'}),
        ),
        const Padding(
          padding: EdgeInsets.only(top: 8),
          child: Text('Lựa chọn này được lưu trên Core API và áp dụng cho tài khoản.',
            style: TextStyle(fontSize: 12, color: Palette.muted)),
        ),
      ])));
}
