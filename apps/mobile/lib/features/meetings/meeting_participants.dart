import 'dart:async';

import 'package:flutter/material.dart';
import 'package:sme_meeting_assistant/core/app_dependencies.dart';
import 'package:sme_meeting_assistant/core/app_theme.dart';
import 'package:sme_meeting_assistant/core/api_response.dart';
import 'package:sme_meeting_assistant/core/meeting_models.dart';
import 'package:sme_meeting_assistant/core/models.dart';
import 'package:sme_meeting_assistant/core/widgets.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_foundation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_membership.dart';
import 'package:sme_meeting_assistant/features/meetings/participant_selection.dart';

class MeetingParticipants extends StatefulWidget {
  const MeetingParticipants({
    super.key,
    required this.dependencies,
    required this.snapshot,
  });

  final AppDependencies dependencies;
  final MeetingSnapshot snapshot;

  @override
  State<MeetingParticipants> createState() => _MeetingParticipantsState();
}

class _MeetingParticipantsState extends State<MeetingParticipants> {
  late final MeetingMembershipController _controller;

  @override
  void initState() {
    super.initState();
    _controller = MeetingMembershipController(
      repository: widget.dependencies.meetingMembership,
      snapshot: widget.snapshot,
    );
    unawaited(_controller.initialize());
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _addMember() async {
    if (!_controller.canManageParticipants) return;
    final selected = await showParticipantPicker(
      context,
      repository: widget.dependencies.participantCandidates,
      sessionScope: widget.snapshot.sessionScope,
      organizerId: widget.snapshot.meeting.organizerId,
      activeParticipantIds: _controller.state.activeParticipants.map(
        (participant) => participant.userId,
      ),
      mode: ParticipantSelectionMode.single,
      title: 'Mời nhân viên',
    );
    if (selected == null || selected.isEmpty || !mounted) return;
    await _handleMutation(
      await _controller.addParticipant(selected.single.id),
      successMessage: 'Đã thêm người tham gia.',
    );
  }

  Future<void> _remove(MeetingParticipant participant) async {
    if (!_controller.canManageParticipants) return;
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
    await _handleMutation(
      await _controller.removeParticipant(participant.userId),
      successMessage: 'Đã xóa người tham gia.',
    );
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
          description: state.failure is ApiFailure
              ? (state.failure! as ApiFailure).message
              : 'Đã xảy ra lỗi khi tải thành viên.',
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
                description: state.failure is ApiFailure
                    ? (state.failure! as ApiFailure).message
                    : 'Hãy thử tải lại.',
                onRetry: _controller.refresh,
              ),
            if (active.isEmpty && historical.isEmpty)
              const MessagePanel(title: 'Chưa có thành viên'),
            if (active.isNotEmpty) const SectionHeading('Đang tham gia'),
            ...active.map(
              (participant) => _participantCard(
                participant,
                active: true,
                canRemove:
                    _controller.canManageParticipants &&
                    participant.userId.toLowerCase() !=
                        widget.snapshot.meeting.organizerId.toLowerCase(),
              ),
            ),
            if (historical.isNotEmpty) ...[
              const SectionHeading('Lịch sử thành viên'),
              ...historical.map(
                (participant) => _participantCard(
                  participant,
                  active: false,
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
    required bool canRemove,
  }) => ContentCard(
    child: ListTile(
      contentPadding: EdgeInsets.zero,
      leading: CircleAvatar(
        child: Icon(active ? Icons.person_outline : Icons.person_off_outlined),
      ),
      title: Text(participant.displayName ?? 'Thành viên'),
      subtitle: Text(
        participant.userId.toLowerCase() ==
                widget.snapshot.meeting.organizerId.toLowerCase()
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
