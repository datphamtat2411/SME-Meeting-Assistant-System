import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';

import '../../core/api_client.dart';
import '../meetings/meeting_foundation.dart';
import 'local_media_models.dart';
import 'local_media_repository.dart';
import 'media_contracts.dart';
import 'media_repository.dart';
import 'processing_repository.dart';

enum SubmissionLifecycleState {
  localReady,
  intentPending,
  intentCreated,
  transferring,
  transferred,
  finalizing,
  mediaAvailable,
  processingAdmissionPending,
  processingAccepted,
  recoverableFailure,
  cancelled,
  waitingForConnectivity,
  reconciliationRequired,
  definitiveRejection,
  authorizationConflict,
}

class SubmissionState {
  const SubmissionState({
    required this.lifecycle,
    required this.assetId,
    this.meetingId,
    this.uploadOperation,
    this.processingOperation,
    this.media,
    this.job,
    this.progress,
    this.failure,
    this.message,
    this.sessionScope,
  });

  final SubmissionLifecycleState lifecycle;
  final String assetId;
  final String? meetingId;
  final UploadOperation? uploadOperation;
  final ProcessingOperation? processingOperation;
  final MediaRecord? media;
  final ProcessingJobRecord? job;
  final double? progress;
  final Object? failure;
  final String? message;
  final AuthenticatedSessionScope? sessionScope;

  bool get remoteMediaAvailable => media?.status == MediaStatus.available;
  bool get processingAdmitted =>
      lifecycle == SubmissionLifecycleState.processingAccepted;
  bool get requiresReconciliation =>
      lifecycle == SubmissionLifecycleState.reconciliationRequired;

  SubmissionState copyWith({
    SubmissionLifecycleState? lifecycle,
    String? meetingId,
    UploadOperation? uploadOperation,
    ProcessingOperation? processingOperation,
    MediaRecord? media,
    ProcessingJobRecord? job,
    double? progress,
    Object? failure,
    String? message,
    AuthenticatedSessionScope? sessionScope,
  }) => SubmissionState(
    lifecycle: lifecycle ?? this.lifecycle,
    assetId: assetId,
    meetingId: meetingId ?? this.meetingId,
    uploadOperation: uploadOperation ?? this.uploadOperation,
    processingOperation: processingOperation ?? this.processingOperation,
    media: media ?? this.media,
    job: job ?? this.job,
    progress: progress ?? this.progress,
    failure: failure ?? this.failure,
    message: message ?? this.message,
    sessionScope: sessionScope ?? this.sessionScope,
  );
}

typedef SubmissionCoordinatorState = SubmissionState;

class SubmissionReconciliationException implements Exception {
  const SubmissionReconciliationException(this.message);

  final String message;

  @override
  String toString() => message;
}

/// Durable owner of local-media submission and initial processing admission.
/// Remote inventory and ongoing job observation belong to [ProcessingManager].
class SubmissionCoordinator extends ChangeNotifier {
  SubmissionCoordinator({
    required this.api,
    required this.localMedia,
    required this.mediaRepository,
    required this.processingRepository,
    DateTime Function()? now,
    Future<void> Function(Duration)? delay,
    int automaticRetries = 2,
  }) : _now = now ?? DateTime.now,
       _delay = delay ?? ((duration) => Future<void>.delayed(duration)),
       _automaticRetries = automaticRetries.clamp(0, 2) {
    api.addListener(_sessionChanged);
  }

  final ApiClient api;
  final LocalMediaRepository localMedia;
  final MediaRepository mediaRepository;
  final ProcessingRepository processingRepository;
  final DateTime Function() _now;
  final Future<void> Function(Duration) _delay;
  final int _automaticRetries;

  final Map<String, SubmissionState> _states = <String, SubmissionState>{};
  final Map<String, Future<SubmissionState>> _active =
      <String, Future<SubmissionState>>{};
  final Map<String, UploadCancellationToken> _cancellation =
      <String, UploadCancellationToken>{};
  bool _disposed = false;

  SubmissionState? stateFor(String assetId) => _states[assetId];

  List<SubmissionState> get states =>
      List<SubmissionState>.unmodifiable(_states.values);

  Future<SubmissionState> submit({
    required LocalMediaAsset asset,
    MeetingCapabilities? capabilities,
    bool admitProcessing = true,
  }) {
    final existing = _active[asset.id];
    if (existing != null) return existing;
    final scope = api.requireAuthenticatedSessionScope();
    _requireCapability(capabilities, MeetingOperation.uploadMedia);
    final meetingId = asset.meetingId;
    if (meetingId == null || meetingId.isEmpty) {
      throw const LocalMediaUnavailableException();
    }
    final future = _execute(
      scope: scope,
      asset: asset,
      capabilities: capabilities,
      admitProcessing: admitProcessing,
    );
    _active[asset.id] = future;
    unawaited(
      future.whenComplete(() {
        if (identical(_active[asset.id], future)) _active.remove(asset.id);
      }),
    );
    return future;
  }

  Future<SubmissionState> resume({
    required String operationId,
    required AuthenticatedSessionScope scope,
    MeetingCapabilities? capabilities,
    bool admitProcessing = true,
  }) async {
    api.requireCurrentAuthenticatedSession(scope);
    final operations = await localMedia.listUploadOperations(scope: scope);
    final operation = operations.firstWhere(
      (candidate) => candidate.id == operationId,
      orElse: () => throw StateError('The upload operation was not found.'),
    );
    final asset = await localMedia.findReadyAsset(
      scope: scope,
      assetId: operation.assetId,
      meetingId: operation.meetingId,
    );
    return submit(
      asset: asset,
      capabilities: capabilities,
      admitProcessing: admitProcessing,
    );
  }

  void cancel(String assetId) {
    _cancellation[assetId]?.cancel();
  }

  Future<SubmissionState> admitAvailableMedia({
    required String meetingId,
    required String mediaId,
    required AuthenticatedSessionScope scope,
    MeetingCapabilities? capabilities,
    bool reprocess = false,
    String? reprocessOfJobId,
  }) async {
    api.requireCurrentAuthenticatedSession(scope);
    _requireCapability(capabilities, MeetingOperation.admitProcessing);
    final media = await _withTransientRetries(
      () => mediaRepository.getMedia(meetingId, mediaId, sessionScope: scope),
      phase: 'media-read',
    );
    if (!media.accepted) {
      throw const SubmissionReconciliationException(
        'Only accepted remote media can enter processing.',
      );
    }
    final operationType = reprocess
        ? ProcessingOperationType.reprocess
        : ProcessingOperationType.admission;
    var operation = await _findProcessingOperation(
      scope: scope,
      meetingId: meetingId,
      sourceMediaId: mediaId,
      operationType: operationType,
      reprocessOfJobId: reprocessOfJobId,
    );
    operation ??= await localMedia.beginProcessingOperation(
      scope: scope,
      meetingId: meetingId,
      idempotencyKey: _newKey(),
      operationType: operationType,
      sourceMediaId: mediaId,
      reprocessOfJobId: reprocessOfJobId,
    );
    return _admitProcessing(
      scope: scope,
      meetingId: meetingId,
      media: media,
      operation: operation,
      capabilities: capabilities,
      assetId: 'remote:$mediaId',
    );
  }

  Future<SubmissionState> _execute({
    required AuthenticatedSessionScope scope,
    required LocalMediaAsset asset,
    required MeetingCapabilities? capabilities,
    required bool admitProcessing,
  }) async {
    var uploadOperation = await _existingOrNewUpload(scope, asset);
    var current = SubmissionState(
      lifecycle: SubmissionLifecycleState.localReady,
      assetId: asset.id,
      meetingId: asset.meetingId,
      uploadOperation: uploadOperation,
      sessionScope: scope,
    );
    _publish(current);
    MediaRecord? media;
    ProcessingOperation? processingOperation;
    try {
      media = await _reconcileOrUpload(
        scope: scope,
        asset: asset,
        operation: uploadOperation,
        capabilities: capabilities,
      );
      uploadOperation = _states[asset.id]?.uploadOperation ?? uploadOperation;
      current = _states[asset.id] ?? current;
      if (!media.accepted) {
        return _publish(
          current.copyWith(
            lifecycle: SubmissionLifecycleState.definitiveRejection,
            media: media,
            message: 'Remote media was rejected.',
          ),
        );
      }
      if (!admitProcessing) {
        return _publish(
          current.copyWith(
            lifecycle: SubmissionLifecycleState.mediaAvailable,
            media: media,
          ),
        );
      }
      _requireCapability(capabilities, MeetingOperation.admitProcessing);
      processingOperation = await _existingOrNewProcessing(
        scope: scope,
        meetingId: asset.meetingId!,
        sourceMediaId: media.id,
        operationType: ProcessingOperationType.admission,
      );
      return await _admitProcessing(
        scope: scope,
        meetingId: asset.meetingId!,
        media: media,
        operation: processingOperation,
        capabilities: capabilities,
        assetId: asset.id,
      );
    } catch (error) {
      final failed = _states[asset.id] ?? current;
      final failure = _asApiFailure(error);
      if (processingOperation != null) {
        await _recordProcessingFailure(scope, processingOperation, failure);
        final retainedMedia = media ?? failed.media;
        if (retainedMedia?.accepted == true) {
          return _publish(
            failed.copyWith(
              lifecycle: SubmissionLifecycleState.mediaAvailable,
              media: retainedMedia,
              processingOperation: processingOperation,
              failure: error,
              message:
                  'Media is available; processing admission can be retried.',
            ),
          );
        }
      }
      await _recordUploadFailure(scope, uploadOperation, failure);
      final lifecycle = _failureLifecycle(error);
      return _publish(
        failed.copyWith(
          lifecycle: lifecycle,
          failure: error,
          message: _messageFor(lifecycle),
        ),
      );
    }
  }

  Future<MediaRecord> _reconcileOrUpload({
    required AuthenticatedSessionScope scope,
    required LocalMediaAsset asset,
    required UploadOperation operation,
    required MeetingCapabilities? capabilities,
  }) async {
    var current = operation;
    if (current.remoteMediaId != null) {
      final remote = await _withTransientRetries(
        () => mediaRepository.getMedia(
          current.meetingId,
          current.remoteMediaId!,
          sessionScope: scope,
        ),
        phase: 'media-reconciliation',
      );
      _validateRemoteMedia(remote, current);
      if (remote.accepted) {
        current = await _confirmFinalization(scope, current, remote);
        _publish(
          SubmissionState(
            lifecycle: SubmissionLifecycleState.mediaAvailable,
            assetId: asset.id,
            meetingId: asset.meetingId,
            uploadOperation: current,
            media: remote,
            sessionScope: scope,
          ),
        );
        return remote;
      }
      if (remote.rejected || remote.failed) {
        return remote;
      }
      // A pending resource with a prior binary checkpoint can be finalized
      // without re-uploading the source. A pending intent without transfer
      // evidence must obtain a capability through same-key replay.
      if (current.checkpoint ==
              UploadOperationCheckpoint.binaryTransferConfirmed ||
          current.checkpoint ==
              UploadOperationCheckpoint.finalizationConfirmed ||
          current.attemptOutcome == OperationAttemptOutcome.uncertain) {
        final finalized = await _finalizePending(
          scope: scope,
          asset: asset,
          operation: current,
        );
        return finalized;
      }
    }

    var intent = await _intentWithRetries(
      scope: scope,
      operation: current,
      capabilities: capabilities,
    );
    current = _states[asset.id]?.uploadOperation ?? current;
    if (intent.status == MediaStatus.available) {
      final available = await mediaRepository.getMedia(
        current.meetingId,
        intent.mediaId,
        sessionScope: scope,
      );
      _validateRemoteMedia(available, current);
      if (!available.accepted) return available;
      current = await _confirmFinalization(scope, current, available);
      _publishMediaAvailable(scope, asset, current, available);
      return available;
    }
    if (intent.status == MediaStatus.rejected ||
        intent.status == MediaStatus.failed) {
      final rejected = await mediaRepository.getMedia(
        current.meetingId,
        intent.mediaId,
        sessionScope: scope,
      );
      return rejected;
    }
    if (!intent.hasUploadCapability) {
      final observed = await mediaRepository.getMedia(
        current.meetingId,
        intent.mediaId,
        sessionScope: scope,
      );
      if (observed.accepted) {
        current = await _confirmFinalization(scope, current, observed);
        _publishMediaAvailable(scope, asset, current, observed);
        return observed;
      }
      throw const SubmissionReconciliationException(
        'The pending media resource did not provide an upload capability.',
      );
    }

    final file = await localMedia.fileFor(scope: scope, asset: asset);
    _publish(
      SubmissionState(
        lifecycle: SubmissionLifecycleState.intentCreated,
        assetId: asset.id,
        meetingId: asset.meetingId,
        uploadOperation: current,
        sessionScope: scope,
      ),
    );
    var uploadAttempt = 0;
    while (true) {
      final cancellation = UploadCancellationToken();
      _cancellation[asset.id] = cancellation;
      try {
        _publish(
          SubmissionState(
            lifecycle: SubmissionLifecycleState.transferring,
            assetId: asset.id,
            meetingId: asset.meetingId,
            uploadOperation: current,
            progress: 0,
            sessionScope: scope,
          ),
        );
        await localMedia.withAssetProtection(
          scope: scope,
          assetId: asset.id,
          action: () => api.uploadSigned(
            intent.uploadUrl!,
            file,
            intent.requiredContentType,
            session: scope,
            expectedLength: current.expectedSizeBytes,
            expiresAt: intent.expiresAt!,
            cancellationToken: cancellation,
            onProgress: (sent, total) {
              if (total <= 0 || !api.isCurrentAuthenticatedSession(scope)) {
                return;
              }
              _publish(
                SubmissionState(
                  lifecycle: SubmissionLifecycleState.transferring,
                  assetId: asset.id,
                  meetingId: asset.meetingId,
                  uploadOperation: current,
                  progress: sent / total,
                  sessionScope: scope,
                ),
              );
            },
          ),
        );
        current = await localMedia.updateUploadOperation(
          current,
          scope: scope,
          checkpoint: UploadOperationCheckpoint.binaryTransferConfirmed,
          confirmedBytes: current.expectedSizeBytes,
          attemptCount: current.attemptCount + 1,
          attemptOutcome: OperationAttemptOutcome.succeeded,
          recoveryRequired: false,
        );
        _publish(
          SubmissionState(
            lifecycle: SubmissionLifecycleState.transferred,
            assetId: asset.id,
            meetingId: asset.meetingId,
            uploadOperation: current,
            progress: 1,
            sessionScope: scope,
          ),
        );
        break;
      } catch (error) {
        if (_isCapabilityFailure(error) && uploadAttempt < 1) {
          uploadAttempt++;
          intent = await _intentWithRetries(
            scope: scope,
            operation: current,
            capabilities: capabilities,
          );
          continue;
        }
        rethrow;
      } finally {
        _cancellation.remove(asset.id);
      }
    }

    return _finalizePending(scope: scope, asset: asset, operation: current);
  }

  Future<MediaRecord> _finalizePending({
    required AuthenticatedSessionScope scope,
    required LocalMediaAsset asset,
    required UploadOperation operation,
  }) async {
    _publish(
      SubmissionState(
        lifecycle: SubmissionLifecycleState.finalizing,
        assetId: asset.id,
        meetingId: asset.meetingId,
        uploadOperation: operation,
        progress: 1,
        sessionScope: scope,
      ),
    );
    final media = await _withTransientRetries(
      () => mediaRepository.finalizeUpload(
        operation.meetingId,
        operation.remoteMediaId!,
        sessionScope: scope,
      ),
      phase: 'finalization',
    );
    _validateRemoteMedia(media, operation);
    if (!media.accepted) return media;
    final confirmed = await _confirmFinalization(scope, operation, media);
    _publishMediaAvailable(scope, asset, confirmed, media);
    return media;
  }

  Future<MediaUploadIntent> _intentWithRetries({
    required AuthenticatedSessionScope scope,
    required UploadOperation operation,
    required MeetingCapabilities? capabilities,
  }) async {
    _requireCapability(capabilities, MeetingOperation.uploadMedia);
    _publish(
      SubmissionState(
        lifecycle: SubmissionLifecycleState.intentPending,
        assetId: operation.assetId,
        meetingId: operation.meetingId,
        uploadOperation: operation,
        sessionScope: scope,
      ),
    );
    final request = MediaUploadRequest(
      sourceType: operation.sourceType == LocalMediaSourceType.recording
          ? MediaSourceType.recording
          : MediaSourceType.upload,
      originalFilename: operation.originalFilename,
      contentType: operation.contentType,
      expectedSizeBytes: operation.expectedSizeBytes,
    );
    final intent = await _withTransientRetries(
      () => mediaRepository.createUploadIntent(
        operation.meetingId,
        request,
        idempotencyKey: operation.idempotencyKey,
        sessionScope: scope,
      ),
      phase: 'upload-intent',
    );
    if (intent.mediaId.trim().isEmpty) {
      throw const SubmissionReconciliationException(
        'The upload intent did not identify a remote media resource.',
      );
    }
    if (intent.requiredContentType != operation.contentType) {
      throw const SubmissionReconciliationException(
        'The remote upload capability is incompatible with the source media.',
      );
    }
    final current = await localMedia.updateUploadOperation(
      operation,
      scope: scope,
      checkpoint: UploadOperationCheckpoint.intentConfirmed,
      remoteMediaId: intent.mediaId,
      attemptCount: operation.attemptCount + 1,
      attemptOutcome: OperationAttemptOutcome.succeeded,
      recoveryRequired: false,
    );
    _publish(
      SubmissionState(
        lifecycle: SubmissionLifecycleState.intentCreated,
        assetId: operation.assetId,
        meetingId: operation.meetingId,
        uploadOperation: current,
        sessionScope: scope,
      ),
    );
    return intent;
  }

  Future<UploadOperation> _confirmFinalization(
    AuthenticatedSessionScope scope,
    UploadOperation operation,
    MediaRecord media,
  ) async => localMedia.updateUploadOperation(
    operation,
    scope: scope,
    checkpoint: UploadOperationCheckpoint.finalizationConfirmed,
    remoteMediaId: media.id,
    confirmedBytes: operation.expectedSizeBytes,
    attemptCount: operation.attemptCount + 1,
    attemptOutcome: OperationAttemptOutcome.succeeded,
    recoveryRequired: false,
  );

  Future<SubmissionState> _admitProcessing({
    required AuthenticatedSessionScope scope,
    required String meetingId,
    required MediaRecord media,
    required ProcessingOperation operation,
    required MeetingCapabilities? capabilities,
    required String assetId,
  }) async {
    _requireCapability(capabilities, MeetingOperation.admitProcessing);
    final confirmedCheckpoint = switch (operation.operationType) {
      ProcessingOperationType.admission =>
        ProcessingOperationCheckpoint.admissionConfirmed,
      ProcessingOperationType.retry =>
        ProcessingOperationCheckpoint.retryConfirmed,
      ProcessingOperationType.reprocess =>
        ProcessingOperationCheckpoint.reprocessConfirmed,
    };
    if (operation.checkpoint == confirmedCheckpoint &&
        operation.resultingJobId != null) {
      final existingJob = await processingRepository.get(
        operation.resultingJobId!,
        sessionScope: scope,
      );
      return _publish(
        SubmissionState(
          lifecycle: SubmissionLifecycleState.processingAccepted,
          assetId: assetId,
          meetingId: meetingId,
          processingOperation: operation,
          media: media,
          job: existingJob,
          sessionScope: scope,
        ),
      );
    }
    _publish(
      SubmissionState(
        lifecycle: SubmissionLifecycleState.processingAdmissionPending,
        assetId: assetId,
        meetingId: meetingId,
        processingOperation: operation,
        media: media,
        sessionScope: scope,
      ),
    );
    final accepted = await _withTransientRetries(
      () => processingRepository.admit(
        meetingId,
        ProcessingAdmissionRequest(
          mediaId: media.id,
          reprocessOfJobId: operation.reprocessOfJobId,
        ),
        idempotencyKey: operation.idempotencyKey,
        sessionScope: scope,
      ),
      phase: 'processing-admission',
    );
    final confirmed = await localMedia.updateProcessingOperation(
      operation,
      scope: scope,
      checkpoint: switch (operation.operationType) {
        ProcessingOperationType.admission =>
          ProcessingOperationCheckpoint.admissionConfirmed,
        ProcessingOperationType.retry =>
          ProcessingOperationCheckpoint.retryConfirmed,
        ProcessingOperationType.reprocess =>
          ProcessingOperationCheckpoint.reprocessConfirmed,
      },
      resultingJobId: accepted.id,
      attemptCount: operation.attemptCount + 1,
      attemptOutcome: OperationAttemptOutcome.succeeded,
      recoveryRequired: false,
    );
    return _publish(
      SubmissionState(
        lifecycle: SubmissionLifecycleState.processingAccepted,
        assetId: assetId,
        meetingId: meetingId,
        processingOperation: confirmed,
        media: media,
        job: accepted,
        sessionScope: scope,
      ),
    );
  }

  Future<UploadOperation> _existingOrNewUpload(
    AuthenticatedSessionScope scope,
    LocalMediaAsset asset,
  ) async {
    final existing = await localMedia.listUploadOperations(
      scope: scope,
      assetId: asset.id,
    );
    if (existing.isNotEmpty) {
      return existing.firstWhere(
        (operation) =>
            operation.checkpoint !=
                UploadOperationCheckpoint.finalizationConfirmed ||
            operation.recoveryRequired ||
            operation.attemptOutcome == OperationAttemptOutcome.uncertain,
        orElse: () => existing.first,
      );
    }
    return localMedia.beginUploadOperation(
      scope: scope,
      asset: asset,
      idempotencyKey: _newKey(),
    );
  }

  Future<ProcessingOperation> _existingOrNewProcessing({
    required AuthenticatedSessionScope scope,
    required String meetingId,
    required String sourceMediaId,
    required ProcessingOperationType operationType,
    String? reprocessOfJobId,
  }) async {
    final existing = await localMedia.listProcessingOperations(
      scope: scope,
      meetingId: meetingId,
      sourceMediaId: sourceMediaId,
    );
    for (final operation in existing) {
      if (operation.operationType == operationType &&
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
    return localMedia.beginProcessingOperation(
      scope: scope,
      meetingId: meetingId,
      idempotencyKey: _newKey(),
      operationType: operationType,
      sourceMediaId: sourceMediaId,
      reprocessOfJobId: reprocessOfJobId,
    );
  }

  Future<ProcessingOperation?> _findProcessingOperation({
    required AuthenticatedSessionScope scope,
    required String meetingId,
    required String sourceMediaId,
    required ProcessingOperationType operationType,
    String? reprocessOfJobId,
  }) async {
    final operations = await localMedia.listProcessingOperations(
      scope: scope,
      meetingId: meetingId,
      sourceMediaId: sourceMediaId,
    );
    for (final operation in operations) {
      if (operation.operationType == operationType &&
          operation.reprocessOfJobId == reprocessOfJobId) {
        return operation;
      }
    }
    return null;
  }

  Future<void> _recordUploadFailure(
    AuthenticatedSessionScope scope,
    UploadOperation operation,
    ApiFailure failure,
  ) async {
    final outcome = _operationOutcome(failure);
    try {
      await localMedia.updateUploadOperation(
        operation,
        scope: scope,
        attemptCount: operation.attemptCount + 1,
        attemptOutcome: outcome,
        recoveryRequired: outcome == OperationAttemptOutcome.uncertain,
        failureCode: failure.code,
        failureStatus: failure.status,
        failureMessage: failure.message,
      );
    } catch (_) {}
  }

  Future<void> _recordProcessingFailure(
    AuthenticatedSessionScope scope,
    ProcessingOperation operation,
    ApiFailure failure,
  ) async {
    final outcome = _operationOutcome(failure);
    try {
      await localMedia.updateProcessingOperation(
        operation,
        scope: scope,
        attemptCount: operation.attemptCount + 1,
        attemptOutcome: outcome,
        recoveryRequired: outcome == OperationAttemptOutcome.uncertain,
        failureCode: failure.code,
        failureStatus: failure.status,
        failureMessage: failure.message,
      );
    } catch (_) {}
  }

  Future<T> _withTransientRetries<T>(
    Future<T> Function() action, {
    required String phase,
  }) async {
    var attempt = 0;
    while (true) {
      try {
        return await action();
      } catch (error) {
        if (!_retryable(error) || attempt >= _automaticRetries) rethrow;
        final failure = _asApiFailure(error);
        final retryAfter = failure.retryAfterDuration(now: _now());
        final exponential = Duration(milliseconds: 1000 * (1 << attempt));
        final delay = retryAfter != null && retryAfter > exponential
            ? retryAfter
            : exponential;
        await _delay(delay);
        attempt++;
      }
    }
  }

  bool _retryable(Object error) {
    if (error is SubmissionReconciliationException ||
        error is LocalMediaUnavailableException ||
        error is LocalMediaOwnershipException) {
      return false;
    }
    final failure = _asApiFailure(error);
    if (failure.status == 401 ||
        failure.status == 403 ||
        failure.status == 400 ||
        failure.status == 404 ||
        failure.status == 409 ||
        failure.status == 412 ||
        failure.status == 415 ||
        failure.status == 422) {
      return false;
    }
    return failure.isTransportFailure ||
        failure.status == 408 ||
        failure.status == 425 ||
        failure.status == 429 ||
        failure.status >= 500;
  }

  ApiFailure _asApiFailure(Object error) {
    if (error is ApiFailure) return error;
    return const ApiFailure(
      0,
      'MEDIA_SUBMISSION_FAILURE',
      'The media submission could not be completed.',
      isTransportFailure: true,
      remoteOutcomeAmbiguous: true,
    );
  }

  OperationAttemptOutcome _operationOutcome(ApiFailure failure) {
    if (failure.remoteOutcomeAmbiguous || failure.isTransportFailure) {
      return OperationAttemptOutcome.uncertain;
    }
    if (failure.status >= 400 && failure.status < 500) {
      return OperationAttemptOutcome.rejected;
    }
    return OperationAttemptOutcome.failed;
  }

  SubmissionLifecycleState _failureLifecycle(Object error) {
    final failure = _asApiFailure(error);
    if (failure.code == 'UPLOAD_CANCELLED') {
      return SubmissionLifecycleState.cancelled;
    }
    if (failure.status == 401 || failure.status == 403) {
      return SubmissionLifecycleState.authorizationConflict;
    }
    if (failure.remoteOutcomeAmbiguous) {
      return SubmissionLifecycleState.reconciliationRequired;
    }
    if (failure.isTransportFailure || failure.status >= 500) {
      return SubmissionLifecycleState.waitingForConnectivity;
    }
    return SubmissionLifecycleState.recoverableFailure;
  }

  String _messageFor(SubmissionLifecycleState lifecycle) => switch (lifecycle) {
    SubmissionLifecycleState.reconciliationRequired =>
      'The remote outcome is uncertain and must be reconciled before retrying.',
    SubmissionLifecycleState.waitingForConnectivity =>
      'The submission can be resumed when connectivity is available.',
    SubmissionLifecycleState.authorizationConflict => 'The current session or meeting authorization no longer permits this action.',
    SubmissionLifecycleState.cancelled => 'Submission was cancelled.',
    _ => 'Submission failed and can be resumed explicitly.',
  };

  bool _isCapabilityFailure(Object error) {
    final failure = _asApiFailure(error);
    return failure.code == 'UPLOAD_CAPABILITY_EXPIRED' ||
        failure.code == 'UPLOAD_CAPABILITY_REQUIRED';
  }

  void _validateRemoteMedia(MediaRecord media, UploadOperation operation) {
    if (media.id.toLowerCase() != operation.remoteMediaId?.toLowerCase() ||
        media.meetingId.toLowerCase() != operation.meetingId.toLowerCase()) {
      throw const SubmissionReconciliationException(
        'The remote media resource does not match the durable submission.',
      );
    }
    if (media.sizeBytes != null &&
        media.sizeBytes != operation.expectedSizeBytes) {
      throw const SubmissionReconciliationException(
        'The remote media size does not match the intended source.',
      );
    }
  }

  void _publishMediaAvailable(
    AuthenticatedSessionScope scope,
    LocalMediaAsset asset,
    UploadOperation operation,
    MediaRecord media,
  ) {
    _publish(
      SubmissionState(
        lifecycle: SubmissionLifecycleState.mediaAvailable,
        assetId: asset.id,
        meetingId: asset.meetingId,
        uploadOperation: operation,
        media: media,
        sessionScope: scope,
      ),
    );
  }

  void _requireCapability(
    MeetingCapabilities? capabilities,
    MeetingOperation operation,
  ) {
    if (capabilities != null && !capabilities.allows(operation)) {
      throw const ApiFailure(
        403,
        'MEDIA_CAPABILITY_REQUIRED',
        'The current meeting capability does not allow this media operation.',
      );
    }
  }

  void _sessionChanged() {
    if (_disposed) return;
    for (final entry in _states.entries.toList()) {
      final scope = entry.value.sessionScope;
      if (scope != null && !api.isCurrentAuthenticatedSession(scope)) {
        _publish(
          entry.value.copyWith(
            lifecycle: SubmissionLifecycleState.authorizationConflict,
            message: 'The authenticated session changed.',
          ),
        );
      }
    }
    for (final token in _cancellation.values) {
      token.cancel();
    }
  }

  SubmissionState _publish(SubmissionState value) {
    if (_disposed) return value;
    _states[value.assetId] = value;
    notifyListeners();
    return value;
  }

  static String _newKey() {
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
    api.removeListener(_sessionChanged);
    for (final token in _cancellation.values) {
      token.cancel();
    }
    _cancellation.clear();
    super.dispose();
  }
}
