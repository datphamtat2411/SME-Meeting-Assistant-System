import 'dart:convert';

import 'package:http/http.dart' as http;

typedef HttpRequestHandler = Future<http.StreamedResponse> Function(
  http.BaseRequest request,
);

/// Records Core API requests while allowing each test to provide responses.
class RecordingHttpClient extends http.BaseClient {
  RecordingHttpClient(this.handler);

  final HttpRequestHandler handler;
  final List<http.BaseRequest> requests = <http.BaseRequest>[];

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    requests.add(request);
    return handler(request);
  }
}

/// Tracks resource disposal for dependency ownership tests without networking.
class NoNetworkHttpClient extends http.BaseClient {
  int closeCalls = 0;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) =>
      Future<http.StreamedResponse>.error(
        UnsupportedError('No network is used by this test.'),
      );

  @override
  void close() {
    closeCalls++;
  }
}

Future<http.StreamedResponse> streamedResponse(
  int statusCode, {
  List<int> body = const <int>[],
  Map<String, String> headers = const <String, String>{},
}) async => http.StreamedResponse(
  Stream<List<int>>.value(body),
  statusCode,
  headers: headers,
);

Future<http.StreamedResponse> jsonResponse(
  int statusCode,
  Map<String, dynamic> value,
) async => http.StreamedResponse(
  Stream<List<int>>.value(utf8.encode(jsonEncode(value))),
  statusCode,
  headers: const <String, String>{'content-type': 'application/json'},
);

Map<String, dynamic> successEnvelope(dynamic data) => <String, dynamic>{
  'success': true,
  'code': 'SUCCESS',
  'message': 'Request completed successfully.',
  'data': data,
  'meta': commonMeta,
};

Map<String, dynamic> errorEnvelope(String code, String message) =>
    <String, dynamic>{
      'success': false,
      'code': code,
      'message': message,
      'data': null,
      'meta': commonMeta,
    };

const commonMeta = <String, dynamic>{
  'requestId': 'test-request-id',
  'timestamp': '2026-11-23T12:00:00Z',
};
