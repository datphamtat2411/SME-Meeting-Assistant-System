import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/widgets.dart';
import 'results_models.dart';
import 'results_workspace_controller.dart';

/// A review dialog must stop rendering protected content as soon as its
/// original authorization context is invalidated.
Future<T?> showResultsReviewDialog<T>({
  required BuildContext context,
  required ResultsWorkspaceController workspace,
  required int epoch,
  required WidgetBuilder builder,
}) {
  if (!workspace.ownsReview(epoch)) return Future<T?>.value();
  return showDialog<T>(
    context: context,
    builder: (dialog) => AnimatedBuilder(
      animation: workspace,
      builder: (context, _) {
        if (workspace.ownsReview(epoch)) return builder(context);
        return AlertDialog(
          title: const Text('Quyền truy cập đã thay đổi'),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialog),
              child: const Text('Đóng'),
            ),
          ],
        );
      },
    ),
  );
}

Widget resultsResourceMessage<T>(
  ResultsResource<T> resource, {
  required Future<void> Function() onRetry,
  required String label,
}) {
  final title = switch (resource.phase) {
    ResultsResourcePhase.forbidden => 'Bạn không có quyền xem kết quả này',
    ResultsResourcePhase.notReady => '$label chưa sẵn sàng',
    ResultsResourcePhase.failed => 'Không thể tải $label',
    ResultsResourcePhase.loading ||
    ResultsResourcePhase.uninitialized ||
    ResultsResourcePhase.refreshing => 'Đang tải $label',
    ResultsResourcePhase.empty => 'Chưa có dữ liệu',
    ResultsResourcePhase.available => 'Chưa có dữ liệu',
  };
  return MessagePanel(
    title: title,
    onRetry: resource.phase == ResultsResourcePhase.failed ||
            resource.phase == ResultsResourcePhase.notReady ||
            resource.phase == ResultsResourcePhase.forbidden
        ? () => unawaited(onRetry())
        : null,
  );
}

Widget resultsRefreshNotice<T>(
  ResultsResource<T> resource,
  Future<void> Function() onRetry,
) {
  if (resource.phase == ResultsResourcePhase.refreshing) {
    return const LinearProgressIndicator();
  }
  if (resource.phase == ResultsResourcePhase.failed && resource.hasData) {
    return MessagePanel(
      title: 'Không thể cập nhật. Đang hiển thị dữ liệu đã tải.',
      onRetry: () => unawaited(onRetry()),
    );
  }
  return const SizedBox.shrink();
}
