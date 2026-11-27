import 'dart:io';

import 'package:flutter/foundation.dart';

enum AppBuildMode { debug, profile, release }

class AppConfigException implements Exception {
  final String message;
  final String presentationMessage;

  const AppConfigException(this.message, {String? presentationMessage})
    : presentationMessage = presentationMessage ?? message;

  @override
  String toString() => message;
}

abstract final class AppConfig {
  /// The value is deliberately empty when the build does not provide it.
  ///
  /// API_BASE_URL is deployment configuration, not a credential. Secrets must
  /// never be passed through Dart defines.
  static const String apiUrl = String.fromEnvironment('API_BASE_URL');

  static AppBuildMode get currentBuildMode {
    if (kReleaseMode) return AppBuildMode.release;
    if (kProfileMode) return AppBuildMode.profile;
    return AppBuildMode.debug;
  }

  static String readApiBaseUrl() => apiUrl;

  static Uri resolve({String? rawValue, AppBuildMode? buildMode}) =>
      validateApiBaseUrl(
        rawValue ?? readApiBaseUrl(),
        buildMode: buildMode ?? currentBuildMode,
      );

  static Uri validateApiBaseUrl(String rawValue, {AppBuildMode? buildMode}) {
    final value = rawValue.trim();
    if (value.isEmpty) {
      throw const AppConfigException(
        'API_BASE_URL is required. Configure an absolute API URL ending in '
        '/api/v1 before starting the app.',
        presentationMessage:
            'Chưa cấu hình API_BASE_URL. Cần địa chỉ API tuyệt đối kết thúc bằng /api/v1.',
      );
    }

    final uri = Uri.tryParse(value);
    final scheme = uri?.scheme.toLowerCase();
    if (uri == null ||
        !uri.isAbsolute ||
        !uri.hasAuthority ||
        uri.host.isEmpty ||
        (scheme != 'http' && scheme != 'https')) {
      throw const AppConfigException(
        'API_BASE_URL must be an absolute HTTP or HTTPS URL with a host.',
        presentationMessage:
            'API_BASE_URL phải là địa chỉ HTTP hoặc HTTPS tuyệt đối có tên máy chủ.',
      );
    }
    if (uri.authority.contains('@')) {
      throw const AppConfigException(
        'API_BASE_URL must not contain embedded user credentials.',
        presentationMessage:
            'API_BASE_URL không được chứa thông tin đăng nhập.',
      );
    }
    if (uri.hasQuery || uri.hasFragment) {
      throw const AppConfigException(
        'API_BASE_URL must not contain a query string or fragment.',
        presentationMessage:
            'API_BASE_URL không được chứa tham số truy vấn hoặc fragment.',
      );
    }

    final normalizedPath = uri.path.replaceFirst(RegExp(r'/+$'), '');
    if (normalizedPath != '/api/v1') {
      throw const AppConfigException(
        'API_BASE_URL must use the /api/v1 Core API base path.',
        presentationMessage:
            'API_BASE_URL phải sử dụng đường dẫn Core API /api/v1.',
      );
    }

    final mode = buildMode ?? currentBuildMode;
    if (scheme == 'http' &&
        (mode != AppBuildMode.debug || !_isLocalDevelopmentHost(uri.host))) {
      throw const AppConfigException(
        'HTTP API_BASE_URL values are limited to local debug development. '
        'Use HTTPS for this build.',
        presentationMessage:
            'HTTP chỉ được phép trong môi trường debug cục bộ. Hãy dùng HTTPS cho bản dựng này.',
      );
    }

    return uri.replace(path: '/api/v1');
  }

  static bool _isLocalDevelopmentHost(String host) {
    final normalizedHost = host.toLowerCase();
    if (normalizedHost == 'localhost' ||
        normalizedHost.endsWith('.localhost')) {
      return true;
    }

    final address = InternetAddress.tryParse(host);
    if (address == null) return false;
    final bytes = address.rawAddress;

    if (address.type == InternetAddressType.IPv4 && bytes.length == 4) {
      final first = bytes[0];
      final second = bytes[1];
      return first == 127 ||
          first == 10 ||
          (first == 172 && second >= 16 && second <= 31) ||
          (first == 192 && second == 168) ||
          (first == 169 && second == 254);
    }

    if (address.type == InternetAddressType.IPv6 && bytes.length == 16) {
      final isLoopback =
          bytes.take(15).every((byte) => byte == 0) && bytes.last == 1;
      final isUniqueLocal = (bytes[0] & 0xfe) == 0xfc;
      final isLinkLocal = bytes[0] == 0xfe && (bytes[1] & 0xc0) == 0x80;
      return isLoopback || isUniqueLocal || isLinkLocal;
    }

    return false;
  }
}
