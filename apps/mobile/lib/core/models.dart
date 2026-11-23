import 'package:intl/intl.dart';

import 'api_client.dart';

String textValue(dynamic v, [String fallback = '']) =>
    v == null ? fallback : v.toString();

DateTime? dateValue(dynamic value) =>
    DateTime.tryParse(textValue(value))?.toLocal();

String dateLabel(dynamic value, {bool time = true}) {
  final date = dateValue(value);
  if (date == null) return 'Chưa xác định';
  return DateFormat(time ? 'dd/MM/yyyy · HH:mm' : 'dd/MM/yyyy').format(date);
}

String dateIso(DateTime value) => value.toUtc().toIso8601String();

class Meeting {
  final String id;
  final String title;
  final String description;
  final String status;
  final String? scheduledStartAt;
  final String? scheduledEndAt;
  final String? roomId;
  final String organizerId;
  final String? organizerName;
  final String? roomName;
  final int participantCount;

  const Meeting({
    required this.id, required this.title, required this.description,
    required this.status, this.scheduledStartAt, this.scheduledEndAt,
    this.roomId, required this.organizerId,
    this.organizerName, this.roomName, this.participantCount = 0,
  });

  factory Meeting.fromJson(Map<String, dynamic> json) {
    final display = objectOf(json['display']);
    return Meeting(
      id: textValue(json['id']),
      title: textValue(json['title'], 'Untitled meeting'),
      description: textValue(json['description']),
      status: textValue(json['status'], 'DRAFT'),
      scheduledStartAt: json['scheduledStartAt']?.toString(),
      scheduledEndAt: json['scheduledEndAt']?.toString(),
      roomId: json['roomId']?.toString(),
      organizerId: textValue(json['organizerUserId']),
      organizerName: display['organizerName']?.toString(),
      roomName: display['roomName']?.toString(),
      participantCount: (display['participantCount'] as num?)?.toInt() ?? 0,
    );
  }
}

class ActionItem {
  final String id;
  final String meetingId;
  final String title;
  final String details;
  final String status;
  final String assigneeId;
  final String? dueDate;
  final bool overdue;
  final int version;

  ActionItem(Map<String, dynamic> raw)
      : id = textValue(raw['id']),
        meetingId = textValue(raw['meetingId']),
        title = textValue(raw['title']),
        details = textValue(raw['details']),
        status = textValue(raw['status']),
        assigneeId = textValue(raw['assigneeUserId']),
        dueDate = raw['dueDate']?.toString(),
        overdue = raw['overdue'] == true,
        version = (raw['version'] as num?)?.toInt() ?? 0;
}

class ProcessingJob {
  final String id;
  final String status;
  final String stage;
  final String warning;
  final String error;
  final bool retryable;
  ProcessingJob(Map<String, dynamic> raw)
      : id = textValue(raw['id']),
        status = textValue(raw['status']),
        stage = textValue(raw['currentStage']),
        warning = textValue(raw['warningSummary']),
        error = textValue(raw['errorSummary']),
        retryable = raw['retryable'] == true;
}

const meetingStates = <String, String>{
  'DRAFT': 'Bản nháp',
  'SCHEDULED': 'Đã lên lịch',
  'IN_PROGRESS': 'Đang diễn ra',
  'ENDED': 'Đã kết thúc',
  'CANCELLED': 'Đã hủy',
};

const actionStates = <String, String>{
  'PROPOSED': 'AI đề xuất',
  'OPEN': 'Cần làm',
  'IN_PROGRESS': 'Đang thực hiện',
  'DONE': 'Hoàn thành',
  'CANCELLED': 'Đã hủy',
  'REJECTED': 'Đã từ chối',
};
