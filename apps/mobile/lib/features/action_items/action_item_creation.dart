import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/features/meetings/participant_selection.dart';

import 'action_item_models.dart';
import 'action_item_repository.dart';

enum ActionItemCreationPhase {
  idle,
  checking,
  submitting,
  unresolved,
  rejected,
}

/// A session-owned logical creation attempt. It must outlive individual forms
/// but is deliberately not persisted across process or session termination.
class ActionItemCreationController extends ChangeNotifier {
  ActionItemCreationController({
    required this.repository,
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now,
       _scope = repository.captureSession() {
    repository.api.sessionCoordinator.addListener(_sessionChanged);
    repository.invalidation.addListener(_onInvalidation);
  }

  final ActionItemRepository repository;
  final DateTime Function() _now;
  final AuthenticatedSessionScope _scope;
  final Stopwatch _elapsed = Stopwatch();
  // Leave room for transmission and avoid retry at the server's exact cutoff.
  static const retryWindow = Duration(hours: 23, minutes: 59);

  ActionItemCreationPhase _phase = ActionItemCreationPhase.idle;
  ActionItemCreateIntent? _intent;
  ActionItemCreationMeeting? _recoveryMeeting;
  ActionItemAssignee? _recoveryAssignee;
  String? _assigneeSearchHint;
  int _contextGeneration = 0;
  DateTime? _firstDispatch;
  Object? _error;
  bool _disposed = false;
  bool _expiredSession = false;
  bool _retryExpired = false;

  ActionItemCreationPhase get phase => _phase;
  ActionItemCreateIntent? get unresolvedIntent => _intent;
  ActionItemCreationMeeting? get recoveryMeeting => _recoveryMeeting;
  ActionItemAssignee? get recoveryAssignee => _recoveryAssignee;
  Object? get error => _error;
  bool get busy =>
      _phase == ActionItemCreationPhase.checking ||
      _phase == ActionItemCreationPhase.submitting;
  bool get current =>
      !_disposed &&
      !_expiredSession &&
      repository.api.isCurrentAuthenticatedSession(_scope);

  bool get canRetry {
    final first = _firstDispatch;
    if (!current ||
        _phase != ActionItemCreationPhase.unresolved ||
        _intent == null ||
        first == null) {
      return false;
    }
    final wallElapsed = _now().difference(first);
    if (wallElapsed.isNegative ||
        wallElapsed >= retryWindow ||
        _elapsed.elapsed >= retryWindow) {
      _retryExpired = true;
    }
    return !_retryExpired;
  }

  Future<ActionItemSnapshot?> submit({
    required ActionItemCreateInput input,
    required ActionItemCreationMeeting meeting,
    required ActionItemAssignee assignee,
    bool Function()? stillAllowed,
  }) async {
    if (!current || busy || _intent != null || !(stillAllowed?.call() ?? true)) {
      return null;
    }
    if (!sameActionItemIdentity(input.meetingId, meeting.id) ||
        !sameActionItemIdentity(input.assigneeUserId, assignee.id) ||
        assignee.accountStatus != ActionItemAccountStatus.active) {
      throw ArgumentError(
        'A verified meeting and active assignee are required.',
      );
    }
    _phase = ActionItemCreationPhase.checking;
    _error = null;
    notifyListeners();
    try {
      if (!current) return null;
      if (!(stillAllowed?.call() ?? true)) {
        _phase = ActionItemCreationPhase.idle;
        notifyListeners();
        return null;
      }
      // The contract supports exact opaque UUID lookup without reading
      // protected meeting titles or enumerating every eligible meeting.
      final page = await repository.creationMeetings(
        ActionItemCreationMeetingQuery(search: input.meetingId),
        sessionScope: _scope,
      );
      if (!current) return null;
      if (!(stillAllowed?.call() ?? true)) {
        _phase = ActionItemCreationPhase.idle;
        notifyListeners();
        return null;
      }
      if (!page.items.any(
        (candidate) => sameActionItemIdentity(candidate.id, input.meetingId),
      )) {
        throw const ApiFailure(
          403,
          'ACTION_ITEM_MEETING_INELIGIBLE',
          'The selected meeting is no longer eligible for creation.',
        );
      }
      _intent = ActionItemCreateIntent(
        input: input,
        idempotencyKey: _newKey(),
        sessionScope: _scope,
      );
      _assigneeSearchHint = assignee.displayName;
      _firstDispatch = _now();
      _elapsed
        ..reset()
        ..start();
      return await _dispatch(recovering: false, stillAllowed: stillAllowed);
    } catch (error) {
      if (current) {
        _error = error;
        _phase = ActionItemCreationPhase.rejected;
        notifyListeners();
      }
      return null;
    }
  }

  Future<ActionItemSnapshot?> retry({bool Function()? stillAllowed}) {
    if (!canRetry || !(stillAllowed?.call() ?? true)) {
      return Future<ActionItemSnapshot?>.value();
    }
    return _dispatch(recovering: true, stillAllowed: stillAllowed);
  }

  Future<ActionItemSnapshot?> _dispatch({
    required bool recovering,
    bool Function()? stillAllowed,
  }) async {
    final intent = _intent;
    if (!current || intent == null) return null;
    _phase = ActionItemCreationPhase.submitting;
    _clearRecoveryContext();
    _error = null;
    notifyListeners();
    try {
      if (!current) return null;
      if (!(stillAllowed?.call() ?? true)) {
        if (!recovering) _clearIntent();
        _phase = recovering
            ? ActionItemCreationPhase.unresolved
            : ActionItemCreationPhase.idle;
        notifyListeners();
        return null;
      }
      final result = await repository.create(intent);
      if (!current) return null;
      _clearIntent();
      _phase = ActionItemCreationPhase.idle;
      notifyListeners();
      return result;
    } catch (error) {
      if (!current) return null;
      _error = error;
      // A rejection of a replay cannot prove an earlier ambiguous write
      // did not commit. Only a verified representation resolves that intent.
      if (recovering ||
          error is! ActionItemFailure ||
          error.outcome == ActionItemMutationOutcome.unknown) {
        _phase = ActionItemCreationPhase.unresolved;
      } else {
        _clearIntent();
        _phase = ActionItemCreationPhase.rejected;
      }
      notifyListeners();
      if (_phase == ActionItemCreationPhase.unresolved) {
        await refreshRecoveryContext();
      }
      return null;
    }
  }

  // Labels are separate from the frozen request. Reopen or retry recovery
  // against the authorized discovery contracts, never a general user lookup.
  Future<void> refreshRecoveryContext() async {
    final intent = _intent;
    if (!current ||
        intent == null ||
        _phase != ActionItemCreationPhase.unresolved) {
      return;
    }
    _clearRecoveryContext();
    final generation = _contextGeneration;
    bool owns() =>
        current &&
        generation == _contextGeneration &&
        identical(intent, _intent) &&
        _phase == ActionItemCreationPhase.unresolved;
    notifyListeners();
    try {
      final page = await repository.creationMeetings(
        ActionItemCreationMeetingQuery(search: intent.input.meetingId),
        sessionScope: _scope,
      );
      if (!owns()) return;
      _recoveryMeeting = page.items
          .where(
            (meeting) =>
                sameActionItemIdentity(meeting.id, intent.input.meetingId),
          )
          .firstOrNull;
      notifyListeners();
    } catch (_) {
      // Unavailable display context does not resolve or replace the intent.
      // Keep the safe reference label rather than an old protected title.
    }
    if (!owns()) return;
    try {
      final assigneeId = intent.input.assigneeUserId;
      if (sameActionItemIdentity(assigneeId, _scope.userId)) {
        _recoveryAssignee = repository.selfCandidate(_scope);
      } else {
        final hint = _assigneeSearchHint?.trim();
        if (hint == null || hint.length < 2 || hint.length > 200) return;
        final page = await repository.assignmentCandidates(
          MeetingCandidateQuery(search: hint),
          sessionScope: _scope,
        );
        if (!owns()) return;
        final candidate = page.items
            .where((value) => sameActionItemIdentity(value.id, assigneeId))
            .firstOrNull;
        if (candidate != null) {
          _recoveryAssignee = ActionItemAssignee(
            id: candidate.id,
            displayName: candidate.displayName,
            accountStatus: ActionItemAccountStatus.active,
          );
        }
      }
      if (owns()) notifyListeners();
    } catch (_) {
      // Candidate discovery is best effort. The immutable assignee identity
      // remains available even if the account is no longer discoverable.
    }
  }

  void _clearRecoveryContext() {
    _contextGeneration++;
    _recoveryMeeting = null;
    _recoveryAssignee = null;
  }

  void _onInvalidation() {
    final intent = _intent;
    if (!current ||
        intent == null ||
        _phase != ActionItemCreationPhase.unresolved) {
      return;
    }
    final meetingId = repository.invalidation.lastMeetingId;
    if (meetingId == null ||
        sameActionItemIdentity(meetingId, intent.input.meetingId)) {
      unawaited(refreshRecoveryContext());
    }
  }

  void abandon({required bool acknowledged}) {
    if (!current ||
        !acknowledged ||
        _phase != ActionItemCreationPhase.unresolved) {
      return;
    }
    _clearIntent();
    _error = null;
    _phase = ActionItemCreationPhase.idle;
    notifyListeners();
  }

  void _clearIntent() {
    _intent = null;
    _clearRecoveryContext();
    _assigneeSearchHint = null;
    _firstDispatch = null;
    _retryExpired = false;
    _elapsed
      ..stop()
      ..reset();
  }

  void _sessionChanged() {
    if (_disposed || _expiredSession || current) return;
    _expiredSession = true;
    _clearIntent();
    _error = null;
    _phase = ActionItemCreationPhase.idle;
    notifyListeners();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _clearIntent();
    repository.api.sessionCoordinator.removeListener(_sessionChanged);
    repository.invalidation.removeListener(_onInvalidation);
    super.dispose();
  }
}

String _newKey() {
  final random = Random.secure();
  final bytes = List<int>.generate(24, (_) => random.nextInt(256));
  return 'action-item-${bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join()}';
}
