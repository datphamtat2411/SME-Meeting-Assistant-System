import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';

import 'action_item_editing.dart';
import 'action_item_models.dart';
import 'action_item_repository.dart';

/// One admission owner shared by detail workflows in the same feature.
/// A late completion releases only its own lease.
class ActionItemMutationAdmission {
  final Map<(AuthenticatedSessionScope, String), Object> _owners = {};

  Object? acquire(AuthenticatedSessionScope scope, String id) {
    final key = (scope, id.toLowerCase());
    if (_owners.containsKey(key)) return null;
    final lease = Object();
    _owners[key] = lease;
    return lease;
  }

  void release(AuthenticatedSessionScope scope, String id, Object lease) {
    final key = (scope, id.toLowerCase());
    if (identical(_owners[key], lease)) _owners.remove(key);
  }
}

enum ActionItemLifecyclePhase {
  submitting,
  notDispatched,
  rejected,
  verifiedSuccess,
  unknown,
}

/// Historical outcome of one command, distinct from snapshot freshness.
/// Observing a target state does not prove that an uncertain write caused it.
class ActionItemLifecycleOperation {
  const ActionItemLifecycleOperation({
    required this.command,
    required this.reviewedVersion,
    required this.phase,
    this.failure,
    this.observedStatus,
  });

  final ActionItemCommand command;
  final int reviewedVersion;
  final ActionItemLifecyclePhase phase;
  final ActionItemFailure? failure;
  final ActionItemStatus? observedStatus;

  ActionItemLifecycleOperation observed(ActionItemStatus status) =>
      ActionItemLifecycleOperation(
        command: command,
        reviewedVersion: reviewedVersion,
        phase: phase,
        failure: failure,
        observedStatus: status,
      );
}

class ActionItemDetailController extends ChangeNotifier {
  ActionItemDetailController({
    required this.repository,
    required this.admission,
    required this.itemId,
    String? expectedMeetingId,
    this.hostIsCurrent,
  }) : _scope = repository.captureSession() {
    requireActionItemUuid(itemId, 'actionItemId');
    if (expectedMeetingId != null) {
      requireActionItemUuid(expectedMeetingId, 'meetingId');
      _meetingId = expectedMeetingId;
    }
    _revision = repository.invalidation.revision;
    repository.invalidation.addListener(_onInvalidation);
    repository.api.sessionCoordinator.addListener(_sessionChanged);
  }

  final ActionItemRepository repository;
  final ActionItemMutationAdmission admission;
  final String itemId;
  final bool Function()? hostIsCurrent;
  final AuthenticatedSessionScope _scope;

  ActionItemSnapshot? _snapshot;
  String? _meetingId;
  ActionItemSnapshot? _baseline;
  ActionItemDraft? _draft;
  ActionItemReconciliation? _reconciliation;
  Object? _error;
  ActionItemLifecycleOperation? _lifecycleOperation;
  bool _busy = false;
  bool _unresolved = false;
  bool _requiresRevalidation = true;
  bool _mergeRequired = false;
  bool _dirty = false;
  bool _disposed = false;
  bool _expiredSession = false;
  late int _revision;

  ActionItemSnapshot? get snapshot => _snapshot;
  ActionItemDraft? get draft => _draft;
  ActionItemReconciliation? get reconciliation => _reconciliation;
  Object? get error => _error;
  ActionItemLifecycleOperation? get lifecycleOperation => _lifecycleOperation;
  bool get busy => _busy;
  bool get unresolved => _unresolved;
  bool get revalidationRequired => _requiresRevalidation || _dirty;
  bool get canUseSnapshot =>
      current && !_busy && !revalidationRequired && _snapshot != null;
  bool get editing => _baseline != null || _reconciliation != null;

  bool canExecuteCommand(
    ActionItemCommand command,
    ActionItemSnapshot reviewed,
  ) =>
      canUseSnapshot &&
      !_unresolved &&
      !editing &&
      identical(_snapshot, reviewed) &&
      reviewed.item.capabilities.allows(command);

  bool get current =>
      !_disposed &&
      !_expiredSession &&
      (hostIsCurrent?.call() ?? true) &&
      repository.api.isCurrentAuthenticatedSession(_scope);
  bool get hasChanges {
    final original = _baseline;
    final draft = _draft;
    final originalValues =
        _reconciliation?.originalValues ??
        (original == null ? null : ActionItemDraft.fromResource(original.item));
    return originalValues != null &&
        draft != null &&
        draft.changesFrom(originalValues).isNotEmpty;
  }

  Future<void> refresh() async {
    if (!current) return;
    if (_busy) {
      _dirty = true;
      return;
    }
    _busy = true;
    _requiresRevalidation = true;
    _dirty = false;
    notifyListeners();
    try {
      await _loadLatest();
    } finally {
      _finish();
    }
  }

  void beginEdit({ActionItemSnapshot? reviewed}) {
    final currentSnapshot = _snapshot;
    if (!canUseSnapshot ||
        _unresolved ||
        editing ||
        currentSnapshot == null ||
        (reviewed != null && !identical(currentSnapshot, reviewed)) ||
        (!currentSnapshot.item.capabilities.canEdit &&
            !currentSnapshot.item.capabilities.canAssign)) {
      return;
    }
    _lifecycleOperation = null;
    _baseline = currentSnapshot;
    _draft = ActionItemDraft.fromResource(currentSnapshot.item);
    _error = null;
    notifyListeners();
  }

  void setDraft(ActionItemDraft value) {
    if (!canUseSnapshot || !editing || _reconciliation != null || _unresolved) {
      return;
    }
    _draft = value;
    notifyListeners();
  }

  void discardEdit({bool acknowledgeUnresolved = false}) {
    if (!current || _busy || (_unresolved && !acknowledgeUnresolved)) return;
    _clearEdit();
    if (!_unresolved) _error = null;
    notifyListeners();
  }

  void acceptReconciliation(
    Map<ActionItemEditField, ActionItemMergeChoice> choices,
  ) {
    final merge = _reconciliation;
    if (!canUseSnapshot ||
        merge == null ||
        !identical(_snapshot, merge.latest)) {
      return;
    }
    final resolved = merge.resolve(choices);
    // Validate permitted remaining fields before adopting the new baseline.
    resolved.patchAgainst(merge.latest.item);
    _baseline = merge.latest;
    _draft = resolved;
    _reconciliation = null;
    _unresolved = false;
    _error = null;
    notifyListeners();
  }

  Future<bool> save() async {
    final original = _baseline;
    final local = _draft;
    if (!canUseSnapshot ||
        _unresolved ||
        _reconciliation != null ||
        original == null ||
        local == null) {
      return false;
    }
    ActionItemPatch? patch;
    try {
      patch = local.patchAgainst(original.item);
    } catch (error) {
      _error = error;
      notifyListeners();
      return false;
    }
    if (patch == null) return false;
    final intendedPatch = patch;
    return _mutate(
      () => repository.update(original, intendedPatch),
      contentEdit: true,
    );
  }

  Future<bool> command(
    ActionItemCommand command, {
    required ActionItemSnapshot reviewed,
  }) async {
    if (!canExecuteCommand(command, reviewed)) return false;
    return _mutate(
      () => repository.command(reviewed, command),
      contentEdit: false,
      lifecycle: ActionItemLifecycleOperation(
        command: command,
        reviewedVersion: reviewed.item.version,
        phase: ActionItemLifecyclePhase.submitting,
      ),
    );
  }

  Future<bool> _mutate(
    Future<ActionItemSnapshot> Function() operation, {
    required bool contentEdit,
    ActionItemLifecycleOperation? lifecycle,
  }) async {
    final lease = admission.acquire(_scope, itemId);
    if (lease == null) {
      _error = StateError('Another mutation is in progress.');
      if (lifecycle != null) {
        _lifecycleOperation = ActionItemLifecycleOperation(
          command: lifecycle.command,
          reviewedVersion: lifecycle.reviewedVersion,
          phase: ActionItemLifecyclePhase.notDispatched,
        );
      }
      notifyListeners();
      return false;
    }
    final signal = repository.invalidation;
    final revisionBefore = signal.revision;
    final wasDirty = _dirty;
    _busy = true;
    _error = null;
    _lifecycleOperation = lifecycle;
    notifyListeners();
    try {
      if (!current) return false;
      if (revalidationRequired) {
        if (lifecycle != null) {
          _lifecycleOperation = ActionItemLifecycleOperation(
            command: lifecycle.command,
            reviewedVersion: lifecycle.reviewedVersion,
            phase: ActionItemLifecyclePhase.notDispatched,
          );
        }
        return false;
      }
      final result = await operation();
      if (!current) return false;
      _snapshot = result;
      // The verified response already represents our own mutation. A later
      // or additional invalidation still requires a read.
      if (!wasDirty &&
          signal.revision == revisionBefore + 1 &&
          signal.lastActionItemId != null &&
          sameActionItemIdentity(signal.lastActionItemId!, itemId)) {
        _dirty = false;
        _requiresRevalidation = false;
      }
      _clearEdit();
      _unresolved = false;
      if (lifecycle != null) {
        _lifecycleOperation = ActionItemLifecycleOperation(
          command: lifecycle.command,
          reviewedVersion: lifecycle.reviewedVersion,
          phase: ActionItemLifecyclePhase.verifiedSuccess,
          observedStatus: result.item.status,
        );
      }
      return true;
    } catch (error) {
      if (!current) return false;
      _error = error;
      final failure = error is ActionItemFailure ? error : null;
      _unresolved =
          failure == null ||
          failure.outcome == ActionItemMutationOutcome.unknown;
      if (lifecycle != null) {
        final phase = switch (failure?.outcome) {
          ActionItemMutationOutcome.notDispatched =>
            ActionItemLifecyclePhase.notDispatched,
          ActionItemMutationOutcome.rejected =>
            ActionItemLifecyclePhase.rejected,
          _ => ActionItemLifecyclePhase.unknown,
        };
        _lifecycleOperation = ActionItemLifecycleOperation(
          command: lifecycle.command,
          reviewedVersion: lifecycle.reviewedVersion,
          phase: phase,
          failure: failure,
        );
      }
      final needsRevalidation =
          _unresolved ||
          failure?.category == ActionItemFailureCategory.versionConflict ||
          failure?.category == ActionItemFailureCategory.missingPrecondition ||
          failure?.category == ActionItemFailureCategory.authentication ||
          failure?.category == ActionItemFailureCategory.authorization ||
          failure?.category == ActionItemFailureCategory.resourceUnavailable ||
          failure?.category == ActionItemFailureCategory.businessConflict ||
          (lifecycle != null &&
              failure?.category == ActionItemFailureCategory.validation);
      if (needsRevalidation) {
        _requiresRevalidation = true;
        _mergeRequired = contentEdit;
        // Consume the repository's own invalidation. Later invalidations
        // arriving during the read remain pending.
        _dirty = false;
        await _loadLatest(forceMerge: contentEdit, preserveError: true);
      }
      return false;
    } finally {
      admission.release(_scope, itemId, lease);
      _finish();
    }
  }

  Future<void> _loadLatest({
    bool forceMerge = false,
    bool preserveError = false,
  }) async {
    _requiresRevalidation = true;
    try {
      if (!current) return;
      final latest = await repository.detail(itemId, sessionScope: _scope);
      if (!current) return;
      if (_meetingId != null &&
          !sameActionItemIdentity(_meetingId!, latest.item.meetingId)) {
        _snapshot = null;
        _lifecycleOperation = null;
        _clearEdit();
        _unresolved = true;
        throw StateError('The resource meeting identity unexpectedly changed.');
      }
      _meetingId ??= latest.item.meetingId;
      final original = _baseline;
      final local = _draft;
      final previousMerge = _reconciliation;
      _snapshot = latest;
      final lifecycle = _lifecycleOperation;
      if (lifecycle != null &&
          lifecycle.phase != ActionItemLifecyclePhase.verifiedSuccess) {
        _lifecycleOperation = lifecycle.observed(latest.item.status);
      }
      if (local != null && (original != null || previousMerge != null)) {
        if (!latest.item.capabilities.canEdit &&
            !latest.item.capabilities.canAssign) {
          _clearEdit();
          _unresolved = false;
        } else if (previousMerge != null) {
          _reconciliation = previousMerge.withLatest(latest);
        } else if (original != null &&
            (forceMerge ||
                _mergeRequired ||
                _unresolved ||
                original.etag != latest.etag ||
                original.item.capabilities.canReadMeetingContext !=
                    latest.item.capabilities.canReadMeetingContext ||
                original.item.capabilities.canEdit !=
                    latest.item.capabilities.canEdit ||
                original.item.capabilities.canAssign !=
                    latest.item.capabilities.canAssign)) {
          if (hasChanges || forceMerge || _mergeRequired || _unresolved) {
            _reconciliation = ActionItemReconciliation(
              original: original,
              local: local,
              latest: latest,
            );
            _baseline = null;
          } else {
            _baseline = latest;
            _draft = ActionItemDraft.fromResource(latest.item);
          }
        }
      } else {
        // A command's uncertain result can only be described in terms of
        // the current canonical state, not as proven success of that request.
        _unresolved = false;
      }
      _mergeRequired = false;
      _requiresRevalidation = false;
      if (!preserveError && !_unresolved) _error = null;
    } catch (error) {
      if (!current) return;
      _error = error;
      if (error is ActionItemFailure &&
          (error.category == ActionItemFailureCategory.authentication ||
              error.category == ActionItemFailureCategory.authorization ||
              error.category ==
                  ActionItemFailureCategory.resourceUnavailable)) {
        _snapshot = null;
        _lifecycleOperation = null;
        _clearEdit();
        _unresolved = false;
      }
      // Failed reads leave the freshness gate closed. A definitive conflict
      // is not an unknown write outcome; the draft still needs reconciliation.
    }
  }

  void _clearEdit() {
    _baseline = null;
    _draft = null;
    _reconciliation = null;
    _mergeRequired = false;
  }

  void _finish() {
    if (!current) return;
    _busy = false;
    notifyListeners();
    if (_dirty && !_busy && current) unawaited(refresh());
  }

  void _onInvalidation() {
    if (!current) {
      _sessionChanged();
      return;
    }
    final signal = repository.invalidation;
    if (signal.revision == _revision) return;
    _revision = signal.revision;
    final affected = signal.lastActionItemId;
    if (affected != null && !sameActionItemIdentity(affected, itemId)) return;
    final meeting = signal.lastMeetingId;
    final ownedMeeting = _meetingId;
    if (affected == null &&
        meeting != null &&
        ownedMeeting != null &&
        !sameActionItemIdentity(meeting, ownedMeeting)) {
      return;
    }
    _dirty = true;
    _requiresRevalidation = true;
    if (!_busy) unawaited(refresh());
  }

  void _sessionChanged() {
    if (_disposed || _expiredSession || current) return;
    _expiredSession = true;
    _snapshot = null;
    _meetingId = null;
    _lifecycleOperation = null;
    _clearEdit();
    _error = null;
    _busy = false;
    _dirty = false;
    _requiresRevalidation = true;
    _unresolved = false;
    notifyListeners();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _snapshot = null;
    _lifecycleOperation = null;
    _clearEdit();
    repository.invalidation.removeListener(_onInvalidation);
    repository.api.sessionCoordinator.removeListener(_sessionChanged);
    super.dispose();
  }
}
