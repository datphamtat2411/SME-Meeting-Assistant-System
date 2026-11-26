import 'package:flutter/material.dart';

import '../../core/widgets.dart';
import 'account_resource_view.dart';
import 'profile_controllers.dart';
import 'profile_models.dart';
import 'regional_preference_dialog.dart';

const _timezones = {
  'Asia/Ho_Chi_Minh': 'Việt Nam',
  'Asia/Singapore': 'Singapore',
  'Asia/Tokyo': 'Tokyo',
  'Asia/Seoul': 'Seoul',
  'Asia/Bangkok': 'Bangkok',
  'Asia/Hong_Kong': 'Hong Kong',
  'Australia/Sydney': 'Sydney',
  'Europe/London': 'London',
  'Europe/Paris': 'Paris',
  'America/New_York': 'New York',
  'America/Los_Angeles': 'Los Angeles',
  'Etc/UTC': 'UTC',
};

const _locales = {
  'vi-VN': 'Tiếng Việt',
  'en-US': 'English (US)',
  'en-GB': 'English (UK)',
  'ja-JP': '日本語',
  'ko-KR': '한국어',
  'zh-CN': '简体中文',
  'fr-FR': 'Français',
  'de-DE': 'Deutsch',
};

String preferenceFieldLabel(PreferenceField field) => switch (field) {
  PreferenceField.meetingEmail => 'Email cuộc họp',
  PreferenceField.actionItemEmail => 'Email phân công công việc',
  PreferenceField.timezone => 'Múi giờ ưu tiên',
  PreferenceField.locale => 'Ngôn ngữ ưu tiên',
};

String _valueLabel(Object? value) => switch (value) {
  true => 'Bật',
  false => 'Tắt',
  null => 'Chưa thiết lập',
  _ => value.toString(),
};

class PreferencesPanel extends StatelessWidget {
  const PreferencesPanel({super.key, required this.controller});
  final PreferencesController controller;

  Future<void> _choose(
    BuildContext context,
    PreferenceField field,
    PreferencesSnapshot original,
  ) async {
    if (!controller.canMutate && controller.pendingIntent?.field != field) {
      return;
    }
    await showDialog<RegionalSelection>(
      context: context,
      barrierDismissible: false,
      builder: (_) => RegionalPreferenceDialog(
        controller: controller,
        original: original,
        field: field,
        title: preferenceFieldLabel(field),
        options: field == PreferenceField.timezone ? _timezones : _locales,
      ),
    );
  }

  String _subtitle(PreferenceField field, String description) =>
      controller.saving && controller.activeIntent?.field == field
      ? '$description\nĐang lưu lựa chọn...'
      : description;

  Widget _recovery(
    BuildContext context,
    PreferenceIntent intent,
    PreferencesSnapshot snapshot,
  ) {
    final currentValue = intent.valueIn(snapshot.preferences);
    final checking = controller.needsReconciliation;
    final busy = controller.loading || controller.saving;
    return ContentCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            checking
                ? 'Cần kiểm tra lại thiết lập từ máy chủ.'
                : 'Hãy xem lại thiết lập hiện tại trước khi thử lưu tiếp.',
          ),
          Text(preferenceFieldLabel(intent.field)),
          Text(
            '${checking ? 'Lần xác nhận gần nhất' : 'Đã lưu'}: '
            '${_valueLabel(currentValue)}',
          ),
          Text('Mong muốn: ${_valueLabel(intent.value)}'),
          if (controller.failure != null)
            Text(
              controller.failure!.message,
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
          if (checking)
            TextButton(
              onPressed: controller.canRefresh ? controller.refresh : null,
              child: const Text('Kiểm tra lại thiết lập'),
            )
          else
            Wrap(
              spacing: 8,
              children: [
                TextButton(
                  onPressed: busy ? null : controller.abandonPending,
                  child: const Text('Giữ giá trị máy chủ'),
                ),
                FilledButton(
                  onPressed: !controller.canConfirmPending
                      ? null
                      : () {
                          if (intent.field == PreferenceField.timezone ||
                              intent.field == PreferenceField.locale) {
                            _choose(context, intent.field, snapshot);
                          } else {
                            controller.confirmPending(currentValue);
                          }
                        },
                  child: Text(
                    intent.field == PreferenceField.timezone ||
                            intent.field == PreferenceField.locale
                        ? 'Xem và xử lý'
                        : 'Xác nhận lưu',
                  ),
                ),
              ],
            ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) => AccountResourceView<PreferencesSnapshot>(
      snapshot: controller.snapshot,
      loading: controller.loading,
      saving: controller.saving,
      failure: controller.pendingIntent == null ? controller.failure : null,
      needsReconciliation:
          controller.pendingIntent == null && controller.needsReconciliation,
      retry: controller.refresh,
      canRetry: controller.canRefresh,
      retryNotBefore: controller.retryNotBefore,
      builder: (snapshot) {
        final prefs = snapshot.preferences;
        final pending = controller.pendingIntent;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            ContentCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    'Thông báo',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  SwitchListTile.adaptive(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('Email cuộc họp'),
                    subtitle: Text(
                      _subtitle(
                        PreferenceField.meetingEmail,
                        'Thông báo tùy chọn về lịch họp, đổi lịch, hủy họp và '
                        'thay đổi người tham gia được hỗ trợ.',
                      ),
                    ),
                    value: prefs.meetingEmailEnabled,
                    onChanged: controller.canMutate
                        ? controller.updateMeetingEmail
                        : null,
                  ),
                  const Divider(),
                  SwitchListTile.adaptive(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('Email phân công công việc'),
                    subtitle: Text(
                      _subtitle(
                        PreferenceField.actionItemEmail,
                        'Thông báo khi được phân công hoặc phân công lại '
                        'công việc, nếu hệ thống hỗ trợ.',
                      ),
                    ),
                    value: prefs.actionItemEmailEnabled,
                    onChanged: controller.canMutate
                        ? controller.updateActionItemEmail
                        : null,
                  ),
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    child: Text(
                      'Tắt email tùy chọn không ảnh hưởng đến việc tham gia '
                      'cuộc họp, công việc được giao hoặc email thiết lập, '
                      'khôi phục và bảo mật bắt buộc. Việc gửi email phụ '
                      'thuộc cấu hình và điều kiện của hệ thống.',
                      style: TextStyle(
                        fontSize: 12,
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ),
                  const Divider(),
                  Text(
                    'Thiết lập khu vực',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(Icons.public_outlined),
                    title: const Text('Múi giờ ưu tiên'),
                    subtitle: Text(
                      _subtitle(
                        PreferenceField.timezone,
                        prefs.timezone ?? 'Chưa thiết lập',
                      ),
                    ),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: controller.canMutate
                        ? () => _choose(context, PreferenceField.timezone, snapshot)
                        : null,
                  ),
                  const Divider(),
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(Icons.language_outlined),
                    title: const Text('Ngôn ngữ ưu tiên'),
                    subtitle: Text(
                      _subtitle(
                        PreferenceField.locale,
                        prefs.locale ?? 'Chưa thiết lập',
                      ),
                    ),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: controller.canMutate
                        ? () => _choose(context, PreferenceField.locale, snapshot)
                        : null,
                  ),
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(
                      'Các tùy chọn này được lưu cho tài khoản. Ứng dụng '
                      'hiện hiển thị giờ theo thiết bị; ngôn ngữ ưu tiên '
                      'chưa điều khiển giao diện hoặc email.',
                      style: TextStyle(
                        fontSize: 12,
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ),
                ],
              ),
            ),
            if (pending != null) _recovery(context, pending, snapshot),
            if (controller.reconciled)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 8),
                child: Text(
                  'Thiết lập hiện tại trên máy chủ đã khớp với lựa chọn.',
                ),
              ),
          ],
        );
      },
    ),
  );
}
