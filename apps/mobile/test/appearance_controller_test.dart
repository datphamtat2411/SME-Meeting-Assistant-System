import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sme_meeting_assistant/core/appearance_controller.dart';
import 'package:sme_meeting_assistant/core/appearance_preferences.dart';

void main() {
  test('a late preference load cannot overwrite a newer selection', () async {
    final preferences = DelayedAppearancePreferences();
    final controller = AppearanceController(preferences: preferences);

    controller.initialize();
    await controller.setMode(ThemeMode.light);

    preferences.complete(ThemeMode.dark);
    await Future<void>.delayed(Duration.zero);

    expect(controller.mode, ThemeMode.light);
    expect(preferences.savedMode, ThemeMode.light);

    controller.dispose();
  });

  test('a preference load failure keeps the system fallback', () async {
    final controller = AppearanceController(
      preferences: FailingAppearancePreferences(),
    );

    controller.initialize();
    await Future<void>.delayed(Duration.zero);

    expect(controller.mode, ThemeMode.system);
    expect(controller.persistenceStatus, AppearancePersistenceStatus.failed);
    controller.dispose();
  });

  test('serializes writes and persists the latest selection', () async {
    final preferences = ControlledWrites();
    final controller = AppearanceController(preferences: preferences);
    final first = controller.setMode(ThemeMode.dark);
    await Future<void>.delayed(Duration.zero);
    final second = controller.setMode(ThemeMode.light);
    final last = controller.setMode(ThemeMode.system);
    expect(controller.mode, ThemeMode.system);
    expect(preferences.modes, [ThemeMode.dark]);
    preferences.writes.first.complete();
    await Future<void>.delayed(Duration.zero);
    expect(preferences.modes, [ThemeMode.dark, ThemeMode.system]);
    preferences.writes.last.complete();
    await Future.wait([first, second, last]);
    expect(controller.persistenceStatus, AppearancePersistenceStatus.saved);
    controller.dispose();
  });

  test('failed write retains active appearance and permits retry', () async {
    final preferences = ControlledWrites();
    final controller = AppearanceController(preferences: preferences);
    final first = controller.setMode(ThemeMode.dark);
    await Future<void>.delayed(Duration.zero);
    preferences.writes.first.completeError(StateError('storage failed'));
    await first;
    expect(controller.mode, ThemeMode.dark);
    expect(controller.persistenceStatus, AppearancePersistenceStatus.failed);
    final retry = controller.retryPersistence();
    await Future<void>.delayed(Duration.zero);
    preferences.writes.last.complete();
    await retry;
    expect(preferences.modes, [ThemeMode.dark, ThemeMode.dark]);
    expect(controller.persistenceStatus, AppearancePersistenceStatus.saved);
    controller.dispose();
  });
}

class ControlledWrites implements AppearancePreferences {
  final modes = <ThemeMode>[];
  final writes = <Completer<void>>[];

  @override
  Future<ThemeMode?> loadThemeMode() async => null;

  @override
  Future<void> saveThemeMode(ThemeMode mode) {
    modes.add(mode);
    final write = Completer<void>();
    writes.add(write);
    return write.future;
  }
}

class DelayedAppearancePreferences implements AppearancePreferences {
  final Completer<ThemeMode?> _load = Completer<ThemeMode?>();
  ThemeMode? savedMode;

  void complete(ThemeMode mode) => _load.complete(mode);

  @override
  Future<ThemeMode?> loadThemeMode() => _load.future;

  @override
  Future<void> saveThemeMode(ThemeMode mode) async {
    savedMode = mode;
  }
}

class FailingAppearancePreferences implements AppearancePreferences {
  @override
  Future<ThemeMode?> loadThemeMode() =>
      Future<ThemeMode?>.error(StateError('test failure'));

  @override
  Future<void> saveThemeMode(ThemeMode mode) async {}
}
