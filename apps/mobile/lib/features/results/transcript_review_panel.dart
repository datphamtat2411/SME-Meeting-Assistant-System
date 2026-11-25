import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/app_theme.dart';
import '../../core/command_actions.dart';
import '../../core/date_labels.dart';
import '../../core/meeting_models.dart';
import '../../core/widgets.dart';
import 'results_workspace_controller.dart';
import 'results_presentation.dart';
import 'results_models.dart';
import 'transcript_evidence_navigation.dart';

class TranscriptReviewPanel extends StatefulWidget {
  const TranscriptReviewPanel({super.key, required this.workspace});
  final ResultsWorkspaceController workspace;

  @override
  State<TranscriptReviewPanel> createState() => _TranscriptReviewPanelState();
}

class _TranscriptReviewPanelState extends State<TranscriptReviewPanel> {
  final search = TextEditingController();
  String speakerFilter = 'Tất cả';
  String qualityFilter = 'Tất cả';

  TranscriptEvidenceNavigationBoundary get evidenceNavigation =>
      TranscriptEvidenceNavigationBoundary(widget.workspace);

  @override
  void initState() {
    super.initState();
  }

  @override
  void dispose() {
    search.dispose();
    super.dispose();
  }

  Future<void> edit(SpeechSegment segment) async {
    final epoch = widget.workspace.reviewEpoch;
    final draftKey = 'segment:${segment.id}';
    final preserved = widget.workspace.recoveryDraft(draftKey);
    var initial = widget.workspace.draftFor(
      draftKey,
      resourceId: segment.id,
      reviewedToken: segment.etag ?? '',
      epoch: epoch,
    );
    if (preserved != null && initial == null) {
      final choice = await showResultsDraftConflictDialog(
        context: context,
        workspace: widget.workspace,
        epoch: epoch,
        currentContent: segment.text,
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
    final controller = TextEditingController(text: initial ?? segment.text);
    final reasonController = TextEditingController();
    final ok = await showResultsReviewDialog<bool>(
      context: context,
      workspace: widget.workspace,
      epoch: epoch,
      builder: (dialog) => AlertDialog(
        title: const Text('Chỉnh sửa đoạn transcript'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: controller,
              maxLength: 20000,
              minLines: 3,
              maxLines: 8,
              decoration: const InputDecoration(labelText: 'Nội dung hiện tại'),
            ),
            TextField(
              controller: reasonController,
              maxLength: 1000,
              maxLines: 2,
              decoration: const InputDecoration(
                labelText: 'Lý do chỉnh sửa (không bắt buộc)',
              ),
            ),
          ],
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
      reasonController.dispose();
      return;
    }
    final value = controller.text.trim();
    final reason = reasonController.text.trim();
    controller.dispose();
    reasonController.dispose();
    if (value.isEmpty) return;
    widget.workspace.keepDraft(
      draftKey,
      value,
      epoch,
      resourceId: segment.id,
      reviewedToken: segment.etag ?? '',
    );
    final saved = await runCommand(
      context,
      operation: () => widget.workspace.correctSegment(
        segment,
        value,
        epoch: epoch,
        reason: reason.isEmpty ? null : reason,
      ),
      successText: 'Đã cập nhật transcript.',
    );
    if (saved) widget.workspace.clearDraft(draftKey, epoch);
  }

  String _fold(String value) => value
      .toLowerCase()
      .replaceAllMapped(RegExp('[àáạảãâầấậẩẫăằắặẳẵ]'), (_) => 'a')
      .replaceAllMapped(RegExp('[èéẹẻẽêềếệểễ]'), (_) => 'e')
      .replaceAllMapped(RegExp('[ìíịỉĩ]'), (_) => 'i')
      .replaceAllMapped(RegExp('[òóọỏõôồốộổỗơờớợởỡ]'), (_) => 'o')
      .replaceAllMapped(RegExp('[ùúụủũưừứựửữ]'), (_) => 'u')
      .replaceAllMapped(RegExp('[ỳýỵỷỹ]'), (_) => 'y')
      .replaceAll('đ', 'd');

  String _qualityLabel(String quality) => switch (quality) {
    'ACCEPTED' => 'Đã chấp nhận',
    'SUSPICIOUS' => 'Cần kiểm tra',
    'UNRESOLVED' => 'Chưa giải quyết',
    _ => quality,
  };

  Widget _coverageOverview(TranscriptCoverage? coverage) {
    if (coverage == null) {
      return widget.workspace.coverage.phase == ResultsResourcePhase.failed
          ? const MessagePanel(
              title: 'Chưa thể tải thông tin coverage',
              description: 'Transcript vẫn hiển thị; hãy thử tải coverage lại.',
            )
          : const SizedBox.shrink();
    }
    final concerns = coverage.regions
        .where((region) => region.status != 'COVERED')
        .toList(growable: false);
    return ContentCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Coverage âm thanh',
            style: TextStyle(fontWeight: FontWeight.w700),
          ),
          Text(
            concerns.isEmpty
                ? 'Toàn bộ vùng đã có bằng chứng giọng nói.'
                : '${concerns.length} vùng cần chú ý trong timeline.',
            style: const TextStyle(color: Palette.muted),
          ),
          ...concerns.map(
            (region) => ListTile(
              contentPadding: EdgeInsets.zero,
              leading: Icon(
                region.status == 'UNRESOLVED_ERROR'
                    ? Icons.error_outline
                    : Icons.warning_amber_outlined,
                color: region.status == 'UNRESOLVED_ERROR'
                    ? Palette.red
                    : Palette.amber,
              ),
              title: Text(
                '${durationLabel(region.startMs)}–${durationLabel(region.endMs)} · '
                '${region.status == 'UNRESOLVED_ERROR' ? 'Không khôi phục được' : 'Đáng ngờ'}',
              ),
              subtitle: Text(
                region.recovered
                    ? 'Đã khôi phục sau ${region.retryCount} lần thử'
                    : 'Chưa có bằng chứng khôi phục',
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _segmentCard(SpeechSegment segment) => ContentCard(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                segment.speakerLabel ?? 'Chưa xác định',
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
            ),
            Text(
              '${durationLabel(segment.startMs)}–${durationLabel(segment.endMs)}',
              style: const TextStyle(fontSize: 12, color: Palette.muted),
            ),
            IconButton(
              icon: const Icon(Icons.edit_note_outlined),
              onPressed:
                  widget.workspace.capabilities.canMutate &&
                      !widget.workspace.mutationBusy(
                        ResultsMutationGroup.transcript,
                      ) &&
                      segment.etag != null &&
                      segment.etag!.trim().isNotEmpty
                  ? () => edit(segment)
                  : null,
              tooltip: segment.etag == null
                  ? 'Thiếu phiên bản máy chủ; chỉ có thể đọc'
                  : 'Chỉnh sửa đoạn transcript',
            ),
          ],
        ),
        SelectableText(segment.text),
        if (segment.quality.isNotEmpty && segment.quality != 'ACCEPTED')
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: StatePill(
              segment.quality,
              label: _qualityLabel(segment.quality),
            ),
          ),
      ],
    ),
  );

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.workspace,
    builder: (context, _) {
      final resource = widget.workspace.transcript;
      final transcript = resource.hasData ? resource.data : null;
      if (transcript == null) {
        return resultsResourceMessage(
          resource,
          label: 'Transcript',
          onRetry: () => widget.workspace.loadTranscript(force: true),
        );
      }
      final query = _fold(search.text.trim());
      final speakers = <String>{
        'Tất cả',
        ...transcript.segments.map(
          (segment) => segment.speakerLabel ?? 'Chưa xác định',
        ),
      }.toList()..sort();
      final qualities = <String>{
        'Tất cả',
        ...transcript.segments.map((segment) => segment.quality),
      }.toList()..sort();
      final visible = transcript.segments
          .where((segment) {
            final matchesText =
                query.isEmpty ||
                _fold(segment.text).contains(query) ||
                _fold(segment.speakerLabel ?? '').contains(query);
            final matchesSpeaker =
                speakerFilter == 'Tất cả' ||
                (segment.speakerLabel ?? 'Chưa xác định') == speakerFilter;
            final matchesQuality =
                qualityFilter == 'Tất cả' || segment.quality == qualityFilter;
            return matchesText && matchesSpeaker && matchesQuality;
          })
          .toList(growable: false);
      if (!speakers.contains(speakerFilter)) speakerFilter = 'Tất cả';
      if (!qualities.contains(qualityFilter)) qualityFilter = 'Tất cả';
      return Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 12, 18, 4),
            child: TextField(
              controller: search,
              decoration: const InputDecoration(
                prefixIcon: Icon(Icons.search),
                hintText: 'Tìm lời nói hoặc nhãn người nói',
              ),
              onChanged: (_) => setState(() {}),
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 18),
            child: Row(
              children: [
                Expanded(
                  child: DropdownButton<String>(
                    isExpanded: true,
                    value: speakerFilter,
                    onChanged: (value) =>
                        setState(() => speakerFilter = value ?? 'Tất cả'),
                    items: speakers
                        .map(
                          (value) => DropdownMenuItem(
                            value: value,
                            child: Text(value, overflow: TextOverflow.ellipsis),
                          ),
                        )
                        .toList(),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: DropdownButton<String>(
                    isExpanded: true,
                    value: qualityFilter,
                    onChanged: (value) =>
                        setState(() => qualityFilter = value ?? 'Tất cả'),
                    items: qualities
                        .map(
                          (value) => DropdownMenuItem(
                            value: value,
                            child: Text(
                              value == 'Tất cả' ? value : _qualityLabel(value),
                            ),
                          ),
                        )
                        .toList(),
                  ),
                ),
              ],
            ),
          ),
          Expanded(
            child: RefreshIndicator(
              onRefresh: () async {
                await Future.wait([
                  widget.workspace.loadTranscript(force: true),
                  widget.workspace.loadCoverage(force: true),
                ]);
              },
              child: CustomScrollView(
                physics: const AlwaysScrollableScrollPhysics(),
                slivers: [
                  SliverPadding(
                    padding: const EdgeInsets.all(18),
                    sliver: SliverToBoxAdapter(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          SectionHeading(
                            'Transcript',
                            subtitle:
                                '${transcript.segments.length} đoạn phát biểu · '
                                'bản ${transcript.versionNumber} · ${transcript.status}',
                          ),
                          resultsRefreshNotice(
                            resource,
                            () => widget.workspace.loadTranscript(force: true),
                          ),
                          _coverageOverview(
                            widget.workspace.coverage.hasData
                                ? widget.workspace.coverage.data
                                : null,
                          ),
                          if (transcript.segments.isEmpty)
                            const MessagePanel(
                              title: 'Transcript trống theo dữ liệu chuẩn',
                            ),
                          if (transcript.segments.isNotEmpty && visible.isEmpty)
                            const MessagePanel(
                              title: 'Không tìm thấy nội dung phù hợp',
                            ),
                        ],
                      ),
                    ),
                  ),
                  if (visible.isNotEmpty)
                    SliverList(
                      delegate: SliverChildBuilderDelegate(
                        (context, index) => Padding(
                          padding: const EdgeInsets.fromLTRB(18, 0, 18, 10),
                          child: _segmentCard(visible[index]),
                        ),
                        childCount: visible.length,
                      ),
                    ),
                  const SliverPadding(padding: EdgeInsets.only(bottom: 24)),
                ],
              ),
            ),
          ),
        ],
      );
    },
  );
}
