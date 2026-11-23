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
      );
    } on TransportFailure catch (failure) {
      throw normalizeTransportFailure(failure);
    }

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
  );
}

String? headerValue(Map<String, String> headers, String name) {
  for (final entry in headers.entries) {
    if (entry.key.toLowerCase() == name.toLowerCase()) return entry.value;
  }
  return null;
}
