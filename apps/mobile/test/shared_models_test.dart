import 'package:flutter_test/flutter_test.dart';
import 'package:sme_meeting_assistant/core/api_response.dart';
import 'package:sme_meeting_assistant/core/date_labels.dart';
import 'package:sme_meeting_assistant/core/meeting_models.dart';
import 'package:sme_meeting_assistant/core/models.dart';

void main() {
  group('shared API models', () {
    test('decodes canonical meeting details without list display metadata', () {
      final meeting = Meeting.fromJson(_meetingJson());

      expect(meeting.id, 'meeting-1');
      expect(meeting.description, isNull);
      expect(meeting.roomId, isNull);
      expect(meeting.display, isNull);
      expect(meeting.participantCount, isNull);
      expect(meeting.scheduledStartAt, isNull);
    });

    test('keeps unknown server statuses and compatible additional fields', () {
      final meeting = Meeting.fromJson({
        ..._meetingJson(),
        'status': 'NEW_SERVER_STATE',
        'futureDisplayField': {'active': true},
      });

      expect(meeting.status, 'NEW_SERVER_STATE');
    });

    test('decodes a meeting list projection and preserves a zero count', () {
      final meeting = Meeting.fromListJson({
        ..._meetingJson(),
        'display': {
          'organizerName': null,
          'roomName': 'Main room',
          'roomLocation': null,
          'participantCount': 0,
          'participantPreview': [],
        },
      });

      expect(meeting.roomName, 'Main room');
      expect(meeting.participantCount, 0);
      expect(meeting.display!.participantPreview, isEmpty);
    });

    test(
      'rejects missing list display projection and fabricated required fields',
      () {
        expect(
          () => Meeting.fromListJson(_meetingJson()),
          throwsA(
            isA<ApiFailure>().having(
              (failure) => failure.invalidResponse,
              'invalidResponse',
              isTrue,
            ),
          ),
        );
        expect(
          () => Meeting.fromJson({..._meetingJson(), 'status': null}),
          throwsA(isA<ApiFailure>()),
        );
        expect(
          () => Meeting.fromJson({..._meetingJson(), 'id': '  '}),
          throwsA(isA<ApiFailure>()),
        );
      },
    );

    test('preserves optional action-item assignee and due date omissions', () {
      final item = ActionItem.fromJson(
        _actionItemJson()
          ..remove('assigneeUserId')
          ..remove('dueDate')
          ..remove('details'),
      );

      expect(item.assigneeId, isNull);
      expect(item.dueDate, isNull);
      expect(item.details, isNull);
      expect(item.version, 0);
    });

    test(
      'rejects malformed action-item version, status, and date-only value',
      () {
        for (final invalid in [
          {..._actionItemJson(), 'version': 1.5},
          {..._actionItemJson(), 'status': ''},
          {..._actionItemJson(), 'dueDate': '2026-02-30'},
        ]) {
          expect(
            () => ActionItem.fromJson(invalid),
            throwsA(isA<ApiFailure>()),
          );
        }
      },
    );

    test(
      'participant and room fields reflect nullable backend projections',
      () {
        final participant = MeetingParticipant.fromJson({
          'id': 'participant-1',
          'meetingId': 'meeting-1',
          'userId': 'user-1',
          'addedByUserId': null,
          'addedAt': '2026-11-23T10:00:00Z',
          'removedAt': null,
          'removedByUserId': null,
          'displayName': null,
        });
        final room = MeetingRoom.fromJson({
          'id': 'room-1',
          'code': 'R1',
          'name': 'Room',
          'location': null,
          'capacity': null,
          'status': 'ACTIVE',
          'notes': null,
          'createdAt': '2026-11-23T10:00:00Z',
          'updatedAt': '2026-11-23T10:00:00Z',
        });

        expect(participant.displayName, isNull);
        expect(room.capacity, isNull);
        expect(room.location, isNull);
        expect(room.status, 'ACTIVE');
      },
    );

    test(
      'validates available-room projection independently from room catalog',
      () {
        final room = AvailableRoom.fromJson({
          'id': 'room-1',
          'code': 'R1',
          'name': 'Room',
          'location': null,
          'capacity': 1,
          'available': false,
          'participantCount': 0,
          'capacityExceeded': false,
        });

        expect(room.available, isFalse);
        expect(room.capacity, 1);
        expect(
          () => AvailableRoom.fromJson({
            'id': 'room-1',
            'code': 'R1',
            'name': 'Room',
            'available': 'false',
          }),
          throwsA(isA<ApiFailure>()),
        );
      },
    );

    test('rejects fractional segment offsets and invalid timing order', () {
      final segment = _segmentJson();
      expect(
        () => SpeechSegment.fromJson({...segment, 'startMs': 1.2}),
        throwsA(isA<ApiFailure>()),
      );
      expect(
        () =>
            SpeechSegment.fromJson({...segment, 'startMs': 500, 'endMs': 499}),
        throwsA(isA<ApiFailure>()),
      );
      expect(
        () => SpeechSegment.fromJson({...segment, 'version': -1}),
        throwsA(isA<ApiFailure>()),
      );
    });

    test(
      'validates transcript identity, revision, timing and nullable fields',
      () {
        final response = ApiResult(
          {
            'id': 'transcript-1',
            'meetingId': 'meeting-1',
            'sourceMediaId': null,
            'processingJobId': null,
            'versionNumber': 1,
            'languageCode': 'vi',
            'status': 'FINALIZED',
            'durationMs': 0,
            'finalizedAt': null,
            'contentRevision': 0,
            'segments': [_segmentJson()],
          },
          const {},
          '"transcript-server-tag"',
          requestId: 'req-body',
          responseRequestId: 'req-header',
        );
        final transcript = Transcript.fromResult(response);

        expect(transcript.segments, hasLength(1));
        expect(transcript.durationMs, 0);
        expect(transcript.finalizedAt, isNull);
        expect(transcript.etag, '"transcript-server-tag"');
        expect(
          () => Transcript.fromResult(
            ApiResult(
              {
                'id': 'transcript-1',
                'meetingId': 'meeting-1',
                'versionNumber': 1.2,
                'languageCode': 'vi',
                'status': 'FINALIZED',
                'contentRevision': 0,
                'segments': [],
              },
              const {},
              null,
            ),
          ),
          throwsA(isA<ApiFailure>()),
        );
      },
    );

    test('validates processing identity, status, counter and timestamps', () {
      final job = ProcessingJob.fromJson({
        'id': 'job-1',
        'meetingId': 'meeting-1',
        'sourceMediaId': null,
        'jobType': 'TRANSCRIPTION',
        'status': 'QUEUED',
        'requestedByUserId': 'user-1',
        'currentStage': null,
        'queuedAt': '2026-11-23T10:00:00Z',
        'startedAt': null,
        'completedAt': null,
        'errorCode': null,
        'errorSummary': null,
        'warningSummary': null,
        'createdAt': '2026-11-23T10:00:00Z',
        'updatedAt': '2026-11-23T10:00:00Z',
        'retryable': false,
        'retryCount': 0,
        'stageRuns': [],
      });

      expect(job.status, 'QUEUED');
      expect(job.currentStage, isNull);
      expect(job.queuedAt.isUtc, isTrue);
      expect(
        () => ProcessingJob.fromJson({
          'id': 'job-1',
          'status': 'QUEUED',
          'queuedAt': '2026-11-23T10:00:00',
        }),
        throwsA(isA<ApiFailure>()),
      );
    });

    test('does not expose a fabricated decision ETag', () {
      final decision = MeetingDecision.fromJson({
        'id': 'decision-1',
        'meetingId': 'meeting-1',
        'content': 'Decision',
        'status': 'PROPOSED',
        'version': 4,
        'isStale': false,
        'createdAt': '2026-11-23T10:00:00Z',
      });

      expect(decision.version, 4);
      expect(decision.stale, isFalse);
      expect(
        () => (decision as dynamic).etag,
        throwsA(isA<NoSuchMethodError>()),
      );
    });

    test('model failures retain response status and request correlation', () {
      final response = ApiResult(
        _meetingJson()..remove('status'),
        const {'pagination': null},
        null,
        statusCode: 206,
        requestId: 'body-request',
        responseRequestId: 'header-request',
        timestamp: '2026-11-23T10:00:00Z',
        headers: const {'x-request-id': 'header-request'},
      );

      try {
        Meeting.fromJson(response.objectData(), response: response);
        fail('Expected invalid response failure.');
      } on ApiFailure catch (failure) {
        expect(failure.invalidResponse, isTrue);
        expect(failure.status, 206);
        expect(failure.requestId, 'body-request');
        expect(failure.responseRequestId, 'header-request');
        expect(failure.timestamp, '2026-11-23T10:00:00Z');
        expect(failure.headers['x-request-id'], 'header-request');
        expect(failure.transportFailure, isFalse);
      }
    });
  });

  group('Core API date semantics', () {
    test('offset-qualified values with different offsets preserve the same instant', () {
      final first = Meeting.fromJson({
        ..._meetingJson(),
        'scheduledStartAt': '2026-11-23T12:00:00+02:00',
      });
      final second = Meeting.fromJson({
        ..._meetingJson(),
        'scheduledStartAt': '2026-11-23T10:00:00Z',
      });

      expect(
        first.scheduledStartAt!.isAtSameMomentAs(second.scheduledStartAt!),
        isTrue,
      );
      expect(first.scheduledStartAt!.isUtc, isTrue);
      expect(
        dateValue(first.scheduledStartAt)!
            .isAtSameMomentAs(second.scheduledStartAt!),
        isTrue,
      );
    });

    test('rejects timestamp without explicit offset and invalid non-null optional time', () {
      expect(
        () => Meeting.fromJson({
          ..._meetingJson(),
          'createdAt': '2026-11-23T10:00:00',
        }),
        throwsA(isA<ApiFailure>()),
      );
      expect(
        () => Meeting.fromJson({
          ..._meetingJson(),
          'scheduledStartAt': 'invalid',
        }),
        throwsA(isA<ApiFailure>()),
      );
    });

    test(
      'date-only values stay calendar dates and invalid dates do not parse',
      () {
        final parsed = parseDateOnly('2026-11-23');

        expect(parsed, isNotNull);
        expect(
          '${parsed!.year}-${parsed.month.toString().padLeft(2, '0')}-'
              '${parsed.day.toString().padLeft(2, '0')}',
          '2026-11-23',
        );
        expect(parseDateOnly('2026-02-30'), isNull);
        expect(parseDateOnly('2026-11-23T00:00:00Z'), isNull);
      },
    );
  });
}

Map<String, dynamic> _meetingJson() => {
  'id': 'meeting-1',
  'title': 'Weekly review',
  'description': null,
  'organizerUserId': 'user-1',
  'roomId': null,
  'scheduledStartAt': null,
  'scheduledEndAt': null,
  'status': 'DRAFT',
  'startedAt': null,
  'endedAt': null,
  'cancelledAt': null,
  'cancellationReason': null,
  'createdByUserId': 'user-1',
  'createdAt': '2026-11-23T10:00:00Z',
  'updatedAt': '2026-11-23T10:00:00Z',
};

Map<String, dynamic> _actionItemJson() => {
  'id': 'action-1',
  'meetingId': 'meeting-1',
  'title': 'Follow up',
  'details': null,
  'status': 'OPEN',
  'assigneeUserId': null,
  'dueDate': null,
  'overdue': false,
  'version': 0,
};

Map<String, dynamic> _segmentJson() => {
  'id': 'segment-1',
  'ordinal': 0,
  'startMs': 0,
  'endMs': 1000,
  'text': 'Hello',
  'qualityStatus': 'ACCEPTED',
  'speakerClusterId': null,
  'speakerLabel': null,
  'version': 0,
};
