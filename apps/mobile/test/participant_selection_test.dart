import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/features/meetings/participant_selection.dart';

import 'support/meeting_test_support.dart';

void main() {
  group('Meeting participant candidates', () {
    test('validates search input and serializes bounded pagination', () {
      final query = MeetingCandidateQuery(search: '  Al  ', page: 1);

      expect(query.toQueryParameters(), {'q': 'Al', 'page': '1', 'size': '20'});
      expect(() => MeetingCandidateQuery(search: '  '), throwsArgumentError);
      expect(() => MeetingCandidateQuery(search: ' a '), throwsArgumentError);
      expect(
        () => MeetingCandidateQuery(search: 'x', size: 21),
        throwsArgumentError,
      );
      expect(
        () => MeetingCandidateQuery(search: List.filled(201, 'x').join()),
        throwsArgumentError,
      );
    });

    test(
      'uses meeting-specific candidates and strictly decodes page data',
      () async {
        final candidateId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
        final client = MeetingTestHttpClient((request) async {
          expect(request.method, 'GET');
          expect(request.url.path, '/api/v1/users/meeting-candidates');
          expect(request.url.queryParameters, {
            'q': 'Linh',
            'page': '0',
            'size': '20',
          });
          return meetingApiSuccess(
            [
              {
                'id': candidateId,
                'displayName': 'Linh Nguyễn',
                'email': 'linh@example.test',
                'organizationalUnitName': 'Vận hành',
              },
            ],
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
          );
        });
        final api = createMeetingTestApi(client);
        addTearDown(api.dispose);
        await signInMeetingTestApi(api);

        final page = await ParticipantCandidateRepository(api).search(
          MeetingCandidateQuery(search: 'Linh'),
          sessionScope: api.requireAuthenticatedSessionScope(),
        );

        expect(page.items.single.id, candidateId);
        expect(page.items.single.organizationalUnitName, 'Vận hành');
      },
    );

    test('selection persists across searches, excludes organizer and active members', () async {
      final firstId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      final secondId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
      final client = MeetingTestHttpClient((request) async {
        final query = request.url.queryParameters['q'];
        final candidate = query == 'Al'
            ? {
                'id': firstId,
                'displayName': 'Alice',
                'email': 'alice@example.test',
                'organizationalUnitName': 'Kế toán',
              }
            : {
                'id': secondId,
                'displayName': 'Bob',
                'email': 'bob@example.test',
                'organizationalUnitName': null,
              };
        return meetingApiSuccess(
          [candidate],
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
        );
      });
      final api = createMeetingTestApi(client);
      addTearDown(api.dispose);
      await signInMeetingTestApi(api);
      final controller = ParticipantPickerController(
        repository: ParticipantCandidateRepository(api),
        sessionScope: api.requireAuthenticatedSessionScope(),
        organizerId: testUserId,
        activeParticipantIds: [testRoomId],
        mode: ParticipantSelectionMode.multiple,
      );
      addTearDown(controller.dispose);

      await controller.searchNow('Al');
      controller.toggleSelection(controller.state.candidates.single);
      await controller.searchNow('Bo');
      expect(controller.state.selected.single.id, firstId);
      expect(controller.state.candidates.single.id, secondId);
      expect(
        controller.state.canSelect(controller.state.candidates.single),
        isTrue,
      );
      expect(
        controller.state.canSelect(
          MeetingParticipantCandidate(
            id: testUserId,
            displayName: 'Organizer',
            email: 'organizer@example.test',
            organizationalUnitName: null,
          ),
        ),
        isFalse,
      );
      expect(
        controller.state.canSelect(
          MeetingParticipantCandidate(
            id: testRoomId,
            displayName: 'Active member',
            email: 'member@example.test',
            organizationalUnitName: null,
          ),
        ),
        isFalse,
      );
    });

    test(
      'an older candidate response cannot replace the current applied search',
      () async {
        final oldResponse = Completer<http.StreamedResponse>();
        final oldStarted = Completer<void>();
        final client = MeetingTestHttpClient((request) async {
          if (request.url.queryParameters['q'] == 'Al') {
            oldStarted.complete();
            return oldResponse.future;
          }
          return _candidatePage(
            id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
            page: 0,
            totalElements: 1,
            totalPages: 1,
            hasNext: false,
          );
        });
        final api = createMeetingTestApi(client);
        addTearDown(api.dispose);
        await signInMeetingTestApi(api);
        final controller = ParticipantPickerController(
          repository: ParticipantCandidateRepository(api),
          sessionScope: api.requireAuthenticatedSessionScope(),
          organizerId: testUserId,
          mode: ParticipantSelectionMode.single,
        );
        addTearDown(controller.dispose);

        final oldSearch = controller.searchNow('Al');
        await oldStarted.future;
        await controller.searchNow('Bo');
        await completeRequestAfter(
          oldResponse,
          status: 200,
          body: meetingSuccessEnvelope(
            [
              {
                'id': 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                'displayName': 'Alice',
                'email': 'alice@example.test',
                'organizationalUnitName': null,
              },
            ],
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
        await oldSearch;

        expect(controller.state.appliedQuery?.search, 'Bo');
        expect(
          controller.state.candidates.single.id,
          'ffffffff-ffff-4fff-8fff-ffffffffffff',
        );
      },
    );

    test(
      'clears candidate selections and ignores responses after session change',
      () async {
        final oldResponse = Completer<http.StreamedResponse>();
        final oldStarted = Completer<void>();
        final client = MeetingTestHttpClient((request) async {
          if (request.url.path.endsWith('/meeting-candidates')) {
            oldStarted.complete();
            return oldResponse.future;
          }
          throw StateError('Unexpected request ${request.url}');
        });
        final api = createMeetingTestApi(client);
        addTearDown(api.dispose);
        await signInMeetingTestApi(api);
        final controller = ParticipantPickerController(
          repository: ParticipantCandidateRepository(api),
          sessionScope: api.requireAuthenticatedSessionScope(),
          organizerId: testUserId,
          mode: ParticipantSelectionMode.multiple,
        );
        addTearDown(controller.dispose);

        final oldSearch = controller.searchNow('Al');
        await oldStarted.future;
        await api.signOut();
        await completeRequestAfter(
          oldResponse,
          status: 200,
          body: meetingSuccessEnvelope(
            [
              {
                'id': 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                'displayName': 'Alice',
                'email': 'alice@example.test',
                'organizationalUnitName': null,
              },
            ],
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
        await oldSearch;

        expect(controller.state.candidates, isEmpty);
        expect(controller.state.selected, isEmpty);
        expect(controller.state.phase, CandidateSearchPhase.idle);
      },
    );
  });
}

Future<http.StreamedResponse> _candidatePage({
  required String id,
  required int page,
  required int totalElements,
  required int totalPages,
  required bool hasNext,
}) => meetingApiSuccess(
  [
    {
      'id': id,
      'displayName': 'Bob',
      'email': 'bob@example.test',
      'organizationalUnitName': null,
    },
  ],
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
