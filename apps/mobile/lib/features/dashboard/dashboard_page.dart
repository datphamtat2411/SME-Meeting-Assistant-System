import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import '../../core/app_theme.dart';
import '../../core/models.dart';
import '../../core/widgets.dart';

class DashboardPage extends StatefulWidget {
  final ApiClient api;
  final VoidCallback openMeetings;
  final VoidCallback openActions;
  const DashboardPage({super.key, required this.api,
    required this.openMeetings, required this.openActions});

  @override
  State<DashboardPage> createState() => _DashboardPageState();
}

class _DashboardPageState extends State<DashboardPage> {
  late Future<Map<String, dynamic>> future;

  @override
  void initState() {
    super.initState();
    reload();
  }

  void reload() {
    setState(() {
      future = widget.api.get('/dashboard/me').then((value) => objectOf(value.data));
    });
  }

  Widget metric(String label, String value, IconData icon, Color tone) =>
      ContentCard(child: Row(children: [
        CircleAvatar(backgroundColor: tone.withValues(alpha: 0.1),
          child: Icon(icon, color: tone)),
        const SizedBox(width: 14),
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(value, style: const TextStyle(fontSize: 25, fontWeight: FontWeight.w800)),
          Text(label, style: const TextStyle(color: Palette.muted, fontSize: 12)),
        ])),
      ]));

  @override
  Widget build(BuildContext context) => RefreshIndicator(
    onRefresh: () async { reload(); await future; },
    child: ListView(padding: const EdgeInsets.all(18), children: [
      SectionHeading('Xin chào, ' +
          (widget.api.displayName.isEmpty ? 'đồng nghiệp' : widget.api.displayName),
        subtitle: 'Lịch trình và công việc của bạn', trailing: IconButton(
          onPressed: reload, icon: const Icon(Icons.refresh))),
      AsyncContent<Map<String, dynamic>>(
        future: future, retry: reload,
        builder: (data) {
          final counts = objectOf(data['meetingCountsByState']);
          final tasks = objectOf(data['assignedActionItems']);
          final meetings = objectsOf(data['upcomingMeetings']);
          final recent = objectsOf(data['recentMeetings']);
          final upcomingCount = (counts['SCHEDULED'] as num?)?.toInt() ?? 0;
          return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            LayoutBuilder(builder: (context, constraints) {
              final width = (constraints.maxWidth - 10) / 2;
              return Wrap(spacing: 10, runSpacing: 0, children: [
                SizedBox(width: width, child: metric('Đã lên lịch',
                  upcomingCount.toString(), Icons.calendar_month, Palette.blue)),
                SizedBox(width: width, child: metric('Cần thực hiện',
                  textValue(tasks['open'], '0'), Icons.checklist, Palette.amber)),
                SizedBox(width: width, child: metric('Quá hạn',
                  textValue(tasks['overdue'], '0'), Icons.warning_amber, Palette.red)),
                SizedBox(width: width, child: metric('Đã hoàn thành',
                  textValue(tasks['done'], '0'), Icons.task_alt, Palette.green)),
              ]);
            }),
            SectionHeading('Cuộc họp sắp tới', trailing: TextButton(
              onPressed: widget.openMeetings, child: const Text('Xem tất cả'))),
            if (meetings.isEmpty) const MessagePanel(title: 'Không có cuộc họp sắp tới')
            else ...meetings.take(5).map((m) => ContentCard(child:
              Row(children: [
                const Icon(Icons.video_camera_front_outlined, color: Palette.blue),
                const SizedBox(width: 12),
                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(textValue(m['title']), style: const TextStyle(fontWeight: FontWeight.w700)),
                  const SizedBox(height: 4),
                  Text(dateLabel(m['scheduledStartAt']),
                    style: const TextStyle(color: Palette.muted, fontSize: 12)),
                ])),
                StatePill(textValue(m['status'])),
              ]))),
            SectionHeading('Gần đây', trailing: TextButton(
              onPressed: widget.openActions, child: const Text('Việc cần làm'))),
            if (recent.isEmpty) const MessagePanel(title: 'Chưa có cuộc họp gần đây')
            else ...recent.take(4).map((m) => ContentCard(child: Row(children: [
              const Icon(Icons.description_outlined, color: Palette.muted),
              const SizedBox(width: 10),
              Expanded(child: Text(textValue(m['title']),
                style: const TextStyle(fontWeight: FontWeight.w600))),
              StatePill(textValue(m['status'])),
            ]))),
          ]);
        }),
    ]),
  );
}
