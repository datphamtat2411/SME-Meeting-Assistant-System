import 'dart:async';

import 'package:flutter/foundation.dart';

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
    _syncProcessingObservation();
  }

  final ApiClient api;
  final ResultsRepository repository;
  final String meetingId;
  final Meeting meeting;
  ResultsCapabilities _capabilities;
  bool _accessDenied = false;
  ResultsCapabilities get capabilities => _accessDenied || !ownsSession
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
  ResultsProcessingBridge? _processingBridge;
  bool _disposed = false;
  final ResultsMutationCoordinator _mutations = ResultsMutationCoordinator();
  int get reviewEpoch => _mutations.epoch;
  bool get regenerationUncertain => _mutations.regenerationUncertain;
  bool get decisionOutcomeUnknown => _mutations.decisionOutcomeUnknown;
  String? draft(String key) => capabilities.canMutate ? _mutations.draft(key) : null;
  void keepDraft(String key, String text, int epoch) {
    if (ownsReview(epoch)) _mutations.keepDraft(key, text);
  }
  void clearDraft(String key, int epoch) {
    if (ownsReview(epoch)) _mutations.clearDraft(key);
  }
  bool mutationBusy(ResultsMutationGroup group) => _mutations.busy(group);
  String? get acceptedRegenerationJobId => _mutations.acceptedRegenerationJobId;
  bool ownsReview(int epoch) => capabilities.canMutate && epoch == reviewEpoch;

  bool get ownsSession =>
      !_disposed && api.isCurrentAuthenticatedSession(sessionScope);

  void _syncProcessingObservation() {
    if (!capabilities.canRead) {
      _processingBridge?.dispose();
      _processingBridge = null;
    } else if (processingManager != null && _processingBridge == null) {
      _processingBridge = ResultsProcessingBridge(
        manager: processingManager!,
        invalidation: invalidation,
        api: api,
        meetingId: meetingId,
        scope: sessionScope,
      );
    }
  }

  void _clearProtectedState() {
    _mutations.invalidate();
    for (final kind in ResultsResourceKind.values) {
      _generations[kind] = (_generations[kind] ?? 0) + 1;
      _dirty.add(kind);
    }
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
    final changed = next.canRead != _capabilities.canRead ||
        next.canMutate != _capabilities.canMutate;
    if (!changed) return;
    final newlyGranted = !_capabilities.canRead && next.canRead;
    if (_capabilities.canMutate && !next.canMutate) _mutations.invalidate();
    _capabilities = next;
    if (newlyGranted) _accessDenied = false;
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
    if (!ownsSession || !_accessDenied) return;
    final epoch = reviewEpoch;
    try {
      final allowed = await repository.verifyReadAccess(
        sessionScope: sessionScope, meetingId: meetingId,
      );
      if (!ownsSession || reviewEpoch != epoch || !allowed) return;
      _accessDenied = false;
      _syncProcessingObservation();
      notifyListeners();
      if (capabilities.canRead) {
        await Future.wait(_active.toList().map(_reload));
      }
    } catch (_) {
      // Do not restore protected data on an inconclusive access check.
    }
  }

  void setActiveResources(Set<ResultsResourceKind> kinds) {
    _active
      ..clear()
      ..addAll(kinds);
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
        stillAuthorized: () => _ownsGeneration(ResultsResourceKind.speakers, generation),
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
    if (force && _accessDenied) return retryAccess();
    if (!ownsSession || !capabilities.canRead) {
      write(
        ResultsResource<T>(
          phase: ResultsResourcePhase.forbidden,
          generation: _generations[kind] ?? 0,
        ),
      );
      notifyListeners();
      return Future<void>.value();
    }
    final currentRequest = _requests[kind];
    if (currentRequest != null) return currentRequest;
    final generation = _generations[kind] ?? 0;
    final current = read();
    if (!force && !_dirty.contains(kind) &&
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
    unawaited(Future<T>.sync(() {
      if (!_ownsGeneration(kind, generation)) {
        throw const ApiFailure(403, 'RESULTS_ACCESS_CHANGED', 'Quyền truy cập đã thay đổi.');
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
              // Never retain a cached representation of a resource that the
              // server no longer exposes, even during membership revalidation.
              write(ResultsResource<T>(
                phase: ResultsResourcePhase.loading,
                generation: generation,
              ));
              notifyListeners();
              bool allowed;
              try {
                allowed = await repository.verifyReadAccess(
                  sessionScope: sessionScope, meetingId: meetingId,
                );
              } catch (_) {
                allowed = false;
              }
              if (!_ownsGeneration(kind, generation)) return;
              if (!allowed) {
                _denyAccess();
                return;
              }
              _dirty.remove(kind);
              write(ResultsResource<T>(
                phase: ResultsResourcePhase.notReady,
                failure: failure,
                generation: generation,
              ));
            } else {
              write(current.copyWith(
                phase: ResultsResourcePhase.failed,
                failure: failure,
              ));
            }
            notifyListeners();
          },
        )
        .whenComplete(() {
          completion.complete();
          if (!identical(_requests[kind], operation)) return;
          _requests.remove(kind);
          if (capabilities.canRead && _active.contains(kind) &&
              (_generations[kind] ?? 0) != generation) {
            unawaited(_reload(kind));
          }
        }));
    return operation;
  }

  bool _ownsGeneration(ResultsResourceKind kind, int generation) =>
      ownsSession && capabilities.canRead &&
      (_generations[kind] ?? 0) == generation;

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
      _generations[kind] = (_generations[kind] ?? 0) + 1;
      _dirty.add(kind);
      if (capabilities.canRead && _active.contains(kind) &&
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

  Future<void> correctSegment(SpeechSegment snapshot, String text, {required int epoch}) async {
    _requireMutation(epoch);
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

  Future<void> mapSpeaker(SpeakerReviewSnapshot snapshot, String clusterId,
      String? userId, {required int epoch}) async {
    _requireMutation(epoch);
    if (!snapshot.clusters.any((cluster) => cluster.id == clusterId)) {
      throw const ApiFailure(412, 'RESULTS_REVIEW_CHANGED',
        'Nhóm người nói không thuộc transcript đã xem.');
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

  Future<void> editSummary(ResultsSummary snapshot, String content, {required int epoch}) async {
    _requireMutation(epoch);
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
    SummaryVersion version, {required int epoch}
  ) async {
    _requireMutation(epoch);
    if (version.isStale || version.isCurrent) {
      throw const ApiFailure(409, 'SUMMARY_VERSION_NOT_ACTIVATABLE',
        'Không thể kích hoạt phiên bản này.');
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
      throw const ApiFailure(409, 'RESULTS_OUTCOME_UNKNOWN',
        'Kiểm tra quyết định trước đó trước khi tạo quyết định mới.');
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
            sessionScope: sessionScope, meetingId: meetingId,
            idempotencyKey: key,
          );
          if (ownsReview(epoch)) _mutations.recordAdmission(jobId);
        } catch (error) {
          if (ownsReview(epoch)) _mutations.recordFailure(error);
          rethrow;
        }
      },
    );
  }

  Future<void> _reconcileAfterMutation(
    ResultsMutationGroup group,
    Set<ResultsResourceKind> resources,
    Future<Object?> Function() operation,
  ) async {
    final ticket = _mutations.begin(group);
    final epoch = reviewEpoch;
    notifyListeners();
    try {
      _requireMutation(epoch);
      await operation();
      _requireMutation(epoch);
    } on ApiFailure catch (failure) {
      if (ownsReview(epoch) && ResultsMutationCoordinator.isUncertain(failure)) {
        if (group == ResultsMutationGroup.decisions) {
          _mutations.decisionOutcomeUnknown = true;
        }
        _invalidate(resources);
        // Reconcile active canonical projections before returning an
        // ambiguous outcome. Never replay the command automatically.
        await Future.wait(resources.where(_active.contains).map(_reload));
        throw const ApiFailure(
          0, 'RESULTS_OUTCOME_UNKNOWN',
          'Chưa xác định thao tác đã được lưu hay chưa. Hãy kiểm tra kết quả trước khi thử lại.',
          remoteOutcomeAmbiguous: true,
        );
      }
      if (ownsReview(epoch) && (failure.status == 403 || failure.status == 404)) {
        bool allowed;
        try {
          allowed = await repository.verifyReadAccess(sessionScope: sessionScope, meetingId: meetingId);
        } catch (_) {
          allowed = false;
        }
        if (ownsReview(epoch) && !allowed) _denyAccess();
      }
      rethrow;
    } finally {
      _mutations.finish(group, ticket);
      if (ownsReview(epoch)) {
        _invalidate(resources);
        notifyListeners();
      }
    }
  }

  Future<bool> reconcileUnknownDecision({required int epoch}) async {
    _requireMutation(epoch);
    await loadDecisions(force: true);
    _requireMutation(epoch);
    return decisions.phase == ResultsResourcePhase.available ||
        decisions.phase == ResultsResourcePhase.empty;
  }

  void acknowledgeUnknownDecision({required int epoch}) {
    _requireMutation(epoch);
    if (decisions.phase != ResultsResourcePhase.available &&
        decisions.phase != ResultsResourcePhase.empty) {
      throw const ApiFailure(409, 'RESULTS_OUTCOME_UNKNOWN',
        'Không thể xác minh danh sách quyết định hiện tại.');
    }
    _mutations.decisionOutcomeUnknown = false;
    notifyListeners();
  }

  Future<List<SpeakerCandidate>> meetingCandidates(String query, {required int epoch}) async {
    _requireMutation(epoch);
    final candidates = await repository.meetingCandidates(
      sessionScope: sessionScope, meetingId: meetingId, query: query,
      stillAuthorized: () => ownsReview(epoch),
    );
    _requireMutation(epoch);
    return candidates;
  }

  void _requireMutation(int epoch) {
    if (!ownsSession) {
      throw const ApiFailure(
        401, 'AUTH_SESSION_CHANGED', 'Phiên đăng nhập đã thay đổi.',
      );
    }
    if (!ownsReview(epoch)) {
      throw const ApiFailure(
        403, 'RESULTS_MUTATION_FORBIDDEN',
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
