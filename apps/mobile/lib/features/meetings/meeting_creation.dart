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
  const MeetingCreationRecoveryRead(this.status, {this.record});

  final MeetingCreationRecoveryReadStatus status;
  final MeetingCreationRecord? record;
}

/// Device-private recovery for explicitly submitted meeting creation requests.
///
/// The account and deployment are part of both the record and its storage key;
/// credentials and unrelated meeting metadata are never persisted here.
class MeetingCreationRecoveryStore {
  MeetingCreationRecoveryStore({required this.storage, required Uri deployment})
    : deploymentScope = _deploymentDigest(deployment);

  static const int recordVersion = 1;
  static const String _keyPrefix = 'sme.mobile.meeting-create.v1.';
  static final Map<String, Future<void>> _operationTails =
      <String, Future<void>>{};
  static final Set<String> _activeOperations = <String>{};

  final CredentialStorage storage;
  final String deploymentScope;

  String _storageKey(String accountId) =>
      '$_keyPrefix${_digest('$deploymentScope|$accountId')}';

  Future<MeetingCreationRecord> save(
    String accountId,
    MeetingCreationRecord record,
  ) => _serialize(accountId, () async {
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

  Future<MeetingCreationRecoveryRead> read(String accountId) =>
      _serialize(accountId, () => _readUnlocked(accountId));

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
    try {
      final decoded = jsonDecode(encoded);
      if (decoded is! Map<String, dynamic>) {
        return const MeetingCreationRecoveryRead(
          MeetingCreationRecoveryReadStatus.malformed,
        );
      }
      if (decoded['version'] != recordVersion) {
        return const MeetingCreationRecoveryRead(
          MeetingCreationRecoveryReadStatus.unsupportedVersion,
        );
      }
      final record = _recordFromJson(decoded);
      if (record.accountId != accountId ||
          record.deploymentScope != deploymentScope) {
        return const MeetingCreationRecoveryRead(
          MeetingCreationRecoveryReadStatus.malformed,
        );
      }
      return MeetingCreationRecoveryRead(
        MeetingCreationRecoveryReadStatus.available,
        record: record,
      );
    } on FormatException {
      return const MeetingCreationRecoveryRead(
        MeetingCreationRecoveryReadStatus.malformed,
      );
    } on TypeError {
      return const MeetingCreationRecoveryRead(
        MeetingCreationRecoveryReadStatus.malformed,
      );
    } on ArgumentError {
      return const MeetingCreationRecoveryRead(
        MeetingCreationRecoveryReadStatus.malformed,
      );
    }
  }

  Future<void> delete(String accountId, {String? expectedIdempotencyKey}) =>
      _serialize(accountId, () async {
        if (expectedIdempotencyKey != null) {
          final current = await _readUnlocked(accountId);
          if (current.status == MeetingCreationRecoveryReadStatus.missing)
            return;
          if (current.status != MeetingCreationRecoveryReadStatus.available) {
            throw const MeetingCreationStorageException();
          }
          if (current.record?.idempotencyKey != expectedIdempotencyKey) {
            return;
          }
        }
        try {
          await storage.delete(key: _storageKey(accountId));
          await storage.confirmDurable();
        } catch (_) {
          throw const MeetingCreationStorageException();
        }
      });

  /// Acquires the one logical recovery slot for an account/deployment.
  ///
  /// Idempotency keys identify a request, but they must not create separate
  /// in-process recovery owners for the same durable record.
  bool tryAcquireOperation(String accountId, [String? idempotencyKey]) =>
      _activeOperations.add(_storageKey(accountId));

  void releaseOperation(String accountId, [String? idempotencyKey]) {
    _activeOperations.remove(_storageKey(accountId));
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
  });

  final MeetingCreationPhase phase;
  final MeetingCreationRecord? record;
  final MeetingSnapshot? snapshot;
  final Object? failure;
  final String? message;
  final MeetingCreationRecoveryReadStatus? recoveryReadStatus;

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
    String Function()? createIdempotencyKey,
  }) : _now = now ?? DateTime.now,
       _monotonicNow = monotonicNow,
       _clockWallAnchor = (now ?? DateTime.now)().toUtc(),
       _clockMonotonicAnchor = monotonicNow?.call() ?? Duration.zero,
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
  final DateTime Function() _now;
  final Duration Function()? _monotonicNow;
  final DateTime _clockWallAnchor;
  final Duration _clockMonotonicAnchor;
  final String Function() _createIdempotencyKey;
  final Stopwatch _stopwatch = Stopwatch()..start();

  MeetingCreationState _state;
  Future<void>? _operation;
  bool _disposed = false;
  bool _clockReliable = true;

  MeetingCreationState get state => _state;
  bool get ownsSession =>
      !_disposed && meetings.api.isCurrentAuthenticatedSession(sessionScope);
  bool canReplayCreate(MeetingCreationRecord record) =>
      record.accountId == sessionScope.userId &&
      record.deploymentScope == recoveryStore.deploymentScope &&
      _replayEligibility(record) == _ReplayEligibility.eligible;

  Future<void> restore() async {
    if (_disposed || !ownsSession) return;
    _publish(
      phase: MeetingCreationPhase.restoring,
      record: _state.record,
      snapshot: _state.snapshot,
      clearFailure: true,
      clearMessage: true,
    );
    final result = await recoveryStore.read(sessionScope.userId);
    if (!ownsSession) return;
    switch (result.status) {
      case MeetingCreationRecoveryReadStatus.missing:
        _publish(
          phase: MeetingCreationPhase.ready,
          record: null,
          snapshot: null,
          recoveryReadStatus: result.status,
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
          message: switch (replayEligibility) {
            _ReplayEligibility.eligible =>
              'Có một yêu cầu tạo cuộc họp chưa được xác nhận hoàn tất.',
            _ReplayEligibility.expired => 'Đã hết thời hạn gửi lại an toàn; hãy kiểm tra danh sách cuộc họp trước khi xử lý tiếp.',
            _ReplayEligibility.uncertain => 'Không thể xác minh thời hạn gửi lại an toàn. Hãy kiểm tra danh sách cuộc họp trước khi xử lý tiếp.',
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
          message: switch (result.status) {
            MeetingCreationRecoveryReadStatus.unavailable => 'Không thể đọc thông tin khôi phục. Chưa thể bắt đầu yêu cầu tạo khác.',
            MeetingCreationRecoveryReadStatus.unsupportedVersion =>
              'Thông tin khôi phục được tạo bởi phiên bản ứng dụng khác.',
            _ => 'Thông tin khôi phục không hợp lệ; chưa thể bắt đầu yêu cầu tạo khác.',
          },
        );
    }
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
    final createdAt = _readWallClock();
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
    final record = _state.record;
    if (record?.meetingId == null || !ownsSession || _operation != null) {
      return null;
    }
    String? result;
    await _run(() async {
      final snapshot = await meetings.detail(record!.meetingId!);
      if (!ownsSession) return;
      await recoveryStore.delete(
        sessionScope.userId,
        expectedIdempotencyKey: record.idempotencyKey,
      );
      if (!ownsSession) return;
      result = snapshot.meeting.id;
      _publish(
        phase: MeetingCreationPhase.completed,
        record: null,
        snapshot: snapshot,
        message: 'Đã mở trạng thái hiện tại của cuộc họp.',
        recoveryReadStatus: MeetingCreationRecoveryReadStatus.missing,
      );
    });
    return result;
  }

  /// Called only after the user has reviewed the existing meeting list and
  /// explicitly chosen to retire an identity-less recovery record.
  Future<bool> resolveAfterManualReview() async {
    if (!ownsSession ||
        _state.record?.meetingId != null ||
        _operation != null) {
      return false;
    }
    var cleared = false;
    await _run(() async {
      await recoveryStore.delete(
        sessionScope.userId,
        expectedIdempotencyKey: _state.record?.idempotencyKey,
      );
      if (!ownsSession) return;
      cleared = true;
      _publish(
        phase: MeetingCreationPhase.ready,
        record: null,
        snapshot: null,
        recoveryReadStatus: MeetingCreationRecoveryReadStatus.missing,
        message: 'Thông tin khôi phục đã được xóa theo xác nhận của bạn.',
      );
    });
    return cleared;
  }

  Future<void> _dispatchCreation(
    MeetingCreationRecord record, {
    required bool isReplay,
  }) async {
    if (!ownsSession) return;
    if (!recoveryStore.tryAcquireOperation(
      sessionScope.userId,
      record.idempotencyKey,
    )) {
      _publish(
        phase: MeetingCreationPhase.recoveryRequired,
        record: record,
        snapshot: _state.snapshot,
        message: 'Yêu cầu này đang được khôi phục ở một cửa sổ khác.',
      );
      return;
    }
    try {
      await _dispatchCreationOwned(record, isReplay: isReplay);
    } finally {
      recoveryStore.releaseOperation(
        sessionScope.userId,
        record.idempotencyKey,
      );
    }
  }

  Future<void> _dispatchCreationOwned(
    MeetingCreationRecord record, {
    required bool isReplay,
  }) async {
    _publish(
      phase: MeetingCreationPhase.persistingIntent,
      record: record,
      snapshot: null,
      clearFailure: true,
      clearMessage: true,
    );
    late final MeetingCreationRecord persistedIntent;
    try {
      persistedIntent = await recoveryStore.save(sessionScope.userId, record);
    } catch (error) {
      if (!ownsSession) return;
      _publish(
        phase: MeetingCreationPhase.recoveryRequired,
        record: null,
        snapshot: null,
        failure: error,
        recoveryReadStatus: MeetingCreationRecoveryReadStatus.unavailable,
        message: 'Không thể xác nhận lưu bền vững yêu cầu. Cuộc họp chưa được gửi; hãy khôi phục trước khi tạo yêu cầu khác.',
      );
      return;
    }
    if (!ownsSession) return;
    if (persistedIntent.phase != MeetingCreationRecordPhase.intentPersisted ||
        persistedIntent.meetingId != null) {
      _publish(
        phase: MeetingCreationPhase.recoveryRequired,
        record: persistedIntent,
        snapshot: null,
        message: 'Đã có một bước khác của yêu cầu này được lưu an toàn. Không gửi lại lệnh tạo; hãy mở hoặc kiểm tra trạng thái hiện tại.',
      );
      return;
    }
    _publish(
      phase: MeetingCreationPhase.creating,
      record: record,
      snapshot: null,
    );
    final MeetingSnapshot created;
    try {
      created = await meetings.create(
        record.input,
        idempotencyKey: record.idempotencyKey,
      );
    } on MeetingFailure catch (failure) {
      if (!ownsSession) return;
      if (failure.mutationOutcome == MeetingMutationOutcome.rejected ||
          failure.mutationOutcome == MeetingMutationOutcome.notDispatched) {
        if (isReplay) {
          _publish(
            phase: MeetingCreationPhase.recoveryRequired,
            record: record,
            snapshot: null,
            failure: failure,
            message: 'Lần khôi phục này bị từ chối nhưng chưa xác định được kết quả của yêu cầu ban đầu. Yêu cầu gốc vẫn được giữ nguyên.',
          );
          return;
        }
        try {
          await recoveryStore.delete(
            sessionScope.userId,
            expectedIdempotencyKey: record.idempotencyKey,
          );
        } catch (error) {
          if (!ownsSession) return;
          _publish(
            phase: MeetingCreationPhase.recoveryRequired,
            record: record,
            snapshot: null,
            failure: error,
            message: 'Yêu cầu bị từ chối nhưng chưa thể xóa an toàn bản ghi khôi phục.',
          );
          return;
        }
        if (!ownsSession) return;
        _publish(
          phase: MeetingCreationPhase.rejected,
          record: null,
          snapshot: null,
          failure: failure,
          message:
              'Máy chủ chưa tạo cuộc họp. Bạn có thể sửa thông tin và thử lại.',
          recoveryReadStatus: MeetingCreationRecoveryReadStatus.missing,
        );
      } else {
        _publish(
          phase: MeetingCreationPhase.outcomeUnknown,
          record: record,
          snapshot: null,
          failure: failure,
          message: 'Chưa thể xác nhận cuộc họp đã được tạo. Hãy khôi phục bằng đúng yêu cầu ban đầu.',
        );
      }
      return;
    } catch (error) {
      if (!ownsSession) return;
      _publish(
        phase: MeetingCreationPhase.outcomeUnknown,
        record: record,
        snapshot: null,
        failure: error,
        message: 'Chưa thể xác nhận cuộc họp đã được tạo. Yêu cầu ban đầu được giữ để khôi phục an toàn.',
      );
      return;
    }
    if (!ownsSession) return;
    final confirmedCandidate = record.withPhase(
      MeetingCreationRecordPhase.meetingConfirmed,
      meetingId: created.meeting.id,
    );
    late final MeetingCreationRecord confirmed;
    try {
      confirmed = await recoveryStore.save(
        sessionScope.userId,
        confirmedCandidate,
      );
    } catch (error) {
      if (!ownsSession) return;
      _publish(
        phase: MeetingCreationPhase.recoveryRequired,
        record: confirmedCandidate,
        snapshot: created,
        failure: error,
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
        message: 'Cuộc họp đã được tạo nhưng một bước khôi phục khác đang giữ định danh. Không gửi lại lệnh tạo hoặc lên lịch tự động.',
      );
      return;
    }

    if (record.action == MeetingCreationAction.saveDraft) {
      await _finishConfirmed(
        confirmed,
        created,
        'Đã tạo cuộc họp với trạng thái ${created.meeting.status}. Chưa có phòng nào được xác nhận đặt.',
      );
      return;
    }
    if (isReplay) {
      if (created.meeting.lifecycleStatus == MeetingStatus.draft) {
        _publish(
          phase: MeetingCreationPhase.partialSuccess,
          record: confirmed,
          snapshot: created,
          message: 'Đã khôi phục bản nháp hiện tại. Hãy kiểm tra trạng thái và xác nhận riêng nếu muốn lên lịch.',
        );
        return;
      }
      final matching =
          created.meeting.lifecycleStatus == MeetingStatus.scheduled &&
          _matchesCreationSchedule(created.meeting, record.input);
      await _finishConfirmed(
        confirmed,
        created,
        matching
            ? 'Cuộc họp hiện đã được lên lịch theo thông tin yêu cầu; trạng thái được xác nhận từ máy chủ.'
            : 'Đã khôi phục cuộc họp hiện có ở trạng thái ${created.meeting.status}. Hãy xem lại trước khi tiếp tục.',
      );
      return;
    }
    await _scheduleExisting(confirmed, created);
  }

  Future<void> _scheduleExisting(
    MeetingCreationRecord record,
    MeetingSnapshot snapshot,
  ) async {
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
      );
      return;
    }
    if (!_matchesCreationSchedule(meeting, record.input)) {
      _publish(
        phase: MeetingCreationPhase.partialSuccess,
        record: record,
        snapshot: snapshot,
        message: 'Bản nháp đã được tạo nhưng lịch hoặc phòng hiện tại khác yêu cầu. Hãy xem lại bản nháp trước khi lên lịch.',
      );
      return;
    }
    final pendingCandidate = record.withPhase(
      MeetingCreationRecordPhase.schedulePending,
      meetingId: meeting.id,
    );
    late final MeetingCreationRecord pending;
    try {
      pending = await recoveryStore.save(sessionScope.userId, pendingCandidate);
    } catch (error) {
      if (!ownsSession) return;
      _publish(
        phase: MeetingCreationPhase.recoveryRequired,
        record: record,
        snapshot: snapshot,
        failure: error,
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
        message: 'Bản nháp đã được tạo nhưng một bước lên lịch khác đang được khôi phục. Không gửi lại lệnh lên lịch tự động.',
      );
      return;
    }
    _publish(
      phase: MeetingCreationPhase.scheduling,
      record: pending,
      snapshot: snapshot,
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
      );
    } on MeetingFailure catch (failure) {
      if (!ownsSession) return;
      if (failure.mutationOutcome == MeetingMutationOutcome.unknown) {
        await _reconcileUnknownSchedule(pending, failure);
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
      await _reconcileUnknownSchedule(pending, error);
    }
  }

  Future<void> _reconcileUnknownSchedule(
    MeetingCreationRecord record,
    Object cause,
  ) async {
    try {
      final snapshot = await meetings.detail(record.meetingId!);
      if (!ownsSession) return;
      if (snapshot.meeting.lifecycleStatus == MeetingStatus.scheduled &&
          _matchesCreationSchedule(snapshot.meeting, record.input)) {
        await _finishConfirmed(
          record,
          snapshot,
          'Trạng thái hiện tại khớp lịch bạn yêu cầu. Không thể xác định thao tác nào đã tạo trạng thái này.',
        );
        return;
      }
      _publish(
        phase: MeetingCreationPhase.partialSuccess,
        record: record,
        snapshot: snapshot,
        failure: cause,
        message: 'Đã tải trạng thái hiện tại nhưng chưa thể xác nhận lịch yêu cầu. Hãy xem lại cuộc họp trước khi thử thao tác khác.',
      );
    } catch (readError) {
      if (!ownsSession) return;
      _publish(
        phase: MeetingCreationPhase.outcomeUnknown,
        record: record,
        snapshot: null,
        failure: readError,
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
    String message,
  ) async {
    try {
      await recoveryStore.delete(
        sessionScope.userId,
        expectedIdempotencyKey: record.idempotencyKey,
      );
    } catch (error) {
      if (!ownsSession) return;
      _publish(
        phase: MeetingCreationPhase.recoveryRequired,
        record: record,
        snapshot: snapshot,
        failure: error,
        message:
            '$message Thao tác đã hoàn tất, nhưng bản ghi khôi phục chưa thể được dọn.',
      );
      return;
    }
    if (!ownsSession) return;
    _publish(
      phase: MeetingCreationPhase.completed,
      record: null,
      snapshot: snapshot,
      message: message,
      recoveryReadStatus: MeetingCreationRecoveryReadStatus.missing,
    );
  }

  Future<void> _run(Future<void> Function() callback) {
    if (_operation != null || _disposed) return Future<void>.value();
    final completer = Completer<void>();
    final operation = completer.future;
    _operation = operation;
    unawaited(
      Future<void>.sync(callback)
          .then(
            (_) => completer.complete(),
            onError: (Object error, StackTrace stackTrace) {
              completer.completeError(error, stackTrace);
            },
          )
          .whenComplete(() {
            if (identical(_operation, operation)) _operation = null;
          }),
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
  }) {
    if (_disposed || !ownsSession) return;
    _state = MeetingCreationState(
      phase: phase,
      record: record,
      snapshot: snapshot,
      failure: clearFailure ? null : failure ?? _state.failure,
      message: clearMessage ? null : message ?? _state.message,
      recoveryReadStatus: recoveryReadStatus ?? _state.recoveryReadStatus,
    );
    notifyListeners();
  }

  _ReplayEligibility _replayEligibility(MeetingCreationRecord record) {
    if (record.meetingId != null) return _ReplayEligibility.notApplicable;
    final window = record.replayDeadline.difference(record.createdAt);
    if (window.isNegative ||
        window == Duration.zero ||
        window > meetingCreationReplaySafetyWindow) {
      return _ReplayEligibility.uncertain;
    }
    final now = _readWallClock();
    if (!_clockReliable || now.isBefore(record.createdAt)) {
      return _ReplayEligibility.uncertain;
    }
    if (!now.isBefore(record.replayDeadline)) {
      return _ReplayEligibility.expired;
    }
    return _ReplayEligibility.eligible;
  }

  DateTime _readWallClock() {
    final wallNow = _now().toUtc();
    final monotonicNow = _monotonicNow?.call() ?? _stopwatch.elapsed;
    final elapsed = monotonicNow - _clockMonotonicAnchor;
    final expectedWallNow = _clockWallAnchor.add(elapsed);
    if (wallNow.isBefore(
      expectedWallNow.subtract(const Duration(seconds: 5)),
    )) {
      _clockReliable = false;
    }
    return wallNow;
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
