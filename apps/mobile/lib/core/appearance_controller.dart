import 'package:flutter/material.dart';

import 'appearance_preferences.dart';

class AppearanceController extends ChangeNotifier {
  final AppearancePreferences preferences;
  ThemeMode mode = ThemeMode.system;
  bool _loadStarted = false;
  bool _selectionChanged = false;
  bool _disposed = false;

  AppearanceController({required this.preferences});

  void initialize() {
    if (_loadStarted) return;
    _loadStarted = true;
    _load();
  }

  Future<void> _load() async {
    try {
      final loaded = await preferences.loadThemeMode();
      if (_disposed || _selectionChanged) return;
      mode = loaded ?? ThemeMode.system;
      notifyListeners();
    } catch (_) {
      // System appearance is a safe fallback when local preferences fail.
    }
  }

  Future<void> setMode(ThemeMode next) async {
    if (_disposed) return;
    _selectionChanged = true;
    mode = next;
    notifyListeners();
    try {
      await preferences.saveThemeMode(next);
    } catch (_) {
      // A local preference failure must not affect authentication or startup.
    }
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
