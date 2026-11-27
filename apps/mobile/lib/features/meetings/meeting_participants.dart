import 'dart:async';

import 'package:flutter/material.dart';
import 'package:sme_meeting_assistant/core/app_dependencies.dart';
import 'package:sme_meeting_assistant/core/app_theme.dart';
import 'package:sme_meeting_assistant/core/api_response.dart';
import 'package:sme_meeting_assistant/core/meeting_models.dart';
import 'package:sme_meeting_assistant/core/models.dart';
import 'package:sme_meeting_assistant/core/ui_presentation.dart';
import 'package:sme_meeting_assistant/core/widgets.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_foundation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_membership.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_aggregate_coordination.dart';
import 'package:sme_meeting_assistant/features/meetings/participant_selection.dart';

class MeetingParticipants extends StatefulWidget {
  const MeetingParticipants({
    super.key,
    required this.dependencies,
    required this.snapshot,
    this.initialRecords,
    this.onRecordsChanged,
    this.onSnapshotRecordsChanged,
    this.onAccessRevoked,
    this.canStartAggregateMutation,
    this.acquireAggregateMutation,
    this.releaseAggregateMutation,
    this.ownsAggregateMutation,
    this.acceptAggregateSnapshot,
    this.acceptAggregateSnapshotAndReconcile,
    this.revalidateAggregate,
    this.refreshCanonical,
    this.addCanonicalSnapshotListener,
  });

  final AppDependencies dependencies;
  final MeetingSnapshot snapshot;
  final List<MeetingParticipant>? initialRecords;
  final MeetingMembershipRecordsCallback? onRecordsChanged;
  final MeetingMembershipSnapshotRecordsCallback? onSnapshotRecordsChanged;
  final VoidCallback? onAccessRevoked;
  final bool Function()? canStartAggregateMutation;
  final MeetingAggregateMutationToken? Function(
    MeetingSnapshot confirmedContext,
  )?
  acquireAggregateMutation;
  final void Function(MeetingAggregateMutationToken token)?
  releaseAggregateMutation;
  final bool Function(MeetingAggregateMutationToken token)?
  ownsAggregateMutation;
  final bool Function(
    MeetingAggregateMutationToken token,
    MeetingSnapshot snapshot,
  )?
  acceptAggregateSnapshot;
  final Future<bool> Function(
    MeetingAggregateMutationToken token,
    MeetingSnapshot snapshot,
  )?
  acceptAggregateSnapshotAndReconcile;
  final Future<MeetingSnapshot?> Function(MeetingAggregateMutationToken token)?
  revalidateAggregate;
  final Future<MeetingSnapshot?> Function()? refreshCanonical;
  final VoidCallback Function(void Function(MeetingSnapshot?) listener)?
  addCanonicalSnapshotListener;

  @override
  State<MeetingParticipants> createState() => _MeetingParticipantsState();
}

class _MeetingParticipantsState extends State<MeetingParticipants> {
  late final MeetingMembershipController _controller;
  VoidCallback? _removeCanonicalSnapshotListener;

  @override
  void initState() {
    super.initState();
    _controller = MeetingMembershipController(
      repository: widget.dependencies.meetingMembership,
      snapshot: widget.snapshot,
      initialRecords: widget.initialRecords,
      onRecordsChanged: widget.onRecordsChanged,
      onSnapshotRecordsChanged: widget.onSnapshotRecordsChanged,
      onAccessRevoked: widget.onAccessRevoked,
      canStartAggregateMutation: widget.canStartAggregateMutation,
      acquireAggregateMutation: widget.acquireAggregateMutation,
      releaseAggregateMutation: widget.releaseAggregateMutation,
      ownsAggregateMutation: widget.ownsAggregateMutation,
      acceptAggregateSnapshot: widget.acceptAggregateSnapshot,
      acceptAggregateSnapshotAndReconcile:
          widget.acceptAggregateSnapshotAndReconcile,
      revalidateAggregate: widget.revalidateAggregate,
      refreshCanonical: widget.refreshCanonical,
    );
    _removeCanonicalSnapshotListener = widget.addCanonicalSnapshotListener
        ?.call((snapshot) {
          if (snapshot == null) {
            _controller.clearForCanonicalAccessLoss();
          } else {
            _controller.updateCanonicalSnapshot(snapshot);
          }
        });
    unawaited(_controller.initialize());
  }

  @override
  void didUpdateWidget(covariant MeetingParticipants oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.snapshot.etag != widget.snapshot.etag) {
      _controller.updateCanonicalSnapshot(widget.snapshot);
    }
  }

  @override
  void dispose() {
    _removeCanonicalSnapshotListener?.call();
    _controller.dispose();
    super.dispose();
  }

  Future<void> _addMember() async {
    if (!_controller.canManageParticipants) return;
    final original = _controller.state.snapshot;
    if (original == null) return;
    final selected = await showParticipantPicker(
      context,
      repository: widget.dependencies.participantCandidates,
      sessionScope: original.sessionScope,
      organizerId: original.meeting.organizerId,
      activeParticipantIds: _controller.state.activeParticipants.map(
        (participant) => participant.userId,
      ),
      mode: ParticipantSelectionMode.single,
      title: 'Mời nhân viên',
    );
    if (selected == null ||
        selected.isEmpty ||
        !mounted ||
        !_controller.canManageParticipants) {
      return;
    }
    final confirmedContext = await _confirmUpdatedContext(
      original,
      'thêm người tham gia',
    );
    if (confirmedContext == null || !mounted) return;
    await _handleMutation(
      await _controller.addParticipant(
        selected.single.id,
        confirmedContext: confirmedContext,
      ),
      successMessage: 'Đã thêm người tham gia.',
    );
  }

  Future<void> _remove(MeetingParticipant participant) async {
    if (!_controller.canManageParticipants) return;
    final original = _controller.state.snapshot;
    if (original == null) return;
    final proceed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Xóa thành viên khỏi cuộc họp?'),
        content: const Text(
          'Quyền truy cập nội dung sẽ được máy chủ đánh giá lại.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Quay lại'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Xóa thành viên'),
          ),
        ],
      ),
    );
    if (proceed != true || !mounted) return;
    final confirmedContext = await _confirmUpdatedContext(
      original,
      'xóa thành viên',
      participant: participant,
    );
    if (confirmedContext == null || !mounted) return;
    await _handleMutation(
      await _controller.removeParticipant(
        participant,
        confirmedContext: confirmedContext,
      ),
      successMessage: 'Đã xóa người tham gia.',
    );
  }

  Future<MeetingSnapshot?> _confirmUpdatedContext(
    MeetingSnapshot original,
    String action, {
    MeetingParticipant? participant,
  }) async {
    var reviewed = original;
    while (mounted) {
      final latest = _controller.state.snapshot;
      if (latest == null || _controller.state.accessRevoked) return null;
      if (participant != null &&
          !_controller.state.activeParticipants.any(
            (record) =>
                record.id.toLowerCase() == participant.id.toLowerCase() &&
                record.userId.toLowerCase() == participant.userId.toLowerCase(),
          )) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'Thành viên đã thay đổi. Hãy chọn lại thành viên đang hoạt động.',
            ),
          ),
        );
        return null;
      }
      if (latest.etag == reviewed.etag &&
          latest.meeting.lifecycleStatus == reviewed.meeting.lifecycleStatus) {
        return latest;
      }
      final confirmed =
          await showDialog<bool>(
            context: context,
            builder: (dialogContext) => AlertDialog(
              title: const Text('Cuộc họp đã thay đổi'),
              content: Text(
                'Trạng thái hiện tại: ${latest.meeting.status}. Hãy xác nhận lại thao tác $action trên phiên bản mới nhất.',
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(dialogContext, false),
                  child: const Text('Quay lại'),
                ),
                FilledButton(
                  onPressed: () => Navigator.pop(dialogContext, true),
                  child: const Text('Xác nhận phiên bản mới'),
                ),
              ],
            ),
          ) ==
          true;
      if (!confirmed || !mounted) return null;
      reviewed = latest;
    }
    return null;
  }

  Future<void> _handleMutation(
    MembershipMutationResult result, {
    required String successMessage,
  }) async {
    if (!mounted) return;
    switch (result.status) {
      case MembershipOperationStatus.confirmed:
        showSuccess(
          context,
          result.requiresRevalidation
              ? '$successMessage Hãy tải lại trước khi thực hiện thay đổi khác.'
              : successMessage,
        );
      case MembershipOperationStatus.observed:
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'Trạng thái thành viên hiện tại phản ánh yêu cầu; không thể xác định thao tác nào đã tạo trạng thái này.',
            ),
          ),
        );
      case MembershipOperationStatus.unknown:
        showFailure(
          context,
          result.failure ??
              const ApiFailure(
                0,
                'MEMBERSHIP_OUTCOME_UNKNOWN',
                'Không thể xác nhận trạng thái thành viên. Hãy tải lại trước khi thử lại.',
                isTransportFailure: true,
              ),
        );
      case MembershipOperationStatus.rejected ||
          MembershipOperationStatus.notDispatched:
        showFailure(
          context,
          result.failure ??
              const ApiFailure(
                409,
                'MEMBERSHIP_NOT_CHANGED',
                'Danh sách thành viên chưa được thay đổi.',
              ),
        );
    }
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _controller,
    builder: (context, _) {
      final state = _controller.state;
      final activeSnapshot = state.snapshot ?? widget.snapshot;
      if (state.accessRevoked) {
        return const MessagePanel(
          icon: Icons.lock_outline,
          title: 'Không thể xem thành viên',
          description: 'Quyền truy cập cuộc họp đã thay đổi.',
        );
      }
      if (!state.isInitialized && state.isLoading) {
        return const Center(child: CircularProgressIndicator());
      }
      if (!state.isInitialized && state.failure != null) {
        return MessagePanel(
          icon: Icons.cloud_off_outlined,
          title: 'Không thể tải danh sách thành viên',
          description: apiFailureLabel(state.failure),
          onRetry: _controller.initialize,
        );
      }
      final active = state.activeParticipants;
      final historical = state.historicalParticipants;
      return RefreshIndicator(
        onRefresh: _controller.refresh,
        child: ListView(
          padding: const EdgeInsets.all(18),
          children: [
            SectionHeading(
              'Người tham gia',
              subtitle:
                  '${state.activeParticipantCount} đang hoạt động · lịch sử được giữ lại',
              trailing: IconButton(
                tooltip: 'Mời nhân viên',
                onPressed: _controller.canManageParticipants
                    ? _addMember
                    : null,
                icon: const Icon(Icons.person_add_alt_1_outlined),
              ),
            ),
            if (state.isMutating || state.isLoading)
              const LinearProgressIndicator(),
            if (state.needsRevalidation)
              ContentCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'Cần xác nhận lại trạng thái thành viên trước khi tiếp tục.',
                    ),
                    Align(
                      alignment: Alignment.centerRight,
                      child: TextButton.icon(
                        onPressed: state.isLoading ? null : _controller.refresh,
                        icon: const Icon(Icons.refresh),
                        label: const Text('Tải lại'),
                      ),
                    ),
                  ],
                ),
              ),
            if (state.failure != null && state.isInitialized)
              MessagePanel(
                icon: Icons.warning_amber_outlined,
                title: 'Không thể làm mới đầy đủ dữ liệu',
                description: apiFailureLabel(state.failure),
                onRetry: _controller.refresh,
              ),
            if (active.isEmpty && historical.isEmpty)
              const MessagePanel(title: 'Chưa có thành viên'),
            if (active.isNotEmpty) const SectionHeading('Đang tham gia'),
            ...active.map(
              (participant) => _participantCard(
                participant,
                active: true,
                organizerId: activeSnapshot.meeting.organizerId,
                canRemove:
                    _controller.canManageParticipants &&
                    participant.userId.toLowerCase() !=
                        activeSnapshot.meeting.organizerId.toLowerCase(),
              ),
            ),
            if (historical.isNotEmpty) ...[
              const SectionHeading('Lịch sử thành viên'),
              ...historical.map(
                (participant) => _participantCard(
                  participant,
                  active: false,
                  organizerId: activeSnapshot.meeting.organizerId,
                  canRemove: false,
                ),
              ),
            ],
          ],
        ),
      );
    },
  );

  Widget _participantCard(
    MeetingParticipant participant, {
    required bool active,
    required String organizerId,
    required bool canRemove,
  }) => ContentCard(
    child: ListTile(
      contentPadding: EdgeInsets.zero,
      leading: CircleAvatar(
        child: Icon(active ? Icons.person_outline : Icons.person_off_outlined),
      ),
      title: Text(participant.displayName ?? 'Thành viên'),
      subtitle: Text(
        participant.userId.toLowerCase() == organizerId.toLowerCase()
            ? 'Người tổ chức'
            : active
            ? 'Đang tham gia · thêm ${dateLabel(participant.addedAt)}'
            : 'Đã rời · ${dateLabel(participant.removedAt)}',
      ),
      trailing: canRemove
          ? IconButton(
              tooltip: 'Xóa thành viên',
              onPressed: _controller.state.isMutating
                  ? null
                  : () => _remove(participant),
              icon: const Icon(Icons.person_remove_outlined),
            )
          : active
          ? const Icon(Icons.check_circle_outline, color: Palette.green)
          : const Icon(Icons.history),
    ),
  );
}
