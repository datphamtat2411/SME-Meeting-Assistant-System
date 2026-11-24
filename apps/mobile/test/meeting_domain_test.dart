import 'package:flutter_test/flutter_test.dart';
import 'package:sme_meeting_assistant/core/api_response.dart';
import 'package:sme_meeting_assistant/core/models.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_foundation.dart';

import 'support/meeting_test_support.dart';

void main() {
  group('Meeting query contracts', () {
    test('serializes filters in a deterministic, backend-supported shape', () {
      final from = DateTime.parse('2026-11-24T09:00:00+02:00');
      final to = DateTime.parse('2026-11-24T11:00:00+02:00');
      final query = MeetingQuery(
        search: '  planning  ',
        status: MeetingStatus.scheduled,
        organizerId: testUserId,
        roomId: testRoomId,
        relationship: MeetingRelationship.participant,
        from: from,
        to: to,
        page: 2,
        size: 100,
        sort: MeetingSortField.scheduledStartAt,
        direction: MeetingSortDirection.ascending,
      );
      final first = query.toQueryParameters();

      expect(first.keys.toList(), [
        'q',
        'status',
        'organizerId',
        'roomId',
        'relationship',
        'from',
        'to',
        'page',
        'size',
        'sort',
      ]);
      expect(first['q'], '  planning  ');
      expect(first['status'], 'SCHEDULED');
      expect(first['relationship'], 'PARTICIPANT');
      expect(first['from'], '2026-11-24T07:00:00.000Z');
      expect(first['to'], '2026-11-24T09:00:00.000Z');
      expect(first['page'], '2');
      expect(first['size'], '100');
      expect(first['sort'], 'scheduledStartAt,asc');
      expect(query.toQueryParameters(), equals(first));
      expect(() => first['page'] = '7', throwsUnsupportedError);
    });

    test('omits the relationship filter by default and validates limits', () {
      final query = MeetingQuery();
      expect(query.toQueryParameters(), {
        'page': '0',
        'size': '20',
        'sort': 'createdAt,desc',
      });
      expect(() => MeetingQuery(size: 101), throwsArgumentError);
      expect(() => MeetingQuery(page: -1), throwsArgumentError);
      expect(
        () => MeetingQuery(search: List<String>.filled(201, 'x').join()),
        throwsArgumentError,
      );
      expect(
        () => MeetingQuery(
          from: DateTime.utc(2026, 11, 24, 10),
          to: DateTime.utc(2026, 11, 24, 10),
        ),
        throwsArgumentError,
      );
    });
  });

  group('Meeting lifecycle and capabilities', () {
    test(
      'decodes only canonical lifecycle states and retains nullable values',
      () {
        for (final status in MeetingStatus.values) {
          final meeting = Meeting.fromJson(
            meetingTestJson(status: status.wireValue),
          );
          expect(meeting.lifecycleStatus, status);
          expect(meeting.status, status.wireValue);
        }

        final draft = Meeting.fromJson(
          meetingTestJson(
            status: 'DRAFT',
            scheduledStartAt: null,
            scheduledEndAt: null,
          ),
        );
        expect(draft.scheduledStartAt, isNull);
        expect(draft.scheduledEndAt, isNull);
        expect(
          () =>
              Meeting.fromJson(meetingTestJson(status: 'RECORDING_PROCESSING')),
          throwsA(isA<ApiFailure>()),
        );
        expect(
          () => Meeting.fromJson(
            meetingTestJson(
              scheduledStartAt: '2026-11-24T09:00:00Z',
              scheduledEndAt: null,
            ),
          ),
          throwsA(isA<ApiFailure>()),
        );
      },
    );

    test('matches the organizer lifecycle capability matrix exactly', () {
      const expected = <MeetingStatus, Set<MeetingOperation>>{
        MeetingStatus.draft: {
          MeetingOperation.edit,
          MeetingOperation.schedule,
          MeetingOperation.cancel,
          MeetingOperation.manageParticipants,
        },
        MeetingStatus.scheduled: {
          MeetingOperation.edit,
          MeetingOperation.start,
          MeetingOperation.cancel,
          MeetingOperation.manageParticipants,
        },
        MeetingStatus.inProgress: {
          MeetingOperation.end,
          MeetingOperation.manageParticipants,
        },
        MeetingStatus.ended: {},
        MeetingStatus.cancelled: {},
      };

      for (final entry in expected.entries) {
        final meeting = Meeting.fromJson(
          meetingTestJson(status: entry.key.wireValue),
        );
        final capabilities = MeetingCapabilityPolicy.evaluate(
          callerId: testUserId,
          meeting: meeting,
        );
        for (final operation in MeetingOperation.values) {
          expect(
            capabilities.allows(operation),
            entry.value.contains(operation),
            reason: '${entry.key} should allow ${operation.name}',
          );
        }
      }
    });

    test(
      'participants, global roles, and unavailable identity fail closed',
      () {
        final meeting = Meeting.fromJson(meetingTestJson(status: 'SCHEDULED'));
        for (final callerId in <String?>['other-user', null, '']) {
          final capabilities = MeetingCapabilityPolicy.evaluate(
            callerId: callerId,
            meeting: meeting,
          );
          expect(
            MeetingOperation.values.every(
              (operation) => !capabilities.allows(operation),
            ),
            isTrue,
          );
        }

        final invalidIdentity = MeetingCapabilityPolicy.evaluate(
          callerId: testUserId,
          meeting: Meeting(
            id: testMeetingId,
            title: 'Legacy model with unknown status',
            description: null,
            status: 'UNKNOWN',
            scheduledStartAt: null,
            scheduledEndAt: null,
            startedAt: null,
            endedAt: null,
            cancelledAt: null,
            cancellationReason: null,
            roomId: null,
            organizerId: testUserId,
            createdByUserId: testUserId,
            createdAt: DateTime.utc(2026, 11, 20),
            updatedAt: DateTime.utc(2026, 11, 20),
            display: null,
          ),
        );
        expect(
          MeetingOperation.values.every(
            (operation) => !invalidIdentity.allows(operation),
          ),
          isTrue,
        );
      },
    );
  });

  group('Scheduling and calendar time semantics', () {
    test('serializes absolute instants as UTC and uses half-open overlap', () {
      final first = MeetingInterval(
        start: DateTime.parse('2026-11-24T09:00:00+02:00'),
        end: DateTime.parse('2026-11-24T10:00:00+02:00'),
      );
      final adjacent = MeetingInterval(
        start: DateTime.parse('2026-11-24T10:00:00+02:00'),
        end: DateTime.parse('2026-11-24T11:00:00+02:00'),
      );
      final overlapping = MeetingInterval(
        start: DateTime.parse('2026-11-24T09:59:00+02:00'),
        end: DateTime.parse('2026-11-24T11:00:00+02:00'),
      );

      expect(first.start.isUtc, isTrue);
      expect(first.toApiStart, '2026-11-24T07:00:00.000Z');
      expect(first.overlaps(adjacent), isFalse);
      expect(adjacent.overlaps(first), isFalse);
      expect(first.overlaps(overlapping), isTrue);
      expect(
        () => MeetingInterval(
          start: DateTime.utc(2026, 11, 24, 10),
          end: DateTime.utc(2026, 11, 24, 10),
        ),
        throwsArgumentError,
      );
    });

    test(
      'calendar dates stay date-only values, not local timestamp instants',
      () {
        final date = CalendarDate.parse('2026-11-24');
        expect(date, isNotNull);
        expect(date!.toString(), '2026-11-24');
        expect(CalendarDate.parse('2026-02-30'), isNull);
        expect(CalendarDate.parse('2026-11-24T00:00:00Z'), isNull);
      },
    );
  });

  group('Immutable create and patch inputs', () {
    test(
      'allows unscheduled and roomless drafts without invented timestamps',
      () {
        final input = CreateMeetingInput(
          title: 'Draft',
          description: null,
          roomId: null,
        );

        expect(input.scheduledInterval, isNull);
        expect(input.roomId, isNull);
      },
    );

    test('patch distinguishes omitted, assigned, and explicit null fields', () {
      final patch = MeetingUpdateInput(
        title: const MeetingFieldUpdate<String>.omitted(),
        description: const MeetingFieldUpdate<String?>.set(null),
        scheduledStartAt: MeetingFieldUpdate<DateTime?>.set(
          DateTime.parse('2026-11-24T10:00:00+02:00'),
        ),
        roomId: const MeetingFieldUpdate<String?>.omitted(),
      );
      expect(patch.title.isSpecified, isFalse);
      expect(patch.description.isSpecified, isTrue);
      expect(patch.description.value, isNull);
      expect(patch.scheduledStartAt.isSpecified, isTrue);
      expect(
        patch.scheduledStartAt.value!.toUtc(),
        DateTime.utc(2026, 11, 24, 8),
      );
      expect(() => MeetingUpdateInput(), throwsArgumentError);
    });
  });
}
