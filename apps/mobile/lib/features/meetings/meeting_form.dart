import 'dart:async';

import 'package:flutter/material.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/app_dependencies.dart';
import 'package:sme_meeting_assistant/core/app_theme.dart';
import 'package:sme_meeting_assistant/core/ui_presentation.dart';
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
  bool _allowPop = false;
  bool _dismissPromptOpen = false;

  MeetingInterval? get _interval => _scheduleDraft?.validatedInterval;

  bool get _hasUnsavedInput =>
      _title.text.trim().isNotEmpty ||
      _description.text.trim().isNotEmpty ||
      _scheduleDraft != null ||
      _roomId != null ||
      _members.isNotEmpty;

  Future<void> _guardDismissal(MeetingCreationState state) async {
    if (!mounted || _allowPop || _dismissPromptOpen) return;
    if (state.isBusy) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Hãy đợi thao tác hiện tại hoàn tất.')),
      );
      return;
    }
    if (!state.hasUnresolvedOperation && !_hasUnsavedInput) return;
    _dismissPromptOpen = true;
    try {
      final keepRecovery = state.hasUnresolvedOperation;
      final leave = await showDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: Text(
            keepRecovery ? 'Rời biểu mẫu khôi phục?' : 'Bỏ thay đổi chưa lưu?',
          ),
          content: Text(
            keepRecovery
                ? 'Yêu cầu đã gửi sẽ được giữ trên thiết bị để bạn khôi phục sau.'
                : 'Các thay đổi chưa gửi sẽ bị loại bỏ.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext, false),
              child: const Text('Tiếp tục ở lại'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(dialogContext, true),
              child: Text(
                keepRecovery ? 'Rời và giữ khôi phục' : 'Bỏ thay đổi',
              ),
            ),
          ],
        ),
      );
      if (leave == true && mounted && !_creation.state.isBusy) {
        setState(() => _allowPop = true);
        Navigator.pop(context);
      }
    } finally {
      _dismissPromptOpen = false;
    }
  }

  void _popWithResult(MeetingFormResult result) {
    if (!mounted) return;
    setState(() => _allowPop = true);
    Navigator.pop(context, result);
  }

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
    _creation.addListener(_onObservedStateChanged);
    _previewController.addListener(_onObservedStateChanged);
    _title.addListener(_onTextChanged);
    _description.addListener(_onTextChanged);
    _updatePreviewIntent();
    unawaited(_creation.restore());
  }

  @override
  void dispose() {
    _creation.removeListener(_onObservedStateChanged);
    _previewController.removeListener(_onObservedStateChanged);
    _title.removeListener(_onTextChanged);
    _description.removeListener(_onTextChanged);
    _title.dispose();
    _description.dispose();
    _creation.dispose();
    _previewController.dispose();
    super.dispose();
  }

  void _onObservedStateChanged() {
    if (mounted) setState(() {});
  }

  void _onTextChanged() {
    if (mounted) setState(() {});
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
    if (!_creation.state.canEdit || !_creation.ownsSession) return;
    setState(() => _scheduleDraft = value);
    _updatePreviewIntent();
  }

  void _changeRoom(String? value) {
    if (!_creation.state.canEdit || !_creation.ownsSession) return;
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
    if (selected == null ||
        !mounted ||
        !_creation.state.canEdit ||
        !_creation.ownsSession) {
      return;
    }
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
      _popWithResult(MeetingFormResult.meeting(snapshot.meeting.id));
    }
  }

  Future<void> _retryRecovery() async {
    final record = _creation.state.record;
    if (record == null || !_creation.canReplayCreate(record)) return;
    try {
      await _creation.retryUnresolvedCreation();
    } catch (error) {
      if (mounted) showFailure(context, error);
    }
    if (!mounted) return;
    final snapshot = _creation.state.snapshot;
    if (_creation.state.phase == MeetingCreationPhase.completed &&
        snapshot != null) {
      _popWithResult(MeetingFormResult.meeting(snapshot.meeting.id));
    }
  }

  Future<void> _openRecovered() async {
    try {
      final meetingId = await _creation.openRecoveredMeeting();
      if (meetingId != null && mounted) {
        _popWithResult(MeetingFormResult.meeting(meetingId));
      }
    } catch (error) {
      if (mounted) showFailure(context, error);
    }
  }

  Future<void> _resolveRecovery() async {
    final reviewed = _creation.recoveryContext;
    final reviewedSession = _scope;
    if (reviewed == null || reviewed.fingerprint == null) return;
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
    if (!widget.api.isCurrentAuthenticatedSession(reviewedSession) ||
        !_creation.ownsSession) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'Phiên đăng nhập đã thay đổi. Hãy tải lại trạng thái khôi phục.',
          ),
        ),
      );
      return;
    }
    try {
      final cleared = await _creation.resolveAfterManualReview(
        reviewedContext: reviewed,
      );
      if (!cleared && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'Thông tin khôi phục đang bận hoặc đã thay đổi. Hãy tải lại và kiểm tra lại trước khi tiếp tục.',
            ),
          ),
        );
      }
    } catch (error) {
      if (mounted) showFailure(context, error);
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = _creation.state;
    final canEdit = state.canEdit;
    final hasSession = widget.api.isCurrentAuthenticatedSession(_scope);
    final previewState = _previewController.state;
    final blockingRoomConflict =
        previewState.phase == SchedulePreviewPhase.current &&
        previewState.intent == _previewIntent &&
        previewState.preview?.roomConflict == true;
    return PopScope<Object?>(
      canPop:
          _allowPop ||
          (!state.isBusy && !state.hasUnresolvedOperation && !_hasUnsavedInput),
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop && !_allowPop) unawaited(_guardDismissal(state));
      },
      child: SafeArea(
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
                      enabled: canEdit && hasSession,
                      onDraftChanged: (value) {
                        if (canEdit && hasSession) _changeSchedule(value);
                      },
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
                        enabled: canEdit && hasSession,
                        onChanged: (value) {
                          if (canEdit && hasSession) _changeRoom(value);
                        },
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
      ),
    );
  }

  Widget _creationStatus(MeetingCreationState state) => ContentCard(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (state.message != null) Text(state.message!),
        if (state.failure != null) ...[
          const SizedBox(height: 6),
          Text(
            apiFailureLabel(state.failure),
            style: const TextStyle(color: Palette.red),
          ),
        ],
        if (state.recoveryBusy)
          TextButton.icon(
            onPressed: state.isBusy ? null : _creation.restore,
            icon: const Icon(Icons.sync),
            label: const Text('Tải lại trạng thái khôi phục'),
          ),
        if (state.record?.meetingId != null) ...[
          const SizedBox(height: 8),
          OutlinedButton.icon(
            onPressed: state.isBusy || state.recoveryBusy
                ? null
                : _openRecovered,
            icon: const Icon(Icons.open_in_new),
            label: const Text('Mở trạng thái hiện tại'),
          ),
        ] else if (state.record != null &&
            _creation.canReplayCreate(state.record!)) ...[
          const SizedBox(height: 8),
          FilledButton.icon(
            onPressed: state.isBusy || state.recoveryBusy
                ? null
                : _retryRecovery,
            icon: const Icon(Icons.refresh),
            label: const Text('Khôi phục đúng yêu cầu đã gửi'),
          ),
        ],
        if (state.record != null &&
            state.record?.meetingId == null &&
            !_creation.canReplayCreate(state.record!))
          const Padding(
            padding: EdgeInsets.only(top: 8),
            child: Text(
              'Không thể xác minh thời hạn gửi lại an toàn. Hãy kiểm tra danh sách cuộc họp trước khi tiếp tục.',
            ),
          ),
        if (state.hasUnresolvedOperation &&
            state.record?.meetingId == null) ...[
          TextButton.icon(
            onPressed: state.isBusy || state.recoveryBusy
                ? null
                : () => _popWithResult(const MeetingFormResult.inspect()),
            icon: const Icon(Icons.search),
            label: const Text('Kiểm tra danh sách cuộc họp'),
          ),
          TextButton(
            onPressed: state.isBusy || state.recoveryBusy
                ? null
                : _resolveRecovery,
            child: const Text('Tôi đã kiểm tra và muốn xóa yêu cầu chờ'),
          ),
        ],
      ],
    ),
  );
}
