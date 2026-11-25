import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/app_theme.dart';
import '../../core/command_actions.dart';
import '../../core/widgets.dart';
import 'results_models.dart';
import 'results_workspace_controller.dart';

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
    final controller = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
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
      operation: () => widget.workspace.createDecision(value),
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
                onPressed: busy || !widget.workspace.capabilities.canMutate
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
                  if (items == null)
                    MessagePanel(
                      title: resource.phase == ResultsResourcePhase.forbidden
                          ? 'Bạn không có quyền xem kết quả này'
                          : 'Quyết định chưa sẵn sàng',
                      onRetry: resource.phase == ResultsResourcePhase.failed
                          ? () => unawaited(
                              widget.workspace.loadDecisions(force: true),
                            )
                          : null,
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
