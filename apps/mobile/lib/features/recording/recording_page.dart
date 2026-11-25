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
import 'recording_workspace_controller.dart';
import 'submission_coordinator.dart';

class RecordingPage extends StatefulWidget {
  const RecordingPage({
    super.key,
    required this.api,
    required this.meetingId,
    required this.enabled,
    this.capabilities,
    this.meetingStatus,
    required this.localMedia,
    required this.mediaRepository,
    required this.processingRepository,
    required this.recordingCoordinator,
    required this.submissionCoordinator,
    required this.processingManager,
  });

  final ApiClient api;
  final String meetingId;
  final bool enabled;
  final MeetingCapabilities? capabilities;
  final MeetingStatus? meetingStatus;
  final LocalMediaRepository localMedia;
  // These repositories remain part of the integration boundary for callers
  // that already compose the recording feature. Execution is delegated to the
  // application-owned coordinators below.
  final MediaRepository mediaRepository;
  final ProcessingRepository processingRepository;
  final RecordingCoordinator recordingCoordinator;
  final SubmissionCoordinator submissionCoordinator;
  final ProcessingManager processingManager;

  @override
  State<RecordingPage> createState() => _RecordingPageState();
}

class _RecordingPageState extends State<RecordingPage> {
  late final RecordingWorkspaceController controller;

  @override
  void initState() {
    super.initState();
    controller = RecordingWorkspaceController(
      api: widget.api,
      meetingId: widget.meetingId,
      capabilities: widget.capabilities,
      meetingStatus: widget.meetingStatus,
      localMedia: widget.localMedia,
      recording: widget.recordingCoordinator,
      submissions: widget.submissionCoordinator,
      processingManager: widget.processingManager,
    )..initialize();
  }

  @override
  void didUpdateWidget(covariant RecordingPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    controller.updateContext(
      meetingId: widget.meetingId,
      capabilities: widget.capabilities,
      meetingStatus: widget.meetingStatus,
    );
  }

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: controller,
    builder: (context, _) {
      controller.updateContext(
        meetingId: widget.meetingId,
        capabilities: widget.capabilities,
        meetingStatus: widget.meetingStatus,
      );
      return _buildWorkspace(context);
    },
  );

  Widget _buildWorkspace(BuildContext context) {
    final capture = controller.recordingState;
    final submission = controller.selectedSubmission;
    final remote = controller.remoteState;
    final canChange = widget.enabled && controller.canUpload;
    final isCapturing = capture.isCapturing;

    if (controller.loadState == RecordingWorkspaceLoadState.loading &&
        controller.assets.isEmpty &&
        controller.recoverableOperations.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }

    return RefreshIndicator(
      onRefresh: controller.refresh,
      child: ListView(
        padding: const EdgeInsets.all(18),
        children: [
          const SectionHeading(
            'Không gian âm thanh',
            subtitle: 'Ghi âm hoặc nhập tệp, sau đó chủ động gửi để xử lý.',
          ),
          if (controller.isSessionFenced || !controller.canReadMedia)
            const MessagePanel(
              icon: Icons.lock_outline,
              title: 'Âm thanh không khả dụng',
              description: 'Quyền truy cập hoặc phiên đăng nhập hiện tại không cho phép xem nội dung cuộc họp.',
            ),
          if (controller.failure != null)
            MessagePanel(
              icon: Icons.cloud_off_outlined,
              title: 'Không thể hoàn tất thao tác',
              description: _failureMessage(controller.failure),
            ),
          _recordingCard(
            context,
            capture,
            canChange: canChange,
            isCapturing: isCapturing,
          ),
          if (capture.lifecycle == RecordingLifecycleState.importing &&
              capture.importProgress != null)
            LinearProgressIndicator(value: capture.importProgress),
          _localMediaSection(context, submission),
          _recoverySection(),
          if (controller.canReadMedia) _remoteSection(context, remote),
          if (controller.canReadMedia) _processingSection(context, remote),
        ],
      ),
    );
  }

  Widget _recordingCard(
    BuildContext context,
    RecordingCoordinatorState capture, {
    required bool canChange,
    required bool isCapturing,
  }) {
    final status = isCapturing
        ? 'Đang ghi âm · ${capture.elapsed.toString().split('.').first}'
        : switch (capture.lifecycle) {
            RecordingLifecycleState.localReady =>
              'Bản ghi đã lưu trên thiết bị',
            RecordingLifecycleState.interrupted =>
              'Ghi âm bị gián đoạn · dữ liệu đã được giữ lại',
            RecordingLifecycleState.failed => 'Ghi âm thất bại',
            _ => 'Sẵn sàng ghi âm',
          };
    return ContentCard(
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
          Text(status, style: const TextStyle(fontWeight: FontWeight.w800)),
          if (isCapturing && capture.meetingId != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                'Cuộc họp ${capture.meetingId}',
                style: const TextStyle(color: Palette.muted, fontSize: 12),
              ),
            ),
          const SizedBox(height: 12),
          if (isCapturing)
            FilledButton.icon(
              onPressed: controller.isBusy ? null : controller.stopRecording,
              icon: const Icon(Icons.stop),
              label: const Text('Dừng ghi âm'),
            )
          else
            FilledButton.icon(
              onPressed:
                  canChange &&
                      widget.meetingStatus == MeetingStatus.inProgress &&
                      !controller.isBusy
                  ? controller.startRecording
                  : null,
              icon: const Icon(Icons.mic),
              label: const Text('Bắt đầu ghi âm'),
            ),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            onPressed: isCapturing || !canChange || controller.isBusy
                ? null
                : controller.importAudio,
            icon: const Icon(Icons.audio_file_outlined),
            label: const Text('Nhập WAV / MP3 / M4A'),
          ),
          if (!canChange)
            const Padding(
              padding: EdgeInsets.only(top: 8),
              child: Text(
                'Bạn có quyền xem nhưng không có quyền thay đổi âm thanh này.',
                textAlign: TextAlign.center,
                style: TextStyle(color: Palette.muted, fontSize: 12),
              ),
            ),
        ],
      ),
    );
  }

  Widget _localMediaSection(BuildContext context, SubmissionState? submission) {
    final assets = controller.assets;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SectionHeading(
          'Âm thanh trên thiết bị',
          subtitle: 'Bản gốc không tự xóa sau khi gửi hoặc xử lý.',
        ),
        if (assets.isEmpty)
          const MessagePanel(
            icon: Icons.audio_file_outlined,
            title: 'Chưa có âm thanh cục bộ',
            description: 'Ghi âm hoặc nhập một tệp được hỗ trợ để bắt đầu.',
          ),
        ...assets.map((asset) => _assetCard(context, asset)),
        if (controller.selectedAsset != null)
          _submissionCard(context, submission),
      ],
    );
  }

  Widget _assetCard(BuildContext context, LocalMediaAsset asset) {
    final selected = controller.selectedAsset?.id == asset.id;
    final state = controller.submissions.stateFor(asset.id);
    final protected = state?.lifecycle == SubmissionLifecycleState.transferring;
    return ContentCard(
      child: ListTile(
        contentPadding: EdgeInsets.zero,
        selected: selected,
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
        subtitle: Text(
          '${asset.sourceType == LocalMediaSourceType.recording ? 'Bản ghi' : 'Tệp nhập'} · '
          '${_assetState(asset)}${asset.sizeBytes == null ? '' : ' · ${_bytes(asset.sizeBytes!)}'}',
        ),
        trailing: Wrap(
          spacing: 2,
          children: [
            OutlinedButton(
              onPressed: asset.isReady && !controller.isBusy
                  ? () => controller.selectAsset(asset)
                  : null,
              child: Text(selected ? 'Đã chọn' : 'Chọn'),
            ),
            IconButton(
              tooltip: 'Xóa bản sao cục bộ',
              onPressed: protected || controller.isBusy
                  ? null
                  : () => _confirmDiscard(context, asset),
              icon: const Icon(Icons.delete_outline),
            ),
          ],
        ),
      ),
    );
  }

  Widget _submissionCard(BuildContext context, SubmissionState? submission) {
    final asset = controller.selectedAsset!;
    final active =
        submission != null &&
        <SubmissionLifecycleState>{
          SubmissionLifecycleState.intentPending,
          SubmissionLifecycleState.intentCreated,
          SubmissionLifecycleState.transferring,
          SubmissionLifecycleState.finalizing,
          SubmissionLifecycleState.processingAdmissionPending,
        }.contains(submission.lifecycle);
    final remoteOnly =
        submission?.lifecycle == SubmissionLifecycleState.mediaAvailable;
    return ContentCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            asset.originalFilename,
            style: const TextStyle(fontWeight: FontWeight.w700),
          ),
          const SizedBox(height: 6),
          Text(_submissionLabel(submission)),
          if (submission?.progress != null) ...[
            const SizedBox(height: 8),
            LinearProgressIndicator(value: submission!.progress),
            Text('${(submission.progress! * 100).round()}% tải lên'),
          ] else if (active)
            const Padding(
              padding: EdgeInsets.only(top: 8),
              child: LinearProgressIndicator(),
            ),
          const SizedBox(height: 10),
          FilledButton.icon(
            onPressed:
                !controller.canUpload ||
                    controller.isBusy ||
                    (submission?.processingAdmitted ?? false)
                ? null
                : active
                ? controller.cancelSubmission
                : controller.submitSelected,
            icon: Icon(active ? Icons.cancel_outlined : Icons.cloud_upload),
            label: Text(
              active
                  ? 'Yêu cầu hủy'
                  : remoteOnly
                  ? 'Tiếp tục xử lý'
                  : 'Gửi và xử lý',
            ),
          ),
          if (submission?.requiresReconciliation == true)
            const Padding(
              padding: EdgeInsets.only(top: 8),
              child: Text(
                'Cần đối soát kết quả từ máy chủ trước khi thử lại.',
                style: TextStyle(color: Palette.amber),
              ),
            ),
        ],
      ),
    );
  }

  Widget _recoverySection() {
    final operations = controller.recoverableOperations;
    if (operations.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SectionHeading(
          'Cần khôi phục',
          subtitle: 'Các thao tác chưa được xác nhận vẫn giữ nguyên định danh.',
        ),
        ...operations.map(
          (operation) => ContentCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.sync_problem_outlined),
                  title: Text(operation.message ?? 'Thao tác cần khôi phục'),
                  subtitle: Text(
                    operation.uploadOperation?.originalFilename ??
                        'Nguồn từ xa · ${operation.meetingId ?? controller.meetingId}',
                  ),
                ),
                Align(
                  alignment: Alignment.centerRight,
                  child: TextButton.icon(
                    onPressed: controller.isBusy
                        ? null
                        : () => controller.resumeRecovery(operation),
                    icon: const Icon(Icons.play_arrow),
                    label: const Text('Khôi phục thao tác này'),
                  ),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _remoteSection(BuildContext context, ProcessingMeetingState? remote) {
    final media = remote?.media ?? const <MediaRecord>[];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SectionHeading(
          'Media từ máy chủ',
          subtitle: 'Nguồn từ xa được giữ riêng theo từng bản ghi.',
        ),
        if (media.isEmpty)
          const MessagePanel(title: 'Chưa có media từ máy chủ'),
        ...media.map(
          (item) => ContentCard(
            child: ListTile(
              contentPadding: EdgeInsets.zero,
              leading: Icon(
                item.accepted
                    ? Icons.cloud_done_outlined
                    : Icons.cloud_outlined,
              ),
              title: Text(item.originalFilename),
              subtitle: Text(_mediaLabel(item)),
              trailing: item.accepted && controller.canAdmitProcessing
                  ? TextButton(
                      onPressed: controller.isBusy
                          ? null
                          : () => controller.admitRemoteMedia(item),
                      child: const Text('Xử lý'),
                    )
                  : null,
            ),
          ),
        ),
      ],
    );
  }

  Widget _processingSection(
    BuildContext context,
    ProcessingMeetingState? remote,
  ) {
    final jobs = remote?.jobs ?? const <ProcessingJobRecord>[];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SectionHeading(
          'Tiến trình xử lý',
          subtitle: remote?.failure == null
              ? 'Trạng thái do bộ quản lý xử lý dùng chung cung cấp.'
              : 'Dữ liệu trước đó có thể đã cũ; hãy làm mới.',
          trailing: IconButton(
            tooltip: 'Làm mới',
            onPressed: controller.isBusy ? null : controller.refresh,
            icon: const Icon(Icons.refresh),
          ),
        ),
        if (remote?.isRefreshing == true) const LinearProgressIndicator(),
        if (remote?.failure != null)
          MessagePanel(
            icon: Icons.warning_amber_outlined,
            title: 'Không thể làm mới xử lý',
            description: 'Đang giữ lại dữ liệu hợp lệ gần nhất.',
            onRetry: controller.refresh,
          ),
        if (jobs.isEmpty)
          const MessagePanel(
            icon: Icons.hourglass_empty,
            title: 'Chưa có tác vụ xử lý',
          ),
        ...jobs.map((job) => _jobCard(context, job)),
      ],
    );
  }

  Widget _jobCard(BuildContext context, ProcessingJobRecord job) {
    final handoff = controller.reviewHandoff(job);
    final canReprocess =
        controller.canAdmitProcessing &&
        job.status.isTerminal &&
        job.sourceMediaId != null;
    return ContentCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.auto_awesome, color: Palette.blue),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  _jobLabel(job),
                  style: const TextStyle(fontWeight: FontWeight.w700),
                ),
              ),
              StatePill(job.status.wireValue),
            ],
          ),
          if (job.currentStage != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text('Giai đoạn: ${job.currentStage}'),
            ),
          if (job.warningSummary != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                job.warningSummary!,
                style: const TextStyle(color: Palette.amber),
              ),
            ),
          if (job.errorSummary != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                job.errorSummary!,
                style: const TextStyle(color: Palette.red),
              ),
            ),
          Wrap(
            spacing: 8,
            children: [
              if (job.retryable && controller.canRetryProcessing)
                TextButton(
                  onPressed: controller.isBusy
                      ? null
                      : () => controller.retryProcessing(job),
                  child: const Text('Thử lại'),
                ),
              if (canReprocess)
                TextButton(
                  onPressed: controller.isBusy
                      ? null
                      : () => _confirmReprocess(job),
                  child: const Text('Xử lý lại'),
                ),
              if (handoff != null)
                OutlinedButton(
                  onPressed: () => _showReviewUnavailable(handoff),
                  child: const Text('Mở duyệt bản ghi'),
                ),
            ],
          ),
        ],
      ),
    );
  }

  Future<void> _confirmDiscard(
    BuildContext context,
    LocalMediaAsset asset,
  ) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Xóa bản sao cục bộ?'),
        content: const Text(
          'Xóa bản sao trên thiết bị không xóa media đã được máy chủ chấp nhận.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Giữ lại'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Xóa'),
          ),
        ],
      ),
    );
    if (confirmed == true) await controller.discardAsset(asset);
  }

  Future<void> _confirmReprocess(ProcessingJobRecord job) async {
    final source = job.sourceMediaId;
    if (source == null) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Xử lý lại?'),
        content: const Text(
          'Tạo kết quả xử lý mới từ media hiện có và giữ lại kết quả trước đó.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: const Text('Quay lại'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Xác nhận'),
          ),
        ],
      ),
    );
    if (confirmed == true) {
      await controller.reprocess(job, sourceMediaId: source);
    }
  }

  void _showReviewUnavailable(TranscriptReviewHandoff handoff) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          'Bản ghi ${handoff.jobId} sẵn sàng để duyệt; màn hình duyệt chưa khả dụng.',
        ),
      ),
    );
  }

  String _assetState(LocalMediaAsset asset) => switch (asset.lifecycle) {
    LocalMediaLifecycle.ready => 'Sẵn sàng',
    LocalMediaLifecycle.interrupted => 'Bị gián đoạn · cần kiểm tra',
    LocalMediaLifecycle.missing => 'Không tìm thấy tệp',
    LocalMediaLifecycle.unavailable => 'Không khả dụng',
    LocalMediaLifecycle.staged ||
    LocalMediaLifecycle.promotionPending => 'Đang khôi phục',
    _ => 'Chưa sẵn sàng',
  };

  String _submissionLabel(SubmissionState? state) => state == null
      ? 'Sẵn sàng gửi chủ động'
      : switch (state.lifecycle) {
          SubmissionLifecycleState.localReady => 'Sẵn sàng gửi',
          SubmissionLifecycleState.intentPending => 'Đang tạo quyền tải lên',
          SubmissionLifecycleState.intentCreated => 'Đã chuẩn bị tải lên',
          SubmissionLifecycleState.transferring => 'Đang tải âm thanh',
          SubmissionLifecycleState.transferred => 'Đã tải âm thanh',
          SubmissionLifecycleState.finalizing => 'Đang xác nhận media',
          SubmissionLifecycleState.mediaAvailable =>
            'Media đã sẵn sàng · chưa tiếp nhận xử lý',
          SubmissionLifecycleState.processingAdmissionPending =>
            'Đang tiếp nhận xử lý',
          SubmissionLifecycleState.processingAccepted => 'Đã tiếp nhận xử lý',
          SubmissionLifecycleState.recoverableFailure => 'Có thể thử lại',
          SubmissionLifecycleState.cancelled => 'Đã hủy · có thể khôi phục',
          SubmissionLifecycleState.waitingForConnectivity => 'Đang chờ kết nối',
          SubmissionLifecycleState.reconciliationRequired =>
            'Cần đối soát kết quả từ máy chủ',
          SubmissionLifecycleState.definitiveRejection => 'Media bị từ chối',
          SubmissionLifecycleState.authorizationConflict =>
            'Quyền truy cập đã thay đổi',
        };

  String _mediaLabel(MediaRecord media) => switch (media.status) {
    MediaStatus.pendingUpload => 'Đang chờ tải lên',
    MediaStatus.available => 'Đã sẵn sàng',
    MediaStatus.rejected => 'Bị từ chối',
    MediaStatus.failed => 'Thất bại',
  };

  String _jobLabel(ProcessingJobRecord job) => switch (job.status) {
    ProcessingJobStatus.pending => 'Đang chờ',
    ProcessingJobStatus.queued => 'Đã xếp hàng',
    ProcessingJobStatus.running => 'Đang xử lý',
    ProcessingJobStatus.waitingForReview => 'Chờ duyệt bản ghi',
    ProcessingJobStatus.completed => 'Đã hoàn tất',
    ProcessingJobStatus.completedWithWarnings => 'Hoàn tất có cảnh báo',
    ProcessingJobStatus.failed => 'Xử lý thất bại',
    ProcessingJobStatus.cancelled => 'Đã hủy',
  };

  String _bytes(int value) {
    if (value < 1024 * 1024) return '${(value / 1024).round()} KB';
    return '${(value / (1024 * 1024)).toStringAsFixed(1)} MB';
  }

  String _failureMessage(Object? error) {
    if (error is ApiFailure) return error.message;
    if (error is AudioImportException) return error.message;
    if (error is RecordingEligibilityException) return error.message;
    return 'Đã xảy ra lỗi không mong muốn.';
  }
}
