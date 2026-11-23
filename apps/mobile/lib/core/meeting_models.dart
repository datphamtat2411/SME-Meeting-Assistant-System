import 'api_client.dart';
import 'models.dart';

class MeetingParticipant {
  const MeetingParticipant({
    required this.userId, required this.displayName,
    required this.email, required this.role,
  });
  final String userId;
  final String displayName;
  final String email;
  final String role;

  factory MeetingParticipant.fromJson(Map<String, dynamic> raw) =>
      MeetingParticipant(
        userId: textValue(raw['userId'], textValue(raw['id'])),
        displayName: textValue(raw['displayName'], 'Thành viên'),
        email: textValue(raw['email']),
        role: textValue(raw['role'], 'PARTICIPANT'),
      );
}

class MeetingRoom {
  const MeetingRoom({
    required this.id, required this.name, required this.status,
    required this.capacity, required this.location, required this.code,
  });
  final String id, name, status, location, code;
  final int? capacity;

  factory MeetingRoom.fromJson(Map<String, dynamic> raw) => MeetingRoom(
    id: textValue(raw['id']), name: textValue(raw['name']),
    status: textValue(raw['status']), code: textValue(raw['code']),
    location: textValue(raw['location']),
    capacity: (raw['capacity'] as num?)?.toInt(),
  );
}

class SpeechSegment {
  const SpeechSegment({
    required this.id, required this.text, required this.startMs,
    required this.endMs, required this.speakerLabel,
    required this.speakerClusterId, required this.quality, required this.version,
  });
  final String id, text, speakerLabel, quality;
  final String? speakerClusterId;
  final int startMs, endMs, version;

  factory SpeechSegment.fromJson(Map<String, dynamic> raw) => SpeechSegment(
    id: textValue(raw['id']), text: textValue(raw['text']),
    startMs: (raw['startMs'] as num?)?.toInt() ?? 0,
    endMs: (raw['endMs'] as num?)?.toInt() ?? 0,
    speakerLabel: textValue(raw['speakerLabel'], 'Chưa xác định'),
    speakerClusterId: raw['speakerClusterId']?.toString(),
    quality: textValue(raw['qualityStatus']),
    version: (raw['version'] as num?)?.toInt() ?? 0,
  );
}

class MeetingDecision {
  const MeetingDecision({
    required this.id, required this.content, required this.status,
    required this.version, required this.stale,
  });
  final String id, content, status;
  final int version;
  final bool stale;

  factory MeetingDecision.fromJson(Map<String, dynamic> raw) => MeetingDecision(
    id: textValue(raw['id']), content: textValue(raw['content']),
    status: textValue(raw['status']),
    version: (raw['version'] as num?)?.toInt() ?? 0,
    stale: raw['isStale'] == true,
  );

  String get etag => '"dec-$id-$version${stale ? '-stale' : ''}"';
}

List<SpeechSegment> speechSegments(ApiResult response) =>
    objectsOf(objectOf(response.data)['segments'])
        .map(SpeechSegment.fromJson).toList(growable: false);
