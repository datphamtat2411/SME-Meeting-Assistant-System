import 'package:flutter/material.dart';

import '../../core/widgets.dart';
import 'profile_repository.dart';

/// Keeps a previously loaded, authorized resource visible during refresh.
class AccountResourceView<T> extends StatelessWidget {
  const AccountResourceView({
    super.key,
    required this.snapshot,
    required this.loading,
    required this.saving,
    required this.failure,
    required this.needsReconciliation,
    required this.retry,
    this.canRetry = true,
    this.retryNotBefore,
    required this.builder,
  });

  final T? snapshot;
  final bool loading;
  final bool saving;
  final ProfileFailure? failure;
  final bool needsReconciliation;
  final VoidCallback retry;
  final bool canRetry;
  final DateTime? retryNotBefore;
  final Widget Function(T) builder;

  @override
  Widget build(BuildContext context) {
    final value = snapshot;
    if (value == null) {
      if (loading) {
        return const Center(child: CircularProgressIndicator());
      }
      return ContentCard(
        child: Column(
          children: [
            Text(failure?.message ?? 'Chưa tải được dữ liệu tài khoản.'),
            if (retryNotBefore case final deadline?)
              AccountRetryNotice(deadline: deadline),
            TextButton(
              onPressed: canRetry ? retry : null,
              child: const Text('Tải lại'),
            ),
          ],
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        builder(value),
        if (loading || saving) const LinearProgressIndicator(),
        if (retryNotBefore case final deadline?)
          AccountRetryNotice(deadline: deadline),
        if (failure != null || needsReconciliation)
          ContentCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  needsReconciliation
                      ? 'Cần tải lại dữ liệu từ máy chủ trước khi lưu tiếp.'
                      : failure!.message,
                ),
                TextButton(
                  onPressed: canRetry && !loading && !saving ? retry : null,
                  child: const Text('Tải lại'),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

/// Shared presentation for resource and identity cooldowns.
class AccountRetryNotice extends StatelessWidget {
  const AccountRetryNotice({super.key, required this.deadline});

  final DateTime deadline;

  @override
  Widget build(BuildContext context) {
    final local = deadline.toLocal();
    final localizations = MaterialLocalizations.of(context);
    final date = localizations.formatCompactDate(local);
    final time = localizations.formatTimeOfDay(
      TimeOfDay.fromDateTime(local),
      alwaysUse24HourFormat: true,
    );
    final seconds = local.second.toString().padLeft(2, '0');
    return Text(
      'Máy chủ đang giới hạn yêu cầu. Có thể thử lại từ '
      '$date, $time:$seconds.',
      style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant),
    );
  }
}
