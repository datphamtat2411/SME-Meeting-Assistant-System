import 'api_response.dart';

final RegExp _offsetTimestampPattern = RegExp(
  r'^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|([+-])(\d{2}):(\d{2}))$',
);
final RegExp _dateOnlyPattern = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$');

Never invalidApiData({ApiResult? response, String? requestId}) {
  throw response?.invalidDataFailure() ??
      ApiFailure(
        0,
        ApiFailure.invalidResponseCode,
        'The server returned an invalid response.',
        requestId: requestId,
      );
}

String requiredString(
  Map<String, dynamic> raw,
  String field, {
  ApiResult? response,
  bool nonEmpty = false,
}) {
  final value = raw[field];
  if (value is! String || (nonEmpty && value.trim().isEmpty)) {
    invalidApiData(response: response);
  }
  return value;
}

String requiredIdentifier(
  Map<String, dynamic> raw,
  String field, {
  ApiResult? response,
}) => requiredString(raw, field, response: response, nonEmpty: true);

String? optionalString(
  Map<String, dynamic> raw,
  String field, {
  ApiResult? response,
}) {
  if (!raw.containsKey(field) || raw[field] == null) return null;
  final value = raw[field];
  if (value is! String) invalidApiData(response: response);
  return value;
}

String? optionalIdentifier(
  Map<String, dynamic> raw,
  String field, {
  ApiResult? response,
}) {
  final value = optionalString(raw, field, response: response);
  if (value != null && value.trim().isEmpty) {
    invalidApiData(response: response);
  }
  return value;
}

int requiredInt(
  Map<String, dynamic> raw,
  String field, {
  ApiResult? response,
  int minimum = 0,
}) {
  final value = raw[field];
  if (value is! int || value < minimum) invalidApiData(response: response);
  return value;
}

int? optionalInt(
  Map<String, dynamic> raw,
  String field, {
  ApiResult? response,
  int minimum = 0,
}) {
  if (!raw.containsKey(field) || raw[field] == null) return null;
  return requiredInt(raw, field, response: response, minimum: minimum);
}

bool requiredBool(
  Map<String, dynamic> raw,
  String field, {
  ApiResult? response,
}) {
  final value = raw[field];
  if (value is! bool) invalidApiData(response: response);
  return value;
}

Map<String, dynamic> requiredObject(
  Map<String, dynamic> raw,
  String field, {
  ApiResult? response,
}) {
  if (!raw.containsKey(field)) invalidApiData(response: response);
  return requireJsonObject(raw[field], response: response);
}

Map<String, dynamic>? optionalObject(
  Map<String, dynamic> raw,
  String field, {
  ApiResult? response,
}) {
  if (!raw.containsKey(field) || raw[field] == null) return null;
  return requireJsonObject(raw[field], response: response);
}

DateTime requiredTimestamp(
  Map<String, dynamic> raw,
  String field, {
  ApiResult? response,
}) {
  final value = raw[field];
  final parsed = value is String ? tryParseApiTimestamp(value) : null;
  if (parsed == null) invalidApiData(response: response);
  return parsed;
}

DateTime? optionalTimestamp(
  Map<String, dynamic> raw,
  String field, {
  ApiResult? response,
}) {
  if (!raw.containsKey(field) || raw[field] == null) return null;
  final value = raw[field];
  final parsed = value is String ? tryParseApiTimestamp(value) : null;
  if (parsed == null) invalidApiData(response: response);
  return parsed;
}

/// Parses RFC 3339 timestamps only when an explicit UTC offset is present.
/// The returned value is normalized to UTC without changing its instant.
DateTime? tryParseApiTimestamp(String value) {
  final match = _offsetTimestampPattern.firstMatch(value);
  if (match == null) return null;
  final year = int.parse(match[1]!);
  final month = int.parse(match[2]!);
  final day = int.parse(match[3]!);
  final hour = int.parse(match[4]!);
  final minute = int.parse(match[5]!);
  final second = int.parse(match[6]!);
  if (year == 0 ||
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > DateTime.utc(year, month + 1, 0).day ||
      hour > 23 ||
      minute > 59 ||
      second > 59) {
    return null;
  }
  if (match[8] != null &&
      (int.parse(match[9]!) > 23 || int.parse(match[10]!) > 59)) {
    return null;
  }
  final parsed = DateTime.tryParse(value);
  return parsed?.toUtc();
}

String? optionalDateOnly(
  Map<String, dynamic> raw,
  String field, {
  ApiResult? response,
}) {
  if (!raw.containsKey(field) || raw[field] == null) return null;
  final value = raw[field];
  if (value is! String || !isValidDateOnly(value)) {
    invalidApiData(response: response);
  }
  return value;
}

bool isValidDateOnly(String value) {
  final match = _dateOnlyPattern.firstMatch(value);
  if (match == null) return false;
  final year = int.parse(match[1]!);
  final month = int.parse(match[2]!);
  final day = int.parse(match[3]!);
  return year > 0 &&
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= DateTime.utc(year, month + 1, 0).day;
}
