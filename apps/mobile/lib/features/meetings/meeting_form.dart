import 'dart:math';

import 'package:flutter/material.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/app_dependencies.dart';
import 'package:sme_meeting_assistant/core/app_theme.dart';
import 'package:sme_meeting_assistant/core/widgets.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_foundation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_scheduling.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_scheduling_widgets.dart';
import 'package:sme_meeting_assistant/features/meetings/participant_selection.dart';

class MeetingForm extends StatefulWidget {
  const MeetingForm({super.key, required this.dependencies});

  final AppDependencies dependencies;
  ApiClient get api => dependencies.api;

  @override
  State<MeetingForm> createState() => _MeetingFormState();
}

class _MeetingFormState extends State<MeetingForm> {
  final _form = GlobalKey<FormState>();
  final _title = TextEditingController();
  final _description = TextEditingController();
  late MeetingInterval? _interval;
  String? _roomId;
  final Map<String, MeetingParticipantCandidate> _members =
      <String, MeetingParticipantCandidate>{};
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    final start = DateTime.now().add(const Duration(hours: 1));
    _interval = MeetingInterval(
      start: start,
      end: start.add(const Duration(hours: 1)),
    );
  }

  @override
  void dispose() {
    _title.dispose();
    _description.dispose();
    super.dispose();
  }

  Future<void> _chooseParticipants() async {
    final scope = widget.api.authenticatedSessionScope;
    final organizerId = widget.api.userId;
    if (scope == null) return;
    final selected = await showParticipantPicker(
      context,
      repository: widget.dependencies.participantCandidates,
      sessionScope: scope,
      organizerId: organizerId,
      initialSelection: _members.values,
    );
    if (selected == null || !mounted) return;
    setState(() {
      _members
        ..clear()
        ..addEntries(
          selected.map(
            (candidate) => MapEntry(candidate.id.toLowerCase(), candidate),
          ),
        );
    });
  }

  ScheduleIntent? get _previewIntent {
    final interval = _interval;
    final scope = widget.api.authenticatedSessionScope;
    final organizerId = widget.api.userId;
    if (interval == null || scope == null) return null;
    return ScheduleIntent(
      interval: interval,
      roomId: _roomId,
      organizerId: organizerId,
      participantUserIds: _members.values
          .map((candidate) => candidate.id)
          .toList(growable: false),
    );
  }

  Future<void> _save() async {
    if (!(_form.currentState?.validate() ?? false)) return;
    final scope = widget.api.authenticatedSessionScope;
    if (scope == null) return;
    setState(() => _saving = true);
    try {
      final input = CreateMeetingInput(
        title: _title.text.trim(),
        description: _description.text.trim().isEmpty
            ? null
            : _description.text.trim(),
        scheduledInterval: _interval,
        roomId: _roomId,
        participantUserIds: _members.values
            .map((candidate) => candidate.id)
            .toList(growable: false),
      );
      final random = Random.secure();
      final idempotencyKey =
          'mobile-${DateTime.now().microsecondsSinceEpoch}-${random.nextInt(1 << 32)}';
      await widget.dependencies.meetings.create(
        input,
        idempotencyKey: idempotencyKey,
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
    final scope = widget.api.authenticatedSessionScope;
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(
          left: 18,
          right: 18,
          bottom: MediaQuery.viewInsetsOf(context).bottom + 16,
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
                    'Tạo cuộc họp',
                    subtitle: 'Mỗi cuộc họp có một người tổ chức và lịch trình riêng.',
                  ),
                  TextFormField(
                    controller: _title,
                    maxLength: 255,
                    decoration: const InputDecoration(
                      labelText: 'Tên cuộc họp *',
                    ),
                    validator: (value) => value == null || value.trim().isEmpty
                        ? 'Nhập tên cuộc họp.'
                        : null,
                  ),
                  TextFormField(
                    controller: _description,
                    maxLines: 2,
                    decoration: const InputDecoration(
                      labelText: 'Mục đích / mô tả',
                    ),
                  ),
                  const SizedBox(height: 10),
                  MeetingScheduleFields(
                    interval: _interval,
                    onChanged: (value) => setState(() => _interval = value),
                  ),
                  if (scope != null)
                    MeetingRoomSelector(
                      repository: widget.dependencies.roomScheduling,
                      sessionScope: scope,
                      selectedId: _roomId,
                      interval: _interval,
                      participantCount: _members.length + 1,
                      onChanged: (value) => setState(() => _roomId = value),
                    ),
                  if (scope != null) ...[
                    const SizedBox(height: 8),
                    OutlinedButton.icon(
                      onPressed: _saving ? null : _chooseParticipants,
                      icon: const Icon(Icons.person_add_alt_1),
                      label: Text(
                        _members.isEmpty
                            ? 'Chọn người tham gia'
                            : 'Người tham gia (${_members.length})',
                      ),
                    ),
                    if (_members.isNotEmpty)
                      Wrap(
                        spacing: 6,
                        runSpacing: 4,
                        children: _members.values
                            .map(
                              (candidate) => InputChip(
                                label: Text(candidate.displayName),
                                onDeleted: _saving
                                    ? null
                                    : () => setState(
                                        () => _members.remove(
                                          candidate.id.toLowerCase(),
                                        ),
                                      ),
                              ),
                            )
                            .toList(),
                      ),
                  ],
                  if (scope != null) ...[
                    const SizedBox(height: 8),
                    SchedulePreviewCard(
                      repository: widget.dependencies.roomScheduling,
                      sessionScope: scope,
                      intent: _previewIntent,
                    ),
                  ],
                  const SizedBox(height: 18),
                  FilledButton.icon(
                    onPressed: _saving ? null : _save,
                    icon: const Icon(Icons.add),
                    label: Text(_saving ? 'Đang lưu...' : 'Tạo cuộc họp'),
                  ),
                  const SizedBox(height: 12),
                  const Text(
                    'Xung đột phòng họp và quyền truy cập được backend kiểm tra.',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: Palette.muted, fontSize: 12),
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
