import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/app_theme.dart';
import '../../core/widgets.dart';
import 'results_workspace_controller.dart';
import 'results_presentation.dart';

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
        return resultsResourceMessage(resource, label: 'Biên bản',
          onRetry: () => widget.workspace.loadMinutes(force: true));

      }
      return RefreshIndicator(
        onRefresh: () => widget.workspace.loadMinutes(force: true),
        child: ListView(
          padding: const EdgeInsets.all(18),
          children: [
            const SectionHeading('Biên bản chính thức'),
            resultsRefreshNotice(resource, () => widget.workspace.loadMinutes(force: true)),
            ContentCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  StatePill(minutes.completeness),
                  const SizedBox(height: 8),
                  Text('Lập lúc: ${dateLabel(minutes.assembledAt)}'),
                  const SizedBox(height: 7),
                  const Text(
                    'Biên bản từ Core API; tóm tắt AI có thể cần đối chiếu.',
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
                child: SelectableText(entry.content),
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
                      entry.title,
                      style: const TextStyle(fontWeight: FontWeight.w700),
                    ),
                    const SizedBox(height: 4),
                    Text(entry.details ?? ''),
                    const SizedBox(height: 7),
                    StatePill(entry.status),
                  ],
                ),
              ),
            ),
            const SectionHeading('Tình trạng transcript'),
            ContentCard(
              child: Text(
                [minutes.transcriptAvailability, if (minutes.transcriptStatus != null) minutes.transcriptStatus!].join(' · '),
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
