import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/app_theme.dart';
import '../../core/models.dart';
import '../../core/widgets.dart';
import 'results_models.dart';
import 'results_workspace_controller.dart';

class MinutesPanel extends StatefulWidget {
  const MinutesPanel({super.key, required this.workspace});
  final ResultsWorkspaceController workspace;

  @override
  State<MinutesPanel> createState() => _MinutesPanelState();
}

class _MinutesPanelState extends State<MinutesPanel> {
  @override
  void initState() {
    super.initState();
    unawaited(widget.workspace.loadMinutes());
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: widget.workspace,
    builder: (context, _) {
      final resource = widget.workspace.minutes;
      final minutes = resource.data;
      if (minutes == null) {
        return MessagePanel(
          title: resource.phase == ResultsResourcePhase.forbidden
              ? 'Bạn không có quyền xem kết quả này'
              : 'Biên bản chưa sẵn sàng',
          onRetry: resource.phase == ResultsResourcePhase.failed
              ? () => unawaited(widget.workspace.loadMinutes(force: true))
              : null,
        );
      }
      return RefreshIndicator(
        onRefresh: () => widget.workspace.loadMinutes(force: true),
        child: ListView(
          padding: const EdgeInsets.all(18),
          children: [
            const SectionHeading('Biên bản chính thức'),
            ContentCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  StatePill(minutes.completeness),
                  const SizedBox(height: 8),
                  Text('Lập lúc: ${dateLabel(minutes.assembledAt)}'),
                  const SizedBox(height: 7),
                  const Text(
                    'Chỉ gồm nội dung đã được xác nhận theo quy tắc Core API.',
                    style: TextStyle(color: Palette.muted, fontSize: 12),
                  ),
                ],
              ),
            ),
            const SectionHeading('Tóm tắt đã chọn'),
            ContentCard(
              child: SelectableText(
                minutes.summaryContent ?? 'Chưa có bản tóm tắt phù hợp.',
              ),
            ),
            SectionHeading(
              'Quyết định đã xác nhận',
              subtitle: '${minutes.confirmedDecisions.length} quyết định',
            ),
            if (minutes.confirmedDecisions.isEmpty)
              const MessagePanel(title: 'Chưa có quyết định chính thức'),
            ...minutes.confirmedDecisions.map(
              (entry) => ContentCard(
                child: SelectableText(textValue(entry['content'])),
              ),
            ),
            SectionHeading(
              'Đầu việc chính thức',
              subtitle: '${minutes.officialActionItems.length} công việc',
            ),
            if (minutes.officialActionItems.isEmpty)
              const MessagePanel(title: 'Chưa có đầu việc chính thức'),
            ...minutes.officialActionItems.map(
              (entry) => ContentCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      textValue(entry['title']),
                      style: const TextStyle(fontWeight: FontWeight.w700),
                    ),
                    const SizedBox(height: 4),
                    Text(textValue(entry['details'])),
                    const SizedBox(height: 7),
                    StatePill(textValue(entry['status'])),
                  ],
                ),
              ),
            ),
            const SectionHeading('Tình trạng transcript'),
            ContentCard(
              child: Text(
                '${minutes.transcriptAvailability} · ${minutes.transcriptStatus}',
              ),
            ),
            if (minutes.warnings.isNotEmpty) ...[
              const SectionHeading('Cảnh báo và giới hạn nguồn'),
              ContentCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: minutes.warnings
                      .map(
                        (warning) => Text(
                          '• $warning',
                          style: const TextStyle(color: Palette.amber),
                        ),
                      )
                      .toList(),
                ),
              ),
            ],
          ],
        ),
      );
    },
  );
}
