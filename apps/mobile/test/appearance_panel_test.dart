import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sme_meeting_assistant/core/appearance_controller.dart';
import 'package:sme_meeting_assistant/core/appearance_preferences.dart';
import 'package:sme_meeting_assistant/features/profile/appearance_panel.dart';

void main() {
  testWidgets('appearance selection remains usable with large text', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(320, 640);
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final controller = AppearanceController(
      preferences: InMemoryAppearancePreferences(),
    );
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(1.8)),
          child: child!,
        ),
        home: Scaffold(body: AppearancePanel(controller: controller)),
      ),
    );
    expect(
      tester
          .widget<SegmentedButton<ThemeMode>>(
            find.byType(SegmentedButton<ThemeMode>),
          )
          .direction,
      Axis.vertical,
    );
    await tester.tap(find.text('Tối'));
    await tester.pumpAndSettle();
    expect(controller.mode, ThemeMode.dark);
    expect(tester.takeException(), isNull);
  });

  testWidgets('appearance panel reports write failure and retries', (
    tester,
  ) async {
    final preferences = _ControlledPreferences();
    final controller = AppearanceController(preferences: preferences);
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: AppearancePanel(controller: controller)),
      ),
    );
    await tester.tap(find.text('Tối'));
    await tester.pump();
    expect(controller.mode, ThemeMode.dark);
    expect(find.text('Đang lưu giao diện trên thiết bị...'), findsOneWidget);
    preferences.writes.single.completeError(StateError('write failed'));
    await tester.pump();
    expect(controller.mode, ThemeMode.dark);
    expect(find.text('Thử lưu lại'), findsOneWidget);
    await tester.tap(find.text('Thử lưu lại'));
    await tester.pump();
    expect(preferences.modes, [ThemeMode.dark, ThemeMode.dark]);
    preferences.writes.last.complete();
    await tester.pumpAndSettle();
    expect(find.text('Thử lưu lại'), findsNothing);
    expect(controller.persistenceStatus, AppearancePersistenceStatus.saved);
    expect(controller.mode, ThemeMode.dark);
  });

  testWidgets('appearance panel retries restore without writing', (
    tester,
  ) async {
    final preferences = _ControlledPreferences()..failRestore = true;
    final controller = AppearanceController(preferences: preferences);
    addTearDown(controller.dispose);
    controller.initialize();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: AppearancePanel(controller: controller)),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Thử tải lại'), findsOneWidget);
    expect(controller.mode, ThemeMode.system);
    preferences.failRestore = false;
    await tester.tap(find.text('Thử tải lại'));
    await tester.pumpAndSettle();
    expect(controller.mode, ThemeMode.light);
    expect(find.text('Thử tải lại'), findsNothing);
    expect(preferences.writes, isEmpty);
  });
}

class _ControlledPreferences implements AppearancePreferences {
  bool failRestore = false;
  final modes = <ThemeMode>[];
  final writes = <Completer<void>>[];

  @override
  Future<ThemeMode?> loadThemeMode() async {
    if (failRestore) throw StateError('read failed');
    return ThemeMode.light;
  }

  @override
  Future<void> saveThemeMode(ThemeMode mode) {
    modes.add(mode);
    final write = Completer<void>();
    writes.add(write);
    return write.future;
  }
}
