import 'dart:async';

import 'package:flutter/material.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/app_dependencies.dart';
import 'package:sme_meeting_assistant/core/app_theme.dart';
import 'package:sme_meeting_assistant/core/widgets.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_creation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_foundation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_scheduling.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_scheduling_widgets.dart';
import 'package:sme_meeting_assistant/features/meetings/participant_selection.dart';

class MeetingFormResult {
  const MeetingFormResult.meeting(this.meetingId) : inspectMeetings = false;
  const MeetingFormResult.inspect() : meetingId = null, inspectMeetings = true;

  final String? meetingId;
  final bool inspectMeetings;
}

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
  final Map<String, MeetingParticipantCandidate> _members =
      <String, MeetingParticipantCandidate>{};
  late final AuthenticatedSessionScope _scope;
  late final MeetingCreationController _creation;
  late final SchedulePreviewController _previewController;
  MeetingScheduleDraft? _scheduleDraft;
  String? _roomId;

  MeetingInterval? get _interval => _scheduleDraft?.validatedInterval;

  @override
  void initState() {
    super.initState();
    _scope = widget.api.requireAuthenticatedSessionScope();
    _creation = MeetingCreationController(
      meetings: widget.dependencies.meetings,
      recoveryStore: widget.dependencies.meetingCreationRecovery,
      sessionScope: _scope,
    );
    _previewController = SchedulePreviewController(
      repository: widget.dependencies.roomScheduling,
      sessionScope: _scope,
    );
    _updatePreviewIntent();
    unawaited(_creation.restore());
  }

  @override
  void dispose() {
    _title.dispose();
    _description.dispose();
    _creation.dispose();
    _previewController.dispose();
    super.dispose();
  }

  ScheduleIntent? get _previewIntent {
    final interval = _interval;
    if (interval == null ||
        !widget.api.isCurrentAuthenticatedSession(_scope) ||
        _members.length > maxSchedulePreviewParticipants) {
      return null;
    }
    return ScheduleIntent(
      interval: interval,
      roomId: _roomId,
      organizerId: widget.api.userId,
      participantUserIds: _members.values
          .map((candidate) => candidate.id)
          .toList(growable: false),
    );
  }

  void _updatePreviewIntent() => _previewController.setIntent(_previewIntent);

  void _changeSchedule(MeetingScheduleDraft? value) {
    setState(() => _scheduleDraft = value);
    _updatePreviewIntent();
  }

  void _changeRoom(String? value) {
    setState(() => _roomId = value);
    _updatePreviewIntent();
  }

  Future<void> _chooseParticipants() async {
    if (!_creation.state.canEdit) return;
    final selected = await showParticipantPicker(
      context,
      repository: widget.dependencies.participantCandidates,
      sessionScope: _scope,
      organizerId: widget.api.userId,
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
    _updatePreviewIntent();
  }

  Future<void> _submit(MeetingCreationAction action) async {
    if (!(_form.currentState?.validate() ?? false)) return;
    if (_scheduleDraft != null && _interval == null) {
      setState(() {});
      return;
    }
    final interval = _interval;
    if (action == MeetingCreationAction.schedule && interval == null) {
      setState(() {});
      return;
    }
    final organizerId = widget.api.userId.toLowerCase();
    final input = CreateMeetingInput(
      title: _title.text.trim(),
      description: _description.text.trim().isEmpty
          ? null
          : _description.text.trim(),
      scheduledInterval: interval,
      roomId: _roomId,
      participantUserIds: _members.values
          .map((candidate) => candidate.id)
          .where((id) => id.toLowerCase() != organizerId)
          .toList(growable: false),
    );
    final previewState = _previewController.state;
    final blockingRoomConflict =
        previewState.phase == SchedulePreviewPhase.current &&
        previewState.intent == _previewIntent &&
        previewState.preview?.roomConflict == true;
    await _creation.submit(
      input,
      action,
      blockingRoomConflict: blockingRoomConflict,
    );
    if (!mounted) return;
    final snapshot = _creation.state.snapshot;
    if (_creation.state.phase == MeetingCreationPhase.completed &&
        snapshot != null) {
      Navigator.pop(context, MeetingFormResult.meeting(snapshot.meeting.id));
    }
  }

  Future<void> _retryRecovery() async {
    try {
      await _creation.retryUnresolvedCreation();
    } catch (error) {
      if (mounted) showFailure(context, error);
    }
    if (!mounted) return;
    final snapshot = _creation.state.snapshot;
    if (_creation.state.phase == MeetingCreationPhase.completed &&
        snapshot != null) {
      Navigator.pop(context, MeetingFormResult.meeting(snapshot.meeting.id));
    }
  }

  Future<void> _openRecovered() async {
    try {
      final meetingId = await _creation.openRecoveredMeeting();
      if (meetingId != null && mounted) {
        Navigator.pop(context, MeetingFormResult.meeting(meetingId));
      }
    } catch (error) {
      if (mounted) showFailure(context, error);
    }
  }

  Future<void> _resolveRecovery() async {
    final proceed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Xóa yêu cầu đang chờ?'),
        content: const Text(
          'Chỉ tiếp tục nếu bạn đã kiểm tra danh sách cuộc họp. Ứng dụng không thể xác định cuộc họp chỉ dựa trên tên hoặc thời gian.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Quay lại'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Tôi đã kiểm tra'),
          ),
        ],
      ),
    );
    if (proceed != true || !mounted) return;
    try {
      await _creation.resolveAfterManualReview();
    } catch (error) {
      if (mounted) showFailure(context, error);
    }
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: Listenable.merge([_creation, _previewController]),
    builder: (context, _) {
      final state = _creation.state;
      final canEdit = state.canEdit;
      final hasSession = widget.api.isCurrentAuthenticatedSession(_scope);
      final previewState = _previewController.state;
      final blockingRoomConflict =
          previewState.phase == SchedulePreviewPhase.current &&
          previewState.intent == _previewIntent &&
          previewState.preview?.roomConflict == true;
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
                      subtitle:
                          'Lưu bản nháp hoặc gửi yêu cầu lên lịch riêng biệt.',
                    ),
                    if (state.isBusy) const LinearProgressIndicator(),
                    TextFormField(
                      controller: _title,
                      enabled: canEdit,
                      maxLength: 255,
                      decoration: const InputDecoration(
                        labelText: 'Tên cuộc họp *',
                      ),
                      validator: (value) =>
                          value == null || value.trim().isEmpty
                          ? 'Nhập tên cuộc họp.'
                          : value.trim().length > 255
                          ? 'Tên cuộc họp tối đa 255 ký tự.'
                          : null,
                    ),
                    TextFormField(
                      controller: _description,
                      enabled: canEdit,
                      maxLines: 2,
                      decoration: const InputDecoration(
                        labelText: 'Mục đích / mô tả',
                      ),
                    ),
                    const SizedBox(height: 10),
                    MeetingScheduleFields(
                      draft: _scheduleDraft,
                      onDraftChanged: _changeSchedule,
                      allowUnscheduled: true,
                    ),
                    if (_members.length > maxSchedulePreviewParticipants)
                      const Text(
                        'Có thể chọn tối đa 100 người tham gia để xem trước lịch.',
                        style: TextStyle(color: Palette.red),
                      ),
                    if (hasSession)
                      MeetingRoomSelector(
                        repository: widget.dependencies.roomScheduling,
                        sessionScope: _scope,
                        selectedId: _roomId,
                        interval: _interval,
                        participantCount: _members.length + 1,
                        onChanged: canEdit ? _changeRoom : (_) {},
                      ),
                    if (hasSession) ...[
                      const SizedBox(height: 8),
                      OutlinedButton.icon(
                        onPressed: canEdit ? _chooseParticipants : null,
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
                                  onDeleted: !canEdit
                                      ? null
                                      : () {
                                          setState(
                                            () => _members.remove(
                                              candidate.id.toLowerCase(),
                                            ),
                                          );
                                          _updatePreviewIntent();
                                        },
                                ),
                              )
                              .toList(),
                        ),
                      const SizedBox(height: 8),
                      SchedulePreviewCard(
                        repository: widget.dependencies.roomScheduling,
                        sessionScope: _scope,
                        intent: _previewIntent,
                        previewController: _previewController,
                        participantDisplayNames: {
                          for (final member in _members.values)
                            member.id.toLowerCase(): member.displayName,
                        },
                      ),
                    ],
                    if (blockingRoomConflict)
                      const MessagePanel(
                        icon: Icons.meeting_room_outlined,
                        title: 'Phòng đang bị trùng lịch',
                        description: 'Hãy chọn phòng khác hoặc điều chỉnh thời gian trước khi lên lịch.',
                      ),
                    if (state.message != null ||
                        state.failure != null ||
                        state.hasUnresolvedOperation)
                      _creationStatus(state),
                    const SizedBox(height: 18),
                    OutlinedButton.icon(
                      onPressed: !canEdit
                          ? null
                          : () => _submit(MeetingCreationAction.saveDraft),
                      icon: const Icon(Icons.save_outlined),
                      label: Text(
                        state.phase == MeetingCreationPhase.persistingIntent ||
                                state.phase == MeetingCreationPhase.creating
                            ? 'Đang lưu bản nháp...'
                            : 'Lưu bản nháp',
                      ),
                    ),
                    FilledButton.icon(
                      onPressed:
                          !canEdit || _interval == null || blockingRoomConflict
                          ? null
                          : () => _submit(MeetingCreationAction.schedule),
                      icon: const Icon(Icons.event_available),
                      label: Text(
                        state.phase == MeetingCreationPhase.scheduling
                            ? 'Đang lên lịch...'
                            : 'Lên lịch cuộc họp',
                      ),
                    ),
                    const SizedBox(height: 12),
                    const Text(
                      'Bản xem trước không đặt phòng. Lịch và quyền truy cập được máy chủ xác nhận.',
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
    },
  );

  Widget _creationStatus(MeetingCreationState state) => ContentCard(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (state.message != null) Text(state.message!),
        if (state.failure != null) ...[
          const SizedBox(height: 6),
          Text(
            state.failure is ApiFailure
                ? (state.failure! as ApiFailure).message
                : state.failure.toString(),
            style: const TextStyle(color: Palette.red),
          ),
        ],
        if (state.record?.meetingId != null) ...[
          const SizedBox(height: 8),
          OutlinedButton.icon(
            onPressed: state.isBusy ? null : _openRecovered,
            icon: const Icon(Icons.open_in_new),
            label: const Text('Mở trạng thái hiện tại'),
          ),
        ] else if (state.record != null && state.record!.canReplayCreate) ...[
          const SizedBox(height: 8),
          FilledButton.icon(
            onPressed: state.isBusy ? null : _retryRecovery,
            icon: const Icon(Icons.refresh),
            label: const Text('Khôi phục đúng yêu cầu đã gửi'),
          ),
        ],
        if (state.hasUnresolvedOperation &&
            state.record?.meetingId == null) ...[
          TextButton.icon(
            onPressed: state.isBusy
                ? null
                : () =>
                      Navigator.pop(context, const MeetingFormResult.inspect()),
            icon: const Icon(Icons.search),
            label: const Text('Kiểm tra danh sách cuộc họp'),
          ),
          TextButton(
            onPressed: state.isBusy ? null : _resolveRecovery,
            child: const Text('Tôi đã kiểm tra và muốn xóa yêu cầu chờ'),
          ),
        ],
      ],
    ),
  );
}
