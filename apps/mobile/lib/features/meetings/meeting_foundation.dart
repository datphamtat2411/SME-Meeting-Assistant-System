import 'package:sme_meeting_assistant/core/api_model_validation.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/models.dart';

final RegExp _meetingUuidPattern = RegExp(
  r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
);

bool isMeetingUuid(String value) => _meetingUuidPattern.hasMatch(value);

void _validateUuid(String? value, String field) {
  if (value != null && !isMeetingUuid(value)) {
    throw ArgumentError.value(value, field, 'Must be a UUID.');
  }
}

enum MeetingRelationship {
  organizer('ORGANIZER'),
  participant('PARTICIPANT');

  const MeetingRelationship(this.wireValue);
  final String wireValue;
}

enum MeetingSortField {
  createdAt('createdAt'),
  scheduledStartAt('scheduledStartAt'),
  title('title'),
  status('status');

  const MeetingSortField(this.wireValue);
  final String wireValue;
}

enum MeetingSortDirection {
  ascending('asc'),
  descending('desc');

  const MeetingSortDirection(this.wireValue);
  final String wireValue;
}

/// Immutable query contract for the caller-authorized Core API meeting list.
///
/// An omitted [relationship] means all meetings the caller is authorized to
/// access, not a system-wide meeting collection.
class MeetingQuery {
  MeetingQuery({
    this.search,
    this.status,
    this.organizerId,
    this.roomId,
    this.relationship,
    this.from,
    this.to,
    this.page = 0,
    this.size = 20,
    this.sort = MeetingSortField.createdAt,
    this.direction = MeetingSortDirection.descending,
  }) {
    if (page < 0)
      throw ArgumentError.value(page, 'page', 'Must be zero-based.');
    if (size < 1 || size > 100) {
      throw ArgumentError.value(size, 'size', 'Must be between 1 and 100.');
    }
    if (search != null && search!.length > 200) {
      throw ArgumentError.value(
        search,
        'search',
        'Must be at most 200 characters.',
      );
    }
    _validateUuid(organizerId, 'organizerId');
    _validateUuid(roomId, 'roomId');
    if (from != null && to != null && !from!.isBefore(to!)) {
      throw ArgumentError('The meeting query start must precede its end.');
    }
  }

  final String? search;
  final MeetingStatus? status;
  final String? organizerId;
  final String? roomId;
  final MeetingRelationship? relationship;
  final DateTime? from;
  final DateTime? to;
  final int page;
  final int size;
  final MeetingSortField sort;
  final MeetingSortDirection direction;

  /// Returns a fixed-order, immutable parameter map.
  Map<String, String> toQueryParameters() =>
      Map<String, String>.unmodifiable(<String, String>{
        if (search != null && search!.isNotEmpty) 'q': search!,
        if (status != null) 'status': status!.wireValue,
        if (organizerId != null) 'organizerId': organizerId!,
        if (roomId != null) 'roomId': roomId!,
        if (relationship != null) 'relationship': relationship!.wireValue,
        if (from != null) 'from': _utcTimestamp(from!),
        if (to != null) 'to': _utcTimestamp(to!),
        'page': '$page',
        'size': '$size',
        'sort': '${sort.wireValue},${direction.wireValue}',
      });
}

/// An immutable absolute-time interval with inclusive start and exclusive end.
class MeetingInterval {
  factory MeetingInterval({required DateTime start, required DateTime end}) {
    if (!start.isBefore(end)) {
      throw ArgumentError('A meeting interval must start before it ends.');
    }
    return MeetingInterval._(start.toUtc(), end.toUtc());
  }

  const MeetingInterval._(this.start, this.end);

  final DateTime start;
  final DateTime end;

  DateTime get startLocal => start.toLocal();
  DateTime get endLocal => end.toLocal();
  String get toApiStart => _utcTimestamp(start);
  String get toApiEnd => _utcTimestamp(end);

  bool overlaps(MeetingInterval other) =>
      start.isBefore(other.end) && other.start.isBefore(end);

  static MeetingInterval? fromNullableEndpoints(
    DateTime? start,
    DateTime? end,
  ) {
    if (start == null && end == null) return null;
    if (start == null || end == null) {
      throw ArgumentError('A meeting interval must contain both endpoints.');
    }
    return MeetingInterval(start: start, end: end);
  }
}

/// A calendar day without a timezone or time-of-day interpretation.
class CalendarDate {
  const CalendarDate._(this.year, this.month, this.day);

  factory CalendarDate({
    required int year,
    required int month,
    required int day,
  }) {
    final value = _formatDate(year, month, day);
    if (!isValidDateOnly(value)) {
      throw ArgumentError.value(
        value,
        'date',
        'Must be a valid calendar date.',
      );
    }
    return CalendarDate._(year, month, day);
  }

  final int year;
  final int month;
  final int day;

  static CalendarDate? parse(String value) {
    if (!isValidDateOnly(value)) return null;
    final parts = value.split('-');
    return CalendarDate._(
      int.parse(parts[0]),
      int.parse(parts[1]),
      int.parse(parts[2]),
    );
  }

  @override
  String toString() => _formatDate(year, month, day);
}

String _formatDate(int year, int month, int day) =>
    '${year.toString().padLeft(4, '0')}-'
    '${month.toString().padLeft(2, '0')}-'
    '${day.toString().padLeft(2, '0')}';

String _utcTimestamp(DateTime value) => value.toUtc().toIso8601String();

/// An immutable canonical meeting version bound to one authenticated session.
class MeetingSnapshot {
  MeetingSnapshot({
    required this.meeting,
    required this.etag,
    required this.sessionScope,
  }) {
    if (!_isUsableEtag(etag)) {
      throw ArgumentError.value(
        etag,
        'etag',
        'A usable server ETag is required.',
      );
    }
  }

  final Meeting meeting;
  final String etag;
  final AuthenticatedSessionScope sessionScope;
}

bool _isUsableEtag(String value) =>
    value.trim().isNotEmpty && !value.contains('\r') && !value.contains('\n');

/// Immutable request to create one independent meeting resource.
class CreateMeetingInput {
  factory CreateMeetingInput({
    required String title,
    String? description,
    MeetingInterval? scheduledInterval,
    String? roomId,
    List<String>? participantUserIds,
  }) {
    if (title.trim().isEmpty || title.length > 255) {
      throw ArgumentError.value(
        title,
        'title',
        'Must contain 1–255 characters.',
      );
    }
    _validateUuid(roomId, 'roomId');
    if (participantUserIds != null) {
      final seen = <String>{};
      for (final userId in participantUserIds) {
        if (!isMeetingUuid(userId) || !seen.add(userId.toLowerCase())) {
          throw ArgumentError.value(
            participantUserIds,
            'participantUserIds',
            'Must contain unique UUIDs.',
          );
        }
      }
    }
    return CreateMeetingInput._(
      title: title,
      description: description,
      scheduledInterval: scheduledInterval,
      roomId: roomId,
      participantUserIds: participantUserIds == null
          ? null
          : List<String>.unmodifiable(participantUserIds),
    );
  }

  const CreateMeetingInput._({
    required this.title,
    required this.description,
    required this.scheduledInterval,
    required this.roomId,
    required this.participantUserIds,
  });

  final String title;
  final String? description;
  final MeetingInterval? scheduledInterval;
  final String? roomId;
  final List<String>? participantUserIds;
}

/// Distinguishes an omitted patch property from an explicit nullable value.
class MeetingFieldUpdate<T> {
  const MeetingFieldUpdate.omitted() : _specified = false, _value = null;
  const MeetingFieldUpdate.set(T value) : _specified = true, _value = value;

  final bool _specified;
  final Object? _value;

  bool get isSpecified => _specified;

  T get value {
    if (!_specified) throw StateError('The meeting field was omitted.');
    return _value as T;
  }
}

/// An immutable and non-empty partial update supported by PATCH /meetings/{id}.
class MeetingUpdateInput {
  factory MeetingUpdateInput({
    MeetingFieldUpdate<String> title =
        const MeetingFieldUpdate<String>.omitted(),
    MeetingFieldUpdate<String?> description =
        const MeetingFieldUpdate<String?>.omitted(),
    MeetingFieldUpdate<DateTime?> scheduledStartAt =
        const MeetingFieldUpdate<DateTime?>.omitted(),
    MeetingFieldUpdate<DateTime?> scheduledEndAt =
        const MeetingFieldUpdate<DateTime?>.omitted(),
    MeetingFieldUpdate<String?> roomId =
        const MeetingFieldUpdate<String?>.omitted(),
  }) {
    if (!title.isSpecified &&
        !description.isSpecified &&
        !scheduledStartAt.isSpecified &&
        !scheduledEndAt.isSpecified &&
        !roomId.isSpecified) {
      throw ArgumentError('A meeting patch must contain at least one field.');
    }
    if (title.isSpecified &&
        (title.value.trim().isEmpty || title.value.length > 255)) {
      throw ArgumentError.value(
        title.value,
        'title',
        'Must contain 1–255 characters.',
      );
    }
    if (roomId.isSpecified) _validateUuid(roomId.value, 'roomId');
    return MeetingUpdateInput._(
      title: title,
      description: description,
      scheduledStartAt: scheduledStartAt,
      scheduledEndAt: scheduledEndAt,
      roomId: roomId,
    );
  }

  const MeetingUpdateInput._({
    required this.title,
    required this.description,
    required this.scheduledStartAt,
    required this.scheduledEndAt,
    required this.roomId,
  });

  final MeetingFieldUpdate<String> title;
  final MeetingFieldUpdate<String?> description;
  final MeetingFieldUpdate<DateTime?> scheduledStartAt;
  final MeetingFieldUpdate<DateTime?> scheduledEndAt;
  final MeetingFieldUpdate<String?> roomId;

  /// Validates the effective interval against the version that owns this edit.
  void validateAgainst(Meeting meeting) {
    final start = scheduledStartAt.isSpecified
        ? scheduledStartAt.value
        : meeting.scheduledStartAt;
    final end = scheduledEndAt.isSpecified
        ? scheduledEndAt.value
        : meeting.scheduledEndAt;
    MeetingInterval.fromNullableEndpoints(start, end);
  }
}

class MeetingScheduleInput {
  const MeetingScheduleInput({this.interval});

  final MeetingInterval? interval;
}

class MeetingCancelInput {
  const MeetingCancelInput({this.reason});

  final String? reason;
}

enum MeetingOperation { edit, schedule, start, end, cancel, manageParticipants }

class MeetingCapabilities {
  MeetingCapabilities._(Set<MeetingOperation> allowed)
    : _allowed = Set<MeetingOperation>.unmodifiable(allowed);

  final Set<MeetingOperation> _allowed;

  bool allows(MeetingOperation operation) => _allowed.contains(operation);

  bool get canEdit => allows(MeetingOperation.edit);
  bool get canSchedule => allows(MeetingOperation.schedule);
  bool get canStart => allows(MeetingOperation.start);
  bool get canEnd => allows(MeetingOperation.end);
  bool get canCancel => allows(MeetingOperation.cancel);
  bool get canManageParticipants => allows(MeetingOperation.manageParticipants);
}

/// Pure client-side lifecycle eligibility. It never considers global roles,
/// operation readiness, room availability, or server authorization.
class MeetingCapabilityPolicy {
  const MeetingCapabilityPolicy._();

  static MeetingCapabilities evaluate({
    required String? callerId,
    required Meeting? meeting,
  }) {
    if (callerId == null ||
        !isMeetingUuid(callerId) ||
        meeting == null ||
        !isMeetingUuid(meeting.organizerId) ||
        callerId.toLowerCase() != meeting.organizerId.toLowerCase()) {
      return MeetingCapabilities._(<MeetingOperation>{});
    }

    final allowed = switch (meeting.lifecycleStatus) {
      MeetingStatus.draft => <MeetingOperation>{
        MeetingOperation.edit,
        MeetingOperation.schedule,
        MeetingOperation.cancel,
        MeetingOperation.manageParticipants,
      },
      MeetingStatus.scheduled => <MeetingOperation>{
        MeetingOperation.edit,
        MeetingOperation.start,
        MeetingOperation.cancel,
        MeetingOperation.manageParticipants,
      },
      MeetingStatus.inProgress => <MeetingOperation>{
        MeetingOperation.end,
        MeetingOperation.manageParticipants,
      },
      MeetingStatus.ended ||
      MeetingStatus.cancelled ||
      null => <MeetingOperation>{},
    };
    return MeetingCapabilities._(allowed);
  }
}
