import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:record/record.dart';
import 'package:sqflite/sqflite.dart' as sqflite;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/models.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_foundation.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_database.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_persistence.dart';
import 'package:sme_meeting_assistant/features/recording/local_media_repository.dart';
import 'package:sme_meeting_assistant/features/recording/managed_media_storage.dart';
import 'package:sme_meeting_assistant/features/recording/recording_coordinator.dart';

import 'support/meeting_test_support.dart';

void main() {
  setUpAll(() {
    sqfliteFfiInit();
    sqflite.databaseFactory = databaseFactoryFfi;
  });

  test('stop during permission acquisition prevents native start', () async {
    final fixture = await _Fixture.create();
    addTearDown(fixture.dispose);
    final permissionStarted = Completer<void>();
    final permissionGate = Completer<bool>();
    final capture = _ControlledCapture(
      permissionStarted: permissionStarted,
      permissionGate: permissionGate,
    );
    final coordinator = fixture.coordinator(capture);

    final start = coordinator.start(
      meetingId: testMeetingId,
      capabilities: fixture.capabilities,
      meetingStatus: MeetingStatus.inProgress,
    );
    await permissionStarted.future;
    final stop = coordinator.stop();
    permissionGate.complete(true);

    await expectLater(start, throwsA(isA<RecordingEligibilityException>()));
    final state = await stop;
    expect(capture.startCalls, 0);
    expect(state.lifecycle, RecordingLifecycleState.interrupted);
  });

  test('live authorization supersedes a stale capture snapshot', () async {
    final fixture = await _Fixture.create();
    addTearDown(fixture.dispose);
    final capture = _ControlledCapture();
    final coordinator = fixture.coordinator(
      capture,
      capabilityResolver: (meetingId, scope) async =>
          RecordingAuthorizationContext(
            capabilities: fixture.capabilities,
            status: MeetingStatus.inProgress,
          ),
    );
    addTearDown(coordinator.dispose);
    final staleCapabilities = MeetingCapabilityPolicy.evaluate(
      callerId: testUserId,
      meeting: Meeting.fromJson(meetingTestJson(status: 'ENDED')),
    );

    final state = await coordinator.start(
      meetingId: testMeetingId,
      capabilities: staleCapabilities,
      meetingStatus: MeetingStatus.ended,
    );

    expect(state.lifecycle, RecordingLifecycleState.recording);
    await File(capture.path!).writeAsBytes(<int>[1, 2, 3]);
    await coordinator.stop();
  });

  test(
    'live authorization also gates import instead of stale capabilities',
    () async {
      final fixture = await _Fixture.create();
      addTearDown(fixture.dispose);
      final staleCapabilities = MeetingCapabilityPolicy.evaluate(
        callerId: testUserId,
        meeting: Meeting.fromJson(meetingTestJson(status: 'ENDED')),
      );
      final coordinator = fixture.coordinator(
        _ControlledCapture(),
        capabilityResolver: (meetingId, scope) async =>
            RecordingAuthorizationContext(
              capabilities: fixture.capabilities,
              status: MeetingStatus.inProgress,
            ),
        picker: () async => AudioImportSource(
          name: 'import.wav',
          sizeBytes: 3,
          bytes: Stream<List<int>>.value(<int>[1, 2, 3]),
        ),
      );
      addTearDown(coordinator.dispose);

      final state = await coordinator.importAudio(
        meetingId: testMeetingId,
        capabilities: staleCapabilities,
      );

      expect(state.lifecycle, RecordingLifecycleState.localReady);
      expect(state.asset?.isReady, isTrue);
    },
  );

  test(
    'cancellation during native startup performs controlled termination',
    () async {
      final fixture = await _Fixture.create();
      addTearDown(fixture.dispose);
      final startStarted = Completer<void>();
      final startGate = Completer<void>();
      final capture = _ControlledCapture(
        startStarted: startStarted,
        startGate: startGate,
      );
      final coordinator = fixture.coordinator(capture);

      final start = coordinator.start(
        meetingId: testMeetingId,
        capabilities: fixture.capabilities,
        meetingStatus: MeetingStatus.inProgress,
      );
      await startStarted.future;
      final stop = coordinator.stop();
      startGate.complete();

      await expectLater(start, throwsA(isA<RecordingEligibilityException>()));
      await stop;
      expect(capture.startCalls, 1);
      expect(capture.stopCalls, greaterThanOrEqualTo(1));
      expect(capture.nativeRecording, isFalse);
    },
  );

  test(
    'uncertain native termination retains writer protection and blocks restart',
    () async {
      final fixture = await _Fixture.create();
      addTearDown(fixture.dispose);
      final capture = _ControlledCapture(
        stopThrows: true,
        disposeTerminates: false,
      );
      final coordinator = fixture.coordinator(capture);
      await coordinator.start(
        meetingId: testMeetingId,
        capabilities: fixture.capabilities,
        meetingStatus: MeetingStatus.inProgress,
      );

      await expectLater(
        coordinator.stop(),
        throwsA(isA<FileSystemException>()),
      );
      expect(capture.nativeRecording, isTrue);
      final restart = await coordinator.start(
        meetingId: testMeetingId,
        capabilities: fixture.capabilities,
        meetingStatus: MeetingStatus.inProgress,
      );
      expect(restart.lifecycle, RecordingLifecycleState.interrupted);
      expect(capture.startCalls, 1);
      await expectLater(
        fixture.repository.discard(
          scope: fixture.scope,
          assetId: coordinator.state.asset!.id,
        ),
        throwsA(isA<LocalMediaBusyException>()),
      );
    },
  );

  test(
    'successful controlled disposal permits a subsequent recording',
    () async {
      final fixture = await _Fixture.create();
      addTearDown(fixture.dispose);
      final capture = _ControlledCapture(
        stopThrows: true,
        disposeTerminates: true,
      );
      final coordinator = fixture.coordinator(capture);
      await coordinator.start(
        meetingId: testMeetingId,
        capabilities: fixture.capabilities,
        meetingStatus: MeetingStatus.inProgress,
      );

      await expectLater(
        coordinator.stop(),
        throwsA(isA<FileSystemException>()),
      );
      final restarted = await coordinator.start(
        meetingId: testMeetingId,
        capabilities: fixture.capabilities,
        meetingStatus: MeetingStatus.inProgress,
      );
      expect(restarted.lifecycle, RecordingLifecycleState.recording);
      expect(capture.startCalls, 2);
    },
  );

  test(
    'caller-handled import failure does not create another uncaught error',
    () async {
      final fixture = await _Fixture.create();
      addTearDown(fixture.dispose);
      final uncaught = <Object>[];
      late RecordingCoordinator coordinator;
      final zone = Zone.current.fork(
        specification: ZoneSpecification(
          handleUncaughtError: (self, parent, zone, error, stack) {
            uncaught.add(error);
          },
        ),
      );
      await zone.run(() async {
        coordinator = fixture.coordinator(
          _ControlledCapture(),
          picker: () async => AudioImportSource(
            name: 'broken.wav',
            sizeBytes: 3,
            bytes: Stream<List<int>>.error(
              const AudioImportException(
                'IMPORT_READ_ERROR',
                'The source could not be read.',
              ),
            ),
          ),
        );
        final import = coordinator.importAudio(
          meetingId: testMeetingId,
          capabilities: fixture.capabilities,
        );
        await expectLater(import, throwsA(isA<AudioImportException>()));
        await Future<void>.value();
        await Future<void>.value();
      });
      coordinator.dispose();
      expect(uncaught, isEmpty);
    },
  );
}

class _Fixture {
  _Fixture({
    required this.api,
    required this.database,
    required this.repository,
  }) : scope = api.requireAuthenticatedSessionScope(),
       capabilities = MeetingCapabilityPolicy.evaluate(
         callerId: testUserId,
         meeting: Meeting.fromJson(meetingTestJson(status: 'IN_PROGRESS')),
       );

  final ApiClient api;
  final LocalMediaDatabase database;
  final LocalMediaRepository repository;
  final AuthenticatedSessionScope scope;
  final MeetingCapabilities capabilities;
  final List<RecordingCoordinator> coordinators = <RecordingCoordinator>[];

  static Future<_Fixture> create() async {
    final api = createMeetingTestApi(
      MeetingTestHttpClient((_) => meetingApiFailure(404, 'NOT_USED')),
    );
    await signInMeetingTestApi(api);
    final directory = await Directory.systemTemp.createTemp('sme-recording-');
    final database = await LocalMediaDatabase.open(
      databasePath: '${directory.path}/media.db',
      databaseFactory: databaseFactoryFfi,
    );
    final repository = LocalMediaRepository(
      persistence: LocalMediaPersistence(database),
      storage: ManagedMediaStorage(
        root: Directory('${directory.path}/managed'),
      ),
    );
    return _Fixture(api: api, database: database, repository: repository)
      ..directory = directory;
  }

  late Directory directory;

  RecordingCoordinator coordinator(
    _ControlledCapture capture, {
    AudioImportPicker? picker,
    RecordingCapabilityResolver? capabilityResolver,
  }) {
    final coordinator = RecordingCoordinator(
      api: api,
      localMedia: repository,
      capture: capture,
      picker: picker,
      capabilityResolver: capabilityResolver,
      observeAppLifecycle: false,
    );
    coordinators.add(coordinator);
    return coordinator;
  }

  Future<void> dispose() async {
    for (final coordinator in coordinators) {
      coordinator.dispose();
    }
    await repository.dispose();
    await directory.delete(recursive: true);
    api.dispose();
  }
}

class _ControlledCapture implements RecordingCaptureAdapter {
  _ControlledCapture({
    this.permissionStarted,
    this.permissionGate,
    this.startStarted,
    this.startGate,
    this.stopThrows = false,
    this.disposeTerminates = true,
  });

  final Completer<void>? permissionStarted;
  final Completer<bool>? permissionGate;
  final Completer<void>? startStarted;
  final Completer<void>? startGate;
  final bool stopThrows;
  final bool disposeTerminates;
  bool nativeRecording = false;
  int startCalls = 0;
  int stopCalls = 0;
  String? path;

  @override
  Future<bool> hasPermission() async {
    permissionStarted?.complete();
    final gate = permissionGate;
    return gate == null ? true : gate.future;
  }

  @override
  Future<void> start(RecordConfig config, {required String path}) async {
    startCalls++;
    this.path = path;
    startStarted?.complete();
    final gate = startGate;
    if (gate != null) await gate.future;
    nativeRecording = true;
  }

  @override
  Future<String?> stop() async {
    stopCalls++;
    if (stopThrows) throw const FileSystemException('native stop failed');
    nativeRecording = false;
    return path;
  }

  @override
  Future<bool?> isRecording() async => nativeRecording;

  @override
  Future<void> dispose() async {
    if (disposeTerminates) nativeRecording = false;
  }
}
