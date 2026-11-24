import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_foundation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_scheduling_widgets.dart';

void main() {
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
