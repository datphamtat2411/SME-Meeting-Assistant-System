import 'package:intl/intl.dart';

import 'api_model_validation.dart';

DateTime? parseLocalDate(dynamic value) {
  if (value == null) return null;
  if (value is DateTime) return value.toLocal();
  if (value is! String) return null;
  if (isValidDateOnly(value)) {
    final parts = value.split('-').map(int.parse).toList(growable: false);
    return DateTime(parts[0], parts[1], parts[2]);
  }
  return tryParseApiTimestamp(value)?.toLocal();
}

String localTimeLabel(dynamic value) {
  final date = parseLocalDate(value);
  return date == null ? 'Chưa xác định' : DateFormat('HH:mm').format(date);
}

String localDateLabel(dynamic value) {
  final date = parseLocalDate(value);
  return date == null ? 'Chưa xác định' : DateFormat('dd/MM/yyyy').format(date);
}

String localDateTimeLabel(dynamic value) {
  final date = parseLocalDate(value);
  return date == null
      ? 'Chưa xác định'
      : DateFormat('dd/MM/yyyy · HH:mm').format(date);
}

String durationLabel(int milliseconds) {
  final total = milliseconds < 0 ? 0 : milliseconds ~/ 1000;
  final h = (total ~/ 3600).toString().padLeft(2, '0');
  final m = ((total % 3600) ~/ 60).toString().padLeft(2, '0');
  final s = (total % 60).toString().padLeft(2, '0');
  return total >= 3600 ? '$h:$m:$s' : '$m:$s';
}

String dateOnly(DateTime date) => DateFormat('yyyy-MM-dd').format(date);
DateTime? parseDateOnly(dynamic value) {
  if (value is! String || !isValidDateOnly(value)) return null;
  final parts = value.split('-').map(int.parse).toList(growable: false);
  return DateTime(parts[0], parts[1], parts[2]);
}
