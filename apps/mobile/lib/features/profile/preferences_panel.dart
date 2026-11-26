import 'package:flutter/material.dart';

import '../../core/app_theme.dart';
import '../../core/widgets.dart';
import 'account_resource_view.dart';
import 'profile_controllers.dart';
import 'profile_models.dart';
import 'profile_repository.dart';

class PreferencesPanel extends StatefulWidget {
  const PreferencesPanel({super.key, required this.repository});
  final ProfileRepository repository;
  @override
  State<PreferencesPanel> createState() => _PreferencesPanelState();
}

class _PreferencesPanelState extends State<PreferencesPanel> {
  late final PreferencesController controller;

  @override
  void initState() {
    super.initState();
    controller = PreferencesController(widget.repository);
    controller.refresh();
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  Future<void> change(Future<bool> Function() operation) async {
    if (!controller.canMutate) return;
    final saved = await operation();
    if (!mounted || !controller.current) return;
    if (saved) {
      showSuccess(context, 'Đã lưu thiết lập.');
    } else if (controller.failure != null) {
      if (controller.outcome == ProfileMutationOutcome.unknown) {
        showFailure(
          context,
          ProfileFailure.local(
            0,
            'PREFERENCES_OUTCOME_UNKNOWN',
            'Chưa xác định được kết quả lưu. Vui lòng tải lại thiết lập.',
          ),
        );
      } else {
        showFailure(context, controller.failure!);
      }
    }
  }

  Future<void> choose({
    required Future<bool> Function(String) update,
    required String title,
    required Map<String, String> options,
  }) async {
    final selection = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (sheet) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            ListTile(
              title: Text(
                title,
                style: const TextStyle(fontWeight: FontWeight.w800),
              ),
            ),
            ...options.entries.map(
              (option) => ListTile(
                title: Text(option.value),
                subtitle: Text(option.key),
                onTap: () => Navigator.pop(sheet, option.key),
              ),
            ),
          ],
        ),
      ),
    );
    if (selection != null && mounted && controller.current) {
      await change(() => update(selection));
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) => AccountResourceView<PreferencesSnapshot>(
      snapshot: controller.snapshot,
      loading: controller.loading,
      saving: controller.saving,
      failure: controller.failure,
      needsReconciliation: controller.needsReconciliation,
      retry: controller.refresh,
      builder: (snapshot) {
        final prefs = snapshot.preferences;
        return ContentCard(
          child: Column(
            children: [
              SwitchListTile.adaptive(
                contentPadding: EdgeInsets.zero,
                title: const Text('Email cuộc họp'),
                subtitle: const Text('Thông báo mời họp và thay đổi lịch'),
                value: prefs.meetingEmailEnabled,
                onChanged: !controller.canMutate
                    ? null
                    : (v) => change(() => controller.updateMeetingEmail(v)),
              ),
              const Divider(),
              SwitchListTile.adaptive(
                contentPadding: EdgeInsets.zero,
                title: const Text('Email công việc'),
                subtitle: const Text(
                  'Thông báo phân công và thay đổi đầu việc',
                ),
                value: prefs.actionItemEmailEnabled,
                onChanged: !controller.canMutate
                    ? null
                    : (v) => change(() => controller.updateActionItemEmail(v)),
              ),
              const Divider(),
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(
                  Icons.public_outlined,
                  color: Palette.muted,
                ),
                title: const Text('Múi giờ'),
                subtitle: Text(prefs.timezone ?? 'Theo hệ thống'),
                trailing: const Icon(Icons.chevron_right),
                onTap: !controller.canMutate
                    ? null
                    : () => choose(
                        update: controller.updateTimezone,
                        title: 'Múi giờ ưu tiên',
                        options: const {
                          'Asia/Ho_Chi_Minh': 'Việt Nam (GMT+7)',
                          'Asia/Singapore': 'Singapore (GMT+8)',
                          'Asia/Tokyo': 'Tokyo (GMT+9)',
                          'Europe/London': 'London',
                          'America/New_York': 'New York',
                        },
                      ),
              ),
              const Divider(),
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(
                  Icons.language_outlined,
                  color: Palette.muted,
                ),
                title: const Text('Ngôn ngữ ưu tiên'),
                subtitle: Text(prefs.locale ?? 'Theo hệ thống'),
                trailing: const Icon(Icons.chevron_right),
                onTap: !controller.canMutate
                    ? null
                    : () => choose(
                        update: controller.updateLocale,
                        title: 'Ngôn ngữ ưu tiên',
                        options: const {
                          'vi-VN': 'Tiếng Việt',
                          'en-US': 'English',
                        },
                      ),
              ),
              const Padding(
                padding: EdgeInsets.only(top: 8),
                child: Text(
                  'Tùy chọn được lưu cho tài khoản. Ứng dụng hiện dùng múi giờ thiết bị; ngôn ngữ chưa điều khiển giao diện hoặc email.',
                  style: TextStyle(fontSize: 12, color: Palette.muted),
                ),
              ),
            ],
          ),
        );
      },
    ),
  );
}
