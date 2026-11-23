import 'package:flutter/material.dart';
import 'api_client.dart';
import 'widgets.dart';

Future<bool> confirmCommand(
  BuildContext context, {
  required String title,
  required String description,
  String confirmLabel = 'Xác nhận',
  bool destructive = false,
}) async {
  final answer = await showDialog<bool>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      title: Text(title),
      content: Text(description),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(dialogContext, false),
          child: const Text('Quay lại'),
        ),
        FilledButton(
          style: destructive
              ? FilledButton.styleFrom(
                  backgroundColor: Theme.of(dialogContext).colorScheme.error,
                  foregroundColor: Theme.of(dialogContext).colorScheme.onError)
              : null,
          onPressed: () => Navigator.pop(dialogContext, true),
          child: Text(confirmLabel),
        ),
      ],
    ),
  );
  return answer == true;
}

Future<bool> runCommand(
  BuildContext context, {
  required Future<void> Function() operation,
  String successText = 'Đã cập nhật.',
}) async {
  try {
    await operation();
    if (context.mounted) showSuccess(context, successText);
    return true;
  } on ApiFailure catch (failure) {
    if (context.mounted) showFailure(context, failure);
    return false;
  } catch (_) {
    if (context.mounted) {
      showFailure(context, const ApiFailure(
          0, 'UNEXPECTED_FAILURE', 'Không thể thực hiện thao tác.'));
    }
    return false;
  }
}

String requireEtag(ApiResult response) {
  final tag = response.etag;
  if (tag == null || tag.isEmpty) {
    throw const ApiFailure(0, 'VERSION_MISSING',
        'Không nhận được phiên bản dữ liệu. Vui lòng tải lại.');
  }
  return tag;
}
