import 'dart:async';

import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import '../../core/app_theme.dart';
import '../../core/models.dart';
import '../../core/widgets.dart';
import '../meetings/meeting_foundation.dart';
import 'local_media_models.dart';
import 'local_media_repository.dart';
import 'media_contracts.dart';
import 'media_repository.dart';
import 'processing_manager.dart';
import 'processing_repository.dart';
import 'recording_coordinator.dart';
import 'submission_coordinator.dart';

class RecordingPage extends StatefulWidget {
  const RecordingPage({
    super.key,
    required this.api,
    required this.meetingId,
    required this.enabled,
    this.capabilities,
    this.meetingStatus,
    this.localMedia,
    this.mediaRepository,
    this.processingRepository,
    this.recordingCoordinator,
    this.submissionCoordinator,
    this.processingManager,
  });

  final ApiClient api;
  final String meetingId;
  final bool enabled;
  final MeetingCapabilities? capabilities;
  final MeetingStatus? meetingStatus;
  final LocalMediaRepository? localMedia;
  final MediaRepository? mediaRepository;
  final ProcessingRepository? processingRepository;
  final RecordingCoordinator? recordingCoordinator;
  final SubmissionCoordinator? submissionCoordinator;
  final ProcessingManager? processingManager;

  @override
  State<RecordingPage> createState() => _RecordingPageState();
}

class _RecordingPageState extends State<RecordingPage> {
  late final AuthenticatedSessionScope sessionScope;
  late final LocalMediaRepository localMedia;
  late final RecordingCoordinator recording;
  late final SubmissionCoordinator submissions;
  late final ProcessingManager processingManager;
  late final bool ownsRecording;
  late final bool ownsSubmission;
  late final bool ownsProcessingManager;

  List<LocalMediaAsset> assets = <LocalMediaAsset>[];
  LocalMediaAsset? selectedAsset;
  SubmissionState? submission;
  ProcessingMeetingState? remoteState;
  Object? failure;

  @override
  void initState() {
    super.initState();
    sessionScope = widget.api.requireAuthenticatedSessionScope();
    localMedia = widget.localMedia ?? LocalMediaRepository.lazyDefault();
    ownsRecording = widget.recordingCoordinator == null;
    ownsSubmission = widget.submissionCoordinator == null;
    ownsProcessingManager = widget.processingManager == null;
    recording =
        widget.recordingCoordinator ??
        RecordingCoordinator(api: widget.api, localMedia: localMedia);
    submissions =
        widget.submissionCoordinator ??
        SubmissionCoordinator(
          api: widget.api,
          localMedia: localMedia,
          mediaRepository:
              widget.mediaRepository ?? MediaRepository(api: widget.api),
          processingRepository:
              widget.processingRepository ??
              ProcessingRepository(api: widget.api),
        );
    processingManager =
        widget.processingManager ??
        ProcessingManager(
          api: widget.api,
          mediaRepository:
              widget.mediaRepository ?? MediaRepository(api: widget.api),
          processingRepository:
              widget.processingRepository ??
              ProcessingRepository(api: widget.api),
          localMedia: localMedia,
        );
    recording.addListener(_changed);
    submissions.addListener(_changed);
    processingManager.addListener(_changed);
    unawaited(_load());
    processingManager.startObserving(widget.meetingId, scope: sessionScope);
  }

  Future<void> _load() async {
    try {
      await localMedia.recoverLocalState(
        scope: sessionScope,
        meetingId: widget.meetingId,
      );
      final listed = await localMedia.listAssets(
        scope: sessionScope,
        meetingId: widget.meetingId,
      );
      if (!mounted || !widget.api.isCurrentAuthenticatedSession(sessionScope)) {
        return;
      }
      setState(() => assets = listed.where((asset) => asset.isReady).toList());
    } catch (error) {
      if (mounted && widget.api.isCurrentAuthenticatedSession(sessionScope)) {
        setState(() => failure = error);
      }
    }
  }

  void _changed() {
    if (!mounted || !widget.api.isCurrentAuthenticatedSession(sessionScope)) {
      return;
    }
    setState(() {
      submission = submissions.stateFor(selectedAsset?.id ?? '');
      remoteState = processingManager.stateFor(widget.meetingId);
    });
  }

  bool _allows(MeetingOperation operation) =>
      widget.capabilities?.allows(operation) == true;

  Future<void> _start() async {
    try {
      await recording.start(
        meetingId: widget.meetingId,
        capabilities:
            widget.capabilities ??
            (throw const ApiFailure(
              403,
              'MEDIA_CAPABILITY_REQUIRED',
              'Recording authorization is unavailable.',
            )),
        meetingStatus:
            widget.meetingStatus ??
            (throw const RecordingEligibilityException(
              'The current meeting state is unavailable.',
            )),
      );
      await _load();
    } catch (error) {
      if (mounted && widget.api.isCurrentAuthenticatedSession(sessionScope)) {
        setState(() => failure = error);
      }
    }
  }

  Future<void> _stop() async {
    try {
      await recording.stop();
      await _load();
      final asset = recording.state.asset;
      if (asset?.isReady == true) {
        setState(() => selectedAsset = asset);
      }
    } catch (error) {
      if (mounted && widget.api.isCurrentAuthenticatedSession(sessionScope)) {
        setState(() => failure = error);
      }
    }
  }

  Future<void> _import() async {
    try {
      await recording.importAudio(
        meetingId: widget.meetingId,
        capabilities:
            widget.capabilities ??
            (throw const ApiFailure(
              403,
              'MEDIA_CAPABILITY_REQUIRED',
              'Import authorization is unavailable.',
            )),
      );
      await _load();
      final asset = recording.state.asset;
      if (asset?.isReady == true) setState(() => selectedAsset = asset);
    } catch (error) {
      if (mounted && widget.api.isCurrentAuthenticatedSession(sessionScope)) {
        setState(() => failure = error);
      }
    }
  }

  Future<void> _submit() async {
    final asset = selectedAsset;
    if (asset == null) return;
    try {
      final result = await submissions.submit(
        asset: asset,
        capabilities: widget.capabilities,
        admitProcessing: _allows(MeetingOperation.admitProcessing),
      );
      if (mounted && widget.api.isCurrentAuthenticatedSession(sessionScope)) {
        setState(() => submission = result);
      }
    } catch (error) {
      if (mounted && widget.api.isCurrentAuthenticatedSession(sessionScope)) {
        setState(() => failure = error);
      }
    }
  }

  Future<void> _discard(LocalMediaAsset asset) async {
    try {
      await localMedia.discard(scope: sessionScope, assetId: asset.id);
      if (selectedAsset?.id == asset.id) {
        setState(() {
          selectedAsset = null;
          submission = null;
        });
      }
      await _load();
    } catch (error) {
      if (mounted && widget.api.isCurrentAuthenticatedSession(sessionScope)) {
        setState(() => failure = error);
      }
    }
  }

  @override
  void dispose() {
    processingManager.stopObserving(widget.meetingId);
    recording.removeListener(_changed);
    submissions.removeListener(_changed);
    processingManager.removeListener(_changed);
    if (ownsRecording) recording.dispose();
    if (ownsSubmission) submissions.dispose();
    if (ownsProcessingManager) processingManager.dispose();
    if (widget.localMedia == null) localMedia.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final captureState = recording.state;
    final isCapturing = captureState.isCapturing;
    final canUpload = widget.enabled && _allows(MeetingOperation.uploadMedia);
    final selectedSubmission =
        submission ??
        (selectedAsset == null
            ? null
            : submissions.stateFor(selectedAsset!.id));
    return ListView(
      padding: const EdgeInsets.all(18),
      children: [
        const SectionHeading(
          'Ghi âm và tải lên',
          subtitle: 'Âm thanh chỉ được xử lý sau khi gửi hoàn tất.',
        ),
        if (!canUpload)
          const MessagePanel(
            title: 'Bạn không có quyền thay đổi âm thanh cuộc họp này',
          ),
        if (failure != null)
          MessagePanel(
            title: 'Không thể hoàn tất thao tác',
            description: failure.toString(),
          ),
        ContentCard(
          child: Column(
            children: [
              CircleAvatar(
                radius: 38,
                backgroundColor: isCapturing
                    ? Palette.red.withValues(alpha: 0.1)
                    : Palette.surface,
                child: Icon(
                  isCapturing ? Icons.mic : Icons.mic_none,
                  size: 34,
                  color: isCapturing ? Palette.red : Palette.ink,
                ),
              ),
              const SizedBox(height: 12),
              Text(
                isCapturing
                    ? 'Đang ghi âm · '
                          '${captureState.elapsed.toString().split('.').first}'
                    : switch (captureState.lifecycle) {
                        RecordingLifecycleState.localReady =>
                          'Đã lưu bản ghi trên thiết bị',
                        RecordingLifecycleState.interrupted =>
                          'Ghi âm bị gián đoạn · dữ liệu vẫn được bảo toàn',
                        _ => 'Ghi âm cuộc họp',
                      },
                style: const TextStyle(
                  fontWeight: FontWeight.w800,
                  fontSize: 16,
                ),
              ),
              const SizedBox(height: 12),
              if (isCapturing)
                FilledButton.icon(
                  onPressed: _stop,
                  icon: const Icon(Icons.stop),
                  label: const Text('Dừng ghi âm'),
                )
              else
                FilledButton.icon(
                  onPressed:
                      canUpload &&
                          widget.meetingStatus == MeetingStatus.inProgress
                      ? _start
                      : null,
                  icon: const Icon(Icons.mic),
                  label: const Text('Bắt đầu ghi âm'),
                ),
              const SizedBox(height: 8),
              OutlinedButton.icon(
                onPressed: isCapturing || !canUpload ? null : _import,
                icon: const Icon(Icons.upload_file),
                label: const Text('Chọn file MP3 / WAV / M4A'),
              ),
            ],
          ),
        ),
        if (captureState.lifecycle == RecordingLifecycleState.importing &&
            captureState.importProgress != null)
          LinearProgressIndicator(value: captureState.importProgress),
        if (assets.isNotEmpty) ...[
          const SectionHeading(
            'Âm thanh đã lưu trên thiết bị',
            subtitle:
                'Nguồn cục bộ không bị xóa khi upload hoặc xử lý thành công.',
          ),
          ...assets.map(
            (asset) => ContentCard(
              child: ListTile(
                contentPadding: EdgeInsets.zero,
                leading: Icon(
                  asset.sourceType == LocalMediaSourceType.recording
                      ? Icons.mic_none
                      : Icons.audio_file_outlined,
                ),
                title: Text(
                  asset.originalFilename,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                subtitle: Text(asset.createdAt.toLocal().toString()),
                trailing: Wrap(
                  spacing: 4,
                  children: [
                    OutlinedButton(
                      onPressed: isCapturing
                          ? null
                          : () => setState(() => selectedAsset = asset),
                      child: const Text('Chọn'),
                    ),
                    IconButton(
                      tooltip: 'Xóa khỏi thiết bị',
                      onPressed:
                          selectedSubmission != null &&
                              selectedSubmission.lifecycle ==
                                  SubmissionLifecycleState.transferring
                          ? null
                          : () => _discard(asset),
                      icon: const Icon(Icons.delete_outline),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
        if (selectedAsset != null)
          ContentCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  selectedAsset!.originalFilename,
                  style: const TextStyle(fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 10),
                FilledButton.icon(
                  onPressed:
                      selectedSubmission != null &&
                          (selectedSubmission.lifecycle ==
                                  SubmissionLifecycleState.transferring ||
                              selectedSubmission.lifecycle ==
                                  SubmissionLifecycleState.intentPending ||
                              selectedSubmission.lifecycle ==
                                  SubmissionLifecycleState.finalizing)
                      ? () => submissions.cancel(selectedAsset!.id)
                      : selectedSubmission?.lifecycle ==
                            SubmissionLifecycleState.processingAccepted
                      ? null
                      : _submit,
                  icon: Icon(
                    selectedSubmission != null &&
                            selectedSubmission.lifecycle ==
                                SubmissionLifecycleState.transferring
                        ? Icons.cancel_outlined
                        : Icons.cloud_upload_outlined,
                  ),
                  label: Text(
                    selectedSubmission?.lifecycle ==
                            SubmissionLifecycleState.processingAccepted
                        ? 'Đã tiếp nhận xử lý'
                        : selectedSubmission?.lifecycle ==
                              SubmissionLifecycleState.mediaAvailable
                        ? 'Media đã sẵn sàng · tiếp nhận xử lý'
                        : 'Tải lên và xử lý AI',
                  ),
                ),
                if (selectedSubmission?.progress != null) ...[
                  const SizedBox(height: 8),
                  LinearProgressIndicator(value: selectedSubmission!.progress),
                  Text(
                    '${(selectedSubmission.progress! * 100).toStringAsFixed(0)}% tải lên',
                  ),
                ],
                if (selectedSubmission?.lifecycle ==
                    SubmissionLifecycleState.reconciliationRequired)
                  const Text(
                    'Cần đối soát kết quả từ máy chủ trước khi tiếp tục.',
                    style: TextStyle(color: Palette.amber),
                  ),
              ],
            ),
          ),
        if (remoteState != null && remoteState!.media.isNotEmpty)
          ContentCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Media từ các thiết bị được cấp quyền',
                  style: TextStyle(fontWeight: FontWeight.w700),
                ),
                ...remoteState!.media.map(
                  (media) => ListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Text(media.originalFilename),
                    subtitle: Text(media.status.wireValue),
                    trailing: media.accepted
                        ? TextButton(
                            onPressed: _allows(MeetingOperation.admitProcessing)
                                ? () => _submitExisting(media)
                                : null,
                            child: const Text('Xử lý'),
                          )
                        : null,
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }

  Future<void> _submitExisting(MediaRecord media) async {
    try {
      final result = await submissions.admitAvailableMedia(
        meetingId: widget.meetingId,
        mediaId: media.id,
        scope: sessionScope,
        capabilities: widget.capabilities,
      );
      if (mounted) setState(() => submission = result);
    } catch (error) {
      if (mounted) setState(() => failure = error);
    }
  }
}
