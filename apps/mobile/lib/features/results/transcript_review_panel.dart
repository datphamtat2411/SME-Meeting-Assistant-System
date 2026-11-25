import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/app_theme.dart';
import '../../core/command_actions.dart';
import '../../core/date_labels.dart';
import '../../core/meeting_models.dart';
import '../../core/widgets.dart';
import 'results_workspace_controller.dart';
import 'results_presentation.dart';

class TranscriptReviewPanel extends StatefulWidget {
  const TranscriptReviewPanel({super.key, required this.workspace});
  final ResultsWorkspaceController workspace;

  @override
  State<TranscriptReviewPanel> createState() => _TranscriptReviewPanelState();
}

class _TranscriptReviewPanelState extends State<TranscriptReviewPanel> {
  final search = TextEditingController();

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
    final ok = await showResultsReviewDialog<bool>(
      context: context,
      workspace: widget.workspace,
      epoch: epoch,
      builder: (dialog) => AlertDialog(
        title: const Text('Chỉnh sửa đoạn transcript'),
        content: TextField(
          controller: controller,
          maxLength: 5000,
          minLines: 3,
          maxLines: 8,
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
    widget.workspace.keepDraft(
      draftKey,
      value,
      epoch,
      resourceId: segment.id,
      reviewedToken: segment.etag ?? '',
    );
    final saved = await runCommand(
      context,
      operation: () =>
          widget.workspace.correctSegment(segment, value, epoch: epoch),
      successText: 'Đã cập nhật transcript.',
    );
    if (saved) widget.workspace.clearDraft(draftKey, epoch);
  }

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
      final query = search.text.trim().toLowerCase();
      final visible = transcript.segments
          .where(
            (segment) =>
                segment.text.toLowerCase().contains(query) ||
                (segment.speakerLabel ?? '').toLowerCase().contains(query),
          )
          .toList();
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
          Expanded(
            child: RefreshIndicator(
              onRefresh: () => widget.workspace.loadTranscript(force: true),
              child: ListView(
                padding: const EdgeInsets.all(18),
                children: [
                  SectionHeading(
                    'Transcript',
                    subtitle:
                        '${transcript.segments.length} đoạn phát biểu có dấu thời gian',
                  ),
                  resultsRefreshNotice(
                    resource,
                    () => widget.workspace.loadTranscript(force: true),
                  ),
                  if (transcript.segments.isEmpty)
                    const MessagePanel(title: 'Transcript chưa sẵn sàng'),
                  if (transcript.segments.isNotEmpty && visible.isEmpty)
                    const MessagePanel(
                      title: 'Không tìm thấy nội dung phù hợp',
                    ),
                  ...visible.map(
                    (segment) => ContentCard(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              Expanded(
                                child: Text(
                                  segment.speakerLabel ?? 'Chưa xác định',
                                  style: const TextStyle(
                                    fontWeight: FontWeight.w700,
                                  ),
                                ),
                              ),
                              Text(
                                '${durationLabel(segment.startMs)}–${durationLabel(segment.endMs)}',
                                style: const TextStyle(
                                  fontSize: 12,
                                  color: Palette.muted,
                                ),
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
                                tooltip: 'Chỉnh sửa đoạn transcript',
                              ),
                            ],
                          ),
                          SelectableText(segment.text),
                          if (segment.quality.isNotEmpty &&
                              segment.quality != 'ACCEPTED')
                            Padding(
                              padding: const EdgeInsets.only(top: 8),
                              child: StatePill(segment.quality),
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
