import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:crypto/crypto.dart';
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

class RecordingPage extends StatefulWidget {
  final ApiClient api;
  final String meetingId;
  final bool enabled;
  final LocalMediaRepository? localMedia;
  final MediaRepository? mediaRepository;
  final ProcessingRepository? processingRepository;
  const RecordingPage({
    super.key,
    required this.api,
    required this.meetingId,
    required this.enabled,
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
  List<RecordingDraft> savedRecordings = [];
  bool capturing = false;
  bool startingCapture = false;
  bool busy = false;
  double? uploadProgress;
  File? file;
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
    reloadJobs();
    loadDrafts();
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
    setState(() {
      jobs = processingRepository.list(widget.meetingId);
    });
  }

  @override
  void dispose() {
    timer?.cancel();
    if (capturing || startingCapture) {
      unawaited(
        recorder
            .stop()
            .then((path) async {
              if (path != null) {
                await draftStore.remember(
                  widget.meetingId,
                  File(path),
                  session: sessionScope,
                );
              }
            })
            .catchError((Object _) {})
            .whenComplete(() => recorder.dispose()),
      );
    } else {
      unawaited(recorder.dispose());
    }
    super.dispose();
  }

  Future<void> begin() async {
    if (!widget.enabled || busy || capturing) return;
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
      final folder = await getApplicationDocumentsDirectory();
      widget.api.requireCurrentAuthenticatedSession(sessionScope);
      final path =
          folder.path +
          '/sme-meeting-' +
          DateTime.now().millisecondsSinceEpoch.toString() +
          '.wav';
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
        rethrow;
      }
      if (!mounted) {
        startingCapture = false;
        return;
      }
      if (!widget.api.isCurrentAuthenticatedSession(sessionScope)) {
        startingCapture = false;
        final stoppedPath = await recorder.stop();
        if (stoppedPath != null) {
          await draftStore.remember(
            widget.meetingId,
            File(stoppedPath),
            session: sessionScope,
          );
        }
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
    try {
      final path = await recorder.stop();
      if (path != null) {
        await draftStore.remember(
          widget.meetingId,
          File(path),
          session: sessionScope,
        );
        await loadDrafts();
      }
      if (mounted && widget.api.isCurrentAuthenticatedSession(sessionScope)) {
        setState(() {
          capturing = false;
          file = path == null ? null : File(path);
          selectedName = path == null ? null : File(path).uri.pathSegments.last;
          sourceType = 'RECORDING';
        });
      }
    } catch (error) {
      if (mounted && widget.api.isCurrentAuthenticatedSession(sessionScope)) {
        showFailure(context, error);
      }
    }
  }

  Future<void> pick() async {
    try {
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
    setState(() {
      busy = true;
      uploadProgress = 0;
    });
    UploadOperation? uploadOperation;
    ProcessingOperation? processingOperation;
    LocalMediaAsset? localAsset;
    try {
      var uploadFile = selected;
      final size = await selected.length();
      widget.api.requireCurrentAuthenticatedSession(sessionScope);
      if (size == 0)
        throw const ApiFailure(422, 'EMPTY_AUDIO', 'File ghi âm trống.');
      final mime = contentType(selected);
      final filename = selectedName ?? selected.uri.pathSegments.last;
      final localMedia = widget.localMedia;
      if (localMedia != null) {
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
        uploadFile = await localMedia.fileFor(
          scope: sessionScope,
          asset: localAsset,
        );
      }
      final uploadKey = key();
      if (localMedia != null && localAsset != null) {
        uploadOperation = await localMedia.beginUploadOperation(
          scope: sessionScope,
          asset: localAsset,
          idempotencyKey: uploadKey,
          requestFingerprint: _fingerprint(
            '$sourceType\n$filename\n$mime\n$size',
          ),
        );
      }
      final intent = await mediaRepository.createUploadIntent(
        widget.meetingId,
        MediaUploadRequest(
          sourceType: sourceType == 'RECORDING'
              ? MediaSourceType.recording
              : MediaSourceType.upload,
          originalFilename: filename,
          contentType: mime,
          expectedSizeBytes: size,
        ),
        idempotencyKey: uploadKey,
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
          expectedLength: size,
          expiresAt: intent.expiresAt,
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
          ? await mediaRepository.getMedia(widget.meetingId, intent.mediaId)
          : await mediaRepository.finalizeUpload(
              widget.meetingId,
              intent.mediaId,
            );
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
      if (localMedia != null) {
        processingOperation = await localMedia.beginProcessingOperation(
          scope: sessionScope,
          meetingId: widget.meetingId,
          idempotencyKey: processingKey,
          requestFingerprint: _fingerprint('ADMISSION\n${finalized.id}'),
          operationType: ProcessingOperationType.admission,
          sourceMediaId: finalized.id,
        );
      }
      final accepted = await processingRepository.admit(
        widget.meetingId,
        ProcessingAdmissionRequest(mediaId: finalized.id),
        idempotencyKey: processingKey,
      );
      if (processingOperation != null && localMedia != null) {
        await localMedia.updateProcessingOperation(
          processingOperation,
          scope: sessionScope,
          checkpoint: ProcessingOperationCheckpoint.admissionConfirmed,
          targetJobId: accepted.id,
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
            await localMedia.updateUploadOperation(
              failedUpload,
              scope: sessionScope,
              checkpoint: UploadOperationCheckpoint.failed,
              attemptCount: failedUpload.attemptCount + 1,
              failureCode: failure?.code ?? 'MEDIA_UPLOAD_FAILED',
              failureStatus: failure?.status,
              failureMessage: failure?.message,
            );
          } catch (_) {}
        }
        final failedProcessing = processingOperation;
        if (failedProcessing != null) {
          try {
            await localMedia.updateProcessingOperation(
              failedProcessing,
              scope: sessionScope,
              checkpoint: ProcessingOperationCheckpoint.failed,
              attemptCount: failedProcessing.attemptCount + 1,
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

  Future<void> retryJob(ProcessingJobRecord candidate) async {
    if (!widget.api.isCurrentAuthenticatedSession(sessionScope)) return;
    setState(() => busy = true);
    try {
      final retryKey = key();
      ProcessingOperation? operation;
      final localMedia = widget.localMedia;
      if (localMedia != null) {
        operation = await localMedia.beginProcessingOperation(
          scope: sessionScope,
          meetingId: candidate.meetingId,
          idempotencyKey: retryKey,
          requestFingerprint: _fingerprint(
            'RETRY\n${candidate.id}\n${candidate.currentStage ?? ''}',
          ),
          operationType: ProcessingOperationType.retry,
          targetJobId: candidate.id,
          stageCode: candidate.currentStage,
        );
      }
      final response = await processingRepository.retry(
        candidate.id,
        idempotencyKey: retryKey,
        stageCode: candidate.currentStage,
      );
      if (operation != null && localMedia != null) {
        await localMedia.updateProcessingOperation(
          operation,
          scope: sessionScope,
          checkpoint: ProcessingOperationCheckpoint.retryConfirmed,
          targetJobId: response.id,
        );
      }
      if (mounted && widget.api.isCurrentAuthenticatedSession(sessionScope)) {
        setState(() => job = response);
        reloadJobs();
      }
    } catch (error) {
      if (mounted && widget.api.isCurrentAuthenticatedSession(sessionScope)) {
        showFailure(context, error);
      }
    } finally {
      if (mounted && widget.api.isCurrentAuthenticatedSession(sessionScope)) {
        setState(() => busy = false);
      }
    }
  }

  String _fingerprint(String value) =>
      sha256.convert(utf8.encode(value)).toString();

  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(18),
    children: [
      const SectionHeading(
        'Ghi âm và tải lên',
        subtitle: 'Âm thanh chỉ được xử lý sau khi gửi hoàn tất.',
      ),
      if (!widget.enabled)
        const MessagePanel(title: 'Không thể ghi âm cuộc họp đã hủy'),
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
                onPressed: widget.enabled && !busy ? begin : null,
                icon: const Icon(Icons.mic),
                label: const Text('Bắt đầu ghi âm'),
              ),
            const SizedBox(height: 8),
            OutlinedButton.icon(
              onPressed: capturing || busy || !widget.enabled ? null : pick,
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
                onPressed: busy || capturing
                    ? null
                    : () {
                        if (!widget.api.isCurrentAuthenticatedSession(
                          sessionScope,
                        )) {
                          return;
                        }
                        setState(() {
                          file = File(draft.path);
                          selectedName = draft.name;
                          sourceType = 'RECORDING';
                          job = null;
                        });
                      },
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
                onPressed: busy ? null : upload,
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
