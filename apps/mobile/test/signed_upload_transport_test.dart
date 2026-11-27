import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/io_client.dart';
import 'package:sme_meeting_assistant/core/api_transport.dart';
import 'package:sme_meeting_assistant/core/signed_upload_transport.dart';

void main() {
  group('SignedUploadTransport native IOClient', () {
    test(
      'successfully transfers the complete request to a local HttpServer',
      () async {
        final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
        addTearDown(() => server.close(force: true));
        final client = IOClient();
        addTearDown(client.close);
        final requestSeen = Completer<Map<String, Object?>>();
        server.listen((request) async {
          var length = 0;
          await for (final chunk in request) {
            length += chunk.length;
          }
          requestSeen.complete(<String, Object?>{
            'method': request.method,
            'contentType': request.headers.contentType?.mimeType,
            'contentLength': request.headers.contentLength,
            'length': length,
            'authorization': request.headers.value('authorization'),
            'cookie': request.headers.value('cookie'),
          });
          await request.response.close();
        });

        final directory = await Directory.systemTemp.createTemp(
          'sme-native-upload-success-',
        );
        addTearDown(() => directory.delete(recursive: true));
        final file = File('${directory.path}/audio.wav')
          ..writeAsBytesSync(List<int>.generate(8192, (index) => index % 251));
        final transport = SignedUploadTransport(
          httpClient: client,
          androidDebugOverride: true,
        );
        final response = await transport.upload(
          'http://127.0.0.1:${server.port}/signed-upload',
          file,
          'audio/wav',
          expectedLength: await file.length(),
          expiresAt: DateTime.now().toUtc().add(const Duration(minutes: 5)),
        );

        expect(response.statusCode, 200);
        expect(await requestSeen.future, <String, Object?>{
          'method': 'PUT',
          'contentType': 'audio/wav',
          'contentLength': 8192,
          'length': 8192,
          'authorization': null,
          'cookie': null,
        });
      },
    );

    test(
      'cancels a paused native request without consuming the whole source',
      () async {
        final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
        addTearDown(() => server.close(force: true));
        final client = IOClient();
        addTearDown(client.close);
        final firstBodyChunk = Completer<void>();
        late StreamSubscription<List<int>> subscription;
        var received = 0;
        server.listen((request) {
          subscription = request.listen((chunk) {
            received += chunk.length;
            if (!firstBodyChunk.isCompleted) {
              firstBodyChunk.complete();
              subscription.pause();
            }
          }, onError: (_) {});
        });

        final directory = await Directory.systemTemp.createTemp(
          'sme-native-upload-backpressure-',
        );
        addTearDown(() => directory.delete(recursive: true));
        final file = File('${directory.path}/large.bin')
          ..writeAsBytesSync(
            List<int>.generate(8 * 1024 * 1024, (index) => index % 251),
          );
        final token = UploadCancellationToken();
        final progress = <int>[];
        final transport = SignedUploadTransport(
          httpClient: client,
          timeout: const Duration(seconds: 5),
          inactivityTimeout: const Duration(seconds: 5),
          androidDebugOverride: true,
        );
        final upload = transport.upload(
          'http://127.0.0.1:${server.port}/paused',
          file,
          'audio/wav',
          expectedLength: await file.length(),
          expiresAt: DateTime.now().toUtc().add(const Duration(minutes: 5)),
          cancellationToken: token,
          onProgress: (sent, _) => progress.add(sent),
        );
        await firstBodyChunk.future.timeout(const Duration(seconds: 2));
        token.cancel();

        await expectLater(
          upload.timeout(const Duration(seconds: 2)),
          throwsA(
            isA<TransportFailure>()
                .having((failure) => failure.code, 'code', 'UPLOAD_CANCELLED')
                .having(
                  (failure) => failure.remoteOutcomeAmbiguous,
                  'remoteOutcomeAmbiguous',
                  isTrue,
                ),
          ),
        );
        expect(received, lessThan(await file.length()));
        expect(progress, isNotEmpty);
        expect(progress.last, lessThan(await file.length()));
      },
    );

    test('cancels while native response headers are withheld', () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      final client = IOClient();
      addTearDown(client.close);
      final consumed = Completer<void>();
      late HttpResponse response;
      server.listen((request) async {
        await request.drain<void>();
        consumed.complete();
        response = request.response;
      });

      final directory = await Directory.systemTemp.createTemp(
        'sme-native-upload-headers-',
      );
      addTearDown(() => directory.delete(recursive: true));
      final file = File('${directory.path}/audio.bin')
        ..writeAsBytesSync(
          List<int>.generate(64 * 1024, (index) => index % 251),
        );
      final token = UploadCancellationToken();
      final transport = SignedUploadTransport(
        httpClient: client,
        timeout: const Duration(seconds: 5),
        inactivityTimeout: const Duration(seconds: 5),
        androidDebugOverride: true,
      );
      final upload = transport.upload(
        'http://127.0.0.1:${server.port}/headers',
        file,
        'audio/wav',
        expectedLength: await file.length(),
        expiresAt: DateTime.now().toUtc().add(const Duration(minutes: 5)),
        cancellationToken: token,
      );
      await consumed.future.timeout(const Duration(seconds: 2));
      token.cancel();
      await expectLater(
        upload.timeout(const Duration(seconds: 2)),
        throwsA(
          isA<TransportFailure>()
              .having((failure) => failure.code, 'code', 'UPLOAD_CANCELLED')
              .having(
                (failure) => failure.remoteOutcomeAmbiguous,
                'remoteOutcomeAmbiguous',
                isTrue,
              ),
        ),
      );
      await response.close();
    });

    test('cancels while consuming a native response body', () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      final client = IOClient();
      addTearDown(client.close);
      final responseStarted = Completer<void>();
      server.listen((request) async {
        await request.drain<void>();
        final response = request.response;
        response.statusCode = 200;
        response.headers.chunkedTransferEncoding = true;
        response.write('first response chunk');
        await response.flush();
        responseStarted.complete();
        await Future<void>.delayed(const Duration(seconds: 5));
        await response.close();
      });

      final directory = await Directory.systemTemp.createTemp(
        'sme-native-upload-response-',
      );
      addTearDown(() => directory.delete(recursive: true));
      final file = File('${directory.path}/audio.bin')
        ..writeAsBytesSync(<int>[1, 2, 3]);
      final token = UploadCancellationToken();
      final transport = SignedUploadTransport(
        httpClient: client,
        timeout: const Duration(seconds: 5),
        inactivityTimeout: const Duration(seconds: 5),
        androidDebugOverride: true,
      );
      final upload = transport.upload(
        'http://127.0.0.1:${server.port}/body',
        file,
        'audio/wav',
        expectedLength: 3,
        expiresAt: DateTime.now().toUtc().add(const Duration(minutes: 5)),
        cancellationToken: token,
      );
      await responseStarted.future.timeout(const Duration(seconds: 2));
      token.cancel();
      await expectLater(
        upload.timeout(const Duration(seconds: 2)),
        throwsA(
          isA<TransportFailure>()
              .having((failure) => failure.code, 'code', 'UPLOAD_CANCELLED')
              .having(
                (failure) => failure.remoteOutcomeAmbiguous,
                'remoteOutcomeAmbiguous',
                isTrue,
              ),
        ),
      );
    });

    test(
      'enforces native inactivity and overall deadlines independently',
      () async {
        final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
        addTearDown(() => server.close(force: true));
        final client = IOClient();
        addTearDown(client.close);
        final requestCount = <int>[0];
        server.listen((request) async {
          requestCount[0]++;
          if (requestCount[0] == 1) {
            final subscription = request.listen((_) {});
            await Future<void>.delayed(const Duration(seconds: 2));
            await subscription.cancel();
          } else {
            try {
              await request.drain<void>();
            } on HttpException catch (error) {
              // The overall deadline intentionally aborts this request while
              // the server is still consuming its body. dart:io reports that
              // expected peer disconnect from drain(); only this exact
              // connection-close condition is part of the timeout scenario.
              if (error.message != 'Connection closed while receiving data') {
                rethrow;
              }
            }
          }
        });

        final directory = await Directory.systemTemp.createTemp(
          'sme-native-upload-deadline-',
        );
        addTearDown(() => directory.delete(recursive: true));
        final file = File('${directory.path}/audio.bin')
          ..writeAsBytesSync(List<int>.filled(1024 * 1024, 7));
        final inactivityTransport = SignedUploadTransport(
          httpClient: client,
          timeout: const Duration(seconds: 4),
          inactivityTimeout: const Duration(milliseconds: 80),
          androidDebugOverride: true,
        );
        await expectLater(
          inactivityTransport.upload(
            'http://127.0.0.1:${server.port}/inactivity',
            file,
            'audio/wav',
            expectedLength: await file.length(),
            expiresAt: DateTime.now().toUtc().add(const Duration(minutes: 5)),
          ),
          throwsA(
            isA<TransportFailure>().having(
              (failure) => failure.code,
              'code',
              'UPLOAD_INACTIVITY_TIMEOUT',
            ),
          ),
        );

        final overallTransport = SignedUploadTransport(
          httpClient: client,
          timeout: const Duration(milliseconds: 80),
          inactivityTimeout: const Duration(seconds: 2),
          androidDebugOverride: true,
        );
        await expectLater(
          overallTransport.upload(
            'http://127.0.0.1:${server.port}/overall',
            file,
            'audio/wav',
            expectedLength: await file.length(),
            expiresAt: DateTime.now().toUtc().add(const Duration(minutes: 5)),
          ),
          throwsA(
            isA<TransportFailure>().having(
              (failure) => failure.code,
              'code',
              'UPLOAD_TIMEOUT',
            ),
          ),
        );
      },
    );

    test('leaves the shared native client usable after cancellation', () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      final client = IOClient();
      addTearDown(client.close);
      final requestStarted = Completer<void>();
      server.listen((request) async {
        if (request.uri.path == '/upload') {
          requestStarted.complete();
          try {
            await request.drain<void>();
          } catch (_) {}
          return;
        }
        request.response
          ..statusCode = 200
          ..write('healthy');
        await request.response.close();
      });

      final directory = await Directory.systemTemp.createTemp(
        'sme-native-upload-client-',
      );
      addTearDown(() => directory.delete(recursive: true));
      final file = File('${directory.path}/audio.bin')
        ..writeAsBytesSync(List<int>.filled(256 * 1024, 3));
      final token = UploadCancellationToken();
      final transport = SignedUploadTransport(
        httpClient: client,
        timeout: const Duration(seconds: 5),
        inactivityTimeout: const Duration(seconds: 5),
        androidDebugOverride: true,
      );
      final upload = transport.upload(
        'http://127.0.0.1:${server.port}/upload',
        file,
        'audio/wav',
        expectedLength: await file.length(),
        expiresAt: DateTime.now().toUtc().add(const Duration(minutes: 5)),
        cancellationToken: token,
      );
      await requestStarted.future.timeout(const Duration(seconds: 2));
      token.cancel();
      await expectLater(
        upload.timeout(const Duration(seconds: 2)),
        throwsA(isA<TransportFailure>()),
      );
      final health = await client
          .get(Uri.parse('http://127.0.0.1:${server.port}/health'))
          .timeout(const Duration(seconds: 2));
      expect(health.statusCode, 200);
      expect(health.body, 'healthy');
    });
  });

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
        expectedLength: bytes.length,
        expiresAt: DateTime.now().toUtc().add(const Duration(minutes: 5)),
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

    test(
      'does not read ahead while the request body consumer is paused',
      () async {
        final directory = await Directory.systemTemp.createTemp(
          'sme-upload-backpressure-',
        );
        addTearDown(() => directory.delete(recursive: true));
        final file = File('${directory.path}/audio.bin');
        final bytes = List<int>.generate(512 * 1024, (index) => index % 251);
        await file.writeAsBytes(bytes);
        final client = PausingUploadClient();
        final transport = SignedUploadTransport(
          httpClient: client,
          androidDebugOverride: false,
        );

        final upload = transport.upload(
          'https://storage.example.test/object?signature=secret',
          file,
          'audio/wav',
          expectedLength: bytes.length,
          expiresAt: DateTime.now().toUtc().add(const Duration(minutes: 5)),
        );
        await client.firstChunk.future;
        expect(client.bytesRead, lessThan(bytes.length));
        client.resume();
        expect((await upload).statusCode, 200);
      },
    );

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
          transport.upload(
            url,
            file,
            'audio/mpeg',
            expectedLength: 3,
            expiresAt: DateTime.now().toUtc().add(const Duration(minutes: 5)),
          ),
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
        expectedLength: 3,
        expiresAt: DateTime.now().toUtc().add(const Duration(minutes: 5)),
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
          expectedLength: 3,
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
        expectedLength: 3,
        expiresAt: DateTime.now().toUtc().add(const Duration(minutes: 5)),
        cancellationToken: token,
      );
      await client.requestStarted.future;
      token.cancel();

      await expectLater(
        upload,
        throwsA(
          isA<TransportFailure>()
              .having((failure) => failure.code, 'code', 'UPLOAD_CANCELLED')
              .having(
                (failure) => failure.remoteOutcomeAmbiguous,
                'remoteOutcomeAmbiguous',
                isTrue,
              ),
        ),
      );
      expect(client.requests, hasLength(1));
      pendingResponse.complete(streamedUploadResponse(200));
    });

    test(
      'does not dispatch an upload that was cancelled before starting',
      () async {
        final directory = await Directory.systemTemp.createTemp(
          'sme-upload-pre-cancel-',
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
        final token = UploadCancellationToken()..cancel();

        await expectLater(
          transport.upload(
            'https://storage.example.test/object?signature=secret',
            file,
            'audio/wav',
            expectedLength: 3,
            expiresAt: DateTime.now().toUtc().add(const Duration(minutes: 5)),
            cancellationToken: token,
          ),
          throwsA(
            isA<TransportFailure>().having(
              (failure) => failure.code,
              'code',
              'UPLOAD_CANCELLED',
            ),
          ),
        );
        expect(client.requests, isEmpty);
      },
    );

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
          expiresAt: DateTime.now().toUtc().add(const Duration(minutes: 5)),
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
            expectedLength: 3,
            expiresAt: DateTime.now().toUtc().add(const Duration(minutes: 5)),
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
            expectedLength: 3,
            expiresAt: DateTime.now().toUtc().add(const Duration(minutes: 5)),
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
            expectedLength: 3,
            expiresAt: DateTime.now().toUtc().add(const Duration(minutes: 5)),
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
            expectedLength: 3,
            expiresAt: DateTime.now().toUtc().add(const Duration(minutes: 5)),
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
  final requestStarted = Completer<void>();
  final List<http.BaseRequest> requests = <http.BaseRequest>[];
  final List<List<int>> requestBodies = <List<int>>[];

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    requests.add(request);
    if (!requestStarted.isCompleted) requestStarted.complete();
    requestBodies.add(await request.finalize().toBytes());
    return handler(request);
  }
}

class PausingUploadClient extends http.BaseClient {
  final firstChunk = Completer<void>();
  final response = Completer<http.StreamedResponse>();
  late StreamSubscription<List<int>> subscription;
  int bytesRead = 0;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    subscription = request.finalize().listen(
      (chunk) {
        bytesRead += chunk.length;
        if (!firstChunk.isCompleted) {
          firstChunk.complete();
          subscription.pause();
        }
      },
      onError: response.completeError,
      onDone: () {
        if (!response.isCompleted) {
          response.complete(streamedUploadResponse(200));
        }
      },
    );
    return response.future;
  }

  void resume() => subscription.resume();
}
