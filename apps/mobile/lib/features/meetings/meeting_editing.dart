import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/models.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_foundation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_invalidation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_repository.dart';

enum MeetingEditField { title, description, schedule, room }

enum MeetingEditPhase {
  editing,
  submitting,
  rebaseRequired,
  completed,
  recoveryRequired,
  accessRevoked,
}

enum MeetingEditFieldChoice { local, server }

class MeetingEditValues {
  const MeetingEditValues({
    required this.title,
    required this.description,
    required this.start,
    required this.end,
    required this.roomId,
  });

  final String title;
  final String? description;
  final DateTime? start;
  final DateTime? end;
  final String? roomId;

  factory MeetingEditValues.fromMeeting(Meeting meeting) => MeetingEditValues(
    title: meeting.title,
    description: meeting.description,
    start: meeting.scheduledStartAt,
    end: meeting.scheduledEndAt,
    roomId: meeting.roomId,
  );

  /// Returns a validated interval only when the editable endpoints form one.
  ///
  /// A form may temporarily contain one endpoint, equal endpoints, or a
  /// reversed range. Those are ordinary editing states and must not invoke
  /// the strict domain constructor.
  MeetingInterval? get interval =>
      MeetingScheduleDraft(start: start, end: end).validatedInterval;

  String? get scheduleValidationMessage {
    if (start == null && end == null) return null;
    return MeetingScheduleDraft(start: start, end: end).validationMessage;
  }

  bool get hasValidSchedule =>
      (start == null && end == null) || interval != null;

  MeetingEditValues withField(
    MeetingEditField field,
    MeetingEditValues source,
  ) => switch (field) {
    MeetingEditField.title => MeetingEditValues(
      title: source.title,
      description: description,
      start: start,
      end: end,
      roomId: roomId,
    ),
    MeetingEditField.description => MeetingEditValues(
      title: title,
      description: source.description,
      start: start,
      end: end,
      roomId: roomId,
    ),
    MeetingEditField.schedule => MeetingEditValues(
      title: title,
      description: description,
      start: source.start,
      end: source.end,
      roomId: roomId,
    ),
    MeetingEditField.room => MeetingEditValues(
      title: title,
      description: description,
      start: start,
      end: end,
      roomId: source.roomId,
    ),
  };
}

class MeetingEditReconciliation {
  MeetingEditReconciliation({
    required this.original,
    required this.local,
    required this.server,
    required this.latestSnapshot,
    required this.merged,
    required Set<MeetingEditField> conflicts,
    required Map<MeetingEditField, MeetingEditFieldChoice> choices,
  }) : conflicts = Set<MeetingEditField>.unmodifiable(conflicts),
       choices = Map<MeetingEditField, MeetingEditFieldChoice>.unmodifiable(
         choices,
       );

  final MeetingEditValues original;
  final MeetingEditValues local;
  final MeetingEditValues server;
  final MeetingSnapshot latestSnapshot;
  final MeetingEditValues merged;
  final Set<MeetingEditField> conflicts;
  final Map<MeetingEditField, MeetingEditFieldChoice> choices;

  Set<MeetingEditField> get unresolvedConflicts =>
      conflicts.difference(choices.keys.toSet());

  MeetingEditReconciliation choose(
    MeetingEditField field,
    MeetingEditFieldChoice choice,
  ) {
    if (!conflicts.contains(field)) return this;
    final nextChoices = <MeetingEditField, MeetingEditFieldChoice>{
      ...choices,
      field: choice,
    };
    final nextMerged = merged.withField(
      field,
      choice == MeetingEditFieldChoice.local ? local : server,
    );
    return MeetingEditReconciliation(
      original: original,
      local: local,
      server: server,
      latestSnapshot: latestSnapshot,
      merged: nextMerged,
      conflicts: conflicts,
      choices: nextChoices,
    );
  }
}

class MeetingEditingState {
  const MeetingEditingState({
    required this.snapshot,
    required this.values,
    required this.dirtyFields,
    required this.phase,
    required this.reconciliation,
    required this.failure,
    required this.message,
    required this.needsRevalidation,
  });

  final MeetingSnapshot? snapshot;
  final MeetingEditValues? values;
  final Set<MeetingEditField> dirtyFields;
  final MeetingEditPhase phase;
  final MeetingEditReconciliation? reconciliation;
  final Object? failure;
  final String? message;
  final bool needsRevalidation;

  bool get isSubmitting => phase == MeetingEditPhase.submitting;
  bool get accessRevoked => phase == MeetingEditPhase.accessRevoked;
  bool get canSubmit =>
      phase == MeetingEditPhase.editing &&
      snapshot != null &&
      values != null &&
      dirtyFields.isNotEmpty &&
      values!.hasValidSchedule &&
      (snapshot!.meeting.lifecycleStatus != MeetingStatus.scheduled ||
          values!.interval != null) &&
      !needsRevalidation;
}

class MeetingEditingController extends ChangeNotifier {
  MeetingEditingController({
    required this.repository,
    required this.invalidation,
    required MeetingSnapshot snapshot,
  }) : _originalSnapshot = snapshot,
       _state = MeetingEditingState(
         snapshot: snapshot,
         values: MeetingEditValues.fromMeeting(snapshot.meeting),
         dirtyFields: const <MeetingEditField>{},
         phase: MeetingEditPhase.editing,
         reconciliation: null,
         failure: null,
         message: null,
         needsRevalidation: false,
       ) {
    _seenInvalidationRevision = invalidation.revision;
    invalidation.addListener(_onInvalidation);
    repository.api.sessionCoordinator.addListener(_onSessionChanged);
  }

  final MeetingRepository repository;
  final MeetingInvalidationSignal invalidation;
  MeetingSnapshot _originalSnapshot;
  MeetingEditingState _state;
  int _generation = 0;
  int _seenInvalidationRevision = 0;
  bool _disposed = false;

  MeetingEditingState get state => _state;
  MeetingSnapshot get originalSnapshot => _originalSnapshot;

  void updateValues(MeetingEditValues values) {
    if (_disposed ||
        _state.phase != MeetingEditPhase.editing ||
        !_ownsSession) {
      return;
    }
    _state = _copy(
      values: values,
      dirtyFields: _dirtyFields(_originalSnapshot.meeting, values),
      clearFailure: true,
      clearMessage: true,
    );
    notifyListeners();
  }

  MeetingUpdateInput? buildPatch() {
    final values = _state.values;
    final original = _originalSnapshot.meeting;
    if (values == null) return null;
    final dirty = _dirtyFields(original, values);
    if (dirty.isEmpty) return null;
    final schedule = values.interval;
    if (!values.hasValidSchedule ||
        (original.lifecycleStatus == MeetingStatus.scheduled &&
            schedule == null)) {
      return null;
    }
    return MeetingUpdateInput(
      title: dirty.contains(MeetingEditField.title)
          ? MeetingFieldUpdate<String>.set(values.title.trim())
          : const MeetingFieldUpdate<String>.omitted(),
      description: dirty.contains(MeetingEditField.description)
          ? MeetingFieldUpdate<String?>.set(
              _normalizeDescription(values.description),
            )
          : const MeetingFieldUpdate<String?>.omitted(),
      scheduledStartAt: dirty.contains(MeetingEditField.schedule)
          ? MeetingFieldUpdate<DateTime?>.set(values.start)
          : const MeetingFieldUpdate<DateTime?>.omitted(),
      scheduledEndAt: dirty.contains(MeetingEditField.schedule)
          ? MeetingFieldUpdate<DateTime?>.set(values.end)
          : const MeetingFieldUpdate<DateTime?>.omitted(),
      roomId: dirty.contains(MeetingEditField.room)
          ? MeetingFieldUpdate<String?>.set(values.roomId)
          : const MeetingFieldUpdate<String?>.omitted(),
    );
  }

  Future<void> submit() async {
    if (_disposed ||
        !_ownsSession ||
        _state.phase != MeetingEditPhase.editing) {
      return;
    }
    final snapshot = _originalSnapshot;
    final values = _state.values;
    if (values == null) return;
    final scheduleValidation = values.scheduleValidationMessage;
    if (scheduleValidation != null) {
      _state = _copy(clearFailure: true, message: scheduleValidation);
      notifyListeners();
      return;
    }
    if (snapshot.meeting.lifecycleStatus == MeetingStatus.scheduled &&
        values.interval == null) {
      _state = _copy(
        clearFailure: true,
        message: 'Cuộc họp đã lên lịch phải giữ khoảng thời gian hợp lệ.',
      );
      notifyListeners();
      return;
    }
    if (!MeetingCapabilityPolicy.evaluate(
      callerId: repository.api.userId,
      meeting: snapshot.meeting,
    ).canEdit) {
      _state = _copy(
        phase: MeetingEditPhase.recoveryRequired,
        message: 'Trạng thái hiện tại không còn cho phép chỉnh sửa.',
      );
      notifyListeners();
      return;
    }
    final MeetingUpdateInput? patch;
    try {
      patch = buildPatch();
      if (patch == null) {
        _state = _copy(message: 'Không có thay đổi cần lưu.');
        notifyListeners();
        return;
      }
      patch.validateAgainst(snapshot.meeting);
    } catch (error) {
      _state = _copy(failure: error, clearMessage: true);
      notifyListeners();
      return;
    }

    final generation = ++_generation;
    final invalidationRevisionAtDispatch = invalidation.revision;
    final localAtDispatch = values;
    _state = _copy(
      phase: MeetingEditPhase.submitting,
      clearFailure: true,
      clearMessage: true,
    );
    notifyListeners();
    try {
      final updated = await repository.update(snapshot, patch);
      if (!_owns(generation, snapshot.sessionScope)) return;
      if (invalidation.revision != invalidationRevisionAtDispatch + 1 ||
          invalidation.lastMeetingId?.toLowerCase() !=
              snapshot.meeting.id.toLowerCase()) {
        await _loadLatestForReconciliation(
          generation: generation,
          originalSnapshot: snapshot,
          local: localAtDispatch,
          failure: null,
          unknownOutcome: false,
        );
        return;
      }
      _originalSnapshot = updated;
      final nextValues = MeetingEditValues.fromMeeting(updated.meeting);
      _state = MeetingEditingState(
        snapshot: updated,
        values: nextValues,
        dirtyFields: const <MeetingEditField>{},
        phase: MeetingEditPhase.completed,
        reconciliation: null,
        failure: null,
        message: 'Đã lưu trạng thái cuộc họp do máy chủ xác nhận.',
        needsRevalidation: false,
      );
    } on MeetingFailure catch (failure) {
      if (!_owns(generation, snapshot.sessionScope)) return;
      if (failure.mutationOutcome == MeetingMutationOutcome.unknown) {
        await _reconcileUnknown(
          generation: generation,
          originalSnapshot: snapshot,
          local: localAtDispatch,
          failure: failure,
        );
      } else if (failure.category == MeetingFailureCategory.versionConflict) {
        await _loadLatestForReconciliation(
          generation: generation,
          originalSnapshot: snapshot,
          local: localAtDispatch,
          failure: failure,
          unknownOutcome: false,
        );
      } else if (failure.category == MeetingFailureCategory.authorization ||
          failure.category == MeetingFailureCategory.resourceUnavailable) {
        await _loadLatestForReconciliation(
          generation: generation,
          originalSnapshot: snapshot,
          local: localAtDispatch,
          failure: failure,
          unknownOutcome: false,
        );
      } else {
        _state = _copy(
          phase: MeetingEditPhase.editing,
          failure: failure,
          message: failure.category == MeetingFailureCategory.businessConflict
              ? 'Máy chủ từ chối thay đổi do xung đột. Thông tin đã nhập vẫn được giữ.'
              : 'Không thể lưu thay đổi. Thông tin đã nhập vẫn được giữ.',
        );
      }
    } catch (error) {
      if (!_owns(generation, snapshot.sessionScope)) return;
      await _reconcileUnknown(
        generation: generation,
        originalSnapshot: snapshot,
        local: localAtDispatch,
        failure: error,
      );
    }
    if (_owns(generation, snapshot.sessionScope) &&
        _state.phase == MeetingEditPhase.submitting) {
      _state = _copy(phase: MeetingEditPhase.editing);
    }
    if (_owns(generation, snapshot.sessionScope)) notifyListeners();
  }

  void chooseConflict(MeetingEditField field, MeetingEditFieldChoice choice) {
    final reconciliation = _state.reconciliation;
    if (_state.phase != MeetingEditPhase.rebaseRequired ||
        reconciliation == null) {
      return;
    }
    _state = _copy(reconciliation: reconciliation.choose(field, choice));
    notifyListeners();
  }

  /// Rebases only after the user has reviewed and accepted the latest snapshot.
  void acceptReconciliation() {
    final reconciliation = _state.reconciliation;
    if (_state.phase != MeetingEditPhase.rebaseRequired ||
        reconciliation == null ||
        reconciliation.unresolvedConflicts.isNotEmpty ||
        _state.needsRevalidation ||
        !_ownsSession) {
      return;
    }
    final latest = reconciliation.latestSnapshot;
    if (!MeetingCapabilityPolicy.evaluate(
      callerId: repository.api.userId,
      meeting: latest.meeting,
    ).canEdit) {
      _state = MeetingEditingState(
        snapshot: latest,
        values: reconciliation.merged,
        dirtyFields: _dirtyFields(latest.meeting, reconciliation.merged),
        phase: MeetingEditPhase.recoveryRequired,
        reconciliation: null,
        failure: null,
        message: 'Trạng thái mới không còn cho phép chỉnh sửa.',
        needsRevalidation: false,
      );
      notifyListeners();
      return;
    }
    _originalSnapshot = latest;
    final merged = reconciliation.merged;
    _state = MeetingEditingState(
      snapshot: latest,
      values: merged,
      dirtyFields: _dirtyFields(latest.meeting, merged),
      phase: MeetingEditPhase.editing,
      reconciliation: null,
      failure: null,
      message: 'Đã cập nhật phiên bản sau khi bạn xác nhận trạng thái mới.',
      needsRevalidation: false,
    );
    notifyListeners();
  }

  Future<void> revalidateLatest() async {
    if (_disposed ||
        !_ownsSession ||
        (_state.phase != MeetingEditPhase.editing &&
            _state.phase != MeetingEditPhase.recoveryRequired &&
            _state.phase != MeetingEditPhase.rebaseRequired)) {
      return;
    }
    final generation = ++_generation;
    final original = _originalSnapshot;
    final local = _state.values!;
    _state = _copy(phase: MeetingEditPhase.submitting, clearFailure: true);
    notifyListeners();
    await _loadLatestForReconciliation(
      generation: generation,
      originalSnapshot: original,
      local: local,
      failure: null,
      unknownOutcome: false,
    );
  }

  /// Revalidates access on foreground resume without replacing unsaved values.
  Future<void> revalidateOnResume() async {
    if (_disposed ||
        !_ownsSession ||
        _state.phase == MeetingEditPhase.submitting ||
        _state.phase == MeetingEditPhase.completed ||
        _state.phase == MeetingEditPhase.accessRevoked) {
      return;
    }
    if (_state.dirtyFields.isNotEmpty ||
        _state.phase != MeetingEditPhase.editing) {
      await revalidateLatest();
      return;
    }
    final generation = ++_generation;
    final original = _originalSnapshot;
    final revisionAtStart = invalidation.revision;
    _state = _copy(
      phase: MeetingEditPhase.submitting,
      clearFailure: true,
      clearMessage: true,
    );
    notifyListeners();
    try {
      final latest = await repository.detail(original.meeting.id);
      if (!_owns(generation, original.sessionScope)) return;
      if (invalidation.revision != revisionAtStart &&
          (invalidation.lastMeetingId == null ||
              invalidation.lastMeetingId?.toLowerCase() ==
                  original.meeting.id.toLowerCase())) {
        _state = _copy(
          phase: MeetingEditPhase.recoveryRequired,
          needsRevalidation: true,
          message: 'Cuộc họp vừa thay đổi. Hãy tải lại trước khi tiếp tục chỉnh sửa.',
        );
      } else {
        _originalSnapshot = latest;
        _state = MeetingEditingState(
          snapshot: latest,
          values: MeetingEditValues.fromMeeting(latest.meeting),
          dirtyFields: const <MeetingEditField>{},
          phase: MeetingEditPhase.editing,
          reconciliation: null,
          failure: null,
          message: 'Đã xác minh quyền truy cập và trạng thái hiện tại.',
          needsRevalidation: false,
        );
      }
    } catch (error) {
      if (!_owns(generation, original.sessionScope)) return;
      final denied =
          error is ApiFailure && (error.status == 403 || error.status == 404);
      if (denied) {
        _clearProtectedState();
        return;
      }
      _state = _copy(
        phase: MeetingEditPhase.recoveryRequired,
        failure: error,
        message: 'Không thể xác minh quyền truy cập hiện tại. Chưa gửi thay đổi nào.',
      );
    }
    if (_owns(generation, original.sessionScope)) notifyListeners();
  }

  Future<void> _reconcileUnknown({
    required int generation,
    required MeetingSnapshot originalSnapshot,
    required MeetingEditValues local,
    required Object failure,
  }) async {
    await _loadLatestForReconciliation(
      generation: generation,
      originalSnapshot: originalSnapshot,
      local: local,
      failure: failure,
      unknownOutcome: true,
    );
  }

  Future<void> _loadLatestForReconciliation({
    required int generation,
    required MeetingSnapshot originalSnapshot,
    required MeetingEditValues local,
    required Object? failure,
    required bool unknownOutcome,
  }) async {
    final invalidationRevisionAtStart = invalidation.revision;
    try {
      final latest = await repository.detail(originalSnapshot.meeting.id);
      if (!_owns(generation, originalSnapshot.sessionScope)) return;
      if (invalidation.revision != invalidationRevisionAtStart &&
          (invalidation.lastMeetingId == null ||
              invalidation.lastMeetingId?.toLowerCase() ==
                  originalSnapshot.meeting.id.toLowerCase())) {
        _state = _copy(
          phase: MeetingEditPhase.recoveryRequired,
          failure: failure,
          message: 'Cuộc họp tiếp tục thay đổi trong khi tải trạng thái. Nội dung đã nhập được giữ lại; hãy tải lại trước khi xác nhận.',
          needsRevalidation: true,
        );
        return;
      }
      if (unknownOutcome &&
          _matchesChangedValues(
            originalSnapshot.meeting,
            local,
            latest.meeting,
          )) {
        _originalSnapshot = latest;
        _state = MeetingEditingState(
          snapshot: latest,
          values: MeetingEditValues.fromMeeting(latest.meeting),
          dirtyFields: const <MeetingEditField>{},
          phase: MeetingEditPhase.completed,
          reconciliation: null,
          failure: null,
          message: 'Trạng thái máy chủ hiện tại đã phản ánh các thay đổi bạn yêu cầu; không thể xác định thao tác nào đã tạo kết quả này.',
          needsRevalidation: false,
        );
        return;
      }
      final server = MeetingEditValues.fromMeeting(latest.meeting);
      final reconciliation = _buildReconciliation(
        originalSnapshot: originalSnapshot,
        local: local,
        server: server,
        latestSnapshot: latest,
      );
      _state = MeetingEditingState(
        snapshot: originalSnapshot,
        values: local,
        dirtyFields: _dirtyFields(originalSnapshot.meeting, local),
        phase: MeetingEditPhase.rebaseRequired,
        reconciliation: reconciliation,
        failure: failure,
        message: unknownOutcome
            ? 'Chưa xác nhận được kết quả lưu. Đã tải phiên bản mới nhất; hãy đối chiếu trước khi tiếp tục.'
            : 'Phiên bản đã thay đổi. Hãy giải quyết khác biệt rồi xác nhận phiên bản mới.',
        needsRevalidation: false,
      );
    } catch (error) {
      if (!_owns(generation, originalSnapshot.sessionScope)) return;
      final denied =
          error is ApiFailure && (error.status == 403 || error.status == 404);
      if (denied) {
        _state = const MeetingEditingState(
          snapshot: null,
          values: null,
          dirtyFields: <MeetingEditField>{},
          phase: MeetingEditPhase.accessRevoked,
          reconciliation: null,
          failure: null,
          message: 'Quyền truy cập cuộc họp đã thay đổi.',
          needsRevalidation: false,
        );
      } else {
        _state = _copy(
          phase: MeetingEditPhase.recoveryRequired,
          failure: error,
          message: 'Không thể xác nhận phiên bản hiện tại. Thông tin đã nhập vẫn được giữ; không gửi lại thay đổi.',
        );
      }
    }
  }

  MeetingEditingState _copy({
    MeetingSnapshot? snapshot,
    MeetingEditValues? values,
    Set<MeetingEditField>? dirtyFields,
    MeetingEditPhase? phase,
    MeetingEditReconciliation? reconciliation,
    Object? failure,
    String? message,
    bool clearFailure = false,
    bool clearMessage = false,
    bool? needsRevalidation,
  }) => MeetingEditingState(
    snapshot: snapshot ?? _state.snapshot,
    values: values ?? _state.values,
    dirtyFields: dirtyFields ?? _state.dirtyFields,
    phase: phase ?? _state.phase,
    reconciliation: reconciliation ?? _state.reconciliation,
    failure: clearFailure ? null : failure ?? _state.failure,
    message: clearMessage ? null : message ?? _state.message,
    needsRevalidation: needsRevalidation ?? _state.needsRevalidation,
  );

  bool get _ownsSession =>
      !_disposed &&
      repository.api.isCurrentAuthenticatedSession(
        _originalSnapshot.sessionScope,
      );

  bool _owns(int generation, AuthenticatedSessionScope scope) =>
      !_disposed &&
      generation == _generation &&
      repository.api.isCurrentAuthenticatedSession(scope);

  void _onInvalidation() {
    if (_disposed || !_ownsSession) {
      _clearProtectedState();
      return;
    }
    if (_seenInvalidationRevision == invalidation.revision) return;
    _seenInvalidationRevision = invalidation.revision;
    final meetingId = invalidation.lastMeetingId;
    if (meetingId == null ||
        meetingId.toLowerCase() == _originalSnapshot.meeting.id.toLowerCase()) {
      _state = _copy(needsRevalidation: true);
      notifyListeners();
    }
  }

  void _onSessionChanged() {
    if (_disposed || _ownsSession) return;
    _clearProtectedState();
  }

  void _clearProtectedState() {
    _generation++;
    _state = const MeetingEditingState(
      snapshot: null,
      values: null,
      dirtyFields: <MeetingEditField>{},
      phase: MeetingEditPhase.accessRevoked,
      reconciliation: null,
      failure: null,
      message: 'Phiên đăng nhập đã thay đổi; dữ liệu cuộc họp đã bị xóa.',
      needsRevalidation: false,
    );
    notifyListeners();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _generation++;
    invalidation.removeListener(_onInvalidation);
    repository.api.sessionCoordinator.removeListener(_onSessionChanged);
    super.dispose();
  }
}

Set<MeetingEditField> _dirtyFields(Meeting original, MeetingEditValues local) {
  final dirty = <MeetingEditField>{};
  if (original.title.trim() != local.title.trim()) {
    dirty.add(MeetingEditField.title);
  }
  if (_normalizeDescription(original.description) !=
      _normalizeDescription(local.description)) {
    dirty.add(MeetingEditField.description);
  }
  if (!_sameSchedule(
    original.scheduledStartAt,
    original.scheduledEndAt,
    local.start,
    local.end,
  )) {
    dirty.add(MeetingEditField.schedule);
  }
  if (!_sameRoom(original.roomId, local.roomId)) {
    dirty.add(MeetingEditField.room);
  }
  return Set<MeetingEditField>.unmodifiable(dirty);
}

MeetingEditReconciliation _buildReconciliation({
  required MeetingSnapshot originalSnapshot,
  required MeetingEditValues local,
  required MeetingEditValues server,
  required MeetingSnapshot latestSnapshot,
}) {
  final original = MeetingEditValues.fromMeeting(originalSnapshot.meeting);
  var merged = server;
  final conflicts = <MeetingEditField>{};
  for (final field in MeetingEditField.values) {
    final localChanged = !_sameField(field, original, local);
    final serverChanged = !_sameField(field, original, server);
    if (!localChanged) continue;
    if (!serverChanged || _sameField(field, local, server)) {
      merged = merged.withField(field, local);
    } else {
      conflicts.add(field);
    }
  }
  return MeetingEditReconciliation(
    original: original,
    local: local,
    server: server,
    latestSnapshot: latestSnapshot,
    merged: merged,
    conflicts: conflicts,
    choices: const <MeetingEditField, MeetingEditFieldChoice>{},
  );
}

bool _matchesChangedValues(
  Meeting original,
  MeetingEditValues local,
  Meeting latest,
) {
  final dirty = _dirtyFields(original, local);
  final current = MeetingEditValues.fromMeeting(latest);
  return dirty.every((field) => _sameField(field, local, current));
}

bool _sameField(
  MeetingEditField field,
  MeetingEditValues first,
  MeetingEditValues second,
) => switch (field) {
  MeetingEditField.title => first.title.trim() == second.title.trim(),
  MeetingEditField.description =>
    _normalizeDescription(first.description) ==
        _normalizeDescription(second.description),
  MeetingEditField.schedule => _sameSchedule(
    first.start,
    first.end,
    second.start,
    second.end,
  ),
  MeetingEditField.room => _sameRoom(first.roomId, second.roomId),
};

bool _sameSchedule(
  DateTime? firstStart,
  DateTime? firstEnd,
  DateTime? secondStart,
  DateTime? secondEnd,
) => _sameInstant(firstStart, secondStart) && _sameInstant(firstEnd, secondEnd);

bool _sameInstant(DateTime? first, DateTime? second) =>
    first == null || second == null
    ? first == second
    : first.toUtc() == second.toUtc();

bool _sameRoom(String? first, String? second) => first == null || second == null
    ? first == second
    : first.toLowerCase() == second.toLowerCase();

String? _normalizeDescription(String? value) {
  final trimmed = value?.trim();
  return trimmed == null || trimmed.isEmpty ? null : trimmed;
}
