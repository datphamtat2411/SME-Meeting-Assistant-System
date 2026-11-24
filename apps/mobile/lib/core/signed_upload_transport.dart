import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'api_transport.dart';

class UploadCancellationToken {
  final Completer<void> _cancelled = Completer<void>();

  bool get isCancelled => _cancelled.isCompleted;
  Future<void> get whenCancelled => _cancelled.future;

  void cancel() {
    if (!isCancelled) _cancelled.complete();
  }
}

typedef UploadCancelToken = UploadCancellationToken;

class SignedUploadResponse {
  SignedUploadResponse({
    required this.statusCode,
    required Map<String, String> headers,
  }) : headers = Map<String, String>.unmodifiable(headers);

  final int statusCode;
  final Map<String, String> headers;

  /// A successful object-storage response confirms transfer acknowledgement,
  /// not Core media validation or finalization.
  bool get transferConfirmed => statusCode >= 200 && statusCode < 300;
}

/// One bounded policy for a single signed PUT attempt.
class SignedUploadTimeoutPolicy {
  const SignedUploadTimeoutPolicy({
    this.maximumAttemptDuration = const Duration(minutes: 30),
    this.inactivityTimeout = const Duration(seconds: 60),
    this.minimumCapabilityValidity = const Duration(seconds: 30),
  });

  final Duration maximumAttemptDuration;
  final Duration inactivityTimeout;
  final Duration minimumCapabilityValidity;
}

/// HTTP transport for short-lived object-storage upload capabilities.
///
/// The transport has no access to authentication state. It sends one exact
/// signed PUT and only adds the content type required by that capability.
/// Requests use package:http's request-level abort trigger, which lets the
/// native IO client abort this request without closing the shared client.
class SignedUploadTransport {
  SignedUploadTransport({
    required this.httpClient,
    Duration timeout = const Duration(minutes: 30),
    Duration inactivityTimeout = const Duration(seconds: 60),
    Duration minimumCapabilityValidity = const Duration(seconds: 30),
    this.androidDebugOverride,
    DateTime Function()? now,
  }) : timeoutPolicy = SignedUploadTimeoutPolicy(
         maximumAttemptDuration: timeout,
         inactivityTimeout: inactivityTimeout,
         minimumCapabilityValidity: minimumCapabilityValidity,
       ),
       _now = now ?? DateTime.now;

  final http.Client httpClient;
  final SignedUploadTimeoutPolicy timeoutPolicy;

  /// Test-only platform input. Production callers should leave this null so
  /// local HTTP is limited to Android debug builds.
  final bool? androidDebugOverride;
  final DateTime Function() _now;

  Duration get timeout => timeoutPolicy.maximumAttemptDuration;
  Duration get inactivityTimeout => timeoutPolicy.inactivityTimeout;
  Duration get minimumCapabilityValidity =>
      timeoutPolicy.minimumCapabilityValidity;

  Future<SignedUploadResponse> upload(
    String signedUrl,
    File file,
    String contentType, {
    void Function(int sent, int total)? onProgress,
    required int expectedLength,
    required DateTime expiresAt,
    UploadCancellationToken? cancellationToken,
  }) async {
    final uri = _parseAndValidateUrl(signedUrl);
    _validateContentType(contentType);
    _validateCapabilityExpiry(expiresAt);

    final length = await _readableLength(file);
    if (length <= 0) {
      throw TransportFailure(
        0,
        'EMPTY_UPLOAD',
        'The selected audio file is empty.',
      );
    }
    if (expectedLength <= 0 || expectedLength != length) {
      throw TransportFailure(
        0,
        'UPLOAD_SIZE_MISMATCH',
        'The selected audio file changed before upload.',
      );
    }
    if (cancellationToken?.isCancelled == true) {
      throw _abortFailure(_UploadAbortReason.cancelled);
    }

    // Capability and source admission are repeated after all asynchronous
    // preparation and immediately before the native request is dispatched.
    final dispatchLength = await _readableLength(file);
    if (dispatchLength <= 0 || dispatchLength != length) {
      throw TransportFailure(
        0,
        'UPLOAD_SIZE_MISMATCH',
        'The selected audio file changed before upload.',
      );
    }
    _validateCapabilityExpiry(expiresAt);
    if (cancellationToken?.isCancelled == true) {
      throw _abortFailure(_UploadAbortReason.cancelled);
    }

    final abortTrigger = Completer<void>();
    var abortReason = _UploadAbortReason.none;
    var active = true;
    var dispatchStarted = false;
    var responseClaimed = false;
    Timer? overallTimer;
    Timer? inactivityTimer;
    var sent = 0;
    final stopwatch = Stopwatch()..start();

    void abort(_UploadAbortReason reason) {
      if (abortReason == _UploadAbortReason.none) abortReason = reason;
      if (!abortTrigger.isCompleted) abortTrigger.complete();
      active = false;
    }

    void activity() {
      if (!active) return;
      inactivityTimer?.cancel();
      inactivityTimer = Timer(inactivityTimeout, () {
        abort(_UploadAbortReason.inactivityTimeout);
      });
    }

    void reportProgress(int value) {
      if (!active) return;
      final bounded = value.clamp(0, length);
      if (bounded < sent) return;
      sent = bounded;
      try {
        onProgress?.call(sent, length);
      } catch (_) {
        // A UI progress listener must not fail the binary transfer.
      }
    }

    if (cancellationToken != null) {
      unawaited(
        cancellationToken.whenCancelled.then<void>(
          (_) => abort(_UploadAbortReason.cancelled),
        ),
      );
    }
    overallTimer = Timer(timeout, () {
      abort(_UploadAbortReason.overallTimeout);
    });
    activity();

    Stream<List<int>> monitoredFile() async* {
      try {
        await for (final chunk in file.openRead()) {
          if (!active) return;
          final next = sent + chunk.length;
          if (next > length) {
            abort(_UploadAbortReason.fileChanged);
            throw const _UploadFileChanged();
          }
          activity();
          reportProgress(next);
          yield chunk;
        }
      } on _UploadFileChanged {
        rethrow;
      } on Object {
        if (active) abort(_UploadAbortReason.sourceFailure);
        rethrow;
      }
      if (active && sent != length) {
        abort(_UploadAbortReason.fileChanged);
        throw const _UploadFileChanged();
      }
    }

    final request =
        _AbortableFileRequest(
            method: 'PUT',
            url: uri,
            body: monitoredFile(),
            abortTrigger: abortTrigger.future,
          )
          ..followRedirects = false
          ..contentLength = length
          ..headers['Content-Type'] = contentType;
    Future<http.StreamedResponse>? responseFuture;

    try {
      dispatchStarted = true;
      final pendingResponse = httpClient.send(request);
      responseFuture = pendingResponse;
      final response = await _awaitWithAbort(
        pendingResponse,
        abortTrigger.future,
      );
      responseClaimed = true;
      if (abortReason != _UploadAbortReason.none) {
        throw _abortFailure(abortReason);
      }

      await _consumeResponse(
        response,
        abortTrigger.future,
        stopwatch: stopwatch,
        onActivity: activity,
      );
      if (abortReason != _UploadAbortReason.none) {
        throw _abortFailure(abortReason);
      }

      final responseHeaders = Map<String, String>.from(response.headers);
      if (response.statusCode >= 300 && response.statusCode < 400) {
        throw TransportFailure(
          response.statusCode,
          'UNEXPECTED_REDIRECT',
          'Upload attempted an unexpected redirect.',
          responseHeaders: responseHeaders,
        );
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw TransportFailure(
          response.statusCode,
          'UPLOAD_FAILED',
          'Audio upload was rejected by storage.',
          responseHeaders: responseHeaders,
        );
      }
      reportProgress(length);
      return SignedUploadResponse(
        statusCode: response.statusCode,
        headers: responseHeaders,
      );
    } on TransportFailure {
      rethrow;
    } on _UploadFileChanged {
      if (abortReason != _UploadAbortReason.none) {
        throw _abortFailure(abortReason);
      }
      throw TransportFailure(
        0,
        'UPLOAD_FILE_CHANGED',
        'The selected audio file changed during upload.',
        remoteOutcomeAmbiguous: dispatchStarted,
      );
    } on http.RequestAbortedException {
      throw _abortFailure(
        abortReason == _UploadAbortReason.none
            ? _UploadAbortReason.overallTimeout
            : abortReason,
      );
    } on _UploadAborted {
      throw _abortFailure(
        abortReason == _UploadAbortReason.none
            ? _UploadAbortReason.overallTimeout
            : abortReason,
      );
    } on TimeoutException {
      abort(_UploadAbortReason.overallTimeout);
      throw _abortFailure(_UploadAbortReason.overallTimeout);
    } on HandshakeException {
      throw TransportFailure(
        0,
        'UPLOAD_TLS_ERROR',
        'A secure upload connection could not be established.',
        remoteOutcomeAmbiguous: true,
      );
    } on SocketException {
      throw TransportFailure(
        0,
        'UPLOAD_NETWORK_ERROR',
        'Audio upload connection lost.',
        remoteOutcomeAmbiguous: true,
      );
    } on http.ClientException {
      throw TransportFailure(
        0,
        'UPLOAD_NETWORK_ERROR',
        'Audio upload connection failed.',
        remoteOutcomeAmbiguous: true,
      );
    } on IOException {
      throw TransportFailure(
        0,
        'UPLOAD_NETWORK_ERROR',
        'Audio upload connection failed.',
        remoteOutcomeAmbiguous: true,
      );
    } on Exception {
      if (abortReason != _UploadAbortReason.none) {
        throw _abortFailure(abortReason);
      }
      throw TransportFailure(
        0,
        'UPLOAD_NETWORK_ERROR',
        'Audio upload failed.',
        remoteOutcomeAmbiguous: true,
      );
    } finally {
      active = false;
      overallTimer.cancel();
      inactivityTimer?.cancel();
      if (dispatchStarted && !responseClaimed && responseFuture != null) {
        if (abortReason == _UploadAbortReason.none) {
          abort(_UploadAbortReason.networkFailure);
        }
        unawaited(
          responseFuture.then<void>(
            (response) => _disposeResponse(response),
            onError: (Object _, StackTrace __) {},
          ),
        );
      }
      stopwatch.stop();
    }
  }

  Future<void> _consumeResponse(
    http.StreamedResponse response,
    Future<void> abortTrigger, {
    required Stopwatch stopwatch,
    required void Function() onActivity,
  }) async {
    final subscription = response.stream.listen((_) => onActivity());
    try {
      await _awaitWithAbort(subscription.asFuture<void>(), abortTrigger);
    } finally {
      await _boundedCleanup(subscription.cancel(), stopwatch);
    }
  }

  Future<void> _disposeResponse(http.StreamedResponse response) async {
    final subscription = response.stream.listen((_) {});
    try {
      await subscription.cancel();
    } catch (_) {
      // A late response is already outside the attempt's terminal outcome.
    }
  }

  Future<void> _boundedCleanup(
    Future<void> cleanup,
    Stopwatch stopwatch,
  ) async {
    final remaining = timeout - stopwatch.elapsed;
    if (remaining <= Duration.zero) return;
    try {
      await cleanup.timeout(remaining);
    } catch (_) {
      // Cleanup cannot replace an established upload outcome.
    }
  }

  Future<int> _readableLength(File file) async {
    try {
      final handle = await file.open();
      try {
        final length = await file.length();
        if (length < 0) throw const FileSystemException();
        return length;
      } finally {
        await handle.close();
      }
    } on Exception {
      throw TransportFailure(
        0,
        'UPLOAD_FILE_ERROR',
        'The selected file could not be read.',
      );
    }
  }

  Future<T> _awaitWithAbort<T>(
    Future<T> operation,
    Future<void> abortTrigger,
  ) => Future.any<T>(<Future<T>>[
    operation,
    abortTrigger.then<T>((_) => throw const _UploadAborted()),
  ]);

  void _validateContentType(String value) {
    if (value.trim().isEmpty ||
        value.trim() != value ||
        value.codeUnits.any(
          (unit) => unit < 0x20 || (unit >= 0x7f && unit <= 0x9f),
        )) {
      throw TransportFailure(
        0,
        'INVALID_UPLOAD',
        'Upload content type is required.',
      );
    }
  }

  void _validateCapabilityExpiry(DateTime expiresAt) {
    final minimum = _now().toUtc().add(minimumCapabilityValidity);
    if (!expiresAt.toUtc().isAfter(minimum)) {
      throw TransportFailure(
        0,
        'UPLOAD_CAPABILITY_EXPIRED',
        'The upload capability is expired or too close to expiration.',
      );
    }
  }

  Uri _parseAndValidateUrl(String signedUrl) {
    Uri? uri;
    try {
      if (signedUrl.isEmpty || signedUrl.trim() != signedUrl) {
        return _invalidUrl();
      }
      uri = Uri.parse(signedUrl);
    } on FormatException {
      return _invalidUrl();
    }

    final scheme = uri.scheme.toLowerCase();
    final https = scheme == 'https';
    final localHttp =
        scheme == 'http' &&
        _isAndroidDebug &&
        _isLocalDevelopmentHost(uri.host);
    if (!uri.isAbsolute ||
        !uri.hasAuthority ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty ||
        uri.hasFragment ||
        (!https && !localHttp)) {
      return _invalidUrl();
    }
    return uri;
  }

  Uri _invalidUrl() {
    throw TransportFailure(0, 'INSECURE_UPLOAD', 'Upload URL must use HTTPS.');
  }

  TransportFailure _abortFailure(_UploadAbortReason reason) {
    switch (reason) {
      case _UploadAbortReason.cancelled:
        return TransportFailure(
          0,
          'UPLOAD_CANCELLED',
          'Audio upload was cancelled.',
          remoteOutcomeAmbiguous: true,
        );
      case _UploadAbortReason.inactivityTimeout:
        return TransportFailure(
          0,
          'UPLOAD_INACTIVITY_TIMEOUT',
          'Audio upload stopped after a period without transfer progress.',
          remoteOutcomeAmbiguous: true,
        );
      case _UploadAbortReason.overallTimeout:
        return TransportFailure(
          0,
          'UPLOAD_TIMEOUT',
          'Audio upload timed out. Try again.',
          remoteOutcomeAmbiguous: true,
        );
      case _UploadAbortReason.fileChanged:
        return TransportFailure(
          0,
          'UPLOAD_FILE_CHANGED',
          'The selected audio file changed during upload.',
          remoteOutcomeAmbiguous: true,
        );
      case _UploadAbortReason.sourceFailure:
        return TransportFailure(
          0,
          'UPLOAD_SOURCE_READ_ERROR',
          'The selected audio file could not be read during upload.',
          remoteOutcomeAmbiguous: true,
        );
      case _UploadAbortReason.networkFailure:
      case _UploadAbortReason.none:
        return TransportFailure(
          0,
          'UPLOAD_NETWORK_ERROR',
          'Audio upload connection failed.',
          remoteOutcomeAmbiguous: true,
        );
    }
  }

  bool get _isAndroidDebug =>
      kDebugMode && (androidDebugOverride ?? Platform.isAndroid);

  static bool _isLocalDevelopmentHost(String host) {
    final normalizedHost = host.toLowerCase();
    if (normalizedHost == 'localhost' ||
        normalizedHost.endsWith('.localhost')) {
      return true;
    }

    final address = InternetAddress.tryParse(host);
    if (address == null) return false;
    final bytes = address.rawAddress;
    if (address.type == InternetAddressType.IPv4 && bytes.length == 4) {
      final first = bytes[0];
      final second = bytes[1];
      return first == 127 ||
          first == 10 ||
          (first == 172 && second >= 16 && second <= 31) ||
          (first == 192 && second == 168) ||
          (first == 169 && second == 254);
    }

    if (address.type == InternetAddressType.IPv6 && bytes.length == 16) {
      final isLoopback =
          bytes.take(15).every((byte) => byte == 0) && bytes.last == 1;
      final isUniqueLocal = (bytes[0] & 0xfe) == 0xfc;
      final isLinkLocal = bytes[0] == 0xfe && (bytes[1] & 0xc0) == 0x80;
      return isLoopback || isUniqueLocal || isLinkLocal;
    }
    return false;
  }
}

enum _UploadAbortReason {
  none,
  cancelled,
  inactivityTimeout,
  overallTimeout,
  fileChanged,
  sourceFailure,
  networkFailure,
}

class _UploadFileChanged implements Exception {
  const _UploadFileChanged();
}

class _UploadAborted implements Exception {
  const _UploadAborted();
}

/// A signed PUT request whose finalized body is the monitored source stream.
///
/// The inherited sink is intentionally unused. Keeping the request body on
/// [finalize] lets the native client own subscription backpressure and
/// cancellation instead of creating a producer-side buffering lifecycle.
class _AbortableFileRequest extends http.StreamedRequest with http.Abortable {
  _AbortableFileRequest({
    required String method,
    required Uri url,
    required this.body,
    required this.abortTrigger,
  }) : super(method, url);

  final Stream<List<int>> body;
  @override
  final Future<void> abortTrigger;

  @override
  http.ByteStream finalize() {
    super.finalize();
    return http.ByteStream(body);
  }
}
