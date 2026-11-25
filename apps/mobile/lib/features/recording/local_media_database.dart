import 'package:sqflite/sqflite.dart' as sqflite;
import 'package:path/path.dart' as path_utils;

/// SQLite owner for structured local media metadata.
///
/// No audio bytes are written to this database. The schema is deliberately
/// explicit so future coordinators can use typed repositories without relying
/// on raw JSON or an ORM.
class LocalMediaDatabase {
  LocalMediaDatabase._(this.database, this.path);

  static const int schemaVersion = 6;
  static const String defaultDatabaseName = 'sme_mobile_media.db';

  final sqflite.Database database;
  final String path;
  bool _closed = false;

  static Future<LocalMediaDatabase> open({
    String? databasePath,
    sqflite.DatabaseFactory? databaseFactory,
  }) async {
    final factory = databaseFactory ?? sqflite.databaseFactory;
    final resolvedPath =
        databasePath ??
        path_utils.join(await sqflite.getDatabasesPath(), defaultDatabaseName);
    final database = await factory.openDatabase(
      resolvedPath,
      options: sqflite.OpenDatabaseOptions(
        version: schemaVersion,
        onConfigure: (db) async {
          await db.execute('PRAGMA foreign_keys = ON');
        },
        onCreate: (db, version) async {
          await _createSchema(db);
        },
        onUpgrade: (db, oldVersion, newVersion) async {
          await _upgradeSchema(db, oldVersion, newVersion);
        },
      ),
    );
    return LocalMediaDatabase._(database, resolvedPath);
  }

  /// Opens the application-private default database and managed media root.
  static Future<LocalMediaDatabase> openDefault() => open();

  Future<T> transaction<T>(Future<T> Function(sqflite.Transaction txn) action) {
    if (_closed) throw StateError('The local media database is closed.');
    return database.transaction(action);
  }

  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    await database.close();
  }

  static Future<void> _createSchema(sqflite.DatabaseExecutor db) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS local_media_assets (
        id TEXT PRIMARY KEY,
        deployment_scope TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        meeting_id TEXT,
        source_type TEXT NOT NULL CHECK (
          source_type IN ('UPLOAD', 'RECORDING', 'IMPORT', 'LEGACY')
        ),
        managed_relative_path TEXT NOT NULL UNIQUE,
        staged_relative_path TEXT,
        original_filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes > 0),
        duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms > 0),
        sha256 TEXT,
        lifecycle_state TEXT NOT NULL CHECK (
          lifecycle_state IN (
            'CREATING', 'STAGED', 'PROMOTION_PENDING', 'READY',
            'INTERRUPTED', 'MISSING', 'UNAVAILABLE', 'QUARANTINED',
            'DISCARD_PENDING', 'DISCARDED'
          )
        ),
        source_provenance TEXT,
        quarantine_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ready_at TEXT,
        version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
        UNIQUE (deployment_scope, owner_user_id, meeting_id, source_provenance),
        UNIQUE (id, deployment_scope, owner_user_id)
      )
    ''');
    await db.execute('''
      CREATE INDEX IF NOT EXISTS ix_local_media_assets_owner_meeting
      ON local_media_assets(deployment_scope, owner_user_id, meeting_id, created_at DESC)
    ''');
    await db.execute('''
      CREATE INDEX IF NOT EXISTS ix_local_media_assets_lifecycle
      ON local_media_assets(lifecycle_state, updated_at)
    ''');

    await db.execute('''
      CREATE TABLE IF NOT EXISTS upload_operations (
        id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL REFERENCES local_media_assets(id) ON DELETE RESTRICT,
        deployment_scope TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        meeting_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        source_type TEXT NOT NULL,
        original_filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        expected_size_bytes INTEGER NOT NULL CHECK (expected_size_bytes > 0),
        remote_media_id TEXT,
        confirmed_checkpoint TEXT NOT NULL DEFAULT 'INTENT_NOT_CONFIRMED'
          CHECK (confirmed_checkpoint IN (
            'INTENT_NOT_CONFIRMED', 'INTENT_CONFIRMED',
             'BINARY_TRANSFER_CONFIRMED', 'FINALIZATION_CONFIRMED'
          )),
        confirmed_bytes INTEGER NOT NULL DEFAULT 0
          CHECK (
            confirmed_bytes >= 0 AND (
              (
                confirmed_checkpoint IN (
                  'INTENT_NOT_CONFIRMED', 'INTENT_CONFIRMED'
                ) AND confirmed_bytes = 0
              ) OR (
                confirmed_checkpoint IN (
                  'BINARY_TRANSFER_CONFIRMED', 'FINALIZATION_CONFIRMED'
                ) AND confirmed_bytes = expected_size_bytes
              )
            )
          ),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        attempt_outcome TEXT NOT NULL DEFAULT 'NONE' CHECK (attempt_outcome IN (
          'NONE', 'SUCCEEDED', 'REJECTED', 'FAILED', 'INTERRUPTED',
          'CANCELLED', 'UNCERTAIN'
        )),
        recovery_required INTEGER NOT NULL DEFAULT 0 CHECK (recovery_required IN (0, 1)),
        last_failure_code TEXT,
        last_failure_status INTEGER,
        last_failure_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
        UNIQUE (deployment_scope, owner_user_id, idempotency_key),
        FOREIGN KEY (asset_id, deployment_scope, owner_user_id)
          REFERENCES local_media_assets(id, deployment_scope, owner_user_id)
          ON DELETE RESTRICT
      )
    ''');
    await db.execute('''
      CREATE INDEX IF NOT EXISTS ix_upload_operations_owner
      ON upload_operations(deployment_scope, owner_user_id, updated_at DESC)
    ''');

    await db.execute('''
      CREATE TABLE IF NOT EXISTS processing_operations (
        id TEXT PRIMARY KEY,
        deployment_scope TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        meeting_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        operation_type TEXT NOT NULL CHECK (
          operation_type IN ('ADMISSION', 'RETRY', 'REPROCESS')
        ),
        source_media_id TEXT,
        target_job_id TEXT,
        resulting_job_id TEXT,
        reprocess_of_job_id TEXT,
        stage_code TEXT,
         confirmed_checkpoint TEXT NOT NULL DEFAULT 'ADMISSION_NOT_CONFIRMED'
            CHECK (confirmed_checkpoint IN (
              'ADMISSION_NOT_CONFIRMED', 'ADMISSION_CONFIRMED',
              'RETRY_NOT_CONFIRMED', 'RETRY_CONFIRMED',
              'REPROCESS_NOT_CONFIRMED', 'REPROCESS_CONFIRMED'
            )),
         attempt_count INTEGER NOT NULL DEFAULT 0
           CHECK (attempt_count >= 0),
         attempt_outcome TEXT NOT NULL DEFAULT 'NONE' CHECK (attempt_outcome IN (
           'NONE', 'SUCCEEDED', 'REJECTED', 'FAILED', 'INTERRUPTED',
           'CANCELLED', 'UNCERTAIN'
         )),
        recovery_required INTEGER NOT NULL DEFAULT 0 CHECK (recovery_required IN (0, 1)),
        last_failure_code TEXT,
        last_failure_status INTEGER,
         last_failure_message TEXT,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
         CHECK (
           resulting_job_id IS NULL OR confirmed_checkpoint IN (
             'ADMISSION_CONFIRMED', 'RETRY_CONFIRMED', 'REPROCESS_CONFIRMED'
           )
         ),
         UNIQUE (deployment_scope, owner_user_id, idempotency_key)
      )
    ''');
    await db.execute('''
      CREATE INDEX IF NOT EXISTS ix_processing_operations_owner
      ON processing_operations(deployment_scope, owner_user_id, updated_at DESC)
    ''');
    await db.execute('''
      CREATE INDEX IF NOT EXISTS ix_upload_operations_meeting
      ON upload_operations(deployment_scope, owner_user_id, meeting_id, updated_at DESC)
    ''');
    await db.execute('''
      CREATE TABLE IF NOT EXISTS local_media_migrations (
        id TEXT PRIMARY KEY,
        migration_key TEXT NOT NULL UNIQUE,
        deployment_scope TEXT,
        owner_user_id TEXT,
        source_description TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN ('STARTED', 'COMPLETED', 'QUARANTINED')
        ),
        detail TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    ''');
    await db.execute('''
      CREATE TABLE IF NOT EXISTS local_media_recovery_artifacts (
        id TEXT PRIMARY KEY,
        relative_path TEXT NOT NULL UNIQUE,
        original_relative_path TEXT,
        deployment_scope TEXT,
        owner_user_id TEXT,
        asset_id TEXT,
        reason TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    ''');
    await db.execute('''
      CREATE INDEX IF NOT EXISTS ix_local_media_recovery_artifacts_updated
      ON local_media_recovery_artifacts(updated_at DESC)
    ''');
    await db.execute('''
      CREATE TRIGGER IF NOT EXISTS trg_upload_asset_scope_insert
      BEFORE INSERT ON upload_operations
      WHEN NOT EXISTS (
        SELECT 1 FROM local_media_assets
        WHERE id = NEW.asset_id
          AND deployment_scope = NEW.deployment_scope
          AND owner_user_id = NEW.owner_user_id
          AND meeting_id = NEW.meeting_id
          AND lifecycle_state = 'READY'
          AND size_bytes IS NOT NULL AND size_bytes > 0
          AND sha256 IS NOT NULL AND length(sha256) = 64
      )
      BEGIN
        SELECT RAISE(ABORT, 'upload operation asset scope or readiness mismatch');
      END
    ''');
    await db.execute('''
      CREATE TRIGGER IF NOT EXISTS trg_upload_asset_scope_update
      BEFORE UPDATE OF asset_id, deployment_scope, owner_user_id, meeting_id
      ON upload_operations
      WHEN NOT EXISTS (
        SELECT 1 FROM local_media_assets
        WHERE id = NEW.asset_id
          AND deployment_scope = NEW.deployment_scope
          AND owner_user_id = NEW.owner_user_id
          AND meeting_id = NEW.meeting_id
          AND lifecycle_state = 'READY'
          AND size_bytes IS NOT NULL AND size_bytes > 0
          AND sha256 IS NOT NULL AND length(sha256) = 64
      )
      BEGIN
        SELECT RAISE(ABORT, 'upload operation asset scope or readiness mismatch');
      END
    ''');
    await _createProcessingTargetTrigger(db);
    await _createOperationEvidence(db);
  }

  static Future<void> _upgradeSchema(
    sqflite.DatabaseExecutor db,
    int oldVersion,
    int newVersion,
  ) async {
    if (oldVersion < 2 && newVersion >= 2) {
      await _createSchema(db);
      await _addColumnIfMissing(
        db,
        'local_media_assets',
        'quarantine_reason',
        'TEXT',
      );
      await db.execute('''
        CREATE TABLE IF NOT EXISTS local_media_migrations (
          id TEXT PRIMARY KEY,
          migration_key TEXT NOT NULL UNIQUE,
          deployment_scope TEXT,
          owner_user_id TEXT,
          source_description TEXT NOT NULL,
          state TEXT NOT NULL CHECK (
            state IN ('STARTED', 'COMPLETED', 'QUARANTINED')
          ),
          detail TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      ''');
    }
    if (oldVersion < 3 && newVersion >= 3) {
      await _rebuildSchemaForV3(db);
    }
    if (oldVersion < 5 && newVersion >= 5) {
      await _createOperationEvidence(db);
      await _normalizeHistoricalOperations(db);
    }
    if (oldVersion < 6 && newVersion >= 6) {
      // V5 databases already have the strict final tables.  Run the
      // normalizer again for them after installing the evidence table so a
      // database interrupted between the two hardening releases converges in
      // exactly the same way as a V2--V4 upgrade.
      await _createOperationEvidence(db);
      await _normalizeHistoricalOperations(db);
    }
    if (oldVersion > newVersion) {
      throw StateError('Local media database downgrade is not supported.');
    }
  }

  static Future<void> _rebuildSchemaForV3(sqflite.DatabaseExecutor db) async {
    final tables = await db.rawQuery(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN "
      "('local_media_assets', 'upload_operations', 'processing_operations')",
    );
    final tableNames = tables
        .map((row) => row['name'])
        .whereType<String>()
        .toSet();
    if (!tableNames.contains('local_media_assets')) {
      await _createSchema(db);
      return;
    }

    // Rebuild all tables that participate in the asset foreign key together.
    // Renaming only local_media_assets leaves SQLite's foreign-key metadata
    // pointing at the old table and can either fail the upgrade or strand
    // operations. The temporary tables are intentionally trigger-free while
    // legacy rows are copied; the scope/readiness triggers are installed after
    // the new tables are in place.
    await db.execute('''
      CREATE TABLE local_media_assets_v3 (
        id TEXT PRIMARY KEY,
        deployment_scope TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        meeting_id TEXT,
        source_type TEXT NOT NULL CHECK (
          source_type IN ('UPLOAD', 'RECORDING', 'IMPORT', 'LEGACY')
        ),
        managed_relative_path TEXT NOT NULL UNIQUE,
        staged_relative_path TEXT,
        original_filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes > 0),
        duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms > 0),
        sha256 TEXT,
        lifecycle_state TEXT NOT NULL CHECK (
          lifecycle_state IN (
            'CREATING', 'STAGED', 'PROMOTION_PENDING', 'READY',
            'INTERRUPTED', 'MISSING', 'UNAVAILABLE', 'QUARANTINED',
            'DISCARD_PENDING', 'DISCARDED'
          )
        ),
        source_provenance TEXT,
        quarantine_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ready_at TEXT,
        version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
        UNIQUE (deployment_scope, owner_user_id, meeting_id, source_provenance),
        UNIQUE (id, deployment_scope, owner_user_id)
      )
    ''');
    await db.execute('''
      INSERT INTO local_media_assets_v3 (
        id, deployment_scope, owner_user_id, meeting_id, source_type,
        managed_relative_path, staged_relative_path, original_filename,
        content_type, size_bytes, duration_ms, sha256, lifecycle_state,
        source_provenance, quarantine_reason, created_at, updated_at, ready_at,
        version
      )
      SELECT id, deployment_scope, owner_user_id, meeting_id, source_type,
        managed_relative_path, staged_relative_path, original_filename,
        content_type, size_bytes, duration_ms, sha256, lifecycle_state,
        source_provenance, quarantine_reason, created_at, updated_at, ready_at,
        version
      FROM local_media_assets
    ''');

    if (tableNames.contains('upload_operations')) {
      await db.execute('''
        CREATE TABLE upload_operations_v3 (
          id TEXT PRIMARY KEY,
          asset_id TEXT NOT NULL REFERENCES local_media_assets_v3(id)
            ON DELETE RESTRICT,
          deployment_scope TEXT NOT NULL,
          owner_user_id TEXT NOT NULL,
          meeting_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          request_fingerprint TEXT NOT NULL,
          source_type TEXT NOT NULL,
          original_filename TEXT NOT NULL,
          content_type TEXT NOT NULL,
          expected_size_bytes INTEGER NOT NULL CHECK (expected_size_bytes > 0),
          remote_media_id TEXT,
          confirmed_checkpoint TEXT NOT NULL DEFAULT 'INTENT_NOT_CONFIRMED'
            CHECK (confirmed_checkpoint IN (
              'INTENT_NOT_CONFIRMED', 'INTENT_CONFIRMED',
              'BINARY_TRANSFER_CONFIRMED', 'FINALIZATION_CONFIRMED',
              'REMOTE_RECONCILIATION_REQUIRED', 'FAILED'
            )),
           -- V3 is an intermediate compatibility schema. Historical V2 rows
           -- may still contain FAILED/REMOTE_RECONCILIATION_REQUIRED and
           -- non-zero byte evidence. The V5 normalizer is the first boundary
           -- that is allowed to discard an obsolete confirmed checkpoint.
           confirmed_bytes INTEGER NOT NULL DEFAULT 0 CHECK (confirmed_bytes >= 0),
           attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
           attempt_outcome TEXT NOT NULL DEFAULT 'NONE' CHECK (attempt_outcome IN (
             'NONE', 'SUCCEEDED', 'REJECTED', 'FAILED', 'INTERRUPTED',
             'CANCELLED', 'UNCERTAIN'
           )),
          recovery_required INTEGER NOT NULL DEFAULT 0
            CHECK (recovery_required IN (0, 1)),
          last_failure_code TEXT,
          last_failure_status INTEGER,
          last_failure_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
          UNIQUE (deployment_scope, owner_user_id, idempotency_key),
          FOREIGN KEY (asset_id, deployment_scope, owner_user_id)
            REFERENCES local_media_assets_v3(id, deployment_scope, owner_user_id)
            ON DELETE RESTRICT
        )
      ''');
      await db.execute('''
        INSERT INTO upload_operations_v3 (
          id, asset_id, deployment_scope, owner_user_id, meeting_id,
          idempotency_key, request_fingerprint, source_type, original_filename,
          content_type, expected_size_bytes, remote_media_id,
          confirmed_checkpoint, confirmed_bytes, attempt_count, attempt_outcome,
          recovery_required, last_failure_code, last_failure_status,
          last_failure_message, created_at, updated_at, version
        )
        SELECT operation.id, operation.asset_id, operation.deployment_scope,
          operation.owner_user_id,
          COALESCE(asset.meeting_id, ''),
          operation.idempotency_key, operation.request_fingerprint,
          operation.source_type, operation.original_filename,
          operation.content_type, operation.expected_size_bytes,
          operation.remote_media_id, operation.confirmed_checkpoint,
          operation.confirmed_bytes, operation.attempt_count, 'NONE', 0,
          operation.last_failure_code, operation.last_failure_status,
          operation.last_failure_message, operation.created_at,
          operation.updated_at, operation.version
        FROM upload_operations operation
        JOIN local_media_assets_v3 asset ON asset.id = operation.asset_id
      ''');
    }

    if (tableNames.contains('processing_operations')) {
      await db.execute('''
        CREATE TABLE processing_operations_v3 (
          id TEXT PRIMARY KEY,
          deployment_scope TEXT NOT NULL,
          owner_user_id TEXT NOT NULL,
          meeting_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          request_fingerprint TEXT NOT NULL,
          operation_type TEXT NOT NULL CHECK (
            operation_type IN ('ADMISSION', 'RETRY', 'REPROCESS')
          ),
          source_media_id TEXT,
          target_job_id TEXT,
          resulting_job_id TEXT,
          reprocess_of_job_id TEXT,
          stage_code TEXT,
           confirmed_checkpoint TEXT NOT NULL DEFAULT 'ADMISSION_NOT_CONFIRMED'
            CHECK (confirmed_checkpoint IN (
               'ADMISSION_NOT_CONFIRMED', 'ADMISSION_CONFIRMED',
               'RETRY_NOT_CONFIRMED', 'RETRY_CONFIRMED',
               'REPROCESS_NOT_CONFIRMED', 'REPROCESS_CONFIRMED',
               'REMOTE_RECONCILIATION_REQUIRED', 'FAILED'
             )),
           attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
           attempt_outcome TEXT NOT NULL DEFAULT 'NONE' CHECK (attempt_outcome IN (
             'NONE', 'SUCCEEDED', 'REJECTED', 'FAILED', 'INTERRUPTED',
             'CANCELLED', 'UNCERTAIN'
           )),
          recovery_required INTEGER NOT NULL DEFAULT 0
            CHECK (recovery_required IN (0, 1)),
          last_failure_code TEXT,
          last_failure_status INTEGER,
           last_failure_message TEXT,
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL,
           version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
           UNIQUE (deployment_scope, owner_user_id, idempotency_key)
         )
      ''');
      await db.execute('''
        INSERT INTO processing_operations_v3 (
          id, deployment_scope, owner_user_id, meeting_id, idempotency_key,
          request_fingerprint, operation_type, source_media_id, target_job_id,
          resulting_job_id, reprocess_of_job_id, stage_code,
          confirmed_checkpoint, attempt_count, attempt_outcome,
          recovery_required, last_failure_code, last_failure_status,
          last_failure_message, created_at, updated_at, version
        )
        SELECT id, deployment_scope, owner_user_id, meeting_id, idempotency_key,
          request_fingerprint, operation_type, source_media_id, target_job_id,
          NULL, reprocess_of_job_id, stage_code, confirmed_checkpoint,
          attempt_count, 'NONE', 0, last_failure_code, last_failure_status,
          last_failure_message, created_at, updated_at, version
        FROM processing_operations
      ''');
    }

    // Dependent tables are gone before the old parent is dropped, so foreign
    // keys remain enabled throughout the upgrade.
    if (tableNames.contains('upload_operations')) {
      await db.execute('DROP TABLE upload_operations');
    }
    if (tableNames.contains('processing_operations')) {
      await db.execute('DROP TABLE processing_operations');
    }
    await db.execute('DROP TABLE local_media_assets');
    await db.execute(
      'ALTER TABLE local_media_assets_v3 RENAME TO local_media_assets',
    );
    if (tableNames.contains('upload_operations')) {
      await db.execute(
        'ALTER TABLE upload_operations_v3 RENAME TO upload_operations',
      );
    }
    if (tableNames.contains('processing_operations')) {
      await db.execute(
        'ALTER TABLE processing_operations_v3 RENAME TO processing_operations',
      );
    }
    await db.execute('''
      CREATE INDEX IF NOT EXISTS ix_local_media_assets_owner_meeting
      ON local_media_assets(deployment_scope, owner_user_id, meeting_id, created_at DESC)
    ''');
    await db.execute('''
      CREATE INDEX IF NOT EXISTS ix_local_media_assets_lifecycle
      ON local_media_assets(lifecycle_state, updated_at)
    ''');
    await db.execute('''
      CREATE INDEX IF NOT EXISTS ix_upload_operations_owner
      ON upload_operations(deployment_scope, owner_user_id, updated_at DESC)
    ''');
    await db.execute('''
      CREATE INDEX IF NOT EXISTS ix_upload_operations_meeting
      ON upload_operations(deployment_scope, owner_user_id, meeting_id, updated_at DESC)
    ''');
    await db.execute('''
      CREATE INDEX IF NOT EXISTS ix_processing_operations_owner
      ON processing_operations(deployment_scope, owner_user_id, updated_at DESC)
    ''');
    await _createRecoveryArtifacts(db);
    await _createOperationEvidence(db);
    await _createUploadScopeTriggers(db);
    await _createProcessingTargetTrigger(db);
  }

  static Future<void> _createRecoveryArtifacts(
    sqflite.DatabaseExecutor db,
  ) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS local_media_recovery_artifacts (
        id TEXT PRIMARY KEY,
        relative_path TEXT NOT NULL UNIQUE,
        original_relative_path TEXT,
        deployment_scope TEXT,
        owner_user_id TEXT,
        asset_id TEXT,
        reason TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    ''');
    await db.execute('''
      CREATE INDEX IF NOT EXISTS ix_local_media_recovery_artifacts_updated
      ON local_media_recovery_artifacts(updated_at DESC)
    ''');
  }

  static Future<void> _createOperationEvidence(
    sqflite.DatabaseExecutor db,
  ) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS local_media_operation_evidence (
        id TEXT PRIMARY KEY,
        operation_kind TEXT NOT NULL CHECK (operation_kind IN ('UPLOAD', 'PROCESSING')),
        operation_id TEXT NOT NULL,
        deployment_scope TEXT,
        owner_user_id TEXT,
        original_checkpoint TEXT,
        original_confirmed_bytes INTEGER,
        expected_size_bytes INTEGER,
        original_remote_media_id TEXT,
        original_target_job_id TEXT,
        original_resulting_job_id TEXT,
        original_attempt_outcome TEXT,
        original_recovery_required INTEGER,
        original_failure_code TEXT,
        original_failure_status INTEGER,
        original_failure_message TEXT,
        reason TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (operation_kind, operation_id, reason)
      )
    ''');
    await db.execute('''
      CREATE INDEX IF NOT EXISTS ix_operation_evidence_operation
      ON local_media_operation_evidence(operation_kind, operation_id, created_at DESC)
    ''');
  }

  /// V5 separates confirmed workflow progress from the result of the latest
  /// attempt. V4 could copy FAILED and REMOTE_RECONCILIATION_REQUIRED into
  /// the confirmed checkpoint, and could derive success from an earlier
  /// checkpoint while erasing a later failure. Normalize those rows without
  /// changing immutable request identity or discarding durable evidence.
  static Future<void> _normalizeHistoricalOperations(
    sqflite.DatabaseExecutor db,
  ) async {
    await db.execute(
      'DROP TRIGGER IF EXISTS trg_processing_target_job_immutable',
    );
    final uploadRows = await db.query('upload_operations');
    for (final row in uploadRows) {
      final checkpoint = row['confirmed_checkpoint'] as String?;
      final remoteMediaId = row['remote_media_id'] as String?;
      final expectedBytes = _integer(row['expected_size_bytes']) ?? 0;
      final oldBytes = _integer(row['confirmed_bytes']) ?? 0;
      final hasRemoteIdentity = remoteMediaId?.trim().isNotEmpty == true;
      final hasAcknowledgedTransfer =
          expectedBytes > 0 && oldBytes == expectedBytes;
      // A byte count without a remote identity is evidence that must remain
      // recoverable, not proof that an object-storage resource was confirmed.
      // A historical FINALIZATION_CONFIRMED row is retained only when both
      // identity and complete-transfer evidence are present.
      var nextCheckpoint = switch (checkpoint) {
        'FINALIZATION_CONFIRMED' =>
          hasRemoteIdentity && hasAcknowledgedTransfer
              ? 'FINALIZATION_CONFIRMED'
              : hasRemoteIdentity
              ? 'INTENT_CONFIRMED'
              : 'INTENT_NOT_CONFIRMED',
        'BINARY_TRANSFER_CONFIRMED' ||
        'FAILED' ||
        'REMOTE_RECONCILIATION_REQUIRED' =>
          hasRemoteIdentity && hasAcknowledgedTransfer
              ? 'BINARY_TRANSFER_CONFIRMED'
              : hasRemoteIdentity
              ? 'INTENT_CONFIRMED'
              : 'INTENT_NOT_CONFIRMED',
        'INTENT_CONFIRMED' =>
          hasRemoteIdentity ? 'INTENT_CONFIRMED' : 'INTENT_NOT_CONFIRMED',
        _ => hasRemoteIdentity ? 'INTENT_CONFIRMED' : 'INTENT_NOT_CONFIRMED',
      };
      var nextBytes =
          nextCheckpoint == 'BINARY_TRANSFER_CONFIRMED' ||
              nextCheckpoint == 'FINALIZATION_CONFIRMED'
          ? expectedBytes
          : 0;
      final existingOutcome = row['attempt_outcome'] as String?;
      var outcome = existingOutcome;
      if (outcome == null ||
          !_validOutcome(outcome) ||
          (outcome == 'NONE' && checkpoint != 'INTENT_NOT_CONFIRMED')) {
        outcome = switch (checkpoint) {
          'FAILED' => 'FAILED',
          'REMOTE_RECONCILIATION_REQUIRED' => 'UNCERTAIN',
          'INTENT_CONFIRMED' ||
          'BINARY_TRANSFER_CONFIRMED' ||
          'FINALIZATION_CONFIRMED' => 'SUCCEEDED',
          _ => 'NONE',
        };
      }
      var recoveryRequired = _integer(row['recovery_required']) == 1;
      if (checkpoint == 'FAILED' ||
          checkpoint == 'REMOTE_RECONCILIATION_REQUIRED' ||
          outcome == 'UNCERTAIN' ||
          !hasRemoteIdentity && oldBytes > 0 ||
          nextCheckpoint != checkpoint &&
              checkpoint != 'INTENT_NOT_CONFIRMED') {
        recoveryRequired = true;
      }
      final existingFailureCode = row['last_failure_code'] as String?;
      final existingFailureMessage = row['last_failure_message'] as String?;
      final preservedByteEvidence = !hasRemoteIdentity && oldBytes > 0;
      final normalized = nextCheckpoint != checkpoint || nextBytes != oldBytes;
      if (normalized ||
          checkpoint == 'FAILED' ||
          checkpoint == 'REMOTE_RECONCILIATION_REQUIRED') {
        await _insertOperationEvidence(
          db,
          kind: 'UPLOAD',
          row: row,
          reason: 'HISTORICAL_NORMALIZATION',
          originalCheckpoint: checkpoint,
          originalConfirmedBytes: oldBytes,
          expectedSizeBytes: expectedBytes,
          originalRemoteMediaId: remoteMediaId,
        );
      }
      await db.update(
        'upload_operations',
        <String, Object?>{
          'confirmed_checkpoint': nextCheckpoint,
          'confirmed_bytes': nextBytes,
          'attempt_outcome': outcome,
          'recovery_required': recoveryRequired ? 1 : 0,
          if (preservedByteEvidence && existingFailureCode == null)
            'last_failure_code': 'HISTORICAL_TRANSFER_EVIDENCE_UNCONFIRMED',
          if (preservedByteEvidence && existingFailureMessage == null)
            'last_failure_message': 'Historical byte evidence was retained but no remote media identity was recorded.',
        },
        where: 'id = ?',
        whereArgs: <Object?>[row['id']],
      );
    }

    final processingRows = await db.query('processing_operations');
    for (final row in processingRows) {
      final type = row['operation_type'] as String?;
      final checkpoint = row['confirmed_checkpoint'] as String?;
      var targetJobId = row['target_job_id'] as String?;
      var resultingJobId = row['resulting_job_id'] as String?;
      final confirmedCheckpoint = switch (type) {
        'RETRY' => 'RETRY_CONFIRMED',
        'REPROCESS' => 'REPROCESS_CONFIRMED',
        _ => 'ADMISSION_CONFIRMED',
      };
      final pendingCheckpoint = switch (type) {
        'RETRY' => 'RETRY_NOT_CONFIRMED',
        'REPROCESS' => 'REPROCESS_NOT_CONFIRMED',
        _ => 'ADMISSION_NOT_CONFIRMED',
      };

      if (type == 'ADMISSION' &&
          checkpoint == 'ADMISSION_CONFIRMED' &&
          resultingJobId == null &&
          targetJobId != null &&
          targetJobId.isNotEmpty) {
        // V2 used target_job_id for the response job on admission. The
        // admission request itself has no target identity.
        resultingJobId = targetJobId;
        targetJobId = null;
      }

      final hasResultingJob = resultingJobId?.trim().isNotEmpty == true;
      var nextCheckpoint = checkpoint == confirmedCheckpoint && hasResultingJob
          ? confirmedCheckpoint
          : pendingCheckpoint;
      final existingOutcome = row['attempt_outcome'] as String?;
      var outcome = existingOutcome;
      if (outcome == null ||
          !_validOutcome(outcome) ||
          (outcome == 'NONE' && checkpoint != pendingCheckpoint)) {
        outcome = checkpoint == 'FAILED'
            ? 'FAILED'
            : checkpoint == 'REMOTE_RECONCILIATION_REQUIRED'
            ? 'UNCERTAIN'
            : checkpoint == confirmedCheckpoint && hasResultingJob
            ? 'SUCCEEDED'
            : checkpoint == confirmedCheckpoint
            ? 'UNCERTAIN'
            : 'NONE';
      }
      var recoveryRequired = _integer(row['recovery_required']) == 1;
      if (checkpoint == 'FAILED' ||
          checkpoint == 'REMOTE_RECONCILIATION_REQUIRED' ||
          nextCheckpoint == pendingCheckpoint ||
          nextCheckpoint == confirmedCheckpoint && !hasResultingJob ||
          outcome == 'UNCERTAIN') {
        recoveryRequired = true;
      }
      // A resulting job is only valid with a positively confirmed operation.
      // Keep the original retry/reprocess target and provenance; do not turn
      // a failed admission into a fabricated resulting job.
      if (nextCheckpoint != confirmedCheckpoint) resultingJobId = null;

      final normalized =
          nextCheckpoint != checkpoint ||
          targetJobId != row['target_job_id'] ||
          resultingJobId != row['resulting_job_id'];
      if (normalized ||
          checkpoint == 'FAILED' ||
          checkpoint == 'REMOTE_RECONCILIATION_REQUIRED' ||
          checkpoint == confirmedCheckpoint && !hasResultingJob) {
        await _insertOperationEvidence(
          db,
          kind: 'PROCESSING',
          row: row,
          reason: 'HISTORICAL_NORMALIZATION',
          originalCheckpoint: checkpoint,
          originalTargetJobId: row['target_job_id'] as String?,
          originalResultingJobId: row['resulting_job_id'] as String?,
        );
      }

      await db.update(
        'processing_operations',
        <String, Object?>{
          'target_job_id': targetJobId,
          'resulting_job_id': resultingJobId,
          'confirmed_checkpoint': nextCheckpoint,
          'attempt_outcome': outcome,
          'recovery_required': recoveryRequired ? 1 : 0,
        },
        where: 'id = ?',
        whereArgs: <Object?>[row['id']],
      );
    }
    await _createProcessingTargetTrigger(db);
  }

  static Future<void> _insertOperationEvidence(
    sqflite.DatabaseExecutor db, {
    required String kind,
    required Map<String, Object?> row,
    required String reason,
    String? originalCheckpoint,
    int? originalConfirmedBytes,
    int? expectedSizeBytes,
    String? originalRemoteMediaId,
    String? originalTargetJobId,
    String? originalResultingJobId,
  }) async {
    final operationId = row['id'] as String;
    final now = DateTime.now().toUtc().toIso8601String();
    final id = '${kind.toLowerCase()}:$operationId:$reason';
    await db.insert('local_media_operation_evidence', <String, Object?>{
      'id': id,
      'operation_kind': kind,
      'operation_id': operationId,
      'deployment_scope': row['deployment_scope'],
      'owner_user_id': row['owner_user_id'],
      'original_checkpoint': originalCheckpoint,
      'original_confirmed_bytes': originalConfirmedBytes,
      'expected_size_bytes': expectedSizeBytes ?? row['expected_size_bytes'],
      'original_remote_media_id': originalRemoteMediaId,
      'original_target_job_id': originalTargetJobId ?? row['target_job_id'],
      'original_resulting_job_id':
          originalResultingJobId ?? row['resulting_job_id'],
      'original_attempt_outcome': row['attempt_outcome'],
      'original_recovery_required': row['recovery_required'],
      'original_failure_code': row['last_failure_code'],
      'original_failure_status': row['last_failure_status'],
      'original_failure_message': row['last_failure_message'],
      'reason': reason,
      'metadata': '{"historical":true}',
      'created_at': now,
    }, conflictAlgorithm: sqflite.ConflictAlgorithm.ignore);
  }

  static bool _validOutcome(String value) => const <String>{
    'NONE',
    'SUCCEEDED',
    'REJECTED',
    'FAILED',
    'INTERRUPTED',
    'CANCELLED',
    'UNCERTAIN',
  }.contains(value);

  static int? _integer(Object? value) {
    if (value is int) return value;
    if (value is num && value == value.toInt()) return value.toInt();
    return null;
  }

  static Future<void> _createUploadScopeTriggers(
    sqflite.DatabaseExecutor db,
  ) async {
    await db.execute('''
      CREATE TRIGGER IF NOT EXISTS trg_upload_asset_scope_insert
      BEFORE INSERT ON upload_operations
      WHEN NOT EXISTS (
        SELECT 1 FROM local_media_assets
        WHERE id = NEW.asset_id
          AND deployment_scope = NEW.deployment_scope
          AND owner_user_id = NEW.owner_user_id
          AND meeting_id = NEW.meeting_id
          AND lifecycle_state = 'READY'
          AND size_bytes IS NOT NULL AND size_bytes > 0
          AND sha256 IS NOT NULL AND length(sha256) = 64
      )
      BEGIN
        SELECT RAISE(ABORT, 'upload operation asset scope or readiness mismatch');
      END
    ''');
    await db.execute('''
      CREATE TRIGGER IF NOT EXISTS trg_upload_asset_scope_update
      BEFORE UPDATE OF asset_id, deployment_scope, owner_user_id, meeting_id
      ON upload_operations
      WHEN NOT EXISTS (
        SELECT 1 FROM local_media_assets
        WHERE id = NEW.asset_id
          AND deployment_scope = NEW.deployment_scope
          AND owner_user_id = NEW.owner_user_id
          AND meeting_id = NEW.meeting_id
          AND lifecycle_state = 'READY'
          AND size_bytes IS NOT NULL AND size_bytes > 0
          AND sha256 IS NOT NULL AND length(sha256) = 64
      )
      BEGIN
        SELECT RAISE(ABORT, 'upload operation asset scope or readiness mismatch');
      END
    ''');
  }

  static Future<void> _createProcessingTargetTrigger(
    sqflite.DatabaseExecutor db,
  ) async {
    await db.execute('''
      CREATE TRIGGER IF NOT EXISTS trg_processing_target_job_immutable
      BEFORE UPDATE OF target_job_id ON processing_operations
      WHEN OLD.target_job_id IS NOT NEW.target_job_id
      BEGIN
        SELECT RAISE(ABORT, 'processing target job is immutable');
      END
    ''');
  }

  static Future<void> _addColumnIfMissing(
    sqflite.DatabaseExecutor db,
    String table,
    String column,
    String definition,
  ) async {
    final rows = await db.rawQuery('PRAGMA table_info($table)');
    if (rows.any((row) => row['name'] == column)) return;
    await db.execute('ALTER TABLE $table ADD COLUMN $column $definition');
  }
}
