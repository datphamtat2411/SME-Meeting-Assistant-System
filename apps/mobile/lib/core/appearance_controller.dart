import 'package:flutter/material.dart';

import 'appearance_preferences.dart';

enum AppearancePersistenceStatus { idle, restoring, restoreFailed, saving, saved, failed }

class AppearanceController extends ChangeNotifier {
  final AppearancePreferences preferences;
  ThemeMode _mode = ThemeMode.system;
  AppearancePersistenceStatus _status = AppearancePersistenceStatus.idle;
  bool _loadStarted = false;
  bool _selectionChanged = false;
  bool _disposed = false;
  int _revision = 0;
  Future<void>? _writer;

  AppearanceController({required this.preferences});

  ThemeMode get mode => _mode;
  AppearancePersistenceStatus get persistenceStatus => _status;

  void initialize() {
    if (_loadStarted || _disposed) return;
    _loadStarted = true;
    _status = AppearancePersistenceStatus.restoring;
    _load();
  }

  Future<void> _load() async {
    try {
      final loaded = await preferences.loadThemeMode();
      if (_disposed || _selectionChanged) return;
      _mode = loaded ?? ThemeMode.system;
      _status = AppearancePersistenceStatus.idle;
      notifyListeners();
    } catch (_) {
      if (_disposed || _selectionChanged) return;
      _status = AppearancePersistenceStatus.restoreFailed;
      notifyListeners();
    }
  }

  Future<void> setMode(ThemeMode next) {
    if (_disposed) return Future<void>.value();
    _selectionChanged = true;
    _mode = next;
    _revision++;
    _status = AppearancePersistenceStatus.saving;
    // Install the drain before notifying listeners, including reentrant ones.
    final writer = _writer ??= Future<void>.microtask(_persist);
    notifyListeners();
    return writer;
  }

  Future<void> retryPersistence() {
    if (_disposed) return Future<void>.value();
    if (_status == AppearancePersistenceStatus.restoreFailed) {
      _status = AppearancePersistenceStatus.restoring;
      notifyListeners();
      return _load();
    }
    return setMode(_mode);
  }

  Future<void> _persist() async {
    while (!_disposed) {
      final revision = _revision;
      final selected = _mode;
      var saved = false;
      try {
        await preferences.saveThemeMode(selected);
        saved = true;
      } catch (_) {
        // Keep the selected theme active; report the failed durable write.
      }
      if (_disposed) break;
      if (revision != _revision) continue;
      _writer = null;
      _status = saved
          ? AppearancePersistenceStatus.saved
          : AppearancePersistenceStatus.failed;
      notifyListeners();
      return;
    }
    _writer = null;
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
