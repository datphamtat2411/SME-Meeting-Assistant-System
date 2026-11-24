import 'package:sqflite/sqflite.dart' as sqflite;

import 'local_media_database.dart';
import 'local_media_models.dart';

/// Typed SQLite boundary for local media metadata.
///
/// This class deliberately does not know about authentication, filesystem
/// paths, or HTTP. Every query includes the deployment and owner scope so a
/// caller cannot accidentally turn a local database row into cross-account
/// state.
class LocalMediaPersistence {
  LocalMediaPersistence(this.owner);

  final LocalMediaDatabase owner;

  sqflite.Database get database => owner.database;

  Future<List<LocalMediaAsset>> listAssets({
    required String deploymentScope,
    required String ownerUserId,
    String? meetingId,
    bool includeDiscarded = false,
  }) async {
    _requireScope(deploymentScope, ownerUserId);
    final where = <String>['deployment_scope = ?', 'owner_user_id = ?'];
    final arguments = <Object?>[deploymentScope, ownerUserId];
    if (meetingId != null) {
      where.add('meeting_id = ?');
      arguments.add(meetingId);
    }
    if (!includeDiscarded) {
      where.add("lifecycle_state <> 'DISCARDED'");
    }
    final rows = await database.query(
      'local_media_assets',
      where: where.join(' AND '),
      whereArgs: arguments,
      orderBy: 'created_at DESC',
    );
    return List<LocalMediaAsset>.unmodifiable(rows.map(_assetFromRow));
  }

  Future<LocalMediaAsset?> findAsset({
    required String id,
    required String deploymentScope,
    required String ownerUserId,
  }) async {
    _requireScope(deploymentScope, ownerUserId);
    final rows = await database.query(
      'local_media_assets',
      where: 'id = ? AND deployment_scope = ? AND owner_user_id = ?',
      whereArgs: <Object?>[id, deploymentScope, ownerUserId],
      limit: 1,
    );
    return rows.isEmpty ? null : _assetFromRow(rows.single);
  }

  Future<LocalMediaAsset?> findAssetByProvenance({
    required String deploymentScope,
    required String ownerUserId,
    required String sourceProvenance,
  }) async {
    _requireScope(deploymentScope, ownerUserId);
    final rows = await database.query(
      'local_media_assets',
      where: 'deployment_scope = ? AND owner_user_id = ? AND source_provenance = ?',
      whereArgs: <Object?>[deploymentScope, ownerUserId, sourceProvenance],
      orderBy: 'created_at DESC',
      limit: 1,
    );
    return rows.isEmpty ? null : _assetFromRow(rows.single);
  }

  Future<LocalMediaAsset> insertAsset(LocalMediaAsset asset) async {
    _validateAssetScope(asset);
    await database.insert(
      'local_media_assets',
      _assetValues(asset),
      conflictAlgorithm: sqflite.ConflictAlgorithm.abort,
    );
    return asset;
  }

  Future<LocalMediaAsset> updateAsset(
    LocalMediaAsset asset, {
    required int expectedVersion,
  }) async {
    _validateAssetScope(asset);
    if (asset.version != expectedVersion) {
      throw LocalMediaConflictException(
        'The local media asset version is stale.',
      );
    }
    final next = asset.copyWith(
      version: expectedVersion + 1,
      updatedAt: asset.updatedAt.toUtc(),
    );
    final changed = await database.update(
      'local_media_assets',
      _assetValues(next),
      where: 'id = ? AND deployment_scope = ? AND owner_user_id = ? AND version = ?',
      whereArgs: <Object?>[
        asset.id,
        asset.deploymentScope,
        asset.ownerUserId,
        expectedVersion,
      ],
    );
    if (changed != 1) {
      throw LocalMediaConflictException(
        'The local media asset was changed by another operation.',
      );
    }
    return next;
  }

  Future<UploadOperation?> findUploadOperation({
    required String deploymentScope,
    required String ownerUserId,
    required String idempotencyKey,
  }) async {
    _requireScope(deploymentScope, ownerUserId);
    final rows = await database.query(
      'upload_operations',
      where:
          'deployment_scope = ? AND owner_user_id = ? AND idempotency_key = ?',
      whereArgs: <Object?>[deploymentScope, ownerUserId, idempotencyKey],
      limit: 1,
    );
    return rows.isEmpty ? null : _uploadFromRow(rows.single);
  }

  Future<UploadOperation> insertUploadOperation(
    UploadOperation operation,
  ) async {
    _validateScope(operation.deploymentScope, operation.ownerUserId);
    await database.insert(
      'upload_operations',
      _uploadValues(operation),
      conflictAlgorithm: sqflite.ConflictAlgorithm.abort,
    );
    return operation;
  }

  Future<UploadOperation> updateUploadOperation(
    UploadOperation operation, {
    required int expectedVersion,
  }) async {
    if (operation.version != expectedVersion) {
      throw LocalMediaConflictException(
        'The upload operation version is stale.',
      );
    }
    final next = operation.copyWith(
      updatedAt: operation.updatedAt.toUtc(),
      version: expectedVersion + 1,
    );
    final changed = await database.update(
      'upload_operations',
      _uploadValues(next),
      where: 'id = ? AND deployment_scope = ? AND owner_user_id = ? AND version = ?',
      whereArgs: <Object?>[
        operation.id,
        operation.deploymentScope,
        operation.ownerUserId,
        expectedVersion,
      ],
    );
    if (changed != 1) {
      throw LocalMediaConflictException(
        'The upload operation was changed by another operation.',
      );
    }
    return next;
  }

  Future<ProcessingOperation?> findProcessingOperation({
    required String deploymentScope,
    required String ownerUserId,
    required String idempotencyKey,
  }) async {
    _requireScope(deploymentScope, ownerUserId);
    final rows = await database.query(
      'processing_operations',
      where:
          'deployment_scope = ? AND owner_user_id = ? AND idempotency_key = ?',
      whereArgs: <Object?>[deploymentScope, ownerUserId, idempotencyKey],
      limit: 1,
    );
    return rows.isEmpty ? null : _processingFromRow(rows.single);
  }

  Future<ProcessingOperation> insertProcessingOperation(
    ProcessingOperation operation,
  ) async {
    _validateScope(operation.deploymentScope, operation.ownerUserId);
    await database.insert(
      'processing_operations',
      _processingValues(operation),
      conflictAlgorithm: sqflite.ConflictAlgorithm.abort,
    );
    return operation;
  }

  Future<ProcessingOperation> updateProcessingOperation(
    ProcessingOperation operation, {
    required int expectedVersion,
  }) async {
    if (operation.version != expectedVersion) {
      throw LocalMediaConflictException(
        'The processing operation version is stale.',
      );
    }
    final next = operation.copyWith(
      updatedAt: operation.updatedAt.toUtc(),
      version: expectedVersion + 1,
    );
    final changed = await database.update(
      'processing_operations',
      _processingValues(next),
      where: 'id = ? AND deployment_scope = ? AND owner_user_id = ? AND version = ?',
      whereArgs: <Object?>[
        operation.id,
        operation.deploymentScope,
        operation.ownerUserId,
        expectedVersion,
      ],
    );
    if (changed != 1) {
      throw LocalMediaConflictException(
        'The processing operation was changed by another operation.',
      );
    }
    return next;
  }

  Future<LocalMediaMigrationRecord?> findMigration(String migrationKey) async {
    final rows = await database.query(
      'local_media_migrations',
      where: 'migration_key = ?',
      whereArgs: <Object?>[migrationKey],
      limit: 1,
    );
    return rows.isEmpty ? null : _migrationFromRow(rows.single);
  }

  Future<LocalMediaMigrationRecord> upsertMigration(
    LocalMediaMigrationRecord record,
  ) async {
    final existing = await findMigration(record.migrationKey);
    if (existing == null) {
      await database.insert(
        'local_media_migrations',
        _migrationValues(record),
        conflictAlgorithm: sqflite.ConflictAlgorithm.abort,
      );
      return record;
    }
    await database.update(
      'local_media_migrations',
      _migrationValues(record),
      where: 'migration_key = ?',
      whereArgs: <Object?>[record.migrationKey],
    );
    return record;
  }

  Future<void> close() => owner.close();

  Map<String, Object?> _assetValues(LocalMediaAsset asset) => <String, Object?>{
    'id': asset.id,
    'deployment_scope': asset.deploymentScope,
    'owner_user_id': asset.ownerUserId,
    'meeting_id': asset.meetingId,
    'source_type': asset.sourceType.wireValue,
    'managed_relative_path': asset.managedRelativePath,
    'staged_relative_path': asset.stagedRelativePath,
    'original_filename': asset.originalFilename,
    'content_type': asset.contentType,
    'size_bytes': asset.sizeBytes,
    'duration_ms': asset.durationMs,
    'sha256': asset.sha256,
    'lifecycle_state': asset.lifecycle.wireValue,
    'source_provenance': asset.sourceProvenance,
    'quarantine_reason': asset.quarantineReason,
    'created_at': asset.createdAt.toUtc().toIso8601String(),
    'updated_at': asset.updatedAt.toUtc().toIso8601String(),
    'ready_at': asset.readyAt?.toUtc().toIso8601String(),
    'version': asset.version,
  };

  Map<String, Object?> _uploadValues(UploadOperation operation) =>
      <String, Object?>{
        'id': operation.id,
        'asset_id': operation.assetId,
        'deployment_scope': operation.deploymentScope,
        'owner_user_id': operation.ownerUserId,
        'idempotency_key': operation.idempotencyKey,
        'request_fingerprint': operation.requestFingerprint,
        'source_type': operation.sourceType.wireValue,
        'original_filename': operation.originalFilename,
        'content_type': operation.contentType,
        'expected_size_bytes': operation.expectedSizeBytes,
        'remote_media_id': operation.remoteMediaId,
        'confirmed_checkpoint': operation.checkpoint.wireValue,
        'confirmed_bytes': operation.confirmedBytes,
        'attempt_count': operation.attemptCount,
        'last_failure_code': operation.lastFailureCode,
        'last_failure_status': operation.lastFailureStatus,
        'last_failure_message': operation.lastFailureMessage,
        'created_at': operation.createdAt.toUtc().toIso8601String(),
        'updated_at': operation.updatedAt.toUtc().toIso8601String(),
        'version': operation.version,
      };

  Map<String, Object?> _processingValues(ProcessingOperation operation) =>
      <String, Object?>{
        'id': operation.id,
        'deployment_scope': operation.deploymentScope,
        'owner_user_id': operation.ownerUserId,
        'meeting_id': operation.meetingId,
        'idempotency_key': operation.idempotencyKey,
        'request_fingerprint': operation.requestFingerprint,
        'operation_type': operation.operationType.wireValue,
        'source_media_id': operation.sourceMediaId,
        'target_job_id': operation.targetJobId,
        'reprocess_of_job_id': operation.reprocessOfJobId,
        'stage_code': operation.stageCode,
        'confirmed_checkpoint': operation.checkpoint.wireValue,
        'attempt_count': operation.attemptCount,
        'last_failure_code': operation.lastFailureCode,
        'last_failure_status': operation.lastFailureStatus,
        'last_failure_message': operation.lastFailureMessage,
        'created_at': operation.createdAt.toUtc().toIso8601String(),
        'updated_at': operation.updatedAt.toUtc().toIso8601String(),
        'version': operation.version,
      };

  Map<String, Object?> _migrationValues(LocalMediaMigrationRecord record) =>
      <String, Object?>{
        'id': record.id,
        'migration_key': record.migrationKey,
        'deployment_scope': record.deploymentScope,
        'owner_user_id': record.ownerUserId,
        'source_description': record.sourceDescription,
        'state': record.state.wireValue,
        'detail': record.detail,
        'created_at': record.createdAt.toUtc().toIso8601String(),
        'updated_at': record.updatedAt.toUtc().toIso8601String(),
      };

  LocalMediaAsset _assetFromRow(Map<String, Object?> row) => LocalMediaAsset(
    id: _requiredString(row, 'id'),
    deploymentScope: _requiredString(row, 'deployment_scope'),
    ownerUserId: _requiredString(row, 'owner_user_id'),
    meetingId: _optionalString(row, 'meeting_id'),
    sourceType: LocalMediaSourceType.fromWireValue(
      _requiredString(row, 'source_type'),
    ),
    managedRelativePath: _requiredString(row, 'managed_relative_path'),
    stagedRelativePath: _optionalString(row, 'staged_relative_path'),
    originalFilename: _requiredString(row, 'original_filename'),
    contentType: _requiredString(row, 'content_type'),
    sizeBytes: _optionalInt(row, 'size_bytes'),
    durationMs: _optionalInt(row, 'duration_ms'),
    sha256: _optionalString(row, 'sha256'),
    lifecycle: LocalMediaLifecycle.fromWireValue(
      _requiredString(row, 'lifecycle_state'),
    ),
    sourceProvenance: _optionalString(row, 'source_provenance'),
    quarantineReason: _optionalString(row, 'quarantine_reason'),
    createdAt: _requiredTimestamp(row, 'created_at'),
    updatedAt: _requiredTimestamp(row, 'updated_at'),
    readyAt: _optionalTimestamp(row, 'ready_at'),
    version: _requiredInt(row, 'version'),
  );

  UploadOperation _uploadFromRow(Map<String, Object?> row) => UploadOperation(
    id: _requiredString(row, 'id'),
    assetId: _requiredString(row, 'asset_id'),
    deploymentScope: _requiredString(row, 'deployment_scope'),
    ownerUserId: _requiredString(row, 'owner_user_id'),
    idempotencyKey: _requiredString(row, 'idempotency_key'),
    requestFingerprint: _requiredString(row, 'request_fingerprint'),
    sourceType: LocalMediaSourceType.fromWireValue(
      _requiredString(row, 'source_type'),
    ),
    originalFilename: _requiredString(row, 'original_filename'),
    contentType: _requiredString(row, 'content_type'),
    expectedSizeBytes: _requiredInt(row, 'expected_size_bytes'),
    remoteMediaId: _optionalString(row, 'remote_media_id'),
    checkpoint: UploadOperationCheckpoint.fromWireValue(
      _requiredString(row, 'confirmed_checkpoint'),
    ),
    confirmedBytes: _requiredInt(row, 'confirmed_bytes'),
    attemptCount: _requiredInt(row, 'attempt_count'),
    lastFailureCode: _optionalString(row, 'last_failure_code'),
    lastFailureStatus: _optionalInt(row, 'last_failure_status'),
    lastFailureMessage: _optionalString(row, 'last_failure_message'),
    createdAt: _requiredTimestamp(row, 'created_at'),
    updatedAt: _requiredTimestamp(row, 'updated_at'),
    version: _requiredInt(row, 'version'),
  );

  ProcessingOperation _processingFromRow(Map<String, Object?> row) =>
      ProcessingOperation(
        id: _requiredString(row, 'id'),
        deploymentScope: _requiredString(row, 'deployment_scope'),
        ownerUserId: _requiredString(row, 'owner_user_id'),
        meetingId: _requiredString(row, 'meeting_id'),
        idempotencyKey: _requiredString(row, 'idempotency_key'),
        requestFingerprint: _requiredString(row, 'request_fingerprint'),
        operationType: ProcessingOperationType.values.firstWhere(
          (candidate) =>
              candidate.wireValue == _requiredString(row, 'operation_type'),
          orElse: () => throw StateError('Unknown processing operation type.'),
        ),
        sourceMediaId: _optionalString(row, 'source_media_id'),
        targetJobId: _optionalString(row, 'target_job_id'),
        reprocessOfJobId: _optionalString(row, 'reprocess_of_job_id'),
        stageCode: _optionalString(row, 'stage_code'),
        checkpoint: ProcessingOperationCheckpoint.fromWireValue(
          _requiredString(row, 'confirmed_checkpoint'),
        ),
        attemptCount: _requiredInt(row, 'attempt_count'),
        lastFailureCode: _optionalString(row, 'last_failure_code'),
        lastFailureStatus: _optionalInt(row, 'last_failure_status'),
        lastFailureMessage: _optionalString(row, 'last_failure_message'),
        createdAt: _requiredTimestamp(row, 'created_at'),
        updatedAt: _requiredTimestamp(row, 'updated_at'),
        version: _requiredInt(row, 'version'),
      );

  LocalMediaMigrationRecord _migrationFromRow(Map<String, Object?> row) =>
      LocalMediaMigrationRecord(
        id: _requiredString(row, 'id'),
        migrationKey: _requiredString(row, 'migration_key'),
        deploymentScope: _optionalString(row, 'deployment_scope'),
        ownerUserId: _optionalString(row, 'owner_user_id'),
        sourceDescription: _requiredString(row, 'source_description'),
        state: LocalMediaMigrationState.fromWireValue(
          _requiredString(row, 'state'),
        ),
        detail: _optionalString(row, 'detail'),
        createdAt: _requiredTimestamp(row, 'created_at'),
        updatedAt: _requiredTimestamp(row, 'updated_at'),
      );

  static void _validateAssetScope(LocalMediaAsset asset) =>
      _validateScope(asset.deploymentScope, asset.ownerUserId);

  static void _requireScope(String deploymentScope, String ownerUserId) =>
      _validateScope(deploymentScope, ownerUserId);

  static void _validateScope(String deploymentScope, String ownerUserId) {
    if (deploymentScope.trim().isEmpty ||
        ownerUserId.trim().isEmpty ||
        deploymentScope.contains('\u0000') ||
        ownerUserId.contains('\u0000')) {
      throw ArgumentError('A deployment and owner scope are required.');
    }
  }
}

class LocalMediaConflictException implements Exception {
  const LocalMediaConflictException(this.message);

  final String message;

  @override
  String toString() => message;
}

String _requiredString(Map<String, Object?> row, String key) {
  final value = row[key];
  if (value is! String || value.isEmpty) {
    throw StateError('Local media row field "$key" is invalid.');
  }
  return value;
}

String? _optionalString(Map<String, Object?> row, String key) {
  final value = row[key];
  if (value == null) return null;
  if (value is! String)
    throw StateError('Local media row field "$key" is invalid.');
  return value;
}

int _requiredInt(Map<String, Object?> row, String key) {
  final value = row[key];
  if (value is int) return value;
  if (value is num && value == value.toInt()) return value.toInt();
  throw StateError('Local media row field "$key" is invalid.');
}

int? _optionalInt(Map<String, Object?> row, String key) {
  final value = row[key];
  if (value == null) return null;
  if (value is int) return value;
  if (value is num && value == value.toInt()) return value.toInt();
  throw StateError('Local media row field "$key" is invalid.');
}

DateTime _requiredTimestamp(Map<String, Object?> row, String key) {
  final value = DateTime.tryParse(_requiredString(row, key));
  if (value == null)
    throw StateError('Local media row field "$key" is invalid.');
  return value.toUtc();
}

DateTime? _optionalTimestamp(Map<String, Object?> row, String key) {
  final value = _optionalString(row, key);
  return value == null ? null : DateTime.tryParse(value)?.toUtc();
}
