import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/meeting_models.dart';
import 'package:sme_meeting_assistant/core/models.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_foundation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_invalidation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_aggregate_coordination.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_membership.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_repository.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_scheduling.dart';
import 'package:sme_meeting_assistant/features/recording/processing_manager.dart';
import 'package:sme_meeting_assistant/features/results/results_invalidation.dart';
import 'package:sme_meeting_assistant/features/results/results_repository.dart';
import 'package:sme_meeting_assistant/features/results/results_workspace_controller.dart';

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

typedef MeetingCanonicalSnapshotListener = void Function(
  MeetingSnapshot? snapshot,
);

enum MeetingLifecycleResultStatus {
  confirmed,
  observed,
  rejected,
  unknown,
  blocked,
}

enum MeetingOrganizerMetadataStatus { loading, resolved, unavailable }

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
    this.organizerName,
    this.organizerMetadataStatus = MeetingOrganizerMetadataStatus.unavailable,
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
  final String? organizerName;
  final MeetingOrganizerMetadataStatus organizerMetadataStatus;
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
    final resolved = organizerName?.trim();
    if (resolved != null && resolved.isNotEmpty) return resolved;
    return switch (organizerMetadataStatus) {
      MeetingOrganizerMetadataStatus.loading =>
        'Đang tải thông tin người tổ chức',
      MeetingOrganizerMetadataStatus.resolved => 'Người tổ chức',
      MeetingOrganizerMetadataStatus.unavailable =>
        'Người tổ chức · thông tin chưa khả dụng',
    };
  }

  MeetingOrganizerMetadataStatus get organizerMetadataState {
    final meeting = snapshot?.meeting;
    if (meeting != null &&
        participants.any(
          (participant) =>
              participant.userId.toLowerCase() ==
                  meeting.organizerId.toLowerCase() &&
              participant.displayName != null &&
              participant.displayName!.trim().isNotEmpty,
        )) {
      return MeetingOrganizerMetadataStatus.resolved;
    }
    return organizerMetadataStatus;
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
    this.results,
    this.resultsInvalidation,
    this.processingManager,
  }) : sessionScope = meetings.api.requireAuthenticatedSessionScope(),
       _state = const MeetingDetailState(
         phase: MeetingDetailPhase.loading,
         snapshot: null,
         room: null,
         roomUnavailable: false,
         participants: <MeetingParticipant>[],
         participantsLoaded: false,
         organizerName: null,
         organizerMetadataStatus: MeetingOrganizerMetadataStatus.unavailable,
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
  final ResultsRepository? results;
  final ResultsInvalidationSignal? resultsInvalidation;
  final ProcessingManager? processingManager;
  final AuthenticatedSessionScope sessionScope;
  final Set<MeetingCanonicalSnapshotListener> _canonicalListeners =
      <MeetingCanonicalSnapshotListener>{};

  MeetingDetailState _state;
  ResultsWorkspaceController? _resultsWorkspace;
  int _generation = 0;
  int _seenInvalidationRevision = 0;
  int _mutationSequence = 0;
  MeetingAggregateMutationToken? _activeMutationToken;
  Future<void>? _refreshOperation;
  bool _pendingInvalidation = false;
  bool _disposed = false;

  MeetingDetailState get state => _state;
  MeetingSnapshot? get snapshot => _state.snapshot;
  ResultsWorkspaceController? get resultsWorkspace => _resultsWorkspace;
  bool get ownsSession =>
      !_disposed && meetings.api.isCurrentAuthenticatedSession(sessionScope);

  ResultsWorkspaceController? ensureResultsWorkspace(
    MeetingCapabilities meetingCapabilities,
  ) {
    final snapshot = _state.snapshot;
    final repository = results;
    final signal = resultsInvalidation;
    if (!ownsSession ||
        snapshot == null ||
        repository == null ||
        signal == null) {
      return null;
    }
    final current = _resultsWorkspace;
    if (current != null && current.ownsSession) {
      return current;
    }
    current?.dispose();
    final workspace = ResultsWorkspaceController(
      api: meetings.api,
      repository: repository,
      meetingId: meetingId,
      meeting: snapshot.meeting,
      capabilities: ResultsCapabilityPolicy.evaluate(
        scope: sessionScope,
        meeting: snapshot.meeting,
        meetingCapabilities: meetingCapabilities,
      ),
      invalidation: signal,
      processingManager: processingManager,
    );
    _resultsWorkspace = workspace;
    _updateResultsIdentityLabels(workspace);
    return workspace;
  }

  void _syncResultsWorkspaceCapabilities() {
    final workspace = _resultsWorkspace;
    final snapshot = _state.snapshot;
    if (workspace == null) return;
    if (!ownsSession || snapshot == null || _state.accessRevoked) {
      _disposeResultsWorkspace();
      return;
    }
    final participant =
        _state.participantsLoaded &&
        _state.participants.any(
          (item) =>
              item.isActive &&
              item.userId.toLowerCase() == meetings.api.userId.toLowerCase(),
        );
    workspace.updateCapabilities(
      ResultsCapabilityPolicy.evaluate(
        scope: sessionScope,
        meeting: snapshot.meeting,
        meetingCapabilities: MeetingCapabilityPolicy.evaluate(
          callerId: meetings.api.userId,
          meeting: snapshot.meeting,
          callerIsActiveParticipant: participant,
        ),
      ),
    );
    _updateResultsIdentityLabels(workspace);
  }

  void _updateResultsIdentityLabels(ResultsWorkspaceController workspace) {
    final meeting = _state.snapshot?.meeting;
    if (meeting == null || !workspace.capabilities.canRead) return;
    final organizerName = _state.organizerName ?? meeting.organizerName;
    workspace.updateMeetingIdentityLabels({
      for (final participant in _state.participants)
        if (participant.displayName?.trim().isNotEmpty == true)
          participant.userId.toLowerCase(): participant.displayName!.trim(),
      if (organizerName?.trim().isNotEmpty == true)
        meeting.organizerId.toLowerCase(): organizerName!.trim(),
    });
  }

  void _disposeResultsWorkspace() {
    _resultsWorkspace?.dispose();
    _resultsWorkspace = null;
  }

  VoidCallback addCanonicalSnapshotListener(
    MeetingCanonicalSnapshotListener listener,
  ) {
    if (_disposed) return () {};
    _canonicalListeners.add(listener);
    listener(_state.snapshot);
    return () => _canonicalListeners.remove(listener);
  }

  Future<void> initialize() => _load(initial: true);

  /// Revalidates protected detail data when the app returns to the foreground.
  ///
  /// An active aggregate operation owns the reviewed version. Resuming during
  /// that operation fences later mutations without replacing its context.
  Future<void> revalidateOnResume() async {
    if (_disposed || !ownsSession) return;
    final resultsVerification = _resultsWorkspace?.revalidateOnResume();
    if (_state.activeMutation != null) {
      _pendingInvalidation = true;
      if (!_state.needsRevalidation) {
        _state = _copy(needsRevalidation: true);
        notifyListeners();
      }
      if (resultsVerification != null) await resultsVerification;
      return;
    }
    await Future.wait([
      refresh(),
      if (resultsVerification != null) resultsVerification,
    ]);
  }

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

  Future<MeetingSnapshot?> refreshCanonicalForChild() async {
    if (!ownsSession) return null;
    await refresh();
    if (!ownsSession || _state.needsRevalidation) return null;
    return _state.snapshot;
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
      _acceptCanonical(latest, generation: generation);
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
    bool loadSecondary = true,
  }) {
    if (!_owns(generation) ||
        snapshot.meeting.id.toLowerCase() != meetingId.toLowerCase()) {
      return;
    }
    final old = _state.snapshot;
    final roomChanged = old?.meeting.roomId != snapshot.meeting.roomId;
    final organizerChanged =
        old?.meeting.organizerId.toLowerCase() !=
        snapshot.meeting.organizerId.toLowerCase();
    final participantOrganizerName = _participantDisplayName(
      _state.participants,
      snapshot.meeting.organizerId,
    );
    final canonicalOrganizerName = snapshot.meeting.organizerName?.trim();
    final signedInOrganizerName =
        snapshot.meeting.organizerId.toLowerCase() ==
                (meetings.api.userId).toLowerCase() &&
            meetings.api.displayName.trim().isNotEmpty
        ? meetings.api.displayName.trim()
        : null;
    final resolvedOrganizerName =
        participantOrganizerName ??
        (canonicalOrganizerName == null || canonicalOrganizerName.isEmpty
            ? null
            : canonicalOrganizerName) ??
        signedInOrganizerName;
    final nextOrganizerName =
        resolvedOrganizerName ??
        (organizerChanged ? null : _state.organizerName);
    final hasOrganizerLabel =
        resolvedOrganizerName != null ||
        (nextOrganizerName?.trim().isNotEmpty ?? false);
    final shouldLoadRoom =
        snapshot.meeting.roomId != null && (roomChanged || refreshMetadata);
    final shouldLoadParticipants =
        !_state.participantsLoaded || refreshMetadata;
    final shouldLoadOrganizer =
        loadSecondary &&
        !hasOrganizerLabel &&
        _state.organizerMetadataStatus !=
            MeetingOrganizerMetadataStatus.loading;
    _state = MeetingDetailState(
      phase: MeetingDetailPhase.ready,
      snapshot: snapshot,
      room: roomChanged ? null : _state.room,
      roomUnavailable: roomChanged ? false : _state.roomUnavailable,
      participants: _state.participants,
      participantsLoaded: _state.participantsLoaded,
      organizerName: nextOrganizerName,
      organizerMetadataStatus: hasOrganizerLabel
          ? MeetingOrganizerMetadataStatus.resolved
          : shouldLoadOrganizer
          ? MeetingOrganizerMetadataStatus.loading
          : organizerChanged
          ? MeetingOrganizerMetadataStatus.unavailable
          : _state.organizerMetadataStatus,
      metadataFailure: null,
      failure: null,
      activeMutation: _state.activeMutation,
      needsRevalidation: false,
      message: _state.message,
    );
    _syncResultsWorkspaceCapabilities();
    for (final listener in List<MeetingCanonicalSnapshotListener>.of(
      _canonicalListeners,
    )) {
      listener(snapshot);
    }
    notifyListeners();
    if (shouldLoadRoom || shouldLoadParticipants || shouldLoadOrganizer) {
      unawaited(
        _loadSecondary(
          snapshot,
          generation,
          loadRoom: shouldLoadRoom,
          loadParticipants: shouldLoadParticipants,
          loadOrganizer: shouldLoadOrganizer,
        ),
      );
    }
  }

  Future<void> _loadSecondary(
    MeetingSnapshot snapshot,
    int generation, {
    required bool loadRoom,
    required bool loadParticipants,
    required bool loadOrganizer,
    MeetingAggregateMutationToken? aggregateToken,
  }) async {
    bool ownsSecondary() =>
        _owns(generation) &&
        (aggregateToken == null || ownsAggregateMutation(aggregateToken)) &&
        _state.snapshot?.meeting.id.toLowerCase() ==
            snapshot.meeting.id.toLowerCase();

    if (loadOrganizer &&
        (_participantDisplayName(
                  _state.participants,
                  snapshot.meeting.organizerId,
                ) !=
                null ||
            (_state.organizerName?.trim().isNotEmpty ?? false))) {
      loadOrganizer = false;
    }

    final roomId = snapshot.meeting.roomId;
    if (!loadRoom) {
      // Retain the already-resolved room projection.
    } else if (roomId == null) {
      if (ownsSecondary()) {
        _state = _copy(room: null, roomUnavailable: false);
        notifyListeners();
      }
    } else {
      try {
        final room = await rooms.roomById(roomId, sessionScope: sessionScope);
        if (ownsSecondary() &&
            _state.snapshot?.meeting.roomId?.toLowerCase() ==
                roomId.toLowerCase()) {
          _state = _copy(
            room: room,
            roomUnavailable: false,
            clearMetadataFailure:
                _state.organizerMetadataStatus !=
                MeetingOrganizerMetadataStatus.unavailable,
          );
          _syncResultsWorkspaceCapabilities();
          notifyListeners();
        }
      } catch (error) {
        if (!ownsSecondary()) return;
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

    if (loadParticipants) {
      if (!ownsSecondary()) return;
      try {
        final records = await membership.listParticipants(
          snapshot.meeting.id,
          sessionScope: sessionScope,
        );
        if (!ownsSecondary()) return;
        final organizerLabel = _participantDisplayName(
          records,
          snapshot.meeting.organizerId,
        );
        _state = _copy(
          participants: records,
          participantsLoaded: true,
          organizerMetadataStatus: organizerLabel == null
              ? _state.organizerMetadataStatus
              : MeetingOrganizerMetadataStatus.resolved,
          clearMetadataFailure:
              organizerLabel != null &&
              _state.organizerMetadataStatus !=
                  MeetingOrganizerMetadataStatus.unavailable,
        );
        _syncResultsWorkspaceCapabilities();
        notifyListeners();
      } catch (error) {
        if (!ownsSecondary()) return;
        if (error is ApiFailure &&
            (error.status == 403 || error.status == 404)) {
          _clearProtectedState();
          return;
        }
        _state = _copy(participantsLoaded: false, metadataFailure: error);
        notifyListeners();
      }
    }

    if (!loadOrganizer || !ownsSecondary()) return;
    if (_participantDisplayName(
          _state.participants,
          snapshot.meeting.organizerId,
        ) !=
        null) {
      if (_state.organizerMetadataStatus !=
          MeetingOrganizerMetadataStatus.resolved) {
        _state = _copy(
          organizerMetadataStatus: MeetingOrganizerMetadataStatus.resolved,
        );
        notifyListeners();
      }
      return;
    }
    try {
      final organizer = await meetings.organizer(
        snapshot.meeting.organizerId,
        sessionScope: sessionScope,
      );
      if (!ownsSecondary() ||
          organizer.id.toLowerCase() !=
              snapshot.meeting.organizerId.toLowerCase()) {
        return;
      }
      _state = _copy(
        organizerName: organizer.name,
        organizerMetadataStatus: MeetingOrganizerMetadataStatus.resolved,
        clearMetadataFailure: true,
      );
      _syncResultsWorkspaceCapabilities();
      notifyListeners();
    } catch (error) {
      if (!ownsSecondary()) return;
      _state = _copy(
        organizerMetadataStatus: MeetingOrganizerMetadataStatus.unavailable,
        metadataFailure: error,
      );
      notifyListeners();
    }
  }

  String? _participantDisplayName(
    Iterable<MeetingParticipant> records,
    String organizerId,
  ) {
    for (final participant in records) {
      if (participant.userId.toLowerCase() == organizerId.toLowerCase()) {
        final name = participant.displayName?.trim();
        if (name != null && name.isNotEmpty) return name;
      }
    }
    return null;
  }

  MeetingAggregateMutationToken? acquireAggregateMutation(
    MeetingDetailMutation mutation, {
    MeetingSnapshot? confirmedContext,
  }) {
    if (!state.canStartAggregateMutation || !ownsSession) return null;
    final current = _state.snapshot;
    if (confirmedContext != null &&
        (current == null ||
            confirmedContext.meeting.id.toLowerCase() !=
                meetingId.toLowerCase() ||
            !meetings.api.isCurrentAuthenticatedSession(
              confirmedContext.sessionScope,
            ) ||
            confirmedContext.etag != current.etag ||
            confirmedContext.meeting.lifecycleStatus !=
                current.meeting.lifecycleStatus)) {
      return null;
    }
    final token = MeetingAggregateMutationToken(
      meetingId: meetingId,
      sessionScope: sessionScope,
      sequence: ++_mutationSequence,
      invalidationRevision: invalidation.revision,
    );
    _activeMutationToken = token;
    _state = _copy(activeMutation: mutation, clearMessage: true);
    notifyListeners();
    return token;
  }

  bool ownsAggregateMutation(MeetingAggregateMutationToken token) =>
      !_disposed &&
      identical(_activeMutationToken, token) &&
      token.meetingId.toLowerCase() == meetingId.toLowerCase() &&
      token.sessionScope == sessionScope &&
      meetings.api.isCurrentAuthenticatedSession(token.sessionScope);

  bool acceptAggregateSnapshot(
    MeetingAggregateMutationToken token,
    MeetingSnapshot snapshot,
  ) {
    if (!_validAggregateSnapshot(token, snapshot)) {
      return false;
    }
    final generation = ++_generation;
    _acceptCanonical(snapshot, generation: generation, loadSecondary: false);
    _finishAggregateAcceptance(token);
    return ownsAggregateMutation(token) &&
        _state.snapshot?.etag == snapshot.etag;
  }

  /// Accepts a mutation response and awaits all protected secondary
  /// projections before the aggregate owner can release its token.
  Future<bool> acceptAggregateSnapshotAndReconcile(
    MeetingAggregateMutationToken token,
    MeetingSnapshot snapshot,
  ) async {
    if (!_validAggregateSnapshot(token, snapshot)) return false;
    final generation = ++_generation;
    _acceptCanonical(snapshot, generation: generation, loadSecondary: false);
    await _loadSecondary(
      snapshot,
      generation,
      loadRoom: snapshot.meeting.roomId != null,
      loadParticipants: true,
      loadOrganizer: true,
      aggregateToken: token,
    );
    if (!ownsAggregateMutation(token)) return false;
    _finishAggregateAcceptance(token);
    return _state.snapshot?.etag == snapshot.etag;
  }

  bool _validAggregateSnapshot(
    MeetingAggregateMutationToken token,
    MeetingSnapshot snapshot,
  ) =>
      ownsAggregateMutation(token) &&
      snapshot.meeting.id.toLowerCase() == meetingId.toLowerCase() &&
      snapshot.sessionScope == sessionScope;

  void _finishAggregateAcceptance(MeetingAggregateMutationToken token) {
    if (!ownsAggregateMutation(token)) return;
    final currentRevision = invalidation.revision;
    final ownInvalidation =
        currentRevision == token.invalidationRevision + 1 &&
        invalidation.lastMeetingId?.toLowerCase() == meetingId.toLowerCase();
    if (ownInvalidation) {
      _pendingInvalidation = false;
      _seenInvalidationRevision = currentRevision;
    } else if (currentRevision != token.invalidationRevision &&
        (invalidation.lastMeetingId == null ||
            invalidation.lastMeetingId?.toLowerCase() ==
                meetingId.toLowerCase())) {
      _pendingInvalidation = true;
      _state = _copy(needsRevalidation: true);
      notifyListeners();
    }
  }

  Future<MeetingSnapshot?> revalidateAggregate(
    MeetingAggregateMutationToken token,
  ) async {
    if (!ownsAggregateMutation(token)) return null;
    final generation = ++_generation;
    final revisionAtRead = invalidation.revision;
    _state = _copy(needsRevalidation: true, clearFailure: true);
    notifyListeners();
    try {
      final latest = await meetings.detail(meetingId);
      if (!_ownsAggregate(generation, token)) return null;
      if (revisionAtRead != invalidation.revision) {
        _pendingInvalidation = true;
        _state = _copy(
          phase: MeetingDetailPhase.recoveryRequired,
          needsRevalidation: true,
          message: 'ข้อมูล cuộc họp vừa thay đổi thêm. Hãy tải lại trước khi tiếp tục.',
        );
        notifyListeners();
        return null;
      }
      _pendingInvalidation = false;
      _seenInvalidationRevision = revisionAtRead;
      _acceptCanonical(
        latest,
        generation: generation,
        refreshMetadata: true,
        loadSecondary: false,
      );
      await _loadSecondary(
        latest,
        generation,
        loadRoom: latest.meeting.roomId != null,
        loadParticipants: false,
        loadOrganizer: true,
        aggregateToken: token,
      );
      if (!_ownsAggregate(generation, token)) return null;
      return _state.snapshot;
    } catch (error) {
      if (!_ownsAggregate(generation, token)) return null;
      final denied =
          error is ApiFailure && (error.status == 403 || error.status == 404);
      if (denied) {
        _clearProtectedState();
      } else {
        _state = _copy(
          phase: MeetingDetailPhase.recoveryRequired,
          failure: error,
          needsRevalidation: true,
          message: 'Không thể xác nhận phiên bản cuộc họp hiện tại.',
        );
        notifyListeners();
      }
      return null;
    }
  }

  void releaseAggregateMutation(MeetingAggregateMutationToken token) {
    if (!ownsAggregateMutation(token)) return;
    _activeMutationToken = null;
    _state = _copy(clearActiveMutation: true);
    notifyListeners();
    if (_pendingInvalidation && ownsSession) {
      _pendingInvalidation = false;
      unawaited(refresh());
    }
  }

  void acceptMembershipRecords(List<MeetingParticipant> records) {
    final snapshot = _state.snapshot;
    if (snapshot == null) return;
    acceptMembershipSnapshotRecords(snapshot, records);
  }

  void acceptMembershipSnapshotRecords(
    MeetingSnapshot snapshot,
    List<MeetingParticipant> records,
  ) {
    if (!ownsSession ||
        _state.snapshot == null ||
        snapshot.sessionScope != sessionScope ||
        snapshot.meeting.id.toLowerCase() != meetingId.toLowerCase() ||
        _state.snapshot!.etag != snapshot.etag) {
      return;
    }
    final organizerLabel = _participantDisplayName(
      records,
      snapshot.meeting.organizerId,
    );
    _state = _copy(
      participants: List<MeetingParticipant>.unmodifiable(records),
      participantsLoaded: true,
      organizerMetadataStatus: organizerLabel == null
          ? _state.organizerMetadataStatus
          : MeetingOrganizerMetadataStatus.resolved,
    );
    _syncResultsWorkspaceCapabilities();
    notifyListeners();
  }

  void membershipAccessRevoked() => _clearProtectedState();

  bool _ownsAggregate(int generation, MeetingAggregateMutationToken token) =>
      _owns(generation) && ownsAggregateMutation(token);

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
        current.meeting.id.toLowerCase() !=
            confirmedContext.meeting.id.toLowerCase() ||
        confirmedContext.meeting.id.toLowerCase() != meetingId.toLowerCase() ||
        !meetings.api.isCurrentAuthenticatedSession(
          confirmedContext.sessionScope,
        ) ||
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
    final token = acquireAggregateMutation(
      mutation,
      confirmedContext: confirmedContext,
    );
    if (token == null) {
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
      if (!_ownsAggregate(generation, token)) {
        return const MeetingLifecycleResult(
          status: MeetingLifecycleResultStatus.unknown,
          message: 'Phiên đăng nhập đã thay đổi; kết quả chưa thể hiển thị.',
        );
      }
      if (!await acceptAggregateSnapshotAndReconcile(token, changed)) {
        return const MeetingLifecycleResult(
          status: MeetingLifecycleResultStatus.unknown,
          message:
              'Phiên bản mới chưa thể được xác nhận trong chi tiết cuộc họp.',
        );
      }
      return MeetingLifecycleResult(
        status: MeetingLifecycleResultStatus.confirmed,
        message: 'Đã cập nhật cuộc họp theo xác nhận của máy chủ.',
        snapshot: changed,
      );
    } on MeetingFailure catch (failure) {
      if (!_ownsAggregate(generation, token)) {
        return MeetingLifecycleResult(
          status: MeetingLifecycleResultStatus.unknown,
          message: 'Phiên đăng nhập đã thay đổi; chưa thể xác nhận kết quả.',
          failure: failure,
        );
      }
      if (failure.mutationOutcome == MeetingMutationOutcome.unknown) {
        return await _reconcileLifecycleOutcome(
          generation: generation,
          token: token,
          command: command,
          context: confirmedContext,
          cancellationReason: cancellationReason,
          failure: failure,
        );
      }
      if (failure.category == MeetingFailureCategory.versionConflict ||
          failure.category == MeetingFailureCategory.businessConflict ||
          failure.category == MeetingFailureCategory.authorization ||
          failure.category == MeetingFailureCategory.resourceUnavailable) {
        await _revalidateAfterRejectedLifecycle(
          generation: generation,
          token: token,
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
      if (!_ownsAggregate(generation, token)) {
        return const MeetingLifecycleResult(
          status: MeetingLifecycleResultStatus.unknown,
          message: 'Phiên đăng nhập đã thay đổi; chưa thể xác nhận kết quả.',
        );
      }
      return await _reconcileLifecycleOutcome(
        generation: generation,
        token: token,
        command: command,
        context: confirmedContext,
        cancellationReason: cancellationReason,
        failure: error,
      );
    } finally {
      if (ownsAggregateMutation(token)) releaseAggregateMutation(token);
    }
  }

  Future<MeetingLifecycleResult> _reconcileLifecycleOutcome({
    required int generation,
    required MeetingAggregateMutationToken token,
    required MeetingLifecycleCommand command,
    required MeetingSnapshot context,
    required String? cancellationReason,
    required Object failure,
  }) async {
    final revisionAtRead = invalidation.revision;
    try {
      final latest = await meetings.detail(meetingId);
      if (!_ownsAggregate(generation, token)) {
        return const MeetingLifecycleResult(
          status: MeetingLifecycleResultStatus.unknown,
          message: 'Phiên đăng nhập đã thay đổi; chưa thể xác nhận kết quả.',
        );
      }
      if (revisionAtRead == invalidation.revision) {
        _pendingInvalidation = false;
        _seenInvalidationRevision = revisionAtRead;
      }
      _acceptCanonical(latest, generation: generation, loadSecondary: false);
      await _loadSecondary(
        latest,
        generation,
        loadRoom: latest.meeting.roomId != null,
        loadParticipants: true,
        loadOrganizer: true,
        aggregateToken: token,
      );
      if (!_ownsAggregate(generation, token)) {
        return const MeetingLifecycleResult(
          status: MeetingLifecycleResultStatus.unknown,
          message: 'Phiên đăng nhập đã thay đổi; chưa thể xác nhận kết quả.',
        );
      }
      if (revisionAtRead == invalidation.revision) {
        _pendingInvalidation = false;
        _seenInvalidationRevision = revisionAtRead;
      }
      final target = _targetStatus(command);
      final observed =
          latest.meeting.lifecycleStatus == target &&
          (command != MeetingLifecycleCommand.schedule ||
              (_sameInterval(context.meeting, latest.meeting) &&
                  context.meeting.roomId == latest.meeting.roomId)) &&
          (command != MeetingLifecycleCommand.cancel ||
              _normalizeReason(cancellationReason) == null ||
              _normalizeReason(latest.meeting.cancellationReason) ==
                  _normalizeReason(cancellationReason));
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
    required MeetingAggregateMutationToken token,
    required Object failure,
  }) async {
    final revisionAtRead = invalidation.revision;
    try {
      final latest = await meetings.detail(meetingId);
      if (!_ownsAggregate(generation, token)) return;
      if (revisionAtRead == invalidation.revision) {
        _pendingInvalidation = false;
        _seenInvalidationRevision = revisionAtRead;
      }
      _acceptCanonical(latest, generation: generation, loadSecondary: false);
      await _loadSecondary(
        latest,
        generation,
        loadRoom: latest.meeting.roomId != null,
        loadParticipants: true,
        loadOrganizer: true,
        aggregateToken: token,
      );
      if (!_ownsAggregate(generation, token)) return;
      if (revisionAtRead == invalidation.revision) {
        _pendingInvalidation = false;
        _seenInvalidationRevision = revisionAtRead;
      }
      _state = _copy(
        message:
            'Thao tác bị từ chối. Đã tải trạng thái hiện tại để bạn xem lại.',
      );
      notifyListeners();
    } catch (error) {
      if (!_ownsAggregate(generation, token)) return;
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
    String? organizerName,
    bool clearOrganizerName = false,
    MeetingOrganizerMetadataStatus? organizerMetadataStatus,
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
    organizerName: clearOrganizerName
        ? null
        : organizerName ?? _state.organizerName,
    organizerMetadataStatus:
        organizerMetadataStatus ?? _state.organizerMetadataStatus,
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
    _disposeResultsWorkspace();
    _generation++;
    _pendingInvalidation = false;
    _activeMutationToken = null;
    _state = const MeetingDetailState(
      phase: MeetingDetailPhase.accessRevoked,
      snapshot: null,
      room: null,
      roomUnavailable: false,
      participants: <MeetingParticipant>[],
      participantsLoaded: false,
      organizerName: null,
      organizerMetadataStatus: MeetingOrganizerMetadataStatus.unavailable,
      metadataFailure: null,
      failure: null,
      activeMutation: null,
      needsRevalidation: false,
      message: 'Quyền truy cập cuộc họp đã thay đổi.',
    );
    for (final listener in List<MeetingCanonicalSnapshotListener>.of(
      _canonicalListeners,
    )) {
      listener(null);
    }
    notifyListeners();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _generation++;
    _disposeResultsWorkspace();
    invalidation.removeListener(_onInvalidation);
    meetings.api.sessionCoordinator.removeListener(_onSessionChanged);
    _canonicalListeners.clear();
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
