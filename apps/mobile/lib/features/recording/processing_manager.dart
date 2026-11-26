import 'dart:async';
import 'dart:math';

import 'package:flutter/widgets.dart';

import '../../core/api_client.dart';
import '../meetings/meeting_foundation.dart';
import 'local_media_models.dart';
import 'local_media_repository.dart';
import 'media_contracts.dart';
import 'media_repository.dart';
import 'processing_repository.dart';

typedef ProcessingCapabilityResolver = Future<MeetingCapabilities?> Function(
  String meetingId,
  AuthenticatedSessionScope scope,
);

class ProcessingMeetingState {
  const ProcessingMeetingState({
    required this.meetingId,
    this.media = const <MediaRecord>[],
    this.jobs = const <ProcessingJobRecord>[],
    this.isRefreshing = false,
    this.lastRefreshedAt,
    this.failure,
    this.nextRefreshIn,
    this.sessionScope,
  });

  final String meetingId;
  final List<MediaRecord> media;
  final List<ProcessingJobRecord> jobs;
  final bool isRefreshing;
  final DateTime? lastRefreshedAt;
  final Object? failure;
  final Duration? nextRefreshIn;
  final AuthenticatedSessionScope? sessionScope;

  bool get hasFreshData => lastRefreshedAt != null;
  bool get hasActiveJobs => jobs.any(
    (job) =>
        job.status == ProcessingJobStatus.pending ||
        job.status == ProcessingJobStatus.queued ||
        job.status == ProcessingJobStatus.running,
  );
  bool get hasReviewWaiting => jobs.any((job) => job.isWaitingForReview);

  ProcessingMeetingState copyWith({
    List<MediaRecord>? media,
    List<ProcessingJobRecord>? jobs,
    bool? isRefreshing,
    DateTime? lastRefreshedAt,
    Object? failure,
    Duration? nextRefreshIn,
    AuthenticatedSessionScope? sessionScope,
  }) => ProcessingMeetingState(
    meetingId: meetingId,
    media: media ?? this.media,
    jobs: jobs ?? this.jobs,
    isRefreshing: isRefreshing ?? this.isRefreshing,
    lastRefreshedAt: lastRefreshedAt ?? this.lastRefreshedAt,
    failure: failure,
    nextRefreshIn: nextRefreshIn ?? this.nextRefreshIn,
    sessionScope: sessionScope ?? this.sessionScope,
  );
}

class TranscriptReviewHandoff {
  const TranscriptReviewHandoff({
    required this.meetingId,
    required this.jobId,
    required this.sourceMediaId,
  });

  final String meetingId;
  final String jobId;
  final String? sourceMediaId;
}

class ProcessingObservation {
  ProcessingObservation(this.manager, this.meetingId, this.key);

  final ProcessingManager manager;
  final String meetingId;
  final String key;
  bool _released = false;

  void dispose() {
    if (_released) return;
    _released = true;
    manager.stopObserving(meetingId, subscription: this);
  }
}

/// Shared authorized remote media inventory and adaptive processing monitor.
/// One manager is owned by the application, while observation counts are
/// scoped by authenticated session and meeting.
class ProcessingManager extends ChangeNotifier with WidgetsBindingObserver {
  ProcessingManager({
    required this.api,
    required this.mediaRepository,
    required this.processingRepository,
    required this.localMedia,
    this.capabilityResolver,
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now {
    api.addListener(_sessionChanged);
    try {
      WidgetsBinding.instance.addObserver(this);
      _lifecycleObserverRegistered = true;
    } catch (_) {
      // See RecordingCoordinator: the production composition is created after
      // Flutter binding initialization, while lightweight unit tests may not
      // have a binding.
    }
  }

  final ApiClient api;
  final MediaRepository mediaRepository;
  final ProcessingRepository processingRepository;
  final LocalMediaRepository localMedia;
  final ProcessingCapabilityResolver? capabilityResolver;
  final DateTime Function() _now;

  final Map<String, ProcessingMeetingState> _states =
      <String, ProcessingMeetingState>{};
  final Map<String, AuthenticatedSessionScope> _scopes =
      <String, AuthenticatedSessionScope>{};
  final Map<String, int> _consumers = <String, int>{};
  final Map<String, Timer> _timers = <String, Timer>{};
  final Map<String, Future<void>> _inFlight = <String, Future<void>>{};
  final Map<String, int> _unchangedRefreshes = <String, int>{};
  final Map<String, String> _meetingForKey = <String, String>{};
  final Map<String, int> _failureCounts = <String, int>{};
  final Map<String, int> _observationGenerations = <String, int>{};
  final Map<String, Future<ProcessingJobRecord>> _mutationFlights =
      <String, Future<ProcessingJobRecord>>{};
  bool _backgrounded = false;
  bool _disposed = false;
  bool _shuttingDown = false;
  bool _lifecycleObserverRegistered = false;
  Future<void>? _shutdownFuture;

  bool get hasActiveWork => _inFlight.isNotEmpty || _mutationFlights.isNotEmpty;

  /// Read-only snapshots already observed by this manager; no new polling.
  Iterable<ProcessingMeetingState> get currentStates =>
      _states.values.where((state) {
        final scope = state.sessionScope;
        return scope != null && api.isCurrentAuthenticatedSession(scope);
      });

  ProcessingMeetingState? stateFor(
    String meetingId, {
    AuthenticatedSessionScope? scope,
  }) {
    final activeScope = scope ?? api.authenticatedSessionScope;
    if (activeScope == null ||
        !api.isCurrentAuthenticatedSession(activeScope)) {
      return null;
    }
    return _states[_key(activeScope, meetingId)];
  }

  int consumerCount(String meetingId) {
    final scope = api.authenticatedSessionScope;
    return scope == null ? 0 : _consumers[_key(scope, meetingId)] ?? 0;
  }

  /// Adds one interested consumer. Duplicate screens share the same timer and
  /// in-flight request; each caller must invoke [stopObserving] once.
  ProcessingObservation startObserving(
    String meetingId, {
    required AuthenticatedSessionScope scope,
  }) {
    if (_disposed || _shuttingDown) {
      throw const ApiFailure(
        0,
        'PROCESSING_SHUTDOWN',
        'Processing observation is unavailable while the application is shutting down.',
      );
    }
    api.requireCurrentAuthenticatedSession(scope);
    final key = _key(scope, meetingId);
    final wasInactive = (_consumers[key] ?? 0) == 0;
    final needsGeneration = wasInactive || !_scopes.containsKey(key);
    _meetingForKey[key] = meetingId;
    _scopes[key] = scope;
    _consumers[key] = (_consumers[key] ?? 0) + 1;
    if (needsGeneration) {
      _cancelTimer(key);
      final generation = (_observationGenerations[key] ?? 0) + 1;
      _observationGenerations[key] = generation;
      _unchangedRefreshes[key] = 0;
      _failureCounts.remove(key);
    }
    if (needsGeneration) {
      final generation = _observationGenerations[key] ??= 1;
      unawaited(
        refresh(
          meetingId,
          scope: scope,
          generation: generation,
          explicit: true,
          force: true,
        ),
      );
    }
    return ProcessingObservation(this, meetingId, key);
  }

  void stopObserving(String meetingId, {ProcessingObservation? subscription}) {
    final currentScope = api.authenticatedSessionScope;
    final key =
        subscription?.key ??
        (currentScope == null ? meetingId : _key(currentScope, meetingId));
    final next = (_consumers[key] ?? 0) - 1;
    if (next > 0) {
      _consumers[key] = next;
      return;
    }
    _consumers.remove(key);
    _observationGenerations[key] = (_observationGenerations[key] ?? 0) + 1;
    _cancelTimer(key);
    _scopes.remove(key);
    _failureCounts.remove(key);
  }

  Future<void> refresh(
    String meetingId, {
    required AuthenticatedSessionScope scope,
    bool explicit = false,
    int? generation,
    bool force = false,
  }) {
    api.requireCurrentAuthenticatedSession(scope);
    if (_disposed || _shuttingDown) return Future<void>.value();
    final key = _key(scope, meetingId);
    var activeGeneration = generation ?? _observationGenerations[key];
    if (activeGeneration == null) {
      activeGeneration = 1;
      _observationGenerations[key] = activeGeneration;
    }
    if (_observationGenerations[key] != activeGeneration) {
      return Future<void>.value();
    }
    _scopes[key] ??= scope;
    _meetingForKey[key] ??= meetingId;
    final running = _inFlight[key];
    // An explicit caller refreshes the current observation generation; it
    // must not create an overlapping request. A generation-bound refresh from
    // a newly mounted observer may use [force] to supersede an older
    // generation's request.
    if (running != null && (!force || generation == null)) return running;
    final current =
        _states[key] ??
        ProcessingMeetingState(meetingId: meetingId, sessionScope: scope);
    _states[key] = current.copyWith(
      isRefreshing: true,
      failure: null,
      sessionScope: scope,
    );
    notifyListeners();
    final future = _fetch(
      meetingId,
      scope,
      explicit: explicit,
      generation: activeGeneration,
    );
    _inFlight[key] = future;
    unawaited(
      future.then<void>(
        (_) {
          if (identical(_inFlight[key], future)) _inFlight.remove(key);
        },
        onError: (Object _, StackTrace __) {
          if (identical(_inFlight[key], future)) _inFlight.remove(key);
        },
      ),
    );
    return future;
  }

  Future<void> _fetch(
    String meetingId,
    AuthenticatedSessionScope scope, {
    required bool explicit,
    required int generation,
  }) async {
    final key = _key(scope, meetingId);
    try {
      await _requireCurrentReadCapability(scope, meetingId);
      api.requireCurrentAuthenticatedSession(scope);
      final results = await Future.wait<Object>(<Future<Object>>[
        mediaRepository.listMedia(meetingId, sessionScope: scope),
        processingRepository.list(meetingId, sessionScope: scope),
      ]);
      if (_disposed ||
          _shuttingDown ||
          !api.isCurrentAuthenticatedSession(scope) ||
          _scopes[key] != scope ||
          _observationGenerations[key] != generation ||
          ((_consumers[key] ?? 0) == 0 && !explicit)) {
        return;
      }
      final media = results[0] as List<MediaRecord>;
      final jobs = results[1] as List<ProcessingJobRecord>;
      final previous = _states[key];
      _failureCounts.remove(key);
      final changed =
          previous == null ||
          !_sameRemoteInventory(previous.media, previous.jobs, media, jobs);
      _unchangedRefreshes[key] = changed
          ? 0
          : (_unchangedRefreshes[key] ?? 0) + 1;
      _states[key] = ProcessingMeetingState(
        meetingId: meetingId,
        media: List<MediaRecord>.unmodifiable(media),
        jobs: List<ProcessingJobRecord>.unmodifiable(jobs),
        isRefreshing: false,
        lastRefreshedAt: _now().toUtc(),
        nextRefreshIn: _intervalFor(jobs, changed, key),
        sessionScope: scope,
      );
      notifyListeners();
      _schedule(
        key,
        meetingId,
        scope,
        _intervalFor(jobs, changed, key),
        generation: generation,
      );
    } catch (error) {
      if (_disposed ||
          _shuttingDown ||
          !api.isCurrentAuthenticatedSession(scope) ||
          _scopes[key] != scope ||
          _observationGenerations[key] != generation ||
          ((_consumers[key] ?? 0) == 0 && !explicit)) {
        return;
      }
      if (error is ApiFailure &&
          (error.status == 401 || error.status == 403 || error.status == 404)) {
        _states[key] = ProcessingMeetingState(
          meetingId: meetingId,
          media: const <MediaRecord>[],
          jobs: const <ProcessingJobRecord>[],
          isRefreshing: false,
          failure: error,
          sessionScope: scope,
        );
        _cancelTimer(key);
        _scopes.remove(key);
        notifyListeners();
        return;
      }
      final failureCount = (_failureCounts[key] ?? 0) + 1;
      _failureCounts[key] = failureCount;
      final serverDelay = error is ApiFailure
          ? error.retryAfterDuration(now: _now())
          : null;
      final exponential = Duration(
        seconds: min(60, 5 * (1 << (failureCount - 1))),
      );
      final retryDelay = serverDelay != null && serverDelay > exponential
          ? serverDelay
          : exponential;
      final previous = _states[key];
      _states[key] =
          (previous ??
                  ProcessingMeetingState(
                    meetingId: meetingId,
                    sessionScope: scope,
                  ))
              .copyWith(
                isRefreshing: false,
                failure: error,
                nextRefreshIn: retryDelay,
                sessionScope: scope,
              );
      notifyListeners();
      _schedule(key, meetingId, scope, retryDelay, generation: generation);
    }
  }

  Future<ProcessingJobRecord> retryJob({
    required ProcessingJobRecord job,
    required AuthenticatedSessionScope scope,
    MeetingCapabilities? capabilities,
    String? expectedOperationId,
  }) {
    if (_disposed || _shuttingDown) {
      return Future<ProcessingJobRecord>.error(
        const ApiFailure(
          0,
          'PROCESSING_SHUTDOWN',
          'Processing actions are unavailable while the application is shutting down.',
        ),
      );
    }
    final key = '${_key(scope, job.meetingId)}\u0000retry\u0000${job.id}';
    final running = _mutationFlights[key];
    if (running != null) {
      if (expectedOperationId != null) {
        return Future<ProcessingJobRecord>.error(
          const ApiFailure(
            409,
            'PROCESSING_BUSY',
            'Another processing operation is already running.',
          ),
        );
      }
      return running;
    }
    final future = _retryJobInternal(
      job: job,
      scope: scope,
      capabilities: capabilities,
      expectedOperationId: expectedOperationId,
    );
    _mutationFlights[key] = future;
    unawaited(
      future.then<void>(
        (_) {
          _mutationFlights.remove(key);
        },
        onError: (Object _, StackTrace __) {
          _mutationFlights.remove(key);
        },
      ),
    );
    return future;
  }

  Future<ProcessingJobRecord> _retryJobInternal({
    required ProcessingJobRecord job,
    required AuthenticatedSessionScope scope,
    MeetingCapabilities? capabilities,
    String? expectedOperationId,
  }) async {
    api.requireCurrentAuthenticatedSession(scope);
    await _requireCurrentCapability(
      scope,
      job.meetingId,
      MeetingOperation.retryProcessing,
      capabilities,
    );
    var operation = await _unresolvedOperation(
      scope: scope,
      meetingId: job.meetingId,
      remoteJobId: job.id,
      type: ProcessingOperationType.retry,
    );
    _requireExpectedOperation(operation, expectedOperationId);
    final authoritative = await processingRepository.get(
      job.id,
      sessionScope: scope,
    );
    _validateAcceptedJob(authoritative, job);
    job = authoritative;
    if (operation == null && !job.retryable) {
      throw const ApiFailure(
        409,
        'PROCESSING_RETRY_NOT_ALLOWED',
        'The processing job is not eligible for retry.',
      );
    }
    operation ??= await localMedia.beginProcessingOperation(
      scope: scope,
      meetingId: job.meetingId,
      idempotencyKey: _newKey(),
      operationType: ProcessingOperationType.retry,
      targetJobId: job.id,
    );
    final priorUnresolved = operation.recoveryRequired;
    _checkMutation(scope);
    operation = await _beginProcessingAttempt(scope, operation);
    late ProcessingJobRecord accepted;
    try {
      // The default request is deliberately {}. A current stage is not proof
      // that stage-specific retry is authorized.
      await _requireCurrentCapability(
        scope,
        job.meetingId,
        MeetingOperation.retryProcessing,
        capabilities,
      );
      _checkMutation(scope);
      accepted = await processingRepository.retry(
        job.id,
        idempotencyKey: operation.idempotencyKey,
        sessionScope: scope,
      );
      api.requireCurrentAuthenticatedSession(scope);
      _validateAcceptedJob(accepted, job);
    } catch (error) {
      final failure = _processingFailure(
        error,
        code: 'PROCESSING_RETRY_FAILED',
        message: 'The processing retry could not be completed.',
      );
      final ambiguous = _processingOutcomeAmbiguous(failure);
      await localMedia.updateProcessingOperation(
        operation,
        scope: scope,
        attemptCount: operation.attemptCount,
        attemptOutcome: failure.code == 'PROCESSING_SHUTDOWN'
            ? OperationAttemptOutcome.interrupted
            : ambiguous
            ? OperationAttemptOutcome.uncertain
            : OperationAttemptOutcome.rejected,
        recoveryRequired:
            priorUnresolved ||
            failure.code == 'PROCESSING_SHUTDOWN' ||
            ambiguous,
        failureCode: failure.code,
        failureStatus: failure.status,
        failureMessage: failure.message,
      );
      rethrow;
    }
    await localMedia.updateProcessingOperation(
      operation,
      scope: scope,
      checkpoint: ProcessingOperationCheckpoint.retryConfirmed,
      resultingJobId: accepted.id,
      attemptCount: operation.attemptCount,
      attemptOutcome: OperationAttemptOutcome.succeeded,
      recoveryRequired: false,
    );
    unawaited(_refreshConfirmedMutation(job.meetingId, scope));
    return accepted;
  }

  Future<ProcessingJobRecord> reprocess({
    required ProcessingJobRecord parent,
    required String sourceMediaId,
    required AuthenticatedSessionScope scope,
    MeetingCapabilities? capabilities,
    String? expectedOperationId,
  }) {
    if (_disposed || _shuttingDown) {
      return Future<ProcessingJobRecord>.error(
        const ApiFailure(
          0,
          'PROCESSING_SHUTDOWN',
          'Processing actions are unavailable while the application is shutting down.',
        ),
      );
    }
    final key =
        '${_key(scope, parent.meetingId)}\u0000reprocess\u0000'
        '${parent.id}\u0000$sourceMediaId';
    final running = _mutationFlights[key];
    if (running != null) {
      if (expectedOperationId != null) {
        return Future<ProcessingJobRecord>.error(
          const ApiFailure(
            409,
            'PROCESSING_BUSY',
            'Another processing operation is already running.',
          ),
        );
      }
      return running;
    }
    final future = _reprocessInternal(
      parent: parent,
      sourceMediaId: sourceMediaId,
      scope: scope,
      capabilities: capabilities,
      expectedOperationId: expectedOperationId,
    );
    _mutationFlights[key] = future;
    unawaited(
      future.then<void>(
        (_) {
          _mutationFlights.remove(key);
        },
        onError: (Object _, StackTrace __) {
          _mutationFlights.remove(key);
        },
      ),
    );
    return future;
  }

  Future<ProcessingJobRecord> _reprocessInternal({
    required ProcessingJobRecord parent,
    required String sourceMediaId,
    required AuthenticatedSessionScope scope,
    MeetingCapabilities? capabilities,
    String? expectedOperationId,
  }) async {
    api.requireCurrentAuthenticatedSession(scope);
    final authoritativeParent = await processingRepository.get(
      parent.id,
      sessionScope: scope,
    );
    if (authoritativeParent.meetingId.toLowerCase() !=
            parent.meetingId.toLowerCase() ||
        authoritativeParent.id.toLowerCase() != parent.id.toLowerCase()) {
      throw const ApiFailure(
        409,
        'PROCESSING_REPROCESS_NOT_ALLOWED',
        'The parent job does not belong to the current meeting.',
      );
    }
    parent = authoritativeParent;
    await _requireCurrentCapability(
      scope,
      parent.meetingId,
      MeetingOperation.admitProcessing,
      capabilities,
    );
    if (!parent.status.isTerminal ||
        parent.meetingId.isEmpty ||
        parent.sourceMediaId != sourceMediaId) {
      throw const ApiFailure(
        409,
        'PROCESSING_REPROCESS_NOT_ALLOWED',
        'The parent job is not an eligible attempt for this source media.',
      );
    }
    final media = await mediaRepository.getMedia(
      parent.meetingId,
      sourceMediaId,
      sessionScope: scope,
    );
    if (!media.accepted) {
      throw const ApiFailure(
        409,
        'MEDIA_NOT_AVAILABLE',
        'Reprocessing requires accepted source media.',
      );
    }
    var operation = await _unresolvedOperation(
      scope: scope,
      meetingId: parent.meetingId,
      sourceMediaId: sourceMediaId,
      type: ProcessingOperationType.reprocess,
      reprocessOfJobId: parent.id,
    );
    _requireExpectedOperation(operation, expectedOperationId);
    operation ??= await localMedia.beginProcessingOperation(
      scope: scope,
      meetingId: parent.meetingId,
      idempotencyKey: _newKey(),
      operationType: ProcessingOperationType.reprocess,
      sourceMediaId: sourceMediaId,
      reprocessOfJobId: parent.id,
    );
    final priorUnresolved = operation.recoveryRequired;
    _checkMutation(scope);
    operation = await _beginProcessingAttempt(scope, operation);
    late ProcessingJobRecord accepted;
    try {
      await _requireCurrentCapability(
        scope,
        parent.meetingId,
        MeetingOperation.admitProcessing,
        capabilities,
      );
      _checkMutation(scope);
      accepted = await processingRepository.admit(
        parent.meetingId,
        ProcessingAdmissionRequest(
          mediaId: sourceMediaId,
          reprocessOfJobId: parent.id,
        ),
        idempotencyKey: operation.idempotencyKey,
        sessionScope: scope,
      );
      api.requireCurrentAuthenticatedSession(scope);
      _validateAcceptedJobIdentity(accepted, parent.meetingId, sourceMediaId);
      if (accepted.reprocessOfJobId?.toLowerCase() != parent.id.toLowerCase() ||
          accepted.id.toLowerCase() == parent.id.toLowerCase()) {
        throw const ApiFailure(
          502,
          'PROCESSING_INVALID_RESPONSE',
          'The reprocessing result has an unexpected parent identity.',
        );
      }
    } catch (error) {
      final failure = _processingFailure(
        error,
        code: 'PROCESSING_REPROCESS_FAILED',
        message: 'The reprocessing request could not be completed.',
      );
      final ambiguous = _processingOutcomeAmbiguous(failure);
      await localMedia.updateProcessingOperation(
        operation,
        scope: scope,
        attemptCount: operation.attemptCount,
        attemptOutcome: failure.code == 'PROCESSING_SHUTDOWN'
            ? OperationAttemptOutcome.interrupted
            : ambiguous
            ? OperationAttemptOutcome.uncertain
            : OperationAttemptOutcome.rejected,
        recoveryRequired:
            priorUnresolved ||
            failure.code == 'PROCESSING_SHUTDOWN' ||
            ambiguous,
        failureCode: failure.code,
        failureStatus: failure.status,
        failureMessage: failure.message,
      );
      rethrow;
    }
    await localMedia.updateProcessingOperation(
      operation,
      scope: scope,
      checkpoint: ProcessingOperationCheckpoint.reprocessConfirmed,
      resultingJobId: accepted.id,
      attemptCount: operation.attemptCount,
      attemptOutcome: OperationAttemptOutcome.succeeded,
      recoveryRequired: false,
    );
    unawaited(_refreshConfirmedMutation(parent.meetingId, scope));
    return accepted;
  }

  void _requireExpectedOperation(
    ProcessingOperation? operation,
    String? expectedOperationId,
  ) {
    if (expectedOperationId != null && operation?.id != expectedOperationId) {
      throw const ApiFailure(
        409,
        'PROCESSING_RECONCILIATION_REQUIRED',
        'The selected recovery operation is no longer unresolved.',
      );
    }
  }

  Future<void> _refreshConfirmedMutation(
    String meetingId,
    AuthenticatedSessionScope scope,
  ) async {
    if (_disposed ||
        _shuttingDown ||
        !api.isCurrentAuthenticatedSession(scope)) {
      return;
    }
    try {
      await refresh(meetingId, scope: scope, explicit: true);
    } catch (error) {
      if (_disposed ||
          _shuttingDown ||
          !api.isCurrentAuthenticatedSession(scope)) {
        return;
      }
      final key = _key(scope, meetingId);
      final current = _states[key];
      if (current != null && current.sessionScope == scope) {
        _states[key] = current.copyWith(isRefreshing: false, failure: error);
        notifyListeners();
      }
    }
  }

  TranscriptReviewHandoff? reviewHandoff(ProcessingJobRecord job) {
    if (!job.isWaitingForReview) return null;
    return TranscriptReviewHandoff(
      meetingId: job.meetingId,
      jobId: job.id,
      sourceMediaId: job.sourceMediaId,
    );
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.inactive) {
      _backgrounded = true;
      for (final key in _timers.keys.toList()) {
        _cancelTimer(key);
      }
    } else if (state == AppLifecycleState.resumed) {
      _backgrounded = false;
      for (final entry in _scopes.entries) {
        if ((_consumers[entry.key] ?? 0) > 0) {
          final meetingId = _meetingForKey[entry.key];
          if (meetingId != null) {
            unawaited(refresh(meetingId, scope: entry.value, explicit: true));
          }
        }
      }
    }
  }

  Duration _intervalFor(
    List<ProcessingJobRecord> jobs,
    bool changed,
    String observationKey,
  ) {
    final active = jobs.any(
      (job) =>
          job.status == ProcessingJobStatus.pending ||
          job.status == ProcessingJobStatus.queued ||
          job.status == ProcessingJobStatus.running,
    );
    if (!active) return const Duration(seconds: 30);
    if (changed || (_unchangedRefreshes[observationKey] ?? 0) == 0) {
      return const Duration(seconds: 5);
    }
    return const Duration(seconds: 15);
  }

  void _schedule(
    String key,
    String meetingId,
    AuthenticatedSessionScope scope,
    Duration duration, {
    required int generation,
  }) {
    _cancelTimer(key);
    if (_backgrounded || (_consumers[key] ?? 0) == 0) return;
    _timers[key] = Timer(duration, () {
      _timers.remove(key);
      if (!_backgrounded &&
          (_consumers[key] ?? 0) > 0 &&
          _scopes[key] == scope &&
          _observationGenerations[key] == generation &&
          !_disposed &&
          !_shuttingDown) {
        unawaited(refresh(meetingId, scope: scope, generation: generation));
      }
    });
  }

  void _cancelTimer(String key) {
    _timers.remove(key)?.cancel();
  }

  /// Fences new observations and processing mutations before shared
  /// application resources are released.
  void beginShutdown() {
    if (_shuttingDown) return;
    _shuttingDown = true;
    for (final key in _timers.keys.toList(growable: false)) {
      _cancelTimer(key);
    }
  }

  /// Original futures may outlive the bounded shutdown wait.
  Future<void> drainActiveWork() async {
    await Future.wait<void>(
      <Future<void>>[
        ..._inFlight.values,
        ..._mutationFlights.values.map((future) => future.then<void>((_) {})),
      ].map(
        (future) =>
            future.then<void>((_) {}, onError: (Object _, StackTrace __) {}),
      ),
    );
  }

  Future<void> shutdown() {
    final existing = _shutdownFuture;
    if (existing != null) return existing;
    final future = () async {
      beginShutdown();
      final active = <Future<void>>[
        ..._inFlight.values,
        ..._mutationFlights.values.map((value) => value.then<void>((_) {})),
      ];
      if (active.isEmpty) return;
      try {
        await Future.wait(active).timeout(const Duration(seconds: 6));
      } catch (_) {
        // Remote observation/mutation state is durable elsewhere or remains
        // explicitly recoverable; shutdown must not block forever on network.
      }
    }();
    _shutdownFuture = future;
    return future;
  }

  Future<ProcessingOperation?> _unresolvedOperation({
    required AuthenticatedSessionScope scope,
    required String meetingId,
    String? remoteJobId,
    String? sourceMediaId,
    required ProcessingOperationType type,
    String? reprocessOfJobId,
  }) async {
    final operations = await localMedia.listProcessingOperations(
      scope: scope,
      meetingId: meetingId,
      remoteJobId: remoteJobId,
      sourceMediaId: sourceMediaId,
    );
    final matches = operations
        .where(
          (operation) =>
              operation.operationType == type &&
              operation.reprocessOfJobId == reprocessOfJobId &&
              (!_processingConfirmed(operation) ||
                  operation.recoveryRequired ||
                  operation.attemptOutcome ==
                      OperationAttemptOutcome.uncertain ||
                  operation.attemptOutcome ==
                      OperationAttemptOutcome.interrupted ||
                  operation.attemptOutcome ==
                      OperationAttemptOutcome.cancelled),
        )
        .toList(growable: false);
    if (matches.length > 1) {
      throw const ApiFailure(
        409,
        'PROCESSING_RECONCILIATION_REQUIRED',
        'Multiple durable processing attempts require reconciliation.',
      );
    }
    return matches.isEmpty ? null : matches.single;
  }

  Future<ProcessingOperation> _beginProcessingAttempt(
    AuthenticatedSessionScope scope,
    ProcessingOperation operation,
  ) => localMedia.updateProcessingOperation(
    operation,
    scope: scope,
    attemptCount: operation.attemptCount + 1,
    attemptOutcome: OperationAttemptOutcome.uncertain,
    recoveryRequired: true,
  );

  bool _processingConfirmed(ProcessingOperation operation) =>
      operation.resultingJobId != null &&
      switch (operation.operationType) {
        ProcessingOperationType.admission =>
          operation.checkpoint ==
              ProcessingOperationCheckpoint.admissionConfirmed,
        ProcessingOperationType.retry =>
          operation.checkpoint == ProcessingOperationCheckpoint.retryConfirmed,
        ProcessingOperationType.reprocess =>
          operation.checkpoint ==
              ProcessingOperationCheckpoint.reprocessConfirmed,
      };

  void _checkMutation(AuthenticatedSessionScope scope) {
    if (_disposed || _shuttingDown) {
      throw const ApiFailure(
        0,
        'PROCESSING_SHUTDOWN',
        'Processing actions are unavailable while the application is shutting down.',
      );
    }
    api.requireCurrentAuthenticatedSession(scope);
  }

  ApiFailure _processingFailure(
    Object error, {
    required String code,
    required String message,
  }) {
    if (error is MediaRepositoryFailure &&
        error.mutationOutcome == MediaMutationOutcome.unknown &&
        !error.remoteOutcomeAmbiguous) {
      return ApiFailure(
        error.status,
        error.code,
        error.message,
        requestId: error.requestId,
        responseRequestId: error.responseRequestId,
        timestamp: error.timestamp,
        errors: error.errors,
        retryAfter: error.retryAfter,
        headers: error.headers,
        isTransportFailure: error.isTransportFailure,
        remoteOutcomeAmbiguous: true,
      );
    }
    if (error is ApiFailure) return error;
    return ApiFailure(
      0,
      code,
      message,
      isTransportFailure: true,
      remoteOutcomeAmbiguous: true,
    );
  }

  bool _processingOutcomeAmbiguous(ApiFailure failure) =>
      failure.remoteOutcomeAmbiguous ||
      failure.isTransportFailure ||
      failure.invalidResponse ||
      failure.status == 401 ||
      failure.status >= 500;

  void _validateAcceptedJob(
    ProcessingJobRecord accepted,
    ProcessingJobRecord requested,
  ) {
    _validateAcceptedJobIdentity(
      accepted,
      requested.meetingId,
      requested.sourceMediaId,
    );
    if (accepted.id.toLowerCase() != requested.id.toLowerCase()) {
      throw const ApiFailure(
        502,
        'PROCESSING_RESPONSE_MISMATCH',
        'The processing retry response does not match the requested job.',
        remoteOutcomeAmbiguous: true,
      );
    }
  }

  void _validateAcceptedJobIdentity(
    ProcessingJobRecord accepted,
    String meetingId,
    String? sourceMediaId,
  ) {
    if (accepted.meetingId.toLowerCase() != meetingId.toLowerCase() ||
        sourceMediaId != null &&
            accepted.sourceMediaId?.toLowerCase() !=
                sourceMediaId.toLowerCase()) {
      throw const ApiFailure(
        502,
        'PROCESSING_RESPONSE_MISMATCH',
        'The processing response does not match the requested media.',
        remoteOutcomeAmbiguous: true,
      );
    }
  }

  Future<void> _requireCurrentCapability(
    AuthenticatedSessionScope scope,
    String meetingId,
    MeetingOperation operation,
    MeetingCapabilities? fallback,
  ) async {
    api.requireCurrentAuthenticatedSession(scope);
    final resolver = capabilityResolver;
    if (resolver == null) {
      if (fallback == null || !fallback.allows(operation)) {
        throw const ApiFailure(
          403,
          'PROCESSING_CAPABILITY_REQUIRED',
          'The current meeting capability does not allow this processing operation.',
        );
      }
      return;
    }
    final current = await resolver(meetingId, scope);
    api.requireCurrentAuthenticatedSession(scope);
    if (current == null || !current.allows(operation)) {
      throw const ApiFailure(
        403,
        'PROCESSING_CAPABILITY_REQUIRED',
        'The current meeting capability does not allow this processing operation.',
      );
    }
  }

  Future<void> _requireCurrentReadCapability(
    AuthenticatedSessionScope scope,
    String meetingId,
  ) async {
    api.requireCurrentAuthenticatedSession(scope);
    final resolver = capabilityResolver;
    if (resolver == null) return;
    final current = await resolver(meetingId, scope);
    api.requireCurrentAuthenticatedSession(scope);
    if (current == null || !current.allows(MeetingOperation.readMedia)) {
      throw const ApiFailure(
        403,
        'PROCESSING_CAPABILITY_REQUIRED',
        'The current meeting capability does not allow processing observation.',
      );
    }
  }

  bool _sameRemoteInventory(
    List<MediaRecord> oldMedia,
    List<ProcessingJobRecord> oldJobs,
    List<MediaRecord> newMedia,
    List<ProcessingJobRecord> newJobs,
  ) {
    String mediaKey(List<MediaRecord> values) => values
        .map(
          (item) => '${item.id}:${item.status.wireValue}:${item.availableAt}',
        )
        .join('|');
    String jobKey(List<ProcessingJobRecord> values) => values
        .map((item) => '${item.id}:${item.status.wireValue}:${item.updatedAt}')
        .join('|');
    return mediaKey(oldMedia) == mediaKey(newMedia) &&
        jobKey(oldJobs) == jobKey(newJobs);
  }

  String _key(AuthenticatedSessionScope scope, String meetingId) =>
      '${scope.deploymentScope}\u0000${scope.userId}\u0000'
      '${scope.lifecycleEpoch}\u0000$meetingId';

  void _sessionChanged() {
    final current = api.authenticatedSessionScope;
    final obsolete = _scopes.entries
        .where(
          (entry) =>
              current == null ||
              _key(current, _meetingForKey[entry.key] ?? '') != entry.key,
        )
        .map((entry) => entry.key)
        .toList(growable: false);
    for (final key in obsolete) {
      _cancelTimer(key);
      _observationGenerations[key] = (_observationGenerations[key] ?? 0) + 1;
      _consumers.remove(key);
      _scopes.remove(key);
      _inFlight.remove(key);
      _unchangedRefreshes.remove(key);
      _failureCounts.remove(key);
      _states.remove(key);
      _meetingForKey.remove(key);
    }
    if (obsolete.isNotEmpty && !_disposed) notifyListeners();
  }

  String _newKey() {
    final random = Random.secure();
    return List<int>.generate(
      16,
      (_) => random.nextInt(256),
    ).map((value) => value.toRadixString(16).padLeft(2, '0')).join();
  }

  @override
  void dispose() {
    if (_disposed) return;
    beginShutdown();
    unawaited(shutdown());
    _disposed = true;
    if (_lifecycleObserverRegistered) {
      WidgetsBinding.instance.removeObserver(this);
    }
    api.removeListener(_sessionChanged);
    for (final timer in _timers.values) {
      timer.cancel();
    }
    _timers.clear();
    _states.clear();
    _scopes.clear();
    _consumers.clear();
    _inFlight.clear();
    _observationGenerations.clear();
    _failureCounts.clear();
    super.dispose();
  }
}
