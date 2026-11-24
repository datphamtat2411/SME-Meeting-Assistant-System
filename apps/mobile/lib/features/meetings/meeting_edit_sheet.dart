import 'package:flutter/material.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/app_dependencies.dart';
import 'package:sme_meeting_assistant/core/app_theme.dart';
import 'package:sme_meeting_assistant/core/widgets.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_foundation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_scheduling.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_scheduling_widgets.dart';

class MeetingEditSheet extends StatefulWidget {
  const MeetingEditSheet({
    super.key,
    required this.dependencies,
    required this.snapshot,
  });

  final AppDependencies dependencies;
  final MeetingSnapshot snapshot;

  ApiClient get api => dependencies.api;

  @override
  State<MeetingEditSheet> createState() => _MeetingEditSheetState();
}

class _MeetingEditSheetState extends State<MeetingEditSheet> {
  final _form = GlobalKey<FormState>();
  late final TextEditingController _title;
  late final TextEditingController _description;
  late MeetingInterval? _interval;
  late String? _roomId;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    final meeting = widget.snapshot.meeting;
    _title = TextEditingController(text: meeting.title);
    _description = TextEditingController(text: meeting.description);
    _interval = MeetingInterval.fromNullableEndpoints(
      meeting.scheduledStartAt,
      meeting.scheduledEndAt,
    );
    _roomId = meeting.roomId;
  }

  @override
  void dispose() {
    _title.dispose();
    _description.dispose();
    super.dispose();
  }

  ScheduleIntent? get _previewIntent {
    final interval = _interval;
    if (interval == null) return null;
    return ScheduleIntent(
      interval: interval,
      meetingId: widget.snapshot.meeting.id,
      roomId: _roomId,
      organizerId: widget.snapshot.meeting.organizerId,
      // Null means that the proposed schedule does not change membership.
      participantUserIds: null,
    );
  }

  Future<void> _save() async {
    if (!(_form.currentState?.validate() ?? false)) return;
    setState(() => _saving = true);
    try {
      final interval = _interval;
      await widget.dependencies.meetings.update(
        widget.snapshot,
        MeetingUpdateInput(
          title: MeetingFieldUpdate<String>.set(_title.text.trim()),
          description: MeetingFieldUpdate<String?>.set(
            _description.text.trim().isEmpty ? null : _description.text.trim(),
          ),
          scheduledStartAt: MeetingFieldUpdate<DateTime?>.set(interval?.start),
          scheduledEndAt: MeetingFieldUpdate<DateTime?>.set(interval?.end),
          roomId: MeetingFieldUpdate<String?>.set(_roomId),
        ),
      );
      if (mounted) Navigator.pop(context, true);
    } catch (error) {
      if (mounted) showFailure(context, error);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final scope = widget.snapshot.sessionScope;
    final meeting = widget.snapshot.meeting;
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(
          18,
          8,
          18,
          MediaQuery.viewInsetsOf(context).bottom + 18,
        ),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 760),
          child: SingleChildScrollView(
            child: Form(
              key: _form,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const SectionHeading(
                    'Chỉnh sửa cuộc họp',
                    subtitle: 'Mọi thay đổi dùng phiên bản đã tải và được máy chủ xác thực lại.',
                  ),
                  TextFormField(
                    controller: _title,
                    maxLength: 255,
                    decoration: const InputDecoration(
                      labelText: 'Tên cuộc họp',
                    ),
                    validator: (value) => value == null || value.trim().isEmpty
                        ? 'Tên cuộc họp không được để trống.'
                        : null,
                  ),
                  TextField(
                    controller: _description,
                    maxLines: 3,
                    decoration: const InputDecoration(labelText: 'Mô tả'),
                  ),
                  const SizedBox(height: 12),
                  MeetingScheduleFields(
                    interval: _interval,
                    onChanged: (value) => setState(() => _interval = value),
                  ),
                  MeetingRoomSelector(
                    repository: widget.dependencies.roomScheduling,
                    sessionScope: scope,
                    selectedId: _roomId,
                    interval: _interval,
                    participantCount: null,
                    onChanged: (value) => setState(() => _roomId = value),
                  ),
                  SchedulePreviewCard(
                    repository: widget.dependencies.roomScheduling,
                    sessionScope: scope,
                    intent: _previewIntent,
                  ),
                  const SizedBox(height: 14),
                  FilledButton.icon(
                    onPressed: _saving ? null : _save,
                    icon: const Icon(Icons.save_outlined),
                    label: Text(_saving ? 'Đang lưu...' : 'Lưu thay đổi'),
                  ),
                  if (meeting.lifecycleStatus == null)
                    const Text(
                      'Không thể xác định trạng thái cuộc họp hiện tại.',
                      style: TextStyle(color: Palette.amber),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
