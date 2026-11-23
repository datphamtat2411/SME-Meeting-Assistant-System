import 'api_client.dart';
import 'api_model_validation.dart';

class MeetingParticipant {
  const MeetingParticipant({
    required this.id,
    required this.meetingId,
    required this.userId,
    required this.addedByUserId,
    required this.addedAt,
    required this.removedAt,
    required this.removedByUserId,
    required this.displayName,
  });

  final String id;
  final String meetingId;
  final String userId;
  final String? addedByUserId;
  final DateTime addedAt;
  final DateTime? removedAt;
  final String? removedByUserId;
  final String? displayName;

  factory MeetingParticipant.fromJson(
    Map<String, dynamic> raw, {
    ApiResult? response,
  }) => MeetingParticipant(
    id: requiredIdentifier(raw, 'id', response: response),
    meetingId: requiredIdentifier(raw, 'meetingId', response: response),
    userId: requiredIdentifier(raw, 'userId', response: response),
    addedByUserId: optionalIdentifier(raw, 'addedByUserId', response: response),
    addedAt: requiredTimestamp(raw, 'addedAt', response: response),
    removedAt: optionalTimestamp(raw, 'removedAt', response: response),
    removedByUserId: optionalIdentifier(
      raw,
      'removedByUserId',
      response: response,
    ),
    displayName: optionalString(raw, 'displayName', response: response),
  );
}

/// Canonical room catalog projection.
class MeetingRoom {
  const MeetingRoom({
    required this.id,
    required this.code,
    required this.name,
    required this.location,
    required this.capacity,
    required this.status,
    required this.notes,
    required this.createdAt,
    required this.updatedAt,
  });

  final String id;
  final String code;
  final String name;
  final String? location;
  final int? capacity;
  final String status;
  final String? notes;
  final DateTime createdAt;
  final DateTime updatedAt;

  factory MeetingRoom.fromJson(
    Map<String, dynamic> raw, {
    ApiResult? response,
  }) => MeetingRoom(
    id: requiredIdentifier(raw, 'id', response: response),
    code: requiredString(raw, 'code', response: response, nonEmpty: true),
    name: requiredString(raw, 'name', response: response, nonEmpty: true),
    location: optionalString(raw, 'location', response: response),
    capacity: optionalInt(raw, 'capacity', response: response, minimum: 1),
    status: requiredString(raw, 'status', response: response, nonEmpty: true),
    notes: optionalString(raw, 'notes', response: response),
    createdAt: requiredTimestamp(raw, 'createdAt', response: response),
    updatedAt: requiredTimestamp(raw, 'updatedAt', response: response),
  );
}

/// Room availability is a separate projection and does not include catalog
/// status or timestamps.
class AvailableRoom {
  const AvailableRoom({
    required this.id,
    required this.code,
    required this.name,
    required this.location,
    required this.capacity,
    required this.available,
    required this.participantCount,
    required this.capacityExceeded,
  });

  final String id;
  final String code;
  final String name;
  final String? location;
  final int? capacity;
  final bool available;
  final int? participantCount;
  final bool? capacityExceeded;

  factory AvailableRoom.fromJson(
    Map<String, dynamic> raw, {
    ApiResult? response,
  }) => AvailableRoom(
    id: requiredIdentifier(raw, 'id', response: response),
    code: requiredString(raw, 'code', response: response, nonEmpty: true),
    name: requiredString(raw, 'name', response: response, nonEmpty: true),
    location: optionalString(raw, 'location', response: response),
    capacity: optionalInt(raw, 'capacity', response: response, minimum: 1),
    available: requiredBool(raw, 'available', response: response),
    participantCount: optionalInt(raw, 'participantCount', response: response),
    capacityExceeded: _optionalBool(
      raw,
      'capacityExceeded',
      response: response,
    ),
  );
}

bool? _optionalBool(
  Map<String, dynamic> raw,
  String field, {
  ApiResult? response,
}) {
  if (!raw.containsKey(field) || raw[field] == null) return null;
  final value = raw[field];
  if (value is! bool) invalidApiData(response: response);
  return value;
}

class SpeechSegment {
  const SpeechSegment({
    required this.id,
    required this.ordinal,
    required this.text,
    required this.startMs,
    required this.endMs,
    required this.speakerLabel,
    required this.speakerClusterId,
    required this.quality,
    required this.version,
  });

  final String id;
  final int ordinal;
  final String text;
  final int startMs;
  final int endMs;
  final String? speakerLabel;
  final String? speakerClusterId;
  final String quality;
  final int version;

  factory SpeechSegment.fromJson(
    Map<String, dynamic> raw, {
    ApiResult? response,
  }) {
    final startMs = requiredInt(raw, 'startMs', response: response);
    final endMs = requiredInt(raw, 'endMs', response: response);
    if (endMs < startMs) invalidApiData(response: response);
    return SpeechSegment(
      id: requiredIdentifier(raw, 'id', response: response),
      ordinal: requiredInt(raw, 'ordinal', response: response),
      text: requiredString(raw, 'text', response: response, nonEmpty: true),
      startMs: startMs,
      endMs: endMs,
      speakerLabel: optionalString(raw, 'speakerLabel', response: response),
      speakerClusterId: optionalIdentifier(
        raw,
        'speakerClusterId',
        response: response,
      ),
      quality: requiredString(
        raw,
        'qualityStatus',
        response: response,
        nonEmpty: true,
      ),
      version: requiredInt(raw, 'version', response: response),
    );
  }
}

class Transcript {
  const Transcript({
    required this.id,
    required this.meetingId,
    required this.sourceMediaId,
    required this.processingJobId,
    required this.versionNumber,
    required this.languageCode,
    required this.status,
    required this.durationMs,
    required this.finalizedAt,
    required this.contentRevision,
    required this.segments,
    required this.etag,
  });

  final String id;
  final String meetingId;
  final String? sourceMediaId;
  final String? processingJobId;
  final int versionNumber;
  final String languageCode;
  final String status;
  final int? durationMs;
  final DateTime? finalizedAt;
  final int contentRevision;
  final List<SpeechSegment> segments;

  /// The opaque HTTP tag for the transcript resource, not a segment tag.
  final String? etag;

  factory Transcript.fromResult(ApiResult response) {
    final raw = response.objectData();
    final rawSegments = requireJsonObjectArray(
      raw['segments'],
      response: response,
    );
    return Transcript(
      id: requiredIdentifier(raw, 'id', response: response),
      meetingId: requiredIdentifier(raw, 'meetingId', response: response),
      sourceMediaId: optionalIdentifier(
        raw,
        'sourceMediaId',
        response: response,
      ),
      processingJobId: optionalIdentifier(
        raw,
        'processingJobId',
        response: response,
      ),
      versionNumber: requiredInt(
        raw,
        'versionNumber',
        response: response,
        minimum: 1,
      ),
      languageCode: requiredString(
        raw,
        'languageCode',
        response: response,
        nonEmpty: true,
      ),
      status: requiredString(raw, 'status', response: response, nonEmpty: true),
      durationMs: optionalInt(raw, 'durationMs', response: response),
      finalizedAt: optionalTimestamp(raw, 'finalizedAt', response: response),
      contentRevision: requiredInt(raw, 'contentRevision', response: response),
      segments: List.unmodifiable(
        rawSegments.map(
          (segment) => SpeechSegment.fromJson(segment, response: response),
        ),
      ),
      etag: response.etag,
    );
  }
}

class MeetingDecision {
  const MeetingDecision({
    required this.id,
    required this.meetingId,
    required this.content,
    required this.status,
    required this.version,
    required this.stale,
    required this.createdAt,
    required this.confirmedAt,
    required this.rejectedAt,
  });

  final String id;
  final String meetingId;
  final String content;
  final String status;
  final int version;
  final bool stale;
  final DateTime createdAt;
  final DateTime? confirmedAt;
  final DateTime? rejectedAt;

  factory MeetingDecision.fromJson(
    Map<String, dynamic> raw, {
    ApiResult? response,
  }) => MeetingDecision(
    id: requiredIdentifier(raw, 'id', response: response),
    meetingId: requiredIdentifier(raw, 'meetingId', response: response),
    content: requiredString(raw, 'content', response: response, nonEmpty: true),
    status: requiredString(raw, 'status', response: response, nonEmpty: true),
    version: requiredInt(raw, 'version', response: response),
    stale: requiredBool(raw, 'isStale', response: response),
    createdAt: requiredTimestamp(raw, 'createdAt', response: response),
    confirmedAt: optionalTimestamp(raw, 'confirmedAt', response: response),
    rejectedAt: optionalTimestamp(raw, 'rejectedAt', response: response),
  );
}

List<SpeechSegment> speechSegments(ApiResult response) =>
    Transcript.fromResult(response).segments;
