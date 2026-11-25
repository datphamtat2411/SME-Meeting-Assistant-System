import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import '../../core/app_theme.dart';
import '../../core/command_actions.dart';
import '../../core/widgets.dart';
import 'results_workspace_controller.dart';
import 'results_presentation.dart';

class DecisionsReviewPanel extends StatefulWidget {
  const DecisionsReviewPanel({super.key, required this.workspace});
  final ResultsWorkspaceController workspace;

  @override
  State<DecisionsReviewPanel> createState() => _DecisionsReviewPanelState();
}

class _DecisionsReviewPanelState extends State<DecisionsReviewPanel> {
  bool busy = false;

  @override
  void initState() {
    super.initState();
    unawaited(widget.workspace.loadDecisions());
  }

  Future<void> createDecision() async {
    final epoch = widget.workspace.reviewEpoch;
    if (widget.workspace.decisionOutcomeUnknown) {
      final reviewed = await runCommand(
        context,
        operation: () async {
          if (!await widget.workspace.reconcileUnknownDecision(epoch: epoch)) {
            throw const ApiFailure(409, 'RESULTS_OUTCOME_UNKNOWN',
              'Không thể xác minh quyết định trước đó.');
          }
        },
        successText: 'Đã tải lại danh sách quyết định.',
      );
      if (!reviewed || !mounted) return;
      final confirmed = await showResultsReviewDialog<bool>(
        context: context,
        workspace: widget.workspace,
        epoch: epoch,
        builder: (dialog) => AlertDialog(
          title: const Text('Kiểm tra quyết định trước đó'),
          content: const Text('Yêu cầu trước có thể đã được lưu. Hãy xem danh sách quyết định hiện tại trước khi tạo một yêu cầu mới.'),
          actions: [
            TextButton(onPressed: () => Navigator.pop(dialog, false), child: const Text('Quay lại danh sách')),
            FilledButton(onPressed: () => Navigator.pop(dialog, true), child: const Text('Đã kiểm tra, tạo mới')),
          ],
        ),
      );
      if (confirmed != true || !mounted) return;
      widget.workspace.acknowledgeUnknownDecision(epoch: epoch);
    }
    final controller = TextEditingController();
    final ok = await showResultsReviewDialog<bool>(
      context: context,
      workspace: widget.workspace,
      epoch: epoch,
      builder: (dialog) => AlertDialog(
        title: const Text('Tạo quyết định'),
        content: SizedBox(
          width: 480,
          child: TextField(
            controller: controller,
            minLines: 3,
            maxLines: 8,
            maxLength: 5000,
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialog, false),
            child: const Text('Hủy'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialog, true),
            child: const Text('Lưu'),
          ),
        ],
      ),
    );
    final value = controller.text.trim();
    controller.dispose();
    if (ok != true || value.isEmpty || !mounted) return;
    setState(() => busy = true);
    await runCommand(
      context,
      operation: () => widget.workspace.createDecision(value, epoch: epoch),
      successText: 'Đã lưu quyết định.',
    );
    if (mounted) setState(() => busy = false);
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.workspace,
    builder: (context, _) {
      final resource = widget.workspace.decisions;
      final items = resource.data?.items;
      return Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 14, 18, 6),
            child: SectionHeading(
              'Quyết định',
              subtitle:
                  'Đề xuất AI cần xác nhận trước khi trở thành chính thức.',
              trailing: IconButton(
                onPressed: busy || widget.workspace.mutationBusy(ResultsMutationGroup.decisions) || !widget.workspace.capabilities.canMutate
                    ? null
                    : createDecision,
                icon: const Icon(Icons.add_circle_outline),
              ),
            ),
          ),
          Expanded(
            child: RefreshIndicator(
              onRefresh: () => widget.workspace.loadDecisions(force: true),
              child: ListView(
                padding: const EdgeInsets.all(18),
                children: [
                  resultsRefreshNotice(resource, () => widget.workspace.loadDecisions(force: true)),
                  if (items == null)
                    resultsResourceMessage(resource, label: 'Quyết định',
                      onRetry: () => widget.workspace.loadDecisions(force: true))

                  else if (items.isEmpty)
                    const MessagePanel(title: 'Chưa có quyết định')
                  else
                    ...items.map(
                      (decision) => ContentCard(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                StatePill(decision.status),
                                if (decision.stale)
                                  const Padding(
                                    padding: EdgeInsets.only(left: 8),
                                    child: StatePill(
                                      'COMPLETED_WITH_WARNINGS',
                                      label: 'Cần đối chiếu',
                                    ),
                                  ),
                              ],
                            ),
                            const SizedBox(height: 9),
                            SelectableText(decision.content),
                            if (decision.stale)
                              const Text(
                                'Nguồn transcript đã thay đổi; cần đối chiếu trước khi sử dụng.',
                                style: TextStyle(
                                  fontSize: 12,
                                  color: Palette.muted,
                                ),
                              ),
                          ],
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ],
      );
    },
  );
}
