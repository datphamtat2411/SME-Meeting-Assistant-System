import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import '../../core/app_theme.dart';
import '../../core/models.dart';
import '../../core/widgets.dart';
import '../recording/recording_page.dart';
import '../results/results_panel.dart';

class MeetingDetailPage extends StatefulWidget {
  final ApiClient api;
  final String meetingId;
  const MeetingDetailPage({super.key, required this.api, required this.meetingId});

  @override
  State<MeetingDetailPage> createState() => _MeetingDetailPageState();
}

class _MeetingDetailPageState extends State<MeetingDetailPage> {
  late Future<Meeting> future;
  int tab = 0;
  bool busy = false;

  @override
  void initState() {
    super.initState();
    reload();
  }

  void reload() => setState(() => future = widget.api
      .get('/meetings/' + widget.meetingId)
      .then((value) => Meeting.fromJson(objectOf(value.data))));

  Future<void> command(String action) async {
    setState(() => busy = true);
    try {
      await widget.api.post('/meetings/' + widget.meetingId + '/' + action,
        action == 'cancel' ? {'reason': 'Cancelled from mobile'} : {});
      if (mounted) {
        showSuccess(context, 'Đã cập nhật cuộc họp.');
        reload();
      }
    } catch (error) {
      if (mounted) showFailure(context, error);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> confirmCancel() async {
    final proceed = await showDialog<bool>(context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Hủy cuộc họp?'),
        content: const Text('Hành động sẽ giữ lịch sử nhưng giải phóng lịch phòng.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Quay lại')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Xác nhận hủy')),
        ],
      ));
    if (proceed == true) await command('cancel');
  }

  Widget overview(Meeting meeting) => ListView(padding: const EdgeInsets.all(18),
    children: [
      SectionHeading(meeting.title, subtitle: 'Thông tin cuộc họp'),
      ContentCard(child: Column(crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          StatePill(meeting.status),
          const SizedBox(height: 16),
          Text(meeting.description.isEmpty ? 'Chưa có mô tả' : meeting.description),
          const Divider(height: 26),
          _line(Icons.event, 'Bắt đầu', dateLabel(meeting.scheduledStartAt)),
          _line(Icons.schedule, 'Kết thúc', dateLabel(meeting.scheduledEndAt)),
          _line(Icons.meeting_room_outlined, 'Phòng họp',
            meeting.roomName ?? (meeting.roomId == null ? 'Chưa chọn phòng' : meeting.roomId!)),
          _line(Icons.person_outline, 'Người tổ chức',
            meeting.organizerName ?? meeting.organizerId),
        ])),
      if (!busy) ...[
        if (meeting.status == 'DRAFT')
          FilledButton.icon(onPressed: () => command('schedule'),
            icon: const Icon(Icons.event_available), label: const Text('Xác nhận lịch')),
        if (meeting.status == 'SCHEDULED') ...[
          FilledButton.icon(onPressed: () => command('start'),
            icon: const Icon(Icons.play_arrow), label: const Text('Bắt đầu cuộc họp')),
          const SizedBox(height: 8),
          OutlinedButton.icon(onPressed: confirmCancel,
            icon: const Icon(Icons.cancel_outlined), label: const Text('Hủy cuộc họp')),
        ],
        if (meeting.status == 'IN_PROGRESS')
          FilledButton.icon(onPressed: () => command('end'),
            icon: const Icon(Icons.stop), label: const Text('Kết thúc cuộc họp')),
      ] else const Center(child: CircularProgressIndicator()),
      const SizedBox(height: 16),
      const MessagePanel(
        icon: Icons.shield_outlined, title: 'Dữ liệu được phân quyền',
        description: 'Người tham gia, trạng thái xử lý và tài liệu được kiểm tra bởi Core API.'),
    ]);

  Widget _line(IconData icon, String label, String value) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Icon(icon, size: 19, color: Palette.muted),
      const SizedBox(width: 10),
      SizedBox(width: 95, child: Text(label,
        style: const TextStyle(color: Palette.muted))),
      Expanded(child: Text(value, style: const TextStyle(fontWeight: FontWeight.w600))),
    ]));

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('Chi tiết cuộc họp'),
      actions: [IconButton(onPressed: reload, icon: const Icon(Icons.refresh))]),
    body: AsyncContent<Meeting>(future: future, retry: reload, builder: (m) =>
      Column(children: [
        SingleChildScrollView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.all(12),
          child: SegmentedButton<int>(
            segments: const [
              ButtonSegment(value: 0, label: Text('Tổng quan')),
              ButtonSegment(value: 1, label: Text('Biên bản AI')),
              ButtonSegment(value: 2, label: Text('Ghi âm')),
            ],
            selected: {tab}, onSelectionChanged: (v) => setState(() => tab = v.first),
          )),
        Expanded(child: switch (tab) {
          0 => overview(m),
          1 => ResultsPanel(api: widget.api, meetingId: widget.meetingId),
          _ => RecordingPage(api: widget.api, meetingId: widget.meetingId,
            enabled: m.status != 'CANCELLED'),
        }),
      ])),
  );
}
