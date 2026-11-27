/// Domain-specific labels prevent meeting, review and work states with the
/// same wire value from acquiring the wrong meaning.
String transcriptStatusLabel(String status) => switch (status) {
  'READY' => 'Sẵn sàng',
  'READY_WITH_WARNINGS' => 'Sẵn sàng, có cảnh báo',
  'PROCESSING' => 'Đang xử lý',
  'FAILED' => 'Thất bại',
  _ => 'Trạng thái chưa được nhận diện ($status)',
};

String transcriptQualityLabel(String quality) => switch (quality) {
  'HIGH' => 'Chất lượng cao',
  'ACCEPTED' => 'Đã chấp nhận',
  'SUSPICIOUS' => 'Cần kiểm tra',
  'UNRESOLVED' || 'UNRESOLVED_ERROR' => 'Lỗi chưa được xử lý',
  _ => 'Chất lượng chưa được nhận diện ($quality)',
};

String summaryQualityLabel(String quality) => switch (quality) {
  'CONFIRMED' => 'Đã xác nhận',
  'WARNING' => 'Có cảnh báo',
  _ => transcriptStatusLabel(quality),
};

String decisionStatusLabel(String status) => switch (status) {
  'PROPOSED' => 'Đề xuất',
  'CONFIRMED' => 'Đã xác nhận',
  'REJECTED' => 'Đã từ chối',
  _ => 'Trạng thái chưa được nhận diện ($status)',
};

String resultSourceLabel(String? source) => switch (source) {
  'AI' || 'AI_GENERATED' => 'Do AI tạo',
  'AI_EXTRACTED' => 'AI trích xuất',
  'HUMAN_EDIT' => 'Do người dùng chỉnh sửa',
  'MANUAL' => 'Do người dùng tạo',
  null => 'Không có thông tin nguồn',
  _ => 'Nguồn chưa được nhận diện ($source)',
};
