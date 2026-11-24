import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sme_meeting_assistant/core/app_dependencies.dart';
import 'package:sme_meeting_assistant/core/appearance_preferences.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_edit_sheet.dart';

import 'support/meeting_test_support.dart';

void main() {
  testWidgets(
    'editing sheet keeps invalid and equal intervals visible without dispatching',
    (tester) async {
      var previewCalls = 0;
      final scheduledStart = DateTime(2026, 11, 24, 9);
      final scheduledEnd = DateTime(2026, 11, 24, 10);
      final client = MeetingTestHttpClient((request) async {
        if (request.method == 'GET') {
          return meetingApiSuccess(
            meetingTestJson(
              status: 'SCHEDULED',
              scheduledStartAt: scheduledStart.toUtc().toIso8601String(),
              scheduledEndAt: scheduledEnd.toUtc().toIso8601String(),
            ),
            headers: const {'etag': '"edit-widget-v1"'},
          );
        }
        if (request.method == 'POST' &&
            request.url.path.endsWith('/meeting-schedule-checks')) {
          previewCalls++;
          return meetingApiSuccess({
            'previewOnly': true,
            'canSchedule': true,
            'roomConflict': false,
            'room': null,
            'warnings': <dynamic>[],
          });
        }
        if (request.method == 'PATCH') {
          throw StateError('PATCH must remain disabled for invalid input.');
        }
        throw StateError('Unexpected request ${request.method} ${request.url}');
      });
      final api = createMeetingTestApi(client);
      await signInMeetingTestApi(api);
      final dependencies = AppDependencies(
        api: api,
        appearancePreferences: InMemoryAppearancePreferences(),
        httpClient: client,
      );
      addTearDown(dependencies.dispose);
      final snapshot = await dependencies.meetings.detail(testMeetingId);

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: MeetingEditSheet(
              dependencies: dependencies,
              snapshot: snapshot,
            ),
          ),
        ),
      );
      await tester.pump();

      Future<void> chooseStartHour(int hour) async {
        await tester.tap(find.textContaining('Bắt đầu ·'));
        await tester.pumpAndSettle();
        final date = find.text('24');
        expect(date, findsWidgets);
        await tester.tap(date.last);
        await tester.tap(find.text('OK').last);
        await tester.pumpAndSettle();
        final am = find.text('AM');
        if (am.evaluate().isNotEmpty) {
          await tester.tap(am.last);
          await tester.pump();
        }
        expect(find.byType(TimePickerDialog), findsOneWidget);
        final dialCandidates = find
            .descendant(
              of: find.byType(TimePickerDialog),
              matching: find.byType(CustomPaint),
            )
            .evaluate();
        final dialElement = dialCandidates.firstWhere((element) {
          final renderObject = element.renderObject;
          if (renderObject is! RenderBox) return false;
          final size = renderObject.size;
          return size.width >= 240 &&
              size.width <= 300 &&
              size.height >= 240 &&
              size.height <= 320;
        });
        final dial = find.byElementPredicate(
          (element) => identical(element, dialElement),
        );
        final bounds = tester.getRect(dial);
        final angle = (hour % 12) * math.pi / 6;
        final center = bounds.center;
        final radius = bounds.shortestSide * 0.36;
        await tester.tapAt(
          Offset(
            center.dx + math.sin(angle) * radius,
            center.dy - math.cos(angle) * radius,
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.text('OK'));
        await tester.pumpAndSettle();
      }

      await chooseStartHour(11);
      expect(tester.takeException(), isNull);
      expect(
        find.text('Thời gian kết thúc phải sau thời gian bắt đầu.'),
        findsOneWidget,
      );
      expect(
        find.textContaining('Bắt đầu · 24/11/2026 · 11:00'),
        findsOneWidget,
      );
      expect(
        find.textContaining('Kết thúc · 24/11/2026 · 10:00'),
        findsOneWidget,
      );
      final save = tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, 'Lưu thay đổi'),
      );
      expect(save.onPressed, isNull);
      expect(previewCalls, 0);
      expect(
        client.requests.where((request) => request.method == 'PATCH'),
        isEmpty,
      );

      await chooseStartHour(10);
      expect(tester.takeException(), isNull);
      expect(
        find.text('Thời gian kết thúc phải sau thời gian bắt đầu.'),
        findsOneWidget,
      );
      expect(
        find.textContaining('Bắt đầu · 24/11/2026 · 10:00'),
        findsOneWidget,
      );
      expect(
        find.textContaining('Kết thúc · 24/11/2026 · 10:00'),
        findsOneWidget,
      );

      await chooseStartHour(8);
      expect(tester.takeException(), isNull);
      expect(
        find.text('Thời gian kết thúc phải sau thời gian bắt đầu.'),
        findsNothing,
      );
      expect(
        find.textContaining('Bắt đầu · 24/11/2026 · 08:00'),
        findsOneWidget,
      );
      expect(
        find.textContaining('Kết thúc · 24/11/2026 · 10:00'),
        findsOneWidget,
      );
      final readySave = tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, 'Lưu thay đổi'),
      );
      expect(readySave.onPressed, isNotNull);
      expect(previewCalls, 0);
      expect(
        client.requests.where((request) => request.method == 'PATCH'),
        isEmpty,
      );
    },
  );
}
