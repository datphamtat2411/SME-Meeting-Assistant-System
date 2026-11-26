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

class ActionItemDetailController extends ChangeNotifier {
  ActionItemDetailController({
    required this.repository,
    required this.admission,
    required this.itemId,
  }) : _scope = repository.captureSession() {
    requireActionItemUuid(itemId, 'actionItemId');
    _revision = repository.invalidation.revision;
    repository.invalidation.addListener(_onInvalidation);
    repository.api.sessionCoordinator.addListener(_sessionChanged);
  }

  final ActionItemRepository repository;
  final ActionItemMutationAdmission admission;
  final String itemId;
  final AuthenticatedSessionScope _scope;

  ActionItemSnapshot? _snapshot;
  ActionItemSnapshot? _baseline;
  ActionItemDraft? _draft;
  ActionItemReconciliation? _reconciliation;
  Object? _error;
  bool _busy = false;
  bool _unresolved = false;
  bool _dirty = false;
  bool _disposed = false;
  bool _expiredSession = false;
  late int _revision;

  ActionItemSnapshot? get snapshot => _snapshot;
  ActionItemDraft? get draft => _draft;
  ActionItemReconciliation? get reconciliation => _reconciliation;
  Object? get error => _error;
  bool get busy => _busy;
  bool get unresolved => _unresolved;
  bool get editing => _baseline != null;
  bool get current =>
      !_disposed &&
      !_expiredSession &&
      repository.api.isCurrentAuthenticatedSession(_scope);
  bool get hasChanges {
    final original = _baseline;
    final draft = _draft;
    return original != null &&
        draft != null &&
        draft.changesFrom(ActionItemDraft.fromResource(original.item)).isNotEmpty;
  }

  Future<void> refresh() async {
    if (!current) return;
    if (_busy) {
      _dirty = true;
      return;
    }
    _busy = true;
    _dirty = false;
    notifyListeners();
    try {
      await _loadLatest();
    } finally {
      _finish();
    }
  }

  void beginEdit() {
    final currentSnapshot = _snapshot;
    if (!current ||
        _busy ||
        _unresolved ||
        editing ||
        currentSnapshot == null ||
        (!currentSnapshot.item.capabilities.canEdit &&
            !currentSnapshot.item.capabilities.canAssign)) {
      return;
    }
    _baseline = currentSnapshot;
    _draft = ActionItemDraft.fromResource(currentSnapshot.item);
    _error = null;
    notifyListeners();
  }

  void setDraft(ActionItemDraft value) {
    if (!current || _busy || !editing || _reconciliation != null || _unresolved) {
      return;
    }
    _draft = value;
    notifyListeners();
  }

  void discardEdit({bool acknowledgeUnresolved = false}) {
    if (!current || _busy || (_unresolved && !acknowledgeUnresolved)) return;
    _clearEdit();
    _unresolved = false;
    _error = null;
    notifyListeners();
  }

  void acceptReconciliation(
    Map<ActionItemEditField, ActionItemMergeChoice> choices,
  ) {
    final merge = _reconciliation;
    if (!current || _busy || merge == null || !identical(_snapshot, merge.latest)) {
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
    if (!current ||
        _busy ||
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

  Future<bool> command(ActionItemCommand command) async {
    final original = _snapshot;
    if (!current ||
        _busy ||
        _unresolved ||
        editing ||
        original == null ||
        !original.item.capabilities.allows(command)) {
      return false;
    }
    return _mutate(
      () => repository.command(original, command),
      contentEdit: false,
    );
  }

  Future<bool> _mutate(
    Future<ActionItemSnapshot> Function() operation, {
    required bool contentEdit,
  }) async {
    final lease = admission.acquire(_scope, itemId);
    if (lease == null) return false;
    _busy = true;
    _error = null;
    notifyListeners();
    try {
      if (!current) return false;
      final result = await operation();
      if (!current) return false;
      _snapshot = result;
      _clearEdit();
      _unresolved = false;
      return true;
    } catch (error) {
      if (!current) return false;
      _error = error;
      final failure = error is ActionItemFailure ? error : null;
      _unresolved =
          failure == null || failure.outcome == ActionItemMutationOutcome.unknown;
      final needsRevalidation =
          _unresolved ||
          failure?.category == ActionItemFailureCategory.versionConflict ||
          failure?.category == ActionItemFailureCategory.authorization ||
          failure?.category == ActionItemFailureCategory.resourceUnavailable ||
          failure?.category == ActionItemFailureCategory.businessConflict;
      if (needsRevalidation) {
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
    try {
      if (!current) return;
      final latest = await repository.detail(itemId, sessionScope: _scope);
      if (!current) return;
      final original = _baseline;
      final local = _draft;
      _snapshot = latest;
      if (original != null && local != null) {
        if (!latest.item.capabilities.canEdit &&
            !latest.item.capabilities.canAssign) {
          _clearEdit();
          _unresolved = false;
        } else if (forceMerge ||
            _unresolved ||
            original.etag != latest.etag ||
            original.item.capabilities.canEdit !=
                latest.item.capabilities.canEdit ||
            original.item.capabilities.canAssign !=
                latest.item.capabilities.canAssign) {
          if (hasChanges || forceMerge || _unresolved) {
            _reconciliation = ActionItemReconciliation(
              original: original,
              local: local,
              latest: latest,
            );
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
      if (!preserveError && !_unresolved) _error = null;
    } catch (error) {
      if (!current) return;
      _error = error;
      if (error is ActionItemFailure &&
          (error.category == ActionItemFailureCategory.authentication ||
              error.category == ActionItemFailureCategory.authorization ||
              error.category == ActionItemFailureCategory.resourceUnavailable)) {
        _snapshot = null;
        _clearEdit();
        _unresolved = false;
      } else if (forceMerge) {
        // A failed conflict read must not allow a stale baseline to be reused.
        _unresolved = true;
      }
    }
  }

  void _clearEdit() {
    _baseline = null;
    _draft = null;
    _reconciliation = null;
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
    _dirty = true;
    if (!_busy) unawaited(refresh());
  }

  void _sessionChanged() {
    if (_disposed || _expiredSession || current) return;
    _expiredSession = true;
    _snapshot = null;
    _clearEdit();
    _error = null;
    _busy = false;
    _dirty = false;
    _unresolved = false;
    notifyListeners();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _snapshot = null;
    _clearEdit();
    repository.invalidation.removeListener(_onInvalidation);
    repository.api.sessionCoordinator.removeListener(_sessionChanged);
    super.dispose();
  }
}
