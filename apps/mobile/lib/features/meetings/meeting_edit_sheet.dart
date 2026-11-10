import 'package:flutter/material.dart';
import '../../core/api_client.dart';
import '../../core/command_actions.dart';
import '../../core/date_labels.dart';
import '../../core/models.dart';
import '../../core/widgets.dart';
import 'room_availability_field.dart';
import 'schedule_preview.dart';

class MeetingEditSheet extends StatefulWidget {
  const MeetingEditSheet({super.key, required this.api, required this.meeting});
  final ApiClient api;
  final Meeting meeting;

  @override
  State<MeetingEditSheet> createState() => _MeetingEditSheetState();
}

class _MeetingEditSheetState extends State<MeetingEditSheet> {
  final _form = GlobalKey<FormState>();
  late final TextEditingController _title;
  late final TextEditingController _description;
  late DateTime _start;
  late DateTime _end;
  String? _roomId;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _title = TextEditingController(text: widget.meeting.title);
    _description = TextEditingController(text: widget.meeting.description);
    _start = dateValue(widget.meeting.scheduledStartAt) ??
        DateTime.now().add(const Duration(hours: 1));
    _end = dateValue(widget.meeting.scheduledEndAt) ??
        _start.add(const Duration(hours: 1));
    _roomId = widget.meeting.roomId;
  }

  @override
  void dispose() {
    _title.dispose();
    _description.dispose();
    super.dispose();
  }

  Future<void> _choose(bool start) async {
    final old = start ? _start : _end;
    final day = await showDatePicker(context: context,
        initialDate: old, firstDate: DateTime(2020), lastDate: DateTime(2100));
    if (day == null || !mounted) return;
    final time = await showTimePicker(context: context,
        initialTime: TimeOfDay.fromDateTime(old));
    if (time == null || !mounted) return;
    final value = DateTime(day.year, day.month, day.day, time.hour, time.minute);
    setState(() {
      if (start) {
        _start = value;
        if (!_end.isAfter(_start)) _end = _start.add(const Duration(hours: 1));
      } else {
        _end = value;
      }
    });
  }

  Future<void> _save() async {
    if (!(_form.currentState?.validate() ?? false)) return;
    if (!_end.isAfter(_start)) {
      showFailure(context, const ApiFailure(
          422, 'VALIDATION_INVALID_INTERVAL', 'Giờ kết thúc phải sau giờ bắt đầu.'));
      return;
    }
    setState(() => _saving = true);
    try {
      final endpoint = '/meetings/' + widget.meeting.id;
      final latest = await widget.api.get(endpoint);
      await widget.api.patch(endpoint, {
        'title': _title.text.trim(),
        'description': _description.text.trim(),
        'scheduledStartAt': dateIso(_start),
        'scheduledEndAt': dateIso(_end),
        'roomId': _roomId,
      }, headers: {'If-Match': requireEtag(latest)});
      if (mounted) Navigator.pop(context, true);
    } catch (error) {
      if (mounted) showFailure(context, error);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) => SafeArea(child: Padding(
    padding: EdgeInsets.fromLTRB(18, 8, 18,
        MediaQuery.viewInsetsOf(context).bottom + 18),
    child: SingleChildScrollView(child: Form(key: _form,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        const SectionHeading('Chỉnh sửa cuộc họp',
          subtitle: 'Mọi thay đổi lịch sẽ được xác thực lại khi lưu.'),
        TextFormField(controller: _title, maxLength: 255,
          decoration: const InputDecoration(labelText: 'Tên cuộc họp'),
          validator: (v) => v == null || v.trim().isEmpty
            ? 'Tên cuộc họp không được để trống.' : null),
        TextField(controller: _description, maxLines: 3,
          decoration: const InputDecoration(labelText: 'Mô tả')),
        const SizedBox(height: 12),
        OutlinedButton.icon(onPressed: () => _choose(true),
          icon: const Icon(Icons.event),
          label: Text('Bắt đầu · ' + localDateTimeLabel(_start.toIso8601String()))),
        const SizedBox(height: 8),
        OutlinedButton.icon(onPressed: () => _choose(false),
          icon: const Icon(Icons.schedule),
          label: Text('Kết thúc · ' + localDateTimeLabel(_end.toIso8601String()))),
        const SizedBox(height: 8),
        RoomAvailabilityField(
          key: ValueKey(_start.toIso8601String() + _end.toIso8601String()),
          api: widget.api, start: _start, end: _end,
          selectedId: _roomId, onChanged: (id) => setState(() => _roomId = id)),
        SchedulePreview(api: widget.api, meetingId: widget.meeting.id,
          start: _start, end: _end, roomId: _roomId,
          participantIds: const []),
        const SizedBox(height: 14),
        FilledButton.icon(onPressed: _saving ? null : _save,
          icon: const Icon(Icons.save_outlined),
          label: Text(_saving ? 'Đang lưu...' : 'Lưu thay đổi')),
      ]))),
  ));
}
