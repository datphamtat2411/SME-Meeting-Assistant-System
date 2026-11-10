import 'package:flutter/material.dart';
import '../../core/api_client.dart';
import '../../core/app_theme.dart';
import '../../core/models.dart';
import '../../core/widgets.dart';

class SchedulePreview extends StatefulWidget {
  const SchedulePreview({
    super.key, required this.api, required this.start, required this.end,
    required this.roomId, required this.participantIds, this.meetingId,
  });
  final ApiClient api;
  final DateTime start, end;
  final String? roomId, meetingId;
  final List<String> participantIds;

  @override
  State<SchedulePreview> createState() => _SchedulePreviewState();
}

class _SchedulePreviewState extends State<SchedulePreview> {
  bool busy = false;
  Map<String, dynamic>? result;
  String? error;

  @override
  void didUpdateWidget(covariant SchedulePreview oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.start != widget.start || oldWidget.end != widget.end ||
        oldWidget.roomId != widget.roomId ||
        oldWidget.participantIds.join(',') != widget.participantIds.join(',')) {
      result = null;
      error = null;
    }
  }

  Future<void> _check() async {
    if (!widget.end.isAfter(widget.start)) {
      setState(() => error = 'Giờ kết thúc phải sau giờ bắt đầu.');
      return;
    }
    setState(() { busy = true; error = null; });
    try {
      final response = await widget.api.post('/meeting-schedule-checks', {
        if (widget.meetingId != null) 'meetingId': widget.meetingId,
        'roomId': widget.roomId,
        'start': dateIso(widget.start),
        'end': dateIso(widget.end),
        'participantUserIds': widget.participantIds,
      });
      if (mounted) setState(() => result = objectOf(response.data));
    } catch (e) {
      if (mounted) setState(() => error =
        e is ApiFailure ? e.message : 'Không thể kiểm tra lịch trình.');
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final warnings = objectsOf(result?['warnings']);
    final canSchedule = result?['canSchedule'] == true;
    return ContentCard(child: Column(
      crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          const Expanded(child: Text('Kiểm tra lịch',
            style: TextStyle(fontWeight: FontWeight.w700))),
          OutlinedButton.icon(onPressed: busy ? null : _check,
            icon: const Icon(Icons.fact_check_outlined),
            label: Text(busy ? 'Đang kiểm tra' : 'Kiểm tra')),
        ]),
        if (error != null) Text(error!, style: const TextStyle(color: Palette.red)),
        if (result != null) ...[
          Row(children: [
            Icon(canSchedule ? Icons.check_circle_outline : Icons.warning_amber,
              color: canSchedule ? Palette.green : Palette.amber),
            const SizedBox(width: 6),
            Expanded(child: Text(canSchedule ? 'Lịch tạm thời phù hợp'
              : 'Có xung đột hoặc điều kiện chưa đáp ứng')),
          ]),
          ...warnings.map((w) => Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text('• ' + textValue(w['code']),
              style: const TextStyle(color: Palette.amber, fontSize: 12)))),
          const SizedBox(height: 4),
          const Text('Đây chỉ là bản xem trước; lưu lịch vẫn được kiểm tra độc lập.',
            style: TextStyle(color: Palette.muted, fontSize: 12)),
        ],
      ]),
    );
  }
}
