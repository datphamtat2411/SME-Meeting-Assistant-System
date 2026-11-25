import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import '../../core/app_theme.dart';
import '../../core/command_actions.dart';
import '../../core/meeting_models.dart';
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
  }

  Future<void> createDecision() async {
    if (busy) return;
    setState(() => busy = true);
    try {
      await _createDecision();
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _createDecision() async {
    final workspace = widget.workspace;
    final epoch = workspace.reviewEpoch;
    List<MeetingDecision>? recovery;
    if (workspace.decisionOutcomeUnknown) {
      final reviewed = await runCommand(
        context,
        operation: () async {
          recovery = await workspace.reconcileUnknownDecision(epoch: epoch);
          if (recovery == null) {
            throw const ApiFailure(
              409,
              'RESULTS_OUTCOME_UNKNOWN',
              'Danh sách đã thay đổi hoặc không thể tải đầy đủ. Hãy thử lại.',
            );
          }
        },
        successText: 'Đã tải danh sách quyết định để kiểm tra.',
      );
      if (!reviewed || !mounted || !workspace.ownsReview(epoch)) return;
      final decisions = recovery!;
      final confirmed = await showResultsReviewDialog<bool>(
        context: context,
        workspace: workspace,
        epoch: epoch,
        builder: (dialog) => AlertDialog(
          title: const Text('Kiểm tra quyết định trước đó'),
          content: SizedBox(
            width: 480,
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Yêu cầu trước có thể đã được lưu. Danh sách này không '
                    'chứng minh yêu cầu thành công hay thất bại. Hãy kiểm tra '
                    'trước khi tạo một yêu cầu mới.',
                  ),
                  if (decisions.isEmpty)
                    const Text('Chưa có quyết định trong danh sách hiện tại.'),
                  for (final decision in decisions)
                    ListTile(
                      title: Text(decision.content),
                      subtitle: Text(decision.status),
                      contentPadding: EdgeInsets.zero,
                    ),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialog, false),
              child: const Text('Quay lại'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(dialog, true),
              child: const Text('Đã kiểm tra, tạo mới'),
            ),
          ],
        ),
      );
      if (confirmed != true || !mounted || !workspace.ownsReview(epoch)) {
        return;
      }
    }
    final controller = TextEditingController();
    final ok = await showResultsReviewDialog<bool>(
      context: context,
      workspace: workspace,
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
    if (ok != true ||
        !mounted ||
        !identical(widget.workspace, workspace) ||
        !workspace.ownsReview(epoch)) {
      controller.dispose();
      return;
    }
    final value = controller.text.trim();
    controller.dispose();
    if (value.isEmpty) {
      return;
    }
    await runCommand(
      context,
      operation: () async {
        final reviewed = recovery;
        if (reviewed != null) {
          workspace.acknowledgeUnknownDecision(
            epoch: epoch,
            reviewed: reviewed,
          );
        }
        await workspace.createDecision(value, epoch: epoch);
      },
      successText: 'Đã lưu quyết định.',
    );
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.workspace,
    builder: (context, _) {
      final resource = widget.workspace.decisions;
      final items = resource.hasData ? resource.data?.items : null;
      return Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 14, 18, 6),
            child: SectionHeading(
              'Quyết định',
              subtitle:
                  'Đề xuất AI cần xác nhận trước khi trở thành chính thức.',
              trailing: IconButton(
                onPressed:
                    busy ||
                        widget.workspace.mutationBusy(
                          ResultsMutationGroup.decisions,
                        ) ||
                        !widget.workspace.capabilities.canMutate
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
                  resultsRefreshNotice(
                    resource,
                    () => widget.workspace.loadDecisions(force: true),
                  ),
                  if (items == null)
                    resultsResourceMessage(
                      resource,
                      label: 'Quyết định',
                      onRetry: () =>
                          widget.workspace.loadDecisions(force: true),
                    )
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
