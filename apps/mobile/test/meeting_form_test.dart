import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sme_meeting_assistant/core/app_dependencies.dart';
import 'package:sme_meeting_assistant/core/appearance_preferences.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_form.dart';

import 'support/meeting_test_support.dart';

void main() {
  testWidgets(
    'creation uses typed intent and preserves nullable schedule semantics',
    (tester) async {
      late MeetingTestHttpClient client;
      client = MeetingTestHttpClient((request) async {
        expect(request.method, 'POST');
        expect(request.url.path, '/api/v1/meetings');
        expect(decodeRequestBody(request), {
          'title': 'Planning review',
          'description': null,
          'scheduledStartAt': null,
          'scheduledEndAt': null,
          'roomId': null,
          'participantUserIds': <String>[],
        });
        expect(request.headers['idempotency-key'], startsWith('mobile-'));
        return meetingApiSuccess(
          meetingTestJson(
            status: 'DRAFT',
            title: 'Planning review',
            scheduledStartAt: null,
            scheduledEndAt: null,
          ),
          status: 201,
          headers: const {'etag': '"meeting-create-v1"'},
        );
      });
      final api = createMeetingTestApi(client);
      await signInMeetingTestApi(api);
      final dependencies = AppDependencies(
        api: api,
        appearancePreferences: InMemoryAppearancePreferences(),
        httpClient: client,
      );
      addTearDown(dependencies.dispose);

      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () => Navigator.push<void>(
                  context,
                  MaterialPageRoute<void>(
                    builder: (_) =>
                        Scaffold(body: MeetingForm(dependencies: dependencies)),
                  ),
                ),
                child: const Text('Open form'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open form'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byType(TextFormField).first,
        'Planning review',
      );
      await tester.tap(find.byType(SwitchListTile));
      await tester.pumpAndSettle();
      await tester.ensureVisible(
        find.widgetWithText(FilledButton, 'Tạo cuộc họp'),
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Tạo cuộc họp'));
      await tester.pumpAndSettle();

      expect(
        client.requests.where(
          (request) =>
              request.method == 'POST' &&
              request.url.path.endsWith('/meetings'),
        ),
        hasLength(1),
      );
    },
  );
}
