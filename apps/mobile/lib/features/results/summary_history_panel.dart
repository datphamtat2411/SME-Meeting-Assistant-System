import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/app_theme.dart';
import '../../core/command_actions.dart';
import '../../core/widgets.dart';
import '../recording/media_contracts.dart';
import '../recording/processing_presentation.dart';
import 'results_models.dart';
import 'result_status_presentation.dart';
import 'results_workspace_controller.dart';
import 'results_presentation.dart';
import 'summary_history_controller.dart';

class SummaryHistoryPanel extends StatefulWidget {
  const SummaryHistoryPanel({super.key, required this.workspace});
  final ResultsWorkspaceController workspace;

  @override
  State<SummaryHistoryPanel> createState() => _SummaryHistoryPanelState();
}

class _SummaryHistoryPanelState extends State<SummaryHistoryPanel> {
  bool busy = false;
  SummaryHistoryController get history => widget.workspace.summaryHistory;

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
    if (!retry) {
      await widget.workspace.loadTranscript(force: true);
      if (!mounted || !widget.workspace.ownsReview(epoch)) return;
      final source = widget.workspace.transcript.data;
      if (!widget.workspace.transcriptIsCurrent ||
          source == null ||
          source.finalizedAt == null ||
          !{'READY', 'READY_WITH_WARNINGS'}.contains(source.status) ||
          source.segments.isEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Cần bản ghi hoàn chỉnh trước khi tạo tóm tắt.'),
          ),
        );
        return;
      }
    }
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

  Future<void> compare(ResultsSummary current, SummaryVersion version) async {
    final epoch = widget.workspace.readEpoch;
    await showResultsReviewDialog<void>(
      context: context,
      workspace: widget.workspace,
      epoch: epoch,
      requiresMutation: false,
      builder: (dialog) => AnimatedBuilder(
        animation: widget.workspace,
        builder: (context, _) => AlertDialog(
          title: Text(
            'So sánh phiên bản ${current.versionNumber} và ${version.versionNumber}',
          ),
          content: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (widget.workspace.summary.data?.etag != current.etag)
                  const MessagePanel(
                    title: 'Phiên bản đang chọn đã thay đổi',
                    description: 'Đây là nội dung tại thời điểm mở so sánh.',
                  ),
                const Text(
                  'Bản đã xem khi mở so sánh',
                  style: TextStyle(fontWeight: FontWeight.w700),
                ),
                SelectableText(current.content),
                const Divider(height: 28),
                Text(
                  'Bản lịch sử · ${resultSourceLabel(version.sourceType)}',
                  style: const TextStyle(fontWeight: FontWeight.w700),
                ),
                SelectableText(version.content),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialog),
              child: const Text('Đóng'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _regenerationStatus() {
    final workspace = widget.workspace;
    final job = workspace.regenerationJob;
    final label = workspace.regenerationAdmitting
        ? 'Đang gửi yêu cầu tạo tóm tắt'
        : workspace.regenerationUncertain
        ? 'Chưa xác định yêu cầu đã được tiếp nhận hay chưa'
        : workspace.regenerationAdmissionRejected
        ? 'Yêu cầu tạo tóm tắt chưa được chấp nhận'
        : switch (job?.status) {
            ProcessingJobStatus.pending => 'Đã tiếp nhận, đang chờ xử lý',
            ProcessingJobStatus.queued => 'Đang trong hàng đợi',
            ProcessingJobStatus.running => 'AI đang tạo tóm tắt',
            ProcessingJobStatus.waitingForReview => 'Đang chờ xem xét',
            ProcessingJobStatus.completed => 'Tác vụ tạo tóm tắt đã hoàn tất',
            ProcessingJobStatus.completedWithWarnings =>
              'Tác vụ đã hoàn tất nhưng có cảnh báo',
            ProcessingJobStatus.failed => 'Tạo tóm tắt thất bại',
            ProcessingJobStatus.cancelled => 'Tác vụ tạo tóm tắt đã bị hủy',
            null =>
              workspace.acceptedRegenerationJobId != null
                  ? 'Đã tiếp nhận, đang xác minh tiến trình'
                  : null,
          };
    if (label == null) return const SizedBox.shrink();
    return ContentCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: const TextStyle(fontWeight: FontWeight.w700)),
          if (job != null)
            StatePill(job.status.wireValue, label: processingJobStatusLabel(job.status)),
          if (job?.warningSummary != null)
            Text(
              job!.warningSummary!,
              style: const TextStyle(color: Palette.amber),
            ),
          if (job?.errorSummary != null)
            Text(
              processingFailureLabel(job!.errorCode, job!.errorSummary),
              style: const TextStyle(color: Palette.red),
            ),
          if (job?.status.isSuccessful == true)
            const Text('Kiểm tra phiên bản đang chọn và lịch sử từ máy chủ.'),
          if (workspace.acceptedRegenerationJobId != null &&
              workspace.processingManager != null)
            TextButton(
              onPressed: () => unawaited(
                workspace.processingManager!.refresh(
                  workspace.meetingId,
                  scope: workspace.sessionScope,
                  explicit: true,
                ),
              ),
              child: const Text('Cập nhật tiến trình'),
            ),
        ],
      ),
    );
  }

  Widget _regenerationButton({required bool hasSummary}) {
    final workspace = widget.workspace;
    return OutlinedButton.icon(
      onPressed:
          busy ||
              workspace.mutationBusy(ResultsMutationGroup.summary) ||
              !workspace.capabilities.canMutate ||
              workspace.acceptedRegenerationJobId != null
          ? null
          : regenerate,
      icon: const Icon(Icons.auto_awesome),
      label: Text(
        workspace.acceptedRegenerationJobId != null
            ? 'Đang xử lý'
            : workspace.regenerationUncertain
            ? 'Kiểm tra lại'
            : hasSummary
            ? 'Tạo lại AI'
            : 'Tạo tóm tắt AI',
      ),
    );
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: Listenable.merge(<Listenable>[widget.workspace, history]),
    builder: (context, _) {
      final current = widget.workspace.summary.hasData
          ? widget.workspace.summary.data
          : null;
      final versions = history.items;
      return ListView(
        padding: const EdgeInsets.all(18),
        children: [
          SectionHeading(
            'Tóm tắt cuộc họp',
            trailing: IconButton(
              onPressed: () {
                unawaited(widget.workspace.loadSummary(force: true));
                unawaited(history.load(refresh: true));
              },
              icon: const Icon(Icons.refresh),
            ),
          ),
          _regenerationStatus(),
          if (current == null) ...[
            resultsResourceMessage(
              widget.workspace.summary,
              label: 'Tóm tắt',
              onRetry: () => widget.workspace.loadSummary(force: true),
            ),
            if (widget.workspace.summary.phase ==
                    ResultsResourcePhase.notReady ||
                widget.workspace.regenerationUncertain ||
                widget.workspace.acceptedRegenerationJobId != null)
              _regenerationButton(hasSummary: false),
          ] else ...[
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
                      Text(
                        resultSourceLabel(current.sourceType),
                        style: const TextStyle(color: Palette.muted),
                      ),
                      if (current.isStale)
                        const StatePill(
                          'COMPLETED_WITH_WARNINGS',
                          label: 'Nguồn đã thay đổi',
                        ),
                    ],
                  ),
                  const SizedBox(height: 10),
                  Text(
                    'Chất lượng: ${summaryQualityLabel(current.qualityStatus)}',
                    style: const TextStyle(color: Palette.muted),
                  ),
                  if (current.transcriptId != null)
                    Text(
                      'Nguồn bản ghi: ${current.transcriptId} · lần chỉnh sửa ${current.contentRevision ?? '—'}',
                      style: const TextStyle(
                        fontSize: 11,
                        color: Palette.muted,
                      ),
                    ),
                  const SizedBox(height: 8),
                  SelectableText(current.content),
                  if (current.aiProducer != null)
                    Text(
                      'Nhà sản xuất AI: ${current.aiProducer!['model'] ?? current.aiProducer!['provider'] ?? 'Không rõ'}',
                      style: const TextStyle(
                        fontSize: 11,
                        color: Palette.muted,
                      ),
                    ),
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
                Expanded(child: _regenerationButton(hasSummary: true)),
              ],
            ),
          ],
          const SizedBox(height: 16),
          const SectionHeading('Lịch sử phiên bản'),
          if (history.phase == SummaryHistoryPhase.loading ||
              history.phase == SummaryHistoryPhase.refreshing)
            const LinearProgressIndicator(),
          if (history.phase == SummaryHistoryPhase.failed)
            MessagePanel(
              title: 'Không thể tải lịch sử phiên bản',
              onRetry: () => unawaited(history.load(refresh: true)),
            )
          else if (history.phase == SummaryHistoryPhase.forbidden)
            const MessagePanel(title: 'Bạn không có quyền xem lịch sử này')
          else if (versions.isEmpty && !history.isLoading)
            const MessagePanel(title: 'Chưa có lịch sử'),
          if (versions.isNotEmpty)
            ...versions.map(
              (version) => ContentCard(
                child: ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text('Phiên bản ${version.versionNumber}'),
                  subtitle: Text(
                    '${resultSourceLabel(version.sourceType)} · ${summaryQualityLabel(version.qualityStatus)}'
                    '${version.isStale ? ' · Nguồn đã cũ' : ''}'
                    '${current?.id == version.id ? ' · Đang chọn' : ''}',
                  ),
                  trailing: PopupMenuButton<String>(
                    onSelected: (value) {
                      if (value == 'compare' && current != null) {
                        unawaited(compare(current, version));
                      } else if (value == 'activate' && current != null) {
                        unawaited(activateVersion(current, version));
                      }
                    },
                    itemBuilder: (context) => [
                      const PopupMenuItem(
                        value: 'compare',
                        child: Text('So sánh'),
                      ),
                      if (current?.id != version.id &&
                          history.phase == SummaryHistoryPhase.available &&
                          !version.isStale &&
                          current != null &&
                          widget.workspace.capabilities.canMutate)
                        const PopupMenuItem(
                          value: 'activate',
                          child: Text('Kích hoạt'),
                        ),
                    ],
                  ),
                ),
              ),
            ),
          if (history.hasMore)
            OutlinedButton.icon(
              onPressed: history.isLoading
                  ? null
                  : () => unawaited(history.loadMore()),
              icon: const Icon(Icons.expand_more),
              label: const Text('Tải thêm phiên bản'),
            ),
        ],
      );
    },
  );
}
