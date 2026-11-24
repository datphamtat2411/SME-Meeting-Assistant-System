import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:crypto/crypto.dart';

import '../../core/api_client.dart';
import 'local_media_database.dart';
import 'local_media_models.dart';
import 'local_media_persistence.dart';
import 'managed_media_storage.dart';

/// Application-level owner of durable local media state.
///
/// Authentication and HTTP remain outside this class. Callers provide the
/// verified [AuthenticatedSessionScope] captured for an operation, and every
/// database query is fenced by that deployment/user pair.
class LocalMediaRepository {
  LocalMediaRepository({
    required LocalMediaPersistence persistence,
    required ManagedMediaStorage storage,
    this.legacyStorage,
    DateTime Function()? now,
  }) : _persistenceReady = Future<LocalMediaPersistence>.value(persistence),
       _storageReady = Future<ManagedMediaStorage>.value(storage),
       _now = now ?? DateTime.now;

  LocalMediaRepository.lazyDefault({
    this.legacyStorage,
    DateTime Function()? now,
  }) : _persistenceReady = null,
       _storageReady = null,
       _now = now ?? DateTime.now;

  LocalMediaRepository._deferred({
    required Future<LocalMediaPersistence> persistence,
    required Future<ManagedMediaStorage> storage,
    this.legacyStorage,
    DateTime Function()? now,
  }) : _persistenceReady = persistence,
       _storageReady = storage,
       _now = now ?? DateTime.now;

  final Future<LocalMediaPersistence>? _persistenceReady;
  final Future<ManagedMediaStorage>? _storageReady;
  Future<LocalMediaPersistence>? _persistenceFuture;
  Future<ManagedMediaStorage>? _storageFuture;
  final CredentialStorage? legacyStorage;
  final DateTime Function() _now;
  bool _disposed = false;

  static LocalMediaRepository fromReady({
    required Future<LocalMediaPersistence> persistence,
    required Future<ManagedMediaStorage> storage,
    CredentialStorage? legacyStorage,
    DateTime Function()? now,
  }) => LocalMediaRepository._deferred(
    persistence: persistence,
    storage: storage,
    legacyStorage: legacyStorage,
    now: now,
  );

  Future<LocalMediaAsset> rememberSourceFile({
    required AuthenticatedSessionScope scope,
    required String meetingId,
    required File source,
    required LocalMediaSourceType sourceType,
    required String originalFilename,
    required String contentType,
    int? expectedSizeBytes,
    String? sourceProvenance,
  }) => _rememberForOwner(
    deploymentScope: scope.deploymentScope,
    ownerUserId: scope.userId,
    meetingId: meetingId,
    source: source,
    sourceType: sourceType,
    originalFilename: originalFilename,
    contentType: contentType,
    expectedSizeBytes: expectedSizeBytes,
    sourceProvenance: sourceProvenance,
  );

  Future<List<LocalMediaAsset>> listAssets({
    required AuthenticatedSessionScope scope,
    String? meetingId,
    bool includeDiscarded = false,
  }) async {
    _requireScope(scope.deploymentScope, scope.userId);
    final persistence = await _persistence();
    return persistence.listAssets(
      deploymentScope: scope.deploymentScope,
      ownerUserId: scope.userId,
      meetingId: meetingId,
      includeDiscarded: includeDiscarded,
    );
  }

  Future<File> fileFor({
    required AuthenticatedSessionScope scope,
    required LocalMediaAsset asset,
  }) async {
    _requireAssetOwner(asset, scope);
    final storage = await _storage();
    return storage.fileFor(asset.managedRelativePath);
  }

  Future<LocalMediaAsset> discard({
    required AuthenticatedSessionScope scope,
    required String assetId,
  }) async {
    final persistence = await _persistence();
    final asset = await persistence.findAsset(
      id: assetId,
      deploymentScope: scope.deploymentScope,
      ownerUserId: scope.userId,
    );
    if (asset == null) throw StateError('The local media asset was not found.');
    var pending = await persistence.updateAsset(
      asset.copyWith(
        lifecycle: LocalMediaLifecycle.discardPending,
        updatedAt: _utcNow(),
      ),
      expectedVersion: asset.version,
    );
    final storage = await _storage();
    await _deleteIfPresent(storage, pending.managedRelativePath);
    final stagedPath = pending.stagedRelativePath;
    if (stagedPath != null) await _deleteIfPresent(storage, stagedPath);
    pending = await persistence.updateAsset(
      pending.copyWith(
        lifecycle: LocalMediaLifecycle.discarded,
        updatedAt: _utcNow(),
      ),
      expectedVersion: pending.version,
    );
    return pending;
  }

  Future<LocalMediaRecoveryReport> reconcile({
    required AuthenticatedSessionScope scope,
    String? meetingId,
  }) async {
    final persistence = await _persistence();
    final storage = await _storage();
    final assets = await persistence.listAssets(
      deploymentScope: scope.deploymentScope,
      ownerUserId: scope.userId,
      meetingId: meetingId,
      includeDiscarded: false,
    );
    var ready = 0;
    var missing = 0;
    var quarantined = 0;
    var interrupted = 0;
    for (final asset in assets) {
      final result = await _reconcileAsset(persistence, storage, asset);
      switch (result.lifecycle) {
        case LocalMediaLifecycle.ready:
          ready++;
        case LocalMediaLifecycle.missing:
          missing++;
        case LocalMediaLifecycle.quarantined:
          quarantined++;
        case LocalMediaLifecycle.interrupted:
          interrupted++;
        default:
          break;
      }
    }
    return LocalMediaRecoveryReport(
      inspected: assets.length,
      ready: ready,
      missing: missing,
      quarantined: quarantined,
      interrupted: interrupted,
    );
  }

  Future<int> cleanupStaleStaging({
    required AuthenticatedSessionScope scope,
    Duration maxAge = const Duration(days: 7),
  }) async {
    if (maxAge <= Duration.zero) {
      throw ArgumentError.value(maxAge, 'maxAge', 'Must be positive.');
    }
    final persistence = await _persistence();
    final storage = await _storage();
    final cutoff = _utcNow().subtract(maxAge);
    final assets = await persistence.listAssets(
      deploymentScope: scope.deploymentScope,
      ownerUserId: scope.userId,
      includeDiscarded: false,
    );
    var count = 0;
    for (final asset in assets) {
      final stagedPath = asset.stagedRelativePath;
      if (stagedPath == null ||
          !asset.updatedAt.isBefore(cutoff) ||
          !asset.isRecoverable ||
          asset.lifecycle == LocalMediaLifecycle.ready) {
        continue;
      }
      final staged = storage.fileFor(stagedPath);
      if (!await staged.exists()) continue;
      final quarantinedPath = await storage.quarantine(
        stagedPath,
        reason: 'stale-staging',
      );
      await persistence.updateAsset(
        asset.copyWith(
          lifecycle: LocalMediaLifecycle.quarantined,
          stagedRelativePath: quarantinedPath,
          quarantineReason: 'STALE_STAGING',
          updatedAt: _utcNow(),
        ),
        expectedVersion: asset.version,
      );
      count++;
    }
    return count;
  }

  Future<UploadOperation> beginUploadOperation({
    required AuthenticatedSessionScope scope,
    required LocalMediaAsset asset,
    required String idempotencyKey,
    required String requestFingerprint,
  }) async {
    _requireAssetOwner(asset, scope);
    _validateIdempotencyKey(idempotencyKey);
    _validateFingerprint(requestFingerprint);
    if (asset.sizeBytes == null || asset.sizeBytes! <= 0) {
      throw StateError(
        'A local media asset must have a positive size before upload admission.',
      );
    }
    final persistence = await _persistence();
    final existing = await persistence.findUploadOperation(
      deploymentScope: scope.deploymentScope,
      ownerUserId: scope.userId,
      idempotencyKey: idempotencyKey,
    );
    if (existing != null) {
      if (existing.requestFingerprint != requestFingerprint) {
        throw const LocalMediaIdempotencyConflictException();
      }
      return existing;
    }
    final now = _utcNow();
    return persistence.insertUploadOperation(
      UploadOperation(
        id: _newId(),
        assetId: asset.id,
        deploymentScope: scope.deploymentScope,
        ownerUserId: scope.userId,
        idempotencyKey: idempotencyKey,
        requestFingerprint: requestFingerprint,
        sourceType: asset.sourceType,
        originalFilename: asset.originalFilename,
        contentType: asset.contentType,
        expectedSizeBytes: asset.sizeBytes ?? 0,
        remoteMediaId: null,
        checkpoint: UploadOperationCheckpoint.intentNotConfirmed,
        confirmedBytes: 0,
        attemptCount: 0,
        lastFailureCode: null,
        lastFailureStatus: null,
        lastFailureMessage: null,
        createdAt: now,
        updatedAt: now,
        version: 0,
      ),
    );
  }

  Future<UploadOperation> updateUploadOperation(
    UploadOperation operation, {
    required AuthenticatedSessionScope scope,
    UploadOperationCheckpoint? checkpoint,
    String? remoteMediaId,
    int? confirmedBytes,
    int? attemptCount,
    String? failureCode,
    int? failureStatus,
    String? failureMessage,
  }) async {
    _requireOperationOwner(
      operation.deploymentScope,
      operation.ownerUserId,
      scope,
    );
    if (confirmedBytes != null &&
        (confirmedBytes < 0 || confirmedBytes > operation.expectedSizeBytes)) {
      throw ArgumentError.value(confirmedBytes, 'confirmedBytes');
    }
    final next = operation.copyWith(
      checkpoint: checkpoint,
      remoteMediaId: remoteMediaId,
      confirmedBytes: confirmedBytes,
      attemptCount: attemptCount,
      lastFailureCode: failureCode,
      lastFailureStatus: failureStatus,
      lastFailureMessage: failureMessage,
      updatedAt: _utcNow(),
    );
    return (await _persistence()).updateUploadOperation(
      next,
      expectedVersion: operation.version,
    );
  }

  Future<ProcessingOperation> beginProcessingOperation({
    required AuthenticatedSessionScope scope,
    required String meetingId,
    required String idempotencyKey,
    required String requestFingerprint,
    required ProcessingOperationType operationType,
    String? sourceMediaId,
    String? reprocessOfJobId,
    String? stageCode,
    String? targetJobId,
  }) async {
    _requireScope(scope.deploymentScope, scope.userId);
    _validateIdentifier(meetingId, 'meetingId');
    _validateIdempotencyKey(idempotencyKey);
    _validateFingerprint(requestFingerprint);
    final persistence = await _persistence();
    final existing = await persistence.findProcessingOperation(
      deploymentScope: scope.deploymentScope,
      ownerUserId: scope.userId,
      idempotencyKey: idempotencyKey,
    );
    if (existing != null) {
      if (existing.requestFingerprint != requestFingerprint) {
        throw const LocalMediaIdempotencyConflictException();
      }
      return existing;
    }
    final now = _utcNow();
    return persistence.insertProcessingOperation(
      ProcessingOperation(
        id: _newId(),
        deploymentScope: scope.deploymentScope,
        ownerUserId: scope.userId,
        meetingId: meetingId,
        idempotencyKey: idempotencyKey,
        requestFingerprint: requestFingerprint,
        operationType: operationType,
        sourceMediaId: sourceMediaId,
        targetJobId: targetJobId,
        reprocessOfJobId: reprocessOfJobId,
        stageCode: stageCode,
        checkpoint: switch (operationType) {
          ProcessingOperationType.admission =>
            ProcessingOperationCheckpoint.admissionNotConfirmed,
          ProcessingOperationType.retry =>
            ProcessingOperationCheckpoint.admissionNotConfirmed,
          ProcessingOperationType.reprocess =>
            ProcessingOperationCheckpoint.admissionNotConfirmed,
        },
        attemptCount: 0,
        lastFailureCode: null,
        lastFailureStatus: null,
        lastFailureMessage: null,
        createdAt: now,
        updatedAt: now,
        version: 0,
      ),
    );
  }

  Future<ProcessingOperation> updateProcessingOperation(
    ProcessingOperation operation, {
    required AuthenticatedSessionScope scope,
    ProcessingOperationCheckpoint? checkpoint,
    String? targetJobId,
    int? attemptCount,
    String? failureCode,
    int? failureStatus,
    String? failureMessage,
  }) async {
    _requireOperationOwner(
      operation.deploymentScope,
      operation.ownerUserId,
      scope,
    );
    final next = operation.copyWith(
      checkpoint: checkpoint,
      targetJobId: targetJobId,
      attemptCount: attemptCount,
      lastFailureCode: failureCode,
      lastFailureStatus: failureStatus,
      lastFailureMessage: failureMessage,
      updatedAt: _utcNow(),
    );
    return (await _persistence()).updateProcessingOperation(
      next,
      expectedVersion: operation.version,
    );
  }

  /// Retires the legacy secure-storage index exactly once. Entries that do not
  /// carry an owner/deployment scope are quarantined as metadata only; their
  /// source files are deliberately left untouched.
  Future<LocalMediaMigrationRecord?> migrateLegacyMetadata({
    CredentialStorage? storage,
    String legacyStorageKey = 'sme.mobile.recordings.v1',
  }) async {
    final sourceStorage = storage ?? legacyStorage;
    if (sourceStorage == null) return null;
    final raw = await sourceStorage.read(key: legacyStorageKey);
    if (raw == null) return null;
    final persistence = await _persistence();
    final key = sha256.convert(utf8.encode(raw)).toString();
    final existing = await persistence.findMigration(key);
    if (existing?.state == LocalMediaMigrationState.completed ||
        existing?.state == LocalMediaMigrationState.quarantined) {
      await sourceStorage.delete(key: legacyStorageKey);
      await sourceStorage.confirmDurable();
      return existing;
    }
    final startedAt = _utcNow();
    await persistence.upsertMigration(
      LocalMediaMigrationRecord(
        id: _newId(),
        migrationKey: key,
        deploymentScope: null,
        ownerUserId: null,
        sourceDescription: 'secure-storage-recording-index',
        state: LocalMediaMigrationState.started,
        detail: null,
        createdAt: startedAt,
        updatedAt: startedAt,
      ),
    );

    var imported = 0;
    var quarantined = 0;
    String? detail;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! List) {
        quarantined = 1;
        detail = 'Legacy metadata was not a list.';
      } else {
        for (final item in decoded) {
          if (item is! Map) {
            quarantined++;
            continue;
          }
          final entry = item.map(
            (key, value) => MapEntry(key.toString(), value),
          );
          final deploymentScope = _text(entry['deploymentScope']);
          final ownerUserId = _text(entry['userId']);
          final meetingId = _text(entry['meetingId']);
          final filePath = _text(entry['path']);
          if (deploymentScope == null ||
              ownerUserId == null ||
              meetingId == null ||
              filePath == null) {
            quarantined++;
            continue;
          }
          final source = File(filePath);
          if (!await source.exists()) {
            quarantined++;
            continue;
          }
          try {
            await _rememberForOwner(
              deploymentScope: deploymentScope,
              ownerUserId: ownerUserId,
              meetingId: meetingId,
              source: source,
              sourceType: LocalMediaSourceType.legacy,
              originalFilename:
                  _text(entry['name']) ?? source.uri.pathSegments.last,
              contentType: _text(entry['contentType']) ?? 'audio/wav',
              sourceProvenance: 'legacy:$key:$imported',
            );
            imported++;
          } on Object {
            quarantined++;
          }
        }
      }
    } on FormatException {
      quarantined = 1;
      detail = 'Legacy metadata was not valid JSON.';
    }
    final state = quarantined == 0
        ? LocalMediaMigrationState.completed
        : LocalMediaMigrationState.quarantined;
    final completed = LocalMediaMigrationRecord(
      id: existing?.id ?? _newId(),
      migrationKey: key,
      deploymentScope: null,
      ownerUserId: null,
      sourceDescription: 'secure-storage-recording-index',
      state: state,
      detail: detail ?? 'Imported $imported entries; quarantined $quarantined.',
      createdAt: existing?.createdAt ?? startedAt,
      updatedAt: _utcNow(),
    );
    final result = await persistence.upsertMigration(completed);
    await sourceStorage.delete(key: legacyStorageKey);
    await sourceStorage.confirmDurable();
    return result;
  }

  Future<void> dispose() async {
    if (_disposed) return;
    _disposed = true;
    final persistence = _persistenceFuture;
    if (persistence != null) await (await persistence).close();
  }

  void close() {
    unawaited(dispose());
  }

  Future<LocalMediaAsset> _rememberForOwner({
    required String deploymentScope,
    required String ownerUserId,
    required String meetingId,
    required File source,
    required LocalMediaSourceType sourceType,
    required String originalFilename,
    required String contentType,
    int? expectedSizeBytes,
    String? sourceProvenance,
  }) async {
    _requireScope(deploymentScope, ownerUserId);
    _validateIdentifier(meetingId, 'meetingId');
    _validateFilename(originalFilename);
    _validateContentType(contentType);
    if (!await source.exists()) {
      throw const FileSystemException('The source media file does not exist.');
    }
    final persistence = await _persistence();
    final storage = await _storage();
    await storage.ensureDirectories();
    final provenance = sourceProvenance ?? await _sourceProvenance(source);
    final existing = await persistence.findAssetByProvenance(
      deploymentScope: deploymentScope,
      ownerUserId: ownerUserId,
      sourceProvenance: provenance,
    );
    if (existing != null) {
      final managed = storage.fileFor(existing.managedRelativePath);
      if (existing.isReady && await managed.exists()) return existing;
      throw const LocalMediaConflictException(
        'A local media import with this source provenance is incomplete.',
      );
    }
    final id = _newId();
    final paths = storage.allocatePaths(id);
    final now = _utcNow();
    var asset = LocalMediaAsset(
      id: id,
      deploymentScope: deploymentScope,
      ownerUserId: ownerUserId,
      meetingId: meetingId,
      sourceType: sourceType,
      managedRelativePath: paths.managedRelativePath,
      stagedRelativePath: paths.stagedRelativePath,
      originalFilename: originalFilename,
      contentType: contentType,
      sizeBytes: null,
      durationMs: null,
      sha256: null,
      lifecycle: LocalMediaLifecycle.creating,
      sourceProvenance: provenance,
      quarantineReason: null,
      createdAt: now,
      updatedAt: now,
      readyAt: null,
      version: 0,
    );
    await persistence.insertAsset(asset);
    try {
      final integrity = await storage.copyFileToStaging(
        source,
        paths.stagedRelativePath,
        expectedSizeBytes: expectedSizeBytes,
      );
      asset = await persistence.updateAsset(
        asset.copyWith(
          lifecycle: LocalMediaLifecycle.staged,
          sizeBytes: integrity.sizeBytes,
          sha256: integrity.sha256,
          updatedAt: _utcNow(),
        ),
        expectedVersion: asset.version,
      );
      await storage.promote(
        paths.stagedRelativePath,
        paths.managedRelativePath,
      );
      asset = await persistence.updateAsset(
        asset.copyWith(
          lifecycle: LocalMediaLifecycle.ready,
          readyAt: _utcNow(),
          updatedAt: _utcNow(),
        ),
        expectedVersion: asset.version,
      );
      return asset;
    } catch (error) {
      try {
        await persistence.updateAsset(
          asset.copyWith(
            lifecycle: LocalMediaLifecycle.interrupted,
            quarantineReason: 'SOURCE_IMPORT_INTERRUPTED',
            updatedAt: _utcNow(),
          ),
          expectedVersion: asset.version,
        );
      } catch (_) {}
      rethrow;
    }
  }

  Future<LocalMediaAsset> _reconcileAsset(
    LocalMediaPersistence persistence,
    ManagedMediaStorage storage,
    LocalMediaAsset asset,
  ) async {
    if (asset.lifecycle == LocalMediaLifecycle.discardPending) {
      await _deleteIfPresent(storage, asset.managedRelativePath);
      final stagedPath = asset.stagedRelativePath;
      if (stagedPath != null) await _deleteIfPresent(storage, stagedPath);
      return await persistence.updateAsset(
        asset.copyWith(
          lifecycle: LocalMediaLifecycle.discarded,
          updatedAt: _utcNow(),
        ),
        expectedVersion: asset.version,
      );
    }

    final managed = storage.fileFor(asset.managedRelativePath);
    final stagedPath = asset.stagedRelativePath;
    final staged = stagedPath == null ? null : storage.fileFor(stagedPath);
    if (await managed.exists()) {
      try {
        final integrity = await storage.inspectFile(asset.managedRelativePath);
        if (!_matches(asset, integrity)) {
          return await persistence.updateAsset(
            asset.copyWith(
              lifecycle: LocalMediaLifecycle.unavailable,
              quarantineReason: 'MANAGED_FILE_INTEGRITY_MISMATCH',
              updatedAt: _utcNow(),
            ),
            expectedVersion: asset.version,
          );
        }
        if (staged != null && await staged.exists()) {
          await staged.delete();
        }
        if (asset.lifecycle == LocalMediaLifecycle.ready &&
            asset.sizeBytes == integrity.sizeBytes &&
            asset.sha256 == integrity.sha256) {
          return asset;
        }
        return await persistence.updateAsset(
          asset.copyWith(
            lifecycle: LocalMediaLifecycle.ready,
            sizeBytes: integrity.sizeBytes,
            sha256: integrity.sha256,
            readyAt: asset.readyAt ?? _utcNow(),
            updatedAt: _utcNow(),
          ),
          expectedVersion: asset.version,
        );
      } on FileSystemException {
        return await persistence.updateAsset(
          asset.copyWith(
            lifecycle: LocalMediaLifecycle.unavailable,
            quarantineReason: 'MANAGED_FILE_UNREADABLE',
            updatedAt: _utcNow(),
          ),
          expectedVersion: asset.version,
        );
      }
    }

    if (staged != null && await staged.exists()) {
      try {
        final integrity = await storage.inspectFile(stagedPath!);
        if (!_matches(asset, integrity)) {
          final quarantinedPath = await storage.quarantine(
            stagedPath,
            reason: 'integrity-mismatch',
          );
          return await persistence.updateAsset(
            asset.copyWith(
              lifecycle: LocalMediaLifecycle.quarantined,
              stagedRelativePath: quarantinedPath,
              quarantineReason: 'STAGED_FILE_INTEGRITY_MISMATCH',
              updatedAt: _utcNow(),
            ),
            expectedVersion: asset.version,
          );
        }
        await storage.promote(stagedPath, asset.managedRelativePath);
        return await persistence.updateAsset(
          asset.copyWith(
            lifecycle: LocalMediaLifecycle.ready,
            sizeBytes: integrity.sizeBytes,
            sha256: integrity.sha256,
            readyAt: asset.readyAt ?? _utcNow(),
            updatedAt: _utcNow(),
          ),
          expectedVersion: asset.version,
        );
      } on FileSystemException {
        return await persistence.updateAsset(
          asset.copyWith(
            lifecycle: LocalMediaLifecycle.quarantined,
            quarantineReason: 'STAGED_FILE_UNREADABLE',
            updatedAt: _utcNow(),
          ),
          expectedVersion: asset.version,
        );
      }
    }

    return await persistence.updateAsset(
      asset.copyWith(
        lifecycle: asset.lifecycle == LocalMediaLifecycle.ready
            ? LocalMediaLifecycle.missing
            : LocalMediaLifecycle.interrupted,
        quarantineReason: asset.lifecycle == LocalMediaLifecycle.ready
            ? 'MANAGED_FILE_MISSING'
            : 'RECOVERY_ARTIFACT_MISSING',
        updatedAt: _utcNow(),
      ),
      expectedVersion: asset.version,
    );
  }

  bool _matches(LocalMediaAsset asset, LocalMediaFileIntegrity integrity) =>
      (asset.sizeBytes == null || asset.sizeBytes == integrity.sizeBytes) &&
      (asset.sha256 == null || asset.sha256 == integrity.sha256);

  Future<LocalMediaPersistence> _persistence() async {
    if (_disposed) throw StateError('The local media repository is closed.');
    _persistenceFuture ??=
        _persistenceReady ??
        LocalMediaDatabase.openDefault().then(LocalMediaPersistence.new);
    return _persistenceFuture!;
  }

  Future<ManagedMediaStorage> _storage() async {
    if (_disposed) throw StateError('The local media repository is closed.');
    _storageFuture ??= _storageReady ?? ManagedMediaStorage.openDefault();
    return _storageFuture!;
  }

  DateTime _utcNow() => _now().toUtc();

  static String _newId() {
    final random = Random.secure();
    return List<int>.generate(
      16,
      (_) => random.nextInt(256),
    ).map((value) => value.toRadixString(16).padLeft(2, '0')).join();
  }

  static Future<String> _sourceProvenance(File source) async {
    final stat = await source.stat();
    return sha256
        .convert(
          utf8.encode(
            '${source.absolute.path}\u0000${stat.size}\u0000'
            '${stat.modified.toUtc().microsecondsSinceEpoch}',
          ),
        )
        .toString();
  }

  static Future<void> _deleteIfPresent(
    ManagedMediaStorage storage,
    String relativePath,
  ) async {
    final file = storage.fileFor(relativePath);
    if (await file.exists()) await file.delete();
  }

  static void _requireScope(String deploymentScope, String ownerUserId) {
    if (deploymentScope.trim().isEmpty || ownerUserId.trim().isEmpty) {
      throw ArgumentError('A deployment and owner scope are required.');
    }
  }

  static void _requireAssetOwner(
    LocalMediaAsset asset,
    AuthenticatedSessionScope scope,
  ) {
    if (asset.deploymentScope != scope.deploymentScope ||
        asset.ownerUserId != scope.userId) {
      throw const LocalMediaOwnershipException();
    }
  }

  static void _requireOperationOwner(
    String deploymentScope,
    String ownerUserId,
    AuthenticatedSessionScope scope,
  ) {
    if (deploymentScope != scope.deploymentScope ||
        ownerUserId != scope.userId) {
      throw const LocalMediaOwnershipException();
    }
  }

  static void _validateIdentifier(String value, String field) {
    if (value.trim().isEmpty ||
        value.contains('\r') ||
        value.contains('\n') ||
        value.contains('/')) {
      throw ArgumentError.value(value, field, 'Must be a safe non-empty ID.');
    }
  }

  static void _validateFilename(String value) {
    if (value.trim().isEmpty ||
        value.length > 512 ||
        value.contains('\u0000') ||
        value.contains('\r') ||
        value.contains('\n')) {
      throw ArgumentError.value(value, 'originalFilename');
    }
  }

  static void _validateContentType(String value) {
    if (value.trim().isEmpty ||
        value.trim() != value ||
        value.contains('\r') ||
        value.contains('\n')) {
      throw ArgumentError.value(value, 'contentType');
    }
  }

  static void _validateIdempotencyKey(String value) {
    if (value.isEmpty ||
        value.trim() != value ||
        value.length > 255 ||
        _containsControl(value)) {
      throw ArgumentError.value(value, 'idempotencyKey');
    }
  }

  static void _validateFingerprint(String value) {
    if (!RegExp(r'^[0-9a-fA-F]{64}$').hasMatch(value)) {
      throw ArgumentError.value(value, 'requestFingerprint');
    }
  }

  static String? _text(Object? value) =>
      value is String && value.trim().isNotEmpty ? value : null;
}

bool _containsControl(String value) => value.codeUnits.any(
  (unit) => unit < 0x20 || (unit >= 0x7f && unit <= 0x9f),
);

class LocalMediaRecoveryReport {
  const LocalMediaRecoveryReport({
    required this.inspected,
    required this.ready,
    required this.missing,
    required this.quarantined,
    required this.interrupted,
  });

  final int inspected;
  final int ready;
  final int missing;
  final int quarantined;
  final int interrupted;
}

class LocalMediaOwnershipException implements Exception {
  const LocalMediaOwnershipException();

  @override
  String toString() =>
      'The local media record belongs to another session scope.';
}

class LocalMediaIdempotencyConflictException implements Exception {
  const LocalMediaIdempotencyConflictException();

  @override
  String toString() =>
      'The idempotency key is already bound to another request.';
}
