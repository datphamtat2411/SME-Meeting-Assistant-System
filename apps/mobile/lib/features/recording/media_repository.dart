import 'package:sme_meeting_assistant/core/api_client.dart';

import 'media_contracts.dart';

enum MediaFailureCategory {
  authentication,
  authorization,
  resourceUnavailable,
  businessConflict,
  validation,
  rateLimited,
  timeout,
  server,
  transport,
  invalidResponse,
  rejectedRequest,
  unknown,
}

enum MediaMutationOutcome { notDispatched, rejected, unknown }

/// A media-specific error that keeps the Core API diagnostic context while
/// making mutation uncertainty explicit to a later coordinator.
class MediaRepositoryFailure extends ApiFailure {
  MediaRepositoryFailure(
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
         remoteOutcomeAmbiguous: source.remoteOutcomeAmbiguous,
       );

  final MediaFailureCategory category;
  final MediaMutationOutcome mutationOutcome;
  final Object? cause;
}

class MediaRepository {
  MediaRepository({required this.api});

  final ApiClient api;

  Future<MediaUploadIntent> createUploadIntent(
    String meetingId,
    MediaUploadRequest request, {
    required String idempotencyKey,
    AuthenticatedSessionScope? sessionScope,
  }) async {
    _validateMeetingId(meetingId);
    _validateIdempotencyKey(idempotencyKey);
    final scope = _captureSession(sessionScope);
    final response = await _mutateRequest(
      scope,
      () => api.post(
        '${_meetingPath(meetingId)}/media/uploads',
        request.toJson(),
        headers: <String, String>{'Idempotency-Key': idempotencyKey},
        sessionScope: scope,
      ),
    );
    try {
      final intent = MediaUploadIntent.fromJson(
        response.objectData(),
        response: response,
      );
      _requireMeetingSession(scope);
      return intent;
    } on MediaRepositoryFailure {
      rethrow;
    } on ApiFailure catch (failure) {
      throw _classify(
        failure,
        outcome: MediaMutationOutcome.unknown,
        cause: failure,
      );
    }
  }

  /// Finalization intentionally returns a typed media record for every valid
  /// Core response. A 2xx response with `REJECTED` or `FAILED` is not success,
  /// but it is also not a malformed transport response.
  Future<MediaRecord> finalizeUpload(
    String meetingId,
    String mediaId, {
    AuthenticatedSessionScope? sessionScope,
  }) async {
    _validateMeetingId(meetingId);
    _validateIdentifier(mediaId, 'mediaId');
    final scope = _captureSession(sessionScope);
    final response = await _mutateRequest(
      scope,
      () => api.post(
        '${_meetingPath(meetingId)}/media/${Uri.encodeComponent(mediaId)}/finalize',
        const <String, dynamic>{},
        timeoutPolicy: CoreApiTimeoutPolicy.mediaFinalization,
        sessionScope: scope,
      ),
    );
    try {
      final media = MediaRecord.fromJson(
        response.objectData(),
        response: response,
      );
      if (media.meetingId.toLowerCase() != meetingId.toLowerCase() ||
          media.id.toLowerCase() != mediaId.toLowerCase()) {
        throw response.invalidDataFailure();
      }
      _requireMeetingSession(scope, outcome: MediaMutationOutcome.unknown);
      return media;
    } on MediaRepositoryFailure {
      rethrow;
    } on ApiFailure catch (failure) {
      throw _classify(
        failure,
        outcome: MediaMutationOutcome.unknown,
        cause: failure,
      );
    }
  }

  Future<List<MediaRecord>> listMedia(
    String meetingId, {
    AuthenticatedSessionScope? sessionScope,
  }) async {
    _validateMeetingId(meetingId);
    final scope = _captureSession(sessionScope);
    final response = await _readRequest(
      scope,
      () => api.get('${_meetingPath(meetingId)}/media', sessionScope: scope),
    );
    try {
      final values = response
          .objectArrayData()
          .map((raw) => MediaRecord.fromJson(raw, response: response))
          .toList(growable: false);
      if (values.any(
        (media) => media.meetingId.toLowerCase() != meetingId.toLowerCase(),
      )) {
        throw response.invalidDataFailure();
      }
      _requireMeetingSession(scope);
      return List<MediaRecord>.unmodifiable(values);
    } on MediaRepositoryFailure {
      rethrow;
    } on ApiFailure catch (failure) {
      throw _classify(
        failure,
        outcome: MediaMutationOutcome.notDispatched,
        cause: failure,
      );
    }
  }

  Future<MediaRecord> getMedia(
    String meetingId,
    String mediaId, {
    AuthenticatedSessionScope? sessionScope,
  }) async {
    _validateMeetingId(meetingId);
    _validateIdentifier(mediaId, 'mediaId');
    final scope = _captureSession(sessionScope);
    final response = await _readRequest(
      scope,
      () => api.get(
        '${_meetingPath(meetingId)}/media/${Uri.encodeComponent(mediaId)}',
        sessionScope: scope,
      ),
    );
    try {
      final media = MediaRecord.fromJson(
        response.objectData(),
        response: response,
      );
      if (media.meetingId.toLowerCase() != meetingId.toLowerCase() ||
          media.id.toLowerCase() != mediaId.toLowerCase()) {
        throw response.invalidDataFailure();
      }
      _requireMeetingSession(scope);
      return media;
    } on MediaRepositoryFailure {
      rethrow;
    } on ApiFailure catch (failure) {
      throw _classify(
        failure,
        outcome: MediaMutationOutcome.notDispatched,
        cause: failure,
      );
    }
  }

  Future<MediaAccessCapability> createAccessCapability(
    String meetingId,
    String mediaId, {
    AuthenticatedSessionScope? sessionScope,
  }) async {
    _validateMeetingId(meetingId);
    _validateIdentifier(mediaId, 'mediaId');
    final scope = _captureSession(sessionScope);
    final response = await _readRequest(
      scope,
      () => api.post(
        '${_meetingPath(meetingId)}/media/${Uri.encodeComponent(mediaId)}/access-url',
        const <String, dynamic>{},
        sessionScope: scope,
      ),
    );
    try {
      final capability = MediaAccessCapability.fromJson(
        response.objectData(),
        response: response,
      );
      _requireMeetingSession(scope);
      return capability;
    } on MediaRepositoryFailure {
      rethrow;
    } on ApiFailure catch (failure) {
      throw _classify(
        failure,
        outcome: MediaMutationOutcome.notDispatched,
        cause: failure,
      );
    }
  }

  Future<ApiResult> _readRequest(
    AuthenticatedSessionScope scope,
    Future<ApiResult> Function() send,
  ) async {
    _requireMeetingSession(scope);
    try {
      final response = await send();
      _requireMeetingSession(scope);
      return response;
    } catch (error) {
      if (!api.isCurrentAuthenticatedSession(scope)) {
        throw _sessionFailure(MediaMutationOutcome.notDispatched, cause: error);
      }
      if (error is MediaRepositoryFailure) rethrow;
      throw _classify(
        _asApiFailure(error),
        outcome: MediaMutationOutcome.notDispatched,
        cause: error,
      );
    }
  }

  Future<ApiResult> _mutateRequest(
    AuthenticatedSessionScope scope,
    Future<ApiResult> Function() send,
  ) async {
    _requireMeetingSession(scope);
    var dispatched = false;
    try {
      dispatched = true;
      final response = await send();
      _requireMeetingSession(scope, outcome: MediaMutationOutcome.unknown);
      return response;
    } catch (error) {
      if (error is MediaRepositoryFailure) rethrow;
      final failure = _asApiFailure(error);
      throw _classify(
        failure,
        outcome: !dispatched
            ? MediaMutationOutcome.notDispatched
            : _mutationOutcome(failure),
        cause: error,
      );
    }
  }

  AuthenticatedSessionScope _captureSession(
    AuthenticatedSessionScope? expected,
  ) {
    final scope = expected ?? api.authenticatedSessionScope;
    if (scope == null || !api.isCurrentAuthenticatedSession(scope)) {
      throw _sessionFailure(MediaMutationOutcome.notDispatched);
    }
    return scope;
  }

  void _requireMeetingSession(
    AuthenticatedSessionScope scope, {
    MediaMutationOutcome outcome = MediaMutationOutcome.notDispatched,
  }) {
    if (!api.isCurrentAuthenticatedSession(scope)) {
      throw _sessionFailure(outcome);
    }
  }

  MediaRepositoryFailure _sessionFailure(
    MediaMutationOutcome outcome, {
    Object? cause,
  }) => MediaRepositoryFailure(
    const ApiFailure(
      401,
      'AUTH_SESSION_CHANGED',
      'The authenticated session changed while the media operation was active.',
    ),
    category: MediaFailureCategory.authentication,
    mutationOutcome: outcome,
    cause: cause,
  );

  MediaRepositoryFailure _classify(
    ApiFailure failure, {
    required MediaMutationOutcome outcome,
    Object? cause,
  }) => MediaRepositoryFailure(
    failure,
    category: _categoryFor(failure),
    mutationOutcome: outcome,
    cause: cause,
  );

  MediaFailureCategory _categoryFor(ApiFailure failure) {
    if (failure.status == 401) return MediaFailureCategory.authentication;
    if (failure.status == 403) return MediaFailureCategory.authorization;
    if (failure.status == 404) return MediaFailureCategory.resourceUnavailable;
    if (failure.status == 409 || failure.status == 412) {
      return MediaFailureCategory.businessConflict;
    }
    if (failure.status == 429) return MediaFailureCategory.rateLimited;
    if (failure.code == 'NETWORK_TIMEOUT' ||
        failure.code == 'UPLOAD_TIMEOUT' ||
        failure.code == 'UPLOAD_INACTIVITY_TIMEOUT') {
      return MediaFailureCategory.timeout;
    }
    if (failure.transportFailure) return MediaFailureCategory.transport;
    if (failure.invalidResponse) return MediaFailureCategory.invalidResponse;
    if (failure.status == 408 || failure.status == 425) {
      return MediaFailureCategory.timeout;
    }
    if (failure.status >= 500 && failure.status <= 599) {
      return MediaFailureCategory.server;
    }
    if (failure.status == 400 ||
        failure.status == 422 ||
        failure.code == 'VALIDATION_FAILED') {
      return MediaFailureCategory.validation;
    }
    if (failure.status >= 400 && failure.status <= 499) {
      return MediaFailureCategory.rejectedRequest;
    }
    return MediaFailureCategory.unknown;
  }

  MediaMutationOutcome _mutationOutcome(ApiFailure failure) {
    if (failure.code == 'AUTH_SESSION_CHANGED' ||
        failure.code == 'AUTH_SESSION_REQUIRED' ||
        failure.status == 401) {
      return MediaMutationOutcome.unknown;
    }
    if (!failure.transportFailure &&
        failure.status >= 400 &&
        failure.status <= 499 &&
        failure.status != 408 &&
        failure.status != 425) {
      return MediaMutationOutcome.rejected;
    }
    return MediaMutationOutcome.unknown;
  }

  ApiFailure _asApiFailure(Object error) {
    if (error is ApiFailure) return error;
    if (error is AuthSessionException) {
      return error.failure.apiFailure ??
          ApiFailure(
            error.failure.status ?? 401,
            error.failure.machineCode ?? 'AUTH_SESSION_CHANGED',
            error.failure.message,
          );
    }
    return const ApiFailure(
      0,
      'MEDIA_REPOSITORY_FAILURE',
      'The media operation could not be completed.',
      isTransportFailure: true,
    );
  }
}

void _validateMeetingId(String meetingId) =>
    _validateIdentifier(meetingId, 'meetingId');

void _validateIdentifier(String value, String name) {
  if (!_uuidPattern.hasMatch(value)) {
    throw ArgumentError.value(value, name, 'Must be a UUID.');
  }
}

void _validateIdempotencyKey(String value) {
  if (value.isEmpty ||
      value.trim() != value ||
      value.length > 255 ||
      _containsControl(value)) {
    throw ArgumentError.value(
      value,
      'idempotencyKey',
      'Must be a stable, safe idempotency key.',
    );
  }
}

bool _containsControl(String value) => value.codeUnits.any(
  (unit) => unit < 0x20 || (unit >= 0x7f && unit <= 0x9f),
);

String _meetingPath(String meetingId) =>
    '/meetings/${Uri.encodeComponent(meetingId)}';

final RegExp _uuidPattern = RegExp(
  r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-'
  r'[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
);
