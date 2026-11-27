import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sme_meeting_assistant/core/app_dependencies.dart';
import 'package:sme_meeting_assistant/core/appearance_preferences.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_form.dart';

import 'support/meeting_test_support.dart';
import 'support/widget_test_support.dart';

void main() {
  testWidgets('asks before dismissing a form with unsaved text', (
    tester,
  ) async {
    final client = MeetingTestHttpClient((request) async {
      throw StateError('Unexpected request ${request.method} ${request.url}');
    });
    final api = createMeetingTestApi(client);
    await tester.runAsync(() => signInMeetingTestApi(api));
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
                  builder: (_) => Scaffold(
                    appBar: AppBar(leading: const BackButton()),
                    body: MeetingForm(dependencies: dependencies),
                  ),
                ),
              ),
              child: const Text('Open form'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('Open form'));
    await pumpUntil(tester, () {
      final save = find.widgetWithText(OutlinedButton, 'Lưu bản nháp');
      return save.evaluate().isNotEmpty &&
          tester.widget<OutlinedButton>(save).onPressed != null;
    }, reason: 'the meeting form to become editable');
    await tester.enterText(find.byType(TextFormField).first, 'Unsaved title');
    await tester.pump();
    await tester.tap(find.byType(BackButton));
    await pumpUntil(
      tester,
      () => find.text('Bỏ thay đổi chưa lưu?').evaluate().isNotEmpty,
      reason: 'the unsaved-changes confirmation',
    );

    expect(find.text('Bỏ thay đổi chưa lưu?'), findsOneWidget);
    expect(find.text('Tiếp tục ở lại'), findsOneWidget);
  });

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
      await tester.runAsync(() => signInMeetingTestApi(api));
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
      await pumpUntil(tester, () {
        final save = find.widgetWithText(OutlinedButton, 'Lưu bản nháp');
        return save.evaluate().isNotEmpty &&
            tester.widget<OutlinedButton>(save).onPressed != null;
      }, reason: 'the meeting form to become editable');
      await tester.enterText(
        find.byType(TextFormField).first,
        'Planning review',
      );
      await tester.ensureVisible(
        find.widgetWithText(OutlinedButton, 'Lưu bản nháp'),
      );
      await tester.tap(find.widgetWithText(OutlinedButton, 'Lưu bản nháp'));
      await pumpUntil(
        tester,
        () =>
            find.byType(MeetingForm).evaluate().isEmpty &&
            client.requests.any(
              (request) =>
                  request.method == 'POST' &&
                  request.url.path.endsWith('/meetings'),
            ),
        reason: 'the meeting creation to finish and return to its caller',
      );

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
