import 'package:flutter_test/flutter_test.dart';
import 'package:sme_meeting_assistant/core/app_config.dart';

void main() {
  group('AppConfig', () {
    test('normalizes the expected trailing slash', () {
      final uri = AppConfig.validateApiBaseUrl(
        'https://api.example.test/api/v1/',
        buildMode: AppBuildMode.release,
      );

      expect(uri.toString(), 'https://api.example.test/api/v1');
    });

    test('accepts HTTPS in every build mode', () {
      for (final mode in AppBuildMode.values) {
        expect(
          AppConfig.validateApiBaseUrl(
            'https://api.example.test/api/v1',
            buildMode: mode,
          ),
          Uri.parse('https://api.example.test/api/v1'),
        );
      }
    });

    test('accepts explicitly local HTTP endpoints in debug mode', () {
      for (final host in [
        'localhost',
        '127.0.0.1',
        '::1',
        '10.0.2.2',
        '192.168.1.20',
        '172.20.0.10',
      ]) {
        final value = host.contains(':')
            ? 'http://[$host]:8080/api/v1'
            : 'http://$host:8080/api/v1';
        expect(
          AppConfig.validateApiBaseUrl(value, buildMode: AppBuildMode.debug),
          isA<Uri>(),
        );
      }
    });

    test('rejects HTTP outside debug mode', () {
      for (final mode in [AppBuildMode.profile, AppBuildMode.release]) {
        expect(
          () => AppConfig.validateApiBaseUrl(
            'http://10.0.2.2:8080/api/v1',
            buildMode: mode,
          ),
          throwsA(isA<AppConfigException>()),
        );
      }
    });

    test('rejects public HTTP endpoints in debug mode', () {
      expect(
        () => AppConfig.validateApiBaseUrl(
          'http://api.example.test/api/v1',
          buildMode: AppBuildMode.debug,
        ),
        throwsA(isA<AppConfigException>()),
      );
    });

    test('rejects a missing value', () {
      expect(
        () => AppConfig.validateApiBaseUrl('', buildMode: AppBuildMode.debug),
        throwsA(isA<AppConfigException>()),
      );
    });

    test('rejects invalid URL combinations', () {
      for (final value in [
        'not a URL',
        'ftp://api.example.test/api/v1',
        'https:///api/v1',
        'https://user:password@api.example.test/api/v1',
        'https://api.example.test/api/v1?tenant=secret',
        'https://api.example.test/api/v1#fragment',
        'https://api.example.test/',
        'https://api.example.test/api/v2',
        'https://api.example.test/api/v1/extra',
      ]) {
        expect(
          () => AppConfig.validateApiBaseUrl(
            value,
            buildMode: AppBuildMode.release,
          ),
          throwsA(isA<AppConfigException>()),
          reason: value,
        );
      }
    });

    test('resolve uses the supplied value instead of an implicit fallback', () {
      expect(
        AppConfig.resolve(
          rawValue: 'https://api.example.test/api/v1',
          buildMode: AppBuildMode.debug,
        ),
        Uri.parse('https://api.example.test/api/v1'),
      );
    });
  });
}
