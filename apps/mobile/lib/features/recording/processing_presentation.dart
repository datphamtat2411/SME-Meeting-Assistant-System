import 'media_contracts.dart';

String processingJobStatusLabel(ProcessingJobStatus status) => switch (status) {
  ProcessingJobStatus.pending || ProcessingJobStatus.queued => 'Chờ xử lý',
  ProcessingJobStatus.running => 'Đang xử lý',
  ProcessingJobStatus.waitingForReview => 'Cần xem xét',
  ProcessingJobStatus.completed => 'Hoàn thành',
  ProcessingJobStatus.completedWithWarnings => 'Hoàn thành có cảnh báo',
  ProcessingJobStatus.failed => 'Xử lý thất bại',
  ProcessingJobStatus.cancelled => 'Đã hủy',
};

String processingStageStatusLabel(ProcessingStageStatus status) =>
    switch (status) {
      ProcessingStageStatus.pending => 'Chờ xử lý',
      ProcessingStageStatus.running => 'Đang xử lý',
      ProcessingStageStatus.succeeded => 'Hoàn thành',
      ProcessingStageStatus.succeededWithWarning => 'Hoàn thành có cảnh báo',
      ProcessingStageStatus.failed => 'Thất bại',
      ProcessingStageStatus.skipped => 'Đã bỏ qua',
      ProcessingStageStatus.cancelled => 'Đã hủy',
    };

String processingJobTypeLabel(ProcessingJobType type) => switch (type) {
  ProcessingJobType.offlineMeetingProcessing => 'Xử lý cuộc họp',
  ProcessingJobType.derivedStageProcessing => 'Xử lý kết quả AI',
};

String processingStageLabel(String? code) => switch (code) {
  null => 'Xử lý AI',
  'TRANSCRIPTION' || 'TRANSCRIBING' => 'Nhận dạng lời nói',
  'CONTEXTUAL_CORRECTION' => 'Hiệu chỉnh bản ghi theo ngữ cảnh',
  'FINALIZING_TRANSCRIPT' => 'Hoàn tất bản ghi lời thoại',
  'TRANSCRIPT_REVIEW' || 'TRANSCRIPTION_REVIEW' => 'Rà soát bản ghi lời thoại',
  'DIARIZATION' || 'DIARIZING' => 'Phân biệt người nói',
  'GENERATING_SUMMARY' => 'Tạo bản tóm tắt',
  'EXTRACTING_DECISIONS' => 'Trích xuất quyết định',
  'EXTRACTING_ACTION_ITEMS' => 'Trích xuất công việc',
  'INDEXING' => 'Lập chỉ mục',
  'INDEXED' => 'Đã lập chỉ mục',
  'MEETING_INTELLIGENCE' => 'Phân tích cuộc họp',
  _ => 'Giai đoạn chưa được nhận diện ($code)',
};

/// Mirrors Core's closed SafeProcessingFailureSummary code mapping. The
/// fallback summary is the public Core message, not a worker exception.
String processingFailureLabel(String? code, String? summary) => switch (code) {
  'STAGE_LEASE_EXPIRED' => 'Tác vụ ngừng báo cáo tiến độ.',
  'WORKER_DELIVERY_EXHAUSTED' =>
    'Cần khôi phục tác vụ theo xác nhận từ máy chủ.',
  'ASR_FAILED' || 'TRANSCRIPTION_TEMPORARY' => 'Nhận dạng lời nói thất bại.',
  'TRANSCRIPTION_EVIDENCE_INVALID' => 'Không thể xác minh bằng chứng bản ghi.',
  'LLM_CORRECTION_FAILED' => 'Hiệu chỉnh bản ghi theo ngữ cảnh thất bại.',
  'DIARIZATION_FAILED' => 'Phân biệt người nói thất bại.',
  'DIARIZATION_SOURCE_STALE' => 'Nguồn phân biệt người nói đã thay đổi.',
  'SUMMARY_FAILED' ||
  'SUMMARY_PROVIDER_FAILURE' => 'Tạo bản tóm tắt cuộc họp thất bại.',
  'PROCESSING_DISPATCH_FAILED' =>
    'Không thể chuyển tác vụ sang hệ thống xử lý.',
  _ => summary ?? 'Giai đoạn xử lý thất bại.',
};
