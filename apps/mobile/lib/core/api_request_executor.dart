import 'api_response.dart';
import 'api_response_decoder.dart';
import 'api_transport.dart';

/// Executes one Core API request and applies the shared envelope/error decoder.
///
/// It deliberately has no session or retry policy. Authentication operations
/// use this same low-level path without recursively entering ApiClient.
class CoreApiRequestExecutor {
  const CoreApiRequestExecutor({
    required this.transport,
    required this.decoder,
  });

  final CoreApiTransport transport;
  final ApiResponseDecoder decoder;

  Future<ApiResult> send(
    String method,
    String path, {
    Map<String, String>? query,
    Object? body,
    Map<String, String>? headers,
    String? authorization,
    CoreApiTimeoutPolicy? timeoutPolicy,
  }) async {
    final CoreApiResponse response;
    try {
      response = await transport.send(
        method,
        path,
        query: query,
        body: body,
        headers: headers,
        authorization: authorization,
        timeoutPolicy: timeoutPolicy,
      );
    } on TransportFailure catch (failure) {
      throw normalizeTransportFailure(failure);
    }

    return _decode(response);
  }

  /// Executes only one of the fixed public authentication operations.
  ///
  /// Unlike [send], this path has no arbitrary URL, authorization, or headers
  /// parameter. The transport applies the ordinary Core API timeout,
  /// validation, response, and error handling without session credentials.
  Future<ApiResult> sendPublicAuthentication(
    PublicAuthenticationOperation operation, {
    required Object body,
  }) async {
    final CoreApiResponse response;
    try {
      response = await transport.sendPublicAuthentication(
        operation,
        body: body,
      );
    } on TransportFailure catch (failure) {
      throw normalizeTransportFailure(failure);
    }
    return _decode(response);
  }

  ApiResult _decode(CoreApiResponse response) {
    return decoder.decode(
      statusCode: response.statusCode,
      headers: response.headers,
      bodyBytes: response.bodyBytes,
    );
  }
}

ApiFailure normalizeTransportFailure(TransportFailure failure) {
  final requestId = headerValue(failure.responseHeaders, 'x-request-id');
  return ApiFailure(
    failure.status,
    failure.code,
    failure.message,
    requestId: requestId,
    responseRequestId: requestId,
    retryAfter: headerValue(failure.responseHeaders, 'retry-after'),
    headers: failure.responseHeaders,
    isTransportFailure: true,
    remoteOutcomeAmbiguous: failure.remoteOutcomeAmbiguous,
  );
}

String? headerValue(Map<String, String> headers, String name) {
  for (final entry in headers.entries) {
    if (entry.key.toLowerCase() == name.toLowerCase()) return entry.value;
  }
  return null;
}
