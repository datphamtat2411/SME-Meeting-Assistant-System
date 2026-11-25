import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import '../../core/app_dependencies.dart';
import '../../core/models.dart';
import '../meetings/meeting_foundation.dart';
import 'decisions_review_panel.dart';
import 'minutes_panel.dart';
import 'results_workspace_controller.dart';
import 'speaker_mapping_panel.dart';
import 'summary_history_panel.dart';
import 'transcript_review_panel.dart';

class ResultsPanel extends StatefulWidget {
  const ResultsPanel({
    super.key,
    required this.api,
    required this.meetingId,
    this.dependencies,
    this.meeting,
    this.meetingCapabilities,
  });

  final ApiClient api;
  final String meetingId;
  final AppDependencies? dependencies;
  final Meeting? meeting;
  final MeetingCapabilities? meetingCapabilities;

  @override
  State<ResultsPanel> createState() => _ResultsPanelState();
}

class _ResultsPanelState extends State<ResultsPanel> {
  int selected = 0;
  ResultsWorkspaceController? workspace;

  @override
  void initState() {
    super.initState();
    final dependencies = widget.dependencies;
    final meeting = widget.meeting;
    final meetingCapabilities = widget.meetingCapabilities;
    if (dependencies != null &&
        meeting != null &&
        meetingCapabilities != null) {
      final scope = widget.api.requireAuthenticatedSessionScope();
      workspace = ResultsWorkspaceController(
        api: widget.api,
        repository: dependencies.results,
        meetingId: widget.meetingId,
        meeting: meeting,
        capabilities: ResultsCapabilityPolicy.evaluate(
          scope: scope,
          meeting: meeting,
          meetingCapabilities: meetingCapabilities,
        ),
        invalidation: dependencies.resultsInvalidation,
        processingManager: dependencies.processingManager,
      );
    }
  }

  @override
  void dispose() {
    workspace?.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(covariant ResultsPanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    final current = workspace;
    final meeting = widget.meeting;
    final meetingCapabilities = widget.meetingCapabilities;
    if (current == null || meeting == null || meetingCapabilities == null)
      return;
    current.updateCapabilities(
      ResultsCapabilityPolicy.evaluate(
        scope: current.sessionScope,
        meeting: meeting,
        meetingCapabilities: meetingCapabilities,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final current = workspace;
    if (current == null) {
      return const Center(
        child: Text('Không thể xác minh quyền truy cập kết quả cuộc họp.'),
      );
    }
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
                    onSelected: (_) => setState(() => selected = i),
                  ),
                ),
            ],
          ),
        ),
        Expanded(child: page),
      ],
    );
  }
}
