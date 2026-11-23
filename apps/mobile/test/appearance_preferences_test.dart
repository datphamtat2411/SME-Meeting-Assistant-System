import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sme_meeting_assistant/core/appearance_preferences.dart';

void main() {
  test(
    'in-memory appearance preferences load and save theme selection',
    () async {
      final preferences = InMemoryAppearancePreferences(
        initialMode: ThemeMode.dark,
      );

      expect(await preferences.loadThemeMode(), ThemeMode.dark);

      await preferences.saveThemeMode(ThemeMode.light);

      expect(await preferences.loadThemeMode(), ThemeMode.light);
    },
  );
}
