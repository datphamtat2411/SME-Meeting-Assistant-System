import 'package:flutter/widgets.dart';
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

/// Reveals a lazily built control inside its owning scrollable, then verifies
/// that the actual gesture target is reachable after layout.
Future<void> revealScrollableControl(
  WidgetTester tester,
  Finder target, {
  required Finder scrollable,
  required double delta,
}) async {
  await tester.scrollUntilVisible(target, delta, scrollable: scrollable);
  await tester.pump();
  expect(target, findsOneWidget);
  await Scrollable.ensureVisible(tester.element(target), alignment: 0.5);
  await tester.pump();
  expect(target.hitTestable(), findsOneWidget);
}
