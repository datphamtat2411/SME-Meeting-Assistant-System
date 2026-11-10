import 'package:intl/intl.dart';

DateTime? parseLocalDate(dynamic value) =>
    value == null ? null : DateTime.tryParse(value.toString())?.toLocal();

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
  return date == null ? 'Chưa xác định' : DateFormat('dd/MM/yyyy · HH:mm').format(date);
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
  if (value == null) return null;
  final text = value.toString();
  if (!RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(text)) return null;
  return DateTime.tryParse(text);
}
