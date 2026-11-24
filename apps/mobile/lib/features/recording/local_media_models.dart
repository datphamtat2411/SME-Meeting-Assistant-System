enum LocalMediaSourceType {
  upload('UPLOAD'),
  recording('RECORDING'),
  importFile('IMPORT'),
  legacy('LEGACY');

  const LocalMediaSourceType(this.wireValue);

  final String wireValue;

  static LocalMediaSourceType fromWireValue(String value) =>
      LocalMediaSourceType.values.firstWhere(
        (candidate) => candidate.wireValue == value,
        orElse: () => throw StateError('Unknown local media source type.'),
      );
}

enum LocalMediaLifecycle {
  creating('CREATING'),
  staged('STAGED'),
  promotionPending('PROMOTION_PENDING'),
  ready('READY'),
  interrupted('INTERRUPTED'),
  missing('MISSING'),
  unavailable('UNAVAILABLE'),
  quarantined('QUARANTINED'),
  discardPending('DISCARD_PENDING'),
  discarded('DISCARDED');

  const LocalMediaLifecycle(this.wireValue);

  final String wireValue;

  static LocalMediaLifecycle fromWireValue(String value) =>
      LocalMediaLifecycle.values.firstWhere(
        (candidate) => candidate.wireValue == value,
        orElse: () => throw StateError('Unknown local media lifecycle.'),
      );
}

enum UploadOperationCheckpoint {
  intentNotConfirmed('INTENT_NOT_CONFIRMED'),
  intentConfirmed('INTENT_CONFIRMED'),
  binaryTransferConfirmed('BINARY_TRANSFER_CONFIRMED'),
  finalizationConfirmed('FINALIZATION_CONFIRMED'),

  /// Retained only for decoding pre-hardening rows. New attempts never use a
  /// failure as a confirmed checkpoint.
  remoteReconciliationRequired('REMOTE_RECONCILIATION_REQUIRED'),
  failed('FAILED');

  const UploadOperationCheckpoint(this.wireValue);

  final String wireValue;

  static UploadOperationCheckpoint fromWireValue(String value) =>
      UploadOperationCheckpoint.values.firstWhere(
        (candidate) => candidate.wireValue == value,
        orElse: () => throw StateError('Unknown upload checkpoint.'),
      );
}

enum OperationAttemptOutcome {
  none('NONE'),
  succeeded('SUCCEEDED'),
  rejected('REJECTED'),
  failed('FAILED'),
  interrupted('INTERRUPTED'),
  cancelled('CANCELLED'),
  uncertain('UNCERTAIN');

  const OperationAttemptOutcome(this.wireValue);

  final String wireValue;

  static OperationAttemptOutcome fromWireValue(String value) =>
      OperationAttemptOutcome.values.firstWhere(
        (candidate) => candidate.wireValue == value,
        orElse: () => throw StateError('Unknown operation attempt outcome.'),
      );
}

enum ProcessingOperationType {
  admission('ADMISSION'),
  retry('RETRY'),
  reprocess('REPROCESS');

  const ProcessingOperationType(this.wireValue);

  final String wireValue;
}

enum ProcessingOperationCheckpoint {
  admissionNotConfirmed('ADMISSION_NOT_CONFIRMED'),
  admissionConfirmed('ADMISSION_CONFIRMED'),
  retryNotConfirmed('RETRY_NOT_CONFIRMED'),
  retryConfirmed('RETRY_CONFIRMED'),
  reprocessNotConfirmed('REPROCESS_NOT_CONFIRMED'),
  reprocessConfirmed('REPROCESS_CONFIRMED'),
  remoteReconciliationRequired('REMOTE_RECONCILIATION_REQUIRED'),
  failed('FAILED');

  const ProcessingOperationCheckpoint(this.wireValue);

  final String wireValue;

  static ProcessingOperationCheckpoint fromWireValue(String value) =>
      ProcessingOperationCheckpoint.values.firstWhere(
        (candidate) => candidate.wireValue == value,
        orElse: () => throw StateError('Unknown processing checkpoint.'),
      );
}

enum LocalMediaMigrationState {
  started('STARTED'),
  completed('COMPLETED'),
  quarantined('QUARANTINED');

  const LocalMediaMigrationState(this.wireValue);

  final String wireValue;

  static LocalMediaMigrationState fromWireValue(String value) =>
      LocalMediaMigrationState.values.firstWhere(
        (candidate) => candidate.wireValue == value,
        orElse: () => throw StateError('Unknown local media migration state.'),
      );
}

class LocalMediaFileIntegrity {
  const LocalMediaFileIntegrity({
    required this.sizeBytes,
    required this.sha256,
  });

  final int sizeBytes;
  final String sha256;
}

class LocalMediaAsset {
  const LocalMediaAsset({
    required this.id,
    required this.deploymentScope,
    required this.ownerUserId,
    required this.meetingId,
    required this.sourceType,
    required this.managedRelativePath,
    required this.stagedRelativePath,
    required this.originalFilename,
    required this.contentType,
    required this.sizeBytes,
    required this.durationMs,
    required this.sha256,
    required this.lifecycle,
    required this.sourceProvenance,
    required this.quarantineReason,
    required this.createdAt,
    required this.updatedAt,
    required this.readyAt,
    required this.version,
  });

  final String id;
  final String deploymentScope;
  final String ownerUserId;
  final String? meetingId;
  final LocalMediaSourceType sourceType;
  final String managedRelativePath;
  final String? stagedRelativePath;
  final String originalFilename;
  final String contentType;
  final int? sizeBytes;
  final int? durationMs;
  final String? sha256;
  final LocalMediaLifecycle lifecycle;
  final String? sourceProvenance;
  final String? quarantineReason;
  final DateTime createdAt;
  final DateTime updatedAt;
  final DateTime? readyAt;
  final int version;

  bool get isReady => lifecycle == LocalMediaLifecycle.ready;
  bool get isRecoverable =>
      lifecycle == LocalMediaLifecycle.ready ||
      lifecycle == LocalMediaLifecycle.staged ||
      lifecycle == LocalMediaLifecycle.interrupted ||
      lifecycle == LocalMediaLifecycle.promotionPending;

  LocalMediaAsset copyWith({
    String? stagedRelativePath,
    int? sizeBytes,
    int? durationMs,
    String? sha256,
    LocalMediaLifecycle? lifecycle,
    String? sourceProvenance,
    String? quarantineReason,
    DateTime? updatedAt,
    DateTime? readyAt,
    int? version,
  }) => LocalMediaAsset(
    id: id,
    deploymentScope: deploymentScope,
    ownerUserId: ownerUserId,
    meetingId: meetingId,
    sourceType: sourceType,
    managedRelativePath: managedRelativePath,
    stagedRelativePath: stagedRelativePath ?? this.stagedRelativePath,
    originalFilename: originalFilename,
    contentType: contentType,
    sizeBytes: sizeBytes ?? this.sizeBytes,
    durationMs: durationMs ?? this.durationMs,
    sha256: sha256 ?? this.sha256,
    lifecycle: lifecycle ?? this.lifecycle,
    sourceProvenance: sourceProvenance ?? this.sourceProvenance,
    quarantineReason: quarantineReason ?? this.quarantineReason,
    createdAt: createdAt,
    updatedAt: updatedAt ?? this.updatedAt,
    readyAt: readyAt ?? this.readyAt,
    version: version ?? this.version,
  );
}

class UploadOperation {
  const UploadOperation({
    required this.id,
    required this.assetId,
    required this.deploymentScope,
    required this.ownerUserId,
    required this.meetingId,
    required this.idempotencyKey,
    required this.requestFingerprint,
    required this.sourceType,
    required this.originalFilename,
    required this.contentType,
    required this.expectedSizeBytes,
    required this.remoteMediaId,
    required this.checkpoint,
    required this.confirmedBytes,
    required this.attemptCount,
    required this.attemptOutcome,
    required this.recoveryRequired,
    required this.lastFailureCode,
    required this.lastFailureStatus,
    required this.lastFailureMessage,
    required this.createdAt,
    required this.updatedAt,
    required this.version,
  });

  final String id;
  final String assetId;
  final String deploymentScope;
  final String ownerUserId;
  final String meetingId;
  final String idempotencyKey;
  final String requestFingerprint;
  final LocalMediaSourceType sourceType;
  final String originalFilename;
  final String contentType;
  final int expectedSizeBytes;
  final String? remoteMediaId;
  final UploadOperationCheckpoint checkpoint;
  final int confirmedBytes;
  final int attemptCount;
  final OperationAttemptOutcome attemptOutcome;
  final bool recoveryRequired;
  final String? lastFailureCode;
  final int? lastFailureStatus;
  final String? lastFailureMessage;
  final DateTime createdAt;
  final DateTime updatedAt;
  final int version;

  UploadOperation copyWith({
    String? remoteMediaId,
    UploadOperationCheckpoint? checkpoint,
    int? confirmedBytes,
    int? attemptCount,
    OperationAttemptOutcome? attemptOutcome,
    bool? recoveryRequired,
    String? lastFailureCode,
    int? lastFailureStatus,
    String? lastFailureMessage,
    DateTime? updatedAt,
    int? version,
  }) => UploadOperation(
    id: id,
    assetId: assetId,
    deploymentScope: deploymentScope,
    ownerUserId: ownerUserId,
    meetingId: meetingId,
    idempotencyKey: idempotencyKey,
    requestFingerprint: requestFingerprint,
    sourceType: sourceType,
    originalFilename: originalFilename,
    contentType: contentType,
    expectedSizeBytes: expectedSizeBytes,
    remoteMediaId: remoteMediaId ?? this.remoteMediaId,
    checkpoint: checkpoint ?? this.checkpoint,
    confirmedBytes: confirmedBytes ?? this.confirmedBytes,
    attemptCount: attemptCount ?? this.attemptCount,
    attemptOutcome: attemptOutcome ?? this.attemptOutcome,
    recoveryRequired: recoveryRequired ?? this.recoveryRequired,
    lastFailureCode: lastFailureCode ?? this.lastFailureCode,
    lastFailureStatus: lastFailureStatus ?? this.lastFailureStatus,
    lastFailureMessage: lastFailureMessage ?? this.lastFailureMessage,
    createdAt: createdAt,
    updatedAt: updatedAt ?? this.updatedAt,
    version: version ?? this.version,
  );
}

class ProcessingOperation {
  const ProcessingOperation({
    required this.id,
    required this.deploymentScope,
    required this.ownerUserId,
    required this.meetingId,
    required this.idempotencyKey,
    required this.requestFingerprint,
    required this.operationType,
    required this.sourceMediaId,
    required this.targetJobId,
    required this.resultingJobId,
    required this.reprocessOfJobId,
    required this.stageCode,
    required this.checkpoint,
    required this.attemptCount,
    required this.attemptOutcome,
    required this.recoveryRequired,
    required this.lastFailureCode,
    required this.lastFailureStatus,
    required this.lastFailureMessage,
    required this.createdAt,
    required this.updatedAt,
    required this.version,
  });

  final String id;
  final String deploymentScope;
  final String ownerUserId;
  final String meetingId;
  final String idempotencyKey;
  final String requestFingerprint;
  final ProcessingOperationType operationType;
  final String? sourceMediaId;

  /// The job/resource named by the immutable request.
  final String? targetJobId;

  /// The resource returned by a later accepted attempt.
  final String? resultingJobId;
  final String? reprocessOfJobId;
  final String? stageCode;
  final ProcessingOperationCheckpoint checkpoint;
  final int attemptCount;
  final OperationAttemptOutcome attemptOutcome;
  final bool recoveryRequired;
  final String? lastFailureCode;
  final int? lastFailureStatus;
  final String? lastFailureMessage;
  final DateTime createdAt;
  final DateTime updatedAt;
  final int version;

  ProcessingOperation copyWith({
    String? resultingJobId,
    ProcessingOperationCheckpoint? checkpoint,
    int? attemptCount,
    OperationAttemptOutcome? attemptOutcome,
    bool? recoveryRequired,
    String? lastFailureCode,
    int? lastFailureStatus,
    String? lastFailureMessage,
    DateTime? updatedAt,
    int? version,
  }) => ProcessingOperation(
    id: id,
    deploymentScope: deploymentScope,
    ownerUserId: ownerUserId,
    meetingId: meetingId,
    idempotencyKey: idempotencyKey,
    requestFingerprint: requestFingerprint,
    operationType: operationType,
    sourceMediaId: sourceMediaId,
    targetJobId: targetJobId,
    resultingJobId: resultingJobId ?? this.resultingJobId,
    reprocessOfJobId: reprocessOfJobId,
    stageCode: stageCode,
    checkpoint: checkpoint ?? this.checkpoint,
    attemptCount: attemptCount ?? this.attemptCount,
    attemptOutcome: attemptOutcome ?? this.attemptOutcome,
    recoveryRequired: recoveryRequired ?? this.recoveryRequired,
    lastFailureCode: lastFailureCode ?? this.lastFailureCode,
    lastFailureStatus: lastFailureStatus ?? this.lastFailureStatus,
    lastFailureMessage: lastFailureMessage ?? this.lastFailureMessage,
    createdAt: createdAt,
    updatedAt: updatedAt ?? this.updatedAt,
    version: version ?? this.version,
  );
}

class ManagedMediaPaths {
  const ManagedMediaPaths({
    required this.assetId,
    required this.managedRelativePath,
    required this.stagedRelativePath,
  });

  final String assetId;
  final String managedRelativePath;
  final String stagedRelativePath;
}

class LocalMediaMigrationRecord {
  const LocalMediaMigrationRecord({
    required this.id,
    required this.migrationKey,
    required this.deploymentScope,
    required this.ownerUserId,
    required this.sourceDescription,
    required this.state,
    required this.detail,
    required this.createdAt,
    required this.updatedAt,
  });

  final String id;
  final String migrationKey;
  final String? deploymentScope;
  final String? ownerUserId;
  final String sourceDescription;
  final LocalMediaMigrationState state;
  final String? detail;
  final DateTime createdAt;
  final DateTime updatedAt;
}

class LocalMediaRecoveryArtifact {
  const LocalMediaRecoveryArtifact({
    required this.id,
    required this.relativePath,
    required this.originalRelativePath,
    required this.deploymentScope,
    required this.ownerUserId,
    required this.assetId,
    required this.reason,
    required this.metadata,
    required this.createdAt,
    required this.updatedAt,
  });

  final String id;
  final String relativePath;
  final String? originalRelativePath;
  final String? deploymentScope;
  final String? ownerUserId;
  final String? assetId;
  final String reason;
  final String? metadata;
  final DateTime createdAt;
  final DateTime updatedAt;
}
