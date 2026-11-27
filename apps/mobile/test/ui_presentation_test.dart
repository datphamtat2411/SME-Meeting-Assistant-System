import 'package:flutter_test/flutter_test.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/ui_presentation.dart';

void main() {
  test('does not expose authentication or server diagnostics', () {
    for (final status in [401, 403, 404, 500, 502, 503, 504, 599]) {
      final failure = ApiFailure(status, 'ERROR', 'private diagnostic');
      expect(apiFailureLabel(failure), isNot(contains('private diagnostic')));
      expect(failure.message, 'private diagnostic');
    }
  });

  test('preserves uncertain outcome guidance and business detail', () {
    const unknown = ApiFailure(
      504,
      'INTERNAL_ERROR',
      'private diagnostic',
      remoteOutcomeAmbiguous: true,
    );
    expect(apiFailureLabel(unknown), contains('Chưa xác định'));
    const conflict = ApiFailure(409, 'RESOURCE_CONFLICT', 'Phòng đã được đặt.');
    expect(apiFailureLabel(conflict), 'Phòng đã được đặt.');
    const room = ApiFailure(409, 'MEETING_ROOM_CONFLICT', 'Room conflict.');
    expect(apiFailureLabel(room), contains('chọn phòng hoặc thời gian khác'));
  });

  test('structured field errors remain useful and local errors stay distinct', () {
    const validation = ApiFailure(
      422,
      'VALIDATION_ERROR',
      'Validation failed.',
      errors: [
        ApiFieldError(
          field: 'startsAt',
          code: 'INVALID_VALUE',
          message: 'Giờ bắt đầu không hợp lệ.',
        ),
      ],
    );
    expect(apiFailureLabel(validation), contains('Giờ bắt đầu không hợp lệ.'));
    const local = ApiFailure(0, 'MEMBERSHIP_OUTCOME_UNKNOWN', 'Unknown.');
    expect(apiFailureLabel(local), contains('Chưa xác định'));
    expect(apiFailureLabel(local), isNot(contains('kết nối')));
  });

  test('unknown exceptions do not reach presentation', () {
    expect(
      apiFailureLabel(StateError('private diagnostic')),
      'Thao tác không thành công.',
    );
  });
}
