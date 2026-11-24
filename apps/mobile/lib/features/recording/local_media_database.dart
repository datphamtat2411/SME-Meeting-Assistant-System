import 'package:sqflite/sqflite.dart' as sqflite;
import 'package:path/path.dart' as path_utils;

/// SQLite owner for structured local media metadata.
///
/// No audio bytes are written to this database. The schema is deliberately
/// explicit so future coordinators can use typed repositories without relying
/// on raw JSON or an ORM.
class LocalMediaDatabase {
  LocalMediaDatabase._(this.database, this.path);

  static const int schemaVersion = 2;
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
        UNIQUE (deployment_scope, owner_user_id, source_provenance)
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
        confirmed_bytes INTEGER NOT NULL DEFAULT 0
          CHECK (confirmed_bytes >= 0),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
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
        reprocess_of_job_id TEXT,
        stage_code TEXT,
        confirmed_checkpoint TEXT NOT NULL DEFAULT 'ADMISSION_NOT_CONFIRMED'
          CHECK (confirmed_checkpoint IN (
            'ADMISSION_NOT_CONFIRMED', 'ADMISSION_CONFIRMED',
            'RETRY_CONFIRMED', 'REPROCESS_CONFIRMED',
            'REMOTE_RECONCILIATION_REQUIRED', 'FAILED'
          )),
        attempt_count INTEGER NOT NULL DEFAULT 0
          CHECK (attempt_count >= 0),
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
      CREATE INDEX IF NOT EXISTS ix_processing_operations_owner
      ON processing_operations(deployment_scope, owner_user_id, updated_at DESC)
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
    if (oldVersion > newVersion) {
      throw StateError('Local media database downgrade is not supported.');
    }
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
