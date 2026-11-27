import 'dart:convert';

import 'api_response.dart';

/// Decodes ordinary Core API JSON responses without constructing requests or
/// changing transport, authentication, or application state.
class ApiResponseDecoder {
  const ApiResponseDecoder();

  ApiResult decode({
    required int statusCode,
    required Map<String, String> headers,
    required List<int> bodyBytes,
  }) {
    final immutableHeaders = Map<String, String>.unmodifiable(headers);
    final responseRequestId = _header(headers, 'x-request-id');
    final retryAfter = _header(headers, 'retry-after');
    final etag = _header(headers, 'etag');
    dynamic decoded;
    try {
      decoded = jsonDecode(utf8.decode(bodyBytes));
    } on FormatException {
      throw _invalidResponse(
        statusCode,
        immutableHeaders,
        responseRequestId: responseRequestId,
        retryAfter: retryAfter,
      );
    } on Exception {
      throw _invalidResponse(
        statusCode,
        immutableHeaders,
        responseRequestId: responseRequestId,
        retryAfter: retryAfter,
      );
    }

    if (decoded is! Map || !decoded.keys.every((key) => key is String)) {
      throw _invalidResponse(
        statusCode,
        immutableHeaders,
        responseRequestId: responseRequestId,
        retryAfter: retryAfter,
      );
    }

    final envelope = decoded.cast<String, dynamic>();
    final validated = _validateEnvelope(
      envelope,
      statusCode: statusCode,
      headers: immutableHeaders,
      responseRequestId: responseRequestId,
      retryAfter: retryAfter,
    );

    if (statusCode == 204 ||
        (statusCode >= 200 && statusCode < 300 && !validated.success) ||
        (statusCode >= 400 && statusCode < 600 && validated.success) ||
        !(statusCode >= 200 && statusCode < 300) &&
            !(statusCode >= 400 && statusCode < 600)) {
      throw _invalidResponse(
        statusCode,
        immutableHeaders,
        requestId: validated.requestId,
        responseRequestId: responseRequestId,
        timestamp: validated.timestamp,
        retryAfter: retryAfter,
      );
    }

    if (!validated.success) {
      if (validated.code == 'SUCCESS' || envelope['data'] != null) {
        throw _invalidResponse(
          statusCode,
          immutableHeaders,
          requestId: validated.requestId,
          responseRequestId: responseRequestId,
          timestamp: validated.timestamp,
          retryAfter: retryAfter,
        );
      }
      return _throwApiFailure(
        statusCode: statusCode,
        code: validated.code,
        message: _safeMessage(validated.message),
        requestId: validated.requestId,
        responseRequestId: responseRequestId,
        timestamp: validated.timestamp,
        errors: validated.errors,
        retryAfter: retryAfter,
        headers: immutableHeaders,
      );
    }

    return ApiResult(
      envelope['data'],
      validated.meta,
      etag,
      code: validated.code,
      message: validated.message,
      statusCode: statusCode,
      requestId: validated.requestId,
      responseRequestId: responseRequestId,
      timestamp: validated.timestamp,
      headers: immutableHeaders,
    );
  }

  _ValidatedEnvelope _validateEnvelope(
    Map<String, dynamic> envelope, {
    required int statusCode,
    required Map<String, String> headers,
    required String? responseRequestId,
    required String? retryAfter,
  }) {
    final bool success;
    final String code;
    final String? message;
    final Map<String, dynamic> meta;
    final String requestId;
    final String timestamp;
    final List<ApiFieldError> errors;

    final rawMeta = envelope['meta'];
    if (envelope['success'] is! bool ||
        envelope['code'] is! String ||
        (envelope['code'] as String).trim().isEmpty ||
        !envelope.containsKey('data') ||
        rawMeta is! Map ||
        !rawMeta.keys.every((key) => key is String)) {
      throw _invalidResponse(
        statusCode,
        headers,
        requestId: rawMeta is Map
            ? _nonEmptyString(rawMeta['requestId'])
            : null,
        responseRequestId: responseRequestId,
        retryAfter: retryAfter,
      );
    }

    if (envelope.containsKey('message') && envelope['message'] is! String) {
      throw _invalidResponse(
        statusCode,
        headers,
        requestId: _nonEmptyString(rawMeta['requestId']),
        responseRequestId: responseRequestId,
        retryAfter: retryAfter,
      );
    }

    success = envelope['success'] as bool;
    code = envelope['code'] as String;
    message = envelope['message'] as String?;
    meta = rawMeta.cast<String, dynamic>();
    final rawRequestId = meta['requestId'];
    final rawTimestamp = meta['timestamp'];
    if (rawRequestId is! String ||
        rawRequestId.trim().isEmpty ||
        rawTimestamp is! String ||
        !_isDateTime(rawTimestamp)) {
      throw _invalidResponse(
        statusCode,
        headers,
        requestId: _nonEmptyString(rawRequestId),
        responseRequestId: responseRequestId,
        timestamp: rawTimestamp is String ? rawTimestamp : null,
        retryAfter: retryAfter,
      );
    }
    requestId = rawRequestId;
    timestamp = rawTimestamp;

    if (meta.containsKey('pagination') && meta['pagination'] is! Map) {
      throw _invalidResponse(
        statusCode,
        headers,
        requestId: requestId,
        responseRequestId: responseRequestId,
        timestamp: timestamp,
        retryAfter: retryAfter,
      );
    }
    if (meta['pagination'] is Map &&
        !(meta['pagination'] as Map).keys.every((key) => key is String)) {
      throw _invalidResponse(
        statusCode,
        headers,
        requestId: requestId,
        responseRequestId: responseRequestId,
        timestamp: timestamp,
        retryAfter: retryAfter,
      );
    }

    errors = _validateErrors(
      envelope,
      statusCode: statusCode,
      headers: headers,
      requestId: requestId,
      responseRequestId: responseRequestId,
      timestamp: timestamp,
      retryAfter: retryAfter,
    );
    if (success && errors.isNotEmpty) {
      throw _invalidResponse(
        statusCode,
        headers,
        requestId: requestId,
        responseRequestId: responseRequestId,
        timestamp: timestamp,
        retryAfter: retryAfter,
      );
    }
    return _ValidatedEnvelope(
      success: success,
      code: code,
      message: message,
      meta: Map<String, dynamic>.unmodifiable(meta),
      requestId: requestId,
      timestamp: timestamp,
      errors: errors,
    );
  }

  List<ApiFieldError> _validateErrors(
    Map<String, dynamic> envelope, {
    required int statusCode,
    required Map<String, String> headers,
    required String requestId,
    required String? responseRequestId,
    required String timestamp,
    required String? retryAfter,
  }) {
    if (!envelope.containsKey('errors')) return const <ApiFieldError>[];
    final rawErrors = envelope['errors'];
    if (rawErrors is! List) {
      throw _invalidResponse(
        statusCode,
        headers,
        requestId: requestId,
        responseRequestId: responseRequestId,
        timestamp: timestamp,
        retryAfter: retryAfter,
      );
    }

    final errors = <ApiFieldError>[];
    for (final rawError in rawErrors) {
      if (rawError is! Map ||
          !rawError.keys.every((key) => key is String) ||
          rawError['code'] is! String ||
          (rawError['code'] as String).trim().isEmpty ||
          rawError['message'] is! String ||
          (rawError.containsKey('field') &&
              rawError['field'] != null &&
              rawError['field'] is! String) ||
          (rawError.containsKey('path') &&
              rawError['path'] != null &&
              rawError['path'] is! String)) {
        throw _invalidResponse(
          statusCode,
          headers,
          requestId: requestId,
          responseRequestId: responseRequestId,
          timestamp: timestamp,
          retryAfter: retryAfter,
        );
      }
      errors.add(
        ApiFieldError(
          field: rawError['field'] as String?,
          path: rawError['path'] as String?,
          code: rawError['code'] as String,
          message: rawError['message'] as String,
        ),
      );
    }
    return List<ApiFieldError>.unmodifiable(errors);
  }
}

class _ValidatedEnvelope {
  const _ValidatedEnvelope({
    required this.success,
    required this.code,
    required this.message,
    required this.meta,
    required this.requestId,
    required this.timestamp,
    required this.errors,
  });

  final bool success;
  final String code;
  final String? message;
  final Map<String, dynamic> meta;
  final String requestId;
  final String timestamp;
  final List<ApiFieldError> errors;
}

ApiFailure _invalidResponse(
  int statusCode,
  Map<String, String> headers, {
  String? requestId,
  String? responseRequestId,
  String? timestamp,
  String? retryAfter,
}) => ApiFailure(
  statusCode,
  ApiFailure.invalidResponseCode,
  'The server returned an invalid response.',
  requestId: requestId ?? responseRequestId,
  responseRequestId: responseRequestId,
  timestamp: timestamp,
  retryAfter: retryAfter,
  headers: headers,
);

Never _throwApiFailure({
  required int statusCode,
  required String code,
  required String message,
  required String requestId,
  required String? responseRequestId,
  required String timestamp,
  required List<ApiFieldError> errors,
  required String? retryAfter,
  required Map<String, String> headers,
}) {
  throw ApiFailure(
    statusCode,
    code,
    message,
    requestId: requestId,
    responseRequestId: responseRequestId,
    timestamp: timestamp,
    errors: errors,
    retryAfter: retryAfter,
    headers: headers,
  );
}

String _safeMessage(String? message) {
  if (message == null || message.trim().isEmpty) {
    return 'The operation could not be completed.';
  }
  return message;
}

String? _header(Map<String, String> headers, String name) {
  for (final entry in headers.entries) {
    if (entry.key.toLowerCase() == name) return entry.value;
  }
  return null;
}

String? _nonEmptyString(dynamic value) =>
    value is String && value.trim().isNotEmpty ? value : null;

bool _isDateTime(String value) {
  if (!RegExp(
    r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$',
  ).hasMatch(value)) {
    return false;
  }
  return DateTime.tryParse(value) != null;
}
