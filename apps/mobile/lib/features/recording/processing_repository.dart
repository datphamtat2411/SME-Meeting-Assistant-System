import 'package:sme_meeting_assistant/core/api_client.dart';

import 'media_contracts.dart';
import 'media_repository.dart';

class ProcessingAdmissionRequest {
  ProcessingAdmissionRequest({required this.mediaId, this.reprocessOfJobId}) {
    if (!_uuidPattern.hasMatch(mediaId)) {
      throw ArgumentError.value(mediaId, 'mediaId', 'Must be a UUID.');
    }
    if (reprocessOfJobId != null && !_uuidPattern.hasMatch(reprocessOfJobId!)) {
      throw ArgumentError.value(
        reprocessOfJobId,
        'reprocessOfJobId',
        'A reprocessing job ID must not be empty.',
      );
    }
  }

  final String mediaId;
  final String? reprocessOfJobId;

  Map<String, dynamic> toJson() => <String, dynamic>{
    'mediaId': mediaId,
    if (reprocessOfJobId != null) 'reprocessOfJobId': reprocessOfJobId,
  };
}

class ProcessingRepository {
  ProcessingRepository({required this.api});

  final ApiClient api;

  Future<ProcessingJobRecord> admit(
    String meetingId,
    ProcessingAdmissionRequest request, {
    required String idempotencyKey,
    AuthenticatedSessionScope? sessionScope,
  }) async {
    _validateId(meetingId, 'meetingId');
    _validateIdempotencyKey(idempotencyKey);
    final scope = _captureSession(sessionScope);
    final response = await _mutate(
      scope,
      () => api.post(
        '${_meetingPath(meetingId)}/processing-jobs',
        request.toJson(),
        headers: <String, String>{'Idempotency-Key': idempotencyKey},
        sessionScope: scope,
      ),
    );
    final job = _decode(response, meetingId: meetingId);
    _requireSession(scope, outcome: MediaMutationOutcome.unknown);
    return job;
  }

  Future<List<ProcessingJobRecord>> list(
    String meetingId, {
    AuthenticatedSessionScope? sessionScope,
  }) async {
    _validateId(meetingId, 'meetingId');
    final scope = _captureSession(sessionScope);
    final response = await _read(
      scope,
      () => api.get(
        '${_meetingPath(meetingId)}/processing-jobs',
        sessionScope: scope,
      ),
    );
    final jobs = response
        .objectArrayData()
        .map((raw) => ProcessingJobRecord.fromJson(raw, response: response))
        .toList(growable: false);
    if (jobs.any(
      (job) => job.meetingId.toLowerCase() != meetingId.toLowerCase(),
    )) {
      throw response.invalidDataFailure();
    }
    _requireSession(scope);
    return List<ProcessingJobRecord>.unmodifiable(jobs);
  }

  Future<ProcessingJobRecord> get(
    String jobId, {
    AuthenticatedSessionScope? sessionScope,
  }) async {
    _validateId(jobId, 'jobId');
    final scope = _captureSession(sessionScope);
    final response = await _read(
      scope,
      () => api.get(
        '/processing-jobs/${Uri.encodeComponent(jobId)}',
        sessionScope: scope,
      ),
    );
    final job = _decode(response);
    if (job.id.toLowerCase() != jobId.toLowerCase()) {
      throw response.invalidDataFailure();
    }
    _requireSession(scope);
    return job;
  }

  Future<ProcessingJobRecord> retry(
    String jobId, {
    required String idempotencyKey,
    String? stageCode,
    AuthenticatedSessionScope? sessionScope,
  }) async {
    _validateId(jobId, 'jobId');
    _validateIdempotencyKey(idempotencyKey);
    if (stageCode != null &&
        !RegExp(r'^[A-Z][A-Z0-9_]{0,47}$').hasMatch(stageCode)) {
      throw ArgumentError.value(
        stageCode,
        'stageCode',
        'Must match the Core processing stage contract.',
      );
    }
    final scope = _captureSession(sessionScope);
    final response = await _mutate(
      scope,
      () => api.post(
        '/processing-jobs/${Uri.encodeComponent(jobId)}/retry',
        <String, dynamic>{if (stageCode != null) 'stageCode': stageCode},
        headers: <String, String>{'Idempotency-Key': idempotencyKey},
        sessionScope: scope,
      ),
    );
    final job = _decode(response);
    if (job.id.toLowerCase() != jobId.toLowerCase()) {
      throw response.invalidDataFailure();
    }
    _requireSession(scope, outcome: MediaMutationOutcome.unknown);
    return job;
  }

  ProcessingJobRecord _decode(ApiResult response, {String? meetingId}) {
    final job = ProcessingJobRecord.fromJson(
      response.objectData(),
      response: response,
    );
    if (meetingId != null &&
        job.meetingId.toLowerCase() != meetingId.toLowerCase()) {
      throw response.invalidDataFailure();
    }
    return job;
  }

  AuthenticatedSessionScope _captureSession(
    AuthenticatedSessionScope? expected,
  ) {
    final scope = expected ?? api.authenticatedSessionScope;
    if (scope == null || !api.isCurrentAuthenticatedSession(scope)) {
      throw MediaRepositoryFailure(
        const ApiFailure(
          401,
          'AUTH_SESSION_CHANGED',
          'The authenticated session is not available.',
        ),
        category: MediaFailureCategory.authentication,
        mutationOutcome: MediaMutationOutcome.notDispatched,
      );
    }
    return scope;
  }

  void _requireSession(
    AuthenticatedSessionScope scope, {
    MediaMutationOutcome outcome = MediaMutationOutcome.notDispatched,
  }) {
    if (!api.isCurrentAuthenticatedSession(scope)) {
      throw MediaRepositoryFailure(
        const ApiFailure(
          401,
          'AUTH_SESSION_CHANGED',
          'The authenticated session changed while the processing operation was active.',
        ),
        category: MediaFailureCategory.authentication,
        mutationOutcome: outcome,
      );
    }
  }

  Future<ApiResult> _read(
    AuthenticatedSessionScope scope,
    Future<ApiResult> Function() send,
  ) async {
    _requireSession(scope);
    try {
      final response = await send();
      _requireSession(scope);
      return response;
    } catch (error) {
      if (!api.isCurrentAuthenticatedSession(scope)) {
        _requireSession(scope);
      }
      if (error is MediaRepositoryFailure) rethrow;
      throw MediaRepositoryFailure(
        error is ApiFailure ? error : _unknownFailure(),
        category: MediaFailureCategory.unknown,
        mutationOutcome: MediaMutationOutcome.notDispatched,
        cause: error,
      );
    }
  }

  Future<ApiResult> _mutate(
    AuthenticatedSessionScope scope,
    Future<ApiResult> Function() send,
  ) async {
    _requireSession(scope);
    try {
      final response = await send();
      _requireSession(scope, outcome: MediaMutationOutcome.unknown);
      return response;
    } catch (error) {
      if (error is MediaRepositoryFailure) rethrow;
      final failure = error is ApiFailure ? error : _unknownFailure();
      final outcome =
          failure.code == 'AUTH_SESSION_CHANGED' ||
              failure.code == 'AUTH_SESSION_REQUIRED' ||
              failure.status == 401
          ? MediaMutationOutcome.unknown
          : !failure.transportFailure &&
                failure.status >= 400 &&
                failure.status <= 499 &&
                failure.status != 408 &&
                failure.status != 425
          ? MediaMutationOutcome.rejected
          : MediaMutationOutcome.unknown;
      throw MediaRepositoryFailure(
        failure,
        category: _categoryFor(failure),
        mutationOutcome: outcome,
        cause: error,
      );
    }
  }

  ApiFailure _unknownFailure() => const ApiFailure(
    0,
    'PROCESSING_REPOSITORY_FAILURE',
    'The processing operation could not be completed.',
    isTransportFailure: true,
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
}

void _validateId(String value, String name) {
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
