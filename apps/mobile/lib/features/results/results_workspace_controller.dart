import 'dart:async';

import 'package:flutter/widgets.dart';

import '../../core/api_client.dart';
import '../../core/meeting_models.dart';
import '../../core/models.dart';
import '../../core/paged_collection.dart';
import '../meetings/meeting_foundation.dart';
import '../recording/processing_manager.dart';
import '../recording/media_contracts.dart';
import '../recording/transcript_review_contract.dart';
import 'decision_review_state.dart';
import 'results_invalidation.dart';
import 'results_models.dart';
import 'results_repository.dart';
import 'results_mutation_coordinator.dart';
import 'summary_history_controller.dart';

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
class ResultsWorkspaceController extends ChangeNotifier
    implements SummaryHistoryAccess {
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
  @override
  final ResultsRepository repository;
  @override
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
  @override
  final ResultsInvalidationSignal invalidation;
  final ProcessingManager? processingManager;
  @override
  final AuthenticatedSessionScope sessionScope;

  ResultsResource<Transcript> transcript = const ResultsResource<Transcript>();
  ResultsResource<TranscriptCoverage> coverage =
      const ResultsResource<TranscriptCoverage>();
  ResultsResource<SpeakerReviewSnapshot> speakers =
      const ResultsResource<SpeakerReviewSnapshot>();
  ResultsResource<ResultsSummary> summary =
      const ResultsResource<ResultsSummary>();
  ResultsResource<PagedCollection<SummaryVersion>> summaryVersions =
      const ResultsResource<PagedCollection<SummaryVersion>>();
  ResultsResource<DecisionCollection> decisions =
      const ResultsResource<DecisionCollection>();
  String? _decisionStatus;
  String? get decisionStatus => _decisionStatus;
  Map<String, String> _meetingIdentityLabels = const {};

  String? meetingIdentityLabel(String? id) => capabilities.canRead && id != null
      ? _meetingIdentityLabels[id.toLowerCase()]
      : null;

  void updateMeetingIdentityLabels(Map<String, String> labels) {
    if (!capabilities.canRead) return;
    final next = Map<String, String>.unmodifiable(labels);
    if (next.length == _meetingIdentityLabels.length &&
        next.entries.every(
          (entry) => _meetingIdentityLabels[entry.key] == entry.value,
        )) {
      return;
    }
    _meetingIdentityLabels = next;
    notifyListeners();
  }

  ResultsResource<MeetingMinutes> minutes =
      const ResultsResource<MeetingMinutes>();

  int _seenInvalidation = 0;
  final Map<ResultsResourceKind, Future<void>> _requests =
      <ResultsResourceKind, Future<void>>{};
  final Map<ResultsResourceKind, int> _generations =
      <ResultsResourceKind, int>{};
  final Set<ResultsResourceKind> _active = <ResultsResourceKind>{};
  bool _observeActionItems = false;
  final Set<ResultsResourceKind> _dirty = <ResultsResourceKind>{};
  final Set<ResultsResourceKind> _authorizationAbsent = <ResultsResourceKind>{};
  ResultsProcessingBridge? _processingBridge;
  bool _creatingProcessingBridge = false;
  bool _disposed = false;
  bool _accessVerificationPending = false;
  Object? _accessVerificationFailure;
  Object? _authorizationTicket;
  bool _authorizationRecheckRequested = false;
  final Map<String, String> _processingOutcomes = <String, String>{};
  bool _hasObservedProcessing = false;
  bool _processingObservationGap = false;
  final ResultsMutationCoordinator _mutations = ResultsMutationCoordinator();
  SummaryHistoryController? _summaryHistory;
  SummaryHistoryController get summaryHistory =>
      _summaryHistory ??= SummaryHistoryController(this);

  @override
  bool get canReadHistory => capabilities.canRead;

  @override
  ResultsSummary? get currentSummaryForHistory =>
      capabilities.canRead && summary.hasData ? summary.data : null;
  final Set<ResultsProtectedDialogRegistration> _dialogs =
      <ResultsProtectedDialogRegistration>{};
  int get reviewEpoch => _mutations.epoch;
  int _readEpoch = 0;
  @override
  int get readEpoch => _readEpoch;
  TranscriptFocusRequest? _transcriptFocus;
  TranscriptFocusRequest? get transcriptFocus =>
      capabilities.canRead ? _transcriptFocus : null;

  bool get transcriptIsCurrent =>
      !_dirty.contains(ResultsResourceKind.transcript) &&
      (transcript.phase == ResultsResourcePhase.available ||
          transcript.phase == ResultsResourcePhase.empty);

  bool focusTranscriptSegment(TranscriptFocusRequest request) {
    final current = transcript.data;
    if (!ownsRead(request.readEpoch) ||
        !transcriptIsCurrent ||
        current == null ||
        current.id != request.transcriptId ||
        current.etag != request.transcriptEtag ||
        !current.segments.any((segment) => segment.id == request.segmentId)) {
      return false;
    }
    _transcriptFocus = request;
    notifyListeners();
    return true;
  }

  bool get regenerationUncertain => _mutations.regenerationUncertain;
  bool get decisionOutcomeUnknown => _mutations.decisionOutcomeUnknown;
  DecisionCommandIntent? get unresolvedDecision =>
      capabilities.canMutate ? _mutations.decisionReview.unresolved : null;
  ManualDecisionDraft? get manualDecisionDraft =>
      capabilities.canMutate &&
          !_mutations.decisionReview.isUnresolvedManualCreation
      ? _mutations.decisionReview.draft
      : null;
  ManualDecisionDraft? get unresolvedManualDecisionContext =>
      capabilities.canMutate &&
          _mutations.decisionReview.isUnresolvedManualCreation
      ? (_mutations.decisionReview.unresolved?.creationContext ??
            _mutations.decisionReview.draft)
      : null;

  void keepManualDecisionDraft(ManualDecisionDraft? draft, int epoch) {
    if (ownsReview(epoch)) _mutations.decisionReview.draft = draft;
  }

  DecisionReviewStamp get decisionReviewStamp => (
    _generations[ResultsResourceKind.decisions] ?? 0,
    _generations[ResultsResourceKind.transcript] ?? 0,
    _generations[ResultsResourceKind.coverage] ?? 0,
    _generations[ResultsResourceKind.speakers] ?? 0,
  );

  bool decisionReviewIsCurrent(
    MeetingDecision snapshot,
    DecisionReviewStamp stamp,
  ) =>
      capabilities.canRead &&
      decisionReviewStamp == stamp &&
      !_dirty.contains(ResultsResourceKind.decisions) &&
      decisions.phase == ResultsResourcePhase.available &&
      (decisions.data?.items.any(
            (item) => item.id == snapshot.id && item.etag == snapshot.etag,
          ) ??
          false);

  void requireDecisionReview(
    MeetingDecision snapshot,
    DecisionReviewStamp stamp,
  ) {
    if (!decisionReviewIsCurrent(snapshot, stamp)) {
      throw const ApiFailure(
        412,
        'RESULTS_REVIEW_CHANGED',
        'Quyết định hoặc nguồn đã thay đổi. Vui lòng đối chiếu lại.',
      );
    }
  }

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
    if (ownsReview(epoch)) {
      _mutations.clearDraft(key);
      notifyListeners();
    }
  }

  bool mutationBusy(ResultsMutationGroup group) => _mutations.busy(group);

  bool get canReviewProcessingTranscript =>
      capabilities.canMutate &&
      !_mutations.hasTranscriptDrafts &&
      !_mutations.busy(ResultsMutationGroup.transcript) &&
      _dialogs.isEmpty &&
      _active.contains(ResultsResourceKind.transcript);

  Future<bool> reviewProcessingTranscript(
    TranscriptReviewHandoff handoff,
    TranscriptReviewCommand command,
    TranscriptReviewProof? proof, {
    required int epoch,
  }) async {
    _requireMutation(epoch);
    final manager = processingManager;
    if (manager == null ||
        handoff.meetingId != meetingId ||
        !canReviewProcessingTranscript) {
      throw const ApiFailure(
        409,
        'REVIEW_CONTEXT_CHANGED',
        'Review the current transcript and resolve any pending edits first.',
      );
    }
    final ticket = _mutations.begin(ResultsMutationGroup.transcript);
    notifyListeners();
    try {
      final admitted = await manager.reviewTranscript(
        handoff: handoff,
        scope: sessionScope,
        command: command,
        displayedProof: proof,
        readCurrentTranscript: () => repository.currentTranscript(
          sessionScope: sessionScope,
          meetingId: meetingId,
        ),
        stillAuthorized: () =>
            ownsReview(epoch) &&
            _mutations.owns(ResultsMutationGroup.transcript, ticket) &&
            !_mutations.hasTranscriptDrafts &&
            _dialogs.isEmpty &&
            _active.contains(ResultsResourceKind.transcript) &&
            (proof == null ||
                (transcriptIsCurrent &&
                    transcript.data != null &&
                    proof.matches(transcript.data!))),
        capabilities: MeetingCapabilityPolicy.evaluate(
          callerId: sessionScope.userId,
          meeting: meeting,
        ),
      );
      _requireMutation(epoch);
      return admitted;
    } on ApiFailure catch (error) {
      if (ownsReview(epoch)) {
        if (error.status == 401 ||
            error.status == 403 ||
            error.status == 404) {
          await handleProtectedReadFailure(error, epoch: readEpoch);
        } else if (error.status == 409 || error.status == 412) {
          await loadTranscript(force: true);
          await loadCoverage(force: true);
        }
      }
      rethrow;
    } finally {
      _mutations.finish(ResultsMutationGroup.transcript, ticket);
      if (!_disposed) notifyListeners();
    }
  }
  String? get acceptedRegenerationJobId => _mutations.acceptedRegenerationJobId;
  ProcessingJobRecord? get regenerationJob =>
      capabilities.canRead ? _mutations.regeneration.job : null;
  bool get regenerationAdmitting =>
      capabilities.canRead && _mutations.regeneration.admitting;
  bool get regenerationAdmissionRejected =>
      capabilities.canRead && _mutations.regeneration.admissionRejected;
  bool get isAuthorizationVerificationPending =>
      _accessVerificationPending || _accessVerificationFailure != null;
  Object? get authorizationVerificationFailure => _accessVerificationFailure;
  bool ownsReview(int epoch) => capabilities.canMutate && epoch == reviewEpoch;
  @override
  bool ownsRead(int epoch) => capabilities.canRead && epoch == _readEpoch;

  ResultsProtectedDialogRegistration registerProtectedDialog(
    int epoch, {
    bool requiresMutation = true,
  }) {
    final registration = ResultsProtectedDialogRegistration(
      this,
      epoch,
      requiresMutation: requiresMutation,
    );
    if (requiresMutation ? ownsReview(epoch) : ownsRead(epoch)) {
      _dialogs.add(registration);
    } else {
      registration.invalidate();
    }
    return registration;
  }

  void _invalidateDialogs({bool mutationOnly = false}) {
    for (final dialog in List<ResultsProtectedDialogRegistration>.of(
      _dialogs,
    )) {
      if (!mutationOnly || dialog.requiresMutation) {
        dialog.invalidate();
        _dialogs.remove(dialog);
      }
    }
  }

  void _releaseDialog(ResultsProtectedDialogRegistration dialog) {
    _dialogs.remove(dialog);
  }

  bool get ownsSession =>
      !_disposed && api.isCurrentAuthenticatedSession(sessionScope);

  bool _ownsOperation(ResultsMutationGroup group, Object ticket) =>
      ownsSession && !_accessDenied && _mutations.owns(group, ticket);

  void _syncProcessingObservation() {
    final shouldObserve =
        capabilities.canRead &&
        (_active.isNotEmpty ||
            _observeActionItems ||
            _mutations.regenerationUncertain ||
            _mutations.acceptedRegenerationJobId != null);
    if (!shouldObserve) {
      if (_processingBridge != null && capabilities.canRead) {
        _processingObservationGap = true;
      }
      _processingBridge?.dispose();
      _processingBridge = null;
    } else if (processingManager != null &&
        _processingBridge == null &&
        !_creatingProcessingBridge) {
      _creatingProcessingBridge = true;
      if (_processingObservationGap) {
        // A shared observer may have completed or lost sight of a job while
        // Results was hidden. Revalidate on demand, not in the background.
        _processingObservationGap = false;
        _authorizationAbsent.clear();
        for (final kind in ResultsResourceKind.values) {
          _generations[kind] = (_generations[kind] ?? 0) + 1;
          _dirty.add(kind);
        }
      }
      try {
        _processingBridge = ResultsProcessingBridge(
          manager: processingManager!,
          invalidation: invalidation,
          api: api,
          meetingId: meetingId,
          scope: sessionScope,
          seenOutcomes: _processingOutcomes,
          publishInitial: _hasObservedProcessing,
          onJobObserved: (job) {
            if (!capabilities.canRead ||
                !_mutations.regeneration.observe(job)) {
              return;
            }
            // Keep the terminal record for Summary presentation. Only the
            // pending admission lock is released on terminal state.
            notifyListeners();
            if (job.status.isTerminal) _syncProcessingObservation();
          },
        );
        _hasObservedProcessing = true;
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
  void activateResources(
    Set<ResultsResourceKind> kinds, {
    bool observeActionItems = false,
  }) {
    if (_disposed || !ownsSession) return;
    _observeActionItems = observeActionItems;
    _active
      ..clear()
      ..addAll(kinds);
    if (kinds.contains(ResultsResourceKind.summary)) {
      summaryHistory.setActive(true);
    } else {
      _summaryHistory?.setActive(false);
    }
    _syncProcessingObservation();
    for (final kind in _active) {
      unawaited(_loadForActivation(kind));
    }
  }

  void deactivate() {
    if (_disposed) return;
    _active.clear();
    _observeActionItems = false;
    _summaryHistory?.setActive(false);
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
      case ResultsResourceKind.coverage:
        await loadCoverage();
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
    _readEpoch++;
    _meetingIdentityLabels = const {};
    _transcriptFocus = null;
    _invalidateDialogs();
    _mutations.invalidate();
    _accessVerificationPending = false;
    _accessVerificationFailure = null;
    _authorizationTicket = null;
    _authorizationRecheckRequested = false;
    _processingOutcomes.clear();
    _hasObservedProcessing = false;
    _processingObservationGap = false;
    _mutations.decisionReview.invalidateRecovery();
    for (final kind in ResultsResourceKind.values) {
      _generations[kind] = (_generations[kind] ?? 0) + 1;
      _dirty.add(kind);
    }
    _authorizationAbsent.clear();
    _requests.clear();
    transcript = const ResultsResource<Transcript>(
      phase: ResultsResourcePhase.forbidden,
    );
    coverage = const ResultsResource<TranscriptCoverage>(
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
    decisions = const ResultsResource<DecisionCollection>(
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
    if (_disposed || !ownsSession) return;
    final changed =
        next.canRead != _capabilities.canRead ||
        next.canMutate != _capabilities.canMutate;
    if (!next.canRead) {
      if (changed || !_accessDenied) {
        _capabilities = next;
        _denyAccess();
      }
      return;
    }
    // Ordinary metadata synchronization is not proof of restored access.
    // Expansions require a new canonical verification; reductions are safe.
    if (_accessDenied || isAuthorizationVerificationPending) {
      if (_capabilities.canMutate && !next.canMutate) {
        _capabilities = next;
        _mutations.invalidate();
        _authorizationRecheckRequested = _authorizationTicket != null;
        notifyListeners();
      }
      if (changed && _authorizationTicket == null) {
        unawaited(retryAccess());
      }
      return;
    }
    if (!changed) return;
    final grantsMutation = !_capabilities.canMutate && next.canMutate;
    if (!_capabilities.canRead || grantsMutation) {
      unawaited(_verifyAuthorization());
      return;
    }
    if (_capabilities.canMutate && !next.canMutate) {
      _invalidateDialogs(mutationOnly: true);
      _mutations.invalidate();
      _mutations.decisionReview.invalidateRecovery();
    }
    _capabilities = next;
    _syncProcessingObservation();
    notifyListeners();
  }

  /// Feature-owned protected reads must use the same authorization recovery
  /// as workspace-owned resources.
  @override
  Future<void> handleProtectedReadFailure(
    ApiFailure failure, {
    required int epoch,
  }) async {
    if (!ownsRead(epoch)) return;
    if (failure.status == 401 || failure.status == 403) {
      _denyAccess();
    } else if (failure.status == 404) {
      await _verifyAuthorization();
    }
  }

  /// A foreground transition may follow external membership or artifact
  /// changes. Verify the canonical access context before reusing snapshots;
  /// inactive resources stay lazy after verification.
  Future<void> revalidateOnResume() async {
    if (!ownsSession) return;
    _authorizationAbsent.clear();
    if (_authorizationTicket != null) {
      _authorizationRecheckRequested = true;
      return;
    }
    await _verifyAuthorization();
  }

  Future<void> retryAccess() async {
    if (!ownsSession ||
        _authorizationTicket != null ||
        (!_accessDenied && !isAuthorizationVerificationPending)) {
      return;
    }
    _authorizationAbsent.clear();
    await _verifyAuthorization();
  }

  Object _beginAuthorizationVerification() {
    final ticket = Object();
    _authorizationTicket = ticket;
    _readEpoch++;
    _transcriptFocus = null;
    _accessVerificationPending = true;
    _accessVerificationFailure = null;
    _invalidateDialogs();
    _mutations.invalidateReviews();
    _mutations.decisionReview.invalidateRecovery();
    for (final kind in ResultsResourceKind.values) {
      _generations[kind] = (_generations[kind] ?? 0) + 1;
      _dirty.add(kind);
    }
    _requests.clear();
    _setAuthorizationPhase(ResultsResourcePhase.verifyingAuthorization);
    _syncProcessingObservation();
    notifyListeners();
    return ticket;
  }

  bool _ownsAuthorizationCheck(Object ticket) =>
      ownsSession && identical(_authorizationTicket, ticket);

  Future<void> _verifyAuthorization({
    ResultsResourceKind? absentKind,
    ApiFailure? failure,
  }) async {
    if (!ownsSession || _authorizationTicket != null) return;
    final absentGeneration = (_generations[absentKind] ?? 0) + 1;
    final ticket = _beginAuthorizationVerification();
    ResultsAccessVerification access;
    try {
      access = await repository.verifyAccess(
        sessionScope: sessionScope,
        meetingId: meetingId,
      );
    } catch (error) {
      if (!_ownsAuthorizationCheck(ticket)) return;
      _authorizationTicket = null;
      _authorizationRecheckRequested = false;
      if (error is ApiFailure && {401, 403, 404}.contains(error.status)) {
        _denyAccess();
        return;
      }
      _accessVerificationPending = false;
      _accessVerificationFailure = error;
      _setAuthorizationPhase(
        ResultsResourcePhase.authorizationVerificationFailed,
      );
      notifyListeners();
      return;
    }
    if (!_ownsAuthorizationCheck(ticket)) return;
    if (_authorizationRecheckRequested) {
      _authorizationRecheckRequested = false;
      _authorizationTicket = null;
      await _verifyAuthorization();
      return;
    }
    if (!access.canRead) {
      _denyAccess();
      return;
    }

    _authorizationTicket = null;
    _accessDenied = false;
    _accessVerificationPending = false;
    _accessVerificationFailure = null;
    _applyVerifiedCapabilities(access);
    if (absentKind != null && _generations[absentKind] == absentGeneration) {
      _authorizationAbsent.add(absentKind);
    }
    _setAuthorizationPhase(ResultsResourcePhase.uninitialized);
    for (final kind in _authorizationAbsent) {
      _dirty.remove(kind);
      _setResourcePhase(
        kind,
        ResultsResourcePhase.notReady,
        failure: kind == absentKind ? failure : null,
      );
    }
    _syncProcessingObservation();
    notifyListeners();
    // The previous request generation has been fenced. Do not wait on its
    // completion or re-fetch an absence already verified in this context.
    unawaited(_refreshActiveResources());
  }

  void _setAuthorizationPhase(ResultsResourcePhase phase) {
    transcript = transcript.copyWith(phase: phase, clearData: true);
    coverage = coverage.copyWith(phase: phase, clearData: true);
    speakers = speakers.copyWith(phase: phase, clearData: true);
    summary = summary.copyWith(phase: phase, clearData: true);
    summaryVersions = summaryVersions.copyWith(phase: phase, clearData: true);
    decisions = decisions.copyWith(phase: phase, clearData: true);
    minutes = minutes.copyWith(phase: phase, clearData: true);
  }

  void _setResourcePhase(
    ResultsResourceKind kind,
    ResultsResourcePhase phase, {
    Object? failure,
  }) {
    switch (kind) {
      case ResultsResourceKind.transcript:
        transcript = transcript.copyWith(phase: phase, failure: failure);
      case ResultsResourceKind.coverage:
        coverage = coverage.copyWith(phase: phase, failure: failure);
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

  void _applyVerifiedCapabilities(ResultsAccessVerification access) {
    final canMutate = access.canMutate ?? _capabilities.canMutate;
    if (_capabilities.canMutate && !canMutate) {
      _invalidateDialogs(mutationOnly: true);
      _mutations.invalidate();
    }
    _capabilities = ResultsCapabilities(
      canRead: access.canRead,
      canMutate: canMutate,
    );
  }

  Future<void> _refreshActiveResources() async {
    final resources = _active
        .where((kind) => !_authorizationAbsent.contains(kind))
        .toList(growable: false);
    await Future.wait(resources.map(_reloadIfNeeded));
    _syncProcessingObservation();
  }

  void setActiveResources(Set<ResultsResourceKind> kinds) {
    activateResources(kinds);
  }

  Future<void> _reload(ResultsResourceKind kind) => switch (kind) {
    ResultsResourceKind.transcript => loadTranscript(force: true),
    ResultsResourceKind.coverage => loadCoverage(force: true),
    ResultsResourceKind.speakers => loadSpeakers(force: true),
    ResultsResourceKind.summary => loadSummary(force: true),
    ResultsResourceKind.summaryVersions => loadSummaryVersions(force: true),
    ResultsResourceKind.decisions => loadDecisions(force: true),
    ResultsResourceKind.minutes => loadMinutes(force: true),
  };

  Future<void> loadTranscript({bool force = false}) =>
      _loadTranscript(force: force);
  Future<void> loadCoverage({bool force = false}) =>
      _loadCoverage(force: force);
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

  Future<void> _loadCoverage({required bool force}) {
    final generation = _generations[ResultsResourceKind.coverage] ?? 0;
    return _load<TranscriptCoverage>(
      ResultsResourceKind.coverage,
      () => repository.currentTranscriptCoverage(
        sessionScope: sessionScope,
        meetingId: meetingId,
        stillAuthorized: () =>
            _ownsGeneration(ResultsResourceKind.coverage, generation),
      ),
      () => coverage,
      (value) => coverage = value,
      (value) => value.regions.isEmpty,
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

  Future<void> selectDecisionStatus(String? status) async {
    if (!capabilities.canRead || _decisionStatus == status) return;
    if (status != null &&
        !const {'PROPOSED', 'CONFIRMED', 'REJECTED'}.contains(status)) {
      throw ArgumentError.value(status, 'status');
    }
    _decisionStatus = status;
    const kind = ResultsResourceKind.decisions;
    _generations[kind] = (_generations[kind] ?? 0) + 1;
    _dirty.add(kind);
    _mutations.decisionReview.invalidateRecovery();
    decisions = const ResultsResource<DecisionCollection>();
    notifyListeners();
    await _loadDecisions(force: true);
  }

  Future<void> _loadDecisions({required bool force}) {
    final status = _decisionStatus;
    return _load<DecisionCollection>(
      ResultsResourceKind.decisions,
      () async => DecisionCollection.first(
        await repository.decisions(
          sessionScope: sessionScope,
          meetingId: meetingId,
          status: status,
        ),
        status,
      ),
      () => decisions,
      (value) => decisions = value,
      (value) => value.items.isEmpty,
      force: force,
    );
  }

  Future<void> loadMoreDecisions() {
    const kind = ResultsResourceKind.decisions;
    final previous = decisions.data;
    if (previous == null || _dirty.contains(kind)) {
      return _loadDecisions(force: true);
    }
    if (!previous.hasMore) return Future<void>.value();
    return _load<DecisionCollection>(
      kind,
      () async => previous.append(
        await repository.decisions(
          sessionScope: sessionScope,
          meetingId: meetingId,
          status: previous.status,
          page: previous.lastPage.page + 1,
          size: previous.lastPage.size,
        ),
      ),
      () => decisions,
      (value) => decisions = value,
      (value) => value.items.isEmpty,
      force: true,
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
    if (force && (_accessDenied || isAuthorizationVerificationPending)) {
      return retryAccess();
    }
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
                await _verifyAuthorization(absentKind: kind, failure: failure);
                return;
              } else {
                if (failure.code == 'DECISION_COLLECTION_CHANGED') {
                  _dirty.add(kind);
                }
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

  bool _ownsGeneration(ResultsResourceKind kind, int generation) =>
      ownsSession &&
      capabilities.canRead &&
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
    if (kinds.contains(ResultsResourceKind.decisions)) {
      _mutations.decisionReview.invalidateRecovery();
    }
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
    String? reason,
  }) async {
    _requireMutation(epoch);
    _requireCurrentSegment(snapshot);
    await _reconcileAfterMutation(
      ResultsMutationGroup.transcript,
      <ResultsResourceKind>{
        ResultsResourceKind.transcript,
        ResultsResourceKind.coverage,
        ResultsResourceKind.speakers,
        ResultsResourceKind.summary,
        ResultsResourceKind.summaryVersions,
        ResultsResourceKind.decisions,
        ResultsResourceKind.minutes,
      },
      (_) => repository.correctSegment(
        sessionScope: sessionScope,
        meetingId: meetingId,
        snapshot: snapshot,
        text: text,
        reason: reason,
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
        ResultsResourceKind.coverage,
        ResultsResourceKind.speakers,
        ResultsResourceKind.summary,
        ResultsResourceKind.summaryVersions,
        ResultsResourceKind.decisions,
        ResultsResourceKind.minutes,
      },
      (_) => repository.mapSpeaker(
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
      (_) => repository.editSummary(
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
      (_) => repository.activateSummaryVersion(
        sessionScope: sessionScope,
        meetingId: meetingId,
        snapshot: snapshot,
        versionId: version.id,
      ),
    );
  }

  Future<({DecisionEvidenceReview evidence, DecisionReviewStamp stamp})>
  loadStampedDecisionEvidence(MeetingDecision snapshot) async {
    final stamp = decisionReviewStamp;
    final evidence = await loadDecisionEvidence(snapshot);
    return (evidence: evidence, stamp: stamp);
  }

  Future<DecisionEvidenceReview> loadDecisionEvidence(
    MeetingDecision snapshot,
  ) async {
    if (snapshot.meetingId.toLowerCase() != meetingId.toLowerCase() ||
        snapshot.transcriptId == null ||
        snapshot.contentRevision == null) {
      return DecisionEvidenceReview(snapshot, null);
    }
    final projection = await loadCurrentDecisionProjection();
    if (projection?.transcript.id != snapshot.transcriptId ||
        projection?.transcript.contentRevision != snapshot.contentRevision) {
      return DecisionEvidenceReview(snapshot, null);
    }
    return DecisionEvidenceReview(snapshot, projection);
  }

  Future<TranscriptReviewProjection?> loadCurrentDecisionProjection() async {
    final epoch = readEpoch;
    if (!ownsRead(epoch)) return null;
    await loadTranscript(force: true);
    if (!ownsRead(epoch) || !transcriptIsCurrent) return null;
    final source = transcript.data;
    if (source == null) return null;
    await Future.wait([loadCoverage(force: true), loadSpeakers(force: true)]);
    if (!ownsRead(epoch) ||
        !transcriptIsCurrent ||
        transcript.data?.etag != source.etag ||
        transcript.data?.id != source.id) {
      return null;
    }
    return TranscriptReviewProjection(
      source,
      coverage:
          !_dirty.contains(ResultsResourceKind.coverage) &&
              (coverage.phase == ResultsResourcePhase.available ||
                  coverage.phase == ResultsResourcePhase.empty)
          ? coverage.data
          : null,
      speakers:
          !_dirty.contains(ResultsResourceKind.speakers) &&
              (speakers.phase == ResultsResourcePhase.available ||
                  speakers.phase == ResultsResourcePhase.empty)
          ? speakers.data
          : null,
    );
  }

  Future<void> createDecision(
    String content, {
    required int epoch,
    Transcript? reviewedTranscript,
    List<String> evidenceSegmentIds = const [],
  }) async {
    _requireMutation(epoch);
    if (_mutations.decisionOutcomeUnknown) {
      throw const ApiFailure(
        409,
        'RESULTS_OUTCOME_UNKNOWN',
        'Kiểm tra quyết định trước đó trước khi tạo quyết định mới.',
      );
    }
    _validateDecisionContent(content);
    final ids = List<String>.unmodifiable(evidenceSegmentIds);
    if (ids.length > 50 ||
        ids.toSet().length != ids.length ||
        (ids.isNotEmpty &&
            (reviewedTranscript == null ||
                reviewedTranscript.meetingId != meetingId ||
                !ids.every(
                  (id) => reviewedTranscript.segments.any((s) => s.id == id),
                )))) {
      throw const ApiFailure(
        422,
        'DECISION_EVIDENCE_INVALID',
        'Bằng chứng không hợp lệ hoặc bị trùng lặp.',
      );
    }
    await _reconcileAfterMutation(
      ResultsMutationGroup.decisions,
      <ResultsResourceKind>{
        ResultsResourceKind.decisions,
        ResultsResourceKind.minutes,
      },
      (ticket) async {
        if (ids.isNotEmpty) {
          await loadTranscript(force: true);
          _requireMutation(epoch);
          final current = transcript.data;
          if (!transcriptIsCurrent ||
              current == null ||
              current.id != reviewedTranscript!.id ||
              current.contentRevision != reviewedTranscript.contentRevision ||
              current.etag == null ||
              current.etag != reviewedTranscript.etag) {
            throw const ApiFailure(
              412,
              'RESULTS_REVIEW_CHANGED',
              'Transcript đã thay đổi. Vui lòng chọn lại bằng chứng.',
            );
          }
        }
        return _dispatchDecision(
          ticket,
          DecisionCommandIntent(
            DecisionCommand.create,
            content,
            creationContext: ManualDecisionDraft(
              content,
              ids.isNotEmpty,
              source: reviewedTranscript,
              evidence: ids.toSet(),
            ),
          ),
          () => repository.createDecision(
            sessionScope: sessionScope,
            meetingId: meetingId,
            content: content,
            evidenceSegmentIds: ids,
            reviewedTranscript: reviewedTranscript,
          ),
        );
      },
    );
  }

  void _validateDecisionContent(String content) {
    if (content.trim().isEmpty || content.length > 5000) {
      throw const ApiFailure(
        422,
        'DECISION_CONTENT_INVALID',
        'Nội dung quyết định phải có từ 1 đến 5.000 ký tự.',
      );
    }
  }

  void _requireDecisionSnapshot(MeetingDecision snapshot, String status) {
    if (snapshot.meetingId.toLowerCase() != meetingId.toLowerCase() ||
        snapshot.status != status ||
        snapshot.etag == null ||
        snapshot.etag!.trim().isEmpty ||
        snapshot.etag!.contains('\r') ||
        snapshot.etag!.contains('\n')) {
      throw const ApiFailure(
        412,
        'RESULTS_REVIEW_CHANGED',
        'Quyết định không còn phù hợp để thực hiện thao tác này.',
      );
    }
  }

  Future<void> editDecision(
    MeetingDecision snapshot,
    String content, {
    required int epoch,
  }) async {
    _requireMutation(epoch);
    _requireDecisionRecoveryResolved();
    _requireDecisionSnapshot(snapshot, 'CONFIRMED');
    _validateDecisionContent(content);
    await _reconcileAfterMutation(
      ResultsMutationGroup.decisions,
      {ResultsResourceKind.decisions, ResultsResourceKind.minutes},
      (ticket) => _dispatchDecision(
        ticket,
        DecisionCommandIntent(
          DecisionCommand.edit,
          content,
          snapshot: snapshot,
        ),
        () => repository.editDecision(
          sessionScope: sessionScope,
          meetingId: meetingId,
          snapshot: snapshot,
          content: content,
        ),
      ),
    );
  }

  Future<void> reviewDecision(
    MeetingDecision snapshot, {
    required bool confirm,
    required int epoch,
    DecisionEvidenceReview? reviewedEvidence,
  }) async {
    _requireMutation(epoch);
    _requireDecisionRecoveryResolved();
    _requireDecisionSnapshot(snapshot, 'PROPOSED');
    if (confirm &&
        (reviewedEvidence == null ||
            !identical(reviewedEvidence.decision, snapshot) ||
            !reviewedEvidence.canConfirm)) {
      throw const ApiFailure(
        409,
        'DECISION_EVIDENCE_INVALID',
        'Bằng chứng chưa đủ điều kiện xác nhận.',
      );
    }
    await _reconcileAfterMutation(
      ResultsMutationGroup.decisions,
      <ResultsResourceKind>{
        ResultsResourceKind.decisions,
        ResultsResourceKind.minutes,
      },
      (ticket) async {
        if (confirm) {
          final current = await loadDecisionEvidence(snapshot);
          _requireMutation(epoch);
          if (!current.canConfirm ||
              current.projection?.transcript.etag !=
                  reviewedEvidence!.projection?.transcript.etag) {
            throw const ApiFailure(
              412,
              'RESULTS_REVIEW_CHANGED',
              'Bằng chứng đã thay đổi. Vui lòng đối chiếu lại.',
            );
          }
        }
        return _dispatchDecision(
          ticket,
          DecisionCommandIntent(
            confirm ? DecisionCommand.confirm : DecisionCommand.reject,
            snapshot.content,
            snapshot: snapshot,
          ),
          () => repository.reviewDecision(
            sessionScope: sessionScope,
            meetingId: meetingId,
            snapshot: snapshot,
            confirm: confirm,
          ),
        );
      },
    );
  }

  void _requireDecisionRecoveryResolved() {
    if (_mutations.decisionOutcomeUnknown) {
      throw const ApiFailure(
        409,
        'RESULTS_OUTCOME_UNKNOWN',
        'Kiểm tra thao tác quyết định trước đó trước khi tiếp tục.',
      );
    }
  }

  Future<T> _dispatchDecision<T>(
    Object ticket,
    DecisionCommandIntent intent,
    Future<T> Function() send,
  ) async {
    try {
      final response = await send();
      if (intent.command == DecisionCommand.create &&
          _ownsOperation(ResultsMutationGroup.decisions, ticket)) {
        _mutations.decisionReview.draft = null;
      }
      return response;
    } catch (error) {
      if (_ownsOperation(ResultsMutationGroup.decisions, ticket) &&
          ResultsMutationCoordinator.isUncertain(error)) {
        _mutations.decisionReview.recordUnresolved(intent);
      }
      rethrow;
    }
  }

  Future<void> regenerateSummary({required int epoch}) async {
    _requireMutation(epoch);
    if (_mutations.acceptedRegenerationJobId != null) {
      throw const ApiFailure(
        409,
        'RESULTS_COMMAND_PENDING',
        'Tác vụ tạo lại tóm tắt trước đó chưa hoàn tất.',
      );
    }
    await _reconcileAfterMutation(
      ResultsMutationGroup.summary,
      <ResultsResourceKind>{
        ResultsResourceKind.summary,
        ResultsResourceKind.summaryVersions,
        ResultsResourceKind.minutes,
      },
      (ticket) async {
        final key = _mutations.regenerationKey();
        try {
          final jobId = await repository.regenerateSummary(
            sessionScope: sessionScope,
            meetingId: meetingId,
            idempotencyKey: key,
          );
          if (_ownsOperation(ResultsMutationGroup.summary, ticket)) {
            _mutations.recordAdmission(jobId);
            _syncProcessingObservation();
            _processingBridge?.reconcileCurrent();
          }
          return jobId;
        } catch (error) {
          if (_ownsOperation(ResultsMutationGroup.summary, ticket)) {
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
    Future<Object?> Function(Object ticket) operation,
  ) async {
    final ticket = _mutations.begin(group);
    final epoch = reviewEpoch;
    var invalidated = false;
    notifyListeners();
    try {
      _requireMutation(epoch);
      await operation(ticket);
    } catch (error, stack) {
      if (_ownsOperation(group, ticket) &&
          ResultsMutationCoordinator.isUncertain(error)) {
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
      if (_ownsOperation(group, ticket) &&
          error is ApiFailure &&
          (error.status == 403 || error.status == 404)) {
        await _verifyAuthorization();
      }
      Error.throwWithStackTrace(error, stack);
    } finally {
      final owned = _ownsOperation(group, ticket);
      _mutations.finish(group, ticket);
      if (owned) {
        if (!invalidated) _invalidate(resources);
        notifyListeners();
      }
    }
    // Admission and completion ownership differ. An already dispatched
    // operation may finish during suspension, but its obsolete UI must not
    // present a success or dispatch another command.
    _requireMutation(epoch);
  }

  Future<List<MeetingDecision>?> reconcileUnknownDecision({
    required int epoch,
  }) async {
    _requireMutation(epoch);
    final state = _mutations.decisionReview;
    final intent = state.unresolved;
    if (intent == null) return null;
    final ticket = state.beginRecovery();
    final accessEpoch = readEpoch;
    final generation = _generations[ResultsResourceKind.decisions] ?? 0;
    List<MeetingDecision>? review;
    try {
      review = await readDecisionRecovery(
        readPage: (page, size) => repository.decisions(
          sessionScope: sessionScope,
          meetingId: meetingId,
          page: page,
          size: size,
        ),
        stillCurrent: () =>
            ownsReview(epoch) &&
            state.ownsRecovery(ticket, intent) &&
            generation == (_generations[ResultsResourceKind.decisions] ?? 0),
      );
    } on ApiFailure catch (error) {
      await handleProtectedReadFailure(error, epoch: accessEpoch);
      rethrow;
    }
    if (review == null ||
        !ownsReview(epoch) ||
        generation != (_generations[ResultsResourceKind.decisions] ?? 0) ||
        !state.publishRecovery(ticket, intent, review, generation)) {
      return null;
    }
    return review;
  }

  void acknowledgeUnknownDecision({
    required int epoch,
    required List<MeetingDecision> reviewed,
  }) {
    _acknowledgeUnknownDecision(epoch: epoch, reviewed: reviewed);
  }

  void resolveUnknownManualCreation({
    required int epoch,
    required List<MeetingDecision> reviewed,
    required ManualDecisionRecoveryDisposition disposition,
  }) {
    _acknowledgeUnknownDecision(
      epoch: epoch,
      reviewed: reviewed,
      disposition: disposition,
    );
  }

  void _acknowledgeUnknownDecision({
    required int epoch,
    required List<MeetingDecision> reviewed,
    ManualDecisionRecoveryDisposition? disposition,
  }) {
    _requireMutation(epoch);
    final state = _mutations.decisionReview;
    if (!state.matchesRecovery(
      reviewed,
      _generations[ResultsResourceKind.decisions] ?? 0,
    )) {
      throw const ApiFailure(
        409,
        'RESULTS_OUTCOME_UNKNOWN',
        'Danh sách quyết định đã thay đổi. Vui lòng kiểm tra lại.',
      );
    }
    if (_mutations.busy(ResultsMutationGroup.decisions)) {
      throw const ApiFailure(
        409,
        'RESULTS_COMMAND_PENDING',
        'Một thao tác trên quyết định đang được xử lý.',
      );
    }
    if (state.isUnresolvedManualCreation && disposition == null) {
      throw const ApiFailure(
        409,
        'RESULTS_OUTCOME_UNKNOWN',
        'Hãy chọn cách xử lý bản nháp của thao tác tạo trước đó.',
      );
    }
    if (state.isUnresolvedManualCreation) {
      final previous = state.unresolved?.creationContext ?? state.draft;
      state.draft = switch (disposition!) {
        ManualDecisionRecoveryDisposition.discard => null,
        ManualDecisionRecoveryDisposition.reuse =>
          previous == null
              ? null
              : ManualDecisionDraft(
                  previous.content,
                  previous.attachEvidence,
                  // The old transcript identity and evidence selection are
                  // deliberately not carried into the new unsent draft.
                  requiresFreshEvidenceReview:
                      previous.attachEvidence || previous.evidence.isNotEmpty,
                ),
      };
    }
    state.invalidateRecovery();
    state.unresolved = null;
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
    _summaryHistory?.dispose();
    super.dispose();
  }
}

/// Registration owned by one protected dialog route. It never looks up a
/// replacement workspace, so a delayed callback cannot act on a new meeting
/// or session context.
class ResultsProtectedDialogRegistration extends ChangeNotifier {
  ResultsProtectedDialogRegistration(
    this._workspace,
    this.epoch, {
    required this.requiresMutation,
  });

  final ResultsWorkspaceController _workspace;
  final int epoch;
  final bool requiresMutation;
  BuildContext? _context;
  NavigatorState? _navigator;
  ModalRoute<dynamic>? _route;
  bool _valid = true;
  bool _dismissScheduled = false;
  bool _disposed = false;

  bool get isValid =>
      _valid &&
      (requiresMutation
          ? _workspace.ownsReview(epoch)
          : _workspace.ownsRead(epoch));

  void attach(BuildContext context) {
    if (_disposed) return;
    _context = context;
    _route ??= ModalRoute.of(context);
    _navigator ??= Navigator.of(context);
    if (!isValid) invalidate();
  }

  void invalidate() {
    if (_disposed) return;
    if (!_valid) {
      _scheduleDismiss();
      return;
    }
    _valid = false;
    notifyListeners();
    _scheduleDismiss();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _valid = false;
    _workspace._releaseDialog(this);
    _context = null;
    _route = null;
    _navigator = null;
    super.dispose();
  }

  void _scheduleDismiss() {
    if (_disposed) return;
    if (_dismissScheduled) return;
    _dismissScheduled = true;
    // A post-frame callback does not request another frame. Invalidation can
    // happen while the owning workspace is being disposed, when no unrelated
    // rebuild is guaranteed to occur.
    WidgetsBinding.instance.ensureVisualUpdate();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _dismissScheduled = false;
      final context = _context;
      final route = _route;
      final navigator = _navigator;
      if (_disposed ||
          context == null ||
          route == null ||
          navigator == null ||
          !route.isActive ||
          !context.mounted) {
        return;
      }
      navigator.removeRoute(route);
    });
  }
}
