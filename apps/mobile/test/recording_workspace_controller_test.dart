import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite/sqflite.dart' as sqflite;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:sme_meeting_assistant/core/models.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_foundation.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_database.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_persistence.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_repository.dart';
import 'package:sme_meeting_assistant/features/recording/managed_media_storage.dart';
import 'package:sme_meeting_assistant/features/recording/media_repository.dart';
import 'package:sme_meeting_assistant/features/recording/processing_manager.dart';
import 'package:sme_meeting_assistant/features/recording/processing_repository.dart';
import 'package:sme_meeting_assistant/features/recording/recording_coordinator.dart';
import 'package:sme_meeting_assistant/features/recording/recording_workspace_controller.dart';
import 'package:sme_meeting_assistant/features/recording/submission_coordinator.dart';

import 'support/meeting_test_support.dart';

void main() {
  setUpAll(() {
    sqfliteFfiInit();
    sqflite.databaseFactory = databaseFactoryFfi;
  });

  test(
    'projects one meeting and fences protected state on session change',
    () async {
      final client = MeetingTestHttpClient((request) async {
        if (request.url.path.endsWith('/media') ||
            request.url.path.endsWith('/processing-jobs')) {
          return meetingApiSuccess(const <dynamic>[]);
        }
        throw StateError('Unexpected request ${request.url.path}');
      });
      final api = createMeetingTestApi(client);
      await signInMeetingTestApi(api);
      final directory = await Directory.systemTemp.createTemp('sme-workspace-');
      final database = await LocalMediaDatabase.open(
        databasePath: '${directory.path}/media.db',
        databaseFactory: databaseFactoryFfi,
      );
      final localMedia = LocalMediaRepository(
        persistence: LocalMediaPersistence(database),
        storage: ManagedMediaStorage(
          root: Directory('${directory.path}/managed'),
        ),
      );
      final media = MediaRepository(api: api);
      final processing = ProcessingRepository(api: api);
      final recording = RecordingCoordinator(
        api: api,
        localMedia: localMedia,
        observeAppLifecycle: false,
      );
      final submissions = SubmissionCoordinator(
        api: api,
        localMedia: localMedia,
        mediaRepository: media,
        processingRepository: processing,
      );
      final manager = ProcessingManager(
        api: api,
        mediaRepository: media,
        processingRepository: processing,
        localMedia: localMedia,
      );
      final capabilities = MeetingCapabilityPolicy.evaluate(
        callerId: testUserId,
        meeting: Meeting.fromJson(meetingTestJson(status: 'IN_PROGRESS')),
      );
      final controller = RecordingWorkspaceController(
        api: api,
        meetingId: testMeetingId,
        capabilities: capabilities,
        meetingStatus: MeetingStatus.inProgress,
        localMedia: localMedia,
        recording: recording,
        submissions: submissions,
        processingManager: manager,
      );
      addTearDown(() async {
        controller.dispose();
        manager.dispose();
        submissions.dispose();
        recording.dispose();
        await localMedia.dispose();
        await directory.delete(recursive: true);
        api.dispose();
      });

      await controller.initialize();
      expect(controller.loadState, RecordingWorkspaceLoadState.ready);
      expect(controller.assets, isEmpty);
      expect(controller.canReadMedia, isTrue);

      final readOnly = MeetingCapabilityPolicy.evaluate(
        callerId: '99999999-9999-4999-8999-999999999999',
        meeting: Meeting.fromJson(meetingTestJson(status: 'IN_PROGRESS')),
        callerIsActiveParticipant: true,
      );
      controller.updateContext(
        meetingId: testMeetingId,
        capabilities: readOnly,
        meetingStatus: MeetingStatus.inProgress,
      );
      expect(controller.canUpload, isFalse);
      expect(controller.canReadMedia, isTrue);

      await api.signOut();
      expect(controller.isSessionFenced, isTrue);
      expect(controller.assets, isEmpty);
      expect(controller.remoteState, isNull);
    },
  );
}
