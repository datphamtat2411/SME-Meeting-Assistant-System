import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/core/api_transport.dart';

void main() {
  group('CoreApiTransport', () {
    test('builds an encoded request and preserves the raw response', () async {
      final client = RecordingHttpClient(
        (request) async => streamedResponse(
          207,
          body: <int>[0, 1, 255],
          headers: <String, String>{
            'etag': '"meeting-v3"',
            'retry-after': '10',
            'x-request-id': 'request-123',
          },
        ),
      );
      final transport = CoreApiTransport(
        baseUri: Uri.parse('https://api.example.test/api/v1'),
        httpClient: client,
      );

      final response = await transport.send(
        'GET',
        '/meetings',
        query: <String, String>{'search': 'room & time', 'page': '2'},
        headers: <String, String>{
          'If-None-Match': '"meeting-v2"',
          'X-Request-Id': 'request-123',
        },
        authorization: 'Bearer access-token',
      );

      final request = client.requests.single;
      expect(request.method, 'GET');
      expect(request.url.scheme, 'https');
      expect(request.url.host, 'api.example.test');
      expect(request.url.path, '/api/v1/meetings');
      expect(request.url.queryParameters, <String, String>{
        'search': 'room & time',
        'page': '2',
      });
      expect(request.followRedirects, isFalse);
      expect(request.headers['Accept'], 'application/json');
      expect(request.headers['X-Auth-Transport'], 'mobile');
      expect(request.headers['Authorization'], 'Bearer access-token');
      expect(request.headers['If-None-Match'], '"meeting-v2"');
      expect(request.headers['X-Request-Id'], 'request-123');
      expect(request.headers.containsKey('Content-Type'), isFalse);

      expect(response.statusCode, 207);
      expect(response.headers['etag'], '"meeting-v3"');
      expect(response.headers['retry-after'], '10');
      expect(response.headers['x-request-id'], 'request-123');
      expect(response.bodyBytes, orderedEquals(<int>[0, 1, 255]));
    });

    test(
      'encodes JSON request bodies as UTF-8 without inventing empty bodies',
      () async {
        final client = RecordingHttpClient(
          (request) async => streamedResponse(201),
        );
        final transport = CoreApiTransport(
          baseUri: Uri.parse('https://api.example.test/api/v1'),
          httpClient: client,
        );

        await transport.send(
          'POST',
          '/meetings',
          body: <String, dynamic>{'title': 'Cuộc họp', 'count': 2},
        );
        await transport.send('DELETE', '/meetings/meeting-1');

        final post = client.requests[0] as http.Request;
        expect(post.headers['Content-Type'], 'application/json');
        expect(jsonDecode(utf8.decode(post.bodyBytes)), <String, dynamic>{
          'title': 'Cuộc họp',
          'count': 2,
        });

        final delete = client.requests[1] as http.Request;
        expect(delete.bodyBytes, isEmpty);
        expect(delete.headers.containsKey('Content-Type'), isFalse);
      },
    );

    test('rejects reserved caller headers case-insensitively', () async {
      const reservedHeaders = <String>[
        'Authorization',
        'cOoKiE',
        'Proxy-Authorization',
        'Host',
        'X-Auth-Transport',
        'Content-Type',
      ];

      for (final header in reservedHeaders) {
        final client = RecordingHttpClient(
          (request) async => streamedResponse(200),
        );
        final transport = CoreApiTransport(
          baseUri: Uri.parse('https://api.example.test/api/v1'),
          httpClient: client,
        );

        await expectLater(
          transport.send(
            'POST',
            '/meetings',
            body: const <String, dynamic>{},
            headers: <String, String>{header: 'attacker-controlled'},
          ),
          throwsA(
            isA<TransportFailure>().having(
              (failure) => failure.code,
              'code',
              'INVALID_REQUEST_HEADERS',
            ),
          ),
        );
        expect(client.requests, isEmpty);
      }
    });

    test(
      'rejects absolute, authority, query, and traversal endpoint paths',
      () async {
        const invalidPaths = <String>[
          'https://evil.example.test/steal',
          '//evil.example.test/steal',
          '/../outside',
          '/%2e%2e/outside',
          '/meetings?redirect=https://evil.example.test',
          '/meetings#fragment',
        ];

        for (final path in invalidPaths) {
          final client = RecordingHttpClient(
            (request) async => streamedResponse(200),
          );
          final transport = CoreApiTransport(
            baseUri: Uri.parse('https://api.example.test/api/v1'),
            httpClient: client,
          );

          await expectLater(
            transport.send('GET', path),
            throwsA(
              isA<TransportFailure>().having(
                (failure) => failure.code,
                'code',
                'INVALID_ENDPOINT',
              ),
            ),
          );
          expect(client.requests, isEmpty);
        }
      },
    );

    test(
      'rejects redirects without following them and preserves their status',
      () async {
        final client = RecordingHttpClient(
          (request) async => streamedResponse(
            302,
            headers: <String, String>{
              'location': 'https://evil.example.test/next',
            },
            body: utf8.encode('redirect body'),
          ),
        );
        final transport = CoreApiTransport(
          baseUri: Uri.parse('https://api.example.test/api/v1'),
          httpClient: client,
        );

        await expectLater(
          transport.send('GET', '/meetings'),
          throwsA(
            isA<TransportFailure>()
                .having((failure) => failure.status, 'status', 302)
                .having(
                  (failure) => failure.code,
                  'code',
                  'UNEXPECTED_REDIRECT',
                )
                .having(
                  (failure) => failure.responseHeaders['location'],
                  'location',
                  'https://evil.example.test/next',
                ),
          ),
        );
        expect(client.requests.single.followRedirects, isFalse);
      },
    );

    test(
      'normalizes connection failures without exposing exception details',
      () async {
        final client = RecordingHttpClient(
          (request) => Future<http.StreamedResponse>.error(
            const SocketException('private socket details'),
          ),
        );
        final transport = CoreApiTransport(
          baseUri: Uri.parse('https://api.example.test/api/v1'),
          httpClient: client,
        );

        await expectLater(
          transport.send('GET', '/meetings'),
          throwsA(
            isA<TransportFailure>()
                .having(
                  (failure) => failure.code,
                  'code',
                  'NETWORK_UNAVAILABLE',
                )
                .having(
                  (failure) => failure.message,
                  'message',
                  isNot(contains('private socket details')),
                ),
          ),
        );
      },
    );

    test('times out dispatch without replaying the request', () async {
      final client = RecordingHttpClient((request) async {
        await Future<void>.delayed(const Duration(milliseconds: 50));
        return streamedResponse(200);
      });
      final transport = CoreApiTransport(
        baseUri: Uri.parse('https://api.example.test/api/v1'),
        httpClient: client,
        dispatchTimeout: const Duration(milliseconds: 1),
      );

      await expectLater(
        transport.send('GET', '/meetings'),
        throwsA(
          isA<TransportFailure>().having(
            (failure) => failure.code,
            'code',
            'NETWORK_TIMEOUT',
          ),
        ),
      );
      expect(client.requests, hasLength(1));
    });
  });
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

class RecordingHttpClient extends http.BaseClient {
  RecordingHttpClient(this.handler);

  final Future<http.StreamedResponse> Function(http.BaseRequest request)
  handler;
  final List<http.BaseRequest> requests = <http.BaseRequest>[];

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    requests.add(request);
    return handler(request);
  }
}
