import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/widgets.dart';
import 'decisions_review_panel.dart';
import 'minutes_panel.dart';
import 'results_workspace_controller.dart';
import 'results_invalidation.dart';
import 'speaker_mapping_panel.dart';
import 'summary_history_panel.dart';
import 'transcript_review_panel.dart';

class ResultsPanel extends StatefulWidget {
  const ResultsPanel({super.key, required this.workspace});

  final ResultsWorkspaceController workspace;

  @override
  State<ResultsPanel> createState() => _ResultsPanelState();
}

class _ResultsPanelState extends State<ResultsPanel> {
  int selected = 0;

  Set<ResultsResourceKind> _resourcesFor(int index) => switch (index) {
    0 => {ResultsResourceKind.summary, ResultsResourceKind.summaryVersions},
    1 => {ResultsResourceKind.transcript},
    2 => {ResultsResourceKind.decisions},
    3 => {ResultsResourceKind.speakers},
    _ => {ResultsResourceKind.minutes},
  };

  @override
  void initState() {
    super.initState();
    _scheduleActivation(widget.workspace);
  }

  @override
  void dispose() {
    widget.workspace.deactivate();
    super.dispose();
  }

  @override
  void didUpdateWidget(covariant ResultsPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.workspace, widget.workspace)) {
      oldWidget.workspace.deactivate();
      _scheduleActivation(widget.workspace);
    }
  }

  void _scheduleActivation(ResultsWorkspaceController workspace) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !identical(widget.workspace, workspace)) return;
      workspace.activateResources(_resourcesFor(selected));
    });
  }

  @override
  Widget build(BuildContext context) {
    final current = widget.workspace;
    final tabs = <(String, IconData)>[
      ('Tóm tắt', Icons.auto_awesome_outlined),
      ('Transcript', Icons.notes_outlined),
      ('Quyết định', Icons.fact_check_outlined),
      ('Người nói', Icons.record_voice_over_outlined),
      ('Biên bản', Icons.article_outlined),
    ];
    final page = switch (selected) {
      0 => SummaryHistoryPanel(workspace: current),
      1 => TranscriptReviewPanel(workspace: current),
      2 => DecisionsReviewPanel(workspace: current),
      3 => SpeakerMappingPanel(workspace: current),
      _ => MinutesPanel(workspace: current),
    };
    return Column(
      children: [
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          child: Row(
            children: [
              for (var i = 0; i < tabs.length; i++)
                Padding(
                  padding: const EdgeInsets.only(right: 6),
                  child: ChoiceChip(
                    avatar: Icon(tabs[i].$2, size: 17),
                    label: Text(tabs[i].$1),
                    selected: selected == i,
                    onSelected: (_) {
                      setState(() => selected = i);
                      current.activateResources(_resourcesFor(i));
                    },
                  ),
                ),
            ],
          ),
        ),
        Expanded(
          child: AnimatedBuilder(
            animation: current,
            builder: (context, _) => current.capabilities.canRead
                ? KeyedSubtree(key: ObjectKey(current), child: page)
                : MessagePanel(
                    title:
                        'Không thể xác minh quyền truy cập kết quả cuộc họp.',
                    onRetry: () => unawaited(current.retryAccess()),
                  ),
          ),
        ),
      ],
    );
  }
}
