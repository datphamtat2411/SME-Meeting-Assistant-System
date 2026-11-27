import 'dart:async';

import 'package:flutter/material.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/app_dependencies.dart';
import 'package:sme_meeting_assistant/core/app_theme.dart';
import 'package:sme_meeting_assistant/core/models.dart';
import 'package:sme_meeting_assistant/core/widgets.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_editing.dart';
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

  @override
  State<MeetingEditSheet> createState() => _MeetingEditSheetState();
}

class _MeetingEditSheetState extends State<MeetingEditSheet>
    with WidgetsBindingObserver {
  final _form = GlobalKey<FormState>();
  late final MeetingEditingController _controller;
  late final TextEditingController _title;
  late final TextEditingController _description;
  late final SchedulePreviewController _previewController;
  bool _allowPop = false;
  bool _dismissPromptOpen = false;

  Future<void> _guardDismissal(MeetingEditingState state) async {
    if (!mounted || _allowPop || _dismissPromptOpen) return;
    if (state.isSubmitting) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Hãy đợi thao tác hiện tại được xác nhận.'),
        ),
      );
      return;
    }
    if (state.dirtyFields.isEmpty) return;
    _dismissPromptOpen = true;
    try {
      final discard = await showDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: const Text('Bỏ thay đổi chưa lưu?'),
          content: const Text(
            'Nội dung đã nhập sẽ bị loại bỏ. Không có thay đổi nào được gửi lại tự động.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext, false),
              child: const Text('Tiếp tục chỉnh sửa'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(dialogContext, true),
              child: const Text('Bỏ thay đổi'),
            ),
          ],
        ),
      );
      if (discard == true && mounted && !_controller.state.isSubmitting) {
        setState(() => _allowPop = true);
        Navigator.pop(context);
      }
    } finally {
      _dismissPromptOpen = false;
    }
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _controller = MeetingEditingController(
      repository: widget.dependencies.meetings,
      invalidation: widget.dependencies.meetingInvalidation,
      snapshot: widget.snapshot,
    );
    final values = MeetingEditValues.fromMeeting(widget.snapshot.meeting);
    _title = TextEditingController(text: values.title);
    _description = TextEditingController(text: values.description ?? '');
    _previewController = SchedulePreviewController(
      repository: widget.dependencies.roomScheduling,
      sessionScope: widget.snapshot.sessionScope,
    );
    _controller.addListener(_syncPreviewIntent);
    _syncPreviewIntent();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      unawaited(_controller.revalidateOnResume());
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _title.dispose();
    _description.dispose();
    _controller.removeListener(_syncPreviewIntent);
    _controller.dispose();
    _previewController.dispose();
    super.dispose();
  }

  MeetingEditValues? _valuesWith({
    String? title,
    String? description,
    DateTime? start,
    DateTime? end,
    String? roomId,
    bool setRoom = false,
  }) {
    final current = _controller.state.values;
    if (current == null ||
        _controller.state.phase != MeetingEditPhase.editing) {
      return null;
    }
    return MeetingEditValues(
      title: title ?? current.title,
      description: description ?? current.description,
      start: start ?? current.start,
      end: end ?? current.end,
      roomId: setRoom ? roomId : current.roomId,
    );
  }

  void _updateSchedule(MeetingScheduleDraft? draft) {
    final current = _controller.state.values;
    if (current == null ||
        _controller.state.phase != MeetingEditPhase.editing) {
      return;
    }
    _controller.updateValues(
      MeetingEditValues(
        title: current.title,
        description: current.description,
        start: draft?.start,
        end: draft?.end,
        roomId: current.roomId,
      ),
    );
  }

  void _syncPreviewIntent() {
    _previewController.setIntent(_previewIntent(_controller.state));
  }

  MeetingInterval? _validInterval(MeetingEditValues? values) {
    if (values == null || values.start == null || values.end == null) {
      return null;
    }
    return MeetingScheduleDraft(
      start: values.start,
      end: values.end,
    ).validatedInterval;
  }

  ScheduleIntent? _previewIntent(MeetingEditingState state) {
    final snapshot = state.snapshot;
    final values = state.values;
    final interval = _validInterval(values);
    if (snapshot == null ||
        values == null ||
        interval == null ||
        state.phase != MeetingEditPhase.editing ||
        state.needsRevalidation) {
      return null;
    }
    return ScheduleIntent(
      interval: interval,
      meetingId: snapshot.meeting.id,
      roomId: values.roomId,
      organizerId: snapshot.meeting.organizerId,
      meetingVersion: snapshot.etag,
      participantUserIds: null,
    );
  }

  Future<void> _save() async {
    if (!(_form.currentState?.validate() ?? false)) return;
    final state = _controller.state;
    if (_blockingScheduleConflict(state)) {
      return;
    }
    await _controller.submit();
    if (!mounted) return;
    if (_controller.state.phase == MeetingEditPhase.completed) {
      _allowPop = true;
      Navigator.pop(context, _controller.state.snapshot);
    }
  }

  void _acceptReconciliation() {
    _controller.acceptReconciliation();
    final values = _controller.state.values;
    if (values == null) return;
    _title.value = TextEditingValue(
      text: values.title,
      selection: TextSelection.collapsed(offset: values.title.length),
    );
    _description.value = TextEditingValue(
      text: values.description ?? '',
      selection: TextSelection.collapsed(
        offset: (values.description ?? '').length,
      ),
    );
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _controller,
    builder: (context, _) {
      final state = _controller.state;
      if (state.accessRevoked) {
        return const SafeArea(
          child: MessagePanel(
            icon: Icons.lock_outline,
            title: 'Không thể tiếp tục chỉnh sửa',
            description: 'Quyền truy cập cuộc họp đã thay đổi.',
          ),
        );
      }
      final snapshot = state.snapshot;
      final values = state.values;
      if (snapshot == null || values == null) {
        return const SafeArea(
          child: MessagePanel(
            title: 'Không thể tải phiên chỉnh sửa',
            description: 'Hãy đóng cửa sổ và mở lại cuộc họp.',
          ),
        );
      }
      final meeting = snapshot.meeting;
      final canEdit =
          state.phase == MeetingEditPhase.editing && !state.needsRevalidation;
      final draft = values.start == null && values.end == null
          ? null
          : MeetingScheduleDraft(start: values.start, end: values.end);
      final intent = _previewIntent(state);
      final blockingScheduleConflict = _blockingScheduleConflict(state);
      return PopScope<MeetingSnapshot>(
        canPop:
            _allowPop ||
            state.dirtyFields.isEmpty ||
            state.phase == MeetingEditPhase.completed,
        onPopInvokedWithResult: (didPop, _) {
          if (!didPop && !_allowPop) unawaited(_guardDismissal(state));
        },
        child: SafeArea(
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
                        subtitle: 'Chỉ các trường bạn thay đổi mới được gửi lên máy chủ.',
                      ),
                      if (state.phase == MeetingEditPhase.submitting)
                        const LinearProgressIndicator(),
                      TextFormField(
                        controller: _title,
                        enabled: canEdit,
                        maxLength: 255,
                        decoration: const InputDecoration(
                          labelText: 'Tên cuộc họp',
                        ),
                        validator: (value) =>
                            value == null || value.trim().isEmpty
                            ? 'Tên cuộc họp không được để trống.'
                            : value.trim().length > 255
                            ? 'Tên cuộc họp tối đa 255 ký tự.'
                            : null,
                        onChanged: (value) {
                          if (!canEdit) return;
                          final next = _valuesWith(title: value);
                          if (next != null) _controller.updateValues(next);
                        },
                      ),
                      TextField(
                        controller: _description,
                        enabled: canEdit,
                        maxLines: 3,
                        decoration: const InputDecoration(labelText: 'Mô tả'),
                        onChanged: (value) {
                          if (!canEdit) return;
                          final next = _valuesWith(description: value);
                          if (next != null) _controller.updateValues(next);
                        },
                      ),
                      const SizedBox(height: 12),
                      MeetingScheduleFields(
                        draft: draft,
                        enabled: canEdit,
                        onDraftChanged: (value) {
                          if (canEdit) _updateSchedule(value);
                        },
                        allowUnscheduled:
                            meeting.lifecycleStatus == MeetingStatus.draft,
                      ),
                      MeetingRoomSelector(
                        repository: widget.dependencies.roomScheduling,
                        sessionScope: snapshot.sessionScope,
                        selectedId: values.roomId,
                        interval: intent?.interval,
                        participantCount: null,
                        enabled: canEdit,
                        onChanged: canEdit
                            ? (roomId) {
                                if (_controller.state.phase !=
                                    MeetingEditPhase.editing) {
                                  return;
                                }
                                final next = _valuesWith(
                                  roomId: roomId,
                                  setRoom: true,
                                );
                                if (next != null)
                                  _controller.updateValues(next);
                              }
                            : (_) {},
                      ),
                      SchedulePreviewCard(
                        repository: widget.dependencies.roomScheduling,
                        sessionScope: snapshot.sessionScope,
                        intent: intent,
                        previewController: _previewController,
                      ),
                      if (blockingScheduleConflict)
                        const MessagePanel(
                          icon: Icons.meeting_room_outlined,
                          title: 'Phòng đang bị trùng lịch',
                          description: 'Hãy chọn phòng khác hoặc điều chỉnh thời gian trước khi lưu thay đổi lịch.',
                        ),
                      if (state.dirtyFields.isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(top: 6),
                          child: Text(
                            'Trường thay đổi: ${state.dirtyFields.map(_fieldLabel).join(', ')}',
                            style: const TextStyle(color: Palette.muted),
                          ),
                        ),
                      if (state.needsRevalidation)
                        MessagePanel(
                          icon: Icons.sync_problem_outlined,
                          title: 'Phiên bản có thể đã thay đổi',
                          description: 'Giữ nguyên nội dung đã nhập và tải phiên bản mới để đối chiếu.',
                          onRetry: state.isSubmitting
                              ? null
                              : _controller.revalidateLatest,
                        ),
                      if (state.reconciliation != null)
                        _reconciliationPanel(
                          state.reconciliation!,
                          state.needsRevalidation,
                        ),
                      if (state.message != null)
                        Padding(
                          padding: const EdgeInsets.only(top: 8),
                          child: Text(
                            state.message!,
                            style: const TextStyle(color: Palette.amber),
                          ),
                        ),
                      if (state.failure != null)
                        Padding(
                          padding: const EdgeInsets.only(top: 8),
                          child: Text(
                            state.failure is ApiFailure
                                ? (state.failure! as ApiFailure).message
                                : state.failure.toString(),
                            style: const TextStyle(color: Palette.red),
                          ),
                        ),
                      const SizedBox(height: 14),
                      FilledButton.icon(
                        onPressed: canEdit && state.canSubmit ? _save : null,
                        icon: const Icon(Icons.save_outlined),
                        label: Text(
                          state.phase == MeetingEditPhase.submitting
                              ? 'Đang lưu...'
                              : 'Lưu thay đổi',
                        ),
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
        ),
      );
    },
  );

  Widget _reconciliationPanel(
    MeetingEditReconciliation reconciliation,
    bool needsRevalidation,
  ) {
    final hasConflicts = reconciliation.unresolvedConflicts.isNotEmpty;
    return ContentCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Đối chiếu phiên bản mới',
            style: TextStyle(fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 8),
          ...MeetingEditField.values.map((field) {
            final localChanged = !_sameFieldForDisplay(
              field,
              reconciliation.original,
              reconciliation.local,
            );
            final serverChanged = !_sameFieldForDisplay(
              field,
              reconciliation.original,
              reconciliation.server,
            );
            if (!localChanged && !serverChanged) {
              return const SizedBox.shrink();
            }
            final conflict = reconciliation.conflicts.contains(field);
            final choice = reconciliation.choices[field];
            return Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    _fieldLabel(field),
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                  Text(
                    'Ban đầu: ${_valueLabel(field, reconciliation.original)}',
                  ),
                  Text('Bạn nhập: ${_valueLabel(field, reconciliation.local)}'),
                  Text('Máy chủ: ${_valueLabel(field, reconciliation.server)}'),
                  if (conflict)
                    Wrap(
                      spacing: 8,
                      children: [
                        ChoiceChip(
                          label: const Text('Giữ nội dung của tôi'),
                          selected: choice == MeetingEditFieldChoice.local,
                          onSelected: (_) => _controller.chooseConflict(
                            field,
                            MeetingEditFieldChoice.local,
                          ),
                        ),
                        ChoiceChip(
                          label: const Text('Dùng phiên bản máy chủ'),
                          selected: choice == MeetingEditFieldChoice.server,
                          onSelected: (_) => _controller.chooseConflict(
                            field,
                            MeetingEditFieldChoice.server,
                          ),
                        ),
                      ],
                    ),
                ],
              ),
            );
          }),
          FilledButton(
            onPressed: hasConflicts || needsRevalidation
                ? null
                : _acceptReconciliation,
            child: const Text('Xác nhận phiên bản mới'),
          ),
        ],
      ),
    );
  }

  bool _blockingScheduleConflict(MeetingEditingState state) {
    final snapshot = state.snapshot;
    if (snapshot?.meeting.lifecycleStatus != MeetingStatus.scheduled ||
        (!state.dirtyFields.contains(MeetingEditField.schedule) &&
            !state.dirtyFields.contains(MeetingEditField.room))) {
      return false;
    }
    final intent = _previewIntent(state);
    final previewState = _previewController.state;
    return intent != null &&
        previewState.phase == SchedulePreviewPhase.current &&
        previewState.intent == intent &&
        previewState.preview?.roomConflict == true;
  }
}

String _fieldLabel(MeetingEditField field) => switch (field) {
  MeetingEditField.title => 'Tên cuộc họp',
  MeetingEditField.description => 'Mô tả',
  MeetingEditField.schedule => 'Khoảng thời gian',
  MeetingEditField.room => 'Phòng họp',
};

String _valueLabel(MeetingEditField field, MeetingEditValues values) =>
    switch (field) {
      MeetingEditField.title => values.title,
      MeetingEditField.description =>
        values.description == null || values.description!.trim().isEmpty
            ? 'Để trống'
            : values.description!,
      MeetingEditField.schedule =>
        values.start == null && values.end == null
            ? 'Chưa xác định'
            : '${dateLabel(values.start)} — ${dateLabel(values.end)}',
      MeetingEditField.room =>
        values.roomId == null ? 'Chưa chọn phòng' : 'Đã chọn phòng',
    };

bool _sameFieldForDisplay(
  MeetingEditField field,
  MeetingEditValues first,
  MeetingEditValues second,
) {
  switch (field) {
    case MeetingEditField.title:
      return first.title.trim() == second.title.trim();
    case MeetingEditField.description:
      return (first.description?.trim().isEmpty ?? true
              ? null
              : first.description?.trim()) ==
          (second.description?.trim().isEmpty ?? true
              ? null
              : second.description?.trim());
    case MeetingEditField.schedule:
      return first.start?.toUtc() == second.start?.toUtc() &&
          first.end?.toUtc() == second.end?.toUtc();
    case MeetingEditField.room:
      return first.roomId?.toLowerCase() == second.roomId?.toLowerCase();
  }
}
