import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_foundation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_scheduling_widgets.dart';

void main() {
  testWidgets('Vietnamese schedule pickers preserve an unchanged interval', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(390, 844);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPhysicalSize);
    final start = DateTime(2026, 11, 27, 9);
    final end = DateTime(2026, 11, 27, 10);
    final draft = MeetingScheduleDraft(start: start, end: end);
    var changes = 0;
    await tester.pumpWidget(
      MaterialApp(
        locale: const Locale('vi', 'VN'),
        supportedLocales: const [Locale('vi', 'VN')],
        localizationsDelegates: GlobalMaterialLocalizations.delegates,
        home: Scaffold(
          body: MeetingScheduleFields(
            draft: draft,
            onDraftChanged: (_) => changes++,
          ),
        ),
      ),
    );
    await tester.tap(find.textContaining('Bắt đầu ·'));
    await tester.pumpAndSettle();
    final dateDialog = find.byType(DatePickerDialog);
    expect(dateDialog, findsOneWidget);
    final context = tester.element(dateDialog);
    expect(Localizations.localeOf(context).languageCode, 'vi');
    final labels = MaterialLocalizations.of(context);
    expect(labels.cancelButtonLabel.toLowerCase(), anyOf('hủy', 'huỷ'));
    await tester.tap(find.text(labels.okButtonLabel));
    await tester.pumpAndSettle();
    expect(find.byType(TimePickerDialog), findsOneWidget);
    await tester.tap(find.text(labels.cancelButtonLabel));
    await tester.pumpAndSettle();
    expect(changes, 0);
    expect(find.textContaining('Bắt đầu ·'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('schedule fields allow an explicitly unscheduled meeting', (
    tester,
  ) async {
    MeetingInterval? interval;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: StatefulBuilder(
            builder: (context, setState) => MeetingScheduleFields(
              interval: interval,
              onChanged: (value) => setState(() => interval = value),
            ),
          ),
        ),
      ),
    );

    expect(find.text('Đặt thời gian cuộc họp'), findsOneWidget);
    expect(find.text('Có thể để lịch chưa xác định.'), findsOneWidget);
    expect(find.textContaining('Bắt đầu ·'), findsNothing);

    await tester.tap(find.byType(SwitchListTile));
    await tester.pumpAndSettle();

    expect(interval, isNotNull);
    expect(find.textContaining('Bắt đầu ·'), findsOneWidget);
    expect(find.textContaining('Kết thúc ·'), findsOneWidget);

    await tester.tap(find.byType(SwitchListTile));
    await tester.pumpAndSettle();

    expect(interval, isNull);
    expect(find.textContaining('Bắt đầu ·'), findsNothing);
  });
}
