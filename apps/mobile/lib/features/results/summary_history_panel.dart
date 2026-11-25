import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/app_theme.dart';
import '../../core/command_actions.dart';
import '../../core/widgets.dart';
import 'results_models.dart';
import 'results_workspace_controller.dart';

class SummaryHistoryPanel extends StatefulWidget {
  const SummaryHistoryPanel({super.key, required this.workspace});
  final ResultsWorkspaceController workspace;

  @override
  State<SummaryHistoryPanel> createState() => _SummaryHistoryPanelState();
}

class _SummaryHistoryPanelState extends State<SummaryHistoryPanel> {
  bool busy = false;

  @override
  void initState() {
    super.initState();
    unawaited(widget.workspace.loadSummary());
    unawaited(widget.workspace.loadSummaryVersions());
  }

  Future<void> edit(ResultsSummary summary) async {
    final epoch = widget.workspace.reviewEpoch;
    final controller = TextEditingController(text: summary.content);
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialog) => AlertDialog(
        title: const Text('Chỉnh sửa tóm tắt'),
        content: SizedBox(
          width: 500,
          child: TextField(
            controller: controller,
            maxLength: 20000,
            minLines: 5,
            maxLines: 12,
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
      operation: () => widget.workspace.editSummary(summary, value, epoch: epoch),
      successText: 'Đã lưu phiên bản mới.',
    );
    if (mounted) setState(() => busy = false);
  }

  Future<void> activateVersion(
    ResultsSummary summary,
    SummaryVersion version,
  ) async {
    setState(() => busy = true);
    await runCommand(
      context,
      operation: () =>
          widget.workspace.activateSummaryVersion(summary, version, epoch: widget.workspace.reviewEpoch),
      successText: 'Đã kích hoạt phiên bản.',
    );
    if (mounted) setState(() => busy = false);
  }

  Future<void> regenerate() async {
    final epoch = widget.workspace.reviewEpoch;
    final ok = await confirmCommand(
      context,
      title: 'Tạo lại tóm tắt AI?',
      description: 'Tạo một tác vụ xử lý mới. Phiên bản cũ vẫn được lưu.',
      confirmLabel: 'Tạo tác vụ',
    );
    if (!ok || !mounted) return;
    setState(() => busy = true);
    await runCommand(
      context,
      operation: () => widget.workspace.regenerateSummary(epoch: epoch),
      successText: 'Đã tiếp nhận tác vụ xử lý.',
    );
    if (mounted) setState(() => busy = false);
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.workspace,
    builder: (context, _) {
      final current = widget.workspace.summary.data;
      final versions = widget.workspace.summaryVersions.data?.items;
      return ListView(
        padding: const EdgeInsets.all(18),
        children: [
          SectionHeading(
            'Tóm tắt cuộc họp',
            trailing: IconButton(
              onPressed: () {
                unawaited(widget.workspace.loadSummary(force: true));
                unawaited(widget.workspace.loadSummaryVersions(force: true));
              },
              icon: const Icon(Icons.refresh),
            ),
          ),
          if (current == null)
            MessagePanel(
              title:
                  widget.workspace.summary.phase ==
                      ResultsResourcePhase.forbidden
                  ? 'Bạn không có quyền xem kết quả này'
                  : 'Tóm tắt chưa sẵn sàng',
              onRetry:
                  widget.workspace.summary.phase == ResultsResourcePhase.failed
                  ? () => unawaited(widget.workspace.loadSummary(force: true))
                  : null,
            )
          else ...[
            ContentCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          'Phiên bản ${current.versionNumber}',
                          style: const TextStyle(fontWeight: FontWeight.w700),
                        ),
                      ),
                      if (current.isStale)
                        const StatePill(
                          'COMPLETED_WITH_WARNINGS',
                          label: 'Nguồn đã cập nhật',
                        ),
                    ],
                  ),
                  const SizedBox(height: 10),
                  SelectableText(current.content),
                  if (current.aiWarnings.isNotEmpty)
                    Text(
                      current.aiWarnings.join('\n'),
                      style: const TextStyle(color: Palette.amber),
                    ),
                ],
              ),
            ),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: busy || widget.workspace.mutationBusy(ResultsMutationGroup.summary) || !widget.workspace.capabilities.canMutate
                        ? null
                        : () => edit(current),
                    icon: const Icon(Icons.edit_outlined),
                    label: const Text('Chỉnh sửa'),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: busy || widget.workspace.mutationBusy(ResultsMutationGroup.summary) || !widget.workspace.capabilities.canMutate
                        ? null
                        : regenerate,
                    icon: const Icon(Icons.auto_awesome),
                    label: const Text('Tạo lại AI'),
                  ),
                ),
              ],
            ),
          ],
          const SizedBox(height: 16),
          const SectionHeading('Lịch sử phiên bản'),
          if (versions == null)
            const MessagePanel(title: 'Chưa tải được lịch sử phiên bản')
          else if (versions.isEmpty)
            const MessagePanel(title: 'Chưa có lịch sử')
          else
            ...versions.map(
              (version) => ContentCard(
                child: ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text('Phiên bản ${version.versionNumber}'),
                  subtitle: Text(
                    '${version.sourceType} · ${version.qualityStatus}',
                  ),
                  trailing: version.isCurrent
                      ? const StatePill('CONFIRMED', label: 'Hiện tại')
                      : TextButton(
                          onPressed:
                              busy ||
                                  widget.workspace.mutationBusy(ResultsMutationGroup.summary) ||
                                  version.isStale ||
                                  current == null ||
                                  !widget.workspace.capabilities.canMutate
                              ? null
                              : () => activateVersion(current, version),
                          child: const Text('Kích hoạt'),
                        ),
                ),
              ),
            ),
        ],
      );
    },
  );
}
