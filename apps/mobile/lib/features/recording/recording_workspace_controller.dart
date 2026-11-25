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
  _WorkspaceAction? _action;
  int _contextGeneration = 0;
  int _selectionRevision = 0;
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
  String? get pendingAction => _action?.kind;
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
  bool get isBusy => _action != null;

  bool get canCancelSubmission {
    final scope = _sessionScope;
    final asset = _selectedAsset;
    return scope != null &&
        asset != null &&
        !isSessionFenced &&
        submissions.hasActiveSubmission(asset.id, scope: scope);
  }

  bool get canCancelImport {
    final scope = _sessionScope;
    return scope != null &&
        !isSessionFenced &&
        recording.canCancelImport(meetingId: meetingId, scope: scope);
  }

  bool get canSubmitSelected =>
      !isBusy &&
      canReadMedia &&
      _selectedAsset?.isReady == true &&
      _selectedSubmission?.processingAdmitted != true &&
      (_selectedSubmission?.remoteMediaAvailable == true
          ? canAdmitProcessing
          : canUpload);

  bool canResumeRecovery(SubmissionState state) {
    if (isBusy || !canReadMedia || !_containsRecovery(state)) return false;
    final upload = state.uploadOperation;
    if (upload != null) {
      return canUpload ||
          (upload.remoteMediaId != null &&
              (canAdmitProcessing ||
                  capabilities?.allows(MeetingOperation.finalizeMedia) ==
                      true));
    }
    return switch (state.processingOperation?.operationType) {
      ProcessingOperationType.retry => canRetryProcessing,
      ProcessingOperationType.admission ||
      ProcessingOperationType.reprocess => canAdmitProcessing,
      null => false,
    };
  }

  bool _containsRecovery(SubmissionState state) =>
      state.meetingId == meetingId &&
      state.sessionScope == _sessionScope &&
      _recoverableOperations.any(
        (item) =>
            item.uploadOperation?.id == state.uploadOperation?.id &&
            item.processingOperation?.id == state.processingOperation?.id,
      );

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
        _generation++;
        _assets = const <LocalMediaAsset>[];
        _recoverableOperations = const <SubmissionState>[];
        _selectedAsset = null;
        _selectedSubmission = null;
        _remoteState = null;
        _loadState = RecordingWorkspaceLoadState.idle;
      } else if (_observation == null) {
        _startObservationIfAllowed();
        unawaited(load());
      }
      _functionalStateChanged();
    }
  }

  Future<void> initialize() async {
    _startObservationIfAllowed();
    await load();
  }

  Future<void> load() async {
    if (_disposed || !canReadMedia) return;
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
      if (!_owns(generation, scope, meeting) || !canReadMedia) return;
      _assets = listed
          .where((asset) => asset.lifecycle != LocalMediaLifecycle.discarded)
          .toList(growable: false);
      _recoverableOperations = recovered;
      if (_selectedAsset != null) {
        final selectedId = _selectedAsset!.id;
        _selectedAsset = _assets
            .where((asset) => asset.id == selectedId)
            .firstOrNull;
      }
      _selectedAsset ??= _findAssetForRecovery(recovered);
      _projectSelectedSubmission();
      _loadState = RecordingWorkspaceLoadState.ready;
      _failure = recoveryFailure;
      notifyListeners();
    } catch (error) {
      if (!_owns(generation, scope, meeting) || !canReadMedia) return;
      _loadState = RecordingWorkspaceLoadState.failed;
      _failure = recoveryFailure ?? error;
      notifyListeners();
    }
  }

  void selectAsset(LocalMediaAsset? asset) {
    if (_disposed ||
        !canReadMedia ||
        asset == null ||
        !_assets.any((item) => item.id == asset.id)) {
      return;
    }
    _selectedAsset = _assets.firstWhere((item) => item.id == asset.id);
    _selectionRevision++;
    _projectSelectedSubmission();
    _warning = null;
    notifyListeners();
  }

  Future<void> startRecording() async {
    if (!canUpload || meetingStatus != MeetingStatus.inProgress) return;
    final action = _beginAction('recording');
    if (action == null) return;
    try {
      final result = await recording.start(
        meetingId: action.meetingId,
        capabilities: capabilities!,
        meetingStatus: meetingStatus!,
      );
      if (!_ownsAction(action)) return;
      _failure = result.failure;
      notifyListeners();
    } catch (error) {
      _setActionFailure(action, error);
    } finally {
      _endAction(action);
    }
  }

  Future<void> stopRecording() async {
    if (!recordingState.isCapturing) return;
    final action = _beginAction('stop', supersedeRecordingStart: true);
    if (action == null) return;
    try {
      final result = await recording.stop(
        meetingId: action.meetingId,
        scope: action.scope,
      );
      if (!_ownsAction(action)) return;
      await load();
      if (!_ownsAction(action)) return;
      _failure = result.failure;
      if (result.asset?.isReady == true &&
          _selectionRevision == action.selectionRevision) {
        selectAsset(result.asset);
      }
      notifyListeners();
    } catch (error) {
      _setActionFailure(action, error);
    } finally {
      _endAction(action);
    }
  }

  Future<void> importAudio() async {
    if (!canUpload) return;
    final action = _beginAction('import');
    if (action == null) return;
    try {
      final result = await recording.importAudio(
        meetingId: action.meetingId,
        meetingStatus: meetingStatus,
        capabilities: capabilities!,
      );
      if (!_ownsAction(action)) return;
      await load();
      if (!_ownsAction(action)) return;
      _failure = result.failure;
      if (result.asset?.isReady == true &&
          _selectionRevision == action.selectionRevision) {
        selectAsset(result.asset);
      }
      notifyListeners();
    } catch (error) {
      _setActionFailure(action, error);
    } finally {
      _endAction(action);
    }
  }

  void cancelImport() {
    final scope = _sessionScope;
    if (scope == null || !canCancelImport) return;
    recording.cancelImport(meetingId: meetingId, scope: scope);
    notifyListeners();
  }

  Future<void> submitSelected() async {
    final asset = _selectedAsset;
    if (asset == null || !canSubmitSelected) return;
    final action = _beginAction('submission');
    if (action == null) return;
    try {
      final operation = submissions.stateFor(asset.id)?.uploadOperation;
      final result = operation == null
          ? await submissions.submit(
              asset: asset,
              capabilities: capabilities,
              admitProcessing: canAdmitProcessing,
            )
          : await submissions.resume(
              operationId: operation.id,
              scope: action.scope,
              capabilities: capabilities,
              admitProcessing: canAdmitProcessing,
            );
      if (!_ownsAction(action)) return;
      await load();
      if (_ownsAction(action)) _applySubmissionResult(action, result);
    } catch (error) {
      _setActionFailure(action, error);
    } finally {
      _endAction(action);
    }
  }

  void cancelSubmission() {
    final asset = _selectedAsset;
    final scope = _sessionScope;
    if (asset == null || scope == null || !canCancelSubmission) return;
    submissions.cancel(asset.id, scope: scope);
    notifyListeners();
  }

  Future<void> discardAsset(LocalMediaAsset asset) async {
    if (!canReadMedia || !_assets.any((item) => item.id == asset.id)) return;
    final action = _beginAction('discard');
    if (action == null) return;
    try {
      await localMedia.discard(scope: action.scope, assetId: asset.id);
      if (!_ownsAction(action)) return;
      if (_selectedAsset?.id == asset.id) {
        _selectedAsset = null;
        _selectedSubmission = null;
        _selectionRevision++;
      }
      await load();
    } catch (error) {
      _setActionFailure(action, error);
    } finally {
      _endAction(action);
    }
  }

  Future<void> admitRemoteMedia(MediaRecord media) async {
    if (!canAdmitProcessing ||
        !canReadMedia ||
        media.meetingId != meetingId ||
        !media.accepted) {
      return;
    }
    final action = _beginAction('processing');
    if (action == null) return;
    try {
      final result = await submissions.admitAvailableMedia(
        meetingId: action.meetingId,
        mediaId: media.id,
        scope: action.scope,
        capabilities: capabilities,
      );
      if (!_ownsAction(action)) return;
      await load();
      if (!_ownsAction(action)) return;
      _applySubmissionResult(action, result);
      await _refreshAfterMutation(action);
    } catch (error) {
      _setActionFailure(action, error);
    } finally {
      _endAction(action);
    }
  }

  /// Recovery uses identities specific to the durable operation type.
  Future<void> resumeRecovery(SubmissionState state) async {
    if (!canResumeRecovery(state)) return;
    final action = _beginAction('recovery');
    if (action == null) return;
    try {
      final upload = state.uploadOperation;
      if (upload != null) {
        final result = await submissions.resume(
          operationId: upload.id,
          scope: action.scope,
          capabilities: capabilities,
          admitProcessing: canAdmitProcessing,
        );
        if (!_ownsAction(action)) return;
        _applySubmissionResult(action, result);
      } else {
        final operation = state.processingOperation;
        if (operation == null) return;
        switch (operation.operationType) {
          case ProcessingOperationType.admission:
            final mediaId = operation.sourceMediaId;
            if (mediaId == null) {
              throw StateError('Missing admission source identity.');
            }
            final result = await submissions.admitAvailableMedia(
              meetingId: action.meetingId,
              mediaId: mediaId,
              scope: action.scope,
              capabilities: capabilities,
            );
            if (!_ownsAction(action)) return;
            _applySubmissionResult(action, result);
          case ProcessingOperationType.retry:
          case ProcessingOperationType.reprocess:
            final isRetry =
                operation.operationType == ProcessingOperationType.retry;
            final targetId = isRetry
                ? operation.targetJobId
                : operation.reprocessOfJobId;
            if (targetId == null) {
              throw StateError('Missing processing target identity.');
            }
            final target = await processingManager.processingRepository.get(
              targetId,
              sessionScope: action.scope,
            );
            if (!_ownsAction(action)) return;
            if (target.meetingId != action.meetingId) {
              throw StateError('Processing target belongs to another meeting.');
            }
            if (isRetry) {
              await processingManager.retryJob(
                job: target,
                scope: action.scope,
                capabilities: capabilities,
                expectedOperationId: operation.id,
              );
            } else {
              final mediaId = operation.sourceMediaId;
              if (mediaId == null) {
                throw StateError('Missing reprocessing source identity.');
              }
              await processingManager.reprocess(
                parent: target,
                sourceMediaId: mediaId,
                scope: action.scope,
                capabilities: capabilities,
                expectedOperationId: operation.id,
              );
            }
        }
      }
    } catch (error) {
      _setActionFailure(action, error);
    } finally {
      await _reloadAfterAction(action);
      if (_ownsAction(action)) await _refreshAfterMutation(action);
      _endAction(action);
    }
  }

  Future<void> retryProcessing(ProcessingJobRecord job) async {
    if (!canRetryProcessing || job.meetingId != meetingId) return;
    final action = _beginAction('retry');
    if (action == null) return;
    try {
      await processingManager.retryJob(
        job: job,
        scope: action.scope,
        capabilities: capabilities,
      );
    } catch (error) {
      _setActionFailure(action, error);
    } finally {
      await _reloadAfterAction(action);
      _endAction(action);
    }
  }

  Future<void> reprocess(
    ProcessingJobRecord job, {
    required String sourceMediaId,
  }) async {
    if (!canAdmitProcessing || job.meetingId != meetingId) return;
    final action = _beginAction('reprocess');
    if (action == null) return;
    try {
      await processingManager.reprocess(
        parent: job,
        sourceMediaId: sourceMediaId,
        scope: action.scope,
        capabilities: capabilities,
      );
    } catch (error) {
      _setActionFailure(action, error);
    } finally {
      await _reloadAfterAction(action);
      _endAction(action);
    }
  }

  Future<void> refresh() async {
    if (!canReadMedia) return;
    final action = _beginAction('refresh');
    if (action == null) return;
    try {
      await processingManager.refresh(
        action.meetingId,
        scope: action.scope,
        explicit: true,
      );
      if (_ownsAction(action)) await load();
    } catch (error) {
      _setActionFailure(action, error);
    } finally {
      _endAction(action);
    }
  }

  Future<void> _reloadAfterAction(_WorkspaceAction action) async {
    if (!_ownsAction(action)) return;
    final failure = _failure;
    await load();
    if (_ownsAction(action)) _failure ??= failure;
  }

  Future<void> _refreshAfterMutation(_WorkspaceAction action) async {
    if (!_ownsAction(action) || !canReadMedia) return;
    try {
      await processingManager.refresh(
        action.meetingId,
        scope: action.scope,
        explicit: true,
      );
    } catch (_) {
      if (_ownsAction(action)) {
        _warning = 'Không thể làm mới trạng thái từ máy chủ.';
        notifyListeners();
      }
    }
  }

  void _applySubmissionResult(
    _WorkspaceAction action,
    SubmissionState result,
  ) {
    if (!_ownsAction(action) ||
        result.meetingId != action.meetingId ||
        result.sessionScope != action.scope) {
      return;
    }
    if (canReadMedia &&
        _selectionRevision == action.selectionRevision &&
        _selectedAsset?.id == result.assetId) {
      _selectedSubmission = result;
    }
    _failure = result.failure;
    notifyListeners();
  }

  void _projectSelectedSubmission() {
    final asset = _selectedAsset;
    final state = asset == null ? null : submissions.stateFor(asset.id);
    _selectedSubmission =
        canReadMedia &&
            state?.meetingId == meetingId &&
            state?.sessionScope == _sessionScope
        ? state
        : null;
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
    _projectSelectedSubmission();
    _remoteState = canReadMedia
        ? processingManager.stateFor(meetingId, scope: scope)
        : null;
    notifyListeners();
  }

  void _sessionChanged() {
    final next = api.authenticatedSessionScope;
    if (_sessionScope == null || next == _sessionScope) return;
    _observation?.dispose();
    _observation = null;
    // The new session requires a newly authorized workspace.
    _sessionScope = null;
    _fencePresentation(notify: false);
    if (!_disposed) notifyListeners();
  }

  void _fencePresentation({bool notify = true}) {
    _generation++;
    _contextGeneration++;
    _selectionRevision++;
    _action = null;
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

  _WorkspaceAction? _beginAction(
    String kind, {
    bool supersedeRecordingStart = false,
  }) {
    if (_disposed || isSessionFenced) return null;
    if (_action != null &&
        !(supersedeRecordingStart && _action?.kind == 'recording')) {
      return null;
    }
    final action = _WorkspaceAction(
      kind: kind,
      scope: _sessionScope!,
      meetingId: meetingId,
      contextGeneration: _contextGeneration,
      selectionRevision: _selectionRevision,
    );
    _action = action;
    _failure = null;
    _warning = null;
    notifyListeners();
    return action;
  }

  bool _ownsAction(_WorkspaceAction action) =>
      !_disposed &&
      identical(_action, action) &&
      action.contextGeneration == _contextGeneration &&
      action.meetingId == meetingId &&
      action.scope == _sessionScope &&
      api.isCurrentAuthenticatedSession(action.scope);

  void _endAction(_WorkspaceAction action) {
    if (_ownsAction(action)) {
      _action = null;
      notifyListeners();
    }
  }

  void _setActionFailure(_WorkspaceAction action, Object error) {
    if (!_ownsAction(action)) return;
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

class _WorkspaceAction {
  const _WorkspaceAction({
    required this.kind,
    required this.scope,
    required this.meetingId,
    required this.contextGeneration,
    required this.selectionRevision,
  });

  final String kind;
  final AuthenticatedSessionScope scope;
  final String meetingId;
  final int contextGeneration;
  final int selectionRevision;
}
