import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/api_client.dart';
import 'profile_models.dart';
import 'profile_repository.dart';

/// A resource-local, one-shot retry gate. Expiry only publishes availability;
/// it never dispatches a request.
class _RetryCooldown {
  Timer? _timer;
  DateTime? deadline;

  void start(Duration duration, VoidCallback onExpired) {
    clear();
    if (duration <= Duration.zero) return;
    deadline = DateTime.now().add(duration);
    _timer = Timer(duration, () {
      clear();
      onExpired();
    });
  }

  void clear() {
    _timer?.cancel();
    _timer = null;
    deadline = null;
  }
}

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
  final _cooldown = _RetryCooldown();
  Future<void>? _reading;
  bool _saving = false;
  bool _disposed = false;
  bool _invalidated = false;
  bool _needsReconciliation = false;
  bool _reconciled = false;
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
  DateTime? get retryNotBefore => current ? _cooldown.deadline : null;
  bool get canRefresh =>
      current && !loading && !saving && retryNotBefore == null;
  bool get needsReconciliation => current && _needsReconciliation;
  bool get reconciled => current && _reconciled;
  ProfileMutationOutcome? get outcome => _outcome;
  bool get _hasPendingDecision => false;
  bool get _additionalBusy => false;
  bool get _canStart =>
      current &&
      _snapshot != null &&
      !_saving &&
      !_needsReconciliation &&
      retryNotBefore == null &&
      !_additionalBusy;
  bool get canMutate => _canStart && !_hasPendingDecision;
  bool get canConfirmPending => _hasPendingDecision && _canStart && !loading;

  Future<T> _readResource();
  void _afterRead(T result) {}
  void _clearWorkflow() {}

  Future<void> refresh() {
    if (!current || _saving) return Future<void>.value();
    final existing = _reading;
    if (existing != null) return existing;
    if (retryNotBefore != null) return Future<void>.value();
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
      _reconciled = false;
      _afterRead(result);
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
    if (error.accessLost) {
      _snapshot = null;
      _cooldown.clear();
      _needsReconciliation = false;
      _reconciled = false;
      _clearWorkflow();
    } else if (error.requiresReconciliation) {
      _needsReconciliation = true;
    }
    if (error.category == ProfileFailureCategory.rateLimited) {
      final duration = error.retryAfterDuration();
      if (duration != null) {
        _cooldown.start(duration, () {
          if (current) notifyListeners();
        });
      }
    }
  }

  Future<bool> _mutate(
    Future<T> Function() send, {
    VoidCallback? onStart,
    void Function(ProfileFailure)? onFailure,
    VoidCallback? afterConfirmed,
  }) async {
    if (!_canStart) return false;
    final generation = ++_generation;
    _reading = null;
    _saving = true;
    _failure = null;
    _outcome = null;
    _reconciled = false;
    onStart?.call();
    notifyListeners();
    try {
      if (!_owns(generation)) return false;
      final result = await send();
      if (!_owns(generation)) return false;
      _snapshot = result;
      _outcome = ProfileMutationOutcome.confirmed;
      afterConfirmed?.call();
      _saving = false;
      notifyListeners();
      return current;
    } on ProfileFailure catch (error) {
      if (_owns(generation)) {
        _applyFailure(error);
        _outcome = error.outcome;
        if (!error.accessLost) onFailure?.call(error);
      }
      return false;
    } finally {
      if (_owns(generation) && _saving) {
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
    _cooldown.clear();
    _outcome = null;
    _reading = null;
    _saving = false;
    _needsReconciliation = false;
    _reconciled = false;
    _clearWorkflow();
    notifyListeners();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _generation++;
    _snapshot = null;
    _cooldown.clear();
    _clearWorkflow();
    repository.api.sessionCoordinator.removeListener(_sessionChanged);
    super.dispose();
  }
}

enum IdentitySyncStatus { idle, synchronizing, synchronized, failed }

class ProfileEditIntent {
  const ProfileEditIntent(this.original, this.name);

  final ProfileSnapshot original;
  final String name;
}

class ProfileController extends _AccountResource<ProfileSnapshot> {
  ProfileController(super.repository);

  ProfileEditIntent? _pendingEdit;
  IdentitySyncStatus _identityStatus = IdentitySyncStatus.idle;
  Future<void>? _identitySync;
  final _identityCooldown = _RetryCooldown();
  int _identityGeneration = 0;

  ProfileEditIntent? get pendingEdit => current ? _pendingEdit : null;
  IdentitySyncStatus get identityStatus =>
      current ? _identityStatus : IdentitySyncStatus.idle;
  bool get identityRefreshFailed => identityStatus == IdentitySyncStatus.failed;
  DateTime? get identityRetryNotBefore =>
      current ? _identityCooldown.deadline : null;
  bool get canRetryIdentity =>
      identityRefreshFailed &&
      snapshot != null &&
      !saving &&
      _identitySync == null &&
      identityRetryNotBefore == null;

  @override
  bool get _hasPendingDecision => _pendingEdit != null;

  @override
  bool get _additionalBusy => _identitySync != null;

  @override
  Future<ProfileSnapshot> _readResource() => repository.profile(scope);

  @override
  void _afterRead(ProfileSnapshot result) {
    final intent = _pendingEdit;
    if (intent == null || result.profile.displayName != intent.name) return;
    _pendingEdit = null;
    _reconciled = true;
    _startIdentitySynchronization();
  }

  @override
  void _clearWorkflow() {
    _pendingEdit = null;
    _identityStatus = IdentitySyncStatus.idle;
    _identityCooldown.clear();
    _identityGeneration++;
    // Keep the in-flight handle until it settles to preserve single-flight.
  }

  Future<void> retryIdentity() {
    final existing = _identitySync;
    if (existing != null) return existing;
    if (!canRetryIdentity) return Future<void>.value();
    return _synchronizeIdentity();
  }

  void _startIdentitySynchronization() {
    unawaited(_synchronizeIdentity());
  }

  Future<void> _synchronizeIdentity() {
    if (!current || snapshot == null) return Future<void>.value();
    final existing = _identitySync;
    if (existing != null) return existing;
    if (identityRetryNotBefore != null) return Future<void>.value();
    final generation = ++_identityGeneration;
    bool owns() =>
        current && snapshot != null && generation == _identityGeneration;

    _identityStatus = IdentitySyncStatus.synchronizing;
    final pending = Future<void>.microtask(() async {
      try {
        if (!owns()) return;
        await repository.api.loadIdentity(expectedScope: scope);
        if (owns()) {
          _identityStatus =
              repository.api.displayName == snapshot!.profile.displayName
              ? IdentitySyncStatus.synchronized
              : IdentitySyncStatus.failed;
          _identityCooldown.clear();
        }
      } on ApiFailure catch (error) {
        if (owns()) {
          _identityStatus = IdentitySyncStatus.failed;
          final duration = error.retryAfterDuration();
          if (duration != null) {
            _identityCooldown.start(duration, () {
              if (owns()) notifyListeners();
            });
          }
        }
      } on AuthSessionException {
        if (owns()) {
          _identityStatus = IdentitySyncStatus.failed;
        }
      } on TokenStoreException {
        if (owns()) {
          _identityStatus = IdentitySyncStatus.failed;
        }
      } on TokenStoreStateException {
        if (owns()) {
          _identityStatus = IdentitySyncStatus.failed;
        }
      } finally {
        _identitySync = null;
        if (current) notifyListeners();
      }
    });
    _identitySync = pending;
    notifyListeners();
    return pending;
  }

  Future<bool> updateName(ProfileSnapshot original, String name) async {
    final value = normalizeDisplayName(name);
    if (original.sessionScope != scope || !canMutate) return false;
    if (!isValidDisplayName(value)) {
      _failure = ProfileFailure.local(
        422,
        'PROFILE_INVALID_NAME',
        'Tên hiển thị không hợp lệ.',
      );
      notifyListeners();
      return false;
    }
    if (original.profile.displayName == value ||
        snapshot!.profile.displayName == value) {
      return true;
    }
    if (original.etag != snapshot!.etag) {
      _pendingEdit = ProfileEditIntent(original, value);
      _outcome = ProfileMutationOutcome.notDispatched;
      _reconciled = false;
      _failure = null;
      notifyListeners();
      return false;
    }
    return _sendName(original, value);
  }

  Future<bool> confirmPending(ProfileSnapshot reviewed, String name) async {
    final value = normalizeDisplayName(name);
    if (!canConfirmPending ||
        reviewed.sessionScope != scope ||
        reviewed.etag != snapshot!.etag ||
        !isValidDisplayName(value)) {
      return false;
    }
    if (snapshot!.profile.displayName == value) {
      abandonPending();
      return true;
    }
    return _sendName(reviewed, value, recovering: true);
  }

  Future<bool> _sendName(
    ProfileSnapshot original,
    String name, {
    bool recovering = false,
  }) => _mutate(
    () => repository.updateName(original, name),
    onStart: () => _pendingEdit = null,
    onFailure: (error) {
      if (error.requiresReconciliation || recovering) {
        _pendingEdit = ProfileEditIntent(original, name);
      }
    },
    afterConfirmed: _startIdentitySynchronization,
  );

  void abandonPending() {
    if (!current || saving || loading || needsReconciliation) return;
    _pendingEdit = null;
    _failure = null;
    _reconciled = false;
    notifyListeners();
  }
}

enum PreferenceField { meetingEmail, actionItemEmail, timezone, locale }

/// The named constructors keep boolean and nullable regional intents distinct.
class PreferenceIntent {
  const PreferenceIntent.meetingEmail(bool enabled)
    : field = PreferenceField.meetingEmail,
      value = enabled;
  const PreferenceIntent.actionItemEmail(bool enabled)
    : field = PreferenceField.actionItemEmail,
      value = enabled;
  const PreferenceIntent.timezone(String? timezone)
    : field = PreferenceField.timezone,
      value = timezone;
  const PreferenceIntent.locale(String? locale)
    : field = PreferenceField.locale,
      value = locale;

  final PreferenceField field;
  final Object? value;

  Object? valueIn(UserPreferences preferences) => switch (field) {
    PreferenceField.meetingEmail => preferences.meetingEmailEnabled,
    PreferenceField.actionItemEmail => preferences.actionItemEmailEnabled,
    PreferenceField.timezone => preferences.timezone,
    PreferenceField.locale => preferences.locale,
  };
}

class PreferencesController extends _AccountResource<PreferencesSnapshot> {
  PreferencesController(super.repository);

  PreferenceIntent? _pendingIntent;
  PreferenceIntent? _activeIntent;

  PreferenceIntent? get pendingIntent => current ? _pendingIntent : null;
  PreferenceIntent? get activeIntent => current ? _activeIntent : null;

  @override
  bool get _hasPendingDecision => _pendingIntent != null;

  @override
  Future<PreferencesSnapshot> _readResource() => repository.preferences(scope);

  @override
  void _afterRead(PreferencesSnapshot result) {
    final intent = _pendingIntent;
    if (intent != null && intent.valueIn(result.preferences) == intent.value) {
      _pendingIntent = null;
      _reconciled = true;
    }
  }

  @override
  void _clearWorkflow() {
    _pendingIntent = null;
    _activeIntent = null;
  }

  Future<bool> updateMeetingEmail(bool enabled) =>
      _submit(PreferenceIntent.meetingEmail(enabled));

  Future<bool> updateActionItemEmail(bool enabled) =>
      _submit(PreferenceIntent.actionItemEmail(enabled));

  Future<bool> updateTimezone(String? value) =>
      _submit(PreferenceIntent.timezone(value));

  Future<bool> updateLocale(String? value) =>
      _submit(PreferenceIntent.locale(value));

  Future<bool> submitRegional(
    PreferenceField field,
    String? value,
    PreferencesSnapshot original,
  ) async {
    if (original.sessionScope != scope || !canMutate) return false;
    final intent = switch (field) {
      PreferenceField.timezone => PreferenceIntent.timezone(value),
      PreferenceField.locale => PreferenceIntent.locale(value),
      _ => throw ArgumentError.value(field, 'field', 'Not a regional field'),
    };
    final observed = intent.valueIn(snapshot!.preferences);
    if (observed == intent.value) return true;
    if (observed != intent.valueIn(original.preferences)) {
      _pendingIntent = intent;
      _outcome = ProfileMutationOutcome.notDispatched;
      _reconciled = false;
      _failure = null;
      notifyListeners();
      return false;
    }
    return _submit(intent);
  }

  Future<bool> _submit(PreferenceIntent intent) async {
    if (!canMutate) return false;
    if (intent.valueIn(snapshot!.preferences) == intent.value) return true;
    return _send(intent);
  }

  Future<bool> confirmPending(Object? reviewedValue) async {
    final intent = _pendingIntent;
    if (intent == null || !canConfirmPending) return false;
    final observed = intent.valueIn(snapshot!.preferences);
    if (observed != reviewedValue) return false;
    if (observed == intent.value) {
      abandonPending();
      return true;
    }
    return _send(intent, recovering: true);
  }

  Future<bool> _send(PreferenceIntent intent, {bool recovering = false}) async {
    try {
      return await _mutate(
        () => switch (intent.field) {
          PreferenceField.meetingEmail => repository.updateMeetingEmail(
            scope,
            intent.value as bool,
          ),
          PreferenceField.actionItemEmail => repository.updateActionItemEmail(
            scope,
            intent.value as bool,
          ),
          PreferenceField.timezone => repository.updateTimezone(
            scope,
            intent.value as String?,
          ),
          PreferenceField.locale => repository.updateLocale(
            scope,
            intent.value as String?,
          ),
        },
        onStart: () {
          _pendingIntent = null;
          _activeIntent = intent;
        },
        onFailure: (error) {
          if (error.requiresReconciliation ||
              recovering &&
                  error.category != ProfileFailureCategory.validation) {
            _pendingIntent = intent;
          }
        },
      );
    } finally {
      if (identical(_activeIntent, intent) && current && !saving) {
        _activeIntent = null;
        notifyListeners();
      }
    }
  }

  void abandonPending() {
    if (!current || saving || loading || needsReconciliation) return;
    _pendingIntent = null;
    _failure = null;
    _reconciled = false;
    notifyListeners();
  }
}
