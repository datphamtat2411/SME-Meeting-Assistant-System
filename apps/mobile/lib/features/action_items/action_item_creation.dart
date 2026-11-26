import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';

import 'action_item_models.dart';
import 'action_item_repository.dart';

enum ActionItemCreationPhase { idle, checking, submitting, unresolved, rejected }

/// A session-owned logical creation attempt. It must outlive individual forms
/// but is deliberately not persisted across process or session termination.
class ActionItemCreationController extends ChangeNotifier {
  ActionItemCreationController({
    required this.repository,
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now,
       _scope = repository.captureSession() {
    repository.api.sessionCoordinator.addListener(_sessionChanged);
  }

  final ActionItemRepository repository;
  final DateTime Function() _now;
  final AuthenticatedSessionScope _scope;
  final Stopwatch _elapsed = Stopwatch();
  // Leave room for transmission and avoid retry at the server's exact cutoff.
  static const retryWindow = Duration(hours: 23, minutes: 59);

  ActionItemCreationPhase _phase = ActionItemCreationPhase.idle;
  ActionItemCreateIntent? _intent;
  DateTime? _firstDispatch;
  Object? _error;
  bool _disposed = false;
  bool _expiredSession = false;
  bool _retryExpired = false;

  ActionItemCreationPhase get phase => _phase;
  ActionItemCreateIntent? get unresolvedIntent => _intent;
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
  }) async {
    if (!current || busy || _intent != null) return null;
    if (!sameActionItemIdentity(input.meetingId, meeting.id) ||
        !sameActionItemIdentity(input.assigneeUserId, assignee.id) ||
        assignee.accountStatus != ActionItemAccountStatus.active) {
      throw ArgumentError('A verified meeting and active assignee are required.');
    }
    _phase = ActionItemCreationPhase.checking;
    _error = null;
    notifyListeners();
    try {
      if (!current) return null;
      // The contract supports exact opaque UUID lookup without reading
      // protected meeting titles or enumerating every eligible meeting.
      final page = await repository.creationMeetings(
        ActionItemCreationMeetingQuery(search: input.meetingId),
        sessionScope: _scope,
      );
      if (!current) return null;
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
      _firstDispatch = _now();
      _elapsed
        ..reset()
        ..start();
      return await _dispatch(recovering: false);
    } catch (error) {
      if (current) {
        _error = error;
        _phase = ActionItemCreationPhase.rejected;
        notifyListeners();
      }
      return null;
    }
  }

  Future<ActionItemSnapshot?> retry() {
    if (!canRetry) return Future<ActionItemSnapshot?>.value();
    return _dispatch(recovering: true);
  }

  Future<ActionItemSnapshot?> _dispatch({required bool recovering}) async {
    final intent = _intent;
    if (!current || intent == null) return null;
    _phase = ActionItemCreationPhase.submitting;
    _error = null;
    notifyListeners();
    try {
      if (!current) return null;
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
      return null;
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
    super.dispose();
  }
}

String _newKey() {
  final random = Random.secure();
  final bytes = List<int>.generate(24, (_) => random.nextInt(256));
  return 'action-item-${bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join()}';
}
