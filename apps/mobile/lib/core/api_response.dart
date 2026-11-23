import 'dart:io';

/// A safe, structured failure returned by the Core API layer.
///
/// Transport failures retain their transport status and code. Invalid API
/// responses use [invalidResponseCode] and never include raw response bodies.
class ApiFailure implements Exception {
  static const String invalidResponseCode = 'INVALID_RESPONSE';

  final int status;
  final String code;
  final String message;
  final String? requestId;
  final String? responseRequestId;
  final String? timestamp;
  final List<ApiFieldError> errors;
  final String? retryAfter;
  final Map<String, String> headers;
  final bool isTransportFailure;

  const ApiFailure(
    this.status,
    this.code,
    this.message, {
    this.requestId,
    this.responseRequestId,
    this.timestamp,
    this.errors = const <ApiFieldError>[],
    this.retryAfter,
    this.headers = const <String, String>{},
    this.isTransportFailure = false,
  });

  bool get unauthorized => status == 401;
  bool get missing => status == 404;
  bool get conflict => status == 409 || status == 412;
  bool get permissionDenied => status == 403;

  bool get authenticationFailure => status == 401;
  bool get authorizationFailure => status == 403;
  bool get resourceFailure => status == 404;
  bool get businessConflict => status == 409;
  bool get concurrencyFailure => status == 412 || status == 428;
  bool get validationFailure => status == 422 || code == 'VALIDATION_FAILED';
  bool get malformedRequest => status == 400;
  bool get payloadTooLarge => status == 413;
  bool get unsupportedMediaType => status == 415;
  bool get rateLimited => status == 429;
  bool get serverFailure => status >= 500 && status <= 599;
  bool get invalidResponse => code == invalidResponseCode;
  bool get transportFailure => isTransportFailure;

  /// Parses either Retry-After delta-seconds or its HTTP-date representation.
  ///
  /// The original value remains available through [retryAfter]. This helper
  /// does not schedule a retry or change transport behavior.
  Duration? retryAfterDuration({DateTime? now}) {
    final value = retryAfter?.trim();
    if (value == null || value.isEmpty) return null;

    final seconds = int.tryParse(value);
    if (seconds != null && seconds >= 0) {
      return Duration(seconds: seconds);
    }

    DateTime? retryAt;
    try {
      retryAt = HttpDate.parse(value);
    } on FormatException {
      retryAt = DateTime.tryParse(value);
    }
    if (retryAt == null) return null;
    final difference = retryAt.toUtc().difference(
      (now ?? DateTime.now()).toUtc(),
    );
    return difference.isNegative ? Duration.zero : difference;
  }

  @override
  String toString() => message;
}

/// A validation error returned by the Common API Response contract.
class ApiFieldError {
  const ApiFieldError({
    this.field,
    this.path,
    required this.code,
    required this.message,
  });

  final String? field;
  final String? path;
  final String code;
  final String message;

  String? get fieldPath => field ?? path;
}

/// The validated success response exposed to existing feature callers.
class ApiResult {
  final dynamic data;
  final Map<String, dynamic> meta;
  final String? etag;
  final String? code;
  final String? message;
  final int statusCode;
  final String? requestId;
  final String? responseRequestId;
  final String? timestamp;
  final Map<String, String> headers;

  /// The original positional constructor remains available for existing
  /// callers and test doubles.
  const ApiResult(
    this.data,
    this.meta,
    this.etag, {
    this.code,
    this.message,
    this.statusCode = 200,
    this.requestId,
    this.responseRequestId,
    this.timestamp,
    this.headers = const <String, String>{},
  });

  Map<String, dynamic> objectData() => requireJsonObject(data, response: this);

  List<dynamic> arrayData() => requireJsonArray(data, response: this);

  List<Map<String, dynamic>> objectArrayData() =>
      requireJsonObjectArray(data, response: this);

  /// Builds a safe shape-validation failure with the originating response
  /// context. This is deliberately distinct from transport failures.
  ApiFailure invalidDataFailure() => ApiFailure(
    hasResponseContext ? statusCode : 0,
    ApiFailure.invalidResponseCode,
    'The server returned an invalid response.',
    requestId: requestId,
    responseRequestId: responseRequestId,
    timestamp: timestamp,
    headers: headers,
  );

  bool get hasResponseContext =>
      requestId != null ||
      responseRequestId != null ||
      timestamp != null ||
      headers.isNotEmpty ||
      meta.containsKey('requestId') ||
      meta.containsKey('timestamp');

  /// Returns a nullable endpoint value after checking its non-null type.
  T? nullableData<T>() {
    if (data == null) return null;
    if (data is T) return data as T;
    throw invalidDataFailure();
  }
}

/// Requires a JSON object and reports a structured invalid-response failure
/// rather than manufacturing an empty map.
Map<String, dynamic> requireJsonObject(
  dynamic value, {
  String? requestId,
  ApiResult? response,
}) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map && value.keys.every((key) => key is String)) {
    return value.map((key, item) => MapEntry(key as String, item));
  }
  throw _invalidPayloadShape(requestId: requestId, response: response);
}

/// Requires a JSON array without changing a valid empty array.
List<dynamic> requireJsonArray(
  dynamic value, {
  String? requestId,
  ApiResult? response,
}) {
  if (value is List) return value;
  throw _invalidPayloadShape(requestId: requestId, response: response);
}

/// Requires an array containing only JSON objects.
List<Map<String, dynamic>> requireJsonObjectArray(
  dynamic value, {
  String? requestId,
  ApiResult? response,
}) {
  final items = requireJsonArray(
    value,
    requestId: requestId,
    response: response,
  );
  final result = <Map<String, dynamic>>[];
  for (final item in items) {
    result.add(
      requireJsonObject(item, requestId: requestId, response: response),
    );
  }
  return List<Map<String, dynamic>>.unmodifiable(result);
}

ApiFailure _invalidPayloadShape({String? requestId, ApiResult? response}) =>
    response?.invalidDataFailure() ??
    ApiFailure(
      0,
      ApiFailure.invalidResponseCode,
      'The server returned an invalid response.',
      requestId: requestId,
    );
