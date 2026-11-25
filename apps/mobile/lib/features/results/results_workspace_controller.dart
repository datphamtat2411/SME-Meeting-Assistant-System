import 'dart:async';

import 'package:flutter/widgets.dart';

import '../../core/api_client.dart';
import '../../core/meeting_models.dart';
import '../../core/models.dart';
import '../../core/paged_collection.dart';
import '../meetings/meeting_foundation.dart';
import '../recording/processing_manager.dart';
import 'results_invalidation.dart';
import 'results_models.dart';
import 'results_repository.dart';
import 'results_mutation_coordinator.dart';

// The private capability field is intentionally updated through the reviewed
// capability boundary rather than exposing a mutable constructor field.
// ignore_for_file: prefer_initializing_formals

export 'results_mutation_coordinator.dart' show ResultsMutationGroup;

class ResultsCapabilities {
  const ResultsCapabilities({required this.canRead, required this.canMutate});

  final bool canRead;
  final bool canMutate;
}

class ResultsCapabilityPolicy {
  const ResultsCapabilityPolicy._();

  static ResultsCapabilities evaluate({
    required AuthenticatedSessionScope scope,
    required Meeting meeting,
    required MeetingCapabilities meetingCapabilities,
  }) {
    final organizer =
        scope.userId.toLowerCase() == meeting.organizerId.toLowerCase();
    final canRead = meetingCapabilities.canReadMedia;
    return ResultsCapabilities(
      canRead: canRead,
      canMutate: canRead && organizer,
    );
  }
}

/// Meeting-scoped application owner for Results. Feature panels only render
/// this state and call commands; they never coordinate transport themselves.
class ResultsWorkspaceController extends ChangeNotifier {
  ResultsWorkspaceController({
    required this.api,
    required this.repository,
    required this.meetingId,
    required this.meeting,
    required ResultsCapabilities capabilities,
    required this.invalidation,
    this.processingManager,
  }) : _capabilities = capabilities,
       sessionScope = api.requireAuthenticatedSessionScope() {
    if (meeting.id.toLowerCase() != meetingId.toLowerCase()) {
      throw ArgumentError.value(meetingId, 'meetingId');
    }
    _seenInvalidation = invalidation.revision;
    invalidation.addListener(_onInvalidation);
    api.sessionCoordinator.addListener(_onSessionChanged);
  }

  final ApiClient api;
  final ResultsRepository repository;
  final String meetingId;
  final Meeting meeting;
  ResultsCapabilities _capabilities;
  bool _accessDenied = false;
  ResultsCapabilities get capabilities =>
      _accessDenied ||
          !ownsSession ||
          _accessVerificationPending ||
          _accessVerificationFailure != null
      ? const ResultsCapabilities(canRead: false, canMutate: false)
      : _capabilities;
  final ResultsInvalidationSignal invalidation;
  final ProcessingManager? processingManager;
  final AuthenticatedSessionScope sessionScope;

  ResultsResource<Transcript> transcript = const ResultsResource<Transcript>();
  ResultsResource<SpeakerReviewSnapshot> speakers =
      const ResultsResource<SpeakerReviewSnapshot>();
  ResultsResource<ResultsSummary> summary =
      const ResultsResource<ResultsSummary>();
  ResultsResource<PagedCollection<SummaryVersion>> summaryVersions =
      const ResultsResource<PagedCollection<SummaryVersion>>();
  ResultsResource<PagedCollection<MeetingDecision>> decisions =
      const ResultsResource<PagedCollection<MeetingDecision>>();
  ResultsResource<MeetingMinutes> minutes =
      const ResultsResource<MeetingMinutes>();

  int _seenInvalidation = 0;
  final Map<ResultsResourceKind, Future<void>> _requests =
      <ResultsResourceKind, Future<void>>{};
  final Map<ResultsResourceKind, int> _generations =
      <ResultsResourceKind, int>{};
  final Set<ResultsResourceKind> _active = <ResultsResourceKind>{};
  final Set<ResultsResourceKind> _dirty = <ResultsResourceKind>{};
  final Set<ResultsResourceKind> _authorizationAbsent = <ResultsResourceKind>{};
  ResultsProcessingBridge? _processingBridge;
  bool _creatingProcessingBridge = false;
  bool _disposed = false;
  bool _accessVerificationPending = false;
  Object? _accessVerificationFailure;
  bool _authorizationRefreshRequested = false;
  final ResultsMutationCoordinator _mutations = ResultsMutationCoordinator();
  final Set<ResultsProtectedDialogRegistration> _dialogs =
      <ResultsProtectedDialogRegistration>{};
  int get reviewEpoch => _mutations.epoch;
  bool get regenerationUncertain => _mutations.regenerationUncertain;
  bool get decisionOutcomeUnknown => _mutations.decisionOutcomeUnknown;
  ResultsRecoveryDraft? recoveryDraft(String key) =>
      capabilities.canMutate ? _mutations.draft(key) : null;
  String? draftFor(
    String key, {
    required String resourceId,
    required String reviewedToken,
    required int epoch,
  }) {
    final draft = recoveryDraft(key);
    if (draft == null ||
        draft.resourceId != resourceId ||
        draft.reviewedToken != reviewedToken ||
        draft.reviewEpoch != epoch ||
        draft.sessionScope != sessionScope ||
        !identical(draft.workspaceIdentity, this) ||
        draft.meetingId.toLowerCase() != meetingId.toLowerCase()) {
      return null;
    }
    return draft.content;
  }

  void keepDraft(
    String key,
    String text,
    int epoch, {
    required String resourceId,
    required String reviewedToken,
  }) {
    if (ownsReview(epoch)) {
      _mutations.keepDraft(
        key,
        ResultsRecoveryDraft(
          resourceId: resourceId,
          reviewedToken: reviewedToken,
          content: text,
          meetingId: meetingId,
          sessionScope: sessionScope,
          reviewEpoch: epoch,
          workspaceIdentity: this,
        ),
      );
    }
  }

  void clearDraft(String key, int epoch) {
    if (ownsReview(epoch)) _mutations.clearDraft(key);
  }

  bool mutationBusy(ResultsMutationGroup group) => _mutations.busy(group);
  String? get acceptedRegenerationJobId => _mutations.acceptedRegenerationJobId;
  bool get isAuthorizationVerificationPending =>
      _accessVerificationPending || _accessVerificationFailure != null;
  Object? get authorizationVerificationFailure => _accessVerificationFailure;
  bool ownsReview(int epoch) => capabilities.canMutate && epoch == reviewEpoch;

  ResultsProtectedDialogRegistration registerProtectedDialog(int epoch) {
    final registration = ResultsProtectedDialogRegistration(this, epoch);
    if (ownsReview(epoch)) {
      _dialogs.add(registration);
    } else {
      registration.invalidate();
    }
    return registration;
  }

  void _invalidateDialogs() {
    for (final dialog in List<ResultsProtectedDialogRegistration>.of(
      _dialogs,
    )) {
      dialog.invalidate();
    }
    _dialogs.clear();
  }

  void _releaseDialog(ResultsProtectedDialogRegistration dialog) {
    _dialogs.remove(dialog);
  }

  bool get ownsSession =>
      !_disposed && api.isCurrentAuthenticatedSession(sessionScope);

  void _syncProcessingObservation() {
    final shouldObserve =
        capabilities.canRead &&
        (_active.isNotEmpty ||
            _mutations.regenerationUncertain ||
            _mutations.acceptedRegenerationJobId != null);
    if (!shouldObserve) {
      _processingBridge?.dispose();
      _processingBridge = null;
    } else if (processingManager != null &&
        _processingBridge == null &&
        !_creatingProcessingBridge) {
      _creatingProcessingBridge = true;
      try {
        _processingBridge = ResultsProcessingBridge(
          manager: processingManager!,
          invalidation: invalidation,
          api: api,
          meetingId: meetingId,
          scope: sessionScope,
          onTerminalOutcome: (jobId) {
            if (_mutations.acceptedRegenerationJobId != jobId) return;
            _mutations.completeAdmission(jobId);
            _syncProcessingObservation();
            notifyListeners();
          },
        );
      } finally {
        _creatingProcessingBridge = false;
      }
      _syncProcessingObservation();
    }
  }

  /// Activates the resources used by the visible Results section.
  ///
  /// The integration boundary calls this after the section has entered the
  /// tree. Panels only render the resulting state and never start their own
  /// initial requests.
  void activateResources(Set<ResultsResourceKind> kinds) {
    if (_disposed || !ownsSession) return;
    _active
      ..clear()
      ..addAll(kinds);
    _syncProcessingObservation();
    for (final kind in _active) {
      unawaited(_loadForActivation(kind));
    }
  }

  void deactivate() {
    if (_disposed) return;
    _active.clear();
    _syncProcessingObservation();
  }

  Future<void> _loadForActivation(ResultsResourceKind kind) async {
    if (_disposed || !ownsSession || !capabilities.canRead) return;
    await _reloadIfNeeded(kind);
  }

  Future<void> _reloadIfNeeded(ResultsResourceKind kind) async {
    switch (kind) {
      case ResultsResourceKind.transcript:
        await loadTranscript();
      case ResultsResourceKind.speakers:
        await loadSpeakers();
      case ResultsResourceKind.summary:
        await loadSummary();
      case ResultsResourceKind.summaryVersions:
        await loadSummaryVersions();
      case ResultsResourceKind.decisions:
        await loadDecisions();
      case ResultsResourceKind.minutes:
        await loadMinutes();
    }
  }

  void _clearProtectedState() {
    _invalidateDialogs();
    _mutations.invalidate();
    _accessVerificationPending = false;
    _accessVerificationFailure = null;
    _authorizationRefreshRequested = false;
    for (final kind in ResultsResourceKind.values) {
      _generations[kind] = (_generations[kind] ?? 0) + 1;
      _dirty.add(kind);
    }
    _authorizationAbsent.clear();
    _requests.clear();
    transcript = const ResultsResource<Transcript>(
      phase: ResultsResourcePhase.forbidden,
    );
    speakers = const ResultsResource<SpeakerReviewSnapshot>(
      phase: ResultsResourcePhase.forbidden,
    );
    summary = const ResultsResource<ResultsSummary>(
      phase: ResultsResourcePhase.forbidden,
    );
    summaryVersions = const ResultsResource<PagedCollection<SummaryVersion>>(
      phase: ResultsResourcePhase.forbidden,
    );
    decisions = const ResultsResource<PagedCollection<MeetingDecision>>(
      phase: ResultsResourcePhase.forbidden,
    );
    minutes = const ResultsResource<MeetingMinutes>(
      phase: ResultsResourcePhase.forbidden,
    );
    _syncProcessingObservation();
  }

  void _denyAccess() {
    _accessDenied = true;
    _clearProtectedState();
    notifyListeners();
  }

  void updateCapabilities(ResultsCapabilities next) {
    if (_disposed) return;
    final wasReadable = capabilities.canRead;
    final changed =
        next.canRead != _capabilities.canRead ||
        next.canMutate != _capabilities.canMutate;
    final restoringAccess =
        next.canRead &&
        (_accessDenied ||
            _accessVerificationPending ||
            _accessVerificationFailure != null);
    if (!changed && !restoringAccess) return;
    final newlyGranted =
        (!_capabilities.canRead && next.canRead) || restoringAccess;
    if (_capabilities.canMutate && !next.canMutate) {
      _invalidateDialogs();
      _mutations.invalidate();
    }
    _capabilities = next;
    if (newlyGranted) {
      _accessDenied = false;
      _accessVerificationPending = false;
      _accessVerificationFailure = null;
    }
    if (!capabilities.canRead) {
      _clearProtectedState();
    } else if (!wasReadable) {
      _syncProcessingObservation();
      for (final kind in _active.toList()) {
        unawaited(_reload(kind));
      }
    }
    notifyListeners();
  }

  Future<void> retryAccess() async {
    if (!ownsSession ||
        (!_accessDenied &&
            !_accessVerificationPending &&
            _accessVerificationFailure == null)) {
      return;
    }
    final epoch = reviewEpoch;
    try {
      final access = await repository.verifyAccess(
        sessionScope: sessionScope,
        meetingId: meetingId,
      );
      if (!ownsSession || reviewEpoch != epoch) return;
      if (!access.canRead) {
        _denyAccess();
        return;
      }
      _accessDenied = false;
      _accessVerificationFailure = null;
      _accessVerificationPending = false;
      _applyVerifiedCapabilities(access);
      _markResourcesForAuthorizationRefresh();
      notifyListeners();
      if (capabilities.canRead) {
        await _refreshActiveResources();
      }
    } catch (error) {
      if (!ownsSession || reviewEpoch != epoch) return;
      _accessVerificationFailure = error;
      _setAuthorizationPhase(
        ResultsResourcePhase.authorizationVerificationFailed,
      );
      notifyListeners();
    }
  }

  void _setAuthorizationPhase(ResultsResourcePhase phase) {
    transcript = transcript.copyWith(phase: phase);
    speakers = speakers.copyWith(phase: phase);
    summary = summary.copyWith(phase: phase);
    summaryVersions = summaryVersions.copyWith(phase: phase);
    decisions = decisions.copyWith(phase: phase);
    minutes = minutes.copyWith(phase: phase);
  }

  void _setResourcePhase(
    ResultsResourceKind kind,
    ResultsResourcePhase phase, {
    Object? failure,
  }) {
    switch (kind) {
      case ResultsResourceKind.transcript:
        transcript = transcript.copyWith(phase: phase, failure: failure);
      case ResultsResourceKind.speakers:
        speakers = speakers.copyWith(phase: phase, failure: failure);
      case ResultsResourceKind.summary:
        summary = summary.copyWith(phase: phase, failure: failure);
      case ResultsResourceKind.summaryVersions:
        summaryVersions = summaryVersions.copyWith(
          phase: phase,
          failure: failure,
        );
      case ResultsResourceKind.decisions:
        decisions = decisions.copyWith(phase: phase, failure: failure);
      case ResultsResourceKind.minutes:
        minutes = minutes.copyWith(phase: phase, failure: failure);
    }
  }

  void _markResourcesForAuthorizationRefresh() {
    _authorizationAbsent.clear();
    for (final kind in ResultsResourceKind.values) {
      _generations[kind] = (_generations[kind] ?? 0) + 1;
      _dirty.add(kind);
    }
    _setAuthorizationPhase(ResultsResourcePhase.uninitialized);
  }

  void _applyVerifiedCapabilities(ResultsAccessVerification access) {
    final canMutate = access.canMutate ?? _capabilities.canMutate;
    if (_capabilities.canMutate && !canMutate) {
      _invalidateDialogs();
      _mutations.invalidate();
    }
    _capabilities = ResultsCapabilities(
      canRead: access.canRead,
      canMutate: canMutate,
    );
  }

  Future<void> _refreshActiveResources() async {
    final resources = _active.toList(growable: false);
    await Future.wait(resources.map((kind) => _reload(kind)));
    _syncProcessingObservation();
  }

  void setActiveResources(Set<ResultsResourceKind> kinds) {
    activateResources(kinds);
  }

  Future<void> _reload(ResultsResourceKind kind) => switch (kind) {
    ResultsResourceKind.transcript => loadTranscript(force: true),
    ResultsResourceKind.speakers => loadSpeakers(force: true),
    ResultsResourceKind.summary => loadSummary(force: true),
    ResultsResourceKind.summaryVersions => loadSummaryVersions(force: true),
    ResultsResourceKind.decisions => loadDecisions(force: true),
    ResultsResourceKind.minutes => loadMinutes(force: true),
  };

  Future<void> loadTranscript({bool force = false}) =>
      _loadTranscript(force: force);
  Future<void> loadSpeakers({bool force = false}) =>
      _loadSpeakers(force: force);
  Future<void> loadSummary({bool force = false}) => _loadSummary(force: force);
  Future<void> loadSummaryVersions({bool force = false}) =>
      _loadSummaryVersions(force: force);
  Future<void> loadDecisions({bool force = false}) =>
      _loadDecisions(force: force);
  Future<void> loadMinutes({bool force = false}) => _loadMinutes(force: force);

  Future<void> _loadTranscript({required bool force}) {
    return _load<Transcript>(
      ResultsResourceKind.transcript,
      () => repository.currentTranscript(
        sessionScope: sessionScope,
        meetingId: meetingId,
      ),
      () => transcript,
      (value) => transcript = value,
      (value) => value.segments.isEmpty,
      force: force,
    );
  }

  Future<void> _loadSpeakers({required bool force}) {
    final generation = _generations[ResultsResourceKind.speakers] ?? 0;
    return _load<SpeakerReviewSnapshot>(
      ResultsResourceKind.speakers,
      () => repository.speakerReview(
        sessionScope: sessionScope,
        meetingId: meetingId,
        stillAuthorized: () =>
            _ownsGeneration(ResultsResourceKind.speakers, generation),
      ),
      () => speakers,
      (value) => speakers = value,
      (value) => value.clusters.isEmpty,
      force: force,
    );
  }

  Future<void> _loadSummary({required bool force}) {
    return _load<ResultsSummary>(
      ResultsResourceKind.summary,
      () => repository.currentSummary(
        sessionScope: sessionScope,
        meetingId: meetingId,
      ),
      () => summary,
      (value) => summary = value,
      (_) => false,
      force: force,
    );
  }

  Future<void> _loadSummaryVersions({required bool force}) {
    return _load<PagedCollection<SummaryVersion>>(
      ResultsResourceKind.summaryVersions,
      () => repository.summaryVersions(
        sessionScope: sessionScope,
        meetingId: meetingId,
      ),
      () => summaryVersions,
      (value) => summaryVersions = value,
      (value) => value.items.isEmpty,
      force: force,
    );
  }

  Future<void> _loadDecisions({required bool force}) {
    return _load<PagedCollection<MeetingDecision>>(
      ResultsResourceKind.decisions,
      () => repository.decisions(
        sessionScope: sessionScope,
        meetingId: meetingId,
      ),
      () => decisions,
      (value) => decisions = value,
      (value) => value.items.isEmpty,
      force: force,
    );
  }

  Future<void> _loadMinutes({required bool force}) {
    return _load<MeetingMinutes>(
      ResultsResourceKind.minutes,
      () =>
          repository.minutes(sessionScope: sessionScope, meetingId: meetingId),
      () => minutes,
      (value) => minutes = value,
      (_) => false,
      force: force,
    );
  }

  Future<void> _load<T>(
    ResultsResourceKind kind,
    Future<T> Function() request,
    ResultsResource<T> Function() read,
    void Function(ResultsResource<T>) write,
    bool Function(T) isEmpty, {
    required bool force,
  }) {
    if (_disposed) return Future<void>.value();
    final current = read();
    if (force) _authorizationAbsent.remove(kind);
    if (force && _accessDenied) return retryAccess();
    if (!ownsSession || !capabilities.canRead) {
      final phase = _accessVerificationPending
          ? ResultsResourcePhase.verifyingAuthorization
          : _accessVerificationFailure != null
          ? ResultsResourcePhase.authorizationVerificationFailed
          : ResultsResourcePhase.forbidden;
      write(
        ResultsResource<T>(
          phase: phase,
          data: phase == ResultsResourcePhase.forbidden ? null : current.data,
          generation: _generations[kind] ?? 0,
        ),
      );
      if (phase == ResultsResourcePhase.forbidden ||
          phase == ResultsResourcePhase.authorizationVerificationFailed) {
        notifyListeners();
      }
      return Future<void>.value();
    }
    final currentRequest = _requests[kind];
    if (currentRequest != null) return currentRequest;
    final generation = _generations[kind] ?? 0;
    if (!force &&
        !_dirty.contains(kind) &&
        (current.phase == ResultsResourcePhase.available ||
            current.phase == ResultsResourcePhase.empty ||
            current.phase == ResultsResourcePhase.notReady)) {
      return Future<void>.value();
    }
    final completion = Completer<void>();
    final operation = completion.future;
    _requests[kind] = operation;
    write(
      current.copyWith(
        phase: current.hasData
            ? ResultsResourcePhase.refreshing
            : ResultsResourcePhase.loading,
        clearFailure: true,
      ),
    );
    notifyListeners();
    unawaited(
      Future<T>.sync(() {
            if (!_ownsGeneration(kind, generation)) {
              throw const ApiFailure(
                403,
                'RESULTS_ACCESS_CHANGED',
                'Quyền truy cập đã thay đổi.',
              );
            }
            return request();
          })
          .then<void>(
            (value) {
              if (!_ownsGeneration(kind, generation)) return;
              _dirty.remove(kind);
              write(
                ResultsResource<T>(
                  phase: isEmpty(value)
                      ? ResultsResourcePhase.empty
                      : ResultsResourcePhase.available,
                  data: value,
                  generation: generation,
                ),
              );
              notifyListeners();
            },
            onError: (Object error, StackTrace stack) async {
              if (!_ownsGeneration(kind, generation)) return;
              final failure = error is ApiFailure
                  ? error
                  : const ApiFailure(
                      0,
                      'UNEXPECTED_FAILURE',
                      'Không thể tải dữ liệu.',
                    );
              if (failure.status == 401 || failure.status == 403) {
                _denyAccess();
                return;
              }
              if (failure.status == 404) {
                // A concealed 404 is ambiguous. Remove this representation and
                // suspend every protected Results surface until canonical
                // meeting/membership access has been verified.
                write(
                  ResultsResource<T>(
                    phase: ResultsResourcePhase.verifyingAuthorization,
                    generation: generation,
                  ),
                );
                _accessVerificationPending = true;
                _accessVerificationFailure = null;
                _setAuthorizationPhase(
                  ResultsResourcePhase.verifyingAuthorization,
                );
                notifyListeners();
                await _verifyAuthorizationAfterProtectedFailure(
                  kind: kind,
                  generation: generation,
                  failure: failure,
                );
                return;
              } else {
                write(
                  current.copyWith(
                    phase: ResultsResourcePhase.failed,
                    failure: failure,
                  ),
                );
              }
              notifyListeners();
            },
          )
          .whenComplete(() {
            completion.complete();
            if (!identical(_requests[kind], operation)) return;
            _requests.remove(kind);
            if (_authorizationRefreshRequested) {
              _authorizationRefreshRequested = false;
              for (final activeKind in _active) {
                if (_requests[activeKind] == null &&
                    !_authorizationAbsent.contains(activeKind)) {
                  unawaited(_reload(activeKind));
                }
              }
            }
            if (capabilities.canRead &&
                _active.contains(kind) &&
                !_authorizationAbsent.contains(kind) &&
                (_generations[kind] ?? 0) != generation) {
              unawaited(_reload(kind));
            }
          }),
    );
    return operation;
  }

  Future<void> _verifyAuthorizationAfterProtectedFailure({
    required ResultsResourceKind kind,
    required int generation,
    required ApiFailure failure,
  }) async {
    ResultsAccessVerification access;
    try {
      access = await repository.verifyAccess(
        sessionScope: sessionScope,
        meetingId: meetingId,
      );
    } catch (error) {
      if (!_ownsAuthorizationCheck(kind, generation)) return;
      _accessVerificationPending = false;
      _accessVerificationFailure = error;
      _setAuthorizationPhase(
        ResultsResourcePhase.authorizationVerificationFailed,
      );
      notifyListeners();
      return;
    }
    if (!_ownsAuthorizationCheck(kind, generation)) return;
    if (!access.canRead) {
      _denyAccess();
      return;
    }

    // Access is now based on a fresh canonical meeting/membership check. Keep
    // all resources non-presentable until the active set has been refreshed.
    _accessDenied = false;
    _accessVerificationPending = false;
    _accessVerificationFailure = null;
    _applyVerifiedCapabilities(access);
    _markResourcesForAuthorizationRefresh();
    _authorizationAbsent.add(kind);
    _dirty.remove(kind);
    _setResourcePhase(kind, ResultsResourcePhase.notReady, failure: failure);
    _authorizationRefreshRequested = true;
    notifyListeners();
  }

  Future<void> _revalidateAuthorizationAfterMutationFailure() async {
    if (!ownsSession) return;
    _accessVerificationPending = true;
    _accessVerificationFailure = null;
    _setAuthorizationPhase(ResultsResourcePhase.verifyingAuthorization);
    notifyListeners();
    ResultsAccessVerification access;
    try {
      access = await repository.verifyAccess(
        sessionScope: sessionScope,
        meetingId: meetingId,
      );
    } catch (error) {
      if (!ownsSession) return;
      _accessVerificationPending = false;
      _accessVerificationFailure = error;
      _setAuthorizationPhase(
        ResultsResourcePhase.authorizationVerificationFailed,
      );
      notifyListeners();
      return;
    }
    if (!ownsSession) return;
    if (!access.canRead) {
      _denyAccess();
      return;
    }
    _accessDenied = false;
    _accessVerificationPending = false;
    _accessVerificationFailure = null;
    _applyVerifiedCapabilities(access);
    _markResourcesForAuthorizationRefresh();
    notifyListeners();
    await _refreshActiveResources();
  }

  bool _ownsGeneration(ResultsResourceKind kind, int generation) =>
      ownsSession &&
      capabilities.canRead &&
      (_generations[kind] ?? 0) == generation;

  bool _ownsAuthorizationCheck(ResultsResourceKind kind, int generation) =>
      ownsSession && !_accessDenied && (_generations[kind] ?? 0) == generation;

  void _onInvalidation() {
    if (_disposed || !ownsSession) return;
    if (invalidation.revision == _seenInvalidation) return;
    _seenInvalidation = invalidation.revision;
    final targetMeeting = invalidation.meetingId;
    if (targetMeeting != null &&
        targetMeeting.toLowerCase() != meetingId.toLowerCase()) {
      return;
    }
    final kinds = invalidation.resources;
    for (final kind in kinds) {
      _authorizationAbsent.remove(kind);
      _generations[kind] = (_generations[kind] ?? 0) + 1;
      _dirty.add(kind);
      if (capabilities.canRead &&
          _active.contains(kind) &&
          _requests[kind] == null) {
        unawaited(_reload(kind));
      }
    }
  }

  void _onSessionChanged() {
    if (_disposed || ownsSession) return;
    _clearProtectedState();
    notifyListeners();
  }

  Future<void> correctSegment(
    SpeechSegment snapshot,
    String text, {
    required int epoch,
  }) async {
    _requireMutation(epoch);
    _requireCurrentSegment(snapshot);
    await _reconcileAfterMutation(
      ResultsMutationGroup.transcript,
      <ResultsResourceKind>{
        ResultsResourceKind.transcript,
        ResultsResourceKind.speakers,
        ResultsResourceKind.summary,
        ResultsResourceKind.summaryVersions,
        ResultsResourceKind.decisions,
        ResultsResourceKind.minutes,
      },
      () => repository.correctSegment(
        sessionScope: sessionScope,
        meetingId: meetingId,
        snapshot: snapshot,
        text: text,
      ),
    );
  }

  Future<void> mapSpeaker(
    SpeakerReviewSnapshot snapshot,
    String clusterId,
    String? userId, {
    required int epoch,
  }) async {
    _requireMutation(epoch);
    if (!snapshot.clusters.any((cluster) => cluster.id == clusterId)) {
      throw const ApiFailure(
        412,
        'RESULTS_REVIEW_CHANGED',
        'Nhóm người nói không thuộc transcript đã xem.',
      );
    }
    final etag = snapshot.etag;
    await _reconcileAfterMutation(
      ResultsMutationGroup.transcript,
      <ResultsResourceKind>{
        ResultsResourceKind.transcript,
        ResultsResourceKind.speakers,
        ResultsResourceKind.summary,
        ResultsResourceKind.summaryVersions,
        ResultsResourceKind.decisions,
        ResultsResourceKind.minutes,
      },
      () => repository.mapSpeaker(
        sessionScope: sessionScope,
        meetingId: meetingId,
        clusterId: clusterId,
        transcriptEtag: etag,
        userId: userId,
      ),
    );
  }

  Future<void> editSummary(
    ResultsSummary snapshot,
    String content, {
    required int epoch,
  }) async {
    _requireMutation(epoch);
    _requireCurrentSummary(snapshot);
    await _reconcileAfterMutation(
      ResultsMutationGroup.summary,
      <ResultsResourceKind>{
        ResultsResourceKind.summary,
        ResultsResourceKind.summaryVersions,
        ResultsResourceKind.minutes,
      },
      () => repository.editSummary(
        sessionScope: sessionScope,
        meetingId: meetingId,
        snapshot: snapshot,
        content: content,
      ),
    );
  }

  Future<void> activateSummaryVersion(
    ResultsSummary snapshot,
    SummaryVersion version, {
    required int epoch,
  }) async {
    _requireMutation(epoch);
    if (version.isStale || version.isCurrent) {
      throw const ApiFailure(
        409,
        'SUMMARY_VERSION_NOT_ACTIVATABLE',
        'Không thể kích hoạt phiên bản này.',
      );
    }
    await _reconcileAfterMutation(
      ResultsMutationGroup.summary,
      <ResultsResourceKind>{
        ResultsResourceKind.summary,
        ResultsResourceKind.summaryVersions,
        ResultsResourceKind.minutes,
      },
      () => repository.activateSummaryVersion(
        sessionScope: sessionScope,
        meetingId: meetingId,
        snapshot: snapshot,
        versionId: version.id,
      ),
    );
  }

  Future<void> createDecision(String content, {required int epoch}) async {
    _requireMutation(epoch);
    if (_mutations.decisionOutcomeUnknown) {
      throw const ApiFailure(
        409,
        'RESULTS_OUTCOME_UNKNOWN',
        'Kiểm tra quyết định trước đó trước khi tạo quyết định mới.',
      );
    }
    await _reconcileAfterMutation(
      ResultsMutationGroup.decisions,
      <ResultsResourceKind>{
        ResultsResourceKind.decisions,
        ResultsResourceKind.minutes,
      },
      () => repository.createDecision(
        sessionScope: sessionScope,
        meetingId: meetingId,
        content: content,
      ),
      unresolvedIntent: content,
    );
  }

  Future<void> reviewDecision(
    MeetingDecision snapshot, {
    required bool confirm,
    required int epoch,
  }) async {
    _requireMutation(epoch);
    await _reconcileAfterMutation(
      ResultsMutationGroup.decisions,
      <ResultsResourceKind>{
        ResultsResourceKind.decisions,
        ResultsResourceKind.minutes,
      },
      () => repository.reviewDecision(
        sessionScope: sessionScope,
        meetingId: meetingId,
        snapshot: snapshot,
        confirm: confirm,
      ),
    );
  }

  Future<void> regenerateSummary({required int epoch}) async {
    _requireMutation(epoch);
    await _reconcileAfterMutation(
      ResultsMutationGroup.summary,
      <ResultsResourceKind>{
        ResultsResourceKind.summary,
        ResultsResourceKind.summaryVersions,
        ResultsResourceKind.minutes,
      },
      () async {
        final key = _mutations.regenerationKey();
        try {
          final jobId = await repository.regenerateSummary(
            sessionScope: sessionScope,
            meetingId: meetingId,
            idempotencyKey: key,
          );
          if (ownsReview(epoch)) _mutations.recordAdmission(jobId);
          _syncProcessingObservation();
          return jobId;
        } catch (error) {
          if (ownsReview(epoch)) {
            _mutations.recordFailure(error);
            _syncProcessingObservation();
          }
          rethrow;
        }
      },
    );
  }

  Future<void> _refreshRequiredResources(
    Set<ResultsResourceKind> resources,
  ) async {
    for (final kind in resources) {
      if (!_active.contains(kind) || !ownsSession) continue;
      final inFlight = _requests[kind];
      if (inFlight != null) await inFlight;
      if (!ownsSession || !capabilities.canRead) continue;
      if (_dirty.contains(kind)) await _reload(kind);
      // If an invalidation arrived while the refresh was in flight, await the
      // newer request too. Never treat the invalidated request as evidence.
      final newer = _requests[kind];
      if (newer != null) await newer;
    }
  }

  Future<void> _reconcileAfterMutation(
    ResultsMutationGroup group,
    Set<ResultsResourceKind> resources,
    Future<Object?> Function() operation, {
    String? unresolvedIntent,
  }) async {
    final ticket = _mutations.begin(group);
    final epoch = reviewEpoch;
    var invalidated = false;
    notifyListeners();
    try {
      _requireMutation(epoch);
      await operation();
      _requireMutation(epoch);
    } catch (error, stack) {
      if (ownsReview(epoch) && ResultsMutationCoordinator.isUncertain(error)) {
        if (group == ResultsMutationGroup.decisions) {
          _mutations.decisionOutcomeUnknown = true;
          _mutations.unknownDecisionContent = unresolvedIntent;
        }
        _invalidate(resources);
        invalidated = true;
        // Reconcile active canonical projections before returning an
        // ambiguous outcome. Never replay the command automatically.
        await _refreshRequiredResources(resources);
        throw const ApiFailure(
          0,
          'RESULTS_OUTCOME_UNKNOWN',
          'Chưa xác định thao tác đã được lưu hay chưa. Hãy kiểm tra kết quả trước khi thử lại.',
          remoteOutcomeAmbiguous: true,
        );
      }
      if (ownsReview(epoch) &&
          error is ApiFailure &&
          (error.status == 403 || error.status == 404)) {
        await _revalidateAuthorizationAfterMutationFailure();
      }
      Error.throwWithStackTrace(error, stack);
    } finally {
      _mutations.finish(group, ticket);
      if (ownsReview(epoch) && !invalidated) {
        _invalidate(resources);
        notifyListeners();
      } else if (ownsReview(epoch)) {
        notifyListeners();
      }
    }
  }

  Future<bool> reconcileUnknownDecision({required int epoch}) async {
    _requireMutation(epoch);
    await loadDecisions(force: true);
    _requireMutation(epoch);
    final firstPage = decisions.data;
    if (firstPage == null) return false;
    for (var page = 1; page < firstPage.totalPages; page++) {
      await repository.decisions(
        sessionScope: sessionScope,
        meetingId: meetingId,
        page: page,
        size: firstPage.size,
      );
      _requireMutation(epoch);
    }
    return decisions.phase == ResultsResourcePhase.available ||
        decisions.phase == ResultsResourcePhase.empty;
  }

  void acknowledgeUnknownDecision({required int epoch}) {
    _requireMutation(epoch);
    if (decisions.phase != ResultsResourcePhase.available &&
        decisions.phase != ResultsResourcePhase.empty) {
      throw const ApiFailure(
        409,
        'RESULTS_OUTCOME_UNKNOWN',
        'Không thể xác minh danh sách quyết định hiện tại.',
      );
    }
    _mutations.decisionOutcomeUnknown = false;
    _mutations.unknownDecisionContent = null;
    notifyListeners();
  }

  Future<List<SpeakerCandidate>> meetingCandidates(
    String query, {
    required int epoch,
  }) async {
    _requireMutation(epoch);
    final candidates = await repository.meetingCandidates(
      sessionScope: sessionScope,
      meetingId: meetingId,
      query: query,
      stillAuthorized: () => ownsReview(epoch),
    );
    _requireMutation(epoch);
    return candidates;
  }

  void _requireCurrentSegment(SpeechSegment snapshot) {
    final current = transcript.data;
    final segment = current?.segments
        .where((candidate) => candidate.id == snapshot.id)
        .firstOrNull;
    if (segment == null ||
        segment.etag != snapshot.etag ||
        current?.etag == null) {
      throw const ApiFailure(
        412,
        'RESULTS_REVIEW_CHANGED',
        'Transcript đã thay đổi. Vui lòng xem lại nội dung mới.',
      );
    }
  }

  void _requireCurrentSummary(ResultsSummary snapshot) {
    final current = summary.data;
    if (current == null ||
        current.id != snapshot.id ||
        current.etag != snapshot.etag) {
      throw const ApiFailure(
        412,
        'RESULTS_REVIEW_CHANGED',
        'Tóm tắt đã thay đổi. Vui lòng xem lại nội dung mới.',
      );
    }
  }

  void _requireMutation(int epoch) {
    if (!ownsSession) {
      throw const ApiFailure(
        401,
        'AUTH_SESSION_CHANGED',
        'Phiên đăng nhập đã thay đổi.',
      );
    }
    if (!ownsReview(epoch)) {
      throw const ApiFailure(
        403,
        'RESULTS_MUTATION_FORBIDDEN',
        'Quyền thay đổi kết quả đã thay đổi. Vui lòng xem xét lại.',
      );
    }
  }

  void _invalidate(Set<ResultsResourceKind> resources) {
    if (!invalidation.invalidate(
      sessionScope: sessionScope,
      meetingId: meetingId,
      resources: resources,
    )) {
      throw const ApiFailure(
        401,
        'AUTH_SESSION_CHANGED',
        'Phiên đăng nhập đã thay đổi.',
      );
    }
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _clearProtectedState();
    invalidation.removeListener(_onInvalidation);
    api.sessionCoordinator.removeListener(_onSessionChanged);
    _processingBridge?.dispose();
    super.dispose();
  }
}

/// Registration owned by one protected dialog route. It never looks up a
/// replacement workspace, so a delayed callback cannot act on a new meeting
/// or session context.
class ResultsProtectedDialogRegistration {
  ResultsProtectedDialogRegistration(this._workspace, this.epoch);

  final ResultsWorkspaceController _workspace;
  final int epoch;
  BuildContext? _context;
  ModalRoute<dynamic>? _route;
  bool _valid = true;
  bool _dismissScheduled = false;

  bool get isValid => _valid && _workspace.ownsReview(epoch);

  void attach(BuildContext context) {
    _context = context;
    _route = ModalRoute.of(context);
    if (!isValid) invalidate();
  }

  void invalidate() {
    if (!_valid) {
      _scheduleDismiss();
      return;
    }
    _valid = false;
    _scheduleDismiss();
  }

  void dispose() {
    _valid = false;
    _workspace._releaseDialog(this);
    _context = null;
    _route = null;
  }

  void _scheduleDismiss() {
    if (_dismissScheduled) return;
    _dismissScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _dismissScheduled = false;
      final context = _context;
      final route = _route;
      if (context == null ||
          route == null ||
          !route.isActive ||
          !context.mounted) {
        return;
      }
      Navigator.of(context).removeRoute(route);
    });
  }
}
