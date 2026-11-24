import 'package:flutter/foundation.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';

/// Shared, lightweight staleness signal for Meeting projections.
///
/// A revision says only that server data should be revalidated. It is not an
/// optimistic state update or confirmation for any particular screen.
class MeetingInvalidationSignal extends ChangeNotifier {
  MeetingInvalidationSignal(this._api)
    : _scope = _api.authenticatedSessionScope {
    _api.sessionCoordinator.addListener(_sessionChanged);
  }

  final ApiClient _api;
  AuthenticatedSessionScope? _scope;
  int _revision = 0;
  String? _lastMeetingId;
  bool _disposed = false;

  int get revision => _revision;
  String? get lastMeetingId => _lastMeetingId;
  AuthenticatedSessionScope? get sessionScope => _scope;
  bool get isDisposed => _disposed;

  bool get hasCurrentSession =>
      !_disposed &&
      _scope != null &&
      _api.isCurrentAuthenticatedSession(_scope!);

  /// Advances the revision only when the caller still owns the current session.
  ///
  /// Returns false for a stale session or after disposal and emits no event.
  bool invalidate({
    required AuthenticatedSessionScope sessionScope,
    String? meetingId,
  }) {
    if (_disposed ||
        _scope != sessionScope ||
        !_api.isCurrentAuthenticatedSession(sessionScope)) {
      return false;
    }
    _revision++;
    _lastMeetingId = meetingId;
    notifyListeners();
    return true;
  }

  void _sessionChanged() {
    if (_disposed) return;
    final nextScope = _api.authenticatedSessionScope;
    if (nextScope == _scope) return;
    _scope = nextScope;
    _revision = 0;
    _lastMeetingId = null;
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
    super.dispose();
  }
}
