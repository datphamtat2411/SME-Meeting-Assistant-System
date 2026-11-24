import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/core/api_transport.dart';
import 'package:sme_meeting_assistant/core/signed_upload_transport.dart';

void main() {
  group('SignedUploadTransport', () {
    test('streams file bytes with only signed-upload headers and progress', () async {
      final directory = await Directory.systemTemp.createTemp(
        'sme-upload-test',
      );
      addTearDown(() => directory.delete(recursive: true));
      final file = File('${directory.path}/audio.bin');
      final bytes = utf8.encode('audio bytes');
      await file.writeAsBytes(bytes);

      final client = UploadRecordingClient(
        (request) async => streamedUploadResponse(200),
      );
      final transport = SignedUploadTransport(
        httpClient: client,
        androidDebugOverride: false,
      );
      final progress = <List<int>>[];
      const signedUrl =
          'https://storage.example.test/object?X-Amz-Signature=a%2Bb&part=1+2';

      final response = await transport.upload(
        signedUrl,
        file,
        'audio/mpeg',
        onProgress: (sent, total) => progress.add(<int>[sent, total]),
      );

      final request = client.requests.single;
      expect(response.statusCode, 200);
      expect(request, isA<http.StreamedRequest>());
      expect(request.method, 'PUT');
      expect(request.url.toString(), signedUrl);
      expect(request.followRedirects, isFalse);
      expect(request.contentLength, bytes.length);
      expect(client.requestBodies.single, orderedEquals(bytes));
      expect(request.headers.keys.map((key) => key.toLowerCase()), <String>[
        'content-type',
      ]);
      expect(request.headers['Content-Type'], 'audio/mpeg');
      expect(request.headers.containsKey('Authorization'), isFalse);
      expect(request.headers.containsKey('Cookie'), isFalse);
      expect(request.headers.containsKey('X-Auth-Transport'), isFalse);
      expect(progress, isNotEmpty);
      expect(progress.last, <int>[bytes.length, bytes.length]);
    });

    test('rejects public HTTP signed URLs and malformed URLs', () async {
      final directory = await Directory.systemTemp.createTemp(
        'sme-upload-test',
      );
      addTearDown(() => directory.delete(recursive: true));
      final file = File('${directory.path}/audio.bin');
      await file.writeAsBytes(<int>[1, 2, 3]);
      final client = UploadRecordingClient(
        (request) async => streamedUploadResponse(200),
      );
      final transport = SignedUploadTransport(
        httpClient: client,
        androidDebugOverride: false,
      );

      for (final url in <String>[
        'http://storage.example.test/object?signature=secret',
        'not a URL',
        'ftp://storage.example.test/object',
        'https://user:password@storage.example.test/object',
      ]) {
        await expectLater(
          transport.upload(url, file, 'audio/mpeg'),
          throwsA(
            isA<TransportFailure>().having(
              (failure) => failure.code,
              'code',
              'INSECURE_UPLOAD',
            ),
          ),
        );
      }
      expect(client.requests, isEmpty);
    });

    test('allows only local HTTP development URLs when explicitly in Android debug mode', () async {
      final directory = await Directory.systemTemp.createTemp(
        'sme-upload-test',
      );
      addTearDown(() => directory.delete(recursive: true));
      final file = File('${directory.path}/audio.bin');
      await file.writeAsBytes(<int>[1, 2, 3]);
      final client = UploadRecordingClient(
        (request) async => streamedUploadResponse(200),
      );
      final transport = SignedUploadTransport(
        httpClient: client,
        androidDebugOverride: true,
      );

      await transport.upload(
        'http://127.0.0.1:9000/object?signature=local',
        file,
        'audio/wav',
      );

      expect(client.requests.single.url.host, '127.0.0.1');
    });

    test('admits only a still-valid signed capability', () async {
      final directory = await Directory.systemTemp.createTemp(
        'sme-upload-test',
      );
      addTearDown(() => directory.delete(recursive: true));
      final file = File('${directory.path}/audio.bin')
        ..writeAsBytesSync(<int>[1, 2, 3]);
      final client = UploadRecordingClient(
        (request) async => streamedUploadResponse(200),
      );
      final transport = SignedUploadTransport(
        httpClient: client,
        now: () => DateTime.utc(2026, 11, 24, 12),
        minimumCapabilityValidity: const Duration(seconds: 30),
        androidDebugOverride: false,
      );

      await expectLater(
        transport.upload(
          'https://storage.example.test/object?signature=secret',
          file,
          'audio/wav',
          expiresAt: DateTime.utc(2026, 11, 24, 12, 0, 29),
        ),
        throwsA(
          isA<TransportFailure>().having(
            (failure) => failure.code,
            'code',
            'UPLOAD_CAPABILITY_EXPIRED',
          ),
        ),
      );
      expect(client.requests, isEmpty);
    });

    test('supports cancellation without closing the shared client', () async {
      final directory = await Directory.systemTemp.createTemp(
        'sme-upload-test',
      );
      addTearDown(() => directory.delete(recursive: true));
      final file = File('${directory.path}/audio.bin')
        ..writeAsBytesSync(<int>[1, 2, 3]);
      final pendingResponse = Completer<http.StreamedResponse>();
      final client = UploadRecordingClient((request) => pendingResponse.future);
      final transport = SignedUploadTransport(
        httpClient: client,
        timeout: const Duration(minutes: 1),
        androidDebugOverride: false,
      );
      final token = UploadCancellationToken();
      final upload = transport.upload(
        'https://storage.example.test/object?signature=secret',
        file,
        'audio/wav',
        cancellationToken: token,
      );
      token.cancel();

      await expectLater(
        upload,
        throwsA(
          isA<TransportFailure>().having(
            (failure) => failure.code,
            'code',
            'UPLOAD_CANCELLED',
          ),
        ),
      );
      expect(client.requests, hasLength(1));
      pendingResponse.complete(streamedUploadResponse(200));
    });

    test('rejects a changed expected length before dispatch', () async {
      final directory = await Directory.systemTemp.createTemp(
        'sme-upload-test',
      );
      addTearDown(() => directory.delete(recursive: true));
      final file = File('${directory.path}/audio.bin')
        ..writeAsBytesSync(<int>[1, 2, 3]);
      final client = UploadRecordingClient(
        (request) async => streamedUploadResponse(200),
      );
      final transport = SignedUploadTransport(
        httpClient: client,
        androidDebugOverride: false,
      );

      await expectLater(
        transport.upload(
          'https://storage.example.test/object?signature=secret',
          file,
          'audio/wav',
          expectedLength: 4,
        ),
        throwsA(
          isA<TransportFailure>().having(
            (failure) => failure.code,
            'code',
            'UPLOAD_SIZE_MISMATCH',
          ),
        ),
      );
      expect(client.requests, isEmpty);
    });

    test(
      'rejects redirects and unsuccessful responses without retrying',
      () async {
        final directory = await Directory.systemTemp.createTemp(
          'sme-upload-test',
        );
        addTearDown(() => directory.delete(recursive: true));
        final file = File('${directory.path}/audio.bin');
        await file.writeAsBytes(<int>[1, 2, 3]);
        var responseStatus = 307;
        final client = UploadRecordingClient(
          (request) async => streamedUploadResponse(
            responseStatus,
            headers: <String, String>{
              'location': 'https://other-storage.example.test/object',
            },
          ),
        );
        final transport = SignedUploadTransport(
          httpClient: client,
          androidDebugOverride: false,
        );

        await expectLater(
          transport.upload(
            'https://storage.example.test/object?signature=secret',
            file,
            'audio/mpeg',
          ),
          throwsA(
            isA<TransportFailure>()
                .having((failure) => failure.status, 'status', 307)
                .having(
                  (failure) => failure.code,
                  'code',
                  'UNEXPECTED_REDIRECT',
                ),
          ),
        );
        expect(client.requests, hasLength(1));
        expect(client.requests.single.followRedirects, isFalse);

        responseStatus = 500;
        await expectLater(
          transport.upload(
            'https://storage.example.test/object?signature=secret',
            file,
            'audio/mpeg',
          ),
          throwsA(
            isA<TransportFailure>()
                .having((failure) => failure.status, 'status', 500)
                .having((failure) => failure.code, 'code', 'UPLOAD_FAILED'),
          ),
        );
        expect(client.requests, hasLength(2));
      },
    );

    test(
      'normalizes upload connection failures and timeouts without retrying',
      () async {
        final directory = await Directory.systemTemp.createTemp(
          'sme-upload-test',
        );
        addTearDown(() => directory.delete(recursive: true));
        final file = File('${directory.path}/audio.bin');
        await file.writeAsBytes(<int>[1, 2, 3]);
        var shouldTimeout = false;
        final timeoutResponse = Completer<http.StreamedResponse>();
        final client = UploadRecordingClient((request) {
          if (shouldTimeout) {
            return timeoutResponse.future;
          }
          return Future<http.StreamedResponse>.error(
            const SocketException('private upload details'),
          );
        });
        final transport = SignedUploadTransport(
          httpClient: client,
          timeout: const Duration(seconds: 1),
          androidDebugOverride: false,
        );

        await expectLater(
          transport.upload(
            'https://storage.example.test/object?signature=secret',
            file,
            'audio/mpeg',
          ),
          throwsA(
            isA<TransportFailure>()
                .having(
                  (failure) => failure.code,
                  'code',
                  'UPLOAD_NETWORK_ERROR',
                )
                .having(
                  (failure) => failure.message,
                  'message',
                  isNot(contains('private upload details')),
                ),
          ),
        );

        shouldTimeout = true;
        await expectLater(
          transport.upload(
            'https://storage.example.test/object?signature=secret',
            file,
            'audio/mpeg',
          ),
          throwsA(
            isA<TransportFailure>().having(
              (failure) => failure.code,
              'code',
              'UPLOAD_TIMEOUT',
            ),
          ),
        );
        expect(client.requests, hasLength(2));
      },
    );
  });
}

Future<http.StreamedResponse> streamedUploadResponse(
  int statusCode, {
  Map<String, String> headers = const <String, String>{},
}) async => http.StreamedResponse(
  const Stream<List<int>>.empty(),
  statusCode,
  headers: headers,
);

class UploadRecordingClient extends http.BaseClient {
  UploadRecordingClient(this.handler);

  final Future<http.StreamedResponse> Function(http.BaseRequest request)
  handler;
  final List<http.BaseRequest> requests = <http.BaseRequest>[];
  final List<List<int>> requestBodies = <List<int>>[];

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    requests.add(request);
    requestBodies.add(await request.finalize().toBytes());
    return handler(request);
  }
}
