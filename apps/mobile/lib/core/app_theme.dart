import 'package:flutter/material.dart';

abstract final class Palette {
  static const ink = Color(0xFF172033);
  static const muted = Color(0xFF677489);
  static const border = Color(0xFFE2E8F0);
  static const surface = Color(0xFFF8FAFC);
  static const green = Color(0xFF15803D);
  static const amber = Color(0xFFB45309);
  static const blue = Color(0xFF2563EB);
  static const red = Color(0xFFB42318);
}

abstract final class AppTheme {
  static ThemeData light() => _create(Brightness.light);
  static ThemeData dark() => _create(Brightness.dark);

  static ThemeData _create(Brightness brightness) {
    final dark = brightness == Brightness.dark;
    final scheme = ColorScheme.fromSeed(
      seedColor: const Color(0xFF172033),
      brightness: brightness,
      primary: dark ? const Color(0xFFE2E8F0) : Palette.ink,
      surface: dark ? const Color(0xFF111827) : Colors.white,
    );
    return ThemeData(
      useMaterial3: true,
      brightness: brightness,
      colorScheme: scheme,
      scaffoldBackgroundColor: dark ? const Color(0xFF0C1322) : Palette.surface,
      appBarTheme: AppBarTheme(
        backgroundColor: dark ? const Color(0xFF111827) : Colors.white,
        foregroundColor: scheme.onSurface,
        elevation: 0,
        centerTitle: false,
        surfaceTintColor: Colors.transparent,
      ),
      cardTheme: CardThemeData(
        color: scheme.surface, elevation: 0,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(
          side: BorderSide(color: dark ? const Color(0xFF334155) : Palette.border),
          borderRadius: BorderRadius.circular(14),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: scheme.surface,
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(11)),
        enabledBorder: OutlineInputBorder(
          borderSide: BorderSide(color: dark ? const Color(0xFF475569) : Palette.border),
          borderRadius: BorderRadius.circular(11)),
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          minimumSize: const Size(0, 46),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(11)),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          minimumSize: const Size(0, 44),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(11)),
        ),
      ),
      dividerColor: dark ? const Color(0xFF334155) : Palette.border,
      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: scheme.surface,
        indicatorColor: scheme.primary.withValues(alpha: 0.10),
        height: 72,
      ),
    );
  }
}
