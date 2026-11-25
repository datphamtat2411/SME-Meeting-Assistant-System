// The dependency holder deliberately keeps public constructor names while
// storing its collaborators privately.
// ignore_for_file: prefer_initializing_formals

import 'package:flutter/foundation.dart';

import '../../core/api_client.dart';
import '../meetings/meeting_invalidation.dart';
import '../recording/processing_manager.dart';
import '../recording/media_contracts.dart';

enum ResultsResourceKind {
  transcript,
  coverage,
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
    this.onTerminalOutcome,
    this.onJobObserved,
    Map<String, String>? seenOutcomes,
    bool publishInitial = false,
  }) : _manager = manager,
       _invalidation = invalidation,
       _api = api,
       _meetingId = meetingId,
       _scope = scope,
       _seenOutcomes = seenOutcomes ?? <String, String>{} {
    _remember(
      _manager.stateFor(meetingId, scope: scope),
      publish: publishInitial,
    );
    _manager.addListener(_changed);
    _observation = _manager.startObserving(meetingId, scope: scope);
  }

  final ProcessingManager _manager;
  final ResultsInvalidationSignal _invalidation;
  final ApiClient _api;
  final String _meetingId;
  final AuthenticatedSessionScope _scope;
  final void Function(String jobId)? onTerminalOutcome;
  final void Function(ProcessingJobRecord job)? onJobObserved;
  late final ProcessingObservation _observation;
  final Map<String, String> _seenOutcomes;
  bool _disposed = false;

  void _changed() => reconcileCurrent();

  void reconcileCurrent() {
    if (_disposed || !_api.isCurrentAuthenticatedSession(_scope)) return;
    _remember(_manager.stateFor(_meetingId, scope: _scope), publish: true);
  }

  void _remember(ProcessingMeetingState? state, {required bool publish}) {
    if (state == null || state.failure != null) return;
    final affected = <ResultsResourceKind>{};
    for (final job in state.jobs) {
      onJobObserved?.call(job);
      if (!job.status.isTerminal && !job.isWaitingForReview) continue;
      final outcome = '${job.status.wireValue}:${job.retryCount}';
      final alreadySeen = _seenOutcomes[job.id] == outcome;
      _seenOutcomes[job.id] = outcome;
      if (job.status.isTerminal) onTerminalOutcome?.call(job.id);
      if (alreadySeen) continue;
      if (job.jobType == ProcessingJobType.offlineMeetingProcessing) {
        affected.addAll(ResultsResourceKind.values);
      } else {
        // Derived jobs may publish summary, decisions, or other projections.
        // No transcript reload is needed for a derived-stage job.
        affected.addAll({
          ResultsResourceKind.summary,
          ResultsResourceKind.summaryVersions,
          ResultsResourceKind.decisions,
          ResultsResourceKind.minutes,
        });
      }
    }
    if (publish && affected.isNotEmpty) {
      _invalidation.invalidate(
        sessionScope: _scope,
        meetingId: _meetingId,
        resources: affected,
      );
    }
  }

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _manager.removeListener(_changed);
    _observation.dispose();
  }
}
