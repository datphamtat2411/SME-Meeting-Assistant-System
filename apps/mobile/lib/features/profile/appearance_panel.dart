import 'package:flutter/material.dart';

import '../../core/appearance_controller.dart';
import '../../core/widgets.dart';

class AppearancePanel extends StatelessWidget {
  const AppearancePanel({super.key, required this.controller});

  final AppearanceController controller;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) => ContentCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Chế độ màu',
            style: TextStyle(fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 12),
          SegmentedButton<ThemeMode>(
            segments: const [
              ButtonSegment(value: ThemeMode.system, label: Text('Tự động')),
              ButtonSegment(value: ThemeMode.light, label: Text('Sáng')),
              ButtonSegment(value: ThemeMode.dark, label: Text('Tối')),
            ],
            selected: {controller.mode},
            onSelectionChanged: (values) => controller.setMode(values.first),
          ),
          if (controller.persistenceStatus ==
              AppearancePersistenceStatus.restoring)
            const Padding(
              padding: EdgeInsets.only(top: 8),
              child: Text('Đang tải giao diện đã lưu...'),
            ),
          if (controller.persistenceStatus ==
              AppearancePersistenceStatus.restoreFailed) ...[
            const SizedBox(height: 8),
            Text(
              'Không thể tải giao diện đã lưu. Đang dùng giao diện hệ thống.',
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
            TextButton(
              onPressed: controller.retryPersistence,
              child: const Text('Thử tải lại'),
            ),
          ],
          if (controller.persistenceStatus ==
              AppearancePersistenceStatus.saving)
            const Padding(
              padding: EdgeInsets.only(top: 8),
              child: Text('Đang lưu giao diện trên thiết bị...'),
            ),
          if (controller.persistenceStatus ==
              AppearancePersistenceStatus.failed) ...[
            const SizedBox(height: 8),
            Text(
              'Giao diện đang áp dụng nhưng chưa xác nhận được thiết lập đã lưu.',
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
            TextButton(
              onPressed: controller.retryPersistence,
              child: const Text('Thử lưu lại'),
            ),
          ],
        ],
      ),
    ),
  );
}
