import 'package:flutter/material.dart';

import '../../core/widgets.dart';
import 'profile_repository.dart';

/// Keeps a previously loaded, authorized resource visible during refresh.
class AccountResourceView<T> extends StatelessWidget {
  const AccountResourceView({
    super.key,
    required this.snapshot,
    required this.loading,
    required this.failure,
    required this.needsReconciliation,
    required this.retry,
    required this.builder,
  });

  final T? snapshot;
  final bool loading;
  final ProfileFailure? failure;
  final bool needsReconciliation;
  final VoidCallback retry;
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
            TextButton(onPressed: retry, child: const Text('Tải lại')),
          ],
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        builder(value),
        if (loading) const LinearProgressIndicator(),
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
                  onPressed: loading ? null : retry,
                  child: const Text('Tải lại'),
                ),
              ],
            ),
          ),
      ],
    );
  }
}
