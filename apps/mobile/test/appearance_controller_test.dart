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
    controller.dispose();
  });
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
