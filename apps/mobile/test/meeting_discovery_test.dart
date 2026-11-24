import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/core/models.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_discovery.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_foundation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_invalidation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_repository.dart';

import 'support/meeting_test_support.dart';

const _meetingBId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const _meetingCId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

Map<String, dynamic> _listMeeting(
  String id, {
  String? start = '2026-11-24T09:00:00Z',
  String? end = '2026-11-24T10:00:00Z',
  String status = 'SCHEDULED',
}) => {
  ...meetingTestJson(
    status: status,
    scheduledStartAt: start,
    scheduledEndAt: end,
  ),
  'id': id,
  'display': {
    'organizerName': 'Người tổ chức',
    'roomName': 'Phòng 1',
    'roomLocation': 'Tòa A',
    'participantCount': 2,
    'participantPreview': [
      {'userId': testUserId, 'displayName': 'Người tổ chức'},
    ],
  },
};

Future<http.StreamedResponse> _meetingPage({
  required List<Map<String, dynamic>> meetings,
  required int page,
  required int totalElements,
  required int totalPages,
  required bool hasNext,
}) => meetingApiSuccess(
  meetings,
  meta: {
    ...meetingTestMeta,
    'pagination': {
      'page': page,
      'size': 20,
      'totalElements': totalElements,
      'totalPages': totalPages,
      'hasNext': hasNext,
      'hasPrevious': page > 0,
    },
  },
);

Future<http.StreamedResponse> _calendarPage({
  required List<Map<String, dynamic>> meetings,
  required int page,
  required int totalElements,
  required int totalPages,
  required bool hasNext,
}) => meetingApiSuccess(
  meetings,
  meta: {
    ...meetingTestMeta,
    'pagination': {
      'page': page,
      'size': 100,
      'totalElements': totalElements,
      'totalPages': totalPages,
      'hasNext': hasNext,
      'hasPrevious': page > 0,
    },
  },
);

void main() {
  group('Meeting discovery controller', () {
    test(
      'applies typed search, status, relationship and sorting filters',
      () async {
        final client = MeetingTestHttpClient((request) async {
          if (request.url.path.endsWith('/meetings')) {
            expect(request.url.queryParameters, {
              'q': 'roadmap',
              'status': 'SCHEDULED',
              'relationship': 'ORGANIZER',
              'page': '0',
              'size': '20',
              'sort': 'title,asc',
            });
            return _meetingPage(
              meetings: [_listMeeting(testMeetingId)],
              page: 0,
              totalElements: 1,
              totalPages: 1,
              hasNext: false,
            );
          }
          throw StateError('Unexpected request ${request.url}');
        });
        final api = createMeetingTestApi(client);
        addTearDown(api.dispose);
        await signInMeetingTestApi(api);
        final invalidation = MeetingInvalidationSignal(api);
        addTearDown(invalidation.dispose);
        final controller = MeetingDiscoveryController(
          repository: MeetingRepository(api: api, invalidation: invalidation),
          invalidation: invalidation,
        );
        addTearDown(controller.dispose);
        controller.setSearchInput(' roadmap ');

        await controller.applyQuery(
          search: controller.searchInput,
          status: MeetingStatus.scheduled,
          relationship: MeetingRelationship.organizer,
          sort: MeetingSortField.title,
          direction: MeetingSortDirection.ascending,
        );

        expect(
          controller.state.appliedQuery.relationship,
          MeetingRelationship.organizer,
        );
        expect(
          controller.state.items.single.display.organizerName,
          'Người tổ chức',
        );
        expect(controller.state.isConfirmedEmpty, isFalse);
      },
    );

    test(
      'a stale query response cannot mix with the newly applied collection',
      () async {
        final oldResponse = Completer<http.StreamedResponse>();
        final oldStarted = Completer<void>();
        final client = MeetingTestHttpClient((request) async {
          if (request.url.path.endsWith('/meetings')) {
            if (request.url.queryParameters['q'] == 'Alice') {
              oldStarted.complete();
              return oldResponse.future;
            }
            return _meetingPage(
              meetings: [_listMeeting(_meetingBId)],
              page: 0,
              totalElements: 1,
              totalPages: 1,
              hasNext: false,
            );
          }
          throw StateError('Unexpected request ${request.url}');
        });
        final api = createMeetingTestApi(client);
        addTearDown(api.dispose);
        await signInMeetingTestApi(api);
        final invalidation = MeetingInvalidationSignal(api);
        addTearDown(invalidation.dispose);
        final controller = MeetingDiscoveryController(
          repository: MeetingRepository(api: api, invalidation: invalidation),
          invalidation: invalidation,
        );
        addTearDown(controller.dispose);

        final oldQuery = controller.applyQuery(search: 'Alice');
        await oldStarted.future;
        await controller.applyQuery(search: 'Bob');
        await completeRequestAfter(
          oldResponse,
          status: 200,
          body: meetingSuccessEnvelope(
            [_listMeeting(testMeetingId)],
            meta: {
              ...meetingTestMeta,
              'pagination': {
                'page': 0,
                'size': 20,
                'totalElements': 1,
                'totalPages': 1,
                'hasNext': false,
                'hasPrevious': false,
              },
            },
          ),
        );
        await oldQuery;

        expect(controller.state.appliedQuery.search, 'Bob');
        expect(controller.state.items.map((entry) => entry.meeting.id), [
          _meetingBId,
        ]);
      },
    );

    test(
      'clears in-flight discovery when its authenticated session changes',
      () async {
        final oldResponse = Completer<http.StreamedResponse>();
        final oldStarted = Completer<void>();
        final client = MeetingTestHttpClient((request) async {
          if (!request.url.path.endsWith('/meetings')) {
            throw StateError('Unexpected request ${request.url}');
          }
          oldStarted.complete();
          return oldResponse.future;
        });
        final api = createMeetingTestApi(client);
        addTearDown(api.dispose);
        await signInMeetingTestApi(api);
        final invalidation = MeetingInvalidationSignal(api);
        addTearDown(invalidation.dispose);
        final controller = MeetingDiscoveryController(
          repository: MeetingRepository(api: api, invalidation: invalidation),
          invalidation: invalidation,
        );
        addTearDown(controller.dispose);

        final oldQuery = controller.applyQuery(search: 'Roadmap');
        await oldStarted.future;
        await api.signOut();
        await completeRequestAfter(
          oldResponse,
          status: 200,
          body: meetingSuccessEnvelope(
            [_listMeeting(testMeetingId)],
            meta: {
              ...meetingTestMeta,
              'pagination': {
                'page': 0,
                'size': 20,
                'totalElements': 1,
                'totalPages': 1,
                'hasNext': false,
                'hasPrevious': false,
              },
            },
          ),
        );
        await oldQuery;

        expect(controller.state.items, isEmpty);
        expect(controller.state.hasLoaded, isFalse);
        expect(controller.state.searchInput, isEmpty);
      },
    );

    test(
      'a page failure preserves loaded rows and remains retryable',
      () async {
        var pageOneAttempts = 0;
        final client = MeetingTestHttpClient((request) async {
          if (!request.url.path.endsWith('/meetings')) {
            throw StateError('Unexpected request ${request.url}');
          }
          final page = int.parse(request.url.queryParameters['page']!);
          if (page == 0) {
            return _meetingPage(
              meetings: [_listMeeting(testMeetingId)],
              page: 0,
              totalElements: 21,
              totalPages: 2,
              hasNext: true,
            );
          }
          pageOneAttempts++;
          if (pageOneAttempts == 1) {
            return meetingApiFailure(503, 'SERVICE_UNAVAILABLE');
          }
          return _meetingPage(
            meetings: [_listMeeting(_meetingBId)],
            page: 1,
            totalElements: 21,
            totalPages: 2,
            hasNext: false,
          );
        });
        final api = createMeetingTestApi(client);
        addTearDown(api.dispose);
        await signInMeetingTestApi(api);
        final invalidation = MeetingInvalidationSignal(api);
        addTearDown(invalidation.dispose);
        final controller = MeetingDiscoveryController(
          repository: MeetingRepository(api: api, invalidation: invalidation),
          invalidation: invalidation,
        );
        addTearDown(controller.dispose);

        await controller.initialize();
        await controller.loadMore();
        expect(controller.state.items, hasLength(1));
        expect(controller.state.loadingFailure, isNotNull);
        expect(controller.state.hasMore, isTrue);

        await controller.retry();
        expect(controller.state.items, hasLength(2));
        expect(controller.state.loadingFailure, isNull);
        expect(controller.state.hasMore, isFalse);
      },
    );
  });

  group('Canonical calendar controller', () {
    test('accumulates canonical pages and reports a complete month', () async {
      var requests = 0;
      final client = MeetingTestHttpClient((request) async {
        expect(request.url.path, '/api/v1/meetings');
        final page = int.parse(request.url.queryParameters['page']!);
        requests++;
        if (page == 0) {
          return _calendarPage(
            meetings: const [],
            page: 0,
            totalElements: 101,
            totalPages: 2,
            hasNext: true,
          );
        }
        return _calendarPage(
          meetings: [_listMeeting(testMeetingId)],
          page: 1,
          totalElements: 101,
          totalPages: 2,
          hasNext: false,
        );
      });
      final api = createMeetingTestApi(client);
      addTearDown(api.dispose);
      await signInMeetingTestApi(api);
      final invalidation = MeetingInvalidationSignal(api);
      addTearDown(invalidation.dispose);
      final controller = MeetingCalendarController(
        repository: MeetingRepository(api: api, invalidation: invalidation),
        invalidation: invalidation,
        initialMonth: DateTime(2026, 11),
      );
      addTearDown(controller.dispose);

      await controller.initialize();

      expect(requests, 2);
      expect(controller.state.loadedPageCount, 2);
      expect(controller.state.entries.single.meeting.id, testMeetingId);
      expect(controller.state.hasMore, isFalse);
      expect(controller.state.incomplete, isFalse);
    });

    test(
      'marks a bounded month incomplete until remaining pages are fetched',
      () async {
        var requests = 0;
        final client = MeetingTestHttpClient((request) async {
          final page = int.parse(request.url.queryParameters['page']!);
          requests++;
          return _calendarPage(
            meetings: const [],
            page: page,
            totalElements: 3001,
            totalPages: 31,
            hasNext: page < 30,
          );
        });
        final api = createMeetingTestApi(client);
        addTearDown(api.dispose);
        await signInMeetingTestApi(api);
        final invalidation = MeetingInvalidationSignal(api);
        addTearDown(invalidation.dispose);
        final controller = MeetingCalendarController(
          repository: MeetingRepository(api: api, invalidation: invalidation),
          invalidation: invalidation,
          initialMonth: DateTime(2026, 11),
        );
        addTearDown(controller.dispose);

        await controller.initialize();
        expect(requests, calendarPageBatchLimit);
        expect(controller.state.incomplete, isTrue);
        expect(controller.state.hasMore, isTrue);
        expect(controller.state.isConfirmedEmpty, isFalse);

        await controller.continueLoading();
        expect(requests, calendarPageBatchLimit + 1);
        expect(controller.state.incomplete, isFalse);
        expect(controller.state.hasMore, isFalse);
        expect(controller.state.isConfirmedEmpty, isTrue);
      },
    );

    test(
      'uses typed month filters and fences an older month response',
      () async {
        final oldResponse = Completer<http.StreamedResponse>();
        final oldStarted = Completer<void>();
        final client = MeetingTestHttpClient((request) async {
          if (!request.url.path.endsWith('/meetings')) {
            throw StateError('Unexpected request ${request.url}');
          }
          final november = CalendarMonthRange.fromDate(DateTime(2026, 11));
          final december = CalendarMonthRange.fromDate(DateTime(2026, 12));
          final from = request.url.queryParameters['from'];
          expect(
            from,
            anyOf(
              november.startUtc.toIso8601String(),
              december.startUtc.toIso8601String(),
            ),
          );
          expect(
            request.url.queryParameters['to'],
            from == november.startUtc.toIso8601String()
                ? november.endUtc.toIso8601String()
                : december.endUtc.toIso8601String(),
          );
          expect(request.url.queryParameters['size'], '100');
          if (from == november.startUtc.toIso8601String()) {
            expect(request.url.queryParameters['relationship'], 'PARTICIPANT');
            expect(request.url.queryParameters['status'], 'SCHEDULED');
            oldStarted.complete();
            return oldResponse.future;
          }
          expect(from, december.startUtc.toIso8601String());
          return _calendarPage(
            meetings: [_listMeeting(_meetingBId)],
            page: 0,
            totalElements: 1,
            totalPages: 1,
            hasNext: false,
          );
        });
        final api = createMeetingTestApi(client);
        addTearDown(api.dispose);
        await signInMeetingTestApi(api);
        final invalidation = MeetingInvalidationSignal(api);
        addTearDown(invalidation.dispose);
        final controller = MeetingCalendarController(
          repository: MeetingRepository(api: api, invalidation: invalidation),
          invalidation: invalidation,
          initialMonth: DateTime(2026, 11, 12),
        );
        addTearDown(controller.dispose);

        final oldMonth = controller.setFilters(
          relationship: MeetingRelationship.participant,
          status: MeetingStatus.scheduled,
        );
        await oldStarted.future;
        await controller.setMonth(DateTime(2026, 12, 1));
        await completeRequestAfter(
          oldResponse,
          status: 200,
          body: meetingSuccessEnvelope(
            [_listMeeting(testMeetingId)],
            meta: {
              ...meetingTestMeta,
              'pagination': {
                'page': 0,
                'size': 100,
                'totalElements': 1,
                'totalPages': 1,
                'hasNext': false,
                'hasPrevious': false,
              },
            },
          ),
        );
        await oldMonth;

        expect(controller.state.month, DateTime(2026, 12));
        expect(controller.state.entries.map((entry) => entry.meeting.id), [
          _meetingBId,
        ]);
        expect(controller.state.isConfirmedEmpty, isFalse);
      },
    );
  });

  group('Calendar interval projection', () {
    test(
      'projects cross-day intervals and respects exclusive midnight ends',
      () {
        final overnight = Meeting.fromListJson(
          _listMeeting(
            testMeetingId,
            start: '2026-11-24T23:00:00Z',
            end: '2026-11-25T02:00:00Z',
          ),
        );
        final endsAtMidnight = Meeting.fromListJson(
          _listMeeting(
            _meetingBId,
            start: DateTime(
              2026,
              11,
              25,
            ).subtract(const Duration(hours: 2)).toUtc().toIso8601String(),
            end: DateTime(2026, 11, 25).toUtc().toIso8601String(),
          ),
        );
        final midnightDay = DateTime(2026, 11, 25);

        expect(meetingIntersectsLocalDay(overnight, midnightDay), isTrue);
        expect(meetingIntersectsLocalDay(endsAtMidnight, midnightDay), isFalse);
        expect(
          meetingIntersectsLocalDay(
            Meeting.fromListJson(
              _listMeeting(_meetingCId, start: null, end: null),
            ),
            midnightDay,
          ),
          isFalse,
        );
      },
    );

    test('orders calendar rows by instant and then canonical identity', () {
      final first = MeetingListProjection.fromJson(_listMeeting(testMeetingId));
      final sameTime = MeetingListProjection.fromJson(
        _listMeeting(_meetingBId),
      );
      final later = MeetingListProjection.fromJson(
        _listMeeting(
          _meetingCId,
          start: '2026-11-24T11:00:00Z',
          end: '2026-11-24T12:00:00Z',
        ),
      );

      expect(
        stableChronologicalMeetings([later, sameTime, first])
            .map((meeting) => meeting.meeting.id),
        [testMeetingId, _meetingBId, _meetingCId],
      );
    });
  });
}
