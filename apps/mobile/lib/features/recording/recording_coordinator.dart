import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/widgets.dart';
import 'package:record/record.dart';

import '../../core/api_client.dart';
import '../../core/models.dart';
import '../meetings/meeting_foundation.dart';
import 'local_media_models.dart';
import 'local_media_repository.dart';

enum RecordingLifecycleState {
  idle,
  requestingPermission,
  starting,
  recording,
  stopping,
  completing,
  localReady,
  interrupted,
  failed,
  importing,
}

class RecordingCoordinatorState {
  const RecordingCoordinatorState({
    required this.lifecycle,
    this.meetingId,
    this.sessionScope,
    this.asset,
    this.elapsed = Duration.zero,
    this.importProgress,
    this.failure,
    this.message,
    this.sessionFenced = false,
  });

  final RecordingLifecycleState lifecycle;
  final String? meetingId;
  final AuthenticatedSessionScope? sessionScope;
  final LocalMediaAsset? asset;
  final Duration elapsed;
  final double? importProgress;
  final Object? failure;
  final String? message;
  final bool sessionFenced;

  bool get isCapturing =>
      lifecycle == RecordingLifecycleState.recording ||
      lifecycle == RecordingLifecycleState.starting ||
      lifecycle == RecordingLifecycleState.stopping ||
      lifecycle == RecordingLifecycleState.completing ||
      lifecycle == RecordingLifecycleState.requestingPermission;

  bool get isReady => lifecycle == RecordingLifecycleState.localReady;

  RecordingCoordinatorState copyWith({
    RecordingLifecycleState? lifecycle,
    String? meetingId,
    AuthenticatedSessionScope? sessionScope,
    LocalMediaAsset? asset,
    Duration? elapsed,
    double? importProgress,
    Object? failure,
    String? message,
    bool? sessionFenced,
    bool clearFailure = false,
    bool clearMessage = false,
    bool clearAsset = false,
  }) => RecordingCoordinatorState(
    lifecycle: lifecycle ?? this.lifecycle,
    meetingId: meetingId ?? this.meetingId,
    sessionScope: sessionScope ?? this.sessionScope,
    asset: clearAsset ? null : asset ?? this.asset,
    elapsed: elapsed ?? this.elapsed,
    importProgress: importProgress ?? this.importProgress,
    failure: clearFailure ? null : failure ?? this.failure,
    message: clearMessage ? null : message ?? this.message,
    sessionFenced: sessionFenced ?? this.sessionFenced,
  );
}

typedef RecordingState = RecordingCoordinatorState;

abstract interface class RecordingCaptureAdapter {
  Future<bool> hasPermission();

  Future<void> start(RecordConfig config, {required String path});

  Future<String?> stop();

  /// Returns `null` when the adapter cannot establish native state.
  Future<bool?> isRecording() async => null;

  Future<void> dispose();
}

class NativeRecordingCaptureAdapter implements RecordingCaptureAdapter {
  NativeRecordingCaptureAdapter({this.recorder});

  AudioRecorder? recorder;
  bool _disposedRecorder = false;
  AudioRecorder get _instance => recorder ??= AudioRecorder();

  @override
  Future<bool> hasPermission() {
    _disposedRecorder = false;
    return _instance.hasPermission();
  }

  @override
  Future<void> start(RecordConfig config, {required String path}) {
    _disposedRecorder = false;
    return _instance.start(config, path: path);
  }

  @override
  Future<String?> stop() => _instance.stop();

  @override
  Future<bool?> isRecording() async {
    if (_disposedRecorder) return false;
    final recorder = this.recorder;
    if (recorder == null) return null;
    try {
      return await recorder.isRecording();
    } on Object {
      return null;
    }
  }

  @override
  Future<void> dispose() async {
    final recorder = this.recorder;
    if (recorder == null) return;
    try {
      await recorder.dispose();
      _disposedRecorder = true;
      // Keep the reference until disposal has completed. A failed disposal
      // must leave the only usable native handle available for a controlled
      // termination retry.
      this.recorder = null;
    } catch (_) {
      _disposedRecorder = false;
      rethrow;
    }
  }
}

class AudioImportSource {
  const AudioImportSource({
    required this.name,
    required this.sizeBytes,
    required this.bytes,
    this.path,
    this.provenance,
  });

  final String name;
  final int sizeBytes;
  final Stream<List<int>> bytes;
  final String? path;
  final String? provenance;
}

typedef AudioImportPicker = Future<AudioImportSource?> Function();

Future<AudioImportSource?> pickSupportedAudioFile() async {
  final result = await FilePicker.pickFile(
    type: FileType.custom,
    allowedExtensions: <String>['wav', 'mp3', 'm4a'],
  );
  if (result == null) return null;
  final path = result.path;
  final size = await result.length();
  if (size == null) {
    throw const AudioImportException(
      'IMPORT_READ_ERROR',
      'The selected audio file could not be read.',
    );
  }
  final bytes = path == null
      ? result.readAsByteStream()
      : File(path).openRead();
  return AudioImportSource(
    name: result.name,
    sizeBytes: size,
    bytes: bytes,
    path: path,
    provenance: path == null ? null : 'picker:${result.name}:$size',
  );
}

class RecordingPermissionException implements Exception {
  const RecordingPermissionException();

  @override
  String toString() => 'Microphone permission is required to record audio.';
}

class RecordingEligibilityException implements Exception {
  const RecordingEligibilityException(this.message);

  final String message;

  @override
  String toString() => message;
}

class RecordingSessionChangedException implements Exception {
  const RecordingSessionChangedException();

  @override
  String toString() => 'The authenticated session changed during recording.';
}

class AudioImportException implements Exception {
  const AudioImportException(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => message;
}

class AudioImportLimits {
  const AudioImportLimits({
    this.maximumSizeBytes = 512 * 1024 * 1024,
    this.maximumDuration = const Duration(minutes: 90),
  });

  final int maximumSizeBytes;
  final Duration maximumDuration;
}

class RecordingAuthorizationContext {
  const RecordingAuthorizationContext({
    required this.capabilities,
    required this.status,
  });

  final MeetingCapabilities capabilities;
  final MeetingStatus status;
}

typedef RecordingCapabilityResolver =
    Future<RecordingAuthorizationContext?> Function(
      String meetingId,
      AuthenticatedSessionScope scope,
    );

/// Application-scoped owner of native capture and managed local media
/// lifecycle. It intentionally has no knowledge of upload or processing.
class RecordingCoordinator extends ChangeNotifier with WidgetsBindingObserver {
  RecordingCoordinator({
    required this.api,
    required this.localMedia,
    RecordingCaptureAdapter? capture,
    AudioImportPicker? picker,
    this.capabilityResolver,
    this.limits = const AudioImportLimits(),
    DateTime Function()? now,
    bool observeAppLifecycle = true,
  }) : _capture = capture ?? NativeRecordingCaptureAdapter(),
       _picker = picker ?? pickSupportedAudioFile,
       _now = now ?? DateTime.now {
    _state = const RecordingCoordinatorState(
      lifecycle: RecordingLifecycleState.idle,
    );
    if (observeAppLifecycle) {
      try {
        WidgetsBinding.instance.addObserver(this);
        _lifecycleObserverRegistered = true;
      } catch (_) {
        // Non-widget composition tests may construct the dependency owner
        // before a Flutter binding exists. Production main initializes it.
      }
    }
    api.addListener(_sessionChanged);
  }

  final ApiClient api;
  final LocalMediaRepository localMedia;
  final RecordingCaptureAdapter _capture;
  final AudioImportPicker _picker;
  final RecordingCapabilityResolver? capabilityResolver;
  final AudioImportLimits limits;
  final DateTime Function() _now;

  late RecordingCoordinatorState _state;
  RecordingCoordinatorState get state => _state;

  /// Returns only the state owned by the supplied authenticated meeting scope.
  /// Application-wide recording indication may use [state], but a meeting
  /// workspace must never project another meeting's command state.
  RecordingCoordinatorState stateFor({
    required String meetingId,
    required AuthenticatedSessionScope scope,
  }) {
    final current = _state;
    if (current.sessionScope != scope || current.meetingId != meetingId) {
      return RecordingCoordinatorState(
        lifecycle: RecordingLifecycleState.idle,
        meetingId: meetingId,
        sessionScope: scope,
      );
    }
    return current;
  }

  Future<void> _commandTail = Future<void>.value();
  Future<RecordingCoordinatorState>? _startFuture;
  Future<RecordingCoordinatorState>? _stopFuture;
  UploadCancellationToken? _importCancellation;
  UploadCancellationToken? _captureCancellation;
  Timer? _elapsedTimer;
  Stopwatch? _stopwatch;
  AuthenticatedSessionScope? _activeScope;
  String? _activeMeetingId;
  LocalMediaAsset? _activeAsset;
  LocalMediaAssetLease? _writerLease;
  String? _activeStagingPath;
  bool _nativeStartAttempted = false;
  MeetingCapabilities? _activeCapabilities;
  MeetingStatus? _activeMeetingStatus;
  bool _sessionInvalidated = false;
  bool _disposed = false;
  bool _shuttingDown = false;
  bool _nativeTerminationUncertain = false;
  bool _captureSizeCheckInFlight = false;
  int _captureGeneration = 0;
  bool _limitStopRequested = false;
  bool _lifecycleObserverRegistered = false;
  _RecordingCommandKind? _activeCommandKind;
  AuthenticatedSessionScope? _commandScope;
  String? _commandMeetingId;
  Future<void>? _shutdownFuture;

  bool get hasActiveWork =>
      _activeCommandKind != null ||
      _startFuture != null ||
      _stopFuture != null ||
      _activeAsset != null ||
      _nativeTerminationUncertain ||
      _state.isCapturing ||
      _state.lifecycle == RecordingLifecycleState.importing;

  Future<RecordingCoordinatorState> start({
    required String meetingId,
    required MeetingCapabilities capabilities,
    required MeetingStatus meetingStatus,
  }) {
    if (_disposed || _shuttingDown) {
      throw const RecordingEligibilityException(
        'Recording is unavailable while the application is shutting down.',
      );
    }
    if (_nativeTerminationUncertain) {
      final scope = api.requireAuthenticatedSessionScope();
      if (_activeMeetingId != meetingId || _activeScope != scope) {
        throw const RecordingEligibilityException(
          'Native recording termination is uncertain for another meeting.',
        );
      }
      // Keep the durable interrupted asset and writer protection in place.
      // The command is deliberately a no-op until native ownership becomes
      // observable as terminated; it must never start a second recorder.
      return Future<RecordingCoordinatorState>.value(_state);
    }
    final existing = _startFuture;
    if (existing != null) {
      if (_activeCommandKind == _RecordingCommandKind.capture &&
          _commandMeetingId == meetingId &&
          _commandScope == api.authenticatedSessionScope) {
        return existing;
      }
      throw const RecordingEligibilityException(
        'Another meeting already owns the active recording attempt.',
      );
    }
    if (_activeCommandKind != null ||
        _activeAsset != null ||
        _writerLease != null ||
        _nativeTerminationUncertain ||
        _state.isCapturing ||
        _state.lifecycle == RecordingLifecycleState.importing) {
      throw const RecordingEligibilityException(
        'Another recording or import operation already owns the capture resources.',
      );
    }
    final scope = api.requireAuthenticatedSessionScope();
    if (capabilityResolver == null) {
      _validateStartEligibility(capabilities, meetingStatus);
    }
    _activeScope = scope;
    _activeMeetingId = meetingId;
    _activeCapabilities = capabilities;
    _activeMeetingStatus = meetingStatus;
    _sessionInvalidated = false;
    _activeCommandKind = _RecordingCommandKind.capture;
    _commandScope = scope;
    _commandMeetingId = meetingId;
    _captureCancellation = UploadCancellationToken();
    _publish(
      RecordingCoordinatorState(
        lifecycle: RecordingLifecycleState.requestingPermission,
        meetingId: meetingId,
        sessionScope: scope,
      ),
    );
    final future = _serialize(() => _startInternal(scope));
    _startFuture = future;
    unawaited(
      future.then<void>(
        (_) => _clearFuture(future, start: true),
        onError: (Object error, StackTrace stack) {
          _clearFuture(future, start: true);
        },
      ),
    );
    return future;
  }

  Future<RecordingCoordinatorState> stop({
    String? meetingId,
    AuthenticatedSessionScope? scope,
  }) {
    if (meetingId != null && _activeMeetingId != meetingId) {
      throw const RecordingEligibilityException(
        'The requested meeting does not own the active recording.',
      );
    }
    if (scope != null && _activeScope != scope) {
      throw const RecordingSessionChangedException();
    }
    final existing = _stopFuture;
    if (existing != null) return existing;
    if (!_state.isCapturing && _activeAsset == null) {
      return Future<RecordingCoordinatorState>.value(_state);
    }
    _captureCancellation?.cancel();
    final future = _serialize(() => _stopInternal());
    _stopFuture = future;
    unawaited(
      future.then<void>(
        (_) => _clearFuture(future, start: false),
        onError: (Object error, StackTrace stack) {
          _clearFuture(future, start: false);
        },
      ),
    );
    return future;
  }

  Future<RecordingCoordinatorState> importAudio({
    required String meetingId,
    required MeetingCapabilities capabilities,
    MeetingStatus? meetingStatus,
  }) {
    if (_disposed || _shuttingDown) {
      throw const RecordingEligibilityException(
        'Audio import is unavailable while the application is shutting down.',
      );
    }
    final existing = _startFuture;
    if (existing != null) {
      if (_activeCommandKind == _RecordingCommandKind.import &&
          _commandMeetingId == meetingId &&
          _commandScope == api.authenticatedSessionScope) {
        return existing;
      }
      throw const RecordingEligibilityException(
        'Another recording or import operation already owns the capture resources.',
      );
    }
    if (_activeCommandKind != null ||
        _activeAsset != null ||
        _writerLease != null ||
        _nativeTerminationUncertain ||
        _state.isCapturing ||
        _state.lifecycle == RecordingLifecycleState.importing) {
      throw const RecordingEligibilityException(
        'Another recording or import operation already owns the capture resources.',
      );
    }
    final scope = api.requireAuthenticatedSessionScope();
    if (capabilityResolver == null &&
        !capabilities.allows(MeetingOperation.uploadMedia)) {
      throw const RecordingEligibilityException(
        'The meeting does not allow audio submission.',
      );
    }
    if (meetingStatus == MeetingStatus.cancelled) {
      throw const RecordingEligibilityException(
        'Audio import is not available for a cancelled meeting.',
      );
    }
    _activeScope = scope;
    _activeMeetingId = meetingId;
    _activeCapabilities = capabilities;
    _activeMeetingStatus = meetingStatus;
    _sessionInvalidated = false;
    _activeCommandKind = _RecordingCommandKind.import;
    _commandScope = scope;
    _commandMeetingId = meetingId;
    _importCancellation = UploadCancellationToken();
    final future = _serialize(
      () => _importInternal(scope, meetingId, meetingStatus),
    );
    _startFuture = future;
    unawaited(
      future.then<void>(
        (_) => _clearFuture(future, start: true),
        onError: (Object error, StackTrace stack) {
          _clearFuture(future, start: true);
        },
      ),
    );
    return future;
  }

  bool canCancelImport({
    required String meetingId,
    required AuthenticatedSessionScope scope,
  }) =>
      api.isCurrentAuthenticatedSession(scope) &&
      _activeCommandKind == _RecordingCommandKind.import &&
      _commandMeetingId == meetingId &&
      _commandScope == scope &&
      _importCancellation?.isCancelled == false;

  void cancelImport({String? meetingId, AuthenticatedSessionScope? scope}) {
    if (meetingId != null || scope != null) {
      if (meetingId == null ||
          scope == null ||
          !canCancelImport(meetingId: meetingId, scope: scope)) {
        return;
      }
    }
    _importCancellation?.cancel();
  }

  Future<List<LocalMediaAsset>> listLocalMedia({
    required AuthenticatedSessionScope scope,
    String? meetingId,
  }) => localMedia.listAssets(scope: scope, meetingId: meetingId);

  Future<LocalMediaAsset> discardLocalMedia({
    required AuthenticatedSessionScope scope,
    required String assetId,
  }) => localMedia.discard(scope: scope, assetId: assetId);

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.paused &&
        state != AppLifecycleState.inactive) {
      return;
    }
    if (_state.lifecycle == RecordingLifecycleState.recording ||
        _state.lifecycle == RecordingLifecycleState.starting) {
      unawaited(_interrupt('APPLICATION_CAPTURE_STATE_UNSUPPORTED'));
    }
  }

  Future<void> _interrupt(String reason) async {
    if (_activeAsset == null) return;
    try {
      final result = await stop();
      if (result.lifecycle == RecordingLifecycleState.localReady) {
        _publish(
          result.copyWith(
            lifecycle: RecordingLifecycleState.interrupted,
            message: reason,
          ),
        );
      }
    } catch (_) {
      // _stopInternal records the durable interrupted state.
    }
  }

  Future<RecordingCoordinatorState> _startInternal(
    AuthenticatedSessionScope scope,
  ) async {
    try {
      if (!await _capture.hasPermission()) {
        throw const RecordingPermissionException();
      }
      _requireCaptureAttemptActive(scope);
      api.requireCurrentAuthenticatedSession(scope);
      await _refreshAuthorization(scope, meetingId: _activeMeetingId!);
      _validateStartEligibility(_activeCapabilities!, _activeMeetingStatus!);

      final filename =
          'sme-meeting-${_now().toUtc().millisecondsSinceEpoch}.wav';
      final asset = await localMedia.reserveAsset(
        scope: scope,
        meetingId: _activeMeetingId!,
        sourceType: LocalMediaSourceType.recording,
        originalFilename: filename,
        contentType: 'audio/wav',
        sourceProvenance:
            'capture:${scope.deploymentScope}:${scope.userId}:'
            '${scope.lifecycleEpoch}:$_activeMeetingId:$filename',
      );
      _activeAsset = asset;
      _writerLease = await localMedia.stagingLeaseFor(
        scope: scope,
        asset: asset,
      );
      _activeStagingPath = _writerLease!.file.path;
      _publish(_state.copyWith(lifecycle: RecordingLifecycleState.starting));
      _requireCaptureAttemptActive(scope);
      api.requireCurrentAuthenticatedSession(scope);
      await _refreshAuthorization(scope, meetingId: _activeMeetingId!);
      _requireCaptureAttemptActive(scope);
      _validateStartEligibility(_activeCapabilities!, _activeMeetingStatus!);
      _nativeStartAttempted = true;
      await _capture.start(
        const RecordConfig(
          encoder: AudioEncoder.wav,
          sampleRate: 16000,
          numChannels: 1,
        ),
        path: _activeStagingPath!,
      );
      // Permission, capability, and session checks may have completed while
      // the native recorder was starting. A cancelled late start is terminated
      // before it can be published as an active capture.
      _requireCaptureAttemptActive(scope);
      _stopwatch = Stopwatch()..start();
      _elapsedTimer = Timer.periodic(
        const Duration(milliseconds: 250),
        (_) => _captureLimitTick(),
      );
      _publish(
        _state.copyWith(
          lifecycle: RecordingLifecycleState.recording,
          elapsed: Duration.zero,
          message: null,
          clearMessage: true,
          clearFailure: true,
        ),
      );
      return _state;
    } catch (error) {
      final fenced = _sessionInvalidated;
      final cancelled = _captureCancellation?.isCancelled == true;
      final terminated = await _terminateNativeCapture();
      if (terminated) {
        await _markActiveInterrupted('RECORDING_START_FAILED');
        _resetCapture();
      }
      _publish(
        _state.copyWith(
          lifecycle: cancelled || fenced
              ? RecordingLifecycleState.interrupted
              : RecordingLifecycleState.failed,
          failure: error,
          sessionFenced: fenced,
          message: cancelled
              ? 'Recording start was cancelled.'
              : fenced
              ? 'Recording start was stopped after the session changed.'
              : 'Recording could not be started.',
        ),
      );
      rethrow;
    }
  }

  Future<RecordingCoordinatorState> _stopInternal() async {
    final asset = _activeAsset;
    final scope = _activeScope;
    if (asset == null || scope == null) return _state;
    _publish(_state.copyWith(lifecycle: RecordingLifecycleState.stopping));
    String? stoppedPath;
    try {
      stoppedPath = await _capture.stop().timeout(const Duration(seconds: 5));
      if ((await _capture.isRecording().timeout(const Duration(seconds: 5))) !=
          false) {
        throw const FileSystemException(
          'Native recording remained active after stop.',
        );
      }
      _elapsedTimer?.cancel();
      _stopwatch?.stop();
      _publish(_state.copyWith(lifecycle: RecordingLifecycleState.completing));
      if (stoppedPath == null ||
          !_samePath(stoppedPath, _activeStagingPath ?? '')) {
        throw const FileSystemException(
          'The recorder did not return the reserved managed destination.',
        );
      }
      if (_sessionInvalidated) {
        // Local completion remains bound to the original owner. It is never
        // published as active state to the new account.
        final completed = await _completeLocal(scope, asset, stoppedPath);
        _resetCapture();
        _publish(
          RecordingCoordinatorState(
            lifecycle: RecordingLifecycleState.interrupted,
            asset: completed,
            meetingId: asset.meetingId,
            sessionScope: scope,
            sessionFenced: true,
            message: 'Recording was saved under the original session.',
          ),
        );
        return _state;
      }
      final completed = await _completeLocal(scope, asset, stoppedPath);
      final elapsed = _stopwatch?.elapsed ?? Duration.zero;
      _resetCapture();
      _publish(
        RecordingCoordinatorState(
          lifecycle: RecordingLifecycleState.localReady,
          asset: completed,
          meetingId: completed.meetingId,
          sessionScope: scope,
          elapsed: elapsed,
        ),
      );
      return _state;
    } catch (error) {
      final terminated = await _terminateNativeCapture();
      if (terminated) {
        _elapsedTimer?.cancel();
        _stopwatch?.stop();
        await _markActiveInterrupted(
          error is FileSystemException
              ? 'RECORDING_COMPLETION_FAILED'
              : 'RECORDING_STOP_FAILED',
        );
        _resetCapture();
      }
      _publish(
        RecordingCoordinatorState(
          lifecycle: RecordingLifecycleState.interrupted,
          asset: asset,
          meetingId: asset.meetingId,
          sessionScope: scope,
          failure: error,
          sessionFenced: _sessionInvalidated,
          message: terminated
              ? 'Recording was interrupted and remains recoverable.'
              : 'Native recording termination is uncertain; capture remains blocked.',
        ),
      );
      rethrow;
    }
  }

  Future<LocalMediaAsset> _completeLocal(
    AuthenticatedSessionScope scope,
    LocalMediaAsset asset,
    String stoppedPath,
  ) async {
    final file = File(stoppedPath);
    if (!await file.exists()) {
      throw const FileSystemException('The recorded file is missing.');
    }
    final size = await file.length();
    if (size <= 0 || size > limits.maximumSizeBytes) {
      throw const FileSystemException(
        'The recorded file exceeded local limits.',
      );
    }
    final completed = await localMedia.confirmFileCompletion(
      scope: scope,
      assetId: asset.id,
      expectedSizeBytes: size,
      writerLease: _writerLease,
    );
    if (!completed.isReady) {
      throw const FileSystemException(
        'The recorded file was not completed as ready managed media.',
      );
    }
    return completed;
  }

  Future<RecordingCoordinatorState> _importInternal(
    AuthenticatedSessionScope scope,
    String meetingId,
    MeetingStatus? fallbackStatus,
  ) async {
    AudioImportSource? source;
    final cancellation = _importCancellation ?? UploadCancellationToken();
    _importCancellation = cancellation;
    try {
      _publish(
        RecordingCoordinatorState(
          lifecycle: RecordingLifecycleState.importing,
          meetingId: meetingId,
          sessionScope: scope,
          importProgress: 0,
        ),
      );
      source = await _picker();
      if (source == null) {
        _publish(
          const RecordingCoordinatorState(
            lifecycle: RecordingLifecycleState.idle,
          ),
        );
        return _state;
      }
      final selectedSource = source;
      if (cancellation.isCancelled) {
        throw const AudioImportException(
          'IMPORT_CANCELLED',
          'Audio import was cancelled.',
        );
      }
      api.requireCurrentAuthenticatedSession(scope);
      final authorization = await _refreshAuthorization(
        scope,
        meetingId: meetingId,
      );
      api.requireCurrentAuthenticatedSession(scope);
      if (cancellation.isCancelled) {
        throw const AudioImportException(
          'IMPORT_CANCELLED',
          'Audio import was cancelled.',
        );
      }
      _validateImportEligibility(
        _activeCapabilities!,
        authorization?.status ?? fallbackStatus,
      );
      final contentType = _contentTypeFor(selectedSource.name);
      if (selectedSource.sizeBytes <= 0) {
        throw const AudioImportException(
          'EMPTY_AUDIO',
          'The selected audio file is empty.',
        );
      }
      if (selectedSource.sizeBytes > limits.maximumSizeBytes) {
        throw const AudioImportException(
          'AUDIO_TOO_LARGE',
          'The selected audio file exceeds the local size limit.',
        );
      }
      var consumed = 0;
      final monitored = selectedSource.bytes.transform(
        StreamTransformer<List<int>, List<int>>.fromHandlers(
          handleData: (chunk, output) {
            if (cancellation.isCancelled) {
              throw const AudioImportException(
                'IMPORT_CANCELLED',
                'Audio import was cancelled.',
              );
            }
            if (!api.isCurrentAuthenticatedSession(scope)) {
              throw const RecordingSessionChangedException();
            }
            consumed += chunk.length;
            if (consumed > selectedSource.sizeBytes) {
              throw const AudioImportException(
                'IMPORT_SIZE_MISMATCH',
                'The selected audio changed while it was being imported.',
              );
            }
            _publish(
              _state.copyWith(
                importProgress: selectedSource.sizeBytes == 0
                    ? null
                    : consumed / selectedSource.sizeBytes,
              ),
            );
            output.add(chunk);
          },
        ),
      );
      final provenance =
          selectedSource.provenance ??
          'picker:${selectedSource.name}:${selectedSource.sizeBytes}';
      _requireImportAttemptActive(scope, meetingId);
      final asset = await localMedia.importStream(
        scope: scope,
        meetingId: meetingId,
        bytes: monitored,
        expectedSizeBytes: selectedSource.sizeBytes,
        sourceType: LocalMediaSourceType.importFile,
        originalFilename: selectedSource.name,
        contentType: contentType,
        sourceProvenance: provenance,
        cancellationToken: cancellation,
      );
      if (consumed != selectedSource.sizeBytes) {
        throw const AudioImportException(
          'IMPORT_SIZE_MISMATCH',
          'The selected audio was not completely consumed.',
        );
      }
      api.requireCurrentAuthenticatedSession(scope);
      _requireImportAttemptActive(scope, meetingId);
      _publish(
        RecordingCoordinatorState(
          lifecycle: RecordingLifecycleState.localReady,
          meetingId: meetingId,
          sessionScope: scope,
          asset: asset,
          importProgress: 1,
        ),
      );
      return _state;
    } catch (error) {
      final fenced = !api.isCurrentAuthenticatedSession(scope);
      _publish(
        RecordingCoordinatorState(
          lifecycle: fenced
              ? RecordingLifecycleState.interrupted
              : RecordingLifecycleState.failed,
          meetingId: meetingId,
          sessionScope: scope,
          failure: error,
          sessionFenced: fenced,
          message: fenced
              ? 'Import was stopped after the session changed.'
              : 'Audio import failed.',
        ),
      );
      rethrow;
    } finally {
      if (identical(_activeScope, scope) && _activeAsset == null) {
        _importCancellation = null;
        _activeScope = null;
        _activeMeetingId = null;
        _sessionInvalidated = false;
        _activeCapabilities = null;
        _activeMeetingStatus = null;
        _activeCommandKind = null;
        _commandScope = null;
        _commandMeetingId = null;
      }
    }
  }

  void _validateStartEligibility(
    MeetingCapabilities capabilities,
    MeetingStatus status,
  ) {
    if (!capabilities.allows(MeetingOperation.uploadMedia) ||
        status != MeetingStatus.inProgress) {
      throw const RecordingEligibilityException(
        'Recording is available only to an authorized organizer while the meeting is in progress.',
      );
    }
  }

  Future<RecordingAuthorizationContext?> _refreshAuthorization(
    AuthenticatedSessionScope scope, {
    required String meetingId,
  }) async {
    final resolver = capabilityResolver;
    if (resolver == null) return null;
    api.requireCurrentAuthenticatedSession(scope);
    final current = await resolver(meetingId, scope);
    if (current == null) {
      throw const RecordingEligibilityException(
        'Current meeting authorization is unavailable.',
      );
    }
    _activeCapabilities = current.capabilities;
    _activeMeetingStatus = current.status;
    api.requireCurrentAuthenticatedSession(scope);
    return current;
  }

  void _validateImportEligibility(
    MeetingCapabilities capabilities,
    MeetingStatus? status,
  ) {
    if (!capabilities.allows(MeetingOperation.uploadMedia) ||
        status == MeetingStatus.cancelled) {
      throw const RecordingEligibilityException(
        'The meeting does not allow audio submission.',
      );
    }
  }

  Future<void> _markActiveInterrupted(String reason) async {
    final asset = _activeAsset;
    final scope = _activeScope;
    if (asset == null || scope == null) return;
    try {
      await localMedia.recordInterruption(
        scope: scope,
        assetId: asset.id,
        reason: reason,
        writerLease: _writerLease,
      );
    } catch (_) {}
  }

  void _sessionChanged() {
    final scope = _activeScope;
    if (scope == null || api.isCurrentAuthenticatedSession(scope)) return;
    if (_sessionInvalidated) return;
    _sessionInvalidated = true;
    _captureCancellation?.cancel();
    _importCancellation?.cancel();
    _publish(
      const RecordingCoordinatorState(
        lifecycle: RecordingLifecycleState.idle,
        sessionFenced: true,
        message:
            'The recording state is unavailable after the session changed.',
      ),
    );
    if (_activeAsset != null) unawaited(_interrupt('AUTH_SESSION_CHANGED'));
  }

  void _requireCaptureAttemptActive(AuthenticatedSessionScope scope) {
    if (_captureCancellation?.isCancelled == true) {
      throw const RecordingEligibilityException(
        'The recording attempt was cancelled.',
      );
    }
    api.requireCurrentAuthenticatedSession(scope);
  }

  void _requireImportAttemptActive(
    AuthenticatedSessionScope scope,
    String meetingId,
  ) {
    if (_activeCommandKind != _RecordingCommandKind.import ||
        _commandScope != scope ||
        _commandMeetingId != meetingId ||
        _importCancellation?.isCancelled == true) {
      throw const AudioImportException(
        'IMPORT_CANCELLED',
        'Audio import was cancelled.',
      );
    }
    api.requireCurrentAuthenticatedSession(scope);
  }

  void _captureLimitTick() {
    if (_state.lifecycle != RecordingLifecycleState.recording ||
        _stopwatch == null ||
        _limitStopRequested) {
      return;
    }
    final elapsed = _stopwatch!.elapsed;
    if (elapsed >= limits.maximumDuration) {
      unawaited(_stopForLimit('MAXIMUM_RECORDING_DURATION'));
      return;
    }
    _publish(_state.copyWith(elapsed: elapsed));
    if (!_captureSizeCheckInFlight) {
      unawaited(_checkCaptureSize());
    }
  }

  Future<void> _checkCaptureSize() async {
    final path = _activeStagingPath;
    final assetId = _activeAsset?.id;
    final generation = _captureGeneration;
    if (path == null || assetId == null || _captureSizeCheckInFlight) return;
    _captureSizeCheckInFlight = true;
    try {
      final size = await File(path).length();
      if (_captureGeneration == generation &&
          _activeAsset?.id == assetId &&
          _activeStagingPath == path &&
          _state.lifecycle == RecordingLifecycleState.recording &&
          size >= limits.maximumSizeBytes) {
        await _stopForLimit('MAXIMUM_RECORDING_SIZE');
      }
    } on FileSystemException {
      // Native recording remains the source of truth for storage failures.
      // Completion will preserve the staged bytes as interrupted media.
    } finally {
      if (_captureGeneration == generation) {
        _captureSizeCheckInFlight = false;
      }
    }
  }

  Future<void> _stopForLimit(String reason) async {
    if (_state.lifecycle != RecordingLifecycleState.recording ||
        _limitStopRequested) {
      return;
    }
    _limitStopRequested = true;
    try {
      final stopped = await stop();
      if (_state.lifecycle == RecordingLifecycleState.localReady) {
        _publish(stopped.copyWith(message: reason));
      }
    } catch (_) {
      // The command records the durable interruption. Consume this timer
      // callback's failure so it cannot become an unhandled async error.
    }
  }

  Future<bool> _terminateNativeCapture() async {
    if (!_nativeStartAttempted) {
      _nativeTerminationUncertain = false;
      return true;
    }
    var terminationKnown = false;
    try {
      await _capture.stop().timeout(const Duration(seconds: 5));
    } catch (_) {}
    try {
      terminationKnown =
          (await _capture.isRecording().timeout(const Duration(seconds: 5))) ==
          false;
    } catch (_) {
      terminationKnown = false;
    }
    if (terminationKnown) {
      _nativeTerminationUncertain = false;
      return true;
    }
    // A few native implementations release their recorder only during
    // disposal. Disposal is a controlled fallback, not termination evidence.
    try {
      await _capture.dispose().timeout(const Duration(seconds: 5));
    } catch (_) {
      return false;
    }
    try {
      final terminated =
          (await _capture.isRecording().timeout(const Duration(seconds: 5))) ==
          false;
      _nativeTerminationUncertain = !terminated;
      return terminated;
    } catch (_) {
      _nativeTerminationUncertain = true;
      return false;
    }
  }

  Future<T> _serialize<T>(Future<T> Function() action) {
    final previous = _commandTail;
    final release = Completer<void>();
    _commandTail = release.future;
    return () async {
      await previous.catchError((_) {});
      try {
        return await action();
      } finally {
        release.complete();
      }
    }();
  }

  void _clearFuture(
    Future<RecordingCoordinatorState> future, {
    required bool start,
  }) {
    if (start) {
      if (identical(_startFuture, future)) _startFuture = null;
    } else {
      if (identical(_stopFuture, future)) _stopFuture = null;
    }
  }

  void _resetCapture() {
    _captureGeneration++;
    _elapsedTimer?.cancel();
    _elapsedTimer = null;
    _stopwatch = null;
    _activeScope = null;
    _activeMeetingId = null;
    _activeAsset = null;
    _writerLease = null;
    _activeStagingPath = null;
    _nativeStartAttempted = false;
    _nativeTerminationUncertain = false;
    _captureSizeCheckInFlight = false;
    _limitStopRequested = false;
    _activeCapabilities = null;
    _activeMeetingStatus = null;
    _sessionInvalidated = false;
    _captureCancellation = null;
    _activeCommandKind = null;
    _commandScope = null;
    _commandMeetingId = null;
  }

  void _publish(RecordingCoordinatorState next) {
    if (_disposed) return;
    final scope = next.sessionScope;
    if (scope != null && !api.isCurrentAuthenticatedSession(scope)) {
      _state = const RecordingCoordinatorState(
        lifecycle: RecordingLifecycleState.idle,
        sessionFenced: true,
        message:
            'The recording state is unavailable after the session changed.',
      );
      notifyListeners();
      return;
    }
    _state = next;
    notifyListeners();
  }

  static String _contentTypeFor(String filename) {
    final lower = filename.toLowerCase();
    if (lower.endsWith('.wav')) return 'audio/wav';
    if (lower.endsWith('.mp3')) return 'audio/mpeg';
    if (lower.endsWith('.m4a')) return 'audio/mp4';
    throw const AudioImportException(
      'UNSUPPORTED_AUDIO',
      'Only WAV, MP3, and M4A audio files are supported.',
    );
  }

  static bool _samePath(String first, String second) =>
      File(first).absolute.path == File(second).absolute.path;

  @override
  void dispose() {
    if (_disposed) return;
    beginShutdown();
    unawaited(shutdown());
    _disposed = true;
    api.removeListener(_sessionChanged);
    if (_lifecycleObserverRegistered) {
      WidgetsBinding.instance.removeObserver(this);
    }
    _elapsedTimer?.cancel();
    _importCancellation?.cancel();
    _captureCancellation?.cancel();
    super.dispose();
  }

  /// Fences new commands and cancellation-sensitive work synchronously.
  /// [shutdown] performs the bounded native cleanup before persistence closes.
  void beginShutdown() {
    if (_shuttingDown) return;
    _shuttingDown = true;
    _elapsedTimer?.cancel();
    _importCancellation?.cancel();
    _captureCancellation?.cancel();
  }

  Future<void> shutdown() {
    final existing = _shutdownFuture;
    if (existing != null) return existing;
    final future = () async {
      beginShutdown();
      try {
        final pendingStart = _startFuture;
        final pendingStop = _stopFuture;
        if (_activeAsset != null ||
            _state.isCapturing ||
            pendingStart != null) {
          try {
            if (_activeAsset != null || _state.isCapturing) {
              await stop().timeout(const Duration(seconds: 6));
            }
          } catch (_) {
            // Durable interruption/reconciliation state is retained by the
            // coordinator and repository when native termination is unknown.
          }
        }
        for (final pending in <Future<RecordingCoordinatorState>?>[
          pendingStart,
          pendingStop,
          _startFuture,
          _stopFuture,
        ]) {
          if (pending == null) continue;
          try {
            await pending.timeout(const Duration(seconds: 6));
          } catch (_) {}
        }
        try {
          await _capture.dispose().timeout(const Duration(seconds: 6));
        } catch (_) {}
      } finally {
        _elapsedTimer?.cancel();
      }
    }();
    _shutdownFuture = future;
    return future;
  }

  static String randomIdentity() {
    final random = Random.secure();
    return List<int>.generate(
      16,
      (_) => random.nextInt(256),
    ).map((value) => value.toRadixString(16).padLeft(2, '0')).join();
  }
}

enum _RecordingCommandKind { capture, import }
