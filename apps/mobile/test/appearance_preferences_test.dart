import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sme_meeting_assistant/core/appearance_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('adapter restores and persists existing theme values', () async {
    SharedPreferences.setMockInitialValues({'theme': 'dark'});
    final preferences = SharedPreferencesAppearancePreferences();
    expect(await preferences.loadThemeMode(), ThemeMode.dark);
    await preferences.saveThemeMode(ThemeMode.light);
    final store = await SharedPreferences.getInstance();
    expect(store.getString('theme'), 'light');
    final recreated = SharedPreferencesAppearancePreferences();
    expect(await recreated.loadThemeMode(), ThemeMode.light);
  });

  test('adapter treats invalid stored values as unset', () async {
    for (final value in <Object>['unexpected', 17]) {
      SharedPreferences.setMockInitialValues({'theme': value});
      final preferences = SharedPreferencesAppearancePreferences();
      expect(await preferences.loadThemeMode(), isNull);
    }
  });

  test('adapter retries failed storage acquisition', () async {
    SharedPreferences.setMockInitialValues({'theme': 'dark'});
    var attempts = 0;
    final preferences = SharedPreferencesAppearancePreferences(
      loadStore: () async {
        if (++attempts == 1) throw StateError('storage unavailable');
        return SharedPreferences.getInstance();
      },
    );
    await expectLater(preferences.loadThemeMode(), throwsStateError);
    expect(await preferences.loadThemeMode(), ThemeMode.dark);
    await preferences.saveThemeMode(ThemeMode.system);
    expect(attempts, 2);
    expect(await preferences.loadThemeMode(), ThemeMode.system);
  });

  test('adapter rejects false storage write results', () async {
    final store = _ControlledStore();
    final preferences = SharedPreferencesAppearancePreferences(
      loadStore: () async => store,
    );
    await expectLater(
      preferences.saveThemeMode(ThemeMode.dark),
      throwsStateError,
    );
    store.allowWrite = true;
    await preferences.saveThemeMode(ThemeMode.dark);
    expect(await preferences.loadThemeMode(), ThemeMode.dark);
  });

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

class _ControlledStore implements SharedPreferences {
  bool allowWrite = false;
  String? value;

  @override
  Object? get(String key) => value;

  @override
  Future<bool> setString(String key, String value) async {
    if (!allowWrite) return false;
    this.value = value;
    return true;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}
