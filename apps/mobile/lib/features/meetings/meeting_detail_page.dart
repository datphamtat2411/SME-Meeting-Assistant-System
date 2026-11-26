import 'dart:async';

import 'package:flutter/material.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/app_dependencies.dart';
import 'package:sme_meeting_assistant/core/app_theme.dart';
import 'package:sme_meeting_assistant/core/models.dart';
import 'package:sme_meeting_assistant/core/widgets.dart';
import 'package:sme_meeting_assistant/features/assistant/assistant_page.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_detail_controller.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_edit_sheet.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_foundation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_participants.dart';
import 'package:sme_meeting_assistant/features/recording/processing_timeline_panel.dart';
import 'package:sme_meeting_assistant/features/recording/recording_page.dart';
import 'package:sme_meeting_assistant/features/results/results_panel.dart';

class MeetingDetailPage extends StatefulWidget {
  const MeetingDetailPage({
    super.key,
    required this.dependencies,
    required this.meetingId,
    this.openRecording = false,
    this.initialResultsSection,
  });

  final AppDependencies dependencies;
  final String meetingId;
  final bool openRecording;
  final ResultsSection? initialResultsSection;
  ApiClient get api => dependencies.api;

  @override
  State<MeetingDetailPage> createState() => _MeetingDetailPageState();
}

class _MeetingDetailPageState extends State<MeetingDetailPage>
    with WidgetsBindingObserver {
  late MeetingDetailController _controller;
  int _tab = 0;
  bool _openingAssistant = false;
  bool _assistantOriginVisible = false;
  bool _foreground = true;
  int _assistantIntentGeneration = 0;

  @override
  void initState() {
    super.initState();
    _tab = widget.openRecording
        ? 2
        : widget.initialResultsSection != null
        ? 1
        : 0;
    final lifecycle = WidgetsBinding.instance.lifecycleState;
    _foreground = lifecycle == null || lifecycle == AppLifecycleState.resumed;
    WidgetsBinding.instance.addObserver(this);
    _createController();
  }

  void _createController() {
    _controller = MeetingDetailController(
      meetings: widget.dependencies.meetings,
      membership: widget.dependencies.meetingMembership,
      rooms: widget.dependencies.roomScheduling,
      invalidation: widget.dependencies.meetingInvalidation,
      meetingId: widget.meetingId,
      results: widget.dependencies.results,
      resultsInvalidation: widget.dependencies.resultsInvalidation,
      processingManager: widget.dependencies.processingManager,
    );
    unawaited(_controller.initialize());
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final visible = ModalRoute.isCurrentOf(context) ?? true;
    if (_assistantOriginVisible == visible) return;
    _assistantOriginVisible = visible;
    if (!visible) _assistantIntentGeneration++;
  }

  @override
  void didUpdateWidget(covariant MeetingDetailPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.meetingId == widget.meetingId &&
        identical(oldWidget.dependencies, widget.dependencies)) {
      return;
    }
    _assistantIntentGeneration++;
    _controller.dispose();
    _createController();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    if (!_foreground) _assistantIntentGeneration++;
    if (_foreground) {
      unawaited(_controller.revalidateOnResume());
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _controller.dispose();
    super.dispose();
  }

  Future<void> _edit(MeetingSnapshot snapshot) async {
    final token = _controller.acquireAggregateMutation(
      MeetingDetailMutation.editing,
      confirmedContext: snapshot,
    );
    if (token == null) return;
    try {
      final updated = await showModalBottomSheet<MeetingSnapshot>(
        context: context,
        isScrollControlled: true,
        isDismissible: false,
        enableDrag: false,
        showDragHandle: true,
        builder: (_) => MeetingEditSheet(
          dependencies: widget.dependencies,
          snapshot: snapshot,
        ),
      );
      if (updated != null && mounted) {
        await _controller.acceptAggregateSnapshotAndReconcile(token, updated);
      }
    } finally {
      _controller.releaseAggregateMutation(token);
    }
  }

  Future<void> _lifecycle(
    MeetingSnapshot snapshot,
    MeetingLifecycleCommand command,
  ) async {
    final input = await _confirmLifecycle(snapshot, command);
    if (input == null || !mounted) return;
    final result = await _controller.runLifecycle(
      command: command,
      confirmedContext: snapshot,
      cancellationReason: input.cancellationReason,
    );
    if (!mounted) return;
    switch (result.status) {
      case MeetingLifecycleResultStatus.confirmed ||
          MeetingLifecycleResultStatus.observed:
        showSuccess(context, result.message);
      case MeetingLifecycleResultStatus.rejected ||
          MeetingLifecycleResultStatus.blocked:
        if (result.failure != null) {
          showFailure(context, result.failure!);
        } else {
          ScaffoldMessenger.of(context)
              .showSnackBar(SnackBar(content: Text(result.message)));
        }
      case MeetingLifecycleResultStatus.unknown:
        if (result.failure != null) {
          showFailure(context, result.failure!);
        } else {
          ScaffoldMessenger.of(context)
              .showSnackBar(SnackBar(content: Text(result.message)));
        }
    }
  }

  Future<_LifecycleConfirmation?> _confirmLifecycle(
    MeetingSnapshot snapshot,
    MeetingLifecycleCommand command,
  ) async {
    final meeting = snapshot.meeting;
    final title = switch (command) {
      MeetingLifecycleCommand.schedule => 'Xác nhận lên lịch?',
      MeetingLifecycleCommand.start => 'Bắt đầu cuộc họp?',
      MeetingLifecycleCommand.end => 'Kết thúc cuộc họp?',
      MeetingLifecycleCommand.cancel => 'Hủy cuộc họp?',
    };
    final detail = switch (command) {
      MeetingLifecycleCommand.schedule =>
        'Gửi yêu cầu lên lịch ${dateLabel(meeting.scheduledStartAt)} tại ${_controller.state.roomDisplayName}. Phòng chỉ được xác nhận khi máy chủ phản hồi thành công.',
      MeetingLifecycleCommand.start =>
        'Cuộc họp sẽ chuyển sang trạng thái đang diễn ra.',
      MeetingLifecycleCommand.end =>
        'Cuộc họp sẽ chuyển sang trạng thái đã kết thúc.',
      MeetingLifecycleCommand.cancel =>
        'Cuộc họp được giữ lại làm lịch sử. Bạn có thể nhập lý do hủy.',
    };
    if (command != MeetingLifecycleCommand.cancel) {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: Text(title),
          content: Text('$detail\n\nTrạng thái hiện tại: ${meeting.status}.'),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext, false),
              child: const Text('Quay lại'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(dialogContext, true),
              child: const Text('Xác nhận'),
            ),
          ],
        ),
      );
      return confirmed == true ? const _LifecycleConfirmation() : null;
    }

    final reason = TextEditingController();
    try {
      final confirmed = await showDialog<String?>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: Text(title),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('$detail\n\nTrạng thái hiện tại: ${meeting.status}.'),
              const SizedBox(height: 12),
              TextField(
                controller: reason,
                maxLength: 500,
                maxLines: 3,
                decoration: const InputDecoration(
                  labelText: 'Lý do hủy (không bắt buộc)',
                ),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext),
              child: const Text('Quay lại'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(dialogContext, reason.text),
              child: const Text('Xác nhận hủy'),
            ),
          ],
        ),
      );
      if (confirmed == null) return null;
      return _LifecycleConfirmation(cancellationReason: confirmed);
    } finally {
      reason.dispose();
    }
  }

  Future<void> _openAssistant(MeetingSnapshot snapshot) async {
    if (_openingAssistant || !mounted || !_foreground || _tab != 0) return;
    final scope = snapshot.sessionScope;
    final meeting = snapshot.meeting;
    final dependencies = widget.dependencies;
    final generation = ++_assistantIntentGeneration;
    bool owns() =>
        mounted &&
        _foreground &&
        _assistantOriginVisible &&
        _tab == 0 &&
        generation == _assistantIntentGeneration &&
        identical(dependencies, widget.dependencies) &&
        widget.api.isCurrentAuthenticatedSession(scope) &&
        _controller.state.snapshot?.meeting.id == meeting.id &&
        (ModalRoute.of(context)?.isCurrent ?? true);
    setState(() => _openingAssistant = true);
    try {
      final allowed = await widget.dependencies.results.verifyReadAccess(
        sessionScope: scope,
        meetingId: meeting.id,
      );
      if (!owns()) return;
      if (!allowed) {
        dependencies.forgetAssistantMeeting(scope, meeting.id);
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Không thể truy cập nội dung cuộc họp.'),
          ),
        );
        return;
      }
      await Navigator.push<void>(
        context,
        MaterialPageRoute<void>(
          builder: (_) => Scaffold(
            appBar: AppBar(title: const Text('Trợ lý cuộc họp')),
            body: SafeArea(
              child: AssistantPage(
                dependencies: widget.dependencies,
                active: true,
                contextualMeeting: meeting,
              ),
            ),
          ),
        ),
      );
    } on Object catch (error) {
      if (owns()) {
        if (error is ApiFailure &&
            (error.status == 403 || error.status == 404)) {
          dependencies.forgetAssistantMeeting(scope, meeting.id);
        }
        showFailure(context, error);
      }
    } finally {
      if (mounted) setState(() => _openingAssistant = false);
    }
  }

  Widget _overview(MeetingDetailState state, MeetingSnapshot snapshot) {
    final meeting = snapshot.meeting;
    final capabilities = MeetingCapabilityPolicy.evaluate(
      callerId: widget.api.userId,
      meeting: meeting,
    );
    final busy =
        state.activeMutation != null ||
        state.needsRevalidation ||
        state.phase != MeetingDetailPhase.ready;
    final canAsk = MeetingCapabilityPolicy.evaluate(
      callerId: widget.api.userId,
      meeting: meeting,
      callerIsActiveParticipant:
          state.participantsLoaded &&
          state.participants.any(
            (participant) =>
                participant.isActive &&
                participant.userId.toLowerCase() ==
                    widget.api.userId.toLowerCase(),
          ),
    ).canReadMedia;
    final validInterval = MeetingScheduleDraft(
      start: meeting.scheduledStartAt,
      end: meeting.scheduledEndAt,
    ).validatedInterval;
    return ListView(
      padding: const EdgeInsets.all(18),
      children: [
        SectionHeading(meeting.title, subtitle: 'Thông tin cuộc họp'),
        if (state.message != null)
          MessagePanel(
            icon: state.phase == MeetingDetailPhase.recoveryRequired
                ? Icons.sync_problem_outlined
                : Icons.info_outline,
            title: state.phase == MeetingDetailPhase.recoveryRequired
                ? 'Cần xác nhận trạng thái'
                : 'Thông tin cập nhật',
            description: state.message!,
            onRetry: state.phase == MeetingDetailPhase.recoveryRequired
                ? _controller.refresh
                : null,
          ),
        if (state.failure != null)
          MessagePanel(
            icon: Icons.cloud_off_outlined,
            title: 'Không thể làm mới cuộc họp',
            description: _failureMessage(state.failure),
            onRetry: _controller.refresh,
          ),
        if (canAsk)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: ContentCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Trợ lý cuộc họp'),
                  const SizedBox(height: 6),
                  const Text('Tra cứu nội dung và bằng chứng từ cuộc họp này.'),
                  const SizedBox(height: 12),
                  FilledButton.icon(
                    onPressed: busy || _openingAssistant
                        ? null
                        : () => _openAssistant(snapshot),
                    icon: const Icon(Icons.auto_awesome),
                    label: const Text('Hỏi trợ lý về cuộc họp này'),
                  ),
                ],
              ),
            ),
          ),
        if (capabilities.canEdit)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: OutlinedButton.icon(
              onPressed: busy ? null : () => _edit(snapshot),
              icon: const Icon(Icons.edit_outlined),
              label: const Text('Chỉnh sửa cuộc họp'),
            ),
          ),
        ContentCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              StatePill(meeting.status),
              const SizedBox(height: 16),
              Text(
                meeting.description == null || meeting.description!.isEmpty
                    ? 'Chưa có mô tả'
                    : meeting.description!,
              ),
              const Divider(height: 26),
              _line(
                Icons.event,
                'Bắt đầu',
                dateLabel(meeting.scheduledStartAt),
              ),
              _line(
                Icons.schedule,
                'Kết thúc',
                dateLabel(meeting.scheduledEndAt),
              ),
              _line(
                Icons.meeting_room_outlined,
                'Phòng họp',
                state.roomDisplayName,
              ),
              _line(
                Icons.person_outline,
                'Người tổ chức',
                state.organizerDisplayName,
              ),
              _line(
                Icons.people_outline,
                'Người tham gia',
                state.participantsLoaded
                    ? '${state.activeParticipantCount} đang hoạt động'
                    : 'Thông tin tạm thời chưa khả dụng',
              ),
              if (meeting.startedAt != null)
                _line(
                  Icons.play_arrow,
                  'Đã bắt đầu',
                  dateLabel(meeting.startedAt),
                ),
              if (meeting.endedAt != null)
                _line(Icons.stop, 'Đã kết thúc', dateLabel(meeting.endedAt)),
              if (meeting.cancelledAt != null) ...[
                _line(
                  Icons.cancel_outlined,
                  'Đã hủy',
                  dateLabel(meeting.cancelledAt),
                ),
                if (meeting.cancellationReason != null &&
                    meeting.cancellationReason!.trim().isNotEmpty)
                  _line(
                    Icons.notes_outlined,
                    'Lý do hủy',
                    meeting.cancellationReason!,
                  ),
              ],
              if (state.metadataFailure != null)
                const Padding(
                  padding: EdgeInsets.only(top: 8),
                  child: Text(
                    'Một số thông tin liên quan chưa thể tải; dữ liệu cuộc họp vẫn do máy chủ xác nhận.',
                    style: TextStyle(color: Palette.muted, fontSize: 12),
                  ),
                ),
            ],
          ),
        ),
        if (state.activeMutation != null)
          const Center(
            child: Padding(
              padding: EdgeInsets.all(16),
              child: CircularProgressIndicator(),
            ),
          ),
        if (capabilities.canSchedule)
          FilledButton.icon(
            onPressed: busy || validInterval == null
                ? null
                : () => _lifecycle(snapshot, MeetingLifecycleCommand.schedule),
            icon: const Icon(Icons.event_available),
            label: Text(
              validInterval == null
                  ? 'Đặt thời gian trước khi xác nhận'
                  : 'Xác nhận lịch',
            ),
          ),
        if (capabilities.canStart)
          FilledButton.icon(
            onPressed: busy
                ? null
                : () => _lifecycle(snapshot, MeetingLifecycleCommand.start),
            icon: const Icon(Icons.play_arrow),
            label: const Text('Bắt đầu cuộc họp'),
          ),
        if (capabilities.canEnd)
          FilledButton.icon(
            onPressed: busy
                ? null
                : () => _lifecycle(snapshot, MeetingLifecycleCommand.end),
            icon: const Icon(Icons.stop),
            label: const Text('Kết thúc cuộc họp'),
          ),
        if (capabilities.canCancel)
          OutlinedButton.icon(
            onPressed: busy
                ? null
                : () => _lifecycle(snapshot, MeetingLifecycleCommand.cancel),
            icon: const Icon(Icons.cancel_outlined),
            label: const Text('Hủy cuộc họp'),
          ),
        const SizedBox(height: 16),
        const MessagePanel(
          icon: Icons.shield_outlined,
          title: 'Dữ liệu được phân quyền',
          description: 'Người tham gia, trạng thái xử lý và tài liệu được kiểm tra bởi Core API.',
        ),
      ],
    );
  }

  Widget _line(IconData icon, String label, String value) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, size: 19, color: Palette.muted),
        const SizedBox(width: 10),
        SizedBox(
          width: 95,
          child: Text(label, style: const TextStyle(color: Palette.muted)),
        ),
        Expanded(
          child: Text(
            value,
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
        ),
      ],
    ),
  );

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _controller,
    builder: (context, _) {
      final state = _controller.state;
      if (state.accessRevoked) {
        return Scaffold(
          appBar: AppBar(title: const Text('Chi tiết cuộc họp')),
          body: const MessagePanel(
            icon: Icons.lock_outline,
            title: 'Không thể truy cập cuộc họp',
            description: 'Quyền truy cập đã thay đổi. Dữ liệu được xóa.',
          ),
        );
      }
      final snapshot = state.snapshot;
      final callerIsActiveParticipant =
          state.participantsLoaded &&
          state.participants.any(
            (participant) =>
                participant.isActive && participant.userId == widget.api.userId,
          );
      final mediaCapabilities = MeetingCapabilityPolicy.evaluate(
        callerId: widget.api.userId,
        meeting: snapshot?.meeting,
        callerIsActiveParticipant: callerIsActiveParticipant,
      );
      return Scaffold(
        appBar: AppBar(
          title: const Text('Chi tiết cuộc họp'),
          actions: [
            IconButton(
              tooltip: 'Làm mới',
              onPressed: state.activeMutation == null
                  ? _controller.refresh
                  : null,
              icon: const Icon(Icons.refresh),
            ),
          ],
        ),
        body: snapshot == null
            ? state.isLoading
                  ? const Center(child: CircularProgressIndicator())
                  : MessagePanel(
                      icon: Icons.cloud_off_outlined,
                      title: 'Không thể tải cuộc họp',
                      description: _failureMessage(state.failure),
                      onRetry: _controller.refresh,
                    )
            : Column(
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
                    child: Wrap(
                      spacing: 6,
                      runSpacing: 4,
                      children: [
                        for (final tab in const [
                          (0, 'Tổng quan', Icons.dashboard_outlined),
                          (1, 'Biên bản AI', Icons.auto_awesome_outlined),
                          (2, 'Ghi âm', Icons.mic_none_outlined),
                          (3, 'Thành viên', Icons.people_outline),
                          (4, 'Xử lý', Icons.sync_outlined),
                        ])
                          Semantics(
                            button: true,
                            selected: _tab == tab.$1,
                            label: tab.$2,
                            child: GestureDetector(
                              onTap: state.activeMutation == null
                                  ? () => setState(() {
                                      if (_tab != tab.$1) {
                                        _assistantIntentGeneration++;
                                      }
                                      _tab = tab.$1;
                                    })
                                  : null,
                              child: Container(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 12,
                                  vertical: 8,
                                ),
                                decoration: BoxDecoration(
                                  color: _tab == tab.$1
                                      ? Theme.of(context)
                                            .colorScheme
                                            .secondaryContainer
                                      : Theme.of(context)
                                            .colorScheme
                                            .surfaceContainerHighest,
                                  borderRadius: BorderRadius.circular(20),
                                ),
                                child: Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    Icon(tab.$3, size: 17),
                                    const SizedBox(width: 6),
                                    Text(tab.$2),
                                  ],
                                ),
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
                  Expanded(
                    child: switch (_tab) {
                      0 => _overview(state, snapshot),
                      1 => _resultsPanel(state, snapshot),
                      2 => RecordingPage(
                        api: widget.api,
                        meetingId: widget.meetingId,
                        enabled: mediaCapabilities.canUploadMedia,
                        capabilities: mediaCapabilities,
                        meetingStatus: snapshot.meeting.lifecycleStatus,
                        localMedia: widget.dependencies.localMedia,
                        mediaRepository: widget.dependencies.media,
                        processingRepository: widget.dependencies.processing,
                        recordingCoordinator: widget.dependencies.recording,
                        submissionCoordinator: widget.dependencies.submissions,
                        processingManager:
                            widget.dependencies.processingManager,
                      ),
                      3 => MeetingParticipants(
                        key: ValueKey(
                          'membership-${snapshot.meeting.id.toLowerCase()}',
                        ),
                        dependencies: widget.dependencies,
                        snapshot: snapshot,
                        initialRecords: state.participantsLoaded
                            ? state.participants
                            : null,
                        onRecordsChanged: _controller.acceptMembershipRecords,
                        onSnapshotRecordsChanged:
                            _controller.acceptMembershipSnapshotRecords,
                        onAccessRevoked: _controller.membershipAccessRevoked,
                        canStartAggregateMutation: () =>
                            _controller.state.canStartAggregateMutation,
                        acquireAggregateMutation: (confirmedContext) =>
                            _controller.acquireAggregateMutation(
                              MeetingDetailMutation.membership,
                              confirmedContext: confirmedContext,
                            ),
                        releaseAggregateMutation:
                            _controller.releaseAggregateMutation,
                        ownsAggregateMutation:
                            _controller.ownsAggregateMutation,
                        acceptAggregateSnapshot:
                            _controller.acceptAggregateSnapshot,
                        acceptAggregateSnapshotAndReconcile:
                            _controller.acceptAggregateSnapshotAndReconcile,
                        revalidateAggregate: _controller.revalidateAggregate,
                        refreshCanonical: _controller.refreshCanonicalForChild,
                        addCanonicalSnapshotListener:
                            _controller.addCanonicalSnapshotListener,
                      ),
                      _ => ProcessingTimelinePanel(
                        api: widget.api,
                        meetingId: snapshot.meeting.id,
                        processingManager:
                            widget.dependencies.processingManager,
                        canRetry: mediaCapabilities.canRetryProcessing,
                        capabilities: mediaCapabilities,
                      ),
                    },
                  ),
                ],
              ),
      );
    },
  );

  String _failureMessage(Object? error) =>
      error is ApiFailure ? error.message : 'Đã xảy ra lỗi không mong muốn.';

  Widget _resultsPanel(MeetingDetailState state, MeetingSnapshot snapshot) {
    final capabilities = MeetingCapabilityPolicy.evaluate(
      callerId: widget.api.userId,
      meeting: snapshot.meeting,
      callerIsActiveParticipant:
          state.participantsLoaded &&
          state.participants.any(
            (participant) =>
                participant.isActive &&
                participant.userId.toLowerCase() ==
                    widget.api.userId.toLowerCase(),
          ),
    );
    final workspace =
        _controller.resultsWorkspace ??
        _controller.ensureResultsWorkspace(capabilities);
    if (workspace == null) {
      return const Center(
        child: Text('Không thể xác minh quyền truy cập kết quả cuộc họp.'),
      );
    }
    return ResultsPanel(
      workspace: workspace,
      dependencies: widget.dependencies,
      initialSection: widget.initialResultsSection ?? ResultsSection.summary,
    );
  }
}

class _LifecycleConfirmation {
  const _LifecycleConfirmation({this.cancellationReason});

  final String? cancellationReason;
}
