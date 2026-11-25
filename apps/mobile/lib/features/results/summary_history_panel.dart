import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/app_theme.dart';
import '../../core/command_actions.dart';
import '../../core/widgets.dart';
import 'results_models.dart';
import 'results_workspace_controller.dart';
import 'results_presentation.dart';

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
  }

  Future<void> edit(ResultsSummary summary) async {
    final epoch = widget.workspace.reviewEpoch;
    final draftKey = 'summary:${summary.meetingId}';
    final preserved = widget.workspace.recoveryDraft(draftKey);
    var initial = widget.workspace.draftFor(
      draftKey,
      resourceId: summary.id,
      reviewedToken: summary.etag,
      epoch: epoch,
    );
    if (preserved != null && initial == null) {
      final choice = await showResultsDraftConflictDialog(
        context: context,
        workspace: widget.workspace,
        epoch: epoch,
        currentContent: summary.content,
        preservedDraft: preserved.content,
      );
      if (!mounted || !widget.workspace.ownsReview(epoch)) return;
      if (choice == ResultsDraftConflictChoice.discard) {
        widget.workspace.clearDraft(draftKey, epoch);
        return;
      }
      if (choice == ResultsDraftConflictChoice.cancel) return;
      initial = preserved.content;
    }
    final controller = TextEditingController(text: initial ?? summary.content);
    final ok = await showResultsReviewDialog<bool>(
      context: context,
      workspace: widget.workspace,
      epoch: epoch,
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
    if (ok != true || !mounted || !widget.workspace.ownsReview(epoch)) {
      controller.dispose();
      return;
    }
    final value = controller.text.trim();
    controller.dispose();
    if (value.isEmpty) return;
    setState(() => busy = true);
    widget.workspace.keepDraft(
      draftKey,
      value,
      epoch,
      resourceId: summary.id,
      reviewedToken: summary.etag,
    );
    final saved = await runCommand(
      context,
      operation: () =>
          widget.workspace.editSummary(summary, value, epoch: epoch),
      successText: 'Đã lưu phiên bản mới.',
    );
    if (saved) widget.workspace.clearDraft(draftKey, epoch);
    if (mounted) setState(() => busy = false);
  }

  Future<void> activateVersion(
    ResultsSummary summary,
    SummaryVersion version,
  ) async {
    final epoch = widget.workspace.reviewEpoch;
    final confirmed = await showResultsReviewDialog<bool>(
      context: context,
      workspace: widget.workspace,
      epoch: epoch,
      builder: (dialog) => AlertDialog(
        title: Text('Kích hoạt phiên bản ${version.versionNumber}?'),
        content: SingleChildScrollView(child: Text(version.content)),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialog, false),
            child: const Text('Hủy'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialog, true),
            child: const Text('Kích hoạt'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted || !widget.workspace.ownsReview(epoch)) {
      return;
    }
    setState(() => busy = true);
    await runCommand(
      context,
      operation: () => widget.workspace.activateSummaryVersion(
        summary,
        version,
        epoch: epoch,
      ),
      successText: 'Đã kích hoạt phiên bản.',
    );
    if (mounted) setState(() => busy = false);
  }

  Future<void> regenerate() async {
    final epoch = widget.workspace.reviewEpoch;
    final retry = widget.workspace.regenerationUncertain;
    final ok = await showResultsReviewDialog<bool>(
      context: context,
      workspace: widget.workspace,
      epoch: epoch,
      builder: (dialog) => AlertDialog(
        title: Text(
          retry ? 'Kiểm tra lại yêu cầu trước?' : 'Tạo lại tóm tắt AI?',
        ),
        content: Text(
          retry
              ? 'Tiếp tục cùng yêu cầu đã gửi; không tạo một yêu cầu mới.'
              : 'Tạo một tác vụ xử lý mới. Phiên bản cũ vẫn được lưu.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialog, false),
            child: const Text('Hủy'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialog, true),
            child: const Text('Xác nhận'),
          ),
        ],
      ),
    );
    if (ok != true || !mounted || !widget.workspace.ownsReview(epoch)) return;
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
      final current = widget.workspace.summary.hasData
          ? widget.workspace.summary.data
          : null;
      final versions = widget.workspace.summaryVersions.hasData
          ? widget.workspace.summaryVersions.data?.items
          : null;
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
            resultsResourceMessage(
              widget.workspace.summary,
              label: 'Tóm tắt',
              onRetry: () => widget.workspace.loadSummary(force: true),
            )
          else ...[
            resultsRefreshNotice(
              widget.workspace.summary,
              () => widget.workspace.loadSummary(force: true),
            ),
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
                    onPressed:
                        busy ||
                            widget.workspace.mutationBusy(
                              ResultsMutationGroup.summary,
                            ) ||
                            !widget.workspace.capabilities.canMutate
                        ? null
                        : () => edit(current),
                    icon: const Icon(Icons.edit_outlined),
                    label: const Text('Chỉnh sửa'),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed:
                        busy ||
                            widget.workspace.mutationBusy(
                              ResultsMutationGroup.summary,
                            ) ||
                            !widget.workspace.capabilities.canMutate ||
                            widget.workspace.acceptedRegenerationJobId != null
                        ? null
                        : regenerate,
                    icon: const Icon(Icons.auto_awesome),
                    label: Text(
                      widget.workspace.acceptedRegenerationJobId != null
                          ? 'Đang xử lý'
                          : widget.workspace.regenerationUncertain
                          ? 'Kiểm tra lại'
                          : 'Tạo lại AI',
                    ),
                  ),
                ),
              ],
            ),
          ],
          const SizedBox(height: 16),
          const SectionHeading('Lịch sử phiên bản'),
          if (versions == null)
            resultsResourceMessage(
              widget.workspace.summaryVersions,
              label: 'Lịch sử phiên bản',
              onRetry: () => widget.workspace.loadSummaryVersions(force: true),
            )
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
                                  widget.workspace.mutationBusy(
                                    ResultsMutationGroup.summary,
                                  ) ||
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
