import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/api_client.dart';
import '../action_items/action_item_invalidation.dart';

/// Owns the canonical personal Dashboard read projection. Invalidations mark
/// it stale; they never adjust counts or dispatch writes.
class DashboardController extends ChangeNotifier {
  DashboardController({
    required this.api,
    required this.invalidation,
    bool active = true,
  }) : _scope = api.requireAuthenticatedSessionScope() {
    if (!active) _active = false;
    invalidation.addListener(_invalidated);
    api.sessionCoordinator.addListener(_sessionChanged);
  }

  final ApiClient api;
  final ActionItemInvalidationSignal invalidation;
  final AuthenticatedSessionScope _scope;
  bool _active = true;
  bool _dirty = true;
  bool _disposed = false;
  Future<void>? _operation;
  Map<String, dynamic>? _data;
  Object? _failure;

  bool get current => !_disposed && api.isCurrentAuthenticatedSession(_scope);
  bool get loading => current && _operation != null;
  Map<String, dynamic>? get data => current ? _data : null;
  Object? get failure => current ? _failure : null;

  void setActive(bool active) {
    if (!current || active == _active) return;
    _active = active;
    if (active && (_dirty || _data == null || _failure != null)) {
      unawaited(refresh());
    }
  }

  Future<void> refresh() {
    if (!current) return Future<void>.value();
    if (!_active) {
      _dirty = true;
      return Future<void>.value();
    }
    if (_operation != null) return _operation!;
    _dirty = false;
    _failure = null;
    final completion = Completer<void>();
    _operation = completion.future;
    notifyListeners();
    unawaited(_load(completion));
    return completion.future;
  }

  Future<void> _load(Completer<void> completion) async {
    try {
      final response = await api.get('/dashboard/me', sessionScope: _scope);
      if (!current) return;
      final data = response.objectData();
      final counts = requireJsonObject(
        data['assignedActionItems'],
        response: response,
      );
      for (final field in ['open', 'inProgress', 'done', 'overdue']) {
        final value = counts[field];
        if (value is! int || value < 0) {
          throw response.invalidDataFailure();
        }
      }
      if ((counts['overdue'] as int) >
          (counts['open'] as int) + (counts['inProgress'] as int)) {
        throw response.invalidDataFailure();
      }
      _data = Map.unmodifiable(data);
    } catch (error) {
      if (!current) return;
      _failure = error;
      if (error is ApiFailure &&
          (error.authenticationFailure ||
              error.authorizationFailure ||
              error.resourceFailure)) {
        _data = null;
      }
    } finally {
      _operation = null;
      completion.complete();
      if (current) {
        notifyListeners();
        if (_active && _dirty) unawaited(refresh());
      }
    }
  }

  void _invalidated() {
    if (!current || invalidation.sessionScope != _scope) return;
    _dirty = true;
    if (_active && _operation == null) unawaited(refresh());
  }

  void _sessionChanged() {
    if (_disposed || current) return;
    _data = null;
    _failure = null;
    _dirty = false;
    notifyListeners();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    invalidation.removeListener(_invalidated);
    api.sessionCoordinator.removeListener(_sessionChanged);
    _data = null;
    super.dispose();
  }
}
