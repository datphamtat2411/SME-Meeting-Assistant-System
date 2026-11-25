// The dependency holder deliberately keeps public constructor names while
// storing its collaborators privately.
// ignore_for_file: prefer_initializing_formals

import 'package:flutter/foundation.dart';

import '../../core/api_client.dart';
import '../meetings/meeting_invalidation.dart';
import '../recording/processing_manager.dart';

enum ResultsResourceKind {
  transcript,
  speakers,
  summary,
  summaryVersions,
  decisions,
  minutes,
}

/// Session- and meeting-scoped revalidation signal. It carries no protected
/// result data and is only a hint to fetch canonical state again.
class ResultsInvalidationSignal extends ChangeNotifier {
  ResultsInvalidationSignal({
    required ApiClient api,
    required MeetingInvalidationSignal meetingInvalidation,
  }) : _api = api,
       _meetingInvalidation = meetingInvalidation,
       _scope = api.authenticatedSessionScope {
    _api.addListener(_onSessionChanged);
    _meetingInvalidation.addListener(_onMeetingInvalidation);
  }

  final ApiClient _api;
  final MeetingInvalidationSignal _meetingInvalidation;
  AuthenticatedSessionScope? _scope;
  String? _meetingId;
  int _revision = 0;
  Set<ResultsResourceKind> _resources = <ResultsResourceKind>{};
  bool _disposed = false;

  AuthenticatedSessionScope? get sessionScope => _scope;
  String? get meetingId => _meetingId;
  int get revision => _revision;
  Set<ResultsResourceKind> get resources => Set.unmodifiable(_resources);

  bool invalidate({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
    Set<ResultsResourceKind> resources = const <ResultsResourceKind>{},
  }) {
    if (_disposed ||
        _scope != sessionScope ||
        !_api.isCurrentAuthenticatedSession(sessionScope)) {
      return false;
    }
    _meetingId = meetingId;
    _resources = resources.isEmpty
        ? Set<ResultsResourceKind>.from(ResultsResourceKind.values)
        : Set<ResultsResourceKind>.from(resources);
    _revision++;
    notifyListeners();
    return true;
  }

  void _onMeetingInvalidation() {
    final scope = _scope;
    final meetingId = _meetingInvalidation.lastMeetingId;
    if (scope == null || meetingId == null) return;
    invalidate(sessionScope: scope, meetingId: meetingId);
  }

  void _onSessionChanged() {
    final next = _api.authenticatedSessionScope;
    if (next == _scope) return;
    _scope = next;
    _meetingId = null;
    _resources = <ResultsResourceKind>{};
    _revision++;
    notifyListeners();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _api.removeListener(_onSessionChanged);
    _meetingInvalidation.removeListener(_onMeetingInvalidation);
    _scope = null;
    _resources = <ResultsResourceKind>{};
    super.dispose();
  }
}

/// Maps meaningful shared processing changes to Results revalidation without
/// creating another polling loop.
class ResultsProcessingBridge {
  ResultsProcessingBridge({
    required ProcessingManager manager,
    required ResultsInvalidationSignal invalidation,
    required ApiClient api,
    required String meetingId,
    required AuthenticatedSessionScope scope,
  }) : _manager = manager,
       _invalidation = invalidation,
       _api = api,
       _meetingId = meetingId,
       _scope = scope {
    _manager.addListener(_changed);
    _observation = _manager.startObserving(meetingId, scope: scope);
    _lastFingerprint = _fingerprint(_manager.stateFor(meetingId, scope: scope));
  }

  final ProcessingManager _manager;
  final ResultsInvalidationSignal _invalidation;
  final ApiClient _api;
  final String _meetingId;
  final AuthenticatedSessionScope _scope;
  late final ProcessingObservation _observation;
  String? _lastFingerprint;
  bool _disposed = false;

  void _changed() {
    if (_disposed || !_api.isCurrentAuthenticatedSession(_scope)) return;
    final next = _fingerprint(_manager.stateFor(_meetingId, scope: _scope));
    if (next == _lastFingerprint) return;
    _lastFingerprint = next;
    _invalidation.invalidate(sessionScope: _scope, meetingId: _meetingId);
  }

  String? _fingerprint(ProcessingMeetingState? state) {
    if (state == null) return null;
    return state.jobs
        .map((job) => '${job.id}:${job.status.name}:${job.jobType.wireValue}')
        .join('|');
  }

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _manager.removeListener(_changed);
    _observation.dispose();
  }
}
