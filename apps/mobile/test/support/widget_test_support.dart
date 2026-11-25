import 'package:flutter_test/flutter_test.dart';

/// Pumps frames and gives real asynchronous work a chance to complete until
/// [condition] becomes true, without requiring animations to become idle.
Future<void> pumpUntil(
  WidgetTester tester,
  bool Function() condition, {
  required String reason,
  Duration step = const Duration(milliseconds: 50),
  int maxPumps = 40,
}) async {
  for (var pump = 0; pump < maxPumps; pump++) {
    if (condition()) return;
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 1)),
    );
    await tester.pump(step);
  }
  expect(
    condition(),
    isTrue,
    reason: 'Timed out after ${step * maxPumps} while waiting for $reason.',
  );
}
