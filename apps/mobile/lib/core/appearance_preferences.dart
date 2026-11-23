import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

abstract interface class AppearancePreferences {
  Future<ThemeMode?> loadThemeMode();

  Future<void> saveThemeMode(ThemeMode mode);
}

class SharedPreferencesAppearancePreferences implements AppearancePreferences {
  final String key;
  Future<SharedPreferences>? _preferences;

  SharedPreferencesAppearancePreferences({this.key = 'theme'});

  Future<SharedPreferences> get _store =>
      _preferences ??= SharedPreferences.getInstance();

  @override
  Future<ThemeMode?> loadThemeMode() async {
    final value = (await _store).getString(key);
    return _modeFromName(value);
  }

  @override
  Future<void> saveThemeMode(ThemeMode mode) async {
    await (await _store).setString(key, mode.name);
  }

  static ThemeMode? _modeFromName(String? value) => switch (value) {
    'dark' => ThemeMode.dark,
    'light' => ThemeMode.light,
    'system' => ThemeMode.system,
    _ => null,
  };
}

class InMemoryAppearancePreferences implements AppearancePreferences {
  ThemeMode? mode;

  InMemoryAppearancePreferences({ThemeMode? initialMode}) : mode = initialMode;

  @override
  Future<ThemeMode?> loadThemeMode() async => mode;

  @override
  Future<void> saveThemeMode(ThemeMode mode) async {
    this.mode = mode;
  }
}
