import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/widgets.dart';
import 'results_models.dart';
import 'results_workspace_controller.dart';

enum ResultsDraftConflictChoice { reuse, revise, discard, cancel }

Future<ResultsDraftConflictChoice> showResultsDraftConflictDialog({
  required BuildContext context,
  required ResultsWorkspaceController workspace,
  required int epoch,
  required String currentContent,
  required String preservedDraft,
}) async {
  final choice = await showResultsReviewDialog<ResultsDraftConflictChoice>(
    context: context,
    workspace: workspace,
    epoch: epoch,
    builder: (dialog) => AlertDialog(
      title: const Text('Nội dung đã thay đổi'),
      content: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Nội dung hiện tại trên máy chủ khác với phiên bản bạn đã bắt đầu chỉnh sửa. Hãy xem nội dung mới trước khi dùng lại bản nháp.',
            ),
            const SizedBox(height: 14),
            const Text(
              'Nội dung hiện tại',
              style: TextStyle(fontWeight: FontWeight.w700),
            ),
            SelectableText(currentContent),
            const SizedBox(height: 14),
            const Text(
              'Bản nháp được giữ lại',
              style: TextStyle(fontWeight: FontWeight.w700),
            ),
            SelectableText(preservedDraft),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () =>
              Navigator.pop(dialog, ResultsDraftConflictChoice.discard),
          child: const Text('Bỏ bản nháp'),
        ),
        TextButton(
          onPressed: () =>
              Navigator.pop(dialog, ResultsDraftConflictChoice.cancel),
          child: const Text('Để sau'),
        ),
        OutlinedButton(
          onPressed: () =>
              Navigator.pop(dialog, ResultsDraftConflictChoice.reuse),
          child: const Text('Dùng lại bản nháp'),
        ),
        FilledButton(
          onPressed: () =>
              Navigator.pop(dialog, ResultsDraftConflictChoice.revise),
          child: const Text('Xem và chỉnh sửa'),
        ),
      ],
    ),
  );
  return choice ?? ResultsDraftConflictChoice.cancel;
}

/// A review dialog must stop rendering protected content as soon as its
/// original authorization context is invalidated.
Future<T?> showResultsReviewDialog<T>({
  required BuildContext context,
  required ResultsWorkspaceController workspace,
  required int epoch,
  required WidgetBuilder builder,
}) {
  if (!workspace.ownsReview(epoch)) return Future<T?>.value();
  final registration = workspace.registerProtectedDialog(epoch);
  return _showOwnedResultsDialog<T>(
    context: context,
    workspace: workspace,
    registration: registration,
    builder: builder,
  );
}

Future<T?> _showOwnedResultsDialog<T>({
  required BuildContext context,
  required ResultsWorkspaceController workspace,
  required ResultsProtectedDialogRegistration registration,
  required WidgetBuilder builder,
}) async {
  try {
    return await showDialog<T>(
      context: context,
      builder: (dialog) => AnimatedBuilder(
        animation: workspace,
        builder: (context, _) {
          registration.attach(context);
          if (!registration.isValid) {
            registration.invalidate();
            return const SizedBox.shrink();
          }
          return builder(context);
        },
      ),
    );
  } finally {
    registration.dispose();
  }
}

Widget resultsResourceMessage<T>(
  ResultsResource<T> resource, {
  required Future<void> Function() onRetry,
  required String label,
}) {
  final title = switch (resource.phase) {
    ResultsResourcePhase.forbidden => 'Bạn không có quyền xem kết quả này',
    ResultsResourcePhase.verifyingAuthorization =>
      'Đang xác minh quyền truy cập kết quả',
    ResultsResourcePhase.authorizationVerificationFailed =>
      'Chưa thể xác minh quyền truy cập kết quả',
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
    onRetry:
        resource.phase == ResultsResourcePhase.failed ||
            resource.phase == ResultsResourcePhase.notReady ||
            resource.phase == ResultsResourcePhase.forbidden ||
            resource.phase ==
                ResultsResourcePhase.authorizationVerificationFailed
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
