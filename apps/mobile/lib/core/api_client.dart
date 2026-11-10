import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

import 'app_config.dart';

class ApiFailure implements Exception {
  final int status;
  final String code;
  final String message;

  const ApiFailure(this.status, this.code, this.message);

  bool get unauthorized => status == 401;
  bool get missing => status == 404;
  bool get conflict => status == 409 || status == 412;
  bool get permissionDenied => status == 403;

  @override
  String toString() => message;
}

class ApiResult {
  final dynamic data;
  final Map<String, dynamic> meta;
  final String? etag;

  const ApiResult(this.data, this.meta, this.etag);
}

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
  final http.Client _http = http.Client();
  final FlutterSecureStorage _secure = const FlutterSecureStorage();
  String? _accessToken;
  String? _refreshToken;
  DateTime? _accessExpiry;
  Future<void>? _refreshFuture;
  bool ready = false;
  String? sessionRestoreError;
  Map<String, dynamic>? identity;

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
      notifyListeners();
    }
  }

  bool _isTemporary(ApiFailure failure) =>
      failure.status == 0 || failure.status >= 500;

  Future<void> retrySessionRestore() async {
    if (_refreshToken == null) return;
    ready = false;
    sessionRestoreError = null;
    notifyListeners();
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
      notifyListeners();
    }
  }

  Future<void> discardLocalSession() async {
    await _forget();
    sessionRestoreError = null;
    notifyListeners();
  }

  Future<void> signIn(String email, String password) async {
    final result = await _request(
      'POST', '/auth/login',
      body: {'email': email.trim(), 'password': password},
      auth: false,
    );
    await _adoptTokens(result.data);
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
    identity = objectOf(result.data);
    if (identity?['userId'] == null) {
      throw const ApiFailure(0, 'INVALID_RESPONSE', 'Invalid account response.');
    }
    notifyListeners();
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
    notifyListeners();
  }

  Future<void> _adoptTokens(dynamic raw) async {
    final values = objectOf(raw);
    final access = values['accessToken'];
    final refresh = values['refreshToken'];
    if (access is! String || access.isEmpty ||
        refresh is! String || refresh.isEmpty) {
      throw const ApiFailure(0, 'INVALID_RESPONSE', 'Invalid mobile token response.');
    }
    _accessToken = access;
    _refreshToken = refresh;
    final expires = (values['expiresIn'] as num?)?.toInt() ?? 600;
    _accessExpiry = DateTime.now().add(Duration(seconds: expires > 60 ? expires - 30 : expires));
    await _secure.write(key: 'sme.mobile.refresh', value: refresh);
  }

  Future<void> _renew() async {
    final token = _refreshToken;
    if (token == null) throw const ApiFailure(401, 'AUTH_SESSION_EXPIRED', 'Session expired.');
    try {
      final result = await _request(
        'POST', '/auth/refresh',
        auth: false, authorization: 'Bearer ' + token,
      );
      await _adoptTokens(result.data);
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

  Future<ApiResult> post(String path, Map<String, dynamic> body,
      {Map<String, String>? headers}) =>
      _request('POST', path, body: body, headers: headers);

  Future<ApiResult> patch(String path, Map<String, dynamic> body,
      {Map<String, String>? headers}) =>
      _request('PATCH', path, body: body, headers: headers);

  Future<ApiResult> delete(String path, {Map<String, String>? headers}) =>
      _request('DELETE', path, headers: headers);

  Future<ApiResult> _request(
    String method, String path, {
    Map<String, String>? query,
    Map<String, dynamic>? body,
    Map<String, String>? headers,
    bool auth = true,
    String? authorization,
    bool allowRetry = true,
  }) async {
    if (auth && _refreshToken != null &&
        (_accessToken == null ||
          (_accessExpiry != null && DateTime.now().isAfter(_accessExpiry!)))) {
      await _refreshOnce();
    }
    final uri = AppConfig.baseUri.replace(
      path: AppConfig.baseUri.path.replaceFirst(RegExp(r'/$'), '') + path,
      queryParameters: query?.isEmpty == true ? null : query,
    );
    final requestHeaders = <String, String>{
      'Accept': 'application/json',
      'X-Auth-Transport': 'mobile',
      if (body != null) 'Content-Type': 'application/json',
      if (authorization != null) 'Authorization': authorization,
      if (auth && _accessToken != null) 'Authorization': 'Bearer ' + _accessToken!,
      ...?headers,
    };
    http.Response response;
    try {
      final request = http.Request(method, uri)
        ..followRedirects = false
        ..headers.addAll(requestHeaders);
      if (body != null) request.body = jsonEncode(body);
      final streamed = await _http.send(request).timeout(const Duration(seconds: 25));
      response = await http.Response.fromStream(streamed)
          .timeout(const Duration(seconds: 45));
    } on TimeoutException {
      throw const ApiFailure(0, 'NETWORK_TIMEOUT', 'Request timed out. Try again.');
    } on SocketException {
      throw const ApiFailure(0, 'NETWORK_UNAVAILABLE', 'Cannot reach Core API.');
    } on http.ClientException {
      throw const ApiFailure(0, 'NETWORK_ERROR', 'Network request failed.');
    }
    if (auth && response.statusCode == 401 && allowRetry && _refreshToken != null) {
      await _refreshOnce();
      return _request(method, path, query: query, body: body, headers: headers,
          allowRetry: false);
    }
    if (response.statusCode >= 300 && response.statusCode < 400) {
      throw const ApiFailure(0, 'UNEXPECTED_REDIRECT',
          'API attempted an unexpected redirect.');
    }
    if (auth && response.statusCode == 401 && !allowRetry) {
      await _forget();
      throw const ApiFailure(401, 'AUTH_SESSION_EXPIRED',
          'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.');
    }
    dynamic envelope;
    try {
      envelope = jsonDecode(utf8.decode(response.bodyBytes));
    } catch (_) {
      throw ApiFailure(response.statusCode, 'INVALID_RESPONSE',
          'Server returned a non-JSON response.');
    }
    final result = objectOf(envelope);
    if (response.statusCode < 200 || response.statusCode >= 300 ||
        result['success'] != true) {
      throw ApiFailure(response.statusCode,
          (result['code'] ?? 'API_ERROR').toString(),
          (result['message'] ?? 'The operation could not be completed.').toString());
    }
    return ApiResult(result['data'], objectOf(result['meta']),
        response.headers['etag']);
  }

  /// A signed upload capability is not an API bearer endpoint. Never attach
  /// session tokens, cookies or extra headers to object-storage requests.
  Future<void> uploadSigned(String signedUrl, File file, String contentType,
      {void Function(int sent, int total)? onProgress}) async {
    final uri = Uri.parse(signedUrl);
    if (uri.scheme != 'https' && !(kDebugMode && uri.scheme == 'http')) {
      throw const ApiFailure(0, 'INSECURE_UPLOAD', 'Upload URL must use HTTPS.');
    }
    final length = await file.length();
    final request = http.StreamedRequest('PUT', uri)
      ..followRedirects = false
      ..contentLength = length
      ..headers['Content-Type'] = contentType;
    try {
      final future = _http.send(request);
      var sent = 0;
      await request.sink.addStream(file.openRead().map((chunk) {
        sent += chunk.length;
        onProgress?.call(sent, length);
        return chunk;
      }));
      await request.sink.close();
      final response = await future.timeout(const Duration(minutes: 10));
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw ApiFailure(response.statusCode, 'UPLOAD_FAILED', 'Audio upload failed.');
      }
      await response.stream.drain<void>();
    } on SocketException {
      throw const ApiFailure(0, 'UPLOAD_NETWORK_ERROR', 'Audio upload connection lost.');
    }
  }

  @override
  void dispose() {
    _http.close();
    super.dispose();
  }
}
