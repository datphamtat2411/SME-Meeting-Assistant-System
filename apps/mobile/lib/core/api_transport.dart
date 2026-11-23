import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

/// A response that has not been interpreted as a Common API Response envelope.
///
/// The API service owns decoding and business-level classification. Keeping the
/// raw status, headers, and bytes here also means an error response is not
/// accidentally lost before that layer can inspect it.
class CoreApiResponse {
  CoreApiResponse({
    required this.statusCode,
    required Map<String, String> headers,
    required List<int> bodyBytes,
  }) : headers = Map<String, String>.unmodifiable(headers),
       bodyBytes = Uint8List.fromList(bodyBytes);

  final int statusCode;
  final Map<String, String> headers;
  final Uint8List bodyBytes;
}

/// A safe, stable description of a failure at the HTTP transport boundary.
///
/// Exception details, URLs, request bodies, and credentials are deliberately
/// not included in [message].
class TransportFailure implements Exception {
  TransportFailure(
    this.status,
    this.code,
    this.message, {
    Map<String, String> responseHeaders = const <String, String>{},
    List<int>? responseBodyBytes,
  }) : responseHeaders = Map<String, String>.unmodifiable(responseHeaders),
       responseBodyBytes = responseBodyBytes == null
           ? null
           : Uint8List.fromList(responseBodyBytes);

  final int status;
  final String code;
  final String message;
  final Map<String, String> responseHeaders;
  final Uint8List? responseBodyBytes;

  @override
  String toString() => message;
}

/// The only Core API operations that may use the public authentication policy.
///
/// The endpoint and HTTP method are selected by the transport, rather than
/// accepting an arbitrary path or a caller-controlled authentication bypass.
enum PublicAuthenticationOperation {
  passwordRecovery('/auth/password-recovery'),
  passwordReset('/auth/password-reset'),
  accountSetup('/auth/account-setup');

  const PublicAuthenticationOperation(this.path);

  final String path;
}

/// HTTP transport for requests whose destination is the configured Core API.
///
/// This class owns request construction and network failure normalization only.
/// It never reads credentials, parses API envelopes, retries requests, or
/// closes the injected [http.Client].
class CoreApiTransport {
  CoreApiTransport({
    required this.baseUri,
    required this.httpClient,
    this.dispatchTimeout = const Duration(seconds: 25),
    this.responseTimeout = const Duration(seconds: 45),
  }) {
    _validateBaseUri(baseUri);
  }

  final Uri baseUri;
  final http.Client httpClient;
  final Duration dispatchTimeout;
  final Duration responseTimeout;

  static const Set<String> _reservedHeaders = <String>{
    'accept',
    'authorization',
    'cookie',
    'content-length',
    'content-type',
    'host',
    'proxy-authorization',
    'transfer-encoding',
    'x-auth-transport',
  };

  Future<CoreApiResponse> send(
    String method,
    String endpointPath, {
    Map<String, String>? query,
    Object? body,
    Map<String, String>? headers,
    String? authorization,
  }) => _send(
    method,
    endpointPath,
    query: query,
    body: body,
    headers: headers,
    authorization: authorization,
    includeAuthTransport: true,
  );

  /// Sends one allowlisted, state-changing public auth operation.
  ///
  /// It intentionally accepts neither a path, authorization value, nor
  /// caller-supplied headers. Public auth requests do not carry the mobile auth
  /// transport marker because these endpoints do not require it.
  Future<CoreApiResponse> sendPublicAuthentication(
    PublicAuthenticationOperation operation, {
    required Object body,
  }) => _send('POST', operation.path, body: body, includeAuthTransport: false);

  Future<CoreApiResponse> _send(
    String method,
    String endpointPath, {
    Map<String, String>? query,
    Object? body,
    Map<String, String>? headers,
    String? authorization,
    required bool includeAuthTransport,
  }) async {
    final uri = _buildUri(endpointPath, query);
    final requestHeaders = _buildHeaders(
      body: body,
      headers: headers,
      authorization: authorization,
      includeAuthTransport: includeAuthTransport,
    );
    final request = _buildRequest(method, uri, requestHeaders, body);

    try {
      final streamed = await httpClient.send(request).timeout(dispatchTimeout);
      final bodyBytes = await streamed.stream.toBytes().timeout(
        responseTimeout,
      );
      final response = CoreApiResponse(
        statusCode: streamed.statusCode,
        headers: streamed.headers,
        bodyBytes: bodyBytes,
      );

      if (response.statusCode >= 300 && response.statusCode < 400) {
        throw TransportFailure(
          response.statusCode,
          'UNEXPECTED_REDIRECT',
          'API attempted an unexpected redirect.',
          responseHeaders: response.headers,
          responseBodyBytes: response.bodyBytes,
        );
      }
      return response;
    } on TransportFailure {
      rethrow;
    } on TimeoutException {
      throw TransportFailure(
        0,
        'NETWORK_TIMEOUT',
        'Request timed out. Try again.',
      );
    } on HandshakeException {
      throw TransportFailure(
        0,
        'TLS_ERROR',
        'A secure connection to Core API could not be established.',
      );
    } on SocketException {
      throw TransportFailure(
        0,
        'NETWORK_UNAVAILABLE',
        'Cannot reach Core API.',
      );
    } on http.ClientException {
      throw TransportFailure(0, 'NETWORK_ERROR', 'Network request failed.');
    } on IOException {
      throw TransportFailure(0, 'NETWORK_ERROR', 'Network request failed.');
    } on Exception {
      throw TransportFailure(0, 'NETWORK_ERROR', 'Network request failed.');
    }
  }

  Uri _buildUri(String endpointPath, Map<String, String>? query) {
    if (endpointPath.isEmpty ||
        !endpointPath.startsWith('/') ||
        endpointPath.startsWith('//')) {
      throw TransportFailure(
        0,
        'INVALID_ENDPOINT',
        'The requested API endpoint is invalid.',
      );
    }

    final parsed = Uri.tryParse(endpointPath);
    if (parsed == null ||
        parsed.hasScheme ||
        parsed.hasAuthority ||
        parsed.hasQuery ||
        parsed.hasFragment ||
        endpointPath.contains('\\') ||
        _containsTraversal(endpointPath)) {
      throw TransportFailure(
        0,
        'INVALID_ENDPOINT',
        'The requested API endpoint is invalid.',
      );
    }

    final basePath = baseUri.path.replaceFirst(RegExp(r'/$'), '');
    final uri = baseUri.replace(
      path: '$basePath$endpointPath',
      queryParameters: query == null || query.isEmpty ? null : query,
    );
    if (!_isUnderBasePath(uri.path)) {
      throw TransportFailure(
        0,
        'INVALID_ENDPOINT',
        'The requested API endpoint is invalid.',
      );
    }
    return uri;
  }

  Map<String, String> _buildHeaders({
    required Object? body,
    required Map<String, String>? headers,
    required String? authorization,
    required bool includeAuthTransport,
  }) {
    final result = <String, String>{
      'Accept': 'application/json',
      if (includeAuthTransport) 'X-Auth-Transport': 'mobile',
      if (body != null) 'Content-Type': 'application/json',
      if (authorization != null) 'Authorization': authorization,
    };
    final seen = <String>{};
    for (final entry in (headers ?? const <String, String>{}).entries) {
      final name = entry.key.toLowerCase();
      if (!seen.add(name) || _reservedHeaders.contains(name)) {
        throw TransportFailure(
          0,
          'INVALID_REQUEST_HEADERS',
          'The request contains a protected header.',
        );
      }
      result[entry.key] = entry.value;
    }
    return result;
  }

  http.Request _buildRequest(
    String method,
    Uri uri,
    Map<String, String> headers,
    Object? body,
  ) {
    try {
      final request = http.Request(method.toUpperCase(), uri)
        ..followRedirects = false
        ..headers.addAll(headers);
      if (body != null) {
        request.bodyBytes = utf8.encode(jsonEncode(body));
      }
      return request;
    } on JsonUnsupportedObjectError {
      throw TransportFailure(
        0,
        'INVALID_REQUEST_BODY',
        'The request body could not be encoded.',
      );
    } on ArgumentError {
      throw TransportFailure(
        0,
        'INVALID_REQUEST',
        'The request could not be constructed.',
      );
    }
  }

  bool _isUnderBasePath(String path) {
    final basePath = baseUri.path.replaceFirst(RegExp(r'/$'), '');
    if (basePath.isEmpty) return path.startsWith('/');
    return path == basePath || path.startsWith('$basePath/');
  }

  static bool _containsTraversal(String path) {
    for (final segment in path.split('/')) {
      try {
        final decoded = Uri.decodeComponent(segment);
        if (decoded == '.' || decoded == '..') return true;
      } on FormatException {
        return true;
      }
    }
    return false;
  }

  static void _validateBaseUri(Uri uri) {
    final scheme = uri.scheme.toLowerCase();
    if (!uri.isAbsolute ||
        !uri.hasAuthority ||
        uri.host.isEmpty ||
        (scheme != 'http' && scheme != 'https') ||
        uri.userInfo.isNotEmpty ||
        uri.hasQuery ||
        uri.hasFragment) {
      throw ArgumentError.value(uri, 'baseUri', 'Invalid Core API base URI.');
    }
  }
}
