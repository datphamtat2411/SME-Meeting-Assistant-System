import 'package:flutter/foundation.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';

/// Session-owned staleness signal. A revision is not a mutation success event.
class ActionItemInvalidationSignal extends ChangeNotifier {
  ActionItemInvalidationSignal(this._api)
    : _scope = _api.authenticatedSessionScope {
    _api.sessionCoordinator.addListener(_sessionChanged);
  }

  final ApiClient _api;
  AuthenticatedSessionScope? _scope;
  int _revision = 0;
  String? _lastMeetingId;
  String? _lastActionItemId;
  bool _disposed = false;

  int get revision => _revision;
  String? get lastMeetingId => _lastMeetingId;
  String? get lastActionItemId => _lastActionItemId;
  AuthenticatedSessionScope? get sessionScope => _scope;
  bool get isDisposed => _disposed;

  bool invalidate({
    required AuthenticatedSessionScope sessionScope,
    String? meetingId,
    String? actionItemId,
  }) {
    if (_disposed ||
        _scope != sessionScope ||
        !_api.isCurrentAuthenticatedSession(sessionScope)) {
      return false;
    }
    _revision++;
    _lastMeetingId = meetingId;
    _lastActionItemId = actionItemId;
    notifyListeners();
    return true;
  }

  void _sessionChanged() {
    if (_disposed) return;
    final next = _api.authenticatedSessionScope;
    if (next == _scope) return;
    _scope = next;
    _revision = 0;
    _lastMeetingId = null;
    _lastActionItemId = null;
    notifyListeners();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _api.sessionCoordinator.removeListener(_sessionChanged);
    _scope = null;
    _revision = 0;
    _lastMeetingId = null;
    _lastActionItemId = null;
    super.dispose();
  }
}
