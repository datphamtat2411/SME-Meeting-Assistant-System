import 'package:flutter/foundation.dart';

import '../../core/api_client.dart';
import 'profile_models.dart';
import 'profile_repository.dart';

/// Shared only by the two account resources. A session owns each instance.
abstract class _AccountResource<T> extends ChangeNotifier {
  _AccountResource(this.repository)
    : scope = repository.api.requireAuthenticatedSessionScope() {
    repository.api.sessionCoordinator.addListener(_sessionChanged);
  }

  final ProfileRepository repository;
  final AuthenticatedSessionScope scope;
  T? _snapshot;
  ProfileFailure? _failure;
  Future<void>? _reading;
  bool _saving = false;
  bool _disposed = false;
  bool _invalidated = false;
  bool _needsReconciliation = false;
  int _generation = 0;
  ProfileMutationOutcome? _outcome;

  bool get current =>
      !_disposed &&
      !_invalidated &&
      repository.api.isCurrentAuthenticatedSession(scope);
  T? get snapshot => current ? _snapshot : null;
  ProfileFailure? get failure => _failure;
  bool get loading => current && _reading != null;
  bool get saving => current && _saving;
  bool get needsReconciliation => _needsReconciliation;
  ProfileMutationOutcome? get outcome => _outcome;
  bool get canMutate =>
      current && _snapshot != null && !_saving && !_needsReconciliation;

  Future<T> _readResource();

  Future<void> refresh() {
    if (!current || _saving) return Future<void>.value();
    final existing = _reading;
    if (existing != null) return existing;
    final generation = ++_generation;
    final pending = Future<void>.microtask(() => _read(generation));
    _reading = pending;
    _failure = null;
    notifyListeners();
    return pending;
  }

  bool _owns(int generation) => current && _generation == generation;

  Future<void> _read(int generation) async {
    try {
      if (!_owns(generation)) return;
      final result = await _readResource();
      if (!_owns(generation)) return;
      _snapshot = result;
      _failure = null;
      _needsReconciliation = false;
    } on ProfileFailure catch (error) {
      if (_owns(generation)) _applyFailure(error);
    } finally {
      if (_owns(generation)) {
        _reading = null;
        notifyListeners();
      }
    }
  }

  void _applyFailure(ProfileFailure error) {
    _failure = error;
    if (error.accessLost) _snapshot = null;
    if (error.requiresReconciliation) _needsReconciliation = true;
  }

  Future<bool> _mutate(
    Future<T> Function() send, {
    Future<void> Function()? afterConfirmed,
  }) async {
    if (!canMutate) return false;
    final generation = ++_generation;
    _reading = null;
    _saving = true;
    _failure = null;
    _outcome = null;
    notifyListeners();
    try {
      if (!_owns(generation)) return false;
      final result = await send();
      if (!_owns(generation)) return false;
      _snapshot = result;
      _outcome = ProfileMutationOutcome.confirmed;
      notifyListeners();
      if (afterConfirmed != null && _owns(generation)) {
        await afterConfirmed();
      }
      return _owns(generation);
    } on ProfileFailure catch (error) {
      if (_owns(generation)) {
        _applyFailure(error);
        _outcome = error.outcome;
      }
      return false;
    } finally {
      if (_owns(generation)) {
        _saving = false;
        notifyListeners();
      }
    }
  }

  void _sessionChanged() {
    if (_disposed ||
        _invalidated ||
        repository.api.isCurrentAuthenticatedSession(scope)) {
      return;
    }
    _invalidated = true;
    _generation++;
    _snapshot = null;
    _failure = null;
    _outcome = null;
    _reading = null;
    _saving = false;
    _needsReconciliation = false;
    notifyListeners();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _generation++;
    _snapshot = null;
    repository.api.sessionCoordinator.removeListener(_sessionChanged);
    super.dispose();
  }
}

class ProfileController extends _AccountResource<ProfileSnapshot> {
  ProfileController(super.repository);

  bool _identityRefreshFailed = false;

  bool get identityRefreshFailed => current && _identityRefreshFailed;

  @override
  Future<ProfileSnapshot> _readResource() => repository.profile(scope);

  Future<bool> updateName(ProfileSnapshot original, String name) async {
    if (original.sessionScope != scope ||
        original.etag != snapshot?.etag ||
        !canMutate) {
      return false;
    }
    if (original.profile.displayName == name) return true;
    return _mutate(
      () => repository.updateName(original, name),
      afterConfirmed: () async {
        try {
          repository.api.requireCurrentAuthenticatedSession(scope);
          await repository.api.loadIdentity();
          if (current) _identityRefreshFailed = false;
        } on ApiFailure {
          if (current) _identityRefreshFailed = true;
        } on AuthSessionException {
          if (current) _identityRefreshFailed = true;
        } on TokenStoreException {
          if (current) _identityRefreshFailed = true;
        } on TokenStoreStateException {
          if (current) _identityRefreshFailed = true;
        }
      },
    );
  }
}

class PreferencesController extends _AccountResource<PreferencesSnapshot> {
  PreferencesController(super.repository);

  @override
  Future<PreferencesSnapshot> _readResource() => repository.preferences(scope);

  Future<bool> updateMeetingEmail(bool enabled) =>
      _mutate(() => repository.updateMeetingEmail(scope, enabled));

  Future<bool> updateActionItemEmail(bool enabled) =>
      _mutate(() => repository.updateActionItemEmail(scope, enabled));

  Future<bool> updateTimezone(String? value) =>
      _mutate(() => repository.updateTimezone(scope, value));

  Future<bool> updateLocale(String? value) =>
      _mutate(() => repository.updateLocale(scope, value));
}
