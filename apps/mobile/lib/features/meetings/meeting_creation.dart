import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/models.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_foundation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_repository.dart';

const Duration meetingCreationReplaySafetyWindow = Duration(
  hours: 23,
  minutes: 50,
);

enum MeetingCreationAction { saveDraft, schedule }

enum MeetingCreationPhase {
  restoring,
  ready,
  persistingIntent,
  creating,
  scheduling,
  partialSuccess,
  outcomeUnknown,
  recoveryRequired,
  rejected,
  completed,
}

enum MeetingCreationRecordPhase {
  intentPersisted,
  meetingConfirmed,
  schedulePending,
}

enum MeetingCreationRecoveryReadStatus {
  missing,
  available,
  malformed,
  unsupportedVersion,
  unavailable,
}

enum MeetingCreationRecoveryDeleteStatus {
  deleted,
  alreadyAbsent,
  changed,
  unavailable,
  notOwned,
}

class MeetingCreationRecord {
  const MeetingCreationRecord({
    required this.accountId,
    required this.deploymentScope,
    required this.idempotencyKey,
    required this.input,
    required this.action,
    required this.createdAt,
    required this.replayDeadline,
    required this.phase,
    this.meetingId,
  });

  final String accountId;
  final String deploymentScope;
  final String idempotencyKey;
  final CreateMeetingInput input;
  final MeetingCreationAction action;
  final DateTime createdAt;
  final DateTime replayDeadline;
  final MeetingCreationRecordPhase phase;
  final String? meetingId;

  bool canReplayCreateAt(DateTime now) {
    final window = replayDeadline.difference(createdAt);
    final current = now.toUtc();
    return meetingId == null &&
        window > Duration.zero &&
        window <= meetingCreationReplaySafetyWindow &&
        !current.isBefore(createdAt) &&
        current.isBefore(replayDeadline);
  }

  MeetingCreationRecord withPhase(
    MeetingCreationRecordPhase next, {
    String? meetingId,
  }) => MeetingCreationRecord(
    accountId: accountId,
    deploymentScope: deploymentScope,
    idempotencyKey: idempotencyKey,
    input: input,
    action: action,
    createdAt: createdAt,
    replayDeadline: replayDeadline,
    phase: next,
    meetingId: meetingId ?? this.meetingId,
  );
}

class MeetingCreationRecoveryRead {
  const MeetingCreationRecoveryRead(
    this.status, {
    this.record,
    this.fingerprint,
  });

  final MeetingCreationRecoveryReadStatus status;
  final MeetingCreationRecord? record;
  final String? fingerprint;
}

class MeetingCreationRecoveryDeleteResult {
  const MeetingCreationRecoveryDeleteResult(this.status);

  final MeetingCreationRecoveryDeleteStatus status;

  bool get deleted =>
      status == MeetingCreationRecoveryDeleteStatus.deleted ||
      status == MeetingCreationRecoveryDeleteStatus.alreadyAbsent;
}

/// An opaque, identity-bound owner for one account/deployment recovery scope.
///
/// The object identity, rather than the account identifier, grants the right to
/// release a recovery operation.
class MeetingCreationOperationLease {
  MeetingCreationOperationLease._(this.scopeKey);

  final String scopeKey;
}

class _MeetingCreationReplayEvidence {
  const _MeetingCreationReplayEvidence({
    required this.scopeKey,
    required this.idempotencyKey,
    required this.createdAt,
    required this.replayDeadline,
    required this.monotonicStart,
  });

  final String scopeKey;
  final String idempotencyKey;
  final DateTime createdAt;
  final DateTime replayDeadline;
  final Duration monotonicStart;
}

/// Process-scoped evidence used to decide whether an identity-less creation
/// intent may be safely replayed.
class MeetingCreationReplayClock {
  MeetingCreationReplayClock({
    DateTime Function()? wallNow,
    Duration Function()? monotonicNow,
  }) : _wallNow = wallNow ?? DateTime.now {
    _monotonicNow = monotonicNow ?? (() => _stopwatch.elapsed);
    _stopwatch.start();
  }

  final DateTime Function() _wallNow;
  final Stopwatch _stopwatch = Stopwatch();
  late final Duration Function() _monotonicNow;
  final Map<String, _MeetingCreationReplayEvidence> _evidence =
      <String, _MeetingCreationReplayEvidence>{};

  DateTime wallNow() => _wallNow().toUtc();

  Duration monotonicNow() => _monotonicNow();

  void register(MeetingCreationRecord record) {
    final key = _evidenceKey(record);
    _evidence.putIfAbsent(
      key,
      () => _MeetingCreationReplayEvidence(
        scopeKey: '${record.deploymentScope}|${record.accountId}',
        idempotencyKey: record.idempotencyKey,
        createdAt: record.createdAt,
        replayDeadline: record.replayDeadline,
        monotonicStart: monotonicNow(),
      ),
    );
  }

  _ReplayEligibility _eligibility(MeetingCreationRecord record) {
    if (record.meetingId != null) return _ReplayEligibility.notApplicable;
    final window = record.replayDeadline.difference(record.createdAt);
    if (window <= Duration.zero || window > meetingCreationReplaySafetyWindow) {
      return _ReplayEligibility.uncertain;
    }
    final evidence = _evidence[_evidenceKey(record)];
    if (evidence == null ||
        evidence.scopeKey != '${record.deploymentScope}|${record.accountId}' ||
        evidence.idempotencyKey != record.idempotencyKey ||
        evidence.createdAt != record.createdAt ||
        evidence.replayDeadline != record.replayDeadline) {
      return _ReplayEligibility.uncertain;
    }
    final wall = wallNow();
    final monotonicElapsed = monotonicNow() - evidence.monotonicStart;
    if (wall.isBefore(record.createdAt) || monotonicElapsed.isNegative) {
      return _ReplayEligibility.uncertain;
    }
    if (!wall.isBefore(record.replayDeadline) || monotonicElapsed >= window) {
      return _ReplayEligibility.expired;
    }
    final expectedWall = record.createdAt.add(monotonicElapsed);
    if (wall.isBefore(expectedWall.subtract(const Duration(seconds: 5))) ||
        wall.isAfter(expectedWall.add(const Duration(seconds: 5)))) {
      return _ReplayEligibility.uncertain;
    }
    return _ReplayEligibility.eligible;
  }

  void retire(MeetingCreationRecord record) {
    _evidence.remove(_evidenceKey(record));
  }

  String _evidenceKey(MeetingCreationRecord record) =>
      '${record.deploymentScope}|${record.accountId}|${record.idempotencyKey}';
}

final MeetingCreationReplayClock sharedMeetingCreationReplayClock =
    MeetingCreationReplayClock();

/// The exact recovery context presented to a user for manual review.
class MeetingCreationRecoveryContext {
  const MeetingCreationRecoveryContext({
    required this.status,
    this.record,
    this.fingerprint,
  });

  final MeetingCreationRecoveryReadStatus status;
  final MeetingCreationRecord? record;
  final String? fingerprint;
}

/// Device-private recovery for explicitly submitted meeting creation requests.
///
/// The account and deployment are part of both the record and its storage key;
/// credentials and unrelated meeting metadata are never persisted here.
class MeetingCreationRecoveryStore {
  MeetingCreationRecoveryStore({
    required this.storage,
    required Uri deployment,
    MeetingCreationReplayClock? replayClock,
  }) : deploymentScope = _deploymentDigest(deployment),
       replayClock = replayClock ?? sharedMeetingCreationReplayClock;

  static const int recordVersion = 1;
  static const String _keyPrefix = 'sme.mobile.meeting-create.v1.';
  static final Map<String, Future<void>> _operationTails =
      <String, Future<void>>{};
  static final Map<String, MeetingCreationOperationLease> _activeOperations =
      <String, MeetingCreationOperationLease>{};

  final CredentialStorage storage;
  final String deploymentScope;
  final MeetingCreationReplayClock replayClock;

  String _storageKey(String accountId) =>
      '$_keyPrefix${_digest('$deploymentScope|$accountId')}';

  Future<MeetingCreationRecord> save(
    String accountId,
    MeetingCreationRecord record, {
    MeetingCreationOperationLease? lease,
  }) => _serialize(accountId, () async {
    if (lease != null &&
        (!ownsOperation(lease) || lease.scopeKey != _storageKey(accountId))) {
      throw const MeetingCreationStorageException();
    }
    if (record.accountId != accountId ||
        record.deploymentScope != deploymentScope) {
      throw const MeetingCreationStorageException();
    }
    _validateRecord(record);
    final existing = await _readUnlocked(accountId);
    if (existing.status == MeetingCreationRecoveryReadStatus.available) {
      final previous = existing.record!;
      if (previous.idempotencyKey != record.idempotencyKey ||
          !_sameIntent(previous, record)) {
        throw const MeetingCreationStorageException();
      }
      if (_phaseRank(previous.phase) > _phaseRank(record.phase)) {
        return previous;
      }
      if (previous.meetingId != null &&
          record.meetingId != previous.meetingId) {
        throw const MeetingCreationStorageException();
      }
    } else if (existing.status != MeetingCreationRecoveryReadStatus.missing) {
      throw const MeetingCreationStorageException();
    } else if (record.phase != MeetingCreationRecordPhase.intentPersisted ||
        record.meetingId != null) {
      throw const MeetingCreationStorageException();
    }
    final encoded = jsonEncode(_recordJson(record));
    try {
      await storage.write(key: _storageKey(accountId), value: encoded);
      await storage.confirmDurable();
      final persisted = await storage.read(key: _storageKey(accountId));
      if (persisted != encoded) throw const MeetingCreationStorageException();
    } catch (_) {
      throw const MeetingCreationStorageException();
    }
    return record;
  });

  Future<MeetingCreationRecoveryRead> read(
    String accountId, {
    MeetingCreationOperationLease? lease,
  }) => _serialize(accountId, () {
    if (lease != null &&
        (!ownsOperation(lease) || lease.scopeKey != _storageKey(accountId))) {
      throw const MeetingCreationStorageException();
    }
    return _readUnlocked(accountId);
  });

  Future<void> confirmDurable(
    String accountId, {
    required MeetingCreationOperationLease lease,
  }) => _serialize(accountId, () async {
    if (!ownsOperation(lease) || lease.scopeKey != _storageKey(accountId)) {
      throw const MeetingCreationStorageException();
    }
    try {
      await storage.confirmDurable();
    } catch (_) {
      throw const MeetingCreationStorageException();
    }
  });

  Future<MeetingCreationRecoveryRead> _readUnlocked(String accountId) async {
    final String? encoded;
    try {
      encoded = await storage.read(key: _storageKey(accountId));
    } catch (_) {
      return const MeetingCreationRecoveryRead(
        MeetingCreationRecoveryReadStatus.unavailable,
      );
    }
    if (encoded == null) {
      return const MeetingCreationRecoveryRead(
        MeetingCreationRecoveryReadStatus.missing,
      );
    }
    final fingerprint = _digest(encoded);
    try {
      final decoded = jsonDecode(encoded);
      if (decoded is! Map<String, dynamic>) {
        return MeetingCreationRecoveryRead(
          MeetingCreationRecoveryReadStatus.malformed,
          fingerprint: fingerprint,
        );
      }
      if (decoded['version'] != recordVersion) {
        return MeetingCreationRecoveryRead(
          MeetingCreationRecoveryReadStatus.unsupportedVersion,
          fingerprint: fingerprint,
        );
      }
      final record = _recordFromJson(decoded);
      if (record.accountId != accountId ||
          record.deploymentScope != deploymentScope) {
        return MeetingCreationRecoveryRead(
          MeetingCreationRecoveryReadStatus.malformed,
          fingerprint: fingerprint,
        );
      }
      return MeetingCreationRecoveryRead(
        MeetingCreationRecoveryReadStatus.available,
        record: record,
        fingerprint: fingerprint,
      );
    } on FormatException {
      return MeetingCreationRecoveryRead(
        MeetingCreationRecoveryReadStatus.malformed,
        fingerprint: fingerprint,
      );
    } on TypeError {
      return MeetingCreationRecoveryRead(
        MeetingCreationRecoveryReadStatus.malformed,
        fingerprint: fingerprint,
      );
    } on ArgumentError {
      return MeetingCreationRecoveryRead(
        MeetingCreationRecoveryReadStatus.malformed,
        fingerprint: fingerprint,
      );
    }
  }

  Future<MeetingCreationRecoveryDeleteResult> delete(
    String accountId, {
    required MeetingCreationOperationLease lease,
    required String expectedFingerprint,
    String? expectedIdempotencyKey,
    String? expectedMeetingId,
  }) => _serialize(accountId, () async {
    if (!ownsOperation(lease) || lease.scopeKey != _storageKey(accountId)) {
      return const MeetingCreationRecoveryDeleteResult(
        MeetingCreationRecoveryDeleteStatus.notOwned,
      );
    }
    final current = await _readUnlocked(accountId);
    if (!ownsOperation(lease)) {
      return const MeetingCreationRecoveryDeleteResult(
        MeetingCreationRecoveryDeleteStatus.notOwned,
      );
    }
    if (current.status == MeetingCreationRecoveryReadStatus.missing) {
      return const MeetingCreationRecoveryDeleteResult(
        MeetingCreationRecoveryDeleteStatus.alreadyAbsent,
      );
    }
    if (current.status == MeetingCreationRecoveryReadStatus.unavailable ||
        current.fingerprint == null) {
      return const MeetingCreationRecoveryDeleteResult(
        MeetingCreationRecoveryDeleteStatus.unavailable,
      );
    }
    if (current.fingerprint != expectedFingerprint) {
      return const MeetingCreationRecoveryDeleteResult(
        MeetingCreationRecoveryDeleteStatus.changed,
      );
    }
    final record = current.record;
    if (expectedIdempotencyKey != null &&
            record?.idempotencyKey != expectedIdempotencyKey ||
        expectedMeetingId != null && record?.meetingId != expectedMeetingId) {
      return const MeetingCreationRecoveryDeleteResult(
        MeetingCreationRecoveryDeleteStatus.changed,
      );
    }
    try {
      await storage.delete(key: _storageKey(accountId));
      await storage.confirmDurable();
      return const MeetingCreationRecoveryDeleteResult(
        MeetingCreationRecoveryDeleteStatus.deleted,
      );
    } catch (_) {
      return const MeetingCreationRecoveryDeleteResult(
        MeetingCreationRecoveryDeleteStatus.unavailable,
      );
    }
  });

  /// Acquires the one logical recovery slot for an account/deployment.
  ///
  /// Idempotency keys identify a request, but they must not create separate
  /// in-process recovery owners for the same durable record.
  MeetingCreationOperationLease? tryAcquireOperation(String accountId) {
    final scopeKey = _storageKey(accountId);
    if (_activeOperations.containsKey(scopeKey)) return null;
    final lease = MeetingCreationOperationLease._(scopeKey);
    _activeOperations[scopeKey] = lease;
    return lease;
  }

  bool ownsOperation(MeetingCreationOperationLease lease) =>
      identical(_activeOperations[lease.scopeKey], lease);

  void releaseOperation(MeetingCreationOperationLease lease) {
    if (!ownsOperation(lease)) return;
    _activeOperations.remove(lease.scopeKey);
  }

  Future<T> _serialize<T>(
    String accountId,
    Future<T> Function() operation,
  ) async {
    final key = _storageKey(accountId);
    final previous = _operationTails[key] ?? Future<void>.value();
    final release = Completer<void>();
    final current = previous.then((_) => release.future);
    _operationTails[key] = current;
    await previous;
    try {
      return await operation();
    } finally {
      release.complete();
      if (identical(_operationTails[key], current)) {
        _operationTails.remove(key);
      }
    }
  }
}

class MeetingCreationStorageException implements Exception {
  const MeetingCreationStorageException();

  @override
  String toString() =>
      'Không thể lưu an toàn thông tin khôi phục cuộc họp trên thiết bị.';
}

class MeetingCreationState {
  const MeetingCreationState({
    required this.phase,
    required this.record,
    required this.snapshot,
    required this.failure,
    required this.message,
    required this.recoveryReadStatus,
    this.recoveryFingerprint,
    this.recoveryBusy = false,
  });

  final MeetingCreationPhase phase;
  final MeetingCreationRecord? record;
  final MeetingSnapshot? snapshot;
  final Object? failure;
  final String? message;
  final MeetingCreationRecoveryReadStatus? recoveryReadStatus;
  final String? recoveryFingerprint;
  final bool recoveryBusy;

  MeetingCreationRecoveryContext? get recoveryContext {
    final status = recoveryReadStatus;
    if (status == null) return null;
    return MeetingCreationRecoveryContext(
      status: status,
      record: record,
      fingerprint: recoveryFingerprint,
    );
  }

  bool get isBusy =>
      phase == MeetingCreationPhase.restoring ||
      phase == MeetingCreationPhase.persistingIntent ||
      phase == MeetingCreationPhase.creating ||
      phase == MeetingCreationPhase.scheduling;

  bool get hasUnresolvedOperation =>
      record != null ||
      recoveryReadStatus == MeetingCreationRecoveryReadStatus.malformed ||
      recoveryReadStatus ==
          MeetingCreationRecoveryReadStatus.unsupportedVersion ||
      recoveryReadStatus == MeetingCreationRecoveryReadStatus.unavailable;

  bool get canEdit =>
      !isBusy &&
      !recoveryBusy &&
      !hasUnresolvedOperation &&
      (phase == MeetingCreationPhase.ready ||
          phase == MeetingCreationPhase.rejected);
}

class MeetingCreationController extends ChangeNotifier {
  MeetingCreationController({
    required this.meetings,
    required this.recoveryStore,
    required this.sessionScope,
    DateTime Function()? now,
    Duration Function()? monotonicNow,
    MeetingCreationReplayClock? replayClock,
    String Function()? createIdempotencyKey,
  }) : _replayClock =
           replayClock ??
           (now != null || monotonicNow != null
               ? MeetingCreationReplayClock(
                   wallNow: now,
                   monotonicNow: monotonicNow,
                 )
               : recoveryStore.replayClock),
       _createIdempotencyKey = createIdempotencyKey ?? _randomKey,
       _state = const MeetingCreationState(
         phase: MeetingCreationPhase.ready,
         record: null,
         snapshot: null,
         failure: null,
         message: null,
         recoveryReadStatus: null,
       ) {
    meetings.api.sessionCoordinator.addListener(_sessionChanged);
  }

  final MeetingRepository meetings;
  final MeetingCreationRecoveryStore recoveryStore;
  final AuthenticatedSessionScope sessionScope;
  final MeetingCreationReplayClock _replayClock;
  final String Function() _createIdempotencyKey;

  MeetingCreationState _state;
  Future<void>? _operation;
  bool _disposed = false;

  MeetingCreationState get state => _state;
  MeetingCreationRecoveryContext? get recoveryContext => _state.recoveryContext;
  bool get ownsSession =>
      !_disposed && meetings.api.isCurrentAuthenticatedSession(sessionScope);
  bool canReplayCreate(MeetingCreationRecord record) =>
      record.accountId == sessionScope.userId &&
      record.deploymentScope == recoveryStore.deploymentScope &&
      _replayEligibility(record) == _ReplayEligibility.eligible;

  Future<void> restore() {
    if (_disposed || !ownsSession) return Future<void>.value();
    return _run(() async {
      await _withRecoveryLease<void>((lease) async {
        _publish(
          phase: MeetingCreationPhase.restoring,
          record: _state.record,
          snapshot: _state.snapshot,
          clearFailure: true,
          clearMessage: true,
          recoveryBusy: false,
        );
        late final MeetingCreationRecoveryRead result;
        try {
          result = await recoveryStore.read(sessionScope.userId, lease: lease);
        } catch (error) {
          if (!ownsSession || !recoveryStore.ownsOperation(lease)) return;
          _publish(
            phase: MeetingCreationPhase.recoveryRequired,
            record: null,
            snapshot: null,
            failure: error,
            recoveryReadStatus: MeetingCreationRecoveryReadStatus.unavailable,
            recoveryFingerprint: null,
            clearRecoveryFingerprint: true,
            message: 'Không thể đọc thông tin khôi phục. Chưa thể bắt đầu yêu cầu tạo khác.',
          );
          return;
        }
        if (!ownsSession || !recoveryStore.ownsOperation(lease)) return;
        switch (result.status) {
          case MeetingCreationRecoveryReadStatus.missing:
            if (_state.record != null) {
              _replayClock.retire(_state.record!);
            }
            _publish(
              phase: MeetingCreationPhase.ready,
              record: null,
              snapshot: null,
              recoveryReadStatus: result.status,
              recoveryFingerprint: null,
              clearRecoveryFingerprint: true,
              clearMessage: true,
            );
          case MeetingCreationRecoveryReadStatus.available:
            final record = result.record!;
            final replayEligibility = record.meetingId == null
                ? _replayEligibility(record)
                : _ReplayEligibility.notApplicable;
            _publish(
              phase: record.meetingId == null
                  ? (replayEligibility == _ReplayEligibility.eligible
                        ? MeetingCreationPhase.outcomeUnknown
                        : MeetingCreationPhase.recoveryRequired)
                  : MeetingCreationPhase.partialSuccess,
              record: record,
              snapshot: null,
              recoveryReadStatus: result.status,
              recoveryFingerprint: result.fingerprint,
              message: switch (replayEligibility) {
                _ReplayEligibility.eligible =>
                  'Có một yêu cầu tạo cuộc họp chưa được xác nhận hoàn tất.',
                _ReplayEligibility.expired => 'Đã hết thời hạn gửi lại an toàn; hãy kiểm tra danh sách cuộc họp trước khi tiếp tục.',
                _ReplayEligibility.uncertain => 'Không thể xác minh thời hạn gửi lại an toàn. Hãy kiểm tra danh sách cuộc họp trước khi tiếp tục.',
                _ReplayEligibility.notApplicable => 'Có một cuộc họp đã được tạo nhưng cần xem lại trạng thái hiện tại.',
              },
            );
          case MeetingCreationRecoveryReadStatus.malformed ||
              MeetingCreationRecoveryReadStatus.unsupportedVersion ||
              MeetingCreationRecoveryReadStatus.unavailable:
            _publish(
              phase: MeetingCreationPhase.recoveryRequired,
              record: null,
              snapshot: null,
              recoveryReadStatus: result.status,
              recoveryFingerprint: result.fingerprint,
              message: switch (result.status) {
                MeetingCreationRecoveryReadStatus.unavailable => 'Không thể đọc thông tin khôi phục. Chưa thể bắt đầu yêu cầu tạo khác.',
                MeetingCreationRecoveryReadStatus.unsupportedVersion =>
                  'Thông tin khôi phục được tạo bởi phiên bản ứng dụng khác.',
                _ => 'Thông tin khôi phục không hợp lệ; chưa thể bắt đầu yêu cầu tạo khác.',
              },
            );
        }
      });
    });
  }

  Future<void> submit(
    CreateMeetingInput input,
    MeetingCreationAction action, {
    bool blockingRoomConflict = false,
  }) {
    final active = _operation;
    if (active != null) return active;
    if (!ownsSession ||
        !_state.canEdit ||
        (action == MeetingCreationAction.schedule &&
            input.scheduledInterval == null) ||
        (action == MeetingCreationAction.schedule && blockingRoomConflict)) {
      return Future<void>.value();
    }
    final createdAt = _replayClock.wallNow();
    final record = MeetingCreationRecord(
      accountId: sessionScope.userId,
      deploymentScope: recoveryStore.deploymentScope,
      idempotencyKey: _createIdempotencyKey(),
      input: input,
      action: action,
      createdAt: createdAt,
      replayDeadline: createdAt.add(meetingCreationReplaySafetyWindow),
      phase: MeetingCreationRecordPhase.intentPersisted,
    );
    _replayClock.register(record);
    return _run(() => _dispatchCreation(record, isReplay: false));
  }

  /// Deliberately retries the exact immutable create request while its
  /// conservative idempotency replay deadline remains valid.
  Future<void> retryUnresolvedCreation() {
    final record = _state.record;
    if (record == null ||
        record.meetingId != null ||
        !canReplayCreate(record) ||
        !ownsSession ||
        _operation != null) {
      return Future<void>.value();
    }
    return _run(() => _dispatchCreation(record, isReplay: true));
  }

  /// Revalidates a known created meeting and returns its id only after an
  /// authorized current representation was obtained.
  Future<String?> openRecoveredMeeting() async {
    final reviewed = recoveryContext;
    if (reviewed?.record?.meetingId == null ||
        reviewed?.fingerprint == null ||
        !ownsSession ||
        _operation != null) {
      return null;
    }
    String? result;
    await _run(() async {
      result = await _withRecoveryLease<String?>(
        (lease) => _openRecoveredMeetingOwned(reviewed!, lease),
      );
    });
    return result;
  }

  /// Called only after the user has reviewed the existing meeting list and
  /// explicitly chosen to retire an identity-less recovery record.
  Future<bool> resolveAfterManualReview({
    MeetingCreationRecoveryContext? reviewedContext,
  }) async {
    final reviewed = reviewedContext ?? recoveryContext;
    if (!ownsSession ||
        _operation != null ||
        reviewed == null ||
        reviewed.fingerprint == null ||
        reviewed.record?.meetingId != null) {
      return false;
    }
    var cleared = false;
    await _run(() async {
      cleared =
          await _withRecoveryLease<bool>(
            (lease) => _resolveAfterManualReviewOwned(reviewed, lease),
          ) ??
          false;
    });
    return cleared;
  }

  Future<void> _dispatchCreation(
    MeetingCreationRecord record, {
    required bool isReplay,
  }) async {
    if (!ownsSession) return;
    await _withRecoveryLease<void>(
      (lease) =>
          _dispatchCreationOwned(record, isReplay: isReplay, lease: lease),
    );
  }

  Future<T?> _withRecoveryLease<T>(
    Future<T> Function(MeetingCreationOperationLease lease) operation,
  ) async {
    if (!ownsSession) return null;
    final lease = recoveryStore.tryAcquireOperation(sessionScope.userId);
    if (lease == null) {
      _publish(
        phase: MeetingCreationPhase.recoveryRequired,
        record: _state.record,
        snapshot: _state.snapshot,
        recoveryBusy: true,
        message: 'Yêu cầu khôi phục đang được xử lý ở một cửa sổ khác. Hãy tải lại trạng thái sau khi thao tác đó hoàn tất.',
      );
      return null;
    }
    try {
      if (!ownsSession) return null;
      return await operation(lease);
    } finally {
      recoveryStore.releaseOperation(lease);
    }
  }

  Future<void> _dispatchCreationOwned(
    MeetingCreationRecord record, {
    required bool isReplay,
    required MeetingCreationOperationLease lease,
  }) async {
    if (!ownsSession || !recoveryStore.ownsOperation(lease)) return;
    _publish(
      phase: MeetingCreationPhase.persistingIntent,
      record: record,
      snapshot: null,
      clearFailure: true,
      clearMessage: true,
    );
    late MeetingCreationRecord persistedIntent;
    late String persistedFingerprint;
    try {
      var current = await recoveryStore.read(sessionScope.userId, lease: lease);
      if (!ownsSession || !recoveryStore.ownsOperation(lease)) return;
      if (isReplay) {
        if (current.status != MeetingCreationRecoveryReadStatus.available) {
          _publishReplayPreparationFailure(record, current);
          return;
        }
        final stored = current.record!;
        if (!_sameReplayIntent(record, stored) ||
            stored.phase != MeetingCreationRecordPhase.intentPersisted ||
            stored.meetingId != null) {
          _publishAdvancedOrChangedRecovery(current, fallback: record);
          return;
        }
        await recoveryStore.confirmDurable(sessionScope.userId, lease: lease);
        current = await recoveryStore.read(sessionScope.userId, lease: lease);
        if (!ownsSession || !recoveryStore.ownsOperation(lease)) return;
        if (current.status != MeetingCreationRecoveryReadStatus.available) {
          _publishReplayPreparationFailure(record, current);
          return;
        }
        final revalidated = current.record!;
        if (!_sameReplayIntent(record, revalidated) ||
            revalidated.phase != MeetingCreationRecordPhase.intentPersisted ||
            revalidated.meetingId != null) {
          _publishAdvancedOrChangedRecovery(current, fallback: record);
          return;
        }
        persistedIntent = revalidated;
        persistedFingerprint = current.fingerprint!;
      } else {
        if (current.status == MeetingCreationRecoveryReadStatus.missing) {
          await recoveryStore.save(sessionScope.userId, record, lease: lease);
          current = await recoveryStore.read(sessionScope.userId, lease: lease);
        }
        if (!ownsSession || !recoveryStore.ownsOperation(lease)) return;
        if (current.status != MeetingCreationRecoveryReadStatus.available) {
          _publishReplayPreparationFailure(record, current);
          return;
        }
        final stored = current.record!;
        if (!_sameReplayIntent(record, stored) ||
            stored.phase != MeetingCreationRecordPhase.intentPersisted ||
            stored.meetingId != null) {
          _publishAdvancedOrChangedRecovery(current, fallback: record);
          return;
        }
        persistedIntent = stored;
        persistedFingerprint = current.fingerprint!;
      }
    } catch (error) {
      if (!ownsSession || !recoveryStore.ownsOperation(lease)) return;
      _publish(
        phase: MeetingCreationPhase.recoveryRequired,
        record: isReplay ? record : null,
        snapshot: null,
        failure: error,
        recoveryReadStatus: MeetingCreationRecoveryReadStatus.unavailable,
        recoveryFingerprint: null,
        clearRecoveryFingerprint: true,
        message: 'Không thể xác nhận lưu bền vững yêu cầu. Cuộc họp chưa được gửi; hãy khôi phục trước khi tạo yêu cầu khác.',
      );
      return;
    }
    _publish(
      phase: MeetingCreationPhase.creating,
      record: persistedIntent,
      snapshot: null,
      recoveryReadStatus: MeetingCreationRecoveryReadStatus.available,
      recoveryFingerprint: persistedFingerprint,
    );
    if (!ownsSession ||
        !recoveryStore.ownsOperation(lease) ||
        (isReplay &&
            _replayEligibility(persistedIntent) !=
                _ReplayEligibility.eligible)) {
      if (ownsSession && recoveryStore.ownsOperation(lease)) {
        _publish(
          phase: MeetingCreationPhase.recoveryRequired,
          record: persistedIntent,
          snapshot: null,
          recoveryReadStatus: MeetingCreationRecoveryReadStatus.available,
          recoveryFingerprint: persistedFingerprint,
          message: _replayMessage(_replayEligibility(persistedIntent)),
        );
      }
      return;
    }
    final MeetingSnapshot created;
    try {
      created = await meetings.create(
        persistedIntent.input,
        idempotencyKey: persistedIntent.idempotencyKey,
      );
    } on MeetingFailure catch (failure) {
      if (!ownsSession) return;
      if (failure.mutationOutcome == MeetingMutationOutcome.rejected ||
          failure.mutationOutcome == MeetingMutationOutcome.notDispatched) {
        if (isReplay) {
          _publish(
            phase: MeetingCreationPhase.recoveryRequired,
            record: persistedIntent,
            snapshot: null,
            failure: failure,
            recoveryReadStatus: MeetingCreationRecoveryReadStatus.available,
            recoveryFingerprint: persistedFingerprint,
            message: 'Lần khôi phục này bị từ chối nhưng chưa xác định được kết quả của yêu cầu ban đầu. Yêu cầu gốc vẫn được giữ nguyên.',
          );
          return;
        }
        final cleanup = await recoveryStore.delete(
          sessionScope.userId,
          lease: lease,
          expectedFingerprint: persistedFingerprint,
          expectedIdempotencyKey: persistedIntent.idempotencyKey,
        );
        if (cleanup.status != MeetingCreationRecoveryDeleteStatus.deleted &&
            cleanup.status !=
                MeetingCreationRecoveryDeleteStatus.alreadyAbsent) {
          if (!ownsSession || !recoveryStore.ownsOperation(lease)) return;
          _publish(
            phase: MeetingCreationPhase.recoveryRequired,
            record: persistedIntent,
            snapshot: null,
            recoveryFingerprint: persistedFingerprint,
            message: 'Yêu cầu bị từ chối nhưng chưa thể xóa an toàn bản ghi khôi phục.',
          );
          return;
        }
        _replayClock.retire(persistedIntent);
        if (!ownsSession) return;
        _publish(
          phase: MeetingCreationPhase.rejected,
          record: null,
          snapshot: null,
          failure: failure,
          message:
              'Máy chủ chưa tạo cuộc họp. Bạn có thể sửa thông tin và thử lại.',
          recoveryReadStatus: MeetingCreationRecoveryReadStatus.missing,
          recoveryFingerprint: null,
          clearRecoveryFingerprint: true,
        );
      } else {
        _publish(
          phase: MeetingCreationPhase.outcomeUnknown,
          record: persistedIntent,
          snapshot: null,
          failure: failure,
          recoveryReadStatus: MeetingCreationRecoveryReadStatus.available,
          recoveryFingerprint: persistedFingerprint,
          message: 'Chưa thể xác nhận cuộc họp đã được tạo. Hãy khôi phục bằng đúng yêu cầu ban đầu.',
        );
      }
      return;
    } catch (error) {
      if (!ownsSession) return;
      _publish(
        phase: MeetingCreationPhase.outcomeUnknown,
        record: persistedIntent,
        snapshot: null,
        failure: error,
        recoveryReadStatus: MeetingCreationRecoveryReadStatus.available,
        recoveryFingerprint: persistedFingerprint,
        message: 'Chưa thể xác nhận cuộc họp đã được tạo. Yêu cầu ban đầu được giữ để khôi phục an toàn.',
      );
      return;
    }
    if (!ownsSession) return;
    final confirmedCandidate = persistedIntent.withPhase(
      MeetingCreationRecordPhase.meetingConfirmed,
      meetingId: created.meeting.id,
    );
    late final MeetingCreationRecord confirmed;
    late final String confirmedFingerprint;
    try {
      confirmed = await recoveryStore.save(
        sessionScope.userId,
        confirmedCandidate,
        lease: lease,
      );
      final confirmedRead = await recoveryStore.read(
        sessionScope.userId,
        lease: lease,
      );
      if (confirmedRead.status != MeetingCreationRecoveryReadStatus.available ||
          confirmedRead.record?.phase !=
              MeetingCreationRecordPhase.meetingConfirmed ||
          confirmedRead.record?.meetingId != created.meeting.id ||
          confirmedRead.fingerprint == null) {
        throw const MeetingCreationStorageException();
      }
      confirmedFingerprint = confirmedRead.fingerprint!;
    } catch (error) {
      if (!ownsSession) return;
      _publish(
        phase: MeetingCreationPhase.recoveryRequired,
        record: confirmedCandidate,
        snapshot: created,
        failure: error,
        recoveryFingerprint: persistedFingerprint,
        message: 'Cuộc họp đã được tạo, nhưng chưa thể lưu định danh khôi phục. Không tạo cuộc họp khác.',
      );
      return;
    }
    if (!ownsSession) return;
    if (confirmed.phase != MeetingCreationRecordPhase.meetingConfirmed ||
        confirmed.meetingId != created.meeting.id) {
      _publish(
        phase: MeetingCreationPhase.partialSuccess,
        record: confirmed,
        snapshot: created,
        recoveryFingerprint: confirmedFingerprint,
        message: 'Cuộc họp đã được tạo nhưng một bước khôi phục khác đang giữ định danh. Không gửi lại lệnh tạo hoặc lên lịch tự động.',
      );
      return;
    }

    if (persistedIntent.action == MeetingCreationAction.saveDraft) {
      await _finishConfirmed(
        confirmed,
        created,
        'Đã tạo cuộc họp với trạng thái ${created.meeting.status}. Chưa có phòng nào được xác nhận đặt.',
        lease: lease,
        expectedFingerprint: confirmedFingerprint,
      );
      return;
    }
    if (isReplay) {
      if (created.meeting.lifecycleStatus == MeetingStatus.draft) {
        _publish(
          phase: MeetingCreationPhase.partialSuccess,
          record: confirmed,
          snapshot: created,
          recoveryFingerprint: confirmedFingerprint,
          message: 'Đã khôi phục bản nháp hiện tại. Hãy kiểm tra trạng thái và xác nhận riêng nếu muốn lên lịch.',
        );
        return;
      }
      final matching =
          created.meeting.lifecycleStatus == MeetingStatus.scheduled &&
          _matchesCreationSchedule(created.meeting, persistedIntent.input);
      await _finishConfirmed(
        confirmed,
        created,
        matching
            ? 'Cuộc họp hiện đã được lên lịch theo thông tin yêu cầu; trạng thái được xác nhận từ máy chủ.'
            : 'Đã khôi phục cuộc họp hiện có ở trạng thái ${created.meeting.status}. Hãy xem lại trước khi tiếp tục.',
        lease: lease,
        expectedFingerprint: confirmedFingerprint,
      );
      return;
    }
    await _scheduleExisting(
      confirmed,
      created,
      lease: lease,
      expectedFingerprint: confirmedFingerprint,
    );
  }

  void _publishReplayPreparationFailure(
    MeetingCreationRecord fallback,
    MeetingCreationRecoveryRead current,
  ) {
    final message = switch (current.status) {
      MeetingCreationRecoveryReadStatus.missing => 'Yêu cầu khôi phục không còn bản ghi bền vững hiện tại. Hãy tải lại trạng thái và kiểm tra danh sách cuộc họp trước khi tiếp tục.',
      MeetingCreationRecoveryReadStatus.malformed ||
      MeetingCreationRecoveryReadStatus.unsupportedVersion => 'Thông tin khôi phục đã thay đổi hoặc không hợp lệ. Hãy kiểm tra danh sách cuộc họp trước khi tiếp tục.',
      MeetingCreationRecoveryReadStatus.unavailable =>
        'Không thể đọc thông tin khôi phục. Chưa thể gửi lại yêu cầu.',
      MeetingCreationRecoveryReadStatus.available =>
        'Thông tin khôi phục đã thay đổi. Hãy xem lại trạng thái hiện tại.',
    };
    _publish(
      phase: MeetingCreationPhase.recoveryRequired,
      record: current.status == MeetingCreationRecoveryReadStatus.available
          ? current.record
          : fallback,
      snapshot: null,
      recoveryReadStatus: current.status,
      recoveryFingerprint: current.fingerprint,
      message: message,
    );
  }

  void _publishAdvancedOrChangedRecovery(
    MeetingCreationRecoveryRead current, {
    required MeetingCreationRecord fallback,
  }) {
    final record = current.record;
    if (current.status != MeetingCreationRecoveryReadStatus.available ||
        record == null) {
      _publishReplayPreparationFailure(fallback, current);
      return;
    }
    _publish(
      phase: record.meetingId == null
          ? MeetingCreationPhase.recoveryRequired
          : MeetingCreationPhase.partialSuccess,
      record: record,
      snapshot: null,
      recoveryReadStatus: current.status,
      recoveryFingerprint: current.fingerprint,
      message: record.meetingId == null
          ? 'Yêu cầu khôi phục hiện tại không còn khớp yêu cầu đang mở. Hãy xem lại trạng thái trước khi tiếp tục.'
          : 'Đã có một bước khác của yêu cầu này được lưu an toàn. Không gửi lại lệnh tạo; hãy mở hoặc kiểm tra trạng thái hiện tại.',
    );
  }

  bool _sameReplayIntent(
    MeetingCreationRecord expected,
    MeetingCreationRecord actual,
  ) =>
      expected.accountId == sessionScope.userId &&
      expected.deploymentScope == recoveryStore.deploymentScope &&
      _sameIntent(expected, actual);

  String _replayMessage(_ReplayEligibility eligibility) =>
      switch (eligibility) {
        _ReplayEligibility.eligible =>
          'Có một yêu cầu tạo cuộc họp chưa được xác nhận hoàn tất.',
        _ReplayEligibility.expired => 'Đã hết thời hạn gửi lại an toàn; hãy kiểm tra danh sách cuộc họp trước khi tiếp tục.',
        _ReplayEligibility.uncertain => 'Không thể xác minh thời hạn gửi lại an toàn. Hãy kiểm tra danh sách cuộc họp trước khi tiếp tục.',
        _ReplayEligibility.notApplicable =>
          'Có một cuộc họp đã được tạo nhưng cần xem lại trạng thái hiện tại.',
      };

  Future<String?> _openRecoveredMeetingOwned(
    MeetingCreationRecoveryContext reviewed,
    MeetingCreationOperationLease lease,
  ) async {
    if (!ownsSession || !recoveryStore.ownsOperation(lease)) return null;
    final reviewedRecord = reviewed.record!;
    var current = await recoveryStore.read(sessionScope.userId, lease: lease);
    if (!_ownsRecoveryLease(lease)) return null;
    final sameImmutableIntent =
        current.status == MeetingCreationRecoveryReadStatus.available &&
        current.fingerprint == reviewed.fingerprint &&
        current.record != null &&
        _sameIntent(reviewedRecord, current.record!);
    final memoryOnlyIdentity =
        sameImmutableIntent &&
        current.record!.meetingId == null &&
        reviewedRecord.meetingId != null &&
        current.record!.phase == MeetingCreationRecordPhase.intentPersisted;
    if (!sameImmutableIntent ||
        (!memoryOnlyIdentity &&
            current.record!.meetingId != reviewedRecord.meetingId)) {
      _publishRecoveryContextChanged(current, reviewedRecord);
      return null;
    }

    if (current.record!.meetingId == null) {
      final reconciled = current.record!.withPhase(
        MeetingCreationRecordPhase.meetingConfirmed,
        meetingId: reviewedRecord.meetingId,
      );
      try {
        await recoveryStore.save(sessionScope.userId, reconciled, lease: lease);
        current = await recoveryStore.read(sessionScope.userId, lease: lease);
      } catch (error) {
        _publish(
          phase: MeetingCreationPhase.recoveryRequired,
          record: reviewedRecord,
          snapshot: _state.snapshot,
          failure: error,
          recoveryFingerprint: reviewed.fingerprint,
          message: 'Cuộc họp đã được xác định trong phiên này nhưng chưa thể đồng bộ an toàn bằng chứng khôi phục. Hãy tải lại để xem xét.',
        );
        return null;
      }
      if (!_ownsRecoveryLease(lease) ||
          current.status != MeetingCreationRecoveryReadStatus.available ||
          current.record?.meetingId != reviewedRecord.meetingId ||
          current.fingerprint == null) {
        _publishRecoveryContextChanged(current, reviewedRecord);
        return null;
      }
    }

    final meetingId = current.record!.meetingId!;
    final snapshot = await meetings.detail(meetingId);
    if (!_ownsRecoveryLease(lease)) return null;
    final latest = await recoveryStore.read(sessionScope.userId, lease: lease);
    if (!_ownsRecoveryLease(lease) ||
        latest.status != MeetingCreationRecoveryReadStatus.available ||
        latest.fingerprint != current.fingerprint ||
        latest.record?.meetingId != meetingId) {
      _publishRecoveryContextChanged(latest, current.record!);
      return null;
    }
    final cleanup = await recoveryStore.delete(
      sessionScope.userId,
      lease: lease,
      expectedFingerprint: latest.fingerprint!,
      expectedIdempotencyKey: current.record!.idempotencyKey,
      expectedMeetingId: meetingId,
    );
    if (cleanup.status != MeetingCreationRecoveryDeleteStatus.deleted &&
        cleanup.status != MeetingCreationRecoveryDeleteStatus.alreadyAbsent) {
      _publish(
        phase: MeetingCreationPhase.recoveryRequired,
        record: current.record,
        snapshot: snapshot,
        recoveryFingerprint: latest.fingerprint,
        message: 'Đã tải cuộc họp nhưng chưa thể dọn bản ghi khôi phục an toàn. Hãy tải lại trạng thái trước khi tiếp tục.',
      );
      return null;
    }
    _replayClock.retire(current.record!);
    if (!_ownsRecoveryLease(lease)) return null;
    _publish(
      phase: MeetingCreationPhase.completed,
      record: null,
      snapshot: snapshot,
      message: 'Đã mở trạng thái hiện tại của cuộc họp.',
      recoveryReadStatus: MeetingCreationRecoveryReadStatus.missing,
      recoveryFingerprint: null,
      clearRecoveryFingerprint: true,
    );
    return snapshot.meeting.id;
  }

  Future<bool> _resolveAfterManualReviewOwned(
    MeetingCreationRecoveryContext reviewed,
    MeetingCreationOperationLease lease,
  ) async {
    if (!_ownsRecoveryLease(lease)) return false;
    final current = await recoveryStore.read(sessionScope.userId, lease: lease);
    if (!_ownsRecoveryLease(lease)) return false;
    if (current.status != reviewed.status ||
        current.fingerprint != reviewed.fingerprint ||
        (reviewed.record != null &&
            (current.record == null ||
                !_sameIntent(reviewed.record!, current.record!) ||
                current.record!.meetingId != reviewed.record!.meetingId))) {
      _publishRecoveryContextChanged(current, reviewed.record);
      return false;
    }
    final cleanup = await recoveryStore.delete(
      sessionScope.userId,
      lease: lease,
      expectedFingerprint: reviewed.fingerprint!,
      expectedIdempotencyKey: reviewed.record?.idempotencyKey,
      expectedMeetingId: reviewed.record?.meetingId,
    );
    if (cleanup.status != MeetingCreationRecoveryDeleteStatus.deleted) {
      _publish(
        phase: MeetingCreationPhase.recoveryRequired,
        record: current.record ?? reviewed.record,
        snapshot: null,
        recoveryReadStatus: current.status,
        recoveryFingerprint: current.fingerprint,
        message: switch (cleanup.status) {
          MeetingCreationRecoveryDeleteStatus.alreadyAbsent => 'Thông tin khôi phục đã biến mất trước khi xác nhận xóa. Hãy tải lại trạng thái trước khi tiếp tục.',
          MeetingCreationRecoveryDeleteStatus.changed => 'Thông tin khôi phục đã thay đổi sau khi bạn xem xét. Hãy tải lại và kiểm tra lại trước khi xóa.',
          MeetingCreationRecoveryDeleteStatus.unavailable ||
          MeetingCreationRecoveryDeleteStatus.notOwned => 'Chưa thể xác nhận xóa an toàn thông tin khôi phục. Hãy thử tải lại sau.',
          MeetingCreationRecoveryDeleteStatus.deleted =>
            'Thông tin khôi phục đã được xóa.',
        },
      );
      return false;
    }
    if (current.record != null) {
      _replayClock.retire(current.record!);
    }
    if (!_ownsRecoveryLease(lease)) return false;
    _publish(
      phase: MeetingCreationPhase.ready,
      record: null,
      snapshot: null,
      recoveryReadStatus: MeetingCreationRecoveryReadStatus.missing,
      recoveryFingerprint: null,
      clearRecoveryFingerprint: true,
      message: 'Thông tin khôi phục đã được xóa theo xác nhận của bạn.',
    );
    return true;
  }

  void _publishRecoveryContextChanged(
    MeetingCreationRecoveryRead current,
    MeetingCreationRecord? fallback,
  ) {
    final message = current.status == MeetingCreationRecoveryReadStatus.missing
        ? 'Thông tin khôi phục đã không còn. Hãy tải lại trạng thái và kiểm tra danh sách cuộc họp trước khi tiếp tục.'
        : 'Thông tin khôi phục đã thay đổi sau khi bạn xem xét. Hãy tải lại và kiểm tra lại trước khi tiếp tục.';
    _publish(
      phase: MeetingCreationPhase.recoveryRequired,
      record: current.record ?? fallback,
      snapshot: null,
      recoveryReadStatus: current.status,
      recoveryFingerprint: current.fingerprint,
      message: message,
    );
  }

  bool _ownsRecoveryLease(MeetingCreationOperationLease lease) =>
      ownsSession && recoveryStore.ownsOperation(lease);

  Future<void> _scheduleExisting(
    MeetingCreationRecord record,
    MeetingSnapshot snapshot, {
    required MeetingCreationOperationLease lease,
    required String expectedFingerprint,
  }) async {
    if (!ownsSession) return;
    final meeting = snapshot.meeting;
    if (meeting.lifecycleStatus != MeetingStatus.draft) {
      final matching =
          meeting.lifecycleStatus == MeetingStatus.scheduled &&
          _matchesCreationSchedule(meeting, record.input);
      await _finishConfirmed(
        record,
        snapshot,
        matching
            ? 'Cuộc họp hiện đã được lên lịch với thời gian bạn yêu cầu.'
            : 'Cuộc họp hiện ở trạng thái ${meeting.status}; không gửi lại lệnh tạo hoặc ghi đè lịch.',
        lease: lease,
        expectedFingerprint: expectedFingerprint,
      );
      return;
    }
    if (!_matchesCreationSchedule(meeting, record.input)) {
      _publish(
        phase: MeetingCreationPhase.partialSuccess,
        record: record,
        snapshot: snapshot,
        recoveryFingerprint: expectedFingerprint,
        message: 'Bản nháp đã được tạo nhưng lịch hoặc phòng hiện tại khác yêu cầu. Hãy xem lại bản nháp trước khi lên lịch.',
      );
      return;
    }
    final pendingCandidate = record.withPhase(
      MeetingCreationRecordPhase.schedulePending,
      meetingId: meeting.id,
    );
    late final MeetingCreationRecord pending;
    late final String pendingFingerprint;
    try {
      pending = await recoveryStore.save(
        sessionScope.userId,
        pendingCandidate,
        lease: lease,
      );
      final pendingRead = await recoveryStore.read(
        sessionScope.userId,
        lease: lease,
      );
      if (pendingRead.status != MeetingCreationRecoveryReadStatus.available ||
          pendingRead.record?.phase !=
              MeetingCreationRecordPhase.schedulePending ||
          pendingRead.record?.meetingId != meeting.id ||
          pendingRead.fingerprint == null) {
        throw const MeetingCreationStorageException();
      }
      pendingFingerprint = pendingRead.fingerprint!;
    } catch (error) {
      if (!ownsSession) return;
      _publish(
        phase: MeetingCreationPhase.recoveryRequired,
        record: record,
        snapshot: snapshot,
        failure: error,
        recoveryFingerprint: expectedFingerprint,
        message: 'Bản nháp đã được tạo nhưng chưa thể lưu trạng thái lên lịch. Hãy mở bản nháp để tiếp tục.',
      );
      return;
    }
    if (!ownsSession) return;
    if (pending.phase != MeetingCreationRecordPhase.schedulePending ||
        pending.meetingId != meeting.id) {
      _publish(
        phase: MeetingCreationPhase.partialSuccess,
        record: pending,
        snapshot: snapshot,
        recoveryFingerprint: pendingFingerprint,
        message: 'Bản nháp đã được tạo nhưng một bước lên lịch khác đang được khôi phục. Không gửi lại lệnh lên lịch tự động.',
      );
      return;
    }
    _publish(
      phase: MeetingCreationPhase.scheduling,
      record: pending,
      snapshot: snapshot,
      recoveryFingerprint: pendingFingerprint,
      clearFailure: true,
      clearMessage: true,
    );
    try {
      final scheduled = await meetings.schedule(
        snapshot,
        MeetingScheduleInput(interval: record.input.scheduledInterval),
      );
      if (!ownsSession) return;
      await _finishConfirmed(
        pending,
        scheduled,
        'Đã lên lịch cuộc họp theo xác nhận của máy chủ.',
        lease: lease,
        expectedFingerprint: pendingFingerprint,
      );
    } on MeetingFailure catch (failure) {
      if (!ownsSession) return;
      if (failure.mutationOutcome == MeetingMutationOutcome.unknown) {
        await _reconcileUnknownSchedule(
          pending,
          failure,
          lease: lease,
          expectedFingerprint: pendingFingerprint,
        );
      } else if (failure.category == MeetingFailureCategory.versionConflict) {
        await _refreshForReview(pending, failure);
      } else {
        _publish(
          phase: MeetingCreationPhase.partialSuccess,
          record: pending,
          snapshot: snapshot,
          failure: failure,
          message: 'Bản nháp đã được tạo nhưng việc lên lịch bị từ chối. Hãy mở bản nháp để xử lý; không tạo cuộc họp khác.',
        );
      }
    } catch (error) {
      if (!ownsSession) return;
      await _reconcileUnknownSchedule(
        pending,
        error,
        lease: lease,
        expectedFingerprint: pendingFingerprint,
      );
    }
  }

  Future<void> _reconcileUnknownSchedule(
    MeetingCreationRecord record,
    Object cause, {
    required MeetingCreationOperationLease lease,
    required String expectedFingerprint,
  }) async {
    try {
      final snapshot = await meetings.detail(record.meetingId!);
      if (!ownsSession) return;
      if (snapshot.meeting.lifecycleStatus == MeetingStatus.scheduled &&
          _matchesCreationSchedule(snapshot.meeting, record.input)) {
        await _finishConfirmed(
          record,
          snapshot,
          'Trạng thái hiện tại khớp lịch bạn yêu cầu. Không thể xác định thao tác nào đã tạo trạng thái này.',
          lease: lease,
          expectedFingerprint: expectedFingerprint,
        );
        return;
      }
      _publish(
        phase: MeetingCreationPhase.partialSuccess,
        record: record,
        snapshot: snapshot,
        failure: cause,
        recoveryFingerprint: expectedFingerprint,
        message: 'Đã tải trạng thái hiện tại nhưng chưa thể xác nhận lịch yêu cầu. Hãy xem lại cuộc họp trước khi thử thao tác khác.',
      );
    } catch (readError) {
      if (!ownsSession) return;
      _publish(
        phase: MeetingCreationPhase.outcomeUnknown,
        record: record,
        snapshot: null,
        failure: readError,
        recoveryFingerprint: expectedFingerprint,
        message: 'Kết quả lên lịch chưa rõ và chưa thể tải trạng thái hiện tại. Không gửi lại lệnh tự động.',
      );
    }
  }

  Future<void> _refreshForReview(
    MeetingCreationRecord record,
    Object failure,
  ) async {
    try {
      final latest = await meetings.detail(record.meetingId!);
      if (!ownsSession) return;
      _publish(
        phase: MeetingCreationPhase.partialSuccess,
        record: record,
        snapshot: latest,
        failure: failure,
        message: 'Phiên bản bản nháp đã thay đổi. Hãy xem trạng thái mới nhất trước khi tiếp tục lên lịch.',
      );
    } catch (error) {
      if (!ownsSession) return;
      _publish(
        phase: MeetingCreationPhase.recoveryRequired,
        record: record,
        snapshot: null,
        failure: error,
        message: 'Bản nháp đã được tạo nhưng không thể tải phiên bản hiện tại để xác nhận lịch.',
      );
    }
  }

  Future<void> _finishConfirmed(
    MeetingCreationRecord record,
    MeetingSnapshot snapshot,
    String message, {
    required MeetingCreationOperationLease lease,
    required String expectedFingerprint,
  }) async {
    if (!ownsSession || !recoveryStore.ownsOperation(lease)) return;
    final cleanup = await recoveryStore.delete(
      sessionScope.userId,
      lease: lease,
      expectedFingerprint: expectedFingerprint,
      expectedIdempotencyKey: record.idempotencyKey,
      expectedMeetingId: record.meetingId,
    );
    if (cleanup.status != MeetingCreationRecoveryDeleteStatus.deleted &&
        cleanup.status != MeetingCreationRecoveryDeleteStatus.alreadyAbsent) {
      if (!ownsSession || !recoveryStore.ownsOperation(lease)) return;
      _publish(
        phase: MeetingCreationPhase.recoveryRequired,
        record: record,
        snapshot: snapshot,
        recoveryFingerprint: expectedFingerprint,
        message:
            '$message Thao tác đã hoàn tất, nhưng bản ghi khôi phục chưa thể được dọn.',
      );
      return;
    }
    _replayClock.retire(record);
    if (!ownsSession) return;
    _publish(
      phase: MeetingCreationPhase.completed,
      record: null,
      snapshot: snapshot,
      message: message,
      recoveryReadStatus: MeetingCreationRecoveryReadStatus.missing,
      recoveryFingerprint: null,
      clearRecoveryFingerprint: true,
    );
  }

  Future<void> _run(Future<void> Function() callback) {
    if (_operation != null || _disposed) return Future<void>.value();
    final completer = Completer<void>();
    final operation = completer.future;
    _operation = operation;
    unawaited(
      Future<void>.sync(callback).then(
        (_) {
          if (identical(_operation, operation)) _operation = null;
          completer.complete();
        },
        onError: (Object error, StackTrace stackTrace) {
          if (identical(_operation, operation)) _operation = null;
          completer.completeError(error, stackTrace);
        },
      ),
    );
    return operation;
  }

  void _publish({
    required MeetingCreationPhase phase,
    required MeetingCreationRecord? record,
    required MeetingSnapshot? snapshot,
    Object? failure,
    String? message,
    bool clearFailure = false,
    bool clearMessage = false,
    MeetingCreationRecoveryReadStatus? recoveryReadStatus,
    String? recoveryFingerprint,
    bool clearRecoveryFingerprint = false,
    bool? recoveryBusy,
  }) {
    if (_disposed || !ownsSession) return;
    _state = MeetingCreationState(
      phase: phase,
      record: record,
      snapshot: snapshot,
      failure: clearFailure ? null : failure ?? _state.failure,
      message: clearMessage ? null : message ?? _state.message,
      recoveryReadStatus: recoveryReadStatus ?? _state.recoveryReadStatus,
      recoveryFingerprint: clearRecoveryFingerprint
          ? null
          : recoveryFingerprint ?? _state.recoveryFingerprint,
      recoveryBusy: recoveryBusy ?? false,
    );
    notifyListeners();
  }

  _ReplayEligibility _replayEligibility(MeetingCreationRecord record) {
    if (record.meetingId != null) return _ReplayEligibility.notApplicable;
    return _replayClock._eligibility(record);
  }

  void _sessionChanged() {
    if (_disposed || ownsSession) return;
    _state = const MeetingCreationState(
      phase: MeetingCreationPhase.recoveryRequired,
      record: null,
      snapshot: null,
      failure: null,
      message: 'Phiên đăng nhập đã thay đổi. Dữ liệu cuộc họp đã được xóa khỏi màn hình.',
      recoveryReadStatus: null,
    );
    notifyListeners();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    meetings.api.sessionCoordinator.removeListener(_sessionChanged);
    super.dispose();
  }
}

enum _ReplayEligibility { eligible, expired, uncertain, notApplicable }

bool _matchesCreationSchedule(Meeting meeting, CreateMeetingInput input) =>
    _matchesSchedule(meeting, input) && meeting.roomId == input.roomId;

bool _matchesSchedule(Meeting meeting, CreateMeetingInput input) {
  final expected = input.scheduledInterval;
  return expected != null &&
      meeting.scheduledStartAt?.toUtc() == expected.start &&
      meeting.scheduledEndAt?.toUtc() == expected.end;
}

Map<String, Object?> _recordJson(MeetingCreationRecord record) =>
    <String, Object?>{
      'version': MeetingCreationRecoveryStore.recordVersion,
      'accountId': record.accountId,
      'deploymentScope': record.deploymentScope,
      'idempotencyKey': record.idempotencyKey,
      'title': record.input.title,
      'description': record.input.description,
      'scheduledStartAt': record.input.scheduledInterval?.toApiStart,
      'scheduledEndAt': record.input.scheduledInterval?.toApiEnd,
      'roomId': record.input.roomId,
      'participantUserIds': record.input.participantUserIds,
      'action': record.action.name,
      'createdAt': record.createdAt.toIso8601String(),
      'replayDeadline': record.replayDeadline.toIso8601String(),
      'phase': record.phase.name,
      'meetingId': record.meetingId,
    };

MeetingCreationRecord _recordFromJson(Map<String, dynamic> raw) {
  final start = _optionalDate(raw, 'scheduledStartAt');
  final end = _optionalDate(raw, 'scheduledEndAt');
  final interval = MeetingInterval.fromNullableEndpoints(start, end);
  final action = MeetingCreationAction.values.byName(raw['action'] as String);
  final phase = MeetingCreationRecordPhase.values.byName(
    raw['phase'] as String,
  );
  final participants = raw['participantUserIds'];
  if (participants != null && participants is! List) {
    throw const FormatException('Invalid participant identity list.');
  }
  final record = MeetingCreationRecord(
    accountId: raw['accountId'] as String,
    deploymentScope: raw['deploymentScope'] as String,
    idempotencyKey: raw['idempotencyKey'] as String,
    input: CreateMeetingInput(
      title: raw['title'] as String,
      description: raw['description'] as String?,
      scheduledInterval: interval,
      roomId: raw['roomId'] as String?,
      participantUserIds: participants?.cast<String>(),
    ),
    action: action,
    createdAt: DateTime.parse(raw['createdAt'] as String).toUtc(),
    replayDeadline: DateTime.parse(raw['replayDeadline'] as String).toUtc(),
    phase: phase,
    meetingId: raw['meetingId'] as String?,
  );
  if (record.accountId.isEmpty ||
      !_validStoredIdempotencyKey(record.idempotencyKey) ||
      (record.meetingId != null && !isMeetingUuid(record.meetingId!)) ||
      !record.replayDeadline.isAfter(record.createdAt) ||
      record.replayDeadline.difference(record.createdAt) >
          meetingCreationReplaySafetyWindow ||
      (record.phase == MeetingCreationRecordPhase.intentPersisted &&
          record.meetingId != null) ||
      (record.phase != MeetingCreationRecordPhase.intentPersisted &&
          record.meetingId == null) ||
      (record.action == MeetingCreationAction.schedule && interval == null) ||
      (record.phase == MeetingCreationRecordPhase.schedulePending &&
          record.action != MeetingCreationAction.schedule)) {
    throw const FormatException('Invalid creation recovery record.');
  }
  return record;
}

void _validateRecord(MeetingCreationRecord record) {
  if (record.accountId.isEmpty ||
      !_validStoredIdempotencyKey(record.idempotencyKey) ||
      (record.meetingId != null && !isMeetingUuid(record.meetingId!)) ||
      !record.replayDeadline.isAfter(record.createdAt) ||
      record.replayDeadline.difference(record.createdAt) >
          meetingCreationReplaySafetyWindow ||
      (record.action == MeetingCreationAction.schedule &&
          record.input.scheduledInterval == null) ||
      (record.phase == MeetingCreationRecordPhase.intentPersisted &&
          record.meetingId != null) ||
      (record.phase != MeetingCreationRecordPhase.intentPersisted &&
          record.meetingId == null) ||
      (record.phase == MeetingCreationRecordPhase.schedulePending &&
          record.action != MeetingCreationAction.schedule)) {
    throw const MeetingCreationStorageException();
  }
}

bool _sameIntent(MeetingCreationRecord first, MeetingCreationRecord second) =>
    first.accountId == second.accountId &&
    first.deploymentScope == second.deploymentScope &&
    first.idempotencyKey == second.idempotencyKey &&
    first.action == second.action &&
    first.createdAt == second.createdAt &&
    first.replayDeadline == second.replayDeadline &&
    first.input.title == second.input.title &&
    first.input.description == second.input.description &&
    first.input.roomId == second.input.roomId &&
    first.input.scheduledInterval?.start ==
        second.input.scheduledInterval?.start &&
    first.input.scheduledInterval?.end == second.input.scheduledInterval?.end &&
    listEquals(first.input.participantUserIds, second.input.participantUserIds);

int _phaseRank(MeetingCreationRecordPhase phase) => switch (phase) {
  MeetingCreationRecordPhase.intentPersisted => 0,
  MeetingCreationRecordPhase.meetingConfirmed => 1,
  MeetingCreationRecordPhase.schedulePending => 2,
};

DateTime? _optionalDate(Map<String, dynamic> raw, String key) {
  final value = raw[key];
  if (value == null) return null;
  if (value is! String) throw const FormatException('Invalid timestamp.');
  return DateTime.tryParse(value)?.toUtc() ??
      (throw const FormatException('Invalid timestamp.'));
}

bool _validStoredIdempotencyKey(String value) =>
    RegExp(r'^[A-Za-z0-9][A-Za-z0-9._~:-]{0,127}$').hasMatch(value);

String _randomKey() {
  final random = Random.secure();
  final bytes = List<int>.generate(24, (_) => random.nextInt(256));
  return 'mobile-${base64Url.encode(bytes).replaceAll('=', '')}';
}

String _deploymentDigest(Uri uri) {
  final normalized = uri.replace(
    scheme: uri.scheme.toLowerCase(),
    host: uri.host.toLowerCase().replaceFirst(RegExp(r'\.$'), ''),
    fragment: null,
    query: null,
  );
  return _digest(normalized.toString().replaceFirst(RegExp(r'/+$'), ''));
}

String _digest(String value) => sha256.convert(utf8.encode(value)).toString();
