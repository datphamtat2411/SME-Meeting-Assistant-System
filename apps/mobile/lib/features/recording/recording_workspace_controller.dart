import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/api_client.dart';
import '../../core/models.dart';
import '../meetings/meeting_foundation.dart';
import 'local_media_models.dart';
import 'local_media_repository.dart';
import 'media_contracts.dart';
import 'processing_manager.dart';
import 'recording_coordinator.dart';
import 'submission_coordinator.dart';

enum RecordingWorkspaceLoadState { idle, loading, ready, failed }

/// Presentation projection for one meeting's recording lifecycle.
///
/// Functional work remains owned by the application-scoped coordinators. This
/// controller only scopes their observable state to a meeting/session and
/// fences presentation commands when that scope changes.
class RecordingWorkspaceController extends ChangeNotifier {
  RecordingWorkspaceController({
    required this.api,
    required this.meetingId,
    required this.localMedia,
    required this.recording,
    required this.submissions,
    required this.processingManager,
    this.capabilities,
    this.meetingStatus,
  }) {
    _sessionScope = api.authenticatedSessionScope;
    recording.addListener(_functionalStateChanged);
    submissions.addListener(_functionalStateChanged);
    processingManager.addListener(_functionalStateChanged);
    api.addListener(_sessionChanged);
  }

  final ApiClient api;
  final LocalMediaRepository localMedia;
  final RecordingCoordinator recording;
  final SubmissionCoordinator submissions;
  final ProcessingManager processingManager;

  String meetingId;
  MeetingCapabilities? capabilities;
  MeetingStatus? meetingStatus;

  AuthenticatedSessionScope? _sessionScope;
  RecordingWorkspaceLoadState _loadState = RecordingWorkspaceLoadState.idle;
  List<LocalMediaAsset> _assets = const <LocalMediaAsset>[];
  List<SubmissionState> _recoverableOperations = const <SubmissionState>[];
  LocalMediaAsset? _selectedAsset;
  SubmissionState? _selectedSubmission;
  ProcessingMeetingState? _remoteState;
  Object? _failure;
  Object? _warning;
  String? _pendingAction;
  ProcessingObservation? _observation;
  int _generation = 0;
  bool _disposed = false;

  RecordingWorkspaceLoadState get loadState => _loadState;
  List<LocalMediaAsset> get assets => List.unmodifiable(_assets);
  List<SubmissionState> get recoverableOperations =>
      List.unmodifiable(_recoverableOperations);
  LocalMediaAsset? get selectedAsset => _selectedAsset;
  SubmissionState? get selectedSubmission => _selectedSubmission;
  ProcessingMeetingState? get remoteState => _remoteState;
  Object? get failure => _failure;
  Object? get warning => _warning;
  String? get pendingAction => _pendingAction;
  AuthenticatedSessionScope? get sessionScope => _sessionScope;
  bool get isSessionFenced =>
      _sessionScope == null ||
      !api.isCurrentAuthenticatedSession(_sessionScope!);
  bool get canReadMedia =>
      !isSessionFenced &&
      capabilities?.allows(MeetingOperation.readMedia) == true;
  bool get canUpload =>
      !isSessionFenced &&
      capabilities?.allows(MeetingOperation.uploadMedia) == true;
  bool get canAdmitProcessing =>
      !isSessionFenced &&
      capabilities?.allows(MeetingOperation.admitProcessing) == true;
  bool get canRetryProcessing =>
      !isSessionFenced &&
      capabilities?.allows(MeetingOperation.retryProcessing) == true;
  bool get isBusy => _pendingAction != null;

  RecordingCoordinatorState get recordingState {
    final scope = _sessionScope;
    if (scope == null || isSessionFenced) {
      return RecordingCoordinatorState(
        lifecycle: RecordingLifecycleState.idle,
        meetingId: meetingId,
        sessionScope: scope,
        sessionFenced: true,
      );
    }
    return recording.stateFor(meetingId: meetingId, scope: scope);
  }

  void updateContext({
    required String meetingId,
    MeetingCapabilities? capabilities,
    MeetingStatus? meetingStatus,
  }) {
    if (_disposed) return;
    final changed =
        this.meetingId != meetingId ||
        _capabilityKey(this.capabilities) != _capabilityKey(capabilities) ||
        this.meetingStatus != meetingStatus;
    if (!changed) return;
    final meetingChanged = this.meetingId != meetingId;
    this.meetingId = meetingId;
    this.capabilities = capabilities;
    this.meetingStatus = meetingStatus;
    if (meetingChanged) {
      _observation?.dispose();
      _observation = null;
      _fencePresentation();
      _startObservationIfAllowed();
      unawaited(load());
    } else {
      if (!canReadMedia) {
        _observation?.dispose();
        _observation = null;
      }
      _startObservationIfAllowed();
      _functionalStateChanged();
    }
  }

  Future<void> initialize() async {
    _startObservationIfAllowed();
    await load();
  }

  Future<void> load() async {
    if (_disposed || isSessionFenced) return;
    final scope = _sessionScope!;
    final meeting = meetingId;
    final generation = ++_generation;
    _loadState = RecordingWorkspaceLoadState.loading;
    _failure = null;
    notifyListeners();
    Object? recoveryFailure;
    try {
      await localMedia.recoverLocalState(scope: scope, meetingId: meeting);
    } catch (error) {
      recoveryFailure = error;
    }
    try {
      final recovered = await submissions.recoverDurableState(
        scope: scope,
        meetingId: meeting,
      );
      final listed = await localMedia.listAssets(
        scope: scope,
        meetingId: meeting,
      );
      if (!_owns(generation, scope, meeting)) return;
      _assets = listed
          .where((asset) => asset.isRecoverable)
          .toList(growable: false);
      _recoverableOperations = recovered;
      if (_selectedAsset != null &&
          !_assets.any((asset) => asset.id == _selectedAsset!.id)) {
        _selectedAsset = null;
      }
      _selectedAsset ??= _findAssetForRecovery(recovered);
      _selectedSubmission = _selectedAsset == null
          ? null
          : submissions.stateFor(_selectedAsset!.id);
      _loadState = RecordingWorkspaceLoadState.ready;
      _failure = recoveryFailure;
      notifyListeners();
    } catch (error) {
      if (!_owns(generation, scope, meeting)) return;
      _loadState = RecordingWorkspaceLoadState.failed;
      _failure = recoveryFailure ?? error;
      notifyListeners();
    }
  }

  void selectAsset(LocalMediaAsset? asset) {
    if (_disposed ||
        asset == null ||
        !_assets.any((item) => item.id == asset.id)) {
      return;
    }
    _selectedAsset = asset;
    _selectedSubmission = submissions.stateFor(asset.id);
    _warning = null;
    notifyListeners();
  }

  Future<void> startRecording() async {
    if (!_beginAction('recording')) return;
    final scope = _sessionScope;
    try {
      if (scope == null || !api.isCurrentAuthenticatedSession(scope)) return;
      await recording.start(
        meetingId: meetingId,
        capabilities:
            capabilities ??
            (throw const ApiFailure(
              403,
              'MEDIA_CAPABILITY_REQUIRED',
              'Recording authorization is unavailable.',
            )),
        meetingStatus:
            meetingStatus ??
            (throw const RecordingEligibilityException(
              'The current meeting state is unavailable.',
            )),
      );
      await load();
    } catch (error) {
      _setActionFailure(scope, error);
    } finally {
      _endAction('recording');
    }
  }

  Future<void> stopRecording() async {
    if (!_beginAction('recording')) return;
    final scope = _sessionScope;
    try {
      if (scope == null || !api.isCurrentAuthenticatedSession(scope)) return;
      await recording.stop(meetingId: meetingId, scope: scope);
      await load();
      final asset = recording
          .stateFor(meetingId: meetingId, scope: scope)
          .asset;
      if (_owns(_generation, scope, meetingId) && asset?.isReady == true) {
        _selectedAsset = asset;
        _selectedSubmission = submissions.stateFor(asset!.id);
        notifyListeners();
      }
    } catch (error) {
      _setActionFailure(scope, error);
    } finally {
      _endAction('recording');
    }
  }

  Future<void> importAudio() async {
    if (!_beginAction('import')) return;
    final scope = _sessionScope;
    try {
      if (scope == null || !api.isCurrentAuthenticatedSession(scope)) return;
      await recording.importAudio(
        meetingId: meetingId,
        meetingStatus: meetingStatus,
        capabilities:
            capabilities ??
            (throw const ApiFailure(
              403,
              'MEDIA_CAPABILITY_REQUIRED',
              'Import authorization is unavailable.',
            )),
      );
      await load();
      final asset = recording
          .stateFor(meetingId: meetingId, scope: scope)
          .asset;
      if (_owns(_generation, scope, meetingId) && asset?.isReady == true) {
        selectAsset(asset);
      }
    } catch (error) {
      _setActionFailure(scope, error);
    } finally {
      _endAction('import');
    }
  }

  Future<void> submitSelected() async {
    final asset = _selectedAsset;
    final scope = _sessionScope;
    if (asset == null || !asset.isReady || !_beginAction('submission')) return;
    try {
      if (scope == null || !api.isCurrentAuthenticatedSession(scope)) return;
      final existing = submissions.stateFor(asset.id);
      final operation = existing?.uploadOperation;
      final result = operation == null
          ? await submissions.submit(
              asset: asset,
              capabilities: capabilities,
              admitProcessing: canAdmitProcessing,
            )
          : await submissions.resume(
              operationId: operation.id,
              scope: scope,
              capabilities: capabilities,
              admitProcessing: canAdmitProcessing,
            );
      if (_owns(_generation, scope, meetingId) &&
          _selectedAsset?.id == asset.id) {
        _selectedSubmission = result;
        notifyListeners();
      }
    } catch (error) {
      _setActionFailure(scope, error);
    } finally {
      _endAction('submission');
    }
  }

  void cancelSubmission() {
    final asset = _selectedAsset;
    if (asset == null || _disposed) return;
    submissions.cancel(asset.id);
  }

  Future<void> discardAsset(LocalMediaAsset asset) async {
    final scope = _sessionScope;
    if (scope == null || !api.isCurrentAuthenticatedSession(scope)) return;
    if (!_beginAction('discard')) return;
    try {
      await localMedia.discard(scope: scope, assetId: asset.id);
      if (_selectedAsset?.id == asset.id) {
        _selectedAsset = null;
        _selectedSubmission = null;
      }
      await load();
    } catch (error) {
      _setActionFailure(scope, error);
    } finally {
      _endAction('discard');
    }
  }

  Future<void> admitRemoteMedia(MediaRecord media) async {
    final scope = _sessionScope;
    if (scope == null ||
        !canAdmitProcessing ||
        !api.isCurrentAuthenticatedSession(scope) ||
        !_beginAction('processing')) {
      return;
    }
    try {
      final result = await submissions.admitAvailableMedia(
        meetingId: meetingId,
        mediaId: media.id,
        scope: scope,
        capabilities: capabilities,
      );
      if (_owns(_generation, scope, meetingId)) {
        _selectedSubmission = result;
        notifyListeners();
      }
    } catch (error) {
      _setActionFailure(scope, error);
    } finally {
      _endAction('processing');
    }
  }

  /// Resumes exactly the durable operation represented by the recovery row.
  /// The coordinators decide whether that means remote reconciliation,
  /// processing-only admission, or a transfer that still needs local bytes.
  Future<void> resumeRecovery(SubmissionState state) async {
    final scope = _sessionScope;
    if (scope == null ||
        !api.isCurrentAuthenticatedSession(scope) ||
        !_beginAction('recovery')) {
      return;
    }
    try {
      final upload = state.uploadOperation;
      if (upload != null) {
        final result = await submissions.resume(
          operationId: upload.id,
          scope: scope,
          capabilities: capabilities,
          admitProcessing: canAdmitProcessing,
        );
        if (_owns(_generation, scope, meetingId)) {
          _selectedSubmission = result;
          notifyListeners();
        }
        return;
      }
      final operation = state.processingOperation;
      if (operation == null || operation.sourceMediaId == null) return;
      if (operation.operationType == ProcessingOperationType.admission) {
        final result = await submissions.admitAvailableMedia(
          meetingId: meetingId,
          mediaId: operation.sourceMediaId!,
          scope: scope,
          capabilities: capabilities,
        );
        if (_owns(_generation, scope, meetingId)) {
          _selectedSubmission = result;
          notifyListeners();
        }
        return;
      }
      final targetId = operation.targetJobId ?? operation.reprocessOfJobId;
      final target = targetId == null
          ? null
          : _remoteState?.jobs.where((job) => job.id == targetId).firstOrNull;
      if (target == null) {
        _warning = 'Tác vụ xử lý cần làm mới để xác định nguồn khôi phục.';
        notifyListeners();
        return;
      }
      if (operation.operationType == ProcessingOperationType.retry) {
        await processingManager.retryJob(
          job: target,
          scope: scope,
          capabilities: capabilities,
        );
      } else {
        await processingManager.reprocess(
          parent: target,
          sourceMediaId: operation.sourceMediaId!,
          scope: scope,
          capabilities: capabilities,
        );
      }
    } catch (error) {
      _setActionFailure(scope, error);
    } finally {
      _endAction('recovery');
    }
  }

  Future<void> retryProcessing(ProcessingJobRecord job) async {
    final scope = _sessionScope;
    if (scope == null || !canRetryProcessing || !_beginAction('retry')) {
      return;
    }
    try {
      await processingManager.retryJob(
        job: job,
        scope: scope,
        capabilities: capabilities,
      );
    } catch (error) {
      _setActionFailure(scope, error);
    } finally {
      _endAction('retry');
    }
  }

  Future<void> reprocess(
    ProcessingJobRecord job, {
    required String sourceMediaId,
  }) async {
    final scope = _sessionScope;
    if (scope == null || !canAdmitProcessing || !_beginAction('reprocess')) {
      return;
    }
    try {
      await processingManager.reprocess(
        parent: job,
        sourceMediaId: sourceMediaId,
        scope: scope,
        capabilities: capabilities,
      );
    } catch (error) {
      _setActionFailure(scope, error);
    } finally {
      _endAction('reprocess');
    }
  }

  Future<void> refresh() async {
    final scope = _sessionScope;
    if (scope == null || !canReadMedia) return;
    try {
      await processingManager.refresh(meetingId, scope: scope, explicit: true);
      await load();
    } catch (error) {
      _setActionFailure(scope, error);
    }
  }

  TranscriptReviewHandoff? reviewHandoff(ProcessingJobRecord job) {
    final scope = _sessionScope;
    if (scope == null ||
        !canReadMedia ||
        !api.isCurrentAuthenticatedSession(scope) ||
        job.meetingId.toLowerCase() != meetingId.toLowerCase()) {
      return null;
    }
    return processingManager.reviewHandoff(job);
  }

  void _startObservationIfAllowed() {
    final scope = _sessionScope;
    if (scope == null || !canReadMedia || _observation != null) return;
    try {
      _observation = processingManager.startObserving(meetingId, scope: scope);
    } catch (error) {
      _failure = error;
      notifyListeners();
    }
  }

  void _functionalStateChanged() {
    if (_disposed) return;
    final scope = _sessionScope;
    if (scope == null || !api.isCurrentAuthenticatedSession(scope)) {
      _fencePresentation();
      return;
    }
    _selectedSubmission = _selectedAsset == null
        ? null
        : submissions.stateFor(_selectedAsset!.id);
    _remoteState = canReadMedia
        ? processingManager.stateFor(meetingId, scope: scope)
        : null;
    notifyListeners();
  }

  void _sessionChanged() {
    final next = api.authenticatedSessionScope;
    if (next == _sessionScope) return;
    _observation?.dispose();
    _observation = null;
    _sessionScope = next;
    _generation++;
    _fencePresentation(notify: false);
    if (!_disposed) notifyListeners();
  }

  void _fencePresentation({bool notify = true}) {
    _generation++;
    _assets = const <LocalMediaAsset>[];
    _recoverableOperations = const <SubmissionState>[];
    _selectedAsset = null;
    _selectedSubmission = null;
    _remoteState = null;
    _failure = null;
    _warning = null;
    _loadState = RecordingWorkspaceLoadState.idle;
    if (notify && !_disposed) notifyListeners();
  }

  LocalMediaAsset? _findAssetForRecovery(List<SubmissionState> states) {
    for (final state in states) {
      for (final asset in _assets) {
        if (asset.id == state.assetId) return asset;
      }
    }
    return null;
  }

  bool _owns(
    int generation,
    AuthenticatedSessionScope scope,
    String expectedMeetingId,
  ) =>
      !_disposed &&
      generation == _generation &&
      meetingId == expectedMeetingId &&
      _sessionScope == scope &&
      api.isCurrentAuthenticatedSession(scope);

  bool _beginAction(String action) {
    if (_disposed || _pendingAction != null || isSessionFenced) return false;
    _pendingAction = action;
    _failure = null;
    notifyListeners();
    return true;
  }

  void _endAction(String action) {
    if (_pendingAction == action) {
      _pendingAction = null;
      if (!_disposed) notifyListeners();
    }
  }

  void _setActionFailure(AuthenticatedSessionScope? scope, Object error) {
    if (_disposed ||
        scope == null ||
        !api.isCurrentAuthenticatedSession(scope)) {
      return;
    }
    _failure = error;
    notifyListeners();
  }

  static String _capabilityKey(MeetingCapabilities? value) {
    if (value == null) return '';
    return MeetingOperation.values
        .where(value.allows)
        .map((operation) => operation.name)
        .join(',');
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _generation++;
    _observation?.dispose();
    _observation = null;
    recording.removeListener(_functionalStateChanged);
    submissions.removeListener(_functionalStateChanged);
    processingManager.removeListener(_functionalStateChanged);
    api.removeListener(_sessionChanged);
    super.dispose();
  }
}
