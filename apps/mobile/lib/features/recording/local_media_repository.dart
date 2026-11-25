import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:crypto/crypto.dart';

import '../../core/api_client.dart';
import 'local_media_database.dart';
import 'local_media_models.dart';
import 'local_media_persistence.dart';
import 'local_media_persistence.dart' as media_persistence;
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
  Future<void> _lifecycleTail = Future<void>.value();
  Future<void> _migrationTail = Future<void>.value();
  final Map<String, Future<LocalMediaRecoveryReport>> _recoveryInFlight =
      <String, Future<LocalMediaRecoveryReport>>{};
  final Map<String, LocalMediaRecoveryReport> _completedRecoveries =
      <String, LocalMediaRecoveryReport>{};
  final Map<String, int> _activeAssetLeases = <String, int>{};
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
  }) => _withLifecycleLock(
    () => _rememberForOwner(
      deploymentScope: scope.deploymentScope,
      ownerUserId: scope.userId,
      meetingId: meetingId,
      source: source,
      sourceType: sourceType,
      originalFilename: originalFilename,
      contentType: contentType,
      expectedSizeBytes: expectedSizeBytes,
      sourceProvenance: sourceProvenance,
    ),
  );

  /// Imports a picker or document-provider stream directly into managed
  /// staging. The source is never retained as the managed asset's path and
  /// the complete source is never buffered in memory.
  Future<LocalMediaAsset> importStream({
    required AuthenticatedSessionScope scope,
    required String meetingId,
    required Stream<List<int>> bytes,
    required int expectedSizeBytes,
    required LocalMediaSourceType sourceType,
    required String originalFilename,
    required String contentType,
    String? sourceProvenance,
    UploadCancellationToken? cancellationToken,
  }) => _importStreamForOwner(
    deploymentScope: scope.deploymentScope,
    ownerUserId: scope.userId,
    meetingId: meetingId,
    bytes: bytes,
    expectedSizeBytes: expectedSizeBytes,
    sourceType: sourceType,
    originalFilename: originalFilename,
    contentType: contentType,
    sourceProvenance: sourceProvenance,
    cancellationToken: cancellationToken,
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

  Future<List<UploadOperation>> listUploadOperations({
    required AuthenticatedSessionScope scope,
    String? meetingId,
    String? assetId,
    String? remoteMediaId,
    bool recoverableOnly = false,
  }) async {
    _requireScope(scope.deploymentScope, scope.userId);
    return (await _persistence()).listUploadOperations(
      deploymentScope: scope.deploymentScope,
      ownerUserId: scope.userId,
      meetingId: meetingId,
      assetId: assetId,
      remoteMediaId: remoteMediaId,
      recoverableOnly: recoverableOnly,
    );
  }

  Future<UploadOperation?> findUploadOperationById({
    required AuthenticatedSessionScope scope,
    required String operationId,
  }) async {
    _requireScope(scope.deploymentScope, scope.userId);
    return (await _persistence()).findUploadOperationById(
      id: operationId,
      deploymentScope: scope.deploymentScope,
      ownerUserId: scope.userId,
    );
  }

  Future<List<ProcessingOperation>> listProcessingOperations({
    required AuthenticatedSessionScope scope,
    String? meetingId,
    String? sourceMediaId,
    String? operationId,
    String? remoteJobId,
    bool recoverableOnly = false,
  }) async {
    _requireScope(scope.deploymentScope, scope.userId);
    return (await _persistence()).listProcessingOperations(
      deploymentScope: scope.deploymentScope,
      ownerUserId: scope.userId,
      meetingId: meetingId,
      sourceMediaId: sourceMediaId,
      operationId: operationId,
      remoteJobId: remoteJobId,
      recoverableOnly: recoverableOnly,
    );
  }

  Future<ProcessingOperation?> findProcessingOperationById({
    required AuthenticatedSessionScope scope,
    required String operationId,
  }) async {
    _requireScope(scope.deploymentScope, scope.userId);
    return (await _persistence()).findProcessingOperationById(
      id: operationId,
      deploymentScope: scope.deploymentScope,
      ownerUserId: scope.userId,
    );
  }

  /// Fences destructive local actions while a coordinator is using the
  /// managed bytes. This is intentionally a narrow asset-level primitive, not
  /// a general workflow lock.
  Future<T> withAssetProtection<T>({
    required AuthenticatedSessionScope scope,
    required String assetId,
    required Future<T> Function() action,
  }) async {
    _requireScope(scope.deploymentScope, scope.userId);
    await _withLifecycleLock(() async {
      final asset = await (await _persistence()).findAsset(
        id: assetId,
        deploymentScope: scope.deploymentScope,
        ownerUserId: scope.userId,
      );
      if (asset == null) throw const LocalMediaOwnershipException();
      if (asset.lifecycle == LocalMediaLifecycle.discarded ||
          asset.lifecycle == LocalMediaLifecycle.discardPending) {
        throw const LocalMediaUnavailableException();
      }
      _acquireAssetLease(assetId);
    });
    try {
      return await action();
    } finally {
      await _withLifecycleLock(() async {
        _releaseAssetLease(assetId);
      });
    }
  }

  Future<File> fileFor({
    required AuthenticatedSessionScope scope,
    required LocalMediaAsset asset,
  }) async {
    _requireAssetOwner(asset, scope);
    final persisted = await (await _persistence()).findAsset(
      id: asset.id,
      deploymentScope: scope.deploymentScope,
      ownerUserId: scope.userId,
    );
    if (persisted == null ||
        persisted.meetingId != asset.meetingId ||
        !persisted.isReady ||
        persisted.sizeBytes == null ||
        persisted.sizeBytes! <= 0 ||
        persisted.sha256 == null ||
        !RegExp(r'^[0-9a-fA-F]{64}$').hasMatch(persisted.sha256!)) {
      throw const LocalMediaUnavailableException();
    }
    final storage = await _storage();
    final file = storage.fileFor(persisted.managedRelativePath);
    try {
      if (!await file.exists() ||
          await file.length() != persisted.sizeBytes ||
          !_matchesConfirmed(
            persisted,
            await storage.inspectFile(persisted.managedRelativePath),
          )) {
        throw const LocalMediaUnavailableException();
      }
    } on FileSystemException {
      throw const LocalMediaUnavailableException();
    }
    return file;
  }

  /// Resolves a ready managed file for routine listing without re-reading the
  /// entire recording. Integrity is re-established by [fileFor] at submission
  /// and recovery boundaries.
  Future<File> lightweightFileFor({
    required AuthenticatedSessionScope scope,
    required LocalMediaAsset asset,
  }) async {
    _requireAssetOwner(asset, scope);
    final persisted = await (await _persistence()).findAsset(
      id: asset.id,
      deploymentScope: scope.deploymentScope,
      ownerUserId: scope.userId,
    );
    if (persisted == null ||
        persisted.meetingId != asset.meetingId ||
        !persisted.isReady ||
        persisted.sizeBytes == null ||
        persisted.sizeBytes! <= 0 ||
        !_hasCompletionEvidence(persisted)) {
      throw const LocalMediaUnavailableException();
    }
    final file = (await _storage()).fileFor(persisted.managedRelativePath);
    try {
      if (!await file.exists()) {
        await _markUnavailable(persisted, missing: true);
        throw const LocalMediaUnavailableException();
      }
      if (await file.length() != persisted.sizeBytes) {
        await _markUnavailable(persisted);
        throw const LocalMediaUnavailableException();
      }
    } on FileSystemException {
      await _markUnavailable(persisted);
      throw const LocalMediaUnavailableException();
    }
    return file;
  }

  Future<void> _markUnavailable(
    LocalMediaAsset expected, {
    bool missing = false,
  }) async {
    await _withLifecycleLock(() async {
      final current = await (await _persistence()).findAsset(
        id: expected.id,
        deploymentScope: expected.deploymentScope,
        ownerUserId: expected.ownerUserId,
      );
      if (current == null ||
          current.version != expected.version ||
          _isAssetProtected(current.id) ||
          !current.isReady) {
        return;
      }
      await (await _persistence()).updateAsset(
        current.copyWith(
          lifecycle: missing
              ? LocalMediaLifecycle.missing
              : LocalMediaLifecycle.unavailable,
          quarantineReason: missing
              ? 'MANAGED_FILE_MISSING'
              : 'MANAGED_FILE_UNAVAILABLE',
          updatedAt: _utcNow(),
        ),
        expectedVersion: current.version,
      );
    });
  }

  Future<LocalMediaAsset> findReadyAsset({
    required AuthenticatedSessionScope scope,
    required String assetId,
    required String meetingId,
  }) async {
    _requireScope(scope.deploymentScope, scope.userId);
    _validateIdentifier(meetingId, 'meetingId');
    final asset = await (await _persistence()).findAsset(
      id: assetId,
      deploymentScope: scope.deploymentScope,
      ownerUserId: scope.userId,
    );
    if (asset == null ||
        asset.meetingId != meetingId ||
        !asset.isReady ||
        asset.sizeBytes == null ||
        asset.sizeBytes! <= 0 ||
        asset.sha256 == null ||
        !RegExp(r'^[0-9a-fA-F]{64}$').hasMatch(asset.sha256!)) {
      throw const LocalMediaUnavailableException();
    }
    final file = (await _storage()).fileFor(asset.managedRelativePath);
    if (!await file.exists() || await file.length() != asset.sizeBytes) {
      throw const LocalMediaUnavailableException();
    }
    return asset;
  }

  /// Reserves ownership and both managed locations before a native writer is
  /// allowed to create bytes.
  Future<LocalMediaAsset> reserveAsset({
    required AuthenticatedSessionScope scope,
    required String meetingId,
    required LocalMediaSourceType sourceType,
    required String originalFilename,
    required String contentType,
    String? sourceProvenance,
    DateTime? createdAt,
    String? assetId,
  }) => _withLifecycleLock(() async {
    _requireScope(scope.deploymentScope, scope.userId);
    _validateIdentifier(meetingId, 'meetingId');
    _validateFilename(originalFilename);
    _validateContentType(contentType);
    final persistence = await _persistence();
    final storage = await _storage();
    await storage.ensureDirectories();
    final provenance =
        sourceProvenance ??
        'reserved:${scope.deploymentScope}:$meetingId:'
            '${sourceType.wireValue}:$originalFilename:$contentType';
    final existing = await persistence.findAssetByProvenance(
      deploymentScope: scope.deploymentScope,
      ownerUserId: scope.userId,
      meetingId: meetingId,
      sourceProvenance: provenance,
    );
    if (existing != null) return existing;
    final id = assetId ?? _newId();
    final paths = storage.allocatePaths(id);
    final now = _utcNow();
    final asset = LocalMediaAsset(
      id: id,
      deploymentScope: scope.deploymentScope,
      ownerUserId: scope.userId,
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
      createdAt: (createdAt ?? now).toUtc(),
      updatedAt: now,
      readyAt: null,
      version: 0,
    );
    return persistence.insertAsset(asset);
  });

  Future<File> stagingFileFor({
    required AuthenticatedSessionScope scope,
    required LocalMediaAsset asset,
  }) => _withLifecycleLock(() async {
    _requireAssetOwner(asset, scope);
    final persisted = await (await _persistence()).findAsset(
      id: asset.id,
      deploymentScope: scope.deploymentScope,
      ownerUserId: scope.userId,
    );
    if (persisted == null || persisted.stagedRelativePath == null) {
      throw const LocalMediaUnavailableException();
    }
    if (persisted.lifecycle == LocalMediaLifecycle.discarded ||
        persisted.lifecycle == LocalMediaLifecycle.quarantined ||
        persisted.lifecycle == LocalMediaLifecycle.discardPending) {
      throw const LocalMediaUnavailableException();
    }
    if (persisted.lifecycle != LocalMediaLifecycle.creating &&
        persisted.lifecycle != LocalMediaLifecycle.staged) {
      throw const LocalMediaUnavailableException();
    }
    // Registration and destination lookup are one lifecycle-critical section.
    // The section ends before the recorder starts, so it does not lock a
    // recording for its full duration.
    _acquireAssetLease(persisted.id);
    return (await _storage()).fileFor(persisted.stagedRelativePath!);
  });

  Future<LocalMediaAsset> confirmFileCompletion({
    required AuthenticatedSessionScope scope,
    required String assetId,
    int? expectedSizeBytes,
  }) => _withLifecycleLock(() async {
    _requireScope(scope.deploymentScope, scope.userId);
    final persistence = await _persistence();
    final asset = await persistence.findAsset(
      id: assetId,
      deploymentScope: scope.deploymentScope,
      ownerUserId: scope.userId,
    );
    if (asset == null) throw const LocalMediaOwnershipException();
    if (asset.lifecycle == LocalMediaLifecycle.discarded ||
        asset.lifecycle == LocalMediaLifecycle.quarantined) {
      return asset;
    }
    if (asset.lifecycle == LocalMediaLifecycle.interrupted ||
        asset.lifecycle == LocalMediaLifecycle.missing ||
        asset.lifecycle == LocalMediaLifecycle.unavailable) {
      throw const LocalMediaUnavailableException();
    }
    if (asset.lifecycle == LocalMediaLifecycle.discardPending) {
      _releaseAssetLease(asset.id);
      return _discardAssetFiles(persistence, await _storage(), asset);
    }
    if (asset.stagedRelativePath == null) {
      throw const LocalMediaUnavailableException();
    }
    final storage = await _storage();
    final acquiredHere = !_isAssetProtected(asset.id);
    if (acquiredHere) _acquireAssetLease(asset.id);
    try {
      final integrity = await storage.inspectFile(asset.stagedRelativePath!);
      if (integrity.sizeBytes <= 0 ||
          expectedSizeBytes != null &&
              integrity.sizeBytes != expectedSizeBytes) {
        return await persistence.updateAsset(
          asset.copyWith(
            lifecycle: LocalMediaLifecycle.interrupted,
            quarantineReason: 'FILE_COMPLETION_INVALID',
            updatedAt: _utcNow(),
          ),
          expectedVersion: asset.version,
        );
      }
      var staged = await persistence.updateAsset(
        asset.copyWith(
          lifecycle: LocalMediaLifecycle.staged,
          sizeBytes: integrity.sizeBytes,
          sha256: integrity.sha256,
          quarantineReason: null,
          updatedAt: _utcNow(),
        ),
        expectedVersion: asset.version,
      );
      staged = await persistence.updateAsset(
        staged.copyWith(
          lifecycle: LocalMediaLifecycle.promotionPending,
          updatedAt: _utcNow(),
        ),
        expectedVersion: staged.version,
      );
      await storage.promote(
        staged.stagedRelativePath!,
        staged.managedRelativePath,
      );
      return await persistence.updateAsset(
        staged.copyWith(
          lifecycle: LocalMediaLifecycle.ready,
          readyAt: staged.readyAt ?? _utcNow(),
          updatedAt: _utcNow(),
        ),
        expectedVersion: staged.version,
      );
    } on FileSystemException {
      try {
        await persistence.updateAsset(
          asset.copyWith(
            lifecycle: LocalMediaLifecycle.interrupted,
            quarantineReason: 'FILE_COMPLETION_UNREADABLE',
            updatedAt: _utcNow(),
          ),
          expectedVersion: asset.version,
        );
      } catch (_) {}
      rethrow;
    } finally {
      if (acquiredHere) _releaseAssetLease(asset.id);
    }
  });

  Future<LocalMediaAsset> recordInterruption({
    required AuthenticatedSessionScope scope,
    required String assetId,
    String reason = 'FILE_CREATION_INTERRUPTED',
  }) => _withLifecycleLock(() async {
    final persistence = await _persistence();
    final asset = await persistence.findAsset(
      id: assetId,
      deploymentScope: scope.deploymentScope,
      ownerUserId: scope.userId,
    );
    if (asset == null) throw const LocalMediaOwnershipException();
    if (asset.lifecycle == LocalMediaLifecycle.quarantined ||
        asset.lifecycle == LocalMediaLifecycle.discarded) {
      return asset;
    }
    if (asset.lifecycle == LocalMediaLifecycle.discardPending) {
      _releaseAssetLease(asset.id);
      return _discardAssetFiles(persistence, await _storage(), asset);
    }
    _releaseAssetLease(asset.id);
    return persistence.updateAsset(
      asset.copyWith(
        lifecycle: LocalMediaLifecycle.interrupted,
        quarantineReason: reason,
        updatedAt: _utcNow(),
      ),
      expectedVersion: asset.version,
    );
  });

  Future<LocalMediaAsset> discard({
    required AuthenticatedSessionScope scope,
    required String assetId,
  }) => _withLifecycleLock(() async {
    final persistence = await _persistence();
    final asset = await persistence.findAsset(
      id: assetId,
      deploymentScope: scope.deploymentScope,
      ownerUserId: scope.userId,
    );
    if (asset == null) throw StateError('The local media asset was not found.');
    if (_isAssetProtected(asset.id)) {
      throw const LocalMediaBusyException();
    }
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
    if (stagedPath != null && _isStagingPath(stagedPath)) {
      await _deleteIfPresent(storage, stagedPath);
    }
    pending = await persistence.updateAsset(
      pending.copyWith(
        lifecycle: LocalMediaLifecycle.discarded,
        updatedAt: _utcNow(),
      ),
      expectedVersion: pending.version,
    );
    return pending;
  });

  Future<LocalMediaRecoveryReport> reconcile({
    required AuthenticatedSessionScope scope,
    String? meetingId,
  }) => _withLifecycleLock(
    () => _reconcileUnlocked(scope: scope, meetingId: meetingId),
  );

  /// Activates local recovery for one authenticated workspace scope.
  ///
  /// Recovery is deliberately explicit rather than being part of routine
  /// listing. A successful scope is memoized for the lifetime of this
  /// repository, while incomplete or failed work remains retryable. Concurrent
  /// callers share the same execution and never compete over filesystem
  /// mutations.
  Future<LocalMediaRecoveryReport> recoverLocalState({
    required AuthenticatedSessionScope scope,
    String? meetingId,
    CredentialStorage? storage,
    bool retry = false,
  }) {
    _requireScope(scope.deploymentScope, scope.userId);
    _releaseObsoleteRecoveryMemoization(scope, meetingId);
    final key =
        '${scope.deploymentScope}\u0000${scope.userId}\u0000'
        '${scope.lifecycleEpoch}\u0000${meetingId ?? ''}';
    final inFlight = _recoveryInFlight[key];
    if (inFlight != null) return inFlight;
    final completed = _completedRecoveries[key];
    if (completed != null && !retry)
      return Future<LocalMediaRecoveryReport>.value(completed);

    final future = _withLifecycleLock(
      () => _withMigrationLock(() async {
        final migration = await _migrateLegacyMetadataUnlocked(
          storage: storage ?? legacyStorage,
          scope: scope,
        );
        final report = await _reconcileUnlocked(
          scope: scope,
          meetingId: meetingId,
        );
        // A migration left in STARTED state because a source file was
        // temporarily unavailable must be retried on a later workspace entry.
        if (migration?.state != LocalMediaMigrationState.started) {
          _completedRecoveries[key] = report;
        } else {
          _completedRecoveries.remove(key);
        }
        return report;
      }),
    );
    _recoveryInFlight[key] = future;
    unawaited(
      future.then<void>(
        (_) {
          if (identical(_recoveryInFlight[key], future)) {
            _recoveryInFlight.remove(key);
          }
        },
        onError: (Object _, StackTrace __) {
          if (identical(_recoveryInFlight[key], future)) {
            _recoveryInFlight.remove(key);
          }
        },
      ),
    );
    return future;
  }

  /// Recovery results are valid only for the authenticated lifecycle that
  /// established them. A later login may have the same owner and deployment,
  /// but it must not inherit a completed result from the previous lifecycle.
  /// This only releases in-memory memoization; it never touches local media.
  void _releaseObsoleteRecoveryMemoization(
    AuthenticatedSessionScope scope,
    String? meetingId,
  ) {
    final prefix = '${scope.deploymentScope}\u0000${scope.userId}\u0000';
    final suffix = '\u0000${meetingId ?? ''}';
    _completedRecoveries.removeWhere(
      (key, _) =>
          key.startsWith(prefix) &&
          key.endsWith(suffix) &&
          key != '$prefix${scope.lifecycleEpoch}$suffix',
    );
  }

  Future<LocalMediaRecoveryReport> _reconcileUnlocked({
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
    var orphaned = 0;
    for (final asset in assets) {
      if (_isAssetProtected(asset.id)) continue;
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
    final allAssets = await persistence.listAllAssets();
    final referenced = <String>{
      for (final candidate in allAssets) ...<String>[
        candidate.managedRelativePath,
        if (candidate.stagedRelativePath != null) candidate.stagedRelativePath!,
      ],
    };
    referenced.addAll(
      (await persistence.listRecoveryArtifacts()).map(
        (artifact) => artifact.relativePath,
      ),
    );
    for (final relativePath in await storage.listFiles()) {
      if (referenced.contains(relativePath) ||
          relativePath == 'quarantine' ||
          relativePath.startsWith('quarantine${Platform.pathSeparator}')) {
        continue;
      }
      final quarantinedPath = await storage.quarantine(
        relativePath,
        reason: 'unmanaged-orphan',
      );
      await _recordRecoveryArtifact(
        persistence,
        relativePath: quarantinedPath,
        originalRelativePath: relativePath,
        reason: 'UNMANAGED_FILESYSTEM_ARTIFACT',
      );
      orphaned++;
    }
    return LocalMediaRecoveryReport(
      inspected: assets.length,
      ready: ready,
      missing: missing,
      quarantined: quarantined,
      interrupted: interrupted,
      orphaned: orphaned,
    );
  }

  Future<int> cleanupStaleStaging({
    required AuthenticatedSessionScope scope,
    Duration maxAge = const Duration(days: 7),
  }) => _withLifecycleLock(() async {
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
      if (_isAssetProtected(asset.id)) continue;
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
  });

  Future<UploadOperation> beginUploadOperation({
    required AuthenticatedSessionScope scope,
    required LocalMediaAsset asset,
    required String idempotencyKey,
    String? requestFingerprint,
  }) async {
    _requireAssetOwner(asset, scope);
    _validateIdempotencyKey(idempotencyKey);
    final persistence = await _persistence();
    final existing = await persistence.findUploadOperation(
      deploymentScope: scope.deploymentScope,
      ownerUserId: scope.userId,
      idempotencyKey: idempotencyKey,
    );
    if (existing != null) {
      if (existing.assetId != asset.id ||
          existing.meetingId != asset.meetingId ||
          existing.sourceType != asset.sourceType ||
          existing.originalFilename != asset.originalFilename ||
          existing.contentType != asset.contentType ||
          asset.sizeBytes != null &&
              existing.expectedSizeBytes != asset.sizeBytes) {
        throw const LocalMediaIdempotencyConflictException();
      }
      // The request fingerprint may have been produced by an older canonical
      // algorithm. Exact persisted request fields above are the compatibility
      // authority; never regenerate the stored key or metadata.
      return existing;
    }
    final persistedAsset = await findReadyAsset(
      scope: scope,
      assetId: asset.id,
      meetingId: asset.meetingId ?? '',
    );
    if (persistedAsset.meetingId == null) {
      throw const LocalMediaUnavailableException();
    }
    final expectedFingerprint = _uploadFingerprint(scope, persistedAsset);
    if (requestFingerprint != null &&
        requestFingerprint != expectedFingerprint) {
      throw const LocalMediaIdempotencyConflictException();
    }
    final now = _utcNow();
    try {
      return await persistence.getOrCreateUploadOperation(
        UploadOperation(
          id: _newId(),
          assetId: persistedAsset.id,
          deploymentScope: scope.deploymentScope,
          ownerUserId: scope.userId,
          meetingId: persistedAsset.meetingId!,
          idempotencyKey: idempotencyKey,
          requestFingerprint: expectedFingerprint,
          sourceType: persistedAsset.sourceType,
          originalFilename: persistedAsset.originalFilename,
          contentType: persistedAsset.contentType,
          expectedSizeBytes: persistedAsset.sizeBytes!,
          remoteMediaId: null,
          checkpoint: UploadOperationCheckpoint.intentNotConfirmed,
          confirmedBytes: 0,
          attemptCount: 0,
          attemptOutcome: OperationAttemptOutcome.none,
          recoveryRequired: false,
          lastFailureCode: null,
          lastFailureStatus: null,
          lastFailureMessage: null,
          createdAt: now,
          updatedAt: now,
          version: 0,
        ),
      );
    } on media_persistence.LocalMediaIdempotencyConflictException {
      throw const LocalMediaIdempotencyConflictException();
    }
  }

  Future<UploadOperation> updateUploadOperation(
    UploadOperation operation, {
    required AuthenticatedSessionScope scope,
    UploadOperationCheckpoint? checkpoint,
    String? remoteMediaId,
    int? confirmedBytes,
    int? attemptCount,
    OperationAttemptOutcome? attemptOutcome,
    bool? recoveryRequired,
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
    final confirmedCheckpoint = _mergeUploadCheckpoint(
      operation.checkpoint,
      checkpoint,
    );
    final next = operation.copyWith(
      checkpoint: confirmedCheckpoint,
      remoteMediaId: remoteMediaId,
      confirmedBytes: confirmedBytes,
      attemptCount: attemptCount,
      attemptOutcome: attemptOutcome,
      recoveryRequired: recoveryRequired,
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
    String? requestFingerprint,
    required ProcessingOperationType operationType,
    String? sourceMediaId,
    String? reprocessOfJobId,
    String? stageCode,
    String? targetJobId,
  }) async {
    _requireScope(scope.deploymentScope, scope.userId);
    _validateIdentifier(meetingId, 'meetingId');
    _validateIdempotencyKey(idempotencyKey);
    _validateOptionalIdentifier(sourceMediaId, 'sourceMediaId');
    _validateOptionalIdentifier(reprocessOfJobId, 'reprocessOfJobId');
    _validateOptionalIdentifier(targetJobId, 'targetJobId');
    _validateOptionalStage(stageCode);
    final expectedFingerprint = _processingFingerprint(
      scope: scope,
      meetingId: meetingId,
      operationType: operationType,
      sourceMediaId: sourceMediaId,
      targetJobId: targetJobId,
      reprocessOfJobId: reprocessOfJobId,
      stageCode: stageCode,
    );
    if (requestFingerprint != null &&
        requestFingerprint != expectedFingerprint) {
      throw const LocalMediaIdempotencyConflictException();
    }
    final persistence = await _persistence();
    final now = _utcNow();
    try {
      return await persistence.getOrCreateProcessingOperation(
        ProcessingOperation(
          id: _newId(),
          deploymentScope: scope.deploymentScope,
          ownerUserId: scope.userId,
          meetingId: meetingId,
          idempotencyKey: idempotencyKey,
          requestFingerprint: expectedFingerprint,
          operationType: operationType,
          sourceMediaId: sourceMediaId,
          targetJobId: targetJobId,
          resultingJobId: null,
          reprocessOfJobId: reprocessOfJobId,
          stageCode: stageCode,
          checkpoint: switch (operationType) {
            ProcessingOperationType.admission =>
              ProcessingOperationCheckpoint.admissionNotConfirmed,
            ProcessingOperationType.retry =>
              ProcessingOperationCheckpoint.retryNotConfirmed,
            ProcessingOperationType.reprocess =>
              ProcessingOperationCheckpoint.reprocessNotConfirmed,
          },
          attemptCount: 0,
          attemptOutcome: OperationAttemptOutcome.none,
          recoveryRequired: false,
          lastFailureCode: null,
          lastFailureStatus: null,
          lastFailureMessage: null,
          createdAt: now,
          updatedAt: now,
          version: 0,
        ),
      );
    } on media_persistence.LocalMediaIdempotencyConflictException {
      throw const LocalMediaIdempotencyConflictException();
    }
  }

  Future<ProcessingOperation> updateProcessingOperation(
    ProcessingOperation operation, {
    required AuthenticatedSessionScope scope,
    ProcessingOperationCheckpoint? checkpoint,
    String? resultingJobId,
    int? attemptCount,
    OperationAttemptOutcome? attemptOutcome,
    bool? recoveryRequired,
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
      checkpoint: _mergeProcessingCheckpoint(operation.checkpoint, checkpoint),
      resultingJobId: resultingJobId,
      attemptCount: attemptCount,
      attemptOutcome: attemptOutcome,
      recoveryRequired: recoveryRequired,
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

  /// Migrates both the original unscoped index and the account-scoped v2
  /// indexes used by the previous application version.
  ///
  /// The v2 key is derived from the explicitly supplied verified scope. A
  /// caller cannot migrate an arbitrary index by merely being signed in.
  Future<LocalMediaMigrationRecord?> migrateLegacyMetadata({
    CredentialStorage? storage,
    String legacyStorageKey = 'sme.mobile.recordings.v1',
    AuthenticatedSessionScope? scope,
  }) => _withLifecycleLock(
    () => _withMigrationLock(
      () => _migrateLegacyMetadataUnlocked(
        storage: storage,
        legacyStorageKey: legacyStorageKey,
        scope: scope,
      ),
    ),
  );

  Future<LocalMediaMigrationRecord?> _migrateLegacyMetadataUnlocked({
    CredentialStorage? storage,
    String legacyStorageKey = 'sme.mobile.recordings.v1',
    AuthenticatedSessionScope? scope,
  }) async {
    final sourceStorage = storage ?? legacyStorage;
    if (sourceStorage == null) return null;
    LocalMediaMigrationRecord? result;
    final unscoped = await sourceStorage.read(key: legacyStorageKey);
    if (unscoped != null) {
      result = await _quarantineUnscopedLegacy(
        sourceStorage,
        legacyStorageKey,
        unscoped,
      );
    }
    if (scope != null) {
      final scopedKey = legacyStorageKeyForScope(scope);
      final scoped = await sourceStorage.read(key: scopedKey);
      if (scoped != null) {
        result = await _migrateScopedLegacy(
          sourceStorage,
          scopedKey,
          scoped,
          scope,
        );
      }
    }
    return result;
  }

  static String legacyStorageKeyForScope(AuthenticatedSessionScope scope) {
    final ownerDigest = sha256
        .convert(utf8.encode('${scope.deploymentScope}\u0000${scope.userId}'))
        .toString();
    return 'sme.mobile.recordings.v2.$ownerDigest';
  }

  Future<LocalMediaMigrationRecord> _quarantineUnscopedLegacy(
    CredentialStorage sourceStorage,
    String sourceKey,
    String raw,
  ) async {
    final persistence = await _persistence();
    final key = sha256
        .convert(utf8.encode('unscoped\u0000$sourceKey\u0000$raw'))
        .toString();
    final existing = await persistence.findMigration(key);
    if (existing?.state == LocalMediaMigrationState.completed ||
        existing?.state == LocalMediaMigrationState.quarantined) {
      await sourceStorage.delete(key: sourceKey);
      await sourceStorage.confirmDurable();
      return existing!;
    }
    final startedAt = _utcNow();
    await _appendLegacyQuarantine(
      sourceStorage,
      raw,
      sourceKey: sourceKey,
      reason: 'UNSCOPED_LEGACY_METADATA',
    );
    final completed = LocalMediaMigrationRecord(
      id: existing?.id ?? _newId(),
      migrationKey: key,
      deploymentScope: null,
      ownerUserId: null,
      sourceDescription: sourceKey,
      state: LocalMediaMigrationState.quarantined,
      detail: 'The unscoped legacy index was preserved without assigning ownership.',
      createdAt: existing?.createdAt ?? startedAt,
      updatedAt: _utcNow(),
    );
    final result = await persistence.upsertMigration(completed);
    await sourceStorage.delete(key: sourceKey);
    await sourceStorage.confirmDurable();
    return result;
  }

  Future<LocalMediaMigrationRecord> _migrateScopedLegacy(
    CredentialStorage sourceStorage,
    String sourceKey,
    String raw,
    AuthenticatedSessionScope scope,
  ) async {
    final persistence = await _persistence();
    final migrationKey = sha256
        .convert(utf8.encode('scoped-v2\u0000$sourceKey'))
        .toString();
    final existing = await persistence.findMigration(migrationKey);
    final startedAt = existing?.createdAt ?? _utcNow();
    final Object? decoded;
    try {
      decoded = jsonDecode(raw);
    } on FormatException {
      await _appendLegacyQuarantine(
        sourceStorage,
        raw,
        sourceKey: sourceKey,
        reason: 'SCOPED_LEGACY_INDEX_INVALID_JSON',
      );
      final result = await persistence.upsertMigration(
        LocalMediaMigrationRecord(
          id: existing?.id ?? _newId(),
          migrationKey: migrationKey,
          deploymentScope: scope.deploymentScope,
          ownerUserId: scope.userId,
          sourceDescription: sourceKey,
          state: LocalMediaMigrationState.quarantined,
          detail: 'The scoped legacy index was not valid JSON.',
          createdAt: startedAt,
          updatedAt: _utcNow(),
        ),
      );
      await sourceStorage.delete(key: sourceKey);
      await sourceStorage.confirmDurable();
      return result;
    }
    if (decoded is! List) {
      await _appendLegacyQuarantine(
        sourceStorage,
        raw,
        sourceKey: sourceKey,
        reason: 'SCOPED_LEGACY_INDEX_INVALID',
      );
      final result = await persistence.upsertMigration(
        LocalMediaMigrationRecord(
          id: existing?.id ?? _newId(),
          migrationKey: migrationKey,
          deploymentScope: scope.deploymentScope,
          ownerUserId: scope.userId,
          sourceDescription: sourceKey,
          state: LocalMediaMigrationState.quarantined,
          detail: 'The scoped legacy index was not a list.',
          createdAt: startedAt,
          updatedAt: _utcNow(),
        ),
      );
      await sourceStorage.delete(key: sourceKey);
      await sourceStorage.confirmDurable();
      return result;
    }

    final remaining = <Object?>[];
    var imported = 0;
    var quarantined = 0;
    for (final item in decoded) {
      final entry = item is Map
          ? item.map((key, value) => MapEntry(key.toString(), value))
          : null;
      final entryIdentity = sha256
          .convert(
            utf8.encode(
              'scoped-v2-entry\u0000$sourceKey\u0000'
              '${jsonEncode(_canonicalLegacyValue(item))}',
            ),
          )
          .toString();
      final prior = await persistence.findMigration(entryIdentity);
      if (prior?.state == LocalMediaMigrationState.completed ||
          prior?.state == LocalMediaMigrationState.quarantined) {
        continue;
      }

      try {
        if (entry == null) {
          throw const _InvalidLegacyMetadata('Entry is not an object.');
        }
        final deployment = _text(entry['deploymentScope']);
        final owner = _text(entry['userId']);
        final meeting = _text(entry['meetingId']);
        final sourcePath = _text(entry['path']);
        if (deployment == null ||
            owner == null ||
            deployment != scope.deploymentScope ||
            owner != scope.userId) {
          throw const _InvalidLegacyMetadata(
            'The legacy entry ownership does not match its storage scope.',
          );
        }
        if (meeting == null || sourcePath == null) {
          throw const _InvalidLegacyMetadata(
            'The legacy entry is missing ownership or source metadata.',
          );
        }
        final source = File(sourcePath);
        if (!await source.exists()) {
          throw const _RecoverableLegacyFailure(
            'The legacy source file is not currently available.',
          );
        }
        final createdAt = _legacyTimestamp(entry['createdAt']);
        final filename = _text(entry['name']) ?? source.uri.pathSegments.last;
        final contentType = _legacyContentType(entry, filename);
        final sourceType = _legacySourceType(entry);
        final sourceProvenance =
            _text(entry['sourceProvenance']) ??
            'legacy-v2:$entryIdentity:${source.absolute.path}';
        final expectedSize = _legacyPositiveInt(entry['sizeBytes']);
        final asset = await _rememberForOwner(
          deploymentScope: deployment,
          ownerUserId: owner,
          meetingId: meeting,
          source: source,
          sourceType: sourceType,
          originalFilename: filename,
          contentType: contentType,
          expectedSizeBytes: expectedSize,
          sourceProvenance: sourceProvenance,
          assetId: entryIdentity.substring(0, 32),
          createdAt: createdAt,
        );
        final verified = await _verifyReadyAsset(asset);
        if (!verified) {
          throw const _RecoverableLegacyFailure(
            'The replacement asset did not pass local verification.',
          );
        }
        await persistence.upsertMigration(
          LocalMediaMigrationRecord(
            id: prior?.id ?? _newId(),
            migrationKey: entryIdentity,
            deploymentScope: deployment,
            ownerUserId: owner,
            sourceDescription: sourceKey,
            state: LocalMediaMigrationState.completed,
            detail: 'Migrated asset ${asset.id}.',
            createdAt: prior?.createdAt ?? _utcNow(),
            updatedAt: _utcNow(),
          ),
        );
        imported++;
      } on _InvalidLegacyMetadata catch (error) {
        quarantined++;
        await _appendLegacyQuarantine(
          sourceStorage,
          jsonEncode(item),
          sourceKey: sourceKey,
          reason: error.reason,
        );
        await persistence.upsertMigration(
          LocalMediaMigrationRecord(
            id: prior?.id ?? _newId(),
            migrationKey: entryIdentity,
            deploymentScope: scope.deploymentScope,
            ownerUserId: scope.userId,
            sourceDescription: sourceKey,
            state: LocalMediaMigrationState.quarantined,
            detail: error.reason,
            createdAt: prior?.createdAt ?? _utcNow(),
            updatedAt: _utcNow(),
          ),
        );
      } on _RecoverableLegacyFailure catch (error) {
        remaining.add(item);
        await persistence.upsertMigration(
          LocalMediaMigrationRecord(
            id: prior?.id ?? _newId(),
            migrationKey: entryIdentity,
            deploymentScope: scope.deploymentScope,
            ownerUserId: scope.userId,
            sourceDescription: sourceKey,
            state: LocalMediaMigrationState.started,
            detail: error.reason,
            createdAt: prior?.createdAt ?? _utcNow(),
            updatedAt: _utcNow(),
          ),
        );
      } on Object catch (error) {
        remaining.add(item);
        await persistence.upsertMigration(
          LocalMediaMigrationRecord(
            id: prior?.id ?? _newId(),
            migrationKey: entryIdentity,
            deploymentScope: scope.deploymentScope,
            ownerUserId: scope.userId,
            sourceDescription: sourceKey,
            state: LocalMediaMigrationState.started,
            detail: 'Recoverable migration failure: ${error.runtimeType}.',
            createdAt: prior?.createdAt ?? _utcNow(),
            updatedAt: _utcNow(),
          ),
        );
      }
    }

    if (remaining.isNotEmpty) {
      await sourceStorage.write(key: sourceKey, value: jsonEncode(remaining));
      await sourceStorage.confirmDurable();
    } else {
      await sourceStorage.delete(key: sourceKey);
      await sourceStorage.confirmDurable();
    }
    return persistence.upsertMigration(
      LocalMediaMigrationRecord(
        id: existing?.id ?? _newId(),
        migrationKey: migrationKey,
        deploymentScope: scope.deploymentScope,
        ownerUserId: scope.userId,
        sourceDescription: sourceKey,
        state: remaining.isNotEmpty
            ? LocalMediaMigrationState.started
            : quarantined > 0
            ? LocalMediaMigrationState.quarantined
            : LocalMediaMigrationState.completed,
        detail:
            'Imported $imported entries; quarantined $quarantined; '
            'recoverable ${remaining.length}.',
        createdAt: startedAt,
        updatedAt: _utcNow(),
      ),
    );
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
    String? assetId,
    DateTime? createdAt,
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
      meetingId: meetingId,
      sourceProvenance: provenance,
    );
    late LocalMediaAsset asset;
    if (existing != null) {
      final managed = storage.fileFor(existing.managedRelativePath);
      if (existing.isReady &&
          await managed.exists() &&
          await _verifyReadyAsset(existing)) {
        return existing;
      }
      if (existing.lifecycle == LocalMediaLifecycle.quarantined ||
          existing.lifecycle == LocalMediaLifecycle.discarded) {
        throw const _RecoverableLegacyFailure(
          'An incomplete or quarantined migration asset needs explicit recovery.',
        );
      }
      asset = existing;
    } else {
      final id = assetId ?? _newId();
      final paths = storage.allocatePaths(id);
      final now = _utcNow();
      asset = LocalMediaAsset(
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
        createdAt: (createdAt ?? now).toUtc(),
        updatedAt: now,
        readyAt: null,
        version: 0,
      );
      await persistence.insertAsset(asset);
    }
    _acquireAssetLease(asset.id);
    try {
      final stagedPath = asset.stagedRelativePath;
      if (stagedPath == null) {
        throw const FileSystemException('The staged media path is missing.');
      }
      final integrity = await storage.copyFileToStaging(
        source,
        stagedPath,
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
      asset = await persistence.updateAsset(
        asset.copyWith(
          lifecycle: LocalMediaLifecycle.promotionPending,
          updatedAt: _utcNow(),
        ),
        expectedVersion: asset.version,
      );
      await storage.promote(stagedPath, asset.managedRelativePath);
      final managedIntegrity = await storage.inspectFile(
        asset.managedRelativePath,
      );
      if (managedIntegrity.sizeBytes != integrity.sizeBytes ||
          managedIntegrity.sha256 != integrity.sha256) {
        throw const FileSystemException(
          'The promoted media file failed integrity verification.',
        );
      }
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
    } finally {
      _releaseAssetLease(asset.id);
    }
  }

  Future<LocalMediaAsset> _importStreamForOwner({
    required String deploymentScope,
    required String ownerUserId,
    required String meetingId,
    required Stream<List<int>> bytes,
    required int expectedSizeBytes,
    required LocalMediaSourceType sourceType,
    required String originalFilename,
    required String contentType,
    String? sourceProvenance,
    UploadCancellationToken? cancellationToken,
  }) async {
    _requireScope(deploymentScope, ownerUserId);
    _validateIdentifier(meetingId, 'meetingId');
    _validateFilename(originalFilename);
    _validateContentType(contentType);
    if (expectedSizeBytes <= 0) {
      throw ArgumentError.value(
        expectedSizeBytes,
        'expectedSizeBytes',
        'The source size must be positive.',
      );
    }
    final persistence = await _persistence();
    final storage = await _storage();
    await storage.ensureDirectories();
    // Picker paths and filename/size pairs are hints, not content identity.
    // Every unverified stream gets a fresh staging identity; duplicate
    // detection happens only after its streamed digest has been established.
    final provenance =
        'import-attempt:${sourceProvenance ?? 'unknown'}:${_newId()}';
    final existing = await persistence.findAssetByProvenance(
      deploymentScope: deploymentScope,
      ownerUserId: ownerUserId,
      meetingId: meetingId,
      sourceProvenance: provenance,
    );
    if (existing?.lifecycle == LocalMediaLifecycle.discarded ||
        existing?.lifecycle == LocalMediaLifecycle.quarantined) {
      throw const LocalMediaUnavailableException();
    }

    LocalMediaAsset? asset = existing;
    if (asset == null) {
      final id = _newId();
      final paths = storage.allocatePaths(id);
      final now = _utcNow();
      asset = LocalMediaAsset(
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
    }

    var current = asset;
    _acquireAssetLease(current.id);
    try {
      final stagedPath = current.stagedRelativePath;
      if (stagedPath == null) {
        throw const FileSystemException('The staged media path is missing.');
      }
      final integrity = await storage.writeStreamToStaging(
        stagedPath,
        bytes,
        expectedSizeBytes: expectedSizeBytes,
        cancellationToken: cancellationToken,
      );
      current = await persistence.updateAsset(
        current.copyWith(
          lifecycle: LocalMediaLifecycle.staged,
          sizeBytes: integrity.sizeBytes,
          sha256: integrity.sha256,
          quarantineReason: null,
          updatedAt: _utcNow(),
        ),
        expectedVersion: current.version,
      );
      current = await persistence.updateAsset(
        current.copyWith(
          lifecycle: LocalMediaLifecycle.promotionPending,
          updatedAt: _utcNow(),
        ),
        expectedVersion: current.version,
      );
      final readyAssets = await persistence.listAssets(
        deploymentScope: deploymentScope,
        ownerUserId: ownerUserId,
        meetingId: meetingId,
      );
      for (final candidate in readyAssets) {
        if (candidate.id == current.id ||
            candidate.sourceType != sourceType ||
            candidate.originalFilename != originalFilename ||
            candidate.contentType != contentType ||
            candidate.sizeBytes != integrity.sizeBytes ||
            candidate.sha256?.toLowerCase() != integrity.sha256.toLowerCase()) {
          continue;
        }
        if (!await _verifyReadyAsset(candidate)) continue;
        await _deleteIfPresent(storage, stagedPath);
        await persistence.updateAsset(
          current.copyWith(
            lifecycle: LocalMediaLifecycle.discarded,
            updatedAt: _utcNow(),
          ),
          expectedVersion: current.version,
        );
        return candidate;
      }
      await storage.promote(stagedPath, current.managedRelativePath);
      final managedIntegrity = await storage.inspectFile(
        current.managedRelativePath,
      );
      if (managedIntegrity.sizeBytes != integrity.sizeBytes ||
          managedIntegrity.sha256 != integrity.sha256) {
        throw const FileSystemException(
          'The promoted media file failed integrity verification.',
        );
      }
      return await persistence.updateAsset(
        current.copyWith(
          lifecycle: LocalMediaLifecycle.ready,
          readyAt: _utcNow(),
          updatedAt: _utcNow(),
        ),
        expectedVersion: current.version,
      );
    } catch (_) {
      try {
        await persistence.updateAsset(
          current.copyWith(
            lifecycle: LocalMediaLifecycle.interrupted,
            quarantineReason: 'SOURCE_IMPORT_INTERRUPTED',
            updatedAt: _utcNow(),
          ),
          expectedVersion: current.version,
        );
      } catch (_) {}
      rethrow;
    } finally {
      _releaseAssetLease(current.id);
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
    if (asset.lifecycle == LocalMediaLifecycle.quarantined ||
        asset.lifecycle == LocalMediaLifecycle.discarded) {
      return asset;
    }

    final managed = storage.fileFor(asset.managedRelativePath);
    final stagedPath = asset.stagedRelativePath;
    final staged = stagedPath == null ? null : storage.fileFor(stagedPath);
    final stagedExists = staged != null && await staged.exists();
    if (await managed.exists()) {
      if (!_hasCompletionEvidence(asset)) {
        return await persistence.updateAsset(
          asset.copyWith(
            lifecycle: asset.lifecycle == LocalMediaLifecycle.ready
                ? LocalMediaLifecycle.unavailable
                : LocalMediaLifecycle.interrupted,
            quarantineReason: 'COMPLETION_EVIDENCE_MISSING',
            updatedAt: _utcNow(),
          ),
          expectedVersion: asset.version,
        );
      }
      try {
        if (asset.lifecycle == LocalMediaLifecycle.ready && !stagedExists) {
          // READY completion metadata is authoritative for routine recovery.
          // Existence and size are enough unless there is a conflicting
          // staged artifact or an explicit integrity-verification boundary.
          if (await managed.length() != asset.sizeBytes) {
            return await persistence.updateAsset(
              asset.copyWith(
                lifecycle: LocalMediaLifecycle.unavailable,
                quarantineReason: 'MANAGED_FILE_SIZE_MISMATCH',
                updatedAt: _utcNow(),
              ),
              expectedVersion: asset.version,
            );
          }
          return asset.readyAt == null
              ? await persistence.updateAsset(
                  asset.copyWith(
                    lifecycle: LocalMediaLifecycle.ready,
                    readyAt: _utcNow(),
                    updatedAt: _utcNow(),
                  ),
                  expectedVersion: asset.version,
                )
              : asset;
        }
        final integrity = await storage.inspectFile(asset.managedRelativePath);
        if (!_matchesConfirmed(asset, integrity)) {
          return await persistence.updateAsset(
            asset.copyWith(
              lifecycle: LocalMediaLifecycle.unavailable,
              quarantineReason: 'MANAGED_FILE_INTEGRITY_MISMATCH',
              updatedAt: _utcNow(),
            ),
            expectedVersion: asset.version,
          );
        }
        if (stagedExists) {
          // A staged artifact alongside a managed file is an interrupted
          // promotion. Both files must be hashed and compared before either
          // is removed or accepted.
          if (!_matchesConfirmed(asset, integrity)) {
            return await persistence.updateAsset(
              asset.copyWith(
                lifecycle: LocalMediaLifecycle.unavailable,
                quarantineReason: 'MANAGED_FILE_INTEGRITY_MISMATCH',
                updatedAt: _utcNow(),
              ),
              expectedVersion: asset.version,
            );
          }
          final stagedIntegrity = await storage.inspectFile(stagedPath!);
          if (!_matchesConfirmed(asset, stagedIntegrity) ||
              stagedIntegrity.sizeBytes != integrity.sizeBytes ||
              stagedIntegrity.sha256 != integrity.sha256) {
            final quarantinedPath = await storage.quarantine(
              stagedPath,
              reason: 'redundant-staging-mismatch',
            );
            await _recordRecoveryArtifact(
              persistence,
              relativePath: quarantinedPath,
              originalRelativePath: stagedPath,
              asset: asset,
              reason: 'REDUNDANT_STAGING_MISMATCH',
            );
            return await persistence.updateAsset(
              asset.copyWith(
                lifecycle: LocalMediaLifecycle.unavailable,
                stagedRelativePath: quarantinedPath,
                quarantineReason: 'REDUNDANT_STAGING_MISMATCH',
                updatedAt: _utcNow(),
              ),
              expectedVersion: asset.version,
            );
          }
          await staged.delete();
        }
        return await persistence.updateAsset(
          asset.copyWith(
            lifecycle: LocalMediaLifecycle.ready,
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

    if (stagedExists) {
      if (!_hasCompletionEvidence(asset)) {
        return await persistence.updateAsset(
          asset.copyWith(
            lifecycle: LocalMediaLifecycle.interrupted,
            quarantineReason: 'COMPLETION_EVIDENCE_MISSING',
            updatedAt: _utcNow(),
          ),
          expectedVersion: asset.version,
        );
      }
      try {
        final integrity = await storage.inspectFile(stagedPath!);
        if (!_matchesConfirmed(asset, integrity)) {
          final quarantinedPath = await storage.quarantine(
            stagedPath,
            reason: 'integrity-mismatch',
          );
          await _recordRecoveryArtifact(
            persistence,
            relativePath: quarantinedPath,
            originalRelativePath: stagedPath,
            asset: asset,
            reason: 'STAGED_FILE_INTEGRITY_MISMATCH',
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
            lifecycle: LocalMediaLifecycle.interrupted,
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

  bool _hasCompletionEvidence(LocalMediaAsset asset) =>
      asset.sizeBytes != null &&
      asset.sizeBytes! > 0 &&
      asset.sha256 != null &&
      RegExp(r'^[0-9a-fA-F]{64}$').hasMatch(asset.sha256!);

  bool _matchesConfirmed(
    LocalMediaAsset asset,
    LocalMediaFileIntegrity integrity,
  ) =>
      _hasCompletionEvidence(asset) &&
      asset.sizeBytes == integrity.sizeBytes &&
      asset.sha256!.toLowerCase() == integrity.sha256.toLowerCase();

  Future<bool> _verifyReadyAsset(LocalMediaAsset asset) async {
    if (!_hasCompletionEvidence(asset)) return false;
    try {
      final file = (await _storage()).fileFor(asset.managedRelativePath);
      if (!await file.exists()) return false;
      return _matchesConfirmed(
        asset,
        await (await _storage()).inspectFile(asset.managedRelativePath),
      );
    } on FileSystemException {
      return false;
    }
  }

  Future<void> _recordRecoveryArtifact(
    LocalMediaPersistence persistence, {
    required String relativePath,
    required String reason,
    String? originalRelativePath,
    LocalMediaAsset? asset,
  }) async {
    final id = sha256
        .convert(utf8.encode('$relativePath\u0000$reason'))
        .toString()
        .substring(0, 32);
    final now = _utcNow();
    await persistence.insertRecoveryArtifact(
      LocalMediaRecoveryArtifact(
        id: id,
        relativePath: relativePath,
        originalRelativePath: originalRelativePath,
        deploymentScope: asset?.deploymentScope,
        ownerUserId: asset?.ownerUserId,
        assetId: asset?.id,
        reason: reason,
        metadata: asset == null
            ? null
            : jsonEncode(<String, Object?>{
                'meetingId': asset.meetingId,
                'lifecycle': asset.lifecycle.wireValue,
              }),
        createdAt: now,
        updatedAt: now,
      ),
    );
  }

  Future<LocalMediaAsset> _discardAssetFiles(
    LocalMediaPersistence persistence,
    ManagedMediaStorage storage,
    LocalMediaAsset asset,
  ) async {
    await _deleteIfPresent(storage, asset.managedRelativePath);
    final stagedPath = asset.stagedRelativePath;
    if (stagedPath != null && _isStagingPath(stagedPath)) {
      await _deleteIfPresent(storage, stagedPath);
    }
    return persistence.updateAsset(
      asset.copyWith(
        lifecycle: LocalMediaLifecycle.discarded,
        updatedAt: _utcNow(),
      ),
      expectedVersion: asset.version,
    );
  }

  Future<T> _withLifecycleLock<T>(Future<T> Function() action) {
    final previous = _lifecycleTail;
    final release = Completer<void>();
    _lifecycleTail = release.future;
    return () async {
      await previous;
      try {
        return await action();
      } finally {
        release.complete();
      }
    }();
  }

  void _acquireAssetLease(String assetId) {
    _activeAssetLeases[assetId] = (_activeAssetLeases[assetId] ?? 0) + 1;
  }

  void _releaseAssetLease(String assetId) {
    final count = _activeAssetLeases[assetId];
    if (count == null || count <= 1) {
      _activeAssetLeases.remove(assetId);
    } else {
      _activeAssetLeases[assetId] = count - 1;
    }
  }

  bool _isAssetProtected(String assetId) =>
      (_activeAssetLeases[assetId] ?? 0) > 0;

  Future<T> _withMigrationLock<T>(Future<T> Function() action) {
    final previous = _migrationTail;
    final release = Completer<void>();
    _migrationTail = release.future;
    return () async {
      await previous;
      try {
        return await action();
      } finally {
        release.complete();
      }
    }();
  }

  Future<void> _appendLegacyQuarantine(
    CredentialStorage storage,
    String rawEntry, {
    required String sourceKey,
    required String reason,
  }) async {
    const unscopedKey = 'sme.mobile.recordings.legacy-quarantine.v1';
    const scopedKey = 'sme.mobile.recordings.legacy-quarantine.v2';
    final key = sourceKey == 'sme.mobile.recordings.v1'
        ? unscopedKey
        : scopedKey;
    final existing = await storage.read(key: key);
    final decoded = existing == null
        ? <Object?>[]
        : jsonDecode(existing) as Object?;
    if (decoded is! List) {
      throw const _RecoverableLegacyFailure(
        'The existing legacy quarantine record is malformed.',
      );
    }
    final values = decoded.toList(growable: true);
    if (key == unscopedKey) {
      if (values.any((value) => value == rawEntry)) return;
      if (values.any((value) => value is! String)) {
        throw const _RecoverableLegacyFailure(
          'The existing unscoped quarantine record is malformed.',
        );
      }
      values.add(rawEntry);
    } else {
      final alreadyRecorded = values.any(
        (value) =>
            value is Map &&
            value['sourceKey'] == sourceKey &&
            value['entry'] == rawEntry &&
            value['reason'] == reason,
      );
      if (alreadyRecorded) return;
      values.add(<String, Object?>{
        'sourceKey': sourceKey,
        'entry': rawEntry,
        'reason': reason,
        'recordedAt': _utcNow().toIso8601String(),
      });
    }
    await storage.write(key: key, value: jsonEncode(values));
    await storage.confirmDurable();
  }

  static Object? _canonicalLegacyValue(Object? value) {
    if (value is Map) {
      final values = <String, Object?>{
        for (final item in value.entries)
          item.key.toString(): _canonicalLegacyValue(item.value),
      };
      final keys = values.keys.toList()..sort();
      return <String, Object?>{for (final key in keys) key: values[key]};
    }
    if (value is List) {
      return value.map(_canonicalLegacyValue).toList(growable: false);
    }
    return value;
  }

  static DateTime _legacyTimestamp(Object? value) {
    final text = _text(value);
    final parsed = text == null ? null : DateTime.tryParse(text);
    if (parsed == null) {
      throw const _InvalidLegacyMetadata(
        'The legacy creation timestamp is missing or invalid.',
      );
    }
    return parsed.toUtc();
  }

  static int? _legacyPositiveInt(Object? value) {
    if (value == null) return null;
    if (value is int && value > 0) return value;
    if (value is num && value == value.toInt() && value > 0) {
      return value.toInt();
    }
    throw const _InvalidLegacyMetadata('The legacy size metadata is invalid.');
  }

  static LocalMediaSourceType _legacySourceType(Map<String, dynamic> entry) {
    final value = _text(entry['sourceType']);
    if (value == null) return LocalMediaSourceType.recording;
    try {
      return LocalMediaSourceType.fromWireValue(value);
    } on Object {
      throw const _InvalidLegacyMetadata('The legacy source type is invalid.');
    }
  }

  static String _legacyContentType(
    Map<String, dynamic> entry,
    String filename,
  ) {
    final explicit = _text(entry['contentType']);
    final candidate = explicit ?? _contentTypeFor(filename);
    final supported = <String>{
      'audio/wav',
      'audio/x-wav',
      'audio/mpeg',
      'audio/mp4',
      'audio/aac',
      'audio/ogg',
      'audio/opus',
      'audio/flac',
    };
    if (!supported.contains(candidate.toLowerCase())) {
      throw const _InvalidLegacyMetadata(
        'The legacy content type cannot be established reliably.',
      );
    }
    return candidate;
  }

  static String _contentTypeFor(String value) {
    final lower = value.toLowerCase();
    if (lower.endsWith('.mp3')) return 'audio/mpeg';
    if (lower.endsWith('.m4a')) return 'audio/mp4';
    if (lower.endsWith('.aac')) return 'audio/aac';
    if (lower.endsWith('.ogg')) return 'audio/ogg';
    if (lower.endsWith('.opus')) return 'audio/opus';
    if (lower.endsWith('.flac')) return 'audio/flac';
    if (lower.endsWith('.wav')) return 'audio/wav';
    throw const _InvalidLegacyMetadata(
      'The legacy filename does not identify a supported audio type.',
    );
  }

  static String _uploadFingerprint(
    AuthenticatedSessionScope scope,
    LocalMediaAsset asset,
  ) => sha256
      .convert(
        utf8.encode(
          _canonicalFields(<String, Object?>{
            'kind': 'UPLOAD_INTENT',
            'deployment': scope.deploymentScope,
            'owner': scope.userId,
            'meeting': asset.meetingId,
            'asset': asset.id,
            'sourceType': asset.sourceType.wireValue,
            'filename': asset.originalFilename,
            'contentType': asset.contentType,
            'sizeBytes': asset.sizeBytes,
          }),
        ),
      )
      .toString();

  static String _processingFingerprint({
    required AuthenticatedSessionScope scope,
    required String meetingId,
    required ProcessingOperationType operationType,
    String? sourceMediaId,
    String? targetJobId,
    String? reprocessOfJobId,
    String? stageCode,
  }) => sha256
      .convert(
        utf8.encode(
          _canonicalFields(<String, Object?>{
            'kind': operationType.wireValue,
            'deployment': scope.deploymentScope,
            'owner': scope.userId,
            'meeting': meetingId,
            'sourceMediaId': sourceMediaId,
            'targetJobId': targetJobId,
            'reprocessOfJobId': reprocessOfJobId,
            'stageCode': stageCode,
          }),
        ),
      )
      .toString();

  static String _canonicalFields(Map<String, Object?> fields) {
    final keys = fields.keys.toList()..sort();
    return keys.map((key) => '$key=${jsonEncode(fields[key])}').join('\u0000');
  }

  static UploadOperationCheckpoint _mergeUploadCheckpoint(
    UploadOperationCheckpoint current,
    UploadOperationCheckpoint? requested,
  ) {
    if (requested == null ||
        requested == UploadOperationCheckpoint.failed ||
        requested == UploadOperationCheckpoint.remoteReconciliationRequired) {
      return current;
    }
    int rank(UploadOperationCheckpoint value) => switch (value) {
      UploadOperationCheckpoint.intentNotConfirmed => 0,
      UploadOperationCheckpoint.intentConfirmed => 1,
      UploadOperationCheckpoint.binaryTransferConfirmed => 2,
      UploadOperationCheckpoint.finalizationConfirmed => 3,
      UploadOperationCheckpoint.remoteReconciliationRequired => 0,
      UploadOperationCheckpoint.failed => 0,
    };
    return rank(requested) >= rank(current) ? requested : current;
  }

  static ProcessingOperationCheckpoint _mergeProcessingCheckpoint(
    ProcessingOperationCheckpoint current,
    ProcessingOperationCheckpoint? requested,
  ) {
    if (requested == null ||
        requested == ProcessingOperationCheckpoint.failed ||
        requested ==
            ProcessingOperationCheckpoint.remoteReconciliationRequired) {
      return current;
    }
    int rank(ProcessingOperationCheckpoint value) => switch (value) {
      ProcessingOperationCheckpoint.admissionNotConfirmed => 0,
      ProcessingOperationCheckpoint.retryNotConfirmed => 0,
      ProcessingOperationCheckpoint.reprocessNotConfirmed => 0,
      ProcessingOperationCheckpoint.admissionConfirmed => 1,
      ProcessingOperationCheckpoint.retryConfirmed => 1,
      ProcessingOperationCheckpoint.reprocessConfirmed => 1,
      ProcessingOperationCheckpoint.remoteReconciliationRequired => 0,
      ProcessingOperationCheckpoint.failed => 0,
    };
    return rank(requested) >= rank(current) ? requested : current;
  }

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

  static bool _isStagingPath(String relativePath) =>
      relativePath == 'staging' ||
      relativePath.startsWith('staging${Platform.pathSeparator}');

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

  static void _validateOptionalIdentifier(String? value, String field) {
    if (value != null) _validateIdentifier(value, field);
  }

  static void _validateOptionalStage(String? value) {
    if (value != null && !RegExp(r'^[A-Z][A-Z0-9_]{0,47}$').hasMatch(value)) {
      throw ArgumentError.value(value, 'stageCode');
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
    this.orphaned = 0,
  });

  final int inspected;
  final int ready;
  final int missing;
  final int quarantined;
  final int interrupted;
  final int orphaned;
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

class LocalMediaUnavailableException implements Exception {
  const LocalMediaUnavailableException();

  @override
  String toString() => 'The local media asset is unavailable.';
}

class LocalMediaBusyException implements Exception {
  const LocalMediaBusyException();

  @override
  String toString() => 'The local media asset is currently in use.';
}

class _InvalidLegacyMetadata implements Exception {
  const _InvalidLegacyMetadata(this.reason);

  final String reason;
}

class _RecoverableLegacyFailure implements Exception {
  const _RecoverableLegacyFailure(this.reason);

  final String reason;
}
