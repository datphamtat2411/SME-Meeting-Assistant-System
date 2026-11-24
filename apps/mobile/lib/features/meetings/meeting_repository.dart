import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/models.dart';
import 'package:sme_meeting_assistant/core/paged_collection.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_foundation.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_invalidation.dart';

enum MeetingFailureCategory {
  authentication,
  authorization,
  resourceUnavailable,
  businessConflict,
  versionConflict,
  missingPrecondition,
  validation,
  rateLimited,
  timeout,
  server,
  transport,
  invalidResponse,
  rejectedRequest,
  unknown,
}

enum MeetingMutationOutcome {
  /// The local operation was rejected before it could be dispatched.
  notDispatched,

  /// Core API returned a definitive rejection (for example 4xx).
  rejected,

  /// The operation may have committed, but no reliable response was obtained.
  unknown,
}

/// A meeting-specific classification that retains the complete Core API
/// diagnostic contract through its ApiFailure superclass.
class MeetingFailure extends ApiFailure {
  MeetingFailure._(
    ApiFailure source, {
    required this.category,
    required this.mutationOutcome,
    this.cause,
  }) : super(
         source.status,
         source.code,
         source.message,
         requestId: source.requestId,
         responseRequestId: source.responseRequestId,
         timestamp: source.timestamp,
         errors: source.errors,
         retryAfter: source.retryAfter,
         headers: source.headers,
         isTransportFailure: source.isTransportFailure,
       );

  final MeetingFailureCategory category;
  final MeetingMutationOutcome mutationOutcome;
  final Object? cause;
}

/// Concrete typed boundary for the existing authenticated Core API.
///
/// Every read and mutation is fenced by the authenticated session that began
/// it. Mutations consume the caller's original snapshot and never refresh its
/// ETag or replay after a conflict.
class MeetingRepository {
  MeetingRepository({required this.api, required this.invalidation});

  final ApiClient api;
  final MeetingInvalidationSignal invalidation;

  Future<PagedCollection<MeetingListProjection>> list({
    MeetingQuery? query,
  }) async {
    final activeQuery = query ?? MeetingQuery();
    final scope = _captureSession();
    final response = await _readRequest(
      scope,
      () => api.get('/meetings', query: activeQuery.toQueryParameters()),
    );
    final PagedCollection<MeetingListProjection> page;
    try {
      page = PagedCollection<MeetingListProjection>.fromResult(
        response,
        (raw) => MeetingListProjection.fromJson(raw, response: response),
        requestedPage: activeQuery.page,
        requestedSize: activeQuery.size,
      );
    } on MeetingFailure {
      rethrow;
    } on ApiFailure catch (failure) {
      throw _classifyFailure(
        failure,
        mutationOutcome: MeetingMutationOutcome.notDispatched,
        cause: failure,
      );
    }
    _requireCurrentSession(scope);
    return page;
  }

  Future<MeetingSnapshot> detail(String meetingId) async {
    _validateMeetingId(meetingId);
    final scope = _captureSession();
    final response = await _readRequest(
      scope,
      () => api.get('/meetings/${Uri.encodeComponent(meetingId)}'),
    );
    final MeetingSnapshot snapshot;
    try {
      snapshot = _decodeSnapshot(response, scope, expectedMeetingId: meetingId);
    } on MeetingFailure {
      rethrow;
    } on ApiFailure catch (failure) {
      throw _classifyFailure(
        failure,
        mutationOutcome: MeetingMutationOutcome.notDispatched,
        cause: failure,
      );
    }
    _requireCurrentSession(scope);
    return snapshot;
  }

  Future<MeetingSnapshot> create(
    CreateMeetingInput input, {
    required String idempotencyKey,
  }) async {
    if (!_validIdempotencyKey(idempotencyKey)) {
      throw ArgumentError.value(
        idempotencyKey,
        'idempotencyKey',
        'Must match the Core API Idempotency-Key contract.',
      );
    }
    final scope = _captureSession();
    return _mutate(
      sessionScope: scope,
      send: () => api.post(
        '/meetings',
        _createBody(input),
        headers: <String, String>{'Idempotency-Key': idempotencyKey},
      ),
    );
  }

  Future<MeetingSnapshot> update(
    MeetingSnapshot original,
    MeetingUpdateInput input,
  ) async {
    input.validateAgainst(original.meeting);
    _validateSnapshot(original);
    return _mutate(
      sessionScope: original.sessionScope,
      meetingId: original.meeting.id,
      send: () => api.patch(
        _meetingPath(original.meeting.id),
        _updateBody(input),
        headers: _ifMatch(original.etag),
      ),
    );
  }

  Future<MeetingSnapshot> schedule(
    MeetingSnapshot original,
    MeetingScheduleInput input,
  ) async {
    _validateSnapshot(original);
    final effective =
        input.interval ??
        MeetingInterval.fromNullableEndpoints(
          original.meeting.scheduledStartAt,
          original.meeting.scheduledEndAt,
        );
    if (effective == null) {
      throw ArgumentError(
        'Scheduling requires an effective start and end timestamp.',
      );
    }
    return _mutate(
      sessionScope: original.sessionScope,
      meetingId: original.meeting.id,
      send: () => api.post(
        '${_meetingPath(original.meeting.id)}/schedule',
        _scheduleBody(input),
        headers: _ifMatch(original.etag),
      ),
    );
  }

  Future<MeetingSnapshot> start(MeetingSnapshot original) async {
    _validateSnapshot(original);
    return _mutate(
      sessionScope: original.sessionScope,
      meetingId: original.meeting.id,
      send: () => api.post(
        '${_meetingPath(original.meeting.id)}/start',
        const <String, dynamic>{},
        headers: _ifMatch(original.etag),
      ),
    );
  }

  Future<MeetingSnapshot> end(MeetingSnapshot original) async {
    _validateSnapshot(original);
    return _mutate(
      sessionScope: original.sessionScope,
      meetingId: original.meeting.id,
      send: () => api.post(
        '${_meetingPath(original.meeting.id)}/end',
        const <String, dynamic>{},
        headers: _ifMatch(original.etag),
      ),
    );
  }

  Future<MeetingSnapshot> cancel(
    MeetingSnapshot original, [
    MeetingCancelInput input = const MeetingCancelInput(),
  ]) async {
    _validateSnapshot(original);
    return _mutate(
      sessionScope: original.sessionScope,
      meetingId: original.meeting.id,
      send: () => api.post(
        '${_meetingPath(original.meeting.id)}/cancel',
        _cancelBody(input),
        headers: _ifMatch(original.etag),
      ),
    );
  }

  Future<ApiResult> _readRequest(
    AuthenticatedSessionScope scope,
    Future<ApiResult> Function() send,
  ) async {
    _requireCurrentSession(scope);
    try {
      final response = await send();
      _requireCurrentSession(scope);
      return response;
    } catch (error) {
      if (!api.isCurrentAuthenticatedSession(scope)) {
        throw _sessionFailure(
          MeetingMutationOutcome.notDispatched,
          cause: error,
        );
      }
      if (error is MeetingFailure) rethrow;
      throw _classifyFailure(
        _asApiFailure(error),
        mutationOutcome: MeetingMutationOutcome.notDispatched,
        cause: error,
      );
    }
  }

  Future<MeetingSnapshot> _mutate({
    required AuthenticatedSessionScope sessionScope,
    String? meetingId,
    required Future<ApiResult> Function() send,
  }) async {
    _requireCurrentSession(sessionScope);
    var dispatched = false;
    try {
      dispatched = true;
      final response = await send();
      _requireCurrentSession(
        sessionScope,
        mutationOutcome: MeetingMutationOutcome.unknown,
      );
      final snapshot = _decodeSnapshot(
        response,
        sessionScope,
        expectedMeetingId: meetingId,
      );
      _requireCurrentSession(
        sessionScope,
        mutationOutcome: MeetingMutationOutcome.unknown,
      );
      final affectedMeetingId = meetingId ?? snapshot.meeting.id;
      if (!invalidation.invalidate(
        sessionScope: sessionScope,
        meetingId: affectedMeetingId,
      )) {
        throw _sessionFailure(
          MeetingMutationOutcome.unknown,
          cause: StateError('Meeting invalidation scope is no longer current.'),
        );
      }
      return snapshot;
    } catch (error) {
      if (!dispatched) rethrow;
      final MeetingFailure failure;
      if (error is MeetingFailure) {
        failure = error.mutationOutcome == MeetingMutationOutcome.unknown
            ? error
            : _copyWithOutcome(error, MeetingMutationOutcome.unknown);
      } else {
        final apiFailure = _asApiFailure(error);
        failure = _classifyFailure(
          apiFailure,
          mutationOutcome: error is AuthSessionException
              ? MeetingMutationOutcome.unknown
              : _mutationOutcome(apiFailure),
          cause: error,
        );
      }

      if (failure.mutationOutcome == MeetingMutationOutcome.unknown &&
          api.isCurrentAuthenticatedSession(sessionScope)) {
        invalidation.invalidate(
          sessionScope: sessionScope,
          meetingId: meetingId,
        );
      }
      throw failure;
    }
  }

  MeetingSnapshot _decodeSnapshot(
    ApiResult response,
    AuthenticatedSessionScope scope, {
    String? expectedMeetingId,
  }) {
    final meeting = Meeting.fromCanonicalJson(
      response.objectData(),
      response: response,
    );
    if (expectedMeetingId != null &&
        meeting.id.toLowerCase() != expectedMeetingId.toLowerCase()) {
      throw response.invalidDataFailure();
    }
    final etag = response.etag;
    if (etag == null || !_isUsableEtag(etag)) {
      throw MeetingFailure._(
        ApiFailure(
          response.statusCode,
          'MEETING_ETAG_MISSING',
          'Core API did not provide a usable meeting version.',
          requestId: response.requestId,
          responseRequestId: response.responseRequestId,
          timestamp: response.timestamp,
          headers: response.headers,
        ),
        category: MeetingFailureCategory.missingPrecondition,
        mutationOutcome: MeetingMutationOutcome.notDispatched,
      );
    }
    return MeetingSnapshot(meeting: meeting, etag: etag, sessionScope: scope);
  }

  AuthenticatedSessionScope _captureSession() {
    final scope = api.authenticatedSessionScope;
    if (scope == null || !api.isCurrentAuthenticatedSession(scope)) {
      throw _sessionFailure(MeetingMutationOutcome.notDispatched);
    }
    return scope;
  }

  void _requireCurrentSession(
    AuthenticatedSessionScope scope, {
    MeetingMutationOutcome mutationOutcome =
        MeetingMutationOutcome.notDispatched,
  }) {
    if (!api.isCurrentAuthenticatedSession(scope)) {
      throw _sessionFailure(mutationOutcome);
    }
  }

  void _validateSnapshot(MeetingSnapshot snapshot) {
    _validateMeetingId(snapshot.meeting.id);
    if (!_isUsableEtag(snapshot.etag)) {
      throw MeetingFailure._(
        const ApiFailure(
          428,
          'MEETING_VERSION_REQUIRED',
          'A server-issued meeting version is required.',
        ),
        category: MeetingFailureCategory.missingPrecondition,
        mutationOutcome: MeetingMutationOutcome.notDispatched,
      );
    }
    _requireCurrentSession(snapshot.sessionScope);
  }

  MeetingFailure _sessionFailure(
    MeetingMutationOutcome outcome, {
    Object? cause,
  }) => MeetingFailure._(
    ApiFailure(
      401,
      'AUTH_SESSION_CHANGED',
      'The authenticated session changed while the Meeting operation was active.',
    ),
    category: MeetingFailureCategory.authentication,
    mutationOutcome: outcome,
    cause: cause,
  );

  MeetingFailure _copyWithOutcome(
    MeetingFailure failure,
    MeetingMutationOutcome outcome,
  ) => MeetingFailure._(
    failure,
    category: failure.category,
    mutationOutcome: outcome,
    cause: failure.cause,
  );

  MeetingFailure _classifyFailure(
    ApiFailure failure, {
    required MeetingMutationOutcome mutationOutcome,
    Object? cause,
  }) => MeetingFailure._(
    failure,
    category: _categoryFor(failure),
    mutationOutcome: mutationOutcome,
    cause: cause,
  );

  MeetingFailureCategory _categoryFor(ApiFailure failure) {
    if (failure.status == 401) return MeetingFailureCategory.authentication;
    if (failure.status == 403) return MeetingFailureCategory.authorization;
    if (failure.status == 404) {
      return MeetingFailureCategory.resourceUnavailable;
    }
    if (failure.status == 412) return MeetingFailureCategory.versionConflict;
    if (failure.status == 428 ||
        failure.code == 'MEETING_ETAG_MISSING' ||
        failure.code == 'MEETING_VERSION_REQUIRED') {
      return MeetingFailureCategory.missingPrecondition;
    }
    if (failure.status == 409) return MeetingFailureCategory.businessConflict;
    if (failure.status == 429) return MeetingFailureCategory.rateLimited;
    if (failure.transportFailure) return MeetingFailureCategory.transport;
    if (failure.invalidResponse) {
      return MeetingFailureCategory.invalidResponse;
    }
    if (failure.status == 408 || failure.status == 425) {
      return MeetingFailureCategory.timeout;
    }
    if (failure.status >= 500 && failure.status <= 599) {
      return MeetingFailureCategory.server;
    }
    if (failure.status == 400 ||
        failure.status == 422 ||
        failure.code == 'VALIDATION_FAILED') {
      return MeetingFailureCategory.validation;
    }
    if (failure.status >= 400 && failure.status <= 499) {
      return MeetingFailureCategory.rejectedRequest;
    }
    return MeetingFailureCategory.unknown;
  }

  MeetingMutationOutcome _mutationOutcome(ApiFailure failure) {
    if (!failure.transportFailure &&
        failure.status >= 400 &&
        failure.status <= 499 &&
        failure.status != 408 &&
        failure.status != 425) {
      return MeetingMutationOutcome.rejected;
    }
    return MeetingMutationOutcome.unknown;
  }

  ApiFailure _asApiFailure(Object error) {
    if (error is ApiFailure) return error;
    if (error is AuthSessionException) {
      final apiFailure = error.failure.apiFailure;
      if (apiFailure != null) return apiFailure;
      return ApiFailure(
        error.failure.status ?? 401,
        error.failure.machineCode ?? 'AUTH_SESSION_CHANGED',
        error.failure.message,
        requestId: error.failure.requestId,
        responseRequestId: error.failure.responseRequestId,
        retryAfter: error.failure.retryAfter,
      );
    }
    return ApiFailure(
      0,
      'MEETING_REPOSITORY_FAILURE',
      'The Meeting operation could not be completed.',
      isTransportFailure: true,
    );
  }

  Map<String, String> _ifMatch(String etag) {
    if (!_isUsableEtag(etag)) {
      throw MeetingFailure._(
        const ApiFailure(
          428,
          'MEETING_VERSION_REQUIRED',
          'A server-issued meeting version is required.',
        ),
        category: MeetingFailureCategory.missingPrecondition,
        mutationOutcome: MeetingMutationOutcome.notDispatched,
      );
    }
    return <String, String>{'If-Match': etag};
  }
}

bool _validIdempotencyKey(String key) =>
    RegExp(r'^[A-Za-z0-9][A-Za-z0-9._~:-]{0,127}$').hasMatch(key);

bool _isUsableEtag(String value) =>
    value.trim().isNotEmpty && !value.contains('\r') && !value.contains('\n');

void _validateMeetingId(String meetingId) {
  if (!isMeetingUuid(meetingId)) {
    throw ArgumentError.value(meetingId, 'meetingId', 'Must be a UUID.');
  }
}

String _meetingPath(String meetingId) =>
    '/meetings/${Uri.encodeComponent(meetingId)}';

Map<String, dynamic> _createBody(CreateMeetingInput input) => <String, dynamic>{
  'title': input.title,
  'description': input.description,
  'scheduledStartAt': input.scheduledInterval?.toApiStart,
  'scheduledEndAt': input.scheduledInterval?.toApiEnd,
  'roomId': input.roomId,
  if (input.participantUserIds != null)
    'participantUserIds': input.participantUserIds,
};

Map<String, dynamic> _updateBody(MeetingUpdateInput input) => <String, dynamic>{
  if (input.title.isSpecified) 'title': input.title.value,
  if (input.description.isSpecified) 'description': input.description.value,
  if (input.scheduledStartAt.isSpecified)
    'scheduledStartAt': _optionalTimestamp(input.scheduledStartAt.value),
  if (input.scheduledEndAt.isSpecified)
    'scheduledEndAt': _optionalTimestamp(input.scheduledEndAt.value),
  if (input.roomId.isSpecified) 'roomId': input.roomId.value,
};

Map<String, dynamic> _scheduleBody(MeetingScheduleInput input) =>
    input.interval == null
    ? <String, dynamic>{}
    : <String, dynamic>{
        'scheduledStartAt': input.interval!.toApiStart,
        'scheduledEndAt': input.interval!.toApiEnd,
      };

Map<String, dynamic> _cancelBody(MeetingCancelInput input) =>
    input.reason == null
    ? <String, dynamic>{}
    : <String, dynamic>{'reason': input.reason};

String? _optionalTimestamp(DateTime? value) => value?.toUtc().toIso8601String();
