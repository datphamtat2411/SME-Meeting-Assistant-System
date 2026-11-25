import 'dart:async';
import 'dart:math';

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
    required this.capabilities,
    required this.invalidation,
    this.processingManager,
  }) : sessionScope = api.requireAuthenticatedSessionScope() {
    if (meeting.id.toLowerCase() != meetingId.toLowerCase()) {
      throw ArgumentError.value(meetingId, 'meetingId');
    }
    _seenInvalidation = invalidation.revision;
    invalidation.addListener(_onInvalidation);
    api.sessionCoordinator.addListener(_onSessionChanged);
    if (processingManager != null) {
      _processingBridge = ResultsProcessingBridge(
        manager: processingManager!,
        invalidation: invalidation,
        api: api,
        meetingId: meetingId,
        scope: sessionScope,
      );
    }
  }

  final ApiClient api;
  final ResultsRepository repository;
  final String meetingId;
  final Meeting meeting;
  ResultsCapabilities capabilities;
  final ResultsInvalidationSignal invalidation;
  final ProcessingManager? processingManager;
  final AuthenticatedSessionScope sessionScope;

  ResultsResource<Transcript> transcript = const ResultsResource<Transcript>();
  ResultsResource<List<SpeakerCluster>> speakers =
      const ResultsResource<List<SpeakerCluster>>();
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
  final Set<ResultsResourceKind> _relevant = <ResultsResourceKind>{};
  ResultsProcessingBridge? _processingBridge;
  bool _disposed = false;

  bool get ownsSession =>
      !_disposed && api.isCurrentAuthenticatedSession(sessionScope);

  void updateCapabilities(ResultsCapabilities next) {
    if (_disposed ||
        (next.canRead == capabilities.canRead &&
            next.canMutate == capabilities.canMutate)) {
      return;
    }
    capabilities = next;
    if (!next.canRead) {
      transcript = const ResultsResource<Transcript>(
        phase: ResultsResourcePhase.forbidden,
      );
      speakers = const ResultsResource<List<SpeakerCluster>>(
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
    }
    notifyListeners();
  }

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
    return _load<List<SpeakerCluster>>(
      ResultsResourceKind.speakers,
      () => repository.speakerClusters(
        sessionScope: sessionScope,
        meetingId: meetingId,
      ),
      () => speakers,
      (value) => speakers = value,
      (value) => value.isEmpty,
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
    _relevant.add(kind);
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
    write(
      current.copyWith(
        phase: current.hasData && !force
            ? ResultsResourcePhase.refreshing
            : ResultsResourcePhase.loading,
        clearFailure: true,
      ),
    );
    notifyListeners();
    final invalidationAtStart = _seenInvalidation;
    late final Future<void> operation;
    operation = request()
        .then<void>(
          (value) {
            if (!_ownsGeneration(kind, generation)) return;
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
          onError: (Object error, StackTrace stack) {
            if (!_ownsGeneration(kind, generation)) return;
            final failure = error is ApiFailure
                ? error
                : const ApiFailure(
                    0,
                    'UNEXPECTED_FAILURE',
                    'Không thể tải dữ liệu.',
                  );
            final forbidden = failure.status == 401 || failure.status == 403;
            write(
              current.copyWith(
                phase: forbidden
                    ? ResultsResourcePhase.forbidden
                    : current.hasData
                    ? ResultsResourcePhase.failed
                    : failure.status == 404
                    ? ResultsResourcePhase.notReady
                    : ResultsResourcePhase.failed,
                failure: failure,
              ),
            );
            notifyListeners();
          },
        )
        .whenComplete(() {
          if (identical(_requests[kind], operation)) _requests.remove(kind);
          if (ownsSession && _seenInvalidation > invalidationAtStart) {
            unawaited(
              _load<T>(kind, request, read, write, isEmpty, force: true),
            );
          }
        });
    _requests[kind] = operation;
    return operation;
  }

  bool _ownsGeneration(ResultsResourceKind kind, int generation) =>
      ownsSession && (_generations[kind] ?? 0) == generation;

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
      if (_relevant.contains(kind) && _requests[kind] == null) {
        switch (kind) {
          case ResultsResourceKind.transcript:
            unawaited(loadTranscript(force: true));
          case ResultsResourceKind.speakers:
            unawaited(loadSpeakers(force: true));
          case ResultsResourceKind.summary:
            unawaited(loadSummary(force: true));
          case ResultsResourceKind.summaryVersions:
            unawaited(loadSummaryVersions(force: true));
          case ResultsResourceKind.decisions:
            unawaited(loadDecisions(force: true));
          case ResultsResourceKind.minutes:
            unawaited(loadMinutes(force: true));
        }
      }
    }
  }

  void _onSessionChanged() {
    if (_disposed || ownsSession) return;
    _requests.clear();
    _processingBridge?.dispose();
    _processingBridge = null;
    transcript = const ResultsResource<Transcript>();
    speakers = const ResultsResource<List<SpeakerCluster>>();
    summary = const ResultsResource<ResultsSummary>();
    summaryVersions = const ResultsResource<PagedCollection<SummaryVersion>>();
    decisions = const ResultsResource<PagedCollection<MeetingDecision>>();
    minutes = const ResultsResource<MeetingMinutes>();
    notifyListeners();
  }

  Future<void> correctSegment(SpeechSegment snapshot, String text) async {
    _requireMutation();
    await _reconcileAfterMutation(
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

  Future<void> mapSpeaker(String clusterId, String? userId) async {
    _requireMutation();
    final current = transcript.data;
    final etag = current?.etag;
    if (current == null || etag == null || etag.isEmpty) {
      throw const ApiFailure(
        0,
        'VERSION_MISSING',
        'Không nhận được phiên bản transcript. Vui lòng tải lại.',
      );
    }
    await _reconcileAfterMutation(
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

  Future<void> editSummary(ResultsSummary snapshot, String content) async {
    _requireMutation();
    await _reconcileAfterMutation(
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
    String versionId,
  ) async {
    _requireMutation();
    await _reconcileAfterMutation(
      <ResultsResourceKind>{
        ResultsResourceKind.summary,
        ResultsResourceKind.summaryVersions,
        ResultsResourceKind.minutes,
      },
      () => repository.activateSummaryVersion(
        sessionScope: sessionScope,
        meetingId: meetingId,
        snapshot: snapshot,
        versionId: versionId,
      ),
    );
  }

  Future<void> createDecision(String content) async {
    _requireMutation();
    await _reconcileAfterMutation(
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
  }) async {
    _requireMutation();
    await _reconcileAfterMutation(
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

  Future<void> regenerateSummary() async {
    _requireMutation();
    final random = Random.secure();
    final key = List<int>.generate(
      16,
      (_) => random.nextInt(256),
    ).map((value) => value.toRadixString(16).padLeft(2, '0')).join();
    await _reconcileAfterMutation(
      <ResultsResourceKind>{
        ResultsResourceKind.summary,
        ResultsResourceKind.summaryVersions,
        ResultsResourceKind.minutes,
      },
      () => repository.regenerateSummary(
        sessionScope: sessionScope,
        meetingId: meetingId,
        idempotencyKey: key,
      ),
    );
  }

  Future<void> _reconcileAfterMutation(
    Set<ResultsResourceKind> resources,
    Future<Object?> Function() operation,
  ) async {
    try {
      await operation();
    } finally {
      if (ownsSession) {
        try {
          _invalidate(resources);
        } on Object {
          // A session transition already fences the original command. Do not
          // replace its failure with a second invalidation error.
        }
      }
    }
  }

  Future<List<Map<String, dynamic>>> meetingCandidates(String query) {
    _requireMutation();
    return repository.meetingCandidates(
      sessionScope: sessionScope,
      query: query,
    );
  }

  void _requireMutation() {
    if (!ownsSession) {
      throw const ApiFailure(
        401,
        'AUTH_SESSION_CHANGED',
        'Phiên đăng nhập đã thay đổi.',
      );
    }
    if (!capabilities.canMutate) {
      throw const ApiFailure(
        403,
        'RESULTS_MUTATION_FORBIDDEN',
        'Bạn không có quyền thay đổi kết quả.',
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
    invalidation.removeListener(_onInvalidation);
    api.sessionCoordinator.removeListener(_onSessionChanged);
    _processingBridge?.dispose();
    super.dispose();
  }
}
