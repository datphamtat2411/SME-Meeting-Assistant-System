import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/app_theme.dart';
import '../../core/command_actions.dart';
import '../../core/date_labels.dart';
import '../../core/meeting_models.dart';
import '../../core/widgets.dart';
import 'results_models.dart';
import 'results_workspace_controller.dart';

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
    unawaited(widget.workspace.loadTranscript());
  }

  @override
  void dispose() {
    search.dispose();
    super.dispose();
  }

  Future<void> edit(SpeechSegment segment) async {
    final controller = TextEditingController(text: segment.text);
    final ok = await showDialog<bool>(
      context: context,
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
    final value = controller.text.trim();
    controller.dispose();
    if (ok != true || value.isEmpty || !mounted) return;
    await runCommand(
      context,
      operation: () => widget.workspace.correctSegment(segment, value),
      successText: 'Đã cập nhật transcript.',
    );
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.workspace,
    builder: (context, _) {
      final resource = widget.workspace.transcript;
      final transcript = resource.data;
      if (transcript == null) {
        return _resourceMessage(
          resource,
          onRetry: widget.workspace.loadTranscript,
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
                  if (resource.phase == ResultsResourcePhase.refreshing)
                    const LinearProgressIndicator(),
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
                                    widget.workspace.capabilities.canMutate
                                    ? () => edit(segment)
                                    : null,
                                tooltip: 'Chỉnh sửa đoạn transcript',
                              ),
                            ],
                          ),
                          SelectableText(segment.text),
                          if (segment.quality.isNotEmpty &&
                              segment.quality != 'OK')
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

Widget _resourceMessage<T>(
  ResultsResource<T> resource, {
  required Future<void> Function() onRetry,
}) {
  final title = switch (resource.phase) {
    ResultsResourcePhase.forbidden => 'Bạn không có quyền xem kết quả này',
    ResultsResourcePhase.notReady => 'Transcript chưa sẵn sàng',
    ResultsResourcePhase.failed => 'Không thể tải transcript',
    ResultsResourcePhase.loading ||
    ResultsResourcePhase.uninitialized ||
    ResultsResourcePhase.refreshing => 'Đang tải transcript',
    ResultsResourcePhase.empty => 'Transcript chưa sẵn sàng',
    ResultsResourcePhase.available => 'Transcript chưa sẵn sàng',
  };
  return MessagePanel(
    title: title,
    onRetry: resource.phase == ResultsResourcePhase.failed
        ? () => unawaited(onRetry())
        : null,
  );
}
