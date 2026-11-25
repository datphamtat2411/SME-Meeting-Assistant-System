import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite/sqflite.dart' as sqflite;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_database.dart';

void main() {
  setUpAll(() {
    sqfliteFfiInit();
    sqflite.databaseFactory = databaseFactoryFfi;
  });

  test('current-version databases receive admission constraints without losing history', () async {
    final directory = await Directory.systemTemp.createTemp('sme-admission-');
    final databasePath = '${directory.path}/media.db';
    final legacy = await databaseFactoryFfi.openDatabase(
      databasePath,
      options: sqflite.OpenDatabaseOptions(
        version: LocalMediaDatabase.schemaVersion,
        onCreate: (db, _) async {
          await db.execute('''
              CREATE TABLE processing_operations (
                id TEXT PRIMARY KEY,
                deployment_scope TEXT NOT NULL,
                owner_user_id TEXT NOT NULL,
                meeting_id TEXT NOT NULL,
                operation_type TEXT NOT NULL,
                source_media_id TEXT,
                reprocess_of_job_id TEXT
              )
            ''');
          for (var index = 0; index < 2; index++) {
            await db.insert('processing_operations', <String, Object?>{
              'id': 'historical-$index',
              'deployment_scope': 'deployment',
              'owner_user_id': 'owner',
              'meeting_id': 'meeting',
              'operation_type': 'ADMISSION',
              'source_media_id': 'source',
            });
          }
        },
      ),
    );
    await legacy.close();

    final database = await LocalMediaDatabase.open(
      databasePath: databasePath,
      databaseFactory: databaseFactoryFfi,
    );
    addTearDown(() async {
      await database.close();
      await directory.delete(recursive: true);
    });

    final historical = await database.database.query('processing_operations');
    expect(historical, hasLength(2));
    await expectLater(
      database.database.insert('processing_operations', <String, Object?>{
        'id': 'new-conflict',
        'deployment_scope': 'deployment',
        'owner_user_id': 'owner',
        'meeting_id': 'meeting',
        'operation_type': 'ADMISSION',
        'source_media_id': 'source',
      }),
      throwsA(isA<sqflite.DatabaseException>()),
    );
  });
}
