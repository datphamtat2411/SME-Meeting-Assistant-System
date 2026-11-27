import 'api_client.dart';

/// Presentation only: preserve the original failure and its machine-readable
/// fields for recovery, but never render arbitrary diagnostics.
String apiFailureLabel(Object? error) {
  if (error is AuthSessionException) return error.failure.message;
  if (error is! ApiFailure) return 'Thao tác không thành công.';

  if (error.authenticationFailure || error.code.startsWith('AUTH_')) {
    return 'Phiên đăng nhập đã hết hiệu lực. Vui lòng đăng nhập lại.';
  }
  if (error.authorizationFailure || error.code.startsWith('AUTHZ_')) {
    return 'Bạn không có quyền thực hiện thao tác này.';
  }
  if (error.remoteOutcomeAmbiguous) {
    return 'Chưa xác định được kết quả thao tác. Hãy kiểm tra trạng thái hiện tại trước khi thử lại.';
  }
  if (error.invalidResponse) {
    return 'Máy chủ trả về dữ liệu không hợp lệ.';
  }
  if (error.rateLimited || error.code.startsWith('RATE_LIMIT_')) {
    return 'Quá nhiều yêu cầu. Vui lòng thử lại sau.';
  }
  if (error.status == 408 ||
      error.code == 'NETWORK_TIMEOUT' ||
      error.code == 'REQUEST_TIMEOUT') {
    return 'Yêu cầu đã hết thời gian chờ. Vui lòng thử lại.';
  }
  if (error.serverFailure || error.code.startsWith('INTERNAL_')) {
    return 'Dịch vụ tạm thời không khả dụng. Vui lòng thử lại sau.';
  }
  if (error.code == 'MEMBERSHIP_OUTCOME_UNKNOWN') {
    return 'Chưa xác định được trạng thái người tham gia. Hãy tải lại trước khi thử lại.';
  }
  if (error.code == 'MEMBERSHIP_NOT_CHANGED') {
    return 'Danh sách người tham gia chưa được thay đổi.';
  }
  if (error.code == 'PROFILE_INVALID_NAME') {
    return 'Tên hiển thị không hợp lệ.';
  }
  if (error.code == 'PREFERENCE_INVALID_VALUE') {
    return 'Giá trị cài đặt không hợp lệ.';
  }
  if (error.code == 'REVIEW_SOURCE_MISMATCH') {
    return 'Bản ghi đã hoàn tất không khớp với tác vụ xử lý đã chọn.';
  }
  if (error.transportFailure) {
    return 'Không thể kết nối đến máy chủ. Hãy kiểm tra kết nối mạng.';
  }
  if (error.missing) return 'Dữ liệu không còn khả dụng.';
  if (error.payloadTooLarge) return 'File vượt quá dung lượng cho phép.';
  if (error.unsupportedMediaType) return 'Định dạng file không được hỗ trợ.';
  if (error.concurrencyFailure) {
    return 'Dữ liệu đã thay đổi. Hãy tải lại trước khi tiếp tục.';
  }

  // Core's structured 4xx business outcomes have a safe public message
  // contract. Preserve the detail only for the relevant category.
  if (error.businessConflict) {
    if (error.code == 'MEETING_ROOM_CONFLICT') {
      return 'Phòng họp đã được đặt trong khung giờ này. Vui lòng chọn phòng hoặc thời gian khác.';
    }
    if (error.code == 'RESOURCE_CONFLICT' && error.message.trim().isNotEmpty) {
      return error.message;
    }
    return 'Trạng thái hiện tại không cho phép thao tác. Hãy kiểm tra lại.';
  }
  if (error.validationFailure || error.malformedRequest) {
    const message = 'Thông tin chưa hợp lệ. Vui lòng kiểm tra lại.';
    final details = error.errors
        .map((field) => field.message.trim())
        .where((detail) => detail.isNotEmpty && detail != message)
        .toSet();
    return details.isEmpty ? message : '$message\n${details.join('\n')}';
  }
  return 'Thao tác không thành công. Vui lòng thử lại.';
}
