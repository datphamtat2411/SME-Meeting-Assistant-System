import 'package:flutter/material.dart';
import '../../core/api_client.dart';
import '../../core/app_theme.dart';
import '../../core/models.dart';
import '../../core/widgets.dart';

class MinutesPanel extends StatefulWidget {
  const MinutesPanel({super.key, required this.api, required this.meetingId});
  final ApiClient api;
  final String meetingId;
  @override
  State<MinutesPanel> createState() => _MinutesPanelState();
}

class _MinutesPanelState extends State<MinutesPanel> {
  late Future<Map<String, dynamic>> future;
  @override
  void initState() { super.initState(); reload(); }
  void reload() => setState(() {
    future = widget.api.get('/meetings/' + widget.meetingId + '/minutes')
      .then((r) => objectOf(r.data));
  });

  @override
  Widget build(BuildContext context) => AsyncContent<Map<String, dynamic>>(
    future: future, retry: reload,
    builder: (minutes) {
      final meeting = objectOf(minutes['meeting']);
      final summary = objectOf(minutes['summary']);
      final transcript = objectOf(minutes['transcript']);
      final decisions = objectsOf(minutes['confirmedDecisions']);
      final actions = objectsOf(minutes['officialActionItems']);
      final warnings = minutes['warnings'] is List ? minutes['warnings'] as List : [];
      return RefreshIndicator(
        onRefresh: () async { reload(); await future; },
        child: ListView(padding: const EdgeInsets.all(18), children: [
          SectionHeading('Biên bản chính thức',
            subtitle: textValue(meeting['title'])),
          ContentCard(child: Column(
            crossAxisAlignment: CrossAxisAlignment.start, children: [
              StatePill(textValue(minutes['completeness'])),
              const SizedBox(height: 8),
              Text('Lập lúc: ' + dateLabel(minutes['assembledAt'])),
              const SizedBox(height: 7),
              const Text('Chỉ gồm nội dung đã được xác nhận theo quy tắc Core API.',
                style: TextStyle(color: Palette.muted, fontSize: 12)),
            ])),
          const SectionHeading('Tóm tắt đã chọn'),
          ContentCard(child: SelectableText(
            textValue(summary['content'], 'Chưa có bản tóm tắt phù hợp.'))),
          SectionHeading('Quyết định đã xác nhận',
            subtitle: decisions.length.toString() + ' quyết định'),
          if (decisions.isEmpty) const MessagePanel(title: 'Chưa có quyết định chính thức'),
          ...decisions.map((entry) => ContentCard(
            child: SelectableText(textValue(entry['content'])))),
          SectionHeading('Đầu việc chính thức',
            subtitle: actions.length.toString() + ' công việc'),
          if (actions.isEmpty) const MessagePanel(title: 'Chưa có đầu việc chính thức'),
          ...actions.map((entry) => ContentCard(child: Column(
            crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(textValue(entry['title']),
                style: const TextStyle(fontWeight: FontWeight.w700)),
              const SizedBox(height: 4),
              Text(textValue(entry['details'])),
              const SizedBox(height: 7),
              StatePill(textValue(entry['status'])),
            ]))),
          const SectionHeading('Tình trạng transcript'),
          ContentCard(child: Text(
            textValue(transcript['availability']) + ' · ' +
            textValue(transcript['status']))),
          if (warnings.isNotEmpty) ...[
            const SectionHeading('Cảnh báo và giới hạn nguồn'),
            ContentCard(child: Column(crossAxisAlignment: CrossAxisAlignment.start,
              children: warnings.map((warning) => Text('• ' + warning.toString(),
                style: const TextStyle(color: Palette.amber))).toList())),
          ],
        ]),
      );
    },
  );
}
