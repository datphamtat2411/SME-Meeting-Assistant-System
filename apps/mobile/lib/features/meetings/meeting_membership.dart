import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/meeting_models.dart';
import 'package:sme_meeting_assistant/core/models.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_foundation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_invalidation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_aggregate_coordination.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_repository.dart';

enum MembershipMutationCertainty { notDispatched, rejected, unknown }

enum MembershipFailureCategory {
  authentication,
  authorization,
  resourceUnavailable,
  businessConflict,
  versionConflict,
  missingPrecondition,
  validation,
  rateLimited,
  timeout,
  server,
  transport,
  invalidResponse,
  rejectedRequest,
  unknown,
}

class MembershipFailure extends ApiFailure {
  MembershipFailure._(
    ApiFailure source, {
    required this.category,
    required this.outcome,
    this.cause,
  }) : super(
         source.status,
         source.code,
         source.message,
         requestId: source.requestId,
         responseRequestId: source.responseRequestId,
         timestamp: source.timestamp,
         errors: source.errors,
         retryAfter: source.retryAfter,
         headers: source.headers,
         isTransportFailure: source.isTransportFailure,
       );

  final MembershipFailureCategory category;
  final MembershipMutationCertainty outcome;
  final Object? cause;
}

class MeetingMembershipRepository {
  MeetingMembershipRepository({
    required this.api,
    required this.meetings,
    required this.invalidation,
  });

  final ApiClient api;
  final MeetingRepository meetings;
  final MeetingInvalidationSignal invalidation;

  Future<List<MeetingParticipant>> listParticipants(
    String meetingId, {
    required AuthenticatedSessionScope sessionScope,
  }) async {
    _validateMeetingId(meetingId);
    api.requireCurrentAuthenticatedSession(sessionScope);
    final response = await api.get('${_meetingPath(meetingId)}/participants');
    api.requireCurrentAuthenticatedSession(sessionScope);
    final raw = response.objectArrayData();
    final records = <MeetingParticipant>[];
    final membershipIds = <String>{};
    final activeUserIds = <String>{};
    for (final item in raw) {
      final record = MeetingParticipant.fromJson(item, response: response);
      if (record.meetingId.toLowerCase() != meetingId.toLowerCase() ||
          !membershipIds.add(record.id.toLowerCase()) ||
          (record.isActive &&
              !activeUserIds.add(record.userId.toLowerCase()))) {
        throw response.invalidDataFailure();
      }
      records.add(record);
    }
    api.requireCurrentAuthenticatedSession(sessionScope);
    return List<MeetingParticipant>.unmodifiable(records);
  }

  Future<MeetingParticipant> addParticipant(
    MeetingSnapshot original,
    String userId,
  ) {
    _validateSnapshot(original);
    _validateManageCapability(original);
    _validateParticipantIdentity(original, userId);
    return _dispatch(
      original,
      send: () => api.post(
        '${_meetingPath(original.meeting.id)}/participants',
        <String, dynamic>{'userId': userId},
        headers: <String, String>{'If-Match': original.etag},
      ),
      decode: (response) {
        final participant = MeetingParticipant.fromJson(
          response.objectData(),
          response: response,
        );
        if (participant.meetingId.toLowerCase() !=
                original.meeting.id.toLowerCase() ||
            participant.userId.toLowerCase() != userId.toLowerCase() ||
            !participant.isActive) {
          throw response.invalidDataFailure();
        }
        return participant;
      },
    );
  }

  Future<MeetingSnapshot> removeParticipant(
    MeetingSnapshot original,
    String userId,
  ) {
    _validateSnapshot(original);
    _validateManageCapability(original);
    _validateParticipantIdentity(original, userId);
    if (userId.toLowerCase() == original.meeting.organizerId.toLowerCase()) {
      throw ArgumentError.value(
        userId,
        'userId',
        'The meeting organizer cannot be removed.',
      );
    }
    return _dispatch(
      original,
      send: () => api.delete(
        '${_meetingPath(original.meeting.id)}/participants/${Uri.encodeComponent(userId)}',
        headers: <String, String>{'If-Match': original.etag},
      ),
      decode: (response) {
        final meeting = Meeting.fromCanonicalJson(
          response.objectData(),
          response: response,
        );
        if (meeting.id.toLowerCase() != original.meeting.id.toLowerCase()) {
          throw response.invalidDataFailure();
        }
        final etag = response.etag;
        if (etag == null || !_isUsableEtag(etag)) {
          throw response.invalidDataFailure();
        }
        return MeetingSnapshot(
          meeting: meeting,
          etag: etag,
          sessionScope: original.sessionScope,
        );
      },
    );
  }

  Future<T> _dispatch<T>(
    MeetingSnapshot original, {
    required Future<ApiResult> Function() send,
    required T Function(ApiResult response) decode,
  }) async {
    var dispatched = false;
    try {
      api.requireCurrentAuthenticatedSession(original.sessionScope);
      dispatched = true;
      final response = await send();
      api.requireCurrentAuthenticatedSession(original.sessionScope);
      final result = decode(response);
      if (!invalidation.invalidate(
        sessionScope: original.sessionScope,
        meetingId: original.meeting.id,
      )) {
        throw MembershipFailure._(
          const ApiFailure(
            401,
            'AUTH_SESSION_CHANGED',
            'The authenticated session changed during membership management.',
          ),
          category: MembershipFailureCategory.authentication,
          outcome: MembershipMutationCertainty.unknown,
        );
      }
      return result;
    } catch (error) {
      if (error is ArgumentError) rethrow;
      final source = _asApiFailure(error);
      final outcome = !dispatched
          ? MembershipMutationCertainty.notDispatched
          : _mutationCertainty(source);
      final failure = error is MembershipFailure
          ? error
          : MembershipFailure._(
              source,
              category: _categoryFor(source),
              outcome: outcome,
              cause: error,
            );
      if (failure.outcome == MembershipMutationCertainty.unknown &&
          api.isCurrentAuthenticatedSession(original.sessionScope)) {
        invalidation.invalidate(
          sessionScope: original.sessionScope,
          meetingId: original.meeting.id,
        );
      }
      throw failure;
    }
  }

  void _validateSnapshot(MeetingSnapshot snapshot) {
    _validateMeetingId(snapshot.meeting.id);
    if (!_isUsableEtag(snapshot.etag)) {
      throw MembershipFailure._(
        const ApiFailure(
          428,
          'MEETING_VERSION_REQUIRED',
          'A server-issued meeting version is required.',
        ),
        category: MembershipFailureCategory.missingPrecondition,
        outcome: MembershipMutationCertainty.notDispatched,
      );
    }
    try {
      api.requireCurrentAuthenticatedSession(snapshot.sessionScope);
    } catch (error) {
      throw MembershipFailure._(
        _asApiFailure(error),
        category: MembershipFailureCategory.authentication,
        outcome: MembershipMutationCertainty.notDispatched,
        cause: error,
      );
    }
  }

  void _validateManageCapability(MeetingSnapshot snapshot) {
    final canManage = MeetingCapabilityPolicy.evaluate(
      callerId: api.userId,
      meeting: snapshot.meeting,
    ).canManageParticipants;
    if (!canManage) {
      throw MembershipFailure._(
        const ApiFailure(
          403,
          'MEETING_MEMBERSHIP_NOT_ALLOWED',
          'You are not allowed to manage this meeting membership.',
        ),
        category: MembershipFailureCategory.authorization,
        outcome: MembershipMutationCertainty.notDispatched,
      );
    }
  }

  void _validateParticipantIdentity(MeetingSnapshot snapshot, String userId) {
    if (!isMeetingUuid(userId)) {
      throw ArgumentError.value(userId, 'userId', 'Must be a UUID.');
    }
    if (userId.toLowerCase() == snapshot.meeting.organizerId.toLowerCase()) {
      throw ArgumentError.value(
        userId,
        'userId',
        'The meeting organizer is not an additional participant.',
      );
    }
  }

  MembershipMutationCertainty _mutationCertainty(ApiFailure failure) {
    if (!failure.transportFailure &&
        failure.status >= 400 &&
        failure.status <= 499 &&
        failure.status != 408 &&
        failure.status != 425) {
      return MembershipMutationCertainty.rejected;
    }
    return MembershipMutationCertainty.unknown;
  }

  MembershipFailureCategory _categoryFor(ApiFailure failure) {
    if (failure.status == 401) return MembershipFailureCategory.authentication;
    if (failure.status == 403) return MembershipFailureCategory.authorization;
    if (failure.status == 404) {
      return MembershipFailureCategory.resourceUnavailable;
    }
    if (failure.status == 412) {
      return MembershipFailureCategory.versionConflict;
    }
    if (failure.status == 428) {
      return MembershipFailureCategory.missingPrecondition;
    }
    if (failure.status == 409)
      return MembershipFailureCategory.businessConflict;
    if (failure.status == 429) return MembershipFailureCategory.rateLimited;
    if (failure.transportFailure) return MembershipFailureCategory.transport;
    if (failure.invalidResponse) {
      return MembershipFailureCategory.invalidResponse;
    }
    if (failure.status == 408 || failure.status == 425) {
      return MembershipFailureCategory.timeout;
    }
    if (failure.status >= 500 && failure.status <= 599) {
      return MembershipFailureCategory.server;
    }
    if (failure.status == 400 ||
        failure.status == 422 ||
        failure.code == 'VALIDATION_FAILED') {
      return MembershipFailureCategory.validation;
    }
    if (failure.status >= 400 && failure.status <= 499) {
      return MembershipFailureCategory.rejectedRequest;
    }
    return MembershipFailureCategory.unknown;
  }

  ApiFailure _asApiFailure(Object error) {
    if (error is ApiFailure) return error;
    return ApiFailure(
      0,
      'MEETING_MEMBERSHIP_FAILURE',
      'The membership operation could not be completed.',
      isTransportFailure: true,
    );
  }
}

enum MembershipOperationStatus {
  notDispatched,
  confirmed,
  observed,
  rejected,
  unknown,
}

class MembershipMutationResult {
  const MembershipMutationResult({
    required this.status,
    required this.reconciled,
    required this.requiresRevalidation,
    this.participant,
    this.snapshot,
    this.failure,
  });

  final MembershipOperationStatus status;
  final bool reconciled;
  final bool requiresRevalidation;
  final MeetingParticipant? participant;
  final MeetingSnapshot? snapshot;
  final Object? failure;
}

class MeetingMembershipState {
  const MeetingMembershipState({
    required this.snapshot,
    required this.records,
    required this.isInitialized,
    required this.isLoading,
    required this.isMutating,
    required this.needsRevalidation,
    required this.accessRevoked,
    required this.lastMutation,
    required this.failure,
  });

  final MeetingSnapshot? snapshot;
  final List<MeetingParticipant> records;
  final bool isInitialized;
  final bool isLoading;
  final bool isMutating;
  final bool needsRevalidation;
  final bool accessRevoked;
  final MembershipMutationResult? lastMutation;
  final Object? failure;

  List<MeetingParticipant> get activeParticipants =>
      List.unmodifiable(records.where((record) => record.isActive));

  List<MeetingParticipant> get historicalParticipants =>
      List.unmodifiable(records.where((record) => !record.isActive));

  int get activeParticipantCount => activeParticipants.length;
}

typedef MeetingMembershipSnapshotAcceptance = bool Function(
  MeetingAggregateMutationToken token,
  MeetingSnapshot snapshot,
);
typedef MeetingMembershipRecordsCallback = void Function(
  List<MeetingParticipant> records,
);
typedef MeetingMembershipSnapshotRecordsCallback = void Function(
  MeetingSnapshot snapshot,
  List<MeetingParticipant> records,
);
typedef MeetingMembershipSnapshotAsyncAcceptance = Future<bool> Function(
  MeetingAggregateMutationToken token,
  MeetingSnapshot snapshot,
);
typedef MeetingAggregateMutationAcquirer =
    MeetingAggregateMutationToken? Function(MeetingSnapshot confirmedContext);
typedef MeetingAggregateMutationOwnership = bool Function(
  MeetingAggregateMutationToken token,
);
typedef MeetingAggregateMutationReleaser = void Function(
  MeetingAggregateMutationToken token,
);
typedef MeetingAggregateRevalidator = Future<MeetingSnapshot?> Function(
  MeetingAggregateMutationToken token,
);
typedef MeetingCanonicalRefresher = Future<MeetingSnapshot?> Function();

class MeetingMembershipController extends ChangeNotifier {
  MeetingMembershipController({
    required this.repository,
    required MeetingSnapshot snapshot,
    Iterable<MeetingParticipant>? initialRecords,
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
  }) : _state = MeetingMembershipState(
         snapshot: snapshot,
         records: initialRecords == null
             ? const <MeetingParticipant>[]
             : List<MeetingParticipant>.unmodifiable(initialRecords),
         isInitialized: initialRecords != null,
         isLoading: initialRecords == null,
         isMutating: false,
         needsRevalidation: false,
         accessRevoked: false,
         lastMutation: null,
         failure: null,
       ) {
    _seenInvalidationRevision = repository.invalidation.revision;
    repository.invalidation.addListener(_onInvalidation);
    repository.api.sessionCoordinator.addListener(_onSessionChanged);
  }

  final MeetingMembershipRepository repository;
  final MeetingMembershipRecordsCallback? onRecordsChanged;
  final MeetingMembershipSnapshotRecordsCallback? onSnapshotRecordsChanged;
  final VoidCallback? onAccessRevoked;
  final bool Function()? canStartAggregateMutation;
  final MeetingAggregateMutationAcquirer? acquireAggregateMutation;
  final MeetingAggregateMutationReleaser? releaseAggregateMutation;
  final MeetingAggregateMutationOwnership? ownsAggregateMutation;
  final MeetingMembershipSnapshotAcceptance? acceptAggregateSnapshot;
  final MeetingMembershipSnapshotAsyncAcceptance?
  acceptAggregateSnapshotAndReconcile;
  final MeetingAggregateRevalidator? revalidateAggregate;
  final MeetingCanonicalRefresher? refreshCanonical;
  MeetingMembershipState _state;
  int _generation = 0;
  int _seenInvalidationRevision = 0;
  Future<void>? _refreshOperation;
  bool _pendingInvalidation = false;
  bool _disposed = false;

  MeetingMembershipState get state => _state;

  bool get canManageParticipants {
    final snapshot = _state.snapshot;
    if (_disposed ||
        snapshot == null ||
        !_isCurrentSession(snapshot.sessionScope) ||
        !_state.isInitialized ||
        _state.isLoading ||
        _state.isMutating ||
        _state.needsRevalidation ||
        _state.accessRevoked ||
        (canStartAggregateMutation != null && !canStartAggregateMutation!())) {
      return false;
    }
    return MeetingCapabilityPolicy.evaluate(
      callerId: repository.api.userId,
      meeting: snapshot.meeting,
    ).canManageParticipants;
  }

  Future<void> initialize() async {
    final snapshot = _state.snapshot;
    if (snapshot == null || _disposed || _state.isInitialized) return;
    final generation = ++_generation;
    _state = _copy(isLoading: true, failure: null, clearFailure: true);
    notifyListeners();
    try {
      final records = await repository.listParticipants(
        snapshot.meeting.id,
        sessionScope: snapshot.sessionScope,
      );
      if (!_owns(generation, snapshot.sessionScope)) return;
      _state = _copy(
        records: records,
        isInitialized: true,
        isLoading: false,
        needsRevalidation: false,
        failure: null,
        clearFailure: true,
      );
      _publishRecords(snapshot, records);
    } catch (error) {
      if (!_owns(generation, snapshot.sessionScope)) return;
      _applyReadFailure(error, accessContext: true);
    } finally {
      if (_owns(generation, snapshot.sessionScope)) notifyListeners();
    }
  }

  /// Accepts a version published by the detail owner and refreshes only the
  /// membership projection; this controller never promotes its own read to
  /// the current aggregate version.
  void updateCanonicalSnapshot(MeetingSnapshot snapshot) {
    final previous = _state.snapshot;
    if (_disposed ||
        previous == null ||
        !_isCurrentSession(snapshot.sessionScope) ||
        snapshot.sessionScope != previous.sessionScope ||
        snapshot.meeting.id.toLowerCase() !=
            previous.meeting.id.toLowerCase() ||
        snapshot.etag == previous.etag ||
        _state.isMutating) {
      return;
    }
    final generation = ++_generation;
    _state = _copy(snapshot: snapshot, needsRevalidation: true);
    notifyListeners();
    unawaited(_refreshMembershipForSnapshot(snapshot, generation));
  }

  void clearForCanonicalAccessLoss() {
    if (_disposed) return;
    _generation++;
    _pendingInvalidation = false;
    _state = const MeetingMembershipState(
      snapshot: null,
      records: <MeetingParticipant>[],
      isInitialized: false,
      isLoading: false,
      isMutating: false,
      needsRevalidation: false,
      accessRevoked: true,
      lastMutation: null,
      failure: null,
    );
    notifyListeners();
  }

  Future<void> _refreshMembershipForSnapshot(
    MeetingSnapshot snapshot,
    int generation,
  ) async {
    try {
      final records = await repository.listParticipants(
        snapshot.meeting.id,
        sessionScope: snapshot.sessionScope,
      );
      if (!_owns(generation, snapshot.sessionScope) ||
          _state.snapshot?.etag != snapshot.etag) {
        return;
      }
      _state = _copy(
        records: records,
        isInitialized: true,
        isLoading: false,
        needsRevalidation: false,
        failure: null,
        clearFailure: true,
      );
      _publishRecords(snapshot, records);
    } catch (error) {
      if (!_owns(generation, snapshot.sessionScope)) return;
      _applyReadFailure(error, accessContext: true);
    }
    if (_owns(generation, snapshot.sessionScope)) notifyListeners();
  }

  Future<void> refresh() {
    if (_disposed || _state.isMutating) return Future<void>.value();
    final active = _refreshOperation;
    if (active != null) return active;
    final operation = _refreshCanonicalAndMembership();
    _refreshOperation = operation;
    unawaited(
      operation.then((_) {
        if (identical(_refreshOperation, operation)) {
          _refreshOperation = null;
        }
      }),
    );
    return operation;
  }

  Future<MembershipMutationResult> addParticipant(
    String userId, {
    MeetingSnapshot? confirmedContext,
  }) async {
    final snapshot = _state.snapshot;
    final guardFailure = _mutationGuard(snapshot, userId, confirmedContext);
    if (guardFailure != null) return _notDispatched(guardFailure);
    if (_state.activeParticipants.any(
      (record) => record.userId.toLowerCase() == userId.toLowerCase(),
    )) {
      return _notDispatched(
        _localConflict('This person is already an active participant.'),
      );
    }
    return _mutateMembership(snapshot: snapshot!, userId: userId, add: true);
  }

  Future<MembershipMutationResult> removeParticipant(
    MeetingParticipant intent, {
    MeetingSnapshot? confirmedContext,
  }) async {
    final snapshot = _state.snapshot;
    final userId = intent.userId;
    final guardFailure = _mutationGuard(snapshot, userId, confirmedContext);
    if (guardFailure != null) return _notDispatched(guardFailure);
    if (userId.toLowerCase() == snapshot!.meeting.organizerId.toLowerCase()) {
      return _notDispatched(
        _localConflict('The meeting organizer cannot be removed.'),
      );
    }
    final activeOccurrence = _state.activeParticipants.where(
      (record) =>
          record.userId.toLowerCase() == userId.toLowerCase() &&
          record.id.toLowerCase() == intent.id.toLowerCase(),
    );
    if (activeOccurrence.isEmpty) {
      return _notDispatched(
        _localConflict(
          'The active membership changed while the confirmation was open. Review the current membership before removing it.',
        ),
      );
    }
    return _mutateMembership(snapshot: snapshot, userId: userId, add: false);
  }

  MembershipFailure? _mutationGuard(
    MeetingSnapshot? snapshot,
    String userId,
    MeetingSnapshot? confirmedContext,
  ) {
    if (snapshot == null ||
        _disposed ||
        !_isCurrentSession(snapshot.sessionScope)) {
      return _localAuthFailure();
    }
    if (_state.isMutating) {
      return _localConflict('A membership update is already in progress.');
    }
    if (!_state.isInitialized || _state.needsRevalidation) {
      return _localConflict('Reload membership data before trying again.');
    }
    if (confirmedContext != null &&
        (confirmedContext.meeting.id.toLowerCase() !=
                snapshot.meeting.id.toLowerCase() ||
            confirmedContext.sessionScope != snapshot.sessionScope ||
            confirmedContext.etag != snapshot.etag ||
            confirmedContext.meeting.lifecycleStatus !=
                snapshot.meeting.lifecycleStatus)) {
      return _localConflict(
        'The reviewed meeting version is no longer current. Review it again before continuing.',
      );
    }
    if (canStartAggregateMutation != null && !canStartAggregateMutation!()) {
      return _localConflict('A meeting change is already in progress.');
    }
    if (!isMeetingUuid(userId)) {
      return _localConflict('The selected participant is not valid.');
    }
    if (!MeetingCapabilityPolicy.evaluate(
      callerId: repository.api.userId,
      meeting: snapshot.meeting,
    ).canManageParticipants) {
      return MembershipFailure._(
        const ApiFailure(
          403,
          'MEETING_MEMBERSHIP_NOT_ALLOWED',
          'You are not allowed to manage this meeting membership.',
        ),
        category: MembershipFailureCategory.authorization,
        outcome: MembershipMutationCertainty.notDispatched,
      );
    }
    return null;
  }

  Future<MembershipMutationResult> _mutateMembership({
    required MeetingSnapshot snapshot,
    required String userId,
    required bool add,
  }) async {
    final acquire = acquireAggregateMutation;
    final aggregateToken = acquire?.call(snapshot);
    if (acquire != null && aggregateToken == null) {
      return _notDispatched(
        _localConflict('A meeting change is already in progress.'),
      );
    }
    final generation = ++_generation;
    _state = _copy(isMutating: true, failure: null, clearFailure: true);
    notifyListeners();
    try {
      if (add) {
        final participant = await repository.addParticipant(snapshot, userId);
        if (!_ownsOperation(
          generation,
          snapshot.sessionScope,
          aggregateToken,
        )) {
          return _unknownAfterSessionChange();
        }
        final records = _withConfirmedAddition(_state.records, participant);
        var result = MembershipMutationResult(
          status: MembershipOperationStatus.confirmed,
          reconciled: false,
          requiresRevalidation: true,
          participant: participant,
        );
        _state = _copy(
          records: records,
          needsRevalidation: true,
          lastMutation: result,
          failure: null,
          clearFailure: true,
        );
        notifyListeners();
        final reconciled = await _reconcileBoth(
          generation: generation,
          sessionScope: snapshot.sessionScope,
          aggregateToken: aggregateToken,
        );
        if (reconciled != null &&
            _ownsOperation(generation, snapshot.sessionScope, aggregateToken)) {
          result = MembershipMutationResult(
            status: MembershipOperationStatus.confirmed,
            reconciled: true,
            requiresRevalidation: false,
            participant: participant,
            snapshot: reconciled,
          );
          _state = _copy(
            lastMutation: result,
            needsRevalidation: false,
            failure: null,
            clearFailure: true,
          );
        } else {
          if (!_ownsOperation(
            generation,
            snapshot.sessionScope,
            aggregateToken,
          )) {
            return _unknownAfterSessionChange();
          }
          result = MembershipMutationResult(
            status: MembershipOperationStatus.confirmed,
            reconciled: false,
            requiresRevalidation: true,
            participant: participant,
          );
          _state = _copy(lastMutation: result, needsRevalidation: true);
        }
        return result;
      }

      final updatedSnapshot = await repository.removeParticipant(
        snapshot,
        userId,
      );
      if (!_ownsOperation(generation, snapshot.sessionScope, aggregateToken)) {
        return _unknownAfterSessionChange();
      }
      if (aggregateToken != null) {
        final accepted = acceptAggregateSnapshotAndReconcile != null
            ? await acceptAggregateSnapshotAndReconcile!(
                aggregateToken,
                updatedSnapshot,
              )
            : acceptAggregateSnapshot?.call(aggregateToken, updatedSnapshot) ??
                  false;
        if (!accepted) return _unknownAfterSessionChange();
      }
      var result = MembershipMutationResult(
        status: MembershipOperationStatus.confirmed,
        reconciled: false,
        requiresRevalidation: true,
        snapshot: updatedSnapshot,
      );
      _state = _copy(
        snapshot: updatedSnapshot,
        needsRevalidation: true,
        lastMutation: result,
        failure: null,
        clearFailure: true,
      );
      notifyListeners();
      final records = await _readMemberships(
        updatedSnapshot,
        generation: generation,
        aggregateToken: aggregateToken,
      );
      if (records != null &&
          _ownsOperation(generation, snapshot.sessionScope, aggregateToken)) {
        result = MembershipMutationResult(
          status: MembershipOperationStatus.confirmed,
          reconciled: true,
          requiresRevalidation: false,
          snapshot: updatedSnapshot,
        );
        _state = _copy(
          records: records,
          isInitialized: true,
          needsRevalidation: false,
          lastMutation: result,
          failure: null,
          clearFailure: true,
        );
        _publishRecords(updatedSnapshot, records);
      } else {
        if (!_ownsOperation(
          generation,
          snapshot.sessionScope,
          aggregateToken,
        )) {
          return _unknownAfterSessionChange();
        }
        result = MembershipMutationResult(
          status: MembershipOperationStatus.confirmed,
          reconciled: false,
          requiresRevalidation: true,
          snapshot: updatedSnapshot,
        );
        _state = _copy(lastMutation: result, needsRevalidation: true);
      }
      return result;
    } on MembershipFailure catch (failure) {
      if (!_ownsOperation(generation, snapshot.sessionScope, aggregateToken)) {
        return _unknownAfterSessionChange(failure: failure);
      }
      if (failure.outcome == MembershipMutationCertainty.unknown) {
        return _reconcileUnknown(
          generation: generation,
          snapshot: snapshot,
          aggregateToken: aggregateToken,
          userId: userId,
          add: add,
          failure: failure,
        );
      }
      final conflict = failure.status == 412;
      var result = MembershipMutationResult(
        status: MembershipOperationStatus.rejected,
        reconciled: false,
        requiresRevalidation: conflict,
        failure: failure,
      );
      _state = _copy(
        needsRevalidation: conflict,
        lastMutation: result,
        clearFailure: true,
      );
      if (conflict) {
        final reconciled = await _reconcileBoth(
          generation: generation,
          sessionScope: snapshot.sessionScope,
          aggregateToken: aggregateToken,
        );
        final success =
            reconciled != null &&
            _ownsOperation(generation, snapshot.sessionScope, aggregateToken);
        if (!_ownsOperation(
          generation,
          snapshot.sessionScope,
          aggregateToken,
        )) {
          return _unknownAfterSessionChange(failure: failure);
        }
        result = MembershipMutationResult(
          status: MembershipOperationStatus.rejected,
          reconciled: success,
          requiresRevalidation: !success,
          failure: failure,
          snapshot: reconciled,
        );
        _state = _copy(
          needsRevalidation: !success,
          lastMutation: result,
          clearFailure: success,
        );
      }
      return result;
    } catch (error) {
      if (!_ownsOperation(generation, snapshot.sessionScope, aggregateToken)) {
        return _unknownAfterSessionChange();
      }
      final failure = _localFailure(error);
      final result = MembershipMutationResult(
        status: MembershipOperationStatus.unknown,
        reconciled: false,
        requiresRevalidation: true,
        failure: failure,
      );
      _state = _copy(
        needsRevalidation: true,
        lastMutation: result,
        clearFailure: true,
      );
      return result;
    } finally {
      var refreshAfterRelease = false;
      if (_owns(generation, snapshot.sessionScope)) {
        final stillOwnsAggregate = _ownsOperation(
          generation,
          snapshot.sessionScope,
          aggregateToken,
        );
        _state = _copy(
          isMutating: false,
          needsRevalidation: stillOwnsAggregate
              ? _state.needsRevalidation
              : true,
        );
        notifyListeners();
        refreshAfterRelease = _pendingInvalidation;
      }
      if (aggregateToken != null) {
        releaseAggregateMutation?.call(aggregateToken);
      }
      if (refreshAfterRelease && _owns(generation, snapshot.sessionScope)) {
        _pendingInvalidation = false;
        _seenInvalidationRevision = repository.invalidation.revision;
        unawaited(refresh());
      }
    }
  }

  Future<MembershipMutationResult> _reconcileUnknown({
    required int generation,
    required MeetingSnapshot snapshot,
    required MeetingAggregateMutationToken? aggregateToken,
    required String userId,
    required bool add,
    required MembershipFailure failure,
  }) async {
    _state = _copy(
      needsRevalidation: true,
      lastMutation: MembershipMutationResult(
        status: MembershipOperationStatus.unknown,
        reconciled: false,
        requiresRevalidation: true,
        failure: failure,
      ),
      clearFailure: true,
    );
    notifyListeners();
    final reconciled = await _reconcileBoth(
      generation: generation,
      sessionScope: snapshot.sessionScope,
      aggregateToken: aggregateToken,
    );
    if (reconciled == null ||
        !_ownsOperation(generation, snapshot.sessionScope, aggregateToken)) {
      if (!_ownsOperation(generation, snapshot.sessionScope, aggregateToken)) {
        return _unknownAfterSessionChange(failure: failure);
      }
      final result = MembershipMutationResult(
        status: MembershipOperationStatus.unknown,
        reconciled: false,
        requiresRevalidation: true,
        failure: failure,
      );
      _state = _copy(needsRevalidation: true, lastMutation: result);
      return result;
    }
    final foundActive = _state.activeParticipants.any(
      (record) => record.userId.toLowerCase() == userId.toLowerCase(),
    );
    final desiredStateObserved = add ? foundActive : !foundActive;
    final matchingParticipants = add
        ? _state.activeParticipants
              .where(
                (record) => record.userId.toLowerCase() == userId.toLowerCase(),
              )
              .toList()
        : const <MeetingParticipant>[];
    final result = MembershipMutationResult(
      status: desiredStateObserved
          ? MembershipOperationStatus.observed
          : MembershipOperationStatus.unknown,
      reconciled: true,
      requiresRevalidation: false,
      participant: matchingParticipants.isEmpty
          ? null
          : matchingParticipants.first,
      snapshot: reconciled,
      failure: desiredStateObserved ? null : failure,
    );
    _state = _copy(
      needsRevalidation: false,
      lastMutation: result,
      clearFailure: true,
    );
    return result;
  }

  Future<MeetingSnapshot?> _reconcileBoth({
    required int generation,
    required AuthenticatedSessionScope sessionScope,
    MeetingAggregateMutationToken? aggregateToken,
  }) async {
    final current = _state.snapshot;
    if (current == null) return null;
    final revisionAtStart = repository.invalidation.revision;
    try {
      final snapshot = aggregateToken != null
          ? await revalidateAggregate?.call(aggregateToken)
          : refreshCanonical == null
          ? await repository.meetings.detail(current.meeting.id)
          : await refreshCanonical!();
      if (snapshot == null ||
          !_ownsOperation(generation, sessionScope, aggregateToken)) {
        return null;
      }
      final records = await repository.listParticipants(
        snapshot.meeting.id,
        sessionScope: sessionScope,
      );
      if (!_ownsOperation(generation, sessionScope, aggregateToken))
        return null;
      if (repository.invalidation.revision != revisionAtStart) {
        _pendingInvalidation = true;
        _state = _copy(needsRevalidation: true);
        notifyListeners();
        return null;
      }
      _pendingInvalidation = false;
      _seenInvalidationRevision = revisionAtStart;
      _state = _copy(
        snapshot: snapshot,
        records: records,
        isInitialized: true,
        needsRevalidation: false,
        failure: null,
        clearFailure: true,
      );
      _publishRecords(snapshot, records);
      notifyListeners();
      return snapshot;
    } catch (error) {
      if (!_ownsOperation(generation, sessionScope, aggregateToken))
        return null;
      _applyReadFailure(error, accessContext: true);
      notifyListeners();
      return null;
    }
  }

  Future<List<MeetingParticipant>?> _readMemberships(
    MeetingSnapshot snapshot, {
    required int generation,
    MeetingAggregateMutationToken? aggregateToken,
  }) async {
    try {
      final records = await repository.listParticipants(
        snapshot.meeting.id,
        sessionScope: snapshot.sessionScope,
      );
      if (!_ownsOperation(generation, snapshot.sessionScope, aggregateToken)) {
        return null;
      }
      return records;
    } catch (error) {
      if (_ownsOperation(generation, snapshot.sessionScope, aggregateToken)) {
        _applyReadFailure(error, accessContext: true);
        notifyListeners();
      }
      return null;
    }
  }

  void _publishRecords(
    MeetingSnapshot snapshot,
    List<MeetingParticipant> records,
  ) {
    if (!_isCurrentSession(snapshot.sessionScope) ||
        _state.snapshot?.sessionScope != snapshot.sessionScope ||
        _state.snapshot?.meeting.id.toLowerCase() !=
            snapshot.meeting.id.toLowerCase() ||
        _state.snapshot?.etag != snapshot.etag) {
      return;
    }
    final immutable = List<MeetingParticipant>.unmodifiable(records);
    onSnapshotRecordsChanged?.call(snapshot, immutable);
    onRecordsChanged?.call(immutable);
  }

  Future<void> _refreshCanonicalAndMembership() async {
    final snapshot = _state.snapshot;
    if (snapshot == null || _disposed) return;
    final generation = ++_generation;
    _state = _copy(isLoading: true, failure: null, clearFailure: true);
    notifyListeners();
    final reconciled = await _reconcileBoth(
      generation: generation,
      sessionScope: snapshot.sessionScope,
    );
    if (!_owns(generation, snapshot.sessionScope)) return;
    if (_state.snapshot == null) return;
    _state = _copy(isLoading: false, needsRevalidation: reconciled == null);
    notifyListeners();
  }

  void _applyReadFailure(Object error, {required bool accessContext}) {
    final denied =
        error is ApiFailure && (error.status == 403 || error.status == 404);
    if (accessContext && denied) {
      _state = _copy(
        clearSnapshot: true,
        records: const <MeetingParticipant>[],
        isInitialized: false,
        isLoading: false,
        needsRevalidation: false,
        accessRevoked: true,
        failure: error,
      );
      onAccessRevoked?.call();
      return;
    }
    _state = _copy(isLoading: false, needsRevalidation: true, failure: error);
  }

  MembershipMutationResult _notDispatched(MembershipFailure failure) =>
      MembershipMutationResult(
        status: MembershipOperationStatus.notDispatched,
        reconciled: false,
        requiresRevalidation: _state.needsRevalidation,
        failure: failure,
      );

  MembershipMutationResult _unknownAfterSessionChange({
    MembershipFailure? failure,
  }) => MembershipMutationResult(
    status: MembershipOperationStatus.unknown,
    reconciled: false,
    requiresRevalidation: true,
    failure: failure,
  );

  MembershipFailure _localConflict(String message) => MembershipFailure._(
    ApiFailure(409, 'MEETING_MEMBERSHIP_CONFLICT', message),
    category: MembershipFailureCategory.businessConflict,
    outcome: MembershipMutationCertainty.notDispatched,
  );

  MembershipFailure _localAuthFailure() => MembershipFailure._(
    const ApiFailure(
      401,
      'AUTH_SESSION_CHANGED',
      'The authenticated session is no longer active.',
    ),
    category: MembershipFailureCategory.authentication,
    outcome: MembershipMutationCertainty.notDispatched,
  );

  MembershipFailure _localFailure(Object error) => MembershipFailure._(
    ApiFailure(
      0,
      'MEETING_MEMBERSHIP_RECONCILIATION_FAILED',
      'Membership status could not be confirmed.',
      isTransportFailure: true,
    ),
    category: MembershipFailureCategory.unknown,
    outcome: MembershipMutationCertainty.unknown,
    cause: error,
  );

  List<MeetingParticipant> _withConfirmedAddition(
    List<MeetingParticipant> records,
    MeetingParticipant added,
  ) {
    if (records.any(
      (record) =>
          record.isActive &&
          record.userId.toLowerCase() == added.userId.toLowerCase(),
    )) {
      return records;
    }
    return List<MeetingParticipant>.unmodifiable([...records, added]);
  }

  MeetingMembershipState _copy({
    MeetingSnapshot? snapshot,
    bool clearSnapshot = false,
    List<MeetingParticipant>? records,
    bool? isInitialized,
    bool? isLoading,
    bool? isMutating,
    bool? needsRevalidation,
    bool? accessRevoked,
    MembershipMutationResult? lastMutation,
    bool clearLastMutation = false,
    Object? failure,
    bool clearFailure = false,
  }) => MeetingMembershipState(
    snapshot: clearSnapshot ? null : snapshot ?? _state.snapshot,
    records: records ?? _state.records,
    isInitialized: isInitialized ?? _state.isInitialized,
    isLoading: isLoading ?? _state.isLoading,
    isMutating: isMutating ?? _state.isMutating,
    needsRevalidation: needsRevalidation ?? _state.needsRevalidation,
    accessRevoked: accessRevoked ?? _state.accessRevoked,
    lastMutation: clearLastMutation
        ? null
        : lastMutation ?? _state.lastMutation,
    failure: clearFailure ? null : failure ?? _state.failure,
  );

  bool _isCurrentSession(AuthenticatedSessionScope scope) =>
      repository.api.isCurrentAuthenticatedSession(scope);

  bool _owns(int generation, AuthenticatedSessionScope scope) =>
      !_disposed && generation == _generation && _isCurrentSession(scope);

  bool _ownsOperation(
    int generation,
    AuthenticatedSessionScope scope,
    MeetingAggregateMutationToken? token,
  ) =>
      _owns(generation, scope) &&
      (token == null || (ownsAggregateMutation?.call(token) ?? false));

  void _onInvalidation() {
    final snapshot = _state.snapshot;
    if (_disposed || snapshot == null) return;
    if (!_isCurrentSession(snapshot.sessionScope)) {
      _clearForSessionChange();
      return;
    }
    if (_seenInvalidationRevision == repository.invalidation.revision) return;
    _seenInvalidationRevision = repository.invalidation.revision;
    final affectedId = repository.invalidation.lastMeetingId;
    if (_state.isMutating) {
      _pendingInvalidation = true;
      return;
    }
    if (affectedId != null &&
        affectedId.toLowerCase() != snapshot.meeting.id.toLowerCase()) {
      return;
    }
    unawaited(refresh());
  }

  void _onSessionChanged() {
    final snapshot = _state.snapshot;
    if (snapshot == null || _isCurrentSession(snapshot.sessionScope)) return;
    _clearForSessionChange();
  }

  void _clearForSessionChange() {
    _generation++;
    _state = const MeetingMembershipState(
      snapshot: null,
      records: <MeetingParticipant>[],
      isInitialized: false,
      isLoading: false,
      isMutating: false,
      needsRevalidation: false,
      accessRevoked: true,
      lastMutation: null,
      failure: null,
    );
    notifyListeners();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _generation++;
    repository.invalidation.removeListener(_onInvalidation);
    repository.api.sessionCoordinator.removeListener(_onSessionChanged);
    super.dispose();
  }
}

void _validateMeetingId(String meetingId) {
  if (!isMeetingUuid(meetingId)) {
    throw ArgumentError.value(meetingId, 'meetingId', 'Must be a UUID.');
  }
}

String _meetingPath(String meetingId) =>
    '/meetings/${Uri.encodeComponent(meetingId)}';

bool _isUsableEtag(String value) =>
    value.trim().isNotEmpty && !value.contains('\r') && !value.contains('\n');
