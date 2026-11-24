import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

import 'recording_drafts.dart';
import 'local_media_models.dart';
import 'local_media_repository.dart';
import 'media_contracts.dart';
import 'media_repository.dart';
import 'processing_repository.dart';

import '../../core/api_client.dart';
import '../../core/app_theme.dart';
import '../../core/widgets.dart';
import '../meetings/meeting_foundation.dart';

class RecordingPage extends StatefulWidget {
  final ApiClient api;
  final String meetingId;
  final bool enabled;
  final MeetingCapabilities? capabilities;
  final LocalMediaRepository? localMedia;
  final MediaRepository? mediaRepository;
  final ProcessingRepository? processingRepository;
  const RecordingPage({
    super.key,
    required this.api,
    required this.meetingId,
    required this.enabled,
    this.capabilities,
    this.localMedia,
    this.mediaRepository,
    this.processingRepository,
  });

  @override
  State<RecordingPage> createState() => _RecordingPageState();
}

class _RecordingPageState extends State<RecordingPage> {
  final AudioRecorder recorder = AudioRecorder();
  late final RecordingDrafts draftStore;
  late final MediaRepository mediaRepository;
  late final ProcessingRepository processingRepository;
  late final AuthenticatedSessionScope sessionScope;
  MeetingCapabilities? _capabilities;
  List<RecordingDraft> savedRecordings = [];
  bool capturing = false;
  bool startingCapture = false;
  bool busy = false;
  double? uploadProgress;
  File? file;
  LocalMediaAsset? selectedAsset;
  LocalMediaAsset? captureAsset;
  String? selectedName;
  String sourceType = 'UPLOAD';
  int elapsed = 0;
  Timer? timer;
  ProcessingJobRecord? job;
  late Future<List<ProcessingJobRecord>> jobs;

  @override
  void initState() {
    super.initState();
    draftStore = RecordingDrafts(repository: widget.localMedia);
    mediaRepository =
        widget.mediaRepository ?? MediaRepository(api: widget.api);
    processingRepository =
        widget.processingRepository ?? ProcessingRepository(api: widget.api);
    sessionScope = widget.api.requireAuthenticatedSessionScope();
    _capabilities = widget.capabilities;
    reloadJobs();
    loadDrafts();
  }

  @override
  void didUpdateWidget(covariant RecordingPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    _capabilities = widget.capabilities;
  }

  bool _allows(MeetingOperation operation) =>
      _capabilities?.allows(operation) == true;

  void _requireCapability(MeetingOperation operation) {
    if (!_allows(operation)) {
      throw const ApiFailure(
        403,
        'MEDIA_CAPABILITY_REQUIRED',
        'Bạn không có quyền thực hiện thao tác âm thanh này.',
      );
    }
  }

  Future<void> loadDrafts() async {
    try {
      final drafts = await draftStore.list(
        widget.meetingId,
        api: widget.api,
        session: sessionScope,
      );
      if (mounted && widget.api.isCurrentAuthenticatedSession(sessionScope)) {
        setState(() => savedRecordings = drafts);
      }
    } catch (error) {
      if (mounted && widget.api.isCurrentAuthenticatedSession(sessionScope)) {
        showFailure(context, error);
      }
    }
  }

  void reloadJobs() {
    if (!widget.api.isCurrentAuthenticatedSession(sessionScope)) return;
    if (!_allows(MeetingOperation.readMedia)) {
      setState(() => jobs = Future<List<ProcessingJobRecord>>.value(const []));
      return;
    }
    setState(() {
      jobs = processingRepository.list(
        widget.meetingId,
        sessionScope: sessionScope,
      );
    });
  }

  @override
  void dispose() {
    timer?.cancel();
    if (capturing || startingCapture) {
      unawaited(_finishCaptureDuringDispose(captureAsset));
    } else {
      unawaited(recorder.dispose());
    }
    super.dispose();
  }

  Future<void> _finishCaptureDuringDispose(LocalMediaAsset? reserved) async {
    try {
      final stoppedPath = await recorder.stop();
      await _completeCapture(stoppedPath, reserved);
    } catch (_) {
      if (reserved != null && widget.localMedia != null) {
        try {
          await widget.localMedia!.recordInterruption(
            scope: sessionScope,
            assetId: reserved.id,
            reason: 'RECORDING_DISPOSED_BEFORE_COMPLETION',
          );
        } catch (_) {}
      }
    } finally {
      await recorder.dispose();
    }
  }

  Future<void> begin() async {
    if (!widget.enabled ||
        !_allows(MeetingOperation.uploadMedia) ||
        busy ||
        capturing) {
      return;
    }
    LocalMediaAsset? reserved;
    try {
      widget.api.requireCurrentAuthenticatedSession(sessionScope);
      if (!await recorder.hasPermission()) {
        throw const ApiFailure(
          0,
          'MIC_PERMISSION',
          'Cần quyền micro để ghi âm.',
        );
      }
      widget.api.requireCurrentAuthenticatedSession(sessionScope);
      final localMedia = widget.localMedia;
      final filename =
          'sme-meeting-${DateTime.now().millisecondsSinceEpoch}.wav';
      final String path;
      if (localMedia == null) {
        path = '${(await getApplicationDocumentsDirectory()).path}/$filename';
      } else {
        reserved = await localMedia.reserveAsset(
          scope: sessionScope,
          meetingId: widget.meetingId,
          sourceType: LocalMediaSourceType.recording,
          originalFilename: filename,
          contentType: 'audio/wav',
          sourceProvenance:
              'capture:${sessionScope.deploymentScope}:'
              '${sessionScope.userId}:${widget.meetingId}:$filename',
        );
        captureAsset = reserved;
        path = (await localMedia.stagingFileFor(
          scope: sessionScope,
          asset: reserved,
        )).path;
      }
      startingCapture = true;
      try {
        await recorder.start(
          const RecordConfig(
            encoder: AudioEncoder.wav,
            sampleRate: 16000,
            numChannels: 1,
          ),
          path: path,
        );
      } catch (_) {
        startingCapture = false;
        if (reserved != null && localMedia != null) {
          await localMedia.recordInterruption(
            scope: sessionScope,
            assetId: reserved.id,
            reason: 'RECORDING_START_FAILED',
          );
          captureAsset = null;
        }
        rethrow;
      }
      if (!mounted || !widget.api.isCurrentAuthenticatedSession(sessionScope)) {
        startingCapture = false;
        final stoppedPath = await recorder.stop();
        await _completeCapture(stoppedPath, reserved);
        captureAsset = null;
        return;
      }
      startingCapture = false;
      timer = Timer.periodic(const Duration(seconds: 1), (_) {
        if (mounted && widget.api.isCurrentAuthenticatedSession(sessionScope)) {
          setState(() => elapsed++);
        }
      });
      if (mounted)
        setState(() {
          capturing = true;
          elapsed = 0;
          file = null;
          selectedAsset = null;
          selectedName = null;
          job = null;
          sourceType = 'RECORDING';
        });
    } catch (error) {
      if (mounted && widget.api.isCurrentAuthenticatedSession(sessionScope)) {
        showFailure(context, error);
      }
    }
  }

  Future<void> stop() async {
    timer?.cancel();
    final reserved = captureAsset;
    try {
      final path = await recorder.stop();
      final completed = await _completeCapture(path, reserved);
      captureAsset = null;
      await loadDrafts();
      if (mounted && widget.api.isCurrentAuthenticatedSession(sessionScope)) {
        final managedFile =
            completed?.isReady == true && widget.localMedia != null
            ? await widget.localMedia!.fileFor(
                scope: sessionScope,
                asset: completed!,
              )
            : null;
        setState(() {
          capturing = false;
          file = managedFile;
          selectedAsset = completed?.isReady == true ? completed : null;
          selectedName = completed?.isReady == true
              ? completed!.originalFilename
              : null;
          sourceType = 'RECORDING';
        });
      }
    } catch (error) {
      captureAsset = null;
      if (reserved != null && widget.localMedia != null) {
        try {
          await widget.localMedia!.recordInterruption(
            scope: sessionScope,
            assetId: reserved.id,
            reason: 'RECORDING_STOP_FAILED',
          );
        } catch (_) {}
      }
      if (mounted && widget.api.isCurrentAuthenticatedSession(sessionScope)) {
        showFailure(context, error);
      }
    }
  }

  Future<LocalMediaAsset?> _completeCapture(
    String? stoppedPath,
    LocalMediaAsset? reserved,
  ) async {
    final localMedia = widget.localMedia;
    if (reserved != null && localMedia != null) {
      if (stoppedPath == null) {
        return localMedia.recordInterruption(
          scope: sessionScope,
          assetId: reserved.id,
          reason: 'RECORDING_STOP_RETURNED_NO_PATH',
        );
      }
      final source = File(stoppedPath);
      final size = await source.length();
      return localMedia.confirmFileCompletion(
        scope: sessionScope,
        assetId: reserved.id,
        expectedSizeBytes: size,
      );
    }
    if (stoppedPath == null) return null;
    return draftStore.remember(
      widget.meetingId,
      File(stoppedPath),
      session: sessionScope,
    );
  }

  Future<void> pick() async {
    try {
      _requireCapability(MeetingOperation.uploadMedia);
      widget.api.requireCurrentAuthenticatedSession(sessionScope);
      final result = await FilePicker.pickFile(
        type: FileType.custom,
        allowedExtensions: ['mp3', 'wav', 'm4a'],
      );
      if (result == null) return;
      widget.api.requireCurrentAuthenticatedSession(sessionScope);
      File selected;
      if (result.path != null) {
        selected = File(result.path!);
      } else {
        // SAF/cloud documents may not expose a local path. Stream into the
        // app sandbox without buffering potentially large meeting audio.
        final folder = await getTemporaryDirectory();
        final safeName = result.name.replaceAll(
          RegExp(r'[^A-Za-z0-9_.-]'),
          '_',
        );
        selected = File(
          folder.path +
              '/sme-import-${DateTime.now().microsecondsSinceEpoch}-$safeName',
        );
        final sink = selected.openWrite();
        try {
          await sink.addStream(result.readAsByteStream());
        } catch (_) {
          await sink.close();
          if (await selected.exists()) await selected.delete();
          rethrow;
        }
        await sink.close();
      }
      if (mounted) {
        widget.api.requireCurrentAuthenticatedSession(sessionScope);
        setState(() {
          file = selected;
          selectedAsset = null;
          selectedName = result.name;
          sourceType = 'UPLOAD';
          job = null;
        });
      }
    } catch (error) {
      if (mounted && widget.api.isCurrentAuthenticatedSession(sessionScope)) {
        showFailure(context, error);
      }
    }
  }

  String contentType(File selected) {
    final name = (selectedName ?? selected.path).toLowerCase();
    if (name.endsWith('.mp3')) return 'audio/mpeg';
    if (name.endsWith('.m4a')) return 'audio/mp4';
    return 'audio/wav';
  }

  MediaSourceType _backendSourceType(LocalMediaSourceType value) =>
      value == LocalMediaSourceType.recording
      ? MediaSourceType.recording
      : MediaSourceType.upload;

  MediaSourceType _backendSourceTypeForValue(String value) =>
      value == LocalMediaSourceType.recording.wireValue
      ? MediaSourceType.recording
      : MediaSourceType.upload;

  Future<MediaRecord> _getMediaWithCapability(String mediaId) {
    _requireCapability(MeetingOperation.readMedia);
    widget.api.requireCurrentAuthenticatedSession(sessionScope);
    return mediaRepository.getMedia(
      widget.meetingId,
      mediaId,
      sessionScope: sessionScope,
    );
  }

  Future<MediaRecord> _finalizeWithCapability(String mediaId) {
    _requireCapability(MeetingOperation.finalizeMedia);
    widget.api.requireCurrentAuthenticatedSession(sessionScope);
    return mediaRepository.finalizeUpload(
      widget.meetingId,
      mediaId,
      sessionScope: sessionScope,
    );
  }

  String key() {
    final bytes = List<int>.generate(16, (_) => Random.secure().nextInt(256));
    return bytes.map((byte) => byte.toRadixString(16).padLeft(2, '0')).join();
  }

  Future<void> upload() async {
    final selected = file;
    if (selected == null ||
        busy ||
        !widget.api.isCurrentAuthenticatedSession(sessionScope)) {
      return;
    }
    if (!_allows(MeetingOperation.uploadMedia)) return;
    setState(() {
      busy = true;
      uploadProgress = 0;
    });
    UploadOperation? uploadOperation;
    ProcessingOperation? processingOperation;
    LocalMediaAsset? localAsset;
    try {
      _requireCapability(MeetingOperation.uploadMedia);
      var uploadFile = selected;
      var size = 0;
      var mime = contentType(selected);
      var filename = selectedName ?? selected.uri.pathSegments.last;
      var backendSourceType = _backendSourceTypeForValue(sourceType);
      final localMedia = widget.localMedia;
      widget.api.requireCurrentAuthenticatedSession(sessionScope);
      if (localMedia != null) {
        if (selectedAsset != null) {
          localAsset = await localMedia.findReadyAsset(
            scope: sessionScope,
            assetId: selectedAsset!.id,
            meetingId: widget.meetingId,
          );
        } else {
          size = await selected.length();
          localAsset = await localMedia.rememberSourceFile(
            scope: sessionScope,
            meetingId: widget.meetingId,
            source: selected,
            sourceType: sourceType == 'RECORDING'
                ? LocalMediaSourceType.recording
                : LocalMediaSourceType.upload,
            originalFilename: filename,
            contentType: mime,
            expectedSizeBytes: size,
          );
        }
        if (!localAsset.isReady ||
            localAsset.sizeBytes == null ||
            localAsset.sizeBytes! <= 0) {
          throw const LocalMediaUnavailableException();
        }
        uploadFile = await localMedia.fileFor(
          scope: sessionScope,
          asset: localAsset,
        );
        size = localAsset.sizeBytes!;
        mime = localAsset.contentType;
        filename = localAsset.originalFilename;
        backendSourceType = _backendSourceType(localAsset.sourceType);
      } else {
        size = await selected.length();
      }
      if (size == 0)
        throw const ApiFailure(422, 'EMPTY_AUDIO', 'File ghi âm trống.');
      final uploadKey = key();
      if (localMedia != null && localAsset != null) {
        uploadOperation = await localMedia.beginUploadOperation(
          scope: sessionScope,
          asset: localAsset,
          idempotencyKey: uploadKey,
        );
      }
      _requireCapability(MeetingOperation.uploadMedia);
      final intent = await mediaRepository.createUploadIntent(
        widget.meetingId,
        MediaUploadRequest(
          sourceType: backendSourceType,
          originalFilename: filename,
          contentType: mime,
          expectedSizeBytes: size,
        ),
        idempotencyKey: uploadKey,
        sessionScope: sessionScope,
      );
      widget.api.requireCurrentAuthenticatedSession(sessionScope);
      final intentOperation = uploadOperation;
      if (intentOperation != null && localMedia != null) {
        uploadOperation = await localMedia.updateUploadOperation(
          intentOperation,
          scope: sessionScope,
          checkpoint: UploadOperationCheckpoint.intentConfirmed,
          remoteMediaId: intent.mediaId,
          attemptCount: intentOperation.attemptCount + 1,
        );
      }
      if (intent.status == MediaStatus.pendingUpload &&
          !intent.hasUploadCapability) {
        throw const ApiFailure(
          0,
          'INVALID_UPLOAD',
          'Server did not provide upload capability.',
        );
      }
      if (intent.hasUploadCapability) {
        await widget.api.uploadSigned(
          intent.uploadUrl!,
          uploadFile,
          intent.requiredContentType,
          session: sessionScope,
          expectedLength: size,
          expiresAt: intent.expiresAt!,
          onProgress: (sent, total) {
            if (!mounted ||
                !widget.api.isCurrentAuthenticatedSession(sessionScope) ||
                total == 0) {
              return;
            }
            final ratio = sent / total;
            if (uploadProgress == null ||
                (uploadProgress! - ratio).abs() >= 0.01 ||
                ratio == 1) {
              setState(() => uploadProgress = ratio);
            }
          },
        );
        final transferOperation = uploadOperation;
        if (transferOperation != null && localMedia != null) {
          uploadOperation = await localMedia.updateUploadOperation(
            transferOperation,
            scope: sessionScope,
            checkpoint: UploadOperationCheckpoint.binaryTransferConfirmed,
            confirmedBytes: size,
          );
        }
      }
      final finalized =
          intent.status == MediaStatus.available ||
              intent.status == MediaStatus.rejected ||
              intent.status == MediaStatus.failed
          ? await _getMediaWithCapability(intent.mediaId)
          : await _finalizeWithCapability(intent.mediaId);
      if (!finalized.accepted) {
        throw ApiFailure(
          409,
          finalized.failureCode ?? 'MEDIA_NOT_AVAILABLE',
          'Media has not been accepted.',
        );
      }
      final finalizedOperation = uploadOperation;
      if (finalizedOperation != null && localMedia != null) {
        uploadOperation = await localMedia.updateUploadOperation(
          finalizedOperation,
          scope: sessionScope,
          checkpoint: UploadOperationCheckpoint.finalizationConfirmed,
          remoteMediaId: finalized.id,
        );
      }
      final processingKey = key();
      _requireCapability(MeetingOperation.admitProcessing);
      if (localMedia != null) {
        processingOperation = await localMedia.beginProcessingOperation(
          scope: sessionScope,
          meetingId: widget.meetingId,
          idempotencyKey: processingKey,
          operationType: ProcessingOperationType.admission,
          sourceMediaId: finalized.id,
        );
      }
      final accepted = await processingRepository.admit(
        widget.meetingId,
        ProcessingAdmissionRequest(mediaId: finalized.id),
        idempotencyKey: processingKey,
        sessionScope: sessionScope,
      );
      if (processingOperation != null && localMedia != null) {
        await localMedia.updateProcessingOperation(
          processingOperation,
          scope: sessionScope,
          checkpoint: ProcessingOperationCheckpoint.admissionConfirmed,
          resultingJobId: accepted.id,
        );
      }
      if (mounted && widget.api.isCurrentAuthenticatedSession(sessionScope)) {
        setState(() => job = accepted);
        showSuccess(context, 'Đã gửi ghi âm. AI đang xử lý bất đồng bộ.');
        reloadJobs();
      }
    } catch (error) {
      final localMedia = widget.localMedia;
      final failure = error is ApiFailure ? error : null;
      if (localMedia != null &&
          widget.api.isCurrentAuthenticatedSession(sessionScope)) {
        final failedUpload = uploadOperation;
        if (failedUpload != null &&
            failedUpload.checkpoint !=
                UploadOperationCheckpoint.finalizationConfirmed) {
          try {
            final outcome = _operationOutcome(failure);
            await localMedia.updateUploadOperation(
              failedUpload,
              scope: sessionScope,
              attemptCount: failedUpload.attemptCount + 1,
              attemptOutcome: outcome,
              recoveryRequired: outcome == OperationAttemptOutcome.uncertain,
              failureCode: failure?.code ?? 'MEDIA_UPLOAD_FAILED',
              failureStatus: failure?.status,
              failureMessage: failure?.message,
            );
          } catch (_) {}
        }
        final failedProcessing = processingOperation;
        if (failedProcessing != null) {
          try {
            final outcome = _operationOutcome(failure);
            await localMedia.updateProcessingOperation(
              failedProcessing,
              scope: sessionScope,
              attemptCount: failedProcessing.attemptCount + 1,
              attemptOutcome: outcome,
              recoveryRequired: outcome == OperationAttemptOutcome.uncertain,
              failureCode: failure?.code ?? 'PROCESSING_ADMISSION_FAILED',
              failureStatus: failure?.status,
              failureMessage: failure?.message,
            );
          } catch (_) {}
        }
      }
      if (mounted && widget.api.isCurrentAuthenticatedSession(sessionScope)) {
        showFailure(context, error);
      }
    } finally {
      if (mounted && widget.api.isCurrentAuthenticatedSession(sessionScope)) {
        setState(() => busy = false);
      }
    }
  }

  Future<void> selectDraft(RecordingDraft draft) async {
    if (!widget.api.isCurrentAuthenticatedSession(sessionScope)) return;
    try {
      LocalMediaAsset? asset;
      File selected;
      final localMedia = widget.localMedia;
      if (draft.assetId != null && localMedia != null) {
        asset = await localMedia.findReadyAsset(
          scope: sessionScope,
          assetId: draft.assetId!,
          meetingId: widget.meetingId,
        );
        selected = await localMedia.fileFor(scope: sessionScope, asset: asset);
      } else {
        selected = File(draft.path);
      }
      if (!await selected.exists()) {
        throw const LocalMediaUnavailableException();
      }
      if (!mounted || !widget.api.isCurrentAuthenticatedSession(sessionScope)) {
        return;
      }
      setState(() {
        file = selected;
        selectedAsset = asset;
        selectedName = asset?.originalFilename ?? draft.name;
        sourceType =
            asset?.sourceType.wireValue ??
            draft.sourceType?.wireValue ??
            'UPLOAD';
        job = null;
      });
    } catch (error) {
      if (mounted && widget.api.isCurrentAuthenticatedSession(sessionScope)) {
        showFailure(context, error);
      }
    }
  }

  OperationAttemptOutcome _operationOutcome(ApiFailure? failure) {
    if (failure == null ||
        failure.remoteOutcomeAmbiguous ||
        failure.isTransportFailure) {
      return OperationAttemptOutcome.uncertain;
    }
    if (failure.status >= 400 && failure.status < 500) {
      return OperationAttemptOutcome.rejected;
    }
    return OperationAttemptOutcome.failed;
  }

  Future<void> retryJob(ProcessingJobRecord candidate) async {
    if (!widget.api.isCurrentAuthenticatedSession(sessionScope) ||
        !_allows(MeetingOperation.retryProcessing)) {
      return;
    }
    setState(() => busy = true);
    ProcessingOperation? operation;
    try {
      final retryKey = key();
      _requireCapability(MeetingOperation.retryProcessing);
      final localMedia = widget.localMedia;
      if (localMedia != null) {
        operation = await localMedia.beginProcessingOperation(
          scope: sessionScope,
          meetingId: candidate.meetingId,
          idempotencyKey: retryKey,
          operationType: ProcessingOperationType.retry,
          targetJobId: candidate.id,
        );
      }
      final response = await processingRepository.retry(
        candidate.id,
        idempotencyKey: retryKey,
        sessionScope: sessionScope,
      );
      if (operation != null && localMedia != null) {
        await localMedia.updateProcessingOperation(
          operation,
          scope: sessionScope,
          checkpoint: ProcessingOperationCheckpoint.retryConfirmed,
          resultingJobId: response.id,
        );
      }
      if (mounted && widget.api.isCurrentAuthenticatedSession(sessionScope)) {
        setState(() => job = response);
        reloadJobs();
      }
    } catch (error) {
      final localMedia = widget.localMedia;
      final failure = error is ApiFailure ? error : null;
      if (operation != null &&
          localMedia != null &&
          widget.api.isCurrentAuthenticatedSession(sessionScope)) {
        try {
          final outcome = _operationOutcome(failure);
          await localMedia.updateProcessingOperation(
            operation,
            scope: sessionScope,
            attemptCount: operation.attemptCount + 1,
            attemptOutcome: outcome,
            recoveryRequired: outcome == OperationAttemptOutcome.uncertain,
            failureCode: failure?.code ?? 'PROCESSING_RETRY_FAILED',
            failureStatus: failure?.status,
            failureMessage: failure?.message,
          );
        } catch (_) {}
      }
      if (mounted && widget.api.isCurrentAuthenticatedSession(sessionScope)) {
        showFailure(context, error);
      }
    } finally {
      if (mounted && widget.api.isCurrentAuthenticatedSession(sessionScope)) {
        setState(() => busy = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(18),
    children: [
      const SectionHeading(
        'Ghi âm và tải lên',
        subtitle: 'Âm thanh chỉ được xử lý sau khi gửi hoàn tất.',
      ),
      if (!widget.enabled || !_allows(MeetingOperation.uploadMedia))
        const MessagePanel(
          title: 'Bạn không có quyền thay đổi âm thanh cuộc họp này',
        ),
      ContentCard(
        child: Column(
          children: [
            CircleAvatar(
              radius: 38,
              backgroundColor: capturing
                  ? Palette.red.withValues(alpha: 0.1)
                  : Palette.surface,
              child: Icon(
                capturing ? Icons.mic : Icons.mic_none,
                size: 34,
                color: capturing ? Palette.red : Palette.ink,
              ),
            ),
            const SizedBox(height: 12),
            Text(
              capturing
                  ? 'Đang ghi âm · ' +
                        Duration(seconds: elapsed).toString().split('.').first
                  : 'Ghi âm cuộc họp',
              style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16),
            ),
            const SizedBox(height: 12),
            if (capturing)
              FilledButton.icon(
                onPressed: stop,
                icon: const Icon(Icons.stop),
                label: const Text('Dừng ghi âm'),
              )
            else
              FilledButton.icon(
                onPressed:
                    widget.enabled &&
                        _allows(MeetingOperation.uploadMedia) &&
                        !busy
                    ? begin
                    : null,
                icon: const Icon(Icons.mic),
                label: const Text('Bắt đầu ghi âm'),
              ),
            const SizedBox(height: 8),
            OutlinedButton.icon(
              onPressed:
                  capturing ||
                      busy ||
                      !widget.enabled ||
                      !_allows(MeetingOperation.uploadMedia)
                  ? null
                  : pick,
              icon: const Icon(Icons.upload_file),
              label: const Text('Chọn file MP3 / WAV / M4A'),
            ),
          ],
        ),
      ),
      if (savedRecordings.isNotEmpty) ...[
        const SectionHeading(
          'Bản ghi đã lưu trên thiết bị',
          subtitle: 'Bản ghi chưa bị xóa khi rời màn hình hoặc khi upload lỗi.',
        ),
        ...savedRecordings.map(
          (draft) => ContentCard(
            child: ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.audio_file_outlined),
              title: Text(
                draft.name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              subtitle: Text(
                draft.createdAt.toLocal().toString().split('.').first,
              ),
              trailing: OutlinedButton(
                onPressed: busy || capturing ? null : () => selectDraft(draft),
                child: const Text('Chọn'),
              ),
            ),
          ),
        ),
      ],
      if (file != null)
        ContentCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                selectedName ?? file!.uri.pathSegments.last,
                maxLines: 2,
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 12),
              FilledButton.icon(
                onPressed: busy || !_allows(MeetingOperation.uploadMedia)
                    ? null
                    : upload,
                icon: const Icon(Icons.cloud_upload_outlined),
                label: Text(busy ? 'Đang tải lên...' : 'Tải lên và xử lý AI'),
              ),
              if (busy && uploadProgress != null) ...[
                const SizedBox(height: 8),
                LinearProgressIndicator(value: uploadProgress),
                const SizedBox(height: 4),
                Text((uploadProgress! * 100).toStringAsFixed(0) + '% tải lên'),
              ],
              const SizedBox(height: 6),
              const Text(
                'File nguồn vẫn giữ lại trên thiết bị khi upload lỗi.',
                style: TextStyle(color: Palette.muted, fontSize: 12),
              ),
            ],
          ),
        ),
      if (job != null) jobTile(job!),
      SectionHeading(
        'Tiến trình xử lý',
        trailing: IconButton(
          onPressed: reloadJobs,
          icon: const Icon(Icons.refresh),
        ),
      ),
      AsyncContent<List<ProcessingJobRecord>>(
        future: jobs,
        retry: reloadJobs,
        builder: (values) => Column(
          children: [
            if (values.isEmpty)
              const MessagePanel(title: 'Chưa có lần xử lý nào'),
            ...values.map(jobTile),
          ],
        ),
      ),
    ],
  );

  Widget jobTile(ProcessingJobRecord item) => ContentCard(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Icon(Icons.auto_awesome, color: Palette.blue),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                item.currentStage?.isNotEmpty == true
                    ? item.currentStage!
                    : 'Xử lý cuộc họp',
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
            ),
            StatePill(item.status.wireValue),
          ],
        ),
        if (item.warningSummary?.isNotEmpty == true)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              item.warningSummary!,
              style: const TextStyle(color: Palette.amber),
            ),
          ),
        if (item.errorSummary?.isNotEmpty == true)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              item.errorSummary!,
              style: const TextStyle(color: Palette.red),
            ),
          ),
        if (item.retryable)
          Align(
            alignment: Alignment.centerRight,
            child: TextButton(
              onPressed: busy ? null : () => retryJob(item),
              child: const Text('Thử lại'),
            ),
          ),
      ],
    ),
  );
}
