import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'api_transport.dart';

class SignedUploadResponse {
  SignedUploadResponse({
    required this.statusCode,
    required Map<String, String> headers,
  }) : headers = Map<String, String>.unmodifiable(headers);

  final int statusCode;
  final Map<String, String> headers;
}

/// HTTP transport for short-lived object-storage upload capabilities.
///
/// This transport deliberately has no access to authentication state and only
/// creates the upload-specific headers required by the signed URL contract.
/// The injected client is shared with [CoreApiTransport] and is never closed
/// here.
class SignedUploadTransport {
  SignedUploadTransport({
    required this.httpClient,
    this.timeout = const Duration(minutes: 10),
    this.androidDebugOverride,
  });

  final http.Client httpClient;
  final Duration timeout;

  /// Test-only platform input. Production callers should leave this null so
  /// local HTTP is limited to Android debug builds.
  final bool? androidDebugOverride;

  Future<SignedUploadResponse> upload(
    String signedUrl,
    File file,
    String contentType, {
    void Function(int sent, int total)? onProgress,
  }) async {
    final uri = _parseAndValidateUrl(signedUrl);
    if (contentType.trim().isEmpty) {
      throw TransportFailure(
        0,
        'INVALID_UPLOAD',
        'Upload content type is required.',
      );
    }

    final int length;
    try {
      length = await file.length();
    } on Exception {
      throw TransportFailure(
        0,
        'UPLOAD_FILE_ERROR',
        'The selected file could not be read.',
      );
    }

    final request = http.StreamedRequest('PUT', uri)
      ..followRedirects = false
      ..contentLength = length
      ..headers['Content-Type'] = contentType;

    var requestClosed = false;
    try {
      final responseFuture = httpClient.send(request);
      var sent = 0;
      await request.sink
          .addStream(
            file.openRead().map((chunk) {
              sent += chunk.length;
              onProgress?.call(sent, length);
              return chunk;
            }),
          )
          .timeout(timeout);
      await request.sink.close().timeout(timeout);
      requestClosed = true;

      final response = await responseFuture.timeout(timeout);
      final responseHeaders = Map<String, String>.from(response.headers);
      await response.stream.drain<void>().timeout(timeout);

      if (response.statusCode >= 300 && response.statusCode < 400) {
        throw TransportFailure(
          response.statusCode,
          'UNEXPECTED_REDIRECT',
          'Upload attempted an unexpected redirect.',
          responseHeaders: responseHeaders,
        );
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw TransportFailure(
          response.statusCode,
          'UPLOAD_FAILED',
          'Audio upload failed.',
          responseHeaders: responseHeaders,
        );
      }
      return SignedUploadResponse(
        statusCode: response.statusCode,
        headers: responseHeaders,
      );
    } on TransportFailure {
      rethrow;
    } on TimeoutException {
      throw TransportFailure(
        0,
        'UPLOAD_TIMEOUT',
        'Audio upload timed out. Try again.',
      );
    } on HandshakeException {
      throw TransportFailure(
        0,
        'UPLOAD_TLS_ERROR',
        'A secure upload connection could not be established.',
      );
    } on SocketException {
      throw TransportFailure(
        0,
        'UPLOAD_NETWORK_ERROR',
        'Audio upload connection lost.',
      );
    } on http.ClientException {
      throw TransportFailure(
        0,
        'UPLOAD_NETWORK_ERROR',
        'Audio upload connection failed.',
      );
    } on IOException {
      throw TransportFailure(
        0,
        'UPLOAD_NETWORK_ERROR',
        'Audio upload connection failed.',
      );
    } on Exception {
      throw TransportFailure(0, 'UPLOAD_NETWORK_ERROR', 'Audio upload failed.');
    } finally {
      if (!requestClosed) {
        try {
          await request.sink.close();
        } on Exception {
          // The shared client remains owned by the composition root. Closing
          // the request sink is the only cleanup available to this transport.
        }
      }
    }
  }

  Uri _parseAndValidateUrl(String signedUrl) {
    Uri? uri;
    try {
      if (signedUrl.isEmpty || signedUrl.trim() != signedUrl)
        return _invalidUrl();
      uri = Uri.parse(signedUrl);
    } on FormatException {
      return _invalidUrl();
    }

    final scheme = uri.scheme.toLowerCase();
    final https = scheme == 'https';
    final localHttp =
        scheme == 'http' &&
        _isAndroidDebug &&
        _isLocalDevelopmentHost(uri.host);
    if (!uri.isAbsolute ||
        !uri.hasAuthority ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty ||
        uri.hasFragment ||
        (!https && !localHttp)) {
      return _invalidUrl();
    }
    return uri;
  }

  Uri _invalidUrl() {
    throw TransportFailure(0, 'INSECURE_UPLOAD', 'Upload URL must use HTTPS.');
  }

  bool get _isAndroidDebug =>
      kDebugMode && (androidDebugOverride ?? Platform.isAndroid);

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
