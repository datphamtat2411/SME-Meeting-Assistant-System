import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'api_response.dart';
import 'api_response_decoder.dart';
import 'api_transport.dart';
import 'credential_storage.dart';
import 'signed_upload_transport.dart';

export 'api_response.dart';
export 'api_transport.dart';
export 'credential_storage.dart';
export 'signed_upload_transport.dart';

Map<String, dynamic> objectOf(dynamic value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) return value.map((key, v) => MapEntry(key.toString(), v));
  return <String, dynamic>{};
}

List<Map<String, dynamic>> objectsOf(dynamic value) {
  if (value is! List) return [];
  return value.map(objectOf).toList(growable: false);
}

/// The Core API owns all business truth. The client handles transport only.
///
/// Access credentials never leave process memory. The refresh credential is
/// rotated on every refresh and persisted in OS-backed secure storage.
class ApiClient extends ChangeNotifier {
  final Uri baseUri;
  final CoreApiTransport _coreTransport;
  final SignedUploadTransport _signedUploadTransport;
  final ApiResponseDecoder _responseDecoder = const ApiResponseDecoder();
  final CredentialStorage _secure;
  String? _accessToken;
  String? _refreshToken;
  DateTime? _accessExpiry;
  Future<void>? _refreshFuture;
  bool _disposed = false;
  bool ready = false;
  String? sessionRestoreError;
  Map<String, dynamic>? identity;

  ApiClient({
    required this.baseUri,
    required http.Client httpClient,
    required CredentialStorage credentialStorage,
    Duration apiDispatchTimeout = const Duration(seconds: 25),
    Duration apiResponseTimeout = const Duration(seconds: 45),
    Duration uploadTimeout = const Duration(minutes: 10),
    bool? androidDebugOverride,
  }) : _coreTransport = CoreApiTransport(
         baseUri: baseUri,
         httpClient: httpClient,
         dispatchTimeout: apiDispatchTimeout,
         responseTimeout: apiResponseTimeout,
       ),
       _signedUploadTransport = SignedUploadTransport(
         httpClient: httpClient,
         timeout: uploadTimeout,
         androidDebugOverride: androidDebugOverride,
       ),
       _secure = credentialStorage;

  bool get hasRecoverableSession =>
      _refreshToken != null && identity == null && sessionRestoreError != null;

  bool get signedIn => _accessToken != null && identity != null;
  String get userId => (identity?['userId'] ?? '').toString();
  String get displayName => (identity?['displayName'] ?? '').toString();
  String get email => (identity?['email'] ?? '').toString();

  Future<void> initialize() async {
    try {
      _refreshToken = await _secure.read(key: 'sme.mobile.refresh');
      if (_refreshToken != null) {
        await _renew();
        await loadIdentity();
      }
      sessionRestoreError = null;
    } on ApiFailure catch (failure) {
      if (_isTemporary(failure)) {
        sessionRestoreError = failure.message;
      } else {
        await _forget();
      }
    } catch (_) {
      await _forget();
    } finally {
      ready = true;
      _notifyListeners();
    }
  }

  bool _isTemporary(ApiFailure failure) =>
      failure.status == 0 || failure.status >= 500;

  Future<void> retrySessionRestore() async {
    if (_refreshToken == null) return;
    ready = false;
    sessionRestoreError = null;
    _notifyListeners();
    try {
      await _renew();
      await loadIdentity();
    } on ApiFailure catch (failure) {
      if (_isTemporary(failure)) {
        sessionRestoreError = failure.message;
      } else {
        await _forget();
      }
    } catch (_) {
      await _forget();
    } finally {
      ready = true;
      _notifyListeners();
    }
  }

  Future<void> discardLocalSession() async {
    await _forget();
    sessionRestoreError = null;
    _notifyListeners();
  }

  Future<void> signIn(String email, String password) async {
    final result = await _request(
      'POST',
      '/auth/login',
      body: {'email': email.trim(), 'password': password},
      auth: false,
    );
    await _adoptTokens(result.objectData(), requestId: result.requestId);
    sessionRestoreError = null;
    try {
      await loadIdentity();
    } catch (_) {
      await _forget();
      rethrow;
    }
  }

  Future<void> loadIdentity() async {
    final result = await get('/auth/me');
    identity = result.objectData();
    if (identity?['userId'] == null) {
      throw const ApiFailure(
        0,
        'INVALID_RESPONSE',
        'Invalid account response.',
      );
    }
    _notifyListeners();
  }

  Future<void> signOut() async {
    try {
      if (_accessToken != null) await post('/auth/logout', const {});
    } finally {
      await _forget();
    }
  }

  Future<void> _forget() async {
    _accessToken = null;
    _refreshToken = null;
    _accessExpiry = null;
    identity = null;
    await _secure.delete(key: 'sme.mobile.refresh');
    _notifyListeners();
  }

  Future<void> _adoptTokens(
    Map<String, dynamic> values, {
    String? requestId,
  }) async {
    final access = values['accessToken'];
    final refresh = values['refreshToken'];
    if (access is! String ||
        access.isEmpty ||
        refresh is! String ||
        refresh.isEmpty) {
      throw ApiFailure(
        0,
        'INVALID_RESPONSE',
        'Invalid mobile token response.',
        requestId: requestId,
      );
    }
    _accessToken = access;
    _refreshToken = refresh;
    final expires = (values['expiresIn'] as num?)?.toInt() ?? 600;
    _accessExpiry = DateTime.now().add(
      Duration(seconds: expires > 60 ? expires - 30 : expires),
    );
    await _secure.write(key: 'sme.mobile.refresh', value: refresh);
  }

  Future<void> _renew() async {
    final token = _refreshToken;
    if (token == null)
      throw const ApiFailure(401, 'AUTH_SESSION_EXPIRED', 'Session expired.');
    try {
      final result = await _request(
        'POST',
        '/auth/refresh',
        auth: false,
        authorization: 'Bearer ' + token,
      );
      await _adoptTokens(result.objectData(), requestId: result.requestId);
    } on ApiFailure catch (failure) {
      // Preserve refresh credentials when transport temporarily disappears.
      // Rejected or replayed credentials must still fail closed.
      if (!_isTemporary(failure)) await _forget();
      rethrow;
    } catch (_) {
      await _forget();
      rethrow;
    }
  }

  Future<void> _refreshOnce() {
    final running = _refreshFuture;
    if (running != null) return running;
    final future = _renew();
    _refreshFuture = future;
    return future.whenComplete(() {
      if (identical(_refreshFuture, future)) _refreshFuture = null;
    });
  }

  Future<ApiResult> get(String path, {Map<String, String>? query}) =>
      _request('GET', path, query: query);

  Future<ApiResult> post(
    String path,
    Map<String, dynamic> body, {
    Map<String, String>? headers,
  }) => _request('POST', path, body: body, headers: headers);

  Future<ApiResult> patch(
    String path,
    Map<String, dynamic> body, {
    Map<String, String>? headers,
  }) => _request('PATCH', path, body: body, headers: headers);

  Future<ApiResult> delete(String path, {Map<String, String>? headers}) =>
      _request('DELETE', path, headers: headers);

  Future<ApiResult> _request(
    String method,
    String path, {
    Map<String, String>? query,
    Map<String, dynamic>? body,
    Map<String, String>? headers,
    bool auth = true,
    String? authorization,
    bool allowRetry = true,
  }) async {
    if (auth &&
        _refreshToken != null &&
        (_accessToken == null ||
            (_accessExpiry != null &&
                DateTime.now().isAfter(_accessExpiry!)))) {
      await _refreshOnce();
    }

    final controlledAuthorization =
        authorization ??
        (auth && _accessToken != null ? 'Bearer ' + _accessToken! : null);
    CoreApiResponse response;
    try {
      response = await _coreTransport.send(
        method,
        path,
        query: query,
        body: body,
        headers: headers,
        authorization: controlledAuthorization,
      );
    } on TransportFailure catch (failure) {
      final requestId = _headerValue(failure.responseHeaders, 'x-request-id');
      throw ApiFailure(
        failure.status,
        failure.code,
        failure.message,
        requestId: requestId,
        responseRequestId: requestId,
        retryAfter: _headerValue(failure.responseHeaders, 'retry-after'),
        headers: failure.responseHeaders,
        isTransportFailure: true,
      );
    }

    if (auth &&
        response.statusCode == 401 &&
        allowRetry &&
        _refreshToken != null) {
      await _refreshOnce();
      if (method.toUpperCase() == 'GET') {
        return _request(
          method,
          path,
          query: query,
          body: body,
          headers: headers,
          allowRetry: false,
        );
      }
    }
    if (auth && response.statusCode == 401 && !allowRetry) {
      try {
        return _responseDecoder.decode(
          statusCode: response.statusCode,
          headers: response.headers,
          bodyBytes: response.bodyBytes,
        );
      } on ApiFailure {
        await _forget();
        rethrow;
      }
    }
    return _responseDecoder.decode(
      statusCode: response.statusCode,
      headers: response.headers,
      bodyBytes: response.bodyBytes,
    );
  }

  /// A signed upload capability is not an API bearer endpoint. Never attach
  /// session tokens, cookies or extra headers to object-storage requests.
  Future<void> uploadSigned(
    String signedUrl,
    File file,
    String contentType, {
    void Function(int sent, int total)? onProgress,
  }) async {
    try {
      await _signedUploadTransport.upload(
        signedUrl,
        file,
        contentType,
        onProgress: onProgress,
      );
    } on TransportFailure catch (failure) {
      final requestId = _headerValue(failure.responseHeaders, 'x-request-id');
      throw ApiFailure(
        failure.status,
        failure.code,
        failure.message,
        requestId: requestId,
        responseRequestId: requestId,
        retryAfter: _headerValue(failure.responseHeaders, 'retry-after'),
        headers: failure.responseHeaders,
        isTransportFailure: true,
      );
    }
  }

  @override
  void dispose() {
    // The application composition root owns and closes the shared client.
    _disposed = true;
    super.dispose();
  }

  void _notifyListeners() {
    if (!_disposed) notifyListeners();
  }

  static String? _headerValue(Map<String, String> headers, String name) {
    for (final entry in headers.entries) {
      if (entry.key.toLowerCase() == name) return entry.value;
    }
    return null;
  }
}
