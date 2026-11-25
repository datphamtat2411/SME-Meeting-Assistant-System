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
  bool _lifecycleObserverRegistered = false;

  ProcessingMeetingState? stateFor(String meetingId) {
    final scope = api.authenticatedSessionScope;
    return scope == null ? null : _states[_key(scope, meetingId)];
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
    if (_disposed) return Future<void>.value();
    final key = _key(scope, meetingId);
    var activeGeneration = generation ?? _observationGenerations[key];
    if (activeGeneration == null) {
      activeGeneration = 1;
      _observationGenerations[key] = activeGeneration;
    }
    if (explicit && generation == null) {
      activeGeneration++;
      _observationGenerations[key] = activeGeneration;
      _cancelTimer(key);
      force = true;
    }
    if (_observationGenerations[key] != activeGeneration) {
      return Future<void>.value();
    }
    _scopes[key] ??= scope;
    _meetingForKey[key] ??= meetingId;
    final running = _inFlight[key];
    if (running != null && !force) return running;
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
      final results = await Future.wait<Object>(<Future<Object>>[
        mediaRepository.listMedia(meetingId, sessionScope: scope),
        processingRepository.list(meetingId, sessionScope: scope),
      ]);
      if (_disposed ||
          !api.isCurrentAuthenticatedSession(scope) ||
          _scopes[key] != scope ||
          _observationGenerations[key] != generation ||
          (_consumers[key] ?? 0) == 0) {
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
          !api.isCurrentAuthenticatedSession(scope) ||
          _scopes[key] != scope ||
          _observationGenerations[key] != generation ||
          (_consumers[key] ?? 0) == 0) {
        return;
      }
      if (error is ApiFailure && (error.status == 401 || error.status == 403)) {
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
  }) {
    final key = '${_key(scope, job.meetingId)}\u0000retry\u0000${job.id}';
    final running = _mutationFlights[key];
    if (running != null) return running;
    final future = _retryJobInternal(
      job: job,
      scope: scope,
      capabilities: capabilities,
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
    try {
      // The default request is deliberately {}. A current stage is not proof
      // that stage-specific retry is authorized.
      final accepted = await processingRepository.retry(
        job.id,
        idempotencyKey: operation.idempotencyKey,
        sessionScope: scope,
      );
      api.requireCurrentAuthenticatedSession(scope);
      await localMedia.updateProcessingOperation(
        operation,
        scope: scope,
        checkpoint: ProcessingOperationCheckpoint.retryConfirmed,
        resultingJobId: accepted.id,
        attemptCount: operation.attemptCount + 1,
        attemptOutcome: OperationAttemptOutcome.succeeded,
      );
      await refresh(job.meetingId, scope: scope, explicit: true);
      return accepted;
    } catch (error) {
      final failure = error is ApiFailure
          ? error
          : const ApiFailure(
              0,
              'PROCESSING_RETRY_FAILED',
              'The processing retry could not be completed.',
              isTransportFailure: true,
              remoteOutcomeAmbiguous: true,
            );
      await localMedia.updateProcessingOperation(
        operation,
        scope: scope,
        attemptCount: operation.attemptCount + 1,
        attemptOutcome:
            failure.remoteOutcomeAmbiguous || failure.isTransportFailure
            ? OperationAttemptOutcome.uncertain
            : OperationAttemptOutcome.rejected,
        recoveryRequired:
            failure.remoteOutcomeAmbiguous || failure.isTransportFailure,
        failureCode: failure.code,
        failureStatus: failure.status,
        failureMessage: failure.message,
      );
      rethrow;
    }
  }

  Future<ProcessingJobRecord> reprocess({
    required ProcessingJobRecord parent,
    required String sourceMediaId,
    required AuthenticatedSessionScope scope,
    MeetingCapabilities? capabilities,
  }) {
    final key =
        '${_key(scope, parent.meetingId)}\u0000reprocess\u0000'
        '${parent.id}\u0000$sourceMediaId';
    final running = _mutationFlights[key];
    if (running != null) return running;
    final future = _reprocessInternal(
      parent: parent,
      sourceMediaId: sourceMediaId,
      scope: scope,
      capabilities: capabilities,
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
  }) async {
    api.requireCurrentAuthenticatedSession(scope);
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
    operation ??= await localMedia.beginProcessingOperation(
      scope: scope,
      meetingId: parent.meetingId,
      idempotencyKey: _newKey(),
      operationType: ProcessingOperationType.reprocess,
      sourceMediaId: sourceMediaId,
      reprocessOfJobId: parent.id,
    );
    try {
      final accepted = await processingRepository.admit(
        parent.meetingId,
        ProcessingAdmissionRequest(
          mediaId: sourceMediaId,
          reprocessOfJobId: parent.id,
        ),
        idempotencyKey: operation.idempotencyKey,
        sessionScope: scope,
      );
      api.requireCurrentAuthenticatedSession(scope);
      await localMedia.updateProcessingOperation(
        operation,
        scope: scope,
        checkpoint: ProcessingOperationCheckpoint.reprocessConfirmed,
        resultingJobId: accepted.id,
        attemptCount: operation.attemptCount + 1,
        attemptOutcome: OperationAttemptOutcome.succeeded,
      );
      await refresh(parent.meetingId, scope: scope, explicit: true);
      return accepted;
    } catch (error) {
      final failure = error is ApiFailure
          ? error
          : const ApiFailure(
              0,
              'PROCESSING_REPROCESS_FAILED',
              'The reprocessing request could not be completed.',
              isTransportFailure: true,
              remoteOutcomeAmbiguous: true,
            );
      await localMedia.updateProcessingOperation(
        operation,
        scope: scope,
        attemptCount: operation.attemptCount + 1,
        attemptOutcome:
            failure.remoteOutcomeAmbiguous || failure.isTransportFailure
            ? OperationAttemptOutcome.uncertain
            : OperationAttemptOutcome.rejected,
        recoveryRequired:
            failure.remoteOutcomeAmbiguous || failure.isTransportFailure,
        failureCode: failure.code,
        failureStatus: failure.status,
        failureMessage: failure.message,
      );
      rethrow;
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
          !_disposed) {
        unawaited(refresh(meetingId, scope: scope, generation: generation));
      }
    });
  }

  void _cancelTimer(String key) {
    _timers.remove(key)?.cancel();
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
    for (final operation in operations) {
      if (operation.operationType == type &&
          operation.reprocessOfJobId == reprocessOfJobId &&
          operation.checkpoint !=
              ProcessingOperationCheckpoint.admissionConfirmed &&
          operation.checkpoint !=
              ProcessingOperationCheckpoint.retryConfirmed &&
          operation.checkpoint !=
              ProcessingOperationCheckpoint.reprocessConfirmed) {
        return operation;
      }
    }
    return null;
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
