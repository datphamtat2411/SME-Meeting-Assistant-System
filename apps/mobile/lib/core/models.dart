import 'package:intl/intl.dart';

import 'api_client.dart';
import 'api_model_validation.dart';

String textValue(dynamic v, [String fallback = '']) =>
    v == null ? fallback : v.toString();

DateTime? dateValue(dynamic value) {
  if (value == null) return null;
  if (value is DateTime) return value.toLocal();
  if (value is! String) return null;
  return tryParseApiTimestamp(value)?.toLocal();
}

String dateLabel(dynamic value, {bool time = true}) {
  final date = dateValue(value);
  if (date == null) return 'Chưa xác định';
  return DateFormat(time ? 'dd/MM/yyyy · HH:mm' : 'dd/MM/yyyy').format(date);
}

String dateIso(DateTime value) => value.toUtc().toIso8601String();

enum MeetingStatus {
  draft('DRAFT'),
  scheduled('SCHEDULED'),
  inProgress('IN_PROGRESS'),
  ended('ENDED'),
  cancelled('CANCELLED');

  const MeetingStatus(this.wireValue);

  final String wireValue;

  static MeetingStatus fromWireValue(String value, {ApiResult? response}) =>
      switch (value) {
        'DRAFT' => MeetingStatus.draft,
        'SCHEDULED' => MeetingStatus.scheduled,
        'IN_PROGRESS' => MeetingStatus.inProgress,
        'ENDED' => MeetingStatus.ended,
        'CANCELLED' => MeetingStatus.cancelled,
        _ => _invalidMeetingStatus(response),
      };
}

class Meeting {
  final String id;
  final String title;
  final String? description;
  final String status;
  final MeetingStatus? lifecycleStatus;
  final DateTime? scheduledStartAt;
  final DateTime? scheduledEndAt;
  final DateTime? startedAt;
  final DateTime? endedAt;
  final DateTime? cancelledAt;
  final String? cancellationReason;
  final String? roomId;
  final String organizerId;
  final String createdByUserId;
  final DateTime createdAt;
  final DateTime updatedAt;
  final MeetingDisplay? display;

  const Meeting({
    required this.id,
    required this.title,
    required this.description,
    required this.status,
    this.lifecycleStatus,
    required this.scheduledStartAt,
    required this.scheduledEndAt,
    required this.startedAt,
    required this.endedAt,
    required this.cancelledAt,
    required this.cancellationReason,
    required this.roomId,
    required this.organizerId,
    required this.createdByUserId,
    required this.createdAt,
    required this.updatedAt,
    required this.display,
  });

  factory Meeting.fromJson(Map<String, dynamic> json, {ApiResult? response}) =>
      _decode(json, response: response, requireDisplay: false);

  /// Canonical repository decoder. It validates any supplied display object
  /// for shape but keeps list-only metadata outside the meeting representation.
  factory Meeting.fromCanonicalJson(
    Map<String, dynamic> json, {
    ApiResult? response,
  }) => _decode(
    json,
    response: response,
    requireDisplay: false,
    attachDisplay: false,
  );

  factory Meeting.fromListJson(
    Map<String, dynamic> json, {
    ApiResult? response,
  }) => _decode(json, response: response, requireDisplay: true);

  static Meeting _decode(
    Map<String, dynamic> json, {
    ApiResult? response,
    required bool requireDisplay,
    bool attachDisplay = true,
  }) {
    final displayJson = requireDisplay
        ? requiredObject(json, 'display', response: response)
        : optionalObject(json, 'display', response: response);
    final lifecycleStatus = MeetingStatus.fromWireValue(
      requiredString(json, 'status', response: response, nonEmpty: true),
      response: response,
    );
    final scheduledStartAt = optionalTimestamp(
      json,
      'scheduledStartAt',
      response: response,
    );
    final scheduledEndAt = optionalTimestamp(
      json,
      'scheduledEndAt',
      response: response,
    );
    if ((scheduledStartAt == null) != (scheduledEndAt == null) ||
        (scheduledStartAt != null &&
            !scheduledStartAt.isBefore(scheduledEndAt!))) {
      invalidApiData(response: response);
    }
    return Meeting(
      id: requiredIdentifier(json, 'id', response: response),
      title: requiredString(json, 'title', response: response, nonEmpty: true),
      description: optionalString(json, 'description', response: response),
      status: lifecycleStatus.wireValue,
      lifecycleStatus: lifecycleStatus,
      scheduledStartAt: scheduledStartAt,
      scheduledEndAt: scheduledEndAt,
      startedAt: optionalTimestamp(json, 'startedAt', response: response),
      endedAt: optionalTimestamp(json, 'endedAt', response: response),
      cancelledAt: optionalTimestamp(json, 'cancelledAt', response: response),
      cancellationReason: optionalString(
        json,
        'cancellationReason',
        response: response,
      ),
      roomId: optionalIdentifier(json, 'roomId', response: response),
      organizerId: requiredIdentifier(
        json,
        'organizerUserId',
        response: response,
      ),
      createdByUserId: requiredIdentifier(
        json,
        'createdByUserId',
        response: response,
      ),
      createdAt: requiredTimestamp(json, 'createdAt', response: response),
      updatedAt: requiredTimestamp(json, 'updatedAt', response: response),
      display: !attachDisplay || displayJson == null
          ? null
          : MeetingDisplay.fromJson(displayJson, response: response),
    );
  }

  /*
   * The compatibility constructor remains public because older Mobile
   * consumers historically constructed Meeting values directly. All decoded
   * server representations go through _decode and have a valid lifecycle.
   */
  String? get organizerName => display?.organizerName;
  String? get roomName => display?.roomName;
  String? get roomLocation => display?.roomLocation;
  int? get participantCount => display?.participantCount;
}

/// A list row keeps page-scoped display metadata separate from the canonical
/// meeting representation used by detail and versioned mutations.
class MeetingListProjection {
  const MeetingListProjection({required this.meeting, required this.display});

  final Meeting meeting;
  final MeetingDisplay display;

  factory MeetingListProjection.fromJson(
    Map<String, dynamic> json, {
    ApiResult? response,
  }) {
    final displayJson = requiredObject(json, 'display', response: response);
    return MeetingListProjection(
      meeting: Meeting._decode(
        json,
        response: response,
        requireDisplay: true,
        attachDisplay: false,
      ),
      display: MeetingDisplay.fromJson(displayJson, response: response),
    );
  }
}

/// List-only meeting display data is kept separate from the canonical detail
/// projection, where this object is not present.
class MeetingDisplay {
  const MeetingDisplay({
    required this.organizerName,
    required this.roomName,
    required this.roomLocation,
    required this.participantCount,
    required this.participantPreview,
  });

  final String? organizerName;
  final String? roomName;
  final String? roomLocation;
  final int participantCount;
  final List<ParticipantPreview> participantPreview;

  factory MeetingDisplay.fromJson(
    Map<String, dynamic> raw, {
    ApiResult? response,
  }) {
    final preview = requireJsonObjectArray(
      raw['participantPreview'],
      response: response,
    );
    return MeetingDisplay(
      organizerName: optionalString(raw, 'organizerName', response: response),
      roomName: optionalString(raw, 'roomName', response: response),
      roomLocation: optionalString(raw, 'roomLocation', response: response),
      participantCount: requiredInt(
        raw,
        'participantCount',
        response: response,
      ),
      participantPreview: List.unmodifiable(
        preview.map(
          (item) => ParticipantPreview.fromJson(item, response: response),
        ),
      ),
    );
  }
}

class ParticipantPreview {
  const ParticipantPreview({required this.userId, required this.displayName});

  final String userId;
  final String? displayName;

  factory ParticipantPreview.fromJson(
    Map<String, dynamic> raw, {
    ApiResult? response,
  }) => ParticipantPreview(
    userId: requiredIdentifier(raw, 'userId', response: response),
    displayName: optionalString(raw, 'displayName', response: response),
  );
}

Never _invalidMeetingStatus(ApiResult? response) =>
    invalidApiData(response: response);

class ActionItem {
  final String id;
  final String meetingId;
  final String title;
  final String? details;
  final String status;
  final String? assigneeId;
  final String? dueDate;
  final bool overdue;
  final int version;

  const ActionItem({
    required this.id,
    required this.meetingId,
    required this.title,
    required this.details,
    required this.status,
    required this.assigneeId,
    required this.dueDate,
    required this.overdue,
    required this.version,
  });

  factory ActionItem.fromJson(
    Map<String, dynamic> raw, {
    ApiResult? response,
  }) => ActionItem(
    id: requiredIdentifier(raw, 'id', response: response),
    meetingId: requiredIdentifier(raw, 'meetingId', response: response),
    title: requiredString(raw, 'title', response: response, nonEmpty: true),
    details: optionalString(raw, 'details', response: response),
    status: requiredString(raw, 'status', response: response, nonEmpty: true),
    assigneeId: optionalIdentifier(raw, 'assigneeUserId', response: response),
    dueDate: optionalDateOnly(raw, 'dueDate', response: response),
    overdue: requiredBool(raw, 'overdue', response: response),
    version: requiredInt(raw, 'version', response: response),
  );
}

class ProcessingJob {
  final String id;
  final String meetingId;
  final String? sourceMediaId;
  final String jobType;
  final String status;
  final String? requestedByUserId;
  final String? currentStage;
  final String? warningSummary;
  final String? errorSummary;
  final String? errorCode;
  final bool retryable;
  final int retryCount;
  final String? reprocessOfJobId;
  final DateTime queuedAt;
  final DateTime? startedAt;
  final DateTime? completedAt;
  final DateTime createdAt;
  final DateTime updatedAt;
  final List<ProcessingStage> stageRuns;

  const ProcessingJob({
    required this.id,
    required this.meetingId,
    required this.sourceMediaId,
    required this.jobType,
    required this.status,
    required this.requestedByUserId,
    required this.currentStage,
    required this.warningSummary,
    required this.errorSummary,
    required this.errorCode,
    required this.retryable,
    required this.retryCount,
    required this.reprocessOfJobId,
    required this.queuedAt,
    required this.startedAt,
    required this.completedAt,
    required this.createdAt,
    required this.updatedAt,
    required this.stageRuns,
  });

  factory ProcessingJob.fromJson(
    Map<String, dynamic> raw, {
    ApiResult? response,
  }) {
    final queuedAt = requiredTimestamp(raw, 'queuedAt', response: response);
    final startedAt = optionalTimestamp(raw, 'startedAt', response: response);
    final completedAt = optionalTimestamp(
      raw,
      'completedAt',
      response: response,
    );
    final createdAt = requiredTimestamp(raw, 'createdAt', response: response);
    final updatedAt = requiredTimestamp(raw, 'updatedAt', response: response);
    if ((startedAt != null && startedAt.isBefore(queuedAt)) ||
        (completedAt != null &&
            startedAt != null &&
            completedAt.isBefore(startedAt)) ||
        updatedAt.isBefore(createdAt)) {
      invalidApiData(response: response);
    }
    return ProcessingJob(
      id: requiredIdentifier(raw, 'id', response: response),
      meetingId: requiredIdentifier(raw, 'meetingId', response: response),
      sourceMediaId: optionalIdentifier(
        raw,
        'sourceMediaId',
        response: response,
      ),
      jobType: requiredString(
        raw,
        'jobType',
        response: response,
        nonEmpty: true,
      ),
      status: requiredString(raw, 'status', response: response, nonEmpty: true),
      requestedByUserId: optionalIdentifier(
        raw,
        'requestedByUserId',
        response: response,
      ),
      currentStage: optionalString(raw, 'currentStage', response: response),
      warningSummary: optionalString(raw, 'warningSummary', response: response),
      errorSummary: optionalString(raw, 'errorSummary', response: response),
      errorCode: optionalString(raw, 'errorCode', response: response),
      retryable: requiredBool(raw, 'retryable', response: response),
      retryCount: requiredInt(raw, 'retryCount', response: response),
      reprocessOfJobId: optionalIdentifier(
        raw,
        'reprocessOfJobId',
        response: response,
      ),
      queuedAt: queuedAt,
      startedAt: startedAt,
      completedAt: completedAt,
      createdAt: createdAt,
      updatedAt: updatedAt,
      stageRuns: List.unmodifiable(
        requireJsonObjectArray(
          raw['stageRuns'],
          response: response,
        ).map((stage) => ProcessingStage.fromJson(stage, response: response)),
      ),
    );
  }
}

class ProcessingStage {
  const ProcessingStage({
    required this.id,
    required this.stageCode,
    required this.attemptNumber,
    required this.status,
    required this.providerName,
    required this.modelName,
    required this.startedAt,
    required this.completedAt,
    required this.errorCode,
  });

  final String id;
  final String stageCode;
  final int attemptNumber;
  final String status;
  final String? providerName;
  final String? modelName;
  final DateTime? startedAt;
  final DateTime? completedAt;
  final String? errorCode;

  factory ProcessingStage.fromJson(
    Map<String, dynamic> raw, {
    ApiResult? response,
  }) {
    final startedAt = optionalTimestamp(raw, 'startedAt', response: response);
    final completedAt = optionalTimestamp(
      raw,
      'completedAt',
      response: response,
    );
    if (startedAt != null &&
        completedAt != null &&
        completedAt.isBefore(startedAt)) {
      invalidApiData(response: response);
    }
    return ProcessingStage(
      id: requiredIdentifier(raw, 'id', response: response),
      stageCode: requiredString(
        raw,
        'stageCode',
        response: response,
        nonEmpty: true,
      ),
      attemptNumber: requiredInt(
        raw,
        'attemptNumber',
        response: response,
        minimum: 1,
      ),
      status: requiredString(raw, 'status', response: response, nonEmpty: true),
      providerName: optionalString(raw, 'providerName', response: response),
      modelName: optionalString(raw, 'modelName', response: response),
      startedAt: startedAt,
      completedAt: completedAt,
      errorCode: optionalString(raw, 'errorCode', response: response),
    );
  }
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
