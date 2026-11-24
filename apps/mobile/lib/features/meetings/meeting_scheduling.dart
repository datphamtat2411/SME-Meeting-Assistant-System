import 'package:flutter/foundation.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/api_model_validation.dart';
import 'package:sme_meeting_assistant/core/meeting_models.dart';
import 'package:sme_meeting_assistant/core/paged_collection.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_foundation.dart';

const int roomPageSize = 20;
const int maxSchedulePreviewParticipants = 100;

class RoomCatalogQuery {
  factory RoomCatalogQuery({
    String? search,
    int page = 0,
    int size = roomPageSize,
  }) {
    _validatePage(page, size, maximumSize: 100);
    _validateSearch(search);
    return RoomCatalogQuery._(
      search: _trimSearch(search),
      page: page,
      size: size,
    );
  }

  const RoomCatalogQuery._({
    required this.search,
    required this.page,
    required this.size,
  });

  final String? search;
  final int page;
  final int size;

  Map<String, String> toQueryParameters() => Map<String, String>.unmodifiable({
    if (search != null) 'q': search!,
    'status': 'ACTIVE',
    'page': '$page',
    'size': '$size',
    'sort': 'code,asc',
  });
}

class RoomAvailabilityQuery {
  factory RoomAvailabilityQuery({
    required MeetingInterval interval,
    String? search,
    int? participantCount,
    int page = 0,
    int size = roomPageSize,
  }) {
    _validatePage(page, size, maximumSize: 100);
    _validateSearch(search);
    if (participantCount != null &&
        (participantCount < 0 || participantCount > 100000)) {
      throw ArgumentError.value(
        participantCount,
        'participantCount',
        'Must be between 0 and 100000.',
      );
    }
    return RoomAvailabilityQuery._(
      interval: interval,
      search: _trimSearch(search),
      participantCount: participantCount,
      page: page,
      size: size,
    );
  }

  const RoomAvailabilityQuery._({
    required this.interval,
    required this.search,
    required this.participantCount,
    required this.page,
    required this.size,
  });

  final MeetingInterval interval;
  final String? search;
  final int? participantCount;
  final int page;
  final int size;

  Map<String, String> toQueryParameters() => Map<String, String>.unmodifiable({
    'start': interval.toApiStart,
    'end': interval.toApiEnd,
    if (search != null) 'q': search!,
    if (participantCount != null) 'participantCount': '$participantCount',
    'page': '$page',
    'size': '$size',
  });
}

/// Immutable scheduling proposal. A null participant set means that existing
/// membership is unchanged; an empty set means an explicitly empty proposal.
class ScheduleIntent {
  factory ScheduleIntent({
    required MeetingInterval interval,
    String? roomId,
    String? meetingId,
    String? organizerId,
    List<String>? participantUserIds,
  }) {
    if (roomId != null && !isMeetingUuid(roomId)) {
      throw ArgumentError.value(roomId, 'roomId', 'Must be a UUID.');
    }
    if (meetingId != null && !isMeetingUuid(meetingId)) {
      throw ArgumentError.value(meetingId, 'meetingId', 'Must be a UUID.');
    }
    if (organizerId != null && !isMeetingUuid(organizerId)) {
      throw ArgumentError.value(organizerId, 'organizerId', 'Must be a UUID.');
    }
    List<String>? validatedParticipants;
    if (participantUserIds != null) {
      final seen = <String>{};
      validatedParticipants = <String>[];
      for (final userId in participantUserIds) {
        if (!isMeetingUuid(userId) || !seen.add(userId.toLowerCase())) {
          throw ArgumentError.value(
            participantUserIds,
            'participantUserIds',
            'Must contain unique UUIDs.',
          );
        }
        if (organizerId == null ||
            userId.toLowerCase() != organizerId.toLowerCase()) {
          validatedParticipants.add(userId);
        }
      }
      if (validatedParticipants.length > maxSchedulePreviewParticipants) {
        throw ArgumentError.value(
          participantUserIds,
          'participantUserIds',
          'Must contain at most $maxSchedulePreviewParticipants participants.',
        );
      }
    }
    return ScheduleIntent._(
      interval: interval,
      roomId: roomId,
      meetingId: meetingId,
      organizerId: organizerId,
      participantUserIds: validatedParticipants == null
          ? null
          : List<String>.unmodifiable(validatedParticipants),
    );
  }

  const ScheduleIntent._({
    required this.interval,
    required this.roomId,
    required this.meetingId,
    required this.organizerId,
    required this.participantUserIds,
  });

  final MeetingInterval interval;
  final String? roomId;
  final String? meetingId;
  final String? organizerId;
  final List<String>? participantUserIds;

  Map<String, dynamic> toRequestBody() => Map<String, dynamic>.unmodifiable({
    if (meetingId != null) 'meetingId': meetingId,
    'roomId': roomId,
    'start': interval.toApiStart,
    'end': interval.toApiEnd,
    if (participantUserIds != null) 'participantUserIds': participantUserIds,
  });

  @override
  bool operator ==(Object other) =>
      other is ScheduleIntent &&
      interval.start == other.interval.start &&
      interval.end == other.interval.end &&
      roomId == other.roomId &&
      meetingId == other.meetingId &&
      organizerId == other.organizerId &&
      listEquals(participantUserIds, other.participantUserIds);

  @override
  int get hashCode => Object.hash(
    interval.start,
    interval.end,
    roomId,
    meetingId,
    organizerId,
    Object.hashAll(participantUserIds ?? const <String>[]),
  );
}

class ScheduleRoomSignal {
  const ScheduleRoomSignal({
    required this.roomId,
    required this.active,
    required this.available,
    required this.capacity,
    required this.participantCount,
    required this.capacityExceeded,
  });

  final String roomId;
  final bool active;
  final bool available;
  final int? capacity;
  final int? participantCount;
  final bool? capacityExceeded;

  factory ScheduleRoomSignal.fromJson(
    Map<String, dynamic> raw, {
    ApiResult? response,
  }) => ScheduleRoomSignal(
    roomId: requiredIdentifier(raw, 'roomId', response: response),
    active: requiredBool(raw, 'active', response: response),
    available: requiredBool(raw, 'available', response: response),
    capacity: optionalInt(raw, 'capacity', response: response, minimum: 1),
    participantCount: optionalInt(
      raw,
      'participantCount',
      response: response,
      minimum: 0,
    ),
    capacityExceeded: _optionalBool(
      raw,
      'capacityExceeded',
      response: response,
    ),
  );
}

class ScheduleWarning {
  const ScheduleWarning({required this.code, required this.userId});

  final String code;
  final String? userId;

  factory ScheduleWarning.fromJson(
    Map<String, dynamic> raw, {
    ApiResult? response,
  }) => ScheduleWarning(
    code: requiredString(raw, 'code', response: response, nonEmpty: true),
    userId: optionalIdentifier(raw, 'userId', response: response),
  );
}

class SchedulePreview {
  const SchedulePreview({
    required this.previewOnly,
    required this.canSchedule,
    required this.roomConflict,
    required this.room,
    required this.warnings,
  });

  final bool previewOnly;
  final bool canSchedule;
  final bool roomConflict;
  final ScheduleRoomSignal? room;
  final List<ScheduleWarning> warnings;

  factory SchedulePreview.fromJson(
    Map<String, dynamic> raw, {
    ApiResult? response,
  }) {
    final roomJson = optionalObject(raw, 'room', response: response);
    return SchedulePreview(
      previewOnly: requiredBool(raw, 'previewOnly', response: response),
      canSchedule: requiredBool(raw, 'canSchedule', response: response),
      roomConflict: requiredBool(raw, 'roomConflict', response: response),
      room: roomJson == null
          ? null
          : ScheduleRoomSignal.fromJson(roomJson, response: response),
      warnings: List<ScheduleWarning>.unmodifiable(
        requireJsonObjectArray(raw['warnings'], response: response).map(
          (warning) => ScheduleWarning.fromJson(warning, response: response),
        ),
      ),
    );
  }
}

class RoomSchedulingRepository {
  RoomSchedulingRepository(this.api);

  final ApiClient api;

  Future<PagedCollection<MeetingRoom>> catalog(
    RoomCatalogQuery query, {
    required AuthenticatedSessionScope sessionScope,
  }) async {
    api.requireCurrentAuthenticatedSession(sessionScope);
    final response = await api.get('/rooms', query: query.toQueryParameters());
    api.requireCurrentAuthenticatedSession(sessionScope);
    return PagedCollection<MeetingRoom>.fromResult(
      response,
      (raw) => MeetingRoom.fromJson(raw, response: response),
      requestedPage: query.page,
      requestedSize: query.size,
    );
  }

  Future<MeetingRoom> roomById(
    String roomId, {
    required AuthenticatedSessionScope sessionScope,
  }) async {
    if (!isMeetingUuid(roomId)) {
      throw ArgumentError.value(roomId, 'roomId', 'Must be a UUID.');
    }
    api.requireCurrentAuthenticatedSession(sessionScope);
    final response = await api.get('/rooms/${Uri.encodeComponent(roomId)}');
    api.requireCurrentAuthenticatedSession(sessionScope);
    final room = MeetingRoom.fromJson(
      response.objectData(),
      response: response,
    );
    if (room.id.toLowerCase() != roomId.toLowerCase()) {
      throw response.invalidDataFailure();
    }
    return room;
  }

  Future<PagedCollection<AvailableRoom>> availability(
    RoomAvailabilityQuery query, {
    required AuthenticatedSessionScope sessionScope,
  }) async {
    api.requireCurrentAuthenticatedSession(sessionScope);
    final response = await api.get(
      '/rooms/availability',
      query: query.toQueryParameters(),
    );
    api.requireCurrentAuthenticatedSession(sessionScope);
    return PagedCollection<AvailableRoom>.fromResult(
      response,
      (raw) => AvailableRoom.fromJson(raw, response: response),
      requestedPage: query.page,
      requestedSize: query.size,
    );
  }

  Future<SchedulePreview> preview(
    ScheduleIntent intent, {
    required AuthenticatedSessionScope sessionScope,
  }) async {
    api.requireCurrentAuthenticatedSession(sessionScope);
    final response = await api.post(
      '/meeting-schedule-checks',
      intent.toRequestBody(),
    );
    api.requireCurrentAuthenticatedSession(sessionScope);
    return SchedulePreview.fromJson(response.objectData(), response: response);
  }
}

enum SchedulePreviewPhase { notPerformed, loading, current, outdated, failed }

class SchedulePreviewState {
  const SchedulePreviewState({
    required this.phase,
    required this.intent,
    required this.preview,
    required this.failure,
  });

  final SchedulePreviewPhase phase;
  final ScheduleIntent? intent;
  final SchedulePreview? preview;
  final Object? failure;
}

class SchedulePreviewController extends ChangeNotifier {
  SchedulePreviewController({
    required this.repository,
    required this.sessionScope,
  }) : _state = const SchedulePreviewState(
         phase: SchedulePreviewPhase.notPerformed,
         intent: null,
         preview: null,
         failure: null,
       ) {
    repository.api.sessionCoordinator.addListener(_sessionChanged);
  }

  final RoomSchedulingRepository repository;
  final AuthenticatedSessionScope sessionScope;
  SchedulePreviewState _state;
  int _generation = 0;
  Future<void>? _operation;
  bool _disposed = false;

  SchedulePreviewState get state => _state;

  void setIntent(ScheduleIntent? intent) {
    if (_state.intent == intent) return;
    _generation++;
    _state = SchedulePreviewState(
      phase: _state.preview == null
          ? SchedulePreviewPhase.notPerformed
          : SchedulePreviewPhase.outdated,
      intent: intent,
      preview: _state.preview,
      failure: null,
    );
    notifyListeners();
  }

  Future<void> check() {
    final intent = _state.intent;
    if (intent == null) return Future<void>.value();
    if (_state.phase == SchedulePreviewPhase.loading && _operation != null) {
      return _operation!;
    }
    final generation = ++_generation;
    _state = SchedulePreviewState(
      phase: SchedulePreviewPhase.loading,
      intent: intent,
      preview: _state.preview,
      failure: null,
    );
    notifyListeners();
    final operation = _check(intent, generation);
    _operation = operation;
    return operation;
  }

  Future<void> _check(ScheduleIntent intent, int generation) async {
    try {
      final preview = await repository.preview(
        intent,
        sessionScope: sessionScope,
      );
      if (!_isCurrent(generation, intent)) return;
      _state = SchedulePreviewState(
        phase: SchedulePreviewPhase.current,
        intent: intent,
        preview: preview,
        failure: null,
      );
    } catch (error) {
      if (!_isCurrent(generation, intent)) return;
      _state = SchedulePreviewState(
        phase: SchedulePreviewPhase.failed,
        intent: intent,
        preview: null,
        failure: error,
      );
    } finally {
      if (_isCurrent(generation, intent)) {
        _operation = null;
        notifyListeners();
      }
    }
  }

  bool _isCurrent(int generation, ScheduleIntent intent) =>
      !_disposed &&
      generation == _generation &&
      _state.intent == intent &&
      repository.api.isCurrentAuthenticatedSession(sessionScope);

  void _sessionChanged() {
    if (_disposed ||
        repository.api.isCurrentAuthenticatedSession(sessionScope)) {
      return;
    }
    _generation++;
    _operation = null;
    _state = const SchedulePreviewState(
      phase: SchedulePreviewPhase.notPerformed,
      intent: null,
      preview: null,
      failure: null,
    );
    notifyListeners();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    repository.api.sessionCoordinator.removeListener(_sessionChanged);
    _generation++;
    super.dispose();
  }
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

void _validatePage(int page, int size, {required int maximumSize}) {
  if (page < 0 || size < 1 || size > maximumSize) {
    throw ArgumentError('Invalid zero-based page or page size.');
  }
}

void _validateSearch(String? search) {
  if (search != null && search.length > 200) {
    throw ArgumentError.value(
      search,
      'search',
      'Must be at most 200 characters.',
    );
  }
}

String? _trimSearch(String? search) {
  final value = search?.trim();
  return value == null || value.isEmpty ? null : value;
}
