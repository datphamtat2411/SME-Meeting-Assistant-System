import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/meeting_models.dart';
import 'package:sme_meeting_assistant/core/models.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_foundation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_invalidation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_membership.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_repository.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_scheduling.dart';

enum MeetingDetailPhase {
  loading,
  ready,
  refreshing,
  recoveryRequired,
  accessRevoked,
}

enum MeetingDetailMutation {
  editing,
  membership,
  scheduling,
  starting,
  ending,
  cancelling,
}

enum MeetingLifecycleCommand { schedule, start, end, cancel }

enum MeetingLifecycleResultStatus {
  confirmed,
  observed,
  rejected,
  unknown,
  blocked,
}

class MeetingLifecycleResult {
  const MeetingLifecycleResult({
    required this.status,
    required this.message,
    this.snapshot,
    this.failure,
  });

  final MeetingLifecycleResultStatus status;
  final String message;
  final MeetingSnapshot? snapshot;
  final Object? failure;
}

class MeetingDetailState {
  const MeetingDetailState({
    required this.phase,
    required this.snapshot,
    required this.room,
    required this.roomUnavailable,
    required this.participants,
    required this.participantsLoaded,
    required this.metadataFailure,
    required this.failure,
    required this.activeMutation,
    required this.needsRevalidation,
    required this.message,
  });

  final MeetingDetailPhase phase;
  final MeetingSnapshot? snapshot;
  final MeetingRoom? room;
  final bool roomUnavailable;
  final List<MeetingParticipant> participants;
  final bool participantsLoaded;
  final Object? metadataFailure;
  final Object? failure;
  final MeetingDetailMutation? activeMutation;
  final bool needsRevalidation;
  final String? message;

  bool get isLoading =>
      phase == MeetingDetailPhase.loading ||
      phase == MeetingDetailPhase.refreshing;
  bool get accessRevoked => phase == MeetingDetailPhase.accessRevoked;

  String get organizerDisplayName {
    final meeting = snapshot?.meeting;
    if (meeting == null) return 'Người tổ chức';
    for (final participant in participants) {
      if (participant.userId.toLowerCase() ==
              meeting.organizerId.toLowerCase() &&
          participant.displayName != null &&
          participant.displayName!.trim().isNotEmpty) {
        return participant.displayName!.trim();
      }
    }
    return 'Người tổ chức';
  }

  String get roomDisplayName {
    final meeting = snapshot?.meeting;
    if (meeting == null || meeting.roomId == null) return 'Chưa chọn phòng';
    final resolved = room;
    if (resolved != null) {
      final location = resolved.location?.trim();
      return '${resolved.name} (${resolved.code})${location == null || location.isEmpty ? '' : ' · $location'}';
    }
    return roomUnavailable
        ? 'Phòng đã chọn · thông tin hiện không khả dụng'
        : 'Đang tải thông tin phòng';
  }

  int get activeParticipantCount =>
      participants.where((participant) => participant.isActive).length;

  bool get canStartAggregateMutation =>
      phase == MeetingDetailPhase.ready &&
      snapshot != null &&
      activeMutation == null &&
      !needsRevalidation &&
      !accessRevoked;
}

class MeetingDetailController extends ChangeNotifier {
  MeetingDetailController({
    required this.meetings,
    required this.membership,
    required this.rooms,
    required this.invalidation,
    required this.meetingId,
  }) : sessionScope = meetings.api.requireAuthenticatedSessionScope(),
       _state = const MeetingDetailState(
         phase: MeetingDetailPhase.loading,
         snapshot: null,
         room: null,
         roomUnavailable: false,
         participants: <MeetingParticipant>[],
         participantsLoaded: false,
         metadataFailure: null,
         failure: null,
         activeMutation: null,
         needsRevalidation: false,
         message: null,
       ) {
    _seenInvalidationRevision = invalidation.revision;
    invalidation.addListener(_onInvalidation);
    meetings.api.sessionCoordinator.addListener(_onSessionChanged);
  }

  final MeetingRepository meetings;
  final MeetingMembershipRepository membership;
  final RoomSchedulingRepository rooms;
  final MeetingInvalidationSignal invalidation;
  final String meetingId;
  final AuthenticatedSessionScope sessionScope;

  MeetingDetailState _state;
  int _generation = 0;
  int _seenInvalidationRevision = 0;
  Future<void>? _refreshOperation;
  bool _pendingInvalidation = false;
  bool _disposed = false;

  MeetingDetailState get state => _state;
  MeetingSnapshot? get snapshot => _state.snapshot;
  bool get ownsSession =>
      !_disposed && meetings.api.isCurrentAuthenticatedSession(sessionScope);

  Future<void> initialize() => _load(initial: true);

  Future<void> refresh() {
    if (_disposed || !ownsSession) return Future<void>.value();
    if (_state.activeMutation != null) {
      _pendingInvalidation = true;
      _state = _copy(needsRevalidation: true);
      notifyListeners();
      return Future<void>.value();
    }
    final current = _refreshOperation;
    if (current != null) {
      _pendingInvalidation = true;
      return current;
    }
    final operation = _load(initial: false);
    _refreshOperation = operation;
    unawaited(
      operation.whenComplete(() {
        if (identical(_refreshOperation, operation)) {
          _refreshOperation = null;
        }
        if (_pendingInvalidation && ownsSession && !_disposed) {
          _pendingInvalidation = false;
          unawaited(refresh());
        }
      }),
    );
    return operation;
  }

  Future<void> _load({required bool initial}) async {
    if (!ownsSession) return;
    final generation = ++_generation;
    _state = _copy(
      phase: initial || _state.snapshot == null
          ? MeetingDetailPhase.loading
          : MeetingDetailPhase.refreshing,
      failure: null,
      clearFailure: true,
      needsRevalidation: false,
      clearMessage: true,
    );
    notifyListeners();
    try {
      final latest = await meetings.detail(meetingId);
      if (!_owns(generation)) return;
      _acceptCanonical(latest, generation: generation, refreshMetadata: true);
    } catch (error) {
      if (!_owns(generation)) return;
      final denied =
          error is ApiFailure && (error.status == 403 || error.status == 404);
      if (denied) {
        _clearProtectedState();
        return;
      }
      _state = _copy(
        phase: _state.snapshot == null
            ? MeetingDetailPhase.recoveryRequired
            : MeetingDetailPhase.ready,
        failure: error,
        needsRevalidation: _state.snapshot != null,
      );
      notifyListeners();
    }
  }

  void _acceptCanonical(
    MeetingSnapshot snapshot, {
    required int generation,
    bool refreshMetadata = false,
  }) {
    if (!_owns(generation) ||
        snapshot.meeting.id.toLowerCase() != meetingId.toLowerCase()) {
      return;
    }
    final old = _state.snapshot;
    final roomChanged = old?.meeting.roomId != snapshot.meeting.roomId;
    final shouldLoadRoom =
        snapshot.meeting.roomId != null && (roomChanged || refreshMetadata);
    final shouldLoadParticipants =
        !_state.participantsLoaded || refreshMetadata;
    _state = MeetingDetailState(
      phase: MeetingDetailPhase.ready,
      snapshot: snapshot,
      room: roomChanged ? null : _state.room,
      roomUnavailable: roomChanged ? false : _state.roomUnavailable,
      participants: _state.participants,
      participantsLoaded: _state.participantsLoaded,
      metadataFailure: null,
      failure: null,
      activeMutation: _state.activeMutation,
      needsRevalidation: false,
      message: _state.message,
    );
    notifyListeners();
    if (shouldLoadRoom || shouldLoadParticipants) {
      unawaited(
        _loadSecondary(
          snapshot,
          generation,
          loadRoom: shouldLoadRoom,
          loadParticipants: shouldLoadParticipants,
        ),
      );
    }
  }

  Future<void> _loadSecondary(
    MeetingSnapshot snapshot,
    int generation, {
    required bool loadRoom,
    required bool loadParticipants,
  }) async {
    final roomId = snapshot.meeting.roomId;
    if (!loadRoom) {
      // Retain the already-resolved room projection.
    } else if (roomId == null) {
      if (_owns(generation)) {
        _state = _copy(room: null, roomUnavailable: false);
        notifyListeners();
      }
    } else {
      try {
        final room = await rooms.roomById(roomId, sessionScope: sessionScope);
        if (_owns(generation) &&
            _state.snapshot?.meeting.roomId?.toLowerCase() ==
                roomId.toLowerCase()) {
          _state = _copy(
            room: room,
            roomUnavailable: false,
            clearMetadataFailure: true,
          );
          notifyListeners();
        }
      } catch (error) {
        if (!_owns(generation)) return;
        if (_state.snapshot?.meeting.roomId?.toLowerCase() ==
            roomId.toLowerCase()) {
          _state = _copy(
            room: null,
            roomUnavailable: true,
            metadataFailure: error,
          );
          notifyListeners();
        }
      }
    }

    if (!loadParticipants) return;
    try {
      final records = await membership.listParticipants(
        snapshot.meeting.id,
        sessionScope: sessionScope,
      );
      if (!_owns(generation) ||
          _state.snapshot?.meeting.id.toLowerCase() !=
              snapshot.meeting.id.toLowerCase()) {
        return;
      }
      _state = _copy(
        participants: records,
        participantsLoaded: true,
        clearMetadataFailure: true,
      );
      notifyListeners();
    } catch (error) {
      if (!_owns(generation)) return;
      if (error is ApiFailure && (error.status == 403 || error.status == 404)) {
        _clearProtectedState();
        return;
      }
      _state = _copy(participantsLoaded: false, metadataFailure: error);
      notifyListeners();
    }
  }

  bool beginMutation(MeetingDetailMutation mutation) {
    if (!state.canStartAggregateMutation || !ownsSession) return false;
    _state = _copy(activeMutation: mutation, clearMessage: true);
    notifyListeners();
    return true;
  }

  void endMutation() {
    if (_disposed || _state.activeMutation == null) return;
    _state = _copy(clearActiveMutation: true);
    notifyListeners();
    if (_pendingInvalidation && ownsSession) {
      _pendingInvalidation = false;
      unawaited(refresh());
    }
  }

  void acceptMembershipSnapshot(MeetingSnapshot snapshot) {
    if (!ownsSession ||
        snapshot.meeting.id.toLowerCase() != meetingId.toLowerCase()) {
      return;
    }
    final generation = ++_generation;
    _acceptCanonical(snapshot, generation: generation);
  }

  void acceptMembershipRecords(List<MeetingParticipant> records) {
    if (!ownsSession || _state.snapshot == null) return;
    _state = _copy(
      participants: List<MeetingParticipant>.unmodifiable(records),
      participantsLoaded: true,
    );
    notifyListeners();
  }

  void membershipAccessRevoked() => _clearProtectedState();

  Future<MeetingLifecycleResult> runLifecycle({
    required MeetingLifecycleCommand command,
    required MeetingSnapshot confirmedContext,
    String? cancellationReason,
  }) async {
    if (!ownsSession || !state.canStartAggregateMutation) {
      return _blocked('Cuộc họp đang được cập nhật hoặc cần tải lại.');
    }
    final current = _state.snapshot;
    if (current == null ||
        current.etag != confirmedContext.etag ||
        current.meeting.lifecycleStatus !=
            confirmedContext.meeting.lifecycleStatus) {
      return _blocked(
        'Trạng thái cuộc họp đã thay đổi trong khi hộp xác nhận đang mở. Hãy xem lại trước khi tiếp tục.',
      );
    }
    final capability = MeetingCapabilityPolicy.evaluate(
      callerId: meetings.api.userId,
      meeting: confirmedContext.meeting,
    );
    final operation = switch (command) {
      MeetingLifecycleCommand.schedule => MeetingOperation.schedule,
      MeetingLifecycleCommand.start => MeetingOperation.start,
      MeetingLifecycleCommand.end => MeetingOperation.end,
      MeetingLifecycleCommand.cancel => MeetingOperation.cancel,
    };
    if (!capability.allows(operation)) {
      return _blocked(
        'Thao tác này không còn khả dụng với trạng thái hiện tại.',
      );
    }
    if (command == MeetingLifecycleCommand.schedule &&
        MeetingInterval.fromNullableEndpoints(
              confirmedContext.meeting.scheduledStartAt,
              confirmedContext.meeting.scheduledEndAt,
            ) ==
            null) {
      return _blocked('Hãy đặt thời gian hợp lệ trước khi lên lịch.');
    }

    final mutation = switch (command) {
      MeetingLifecycleCommand.schedule => MeetingDetailMutation.scheduling,
      MeetingLifecycleCommand.start => MeetingDetailMutation.starting,
      MeetingLifecycleCommand.end => MeetingDetailMutation.ending,
      MeetingLifecycleCommand.cancel => MeetingDetailMutation.cancelling,
    };
    if (!beginMutation(mutation)) {
      return _blocked('Một thay đổi khác đang được thực hiện.');
    }
    final generation = ++_generation;
    try {
      final changed = switch (command) {
        MeetingLifecycleCommand.schedule => await meetings.schedule(
          confirmedContext,
          const MeetingScheduleInput(),
        ),
        MeetingLifecycleCommand.start => await meetings.start(confirmedContext),
        MeetingLifecycleCommand.end => await meetings.end(confirmedContext),
        MeetingLifecycleCommand.cancel => await meetings.cancel(
          confirmedContext,
          MeetingCancelInput(reason: _normalizeReason(cancellationReason)),
        ),
      };
      if (!_owns(generation)) {
        return const MeetingLifecycleResult(
          status: MeetingLifecycleResultStatus.unknown,
          message: 'Phiên đăng nhập đã thay đổi; kết quả chưa thể hiển thị.',
        );
      }
      _acceptCanonical(changed, generation: generation);
      return MeetingLifecycleResult(
        status: MeetingLifecycleResultStatus.confirmed,
        message: 'Đã cập nhật cuộc họp theo xác nhận của máy chủ.',
        snapshot: changed,
      );
    } on MeetingFailure catch (failure) {
      if (!_owns(generation)) {
        return MeetingLifecycleResult(
          status: MeetingLifecycleResultStatus.unknown,
          message: 'Phiên đăng nhập đã thay đổi; chưa thể xác nhận kết quả.',
          failure: failure,
        );
      }
      if (failure.mutationOutcome == MeetingMutationOutcome.unknown) {
        return await _reconcileLifecycleOutcome(
          generation: generation,
          command: command,
          context: confirmedContext,
          failure: failure,
        );
      }
      if (failure.category == MeetingFailureCategory.versionConflict ||
          failure.category == MeetingFailureCategory.businessConflict ||
          failure.category == MeetingFailureCategory.authorization ||
          failure.category == MeetingFailureCategory.resourceUnavailable) {
        await _revalidateAfterRejectedLifecycle(
          generation: generation,
          failure: failure,
        );
      } else {
        _state = _copy(message: 'Máy chủ chưa xác nhận thay đổi.');
        notifyListeners();
      }
      return MeetingLifecycleResult(
        status: MeetingLifecycleResultStatus.rejected,
        message: failure.category == MeetingFailureCategory.versionConflict
            ? 'Phiên bản đã cũ. Hãy xem trạng thái mới trước khi xác nhận thao tác khác.'
            : 'Máy chủ chưa xác nhận thay đổi. Hãy xem điều kiện hiện tại.',
        snapshot: _state.snapshot,
        failure: failure,
      );
    } catch (error) {
      if (!_owns(generation)) {
        return const MeetingLifecycleResult(
          status: MeetingLifecycleResultStatus.unknown,
          message: 'Phiên đăng nhập đã thay đổi; chưa thể xác nhận kết quả.',
        );
      }
      return await _reconcileLifecycleOutcome(
        generation: generation,
        command: command,
        context: confirmedContext,
        failure: error,
      );
    } finally {
      if (_owns(generation)) endMutation();
    }
  }

  Future<MeetingLifecycleResult> _reconcileLifecycleOutcome({
    required int generation,
    required MeetingLifecycleCommand command,
    required MeetingSnapshot context,
    required Object failure,
  }) async {
    final revisionAtRead = invalidation.revision;
    try {
      final latest = await meetings.detail(meetingId);
      if (!_owns(generation)) {
        return const MeetingLifecycleResult(
          status: MeetingLifecycleResultStatus.unknown,
          message: 'Phiên đăng nhập đã thay đổi; chưa thể xác nhận kết quả.',
        );
      }
      if (revisionAtRead == invalidation.revision) {
        _pendingInvalidation = false;
        _seenInvalidationRevision = revisionAtRead;
      }
      _acceptCanonical(latest, generation: generation);
      final target = _targetStatus(command);
      final observed =
          latest.meeting.lifecycleStatus == target &&
          (command != MeetingLifecycleCommand.schedule ||
              _sameInterval(context.meeting, latest.meeting));
      final message = observed
          ? 'Trạng thái hiện tại phù hợp với yêu cầu; không thể xác định thao tác nào đã tạo trạng thái này.'
          : 'Chưa xác nhận được kết quả thao tác. Trạng thái hiện tại đã được tải; không tự động gửi lại.';
      _state = _copy(
        phase: observed
            ? MeetingDetailPhase.ready
            : MeetingDetailPhase.recoveryRequired,
        message: message,
        needsRevalidation: !observed,
      );
      notifyListeners();
      return MeetingLifecycleResult(
        status: observed
            ? MeetingLifecycleResultStatus.observed
            : MeetingLifecycleResultStatus.unknown,
        message: message,
        snapshot: latest,
        failure: observed ? null : failure,
      );
    } catch (error) {
      if (!_owns(generation)) {
        return const MeetingLifecycleResult(
          status: MeetingLifecycleResultStatus.unknown,
          message: 'Phiên đăng nhập đã thay đổi; chưa thể xác nhận kết quả.',
        );
      }
      final denied =
          error is ApiFailure && (error.status == 403 || error.status == 404);
      if (denied) {
        _clearProtectedState();
      } else {
        _state = _copy(
          phase: MeetingDetailPhase.recoveryRequired,
          failure: error,
          needsRevalidation: true,
          message: 'Kết quả thao tác chưa rõ và không thể tải trạng thái hiện tại. Không thử lại tự động.',
        );
        notifyListeners();
      }
      return MeetingLifecycleResult(
        status: MeetingLifecycleResultStatus.unknown,
        message: 'Chưa thể xác nhận kết quả thao tác.',
        failure: error,
      );
    }
  }

  Future<void> _revalidateAfterRejectedLifecycle({
    required int generation,
    required Object failure,
  }) async {
    final revisionAtRead = invalidation.revision;
    try {
      final latest = await meetings.detail(meetingId);
      if (!_owns(generation)) return;
      if (revisionAtRead == invalidation.revision) {
        _pendingInvalidation = false;
        _seenInvalidationRevision = revisionAtRead;
      }
      _acceptCanonical(latest, generation: generation);
      _state = _copy(
        message:
            'Thao tác bị từ chối. Đã tải trạng thái hiện tại để bạn xem lại.',
      );
      notifyListeners();
    } catch (error) {
      if (!_owns(generation)) return;
      final denied =
          error is ApiFailure && (error.status == 403 || error.status == 404);
      if (denied) {
        _clearProtectedState();
      } else {
        _state = _copy(
          phase: MeetingDetailPhase.recoveryRequired,
          failure: error,
          needsRevalidation: true,
          message: 'Không thể xác nhận trạng thái hiện tại.',
        );
        notifyListeners();
      }
    }
  }

  MeetingLifecycleResult _blocked(String message) => MeetingLifecycleResult(
    status: MeetingLifecycleResultStatus.blocked,
    message: message,
    snapshot: _state.snapshot,
  );

  bool _owns(int generation) =>
      !_disposed &&
      generation == _generation &&
      meetings.api.isCurrentAuthenticatedSession(sessionScope);

  MeetingDetailState _copy({
    MeetingDetailPhase? phase,
    MeetingSnapshot? snapshot,
    MeetingRoom? room,
    bool clearRoom = false,
    bool? roomUnavailable,
    List<MeetingParticipant>? participants,
    bool? participantsLoaded,
    Object? metadataFailure,
    bool clearMetadataFailure = false,
    Object? failure,
    bool clearFailure = false,
    MeetingDetailMutation? activeMutation,
    bool clearActiveMutation = false,
    bool? needsRevalidation,
    String? message,
    bool clearMessage = false,
  }) => MeetingDetailState(
    phase: phase ?? _state.phase,
    snapshot: snapshot ?? _state.snapshot,
    room: clearRoom ? null : room ?? _state.room,
    roomUnavailable: roomUnavailable ?? _state.roomUnavailable,
    participants: participants ?? _state.participants,
    participantsLoaded: participantsLoaded ?? _state.participantsLoaded,
    metadataFailure: clearMetadataFailure
        ? null
        : metadataFailure ?? _state.metadataFailure,
    failure: clearFailure ? null : failure ?? _state.failure,
    activeMutation: clearActiveMutation
        ? null
        : activeMutation ?? _state.activeMutation,
    needsRevalidation: needsRevalidation ?? _state.needsRevalidation,
    message: clearMessage ? null : message ?? _state.message,
  );

  void _onInvalidation() {
    if (_disposed) return;
    if (!ownsSession) {
      _clearProtectedState();
      return;
    }
    if (_seenInvalidationRevision == invalidation.revision) return;
    _seenInvalidationRevision = invalidation.revision;
    final affectedId = invalidation.lastMeetingId;
    if (affectedId != null &&
        affectedId.toLowerCase() != meetingId.toLowerCase()) {
      return;
    }
    if (_state.activeMutation != null || _refreshOperation != null) {
      _pendingInvalidation = true;
      _state = _copy(needsRevalidation: true);
      notifyListeners();
      return;
    }
    unawaited(refresh());
  }

  void _onSessionChanged() {
    if (_disposed || ownsSession) return;
    _clearProtectedState();
  }

  void _clearProtectedState() {
    _generation++;
    _pendingInvalidation = false;
    _state = const MeetingDetailState(
      phase: MeetingDetailPhase.accessRevoked,
      snapshot: null,
      room: null,
      roomUnavailable: false,
      participants: <MeetingParticipant>[],
      participantsLoaded: false,
      metadataFailure: null,
      failure: null,
      activeMutation: null,
      needsRevalidation: false,
      message: 'Quyền truy cập cuộc họp đã thay đổi.',
    );
    notifyListeners();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _generation++;
    invalidation.removeListener(_onInvalidation);
    meetings.api.sessionCoordinator.removeListener(_onSessionChanged);
    super.dispose();
  }
}

MeetingStatus? _targetStatus(MeetingLifecycleCommand command) =>
    switch (command) {
      MeetingLifecycleCommand.schedule => MeetingStatus.scheduled,
      MeetingLifecycleCommand.start => MeetingStatus.inProgress,
      MeetingLifecycleCommand.end => MeetingStatus.ended,
      MeetingLifecycleCommand.cancel => MeetingStatus.cancelled,
    };

bool _sameInterval(Meeting first, Meeting second) =>
    first.scheduledStartAt?.toUtc() == second.scheduledStartAt?.toUtc() &&
    first.scheduledEndAt?.toUtc() == second.scheduledEndAt?.toUtc();

String? _normalizeReason(String? reason) {
  final value = reason?.trim();
  return value == null || value.isEmpty ? null : value;
}
