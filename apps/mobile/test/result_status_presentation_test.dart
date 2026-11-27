import 'package:flutter_test/flutter_test.dart';
import 'package:sme_meeting_assistant/features/results/result_status_presentation.dart';

void main() {
  test('review states remain distinct from official decisions', () {
    expect(decisionStatusLabel('PROPOSED'), 'Đề xuất');
    expect(decisionStatusLabel('CONFIRMED'), 'Đã xác nhận');
    expect(decisionStatusLabel('REJECTED'), 'Đã từ chối');
  });

  test('transcript warnings are not presented as ready', () {
    expect(transcriptStatusLabel('READY'), 'Sẵn sàng');
    expect(
      transcriptStatusLabel('READY_WITH_WARNINGS'),
      'Sẵn sàng, có cảnh báo',
    );
    expect(transcriptQualityLabel('UNRESOLVED_ERROR'), 'Lỗi chưa được xử lý');
    expect(transcriptStatusLabel('FUTURE'), contains('chưa được nhận diện'));
  });

  test('source presentation distinguishes AI from human content', () {
    expect(resultSourceLabel('AI_EXTRACTED'), 'AI trích xuất');
    expect(resultSourceLabel('HUMAN_EDIT'), 'Do người dùng chỉnh sửa');
  });
}
