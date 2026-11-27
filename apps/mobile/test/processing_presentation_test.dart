import 'package:flutter_test/flutter_test.dart';
import 'package:sme_meeting_assistant/features/recording/media_contracts.dart';
import 'package:sme_meeting_assistant/features/recording/processing_presentation.dart';

void main() {
  test('job and stage labels preserve review, warning and failure distinctions', () {
    expect(
      ProcessingJobStatus.values.map(processingJobStatusLabel),
      [
        'Chờ xử lý',
        'Chờ xử lý',
        'Đang xử lý',
        'Cần xem xét',
        'Hoàn thành',
        'Hoàn thành có cảnh báo',
        'Xử lý thất bại',
        'Đã hủy',
      ],
    );
    expect(
      processingStageStatusLabel(ProcessingStageStatus.succeededWithWarning),
      'Hoàn thành có cảnh báo',
    );
    expect(ProcessingJobStatus.waitingForReview.wireValue, 'WAITING_FOR_REVIEW');
    expect(ProcessingJobStatus.waitingForReview.isSuccessful, isFalse);
  });

  test('stage codes are displayed without rewriting the contract', () {
    expect(processingStageLabel('TRANSCRIPTION'), 'Nhận dạng lời nói');
    expect(processingStageLabel('DIARIZING'), 'Phân biệt người nói');
    expect(
      processingStageLabel('TRANSCRIPT_REVIEW'),
      'Rà soát bản ghi lời thoại',
    );
    expect(processingStageLabel('FUTURE_STAGE'), contains('chưa được nhận diện'));
  });

  test('known failures retain their specific meaning in Vietnamese', () {
    expect(
      processingFailureLabel('DIARIZATION_SOURCE_STALE', 'Source changed.'),
      'Nguồn phân biệt người nói đã thay đổi.',
    );
    expect(
      processingFailureLabel('STAGE_LEASE_EXPIRED', 'Worker stopped.'),
      'Tác vụ ngừng báo cáo tiến độ.',
    );
  });
}
