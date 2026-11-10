import 'package:flutter/material.dart';
import '../../core/api_client.dart';
import 'transcript_review_panel.dart';
import 'speaker_mapping_panel.dart';
import 'summary_history_panel.dart';
import 'decisions_review_panel.dart';

class ResultsPanel extends StatefulWidget {
  const ResultsPanel({super.key, required this.api, required this.meetingId});
  final ApiClient api;
  final String meetingId;
  @override
  State<ResultsPanel> createState() => _ResultsPanelState();
}

class _ResultsPanelState extends State<ResultsPanel> {
  int selected = 0;

  @override
  Widget build(BuildContext context) {
    final tabs = <(String, IconData)>[
      ('Tóm tắt', Icons.auto_awesome_outlined),
      ('Transcript', Icons.notes_outlined),
      ('Quyết định', Icons.fact_check_outlined),
      ('Người nói', Icons.record_voice_over_outlined),
    ];
    final pages = <Widget>[
      SummaryHistoryPanel(api: widget.api, meetingId: widget.meetingId),
      TranscriptReviewPanel(api: widget.api, meetingId: widget.meetingId),
      DecisionsReviewPanel(api: widget.api, meetingId: widget.meetingId),
      SpeakerMappingPanel(api: widget.api, meetingId: widget.meetingId),
    ];
    return Column(children: [
      SingleChildScrollView(scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        child: Row(children: [
          for (var i = 0; i < tabs.length; i++)
            Padding(padding: const EdgeInsets.only(right: 6),
              child: ChoiceChip(
                avatar: Icon(tabs[i].$2, size: 17),
                label: Text(tabs[i].$1),
                selected: selected == i,
                onSelected: (_) => setState(() => selected = i),
              )),
        ])),
      Expanded(child: IndexedStack(index: selected, children: pages)),
    ]);
  }
}
