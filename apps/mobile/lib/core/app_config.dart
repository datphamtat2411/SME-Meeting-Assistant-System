import 'package:flutter/foundation.dart';

abstract final class AppConfig {
  static const String apiUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'http://10.0.2.2:8080/api/v1',
  );

  static Uri get baseUri {
    final uri = Uri.tryParse(apiUrl);
    if (uri == null || !uri.hasAuthority || !['http', 'https'].contains(uri.scheme)) {
      throw StateError('API_BASE_URL must be a complete HTTP(S) URL.');
    }
    if (kReleaseMode && uri.scheme != 'https') {
      throw StateError('Release builds require HTTPS API_BASE_URL.');
    }
    return uri;
  }
}
