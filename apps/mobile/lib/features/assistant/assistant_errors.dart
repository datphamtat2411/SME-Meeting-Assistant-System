import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/api_request_executor.dart';

enum AssistantFailureCategory {
  authentication,
  authorization,
  resourceUnavailable,
  validation,
  conflict,
  sourceStale,
  rateLimited,
  serviceUnavailable,
  timeout,
  transport,
  invalidResponse,
  unknown,
}

/// Describes the current attempt, not the fate of any earlier replay.
enum AssistantMutationOutcome {
  notApplicable,
  notDispatched,
  rejected,
  unknown,
}

class AssistantFailure extends ApiFailure {
  AssistantFailure._(
    ApiFailure source, {
    required this.category,
    required this.outcome,
  }) : super(
         source.status,
         source.code,
         source.message,
         requestId: source.requestId,
         responseRequestId: source.responseRequestId,
         timestamp: source.timestamp,
         errors: source.errors,
         retryAfter: source.retryAfter ??
             headerValue(source.headers, 'retry-after'),
         headers: source.headers,
         isTransportFailure: source.isTransportFailure,
         remoteOutcomeAmbiguous:
             source.remoteOutcomeAmbiguous ||
             outcome == AssistantMutationOutcome.unknown,
       );

  final AssistantFailureCategory category;
  final AssistantMutationOutcome outcome;

  factory AssistantFailure.invalidInput(String field) => AssistantFailure._(
    ApiFailure(
      422,
      'VALIDATION_ERROR',
      'Invalid Assistant request.',
      errors: [
        ApiFieldError(
          field: field,
          code: 'INVALID_VALUE',
          message: 'Invalid value.',
        ),
      ],
    ),
    category: AssistantFailureCategory.validation,
    outcome: AssistantMutationOutcome.notDispatched,
  );

  factory AssistantFailure.sessionChanged(AssistantMutationOutcome outcome) =>
      AssistantFailure._(
        const ApiFailure(
          401,
          'AUTH_SESSION_CHANGED',
          'The authenticated session changed during the Assistant operation.',
        ),
        category: AssistantFailureCategory.authentication,
        outcome: outcome,
      );

  factory AssistantFailure.fromApi(
    ApiFailure source, {
    required bool mutation,
  }) => AssistantFailure._(
    source,
    category: _category(source),
    outcome: mutation
        ? _mutationOutcome(source)
        : AssistantMutationOutcome.notApplicable,
  );

  factory AssistantFailure.fromSession(
    AuthSessionException error, {
    required bool mutation,
  }) => AssistantFailure._(
    error.failure.apiFailure ??
        ApiFailure(
          error.failure.status ?? 401,
          error.failure.machineCode ?? 'AUTH_SESSION_CHANGED',
          error.failure.message,
          requestId: error.failure.requestId,
          responseRequestId: error.failure.responseRequestId,
          retryAfter: error.failure.retryAfter,
        ),
    category: AssistantFailureCategory.authentication,
    outcome: mutation
        ? AssistantMutationOutcome.unknown
        : AssistantMutationOutcome.notApplicable,
  );
}

AssistantFailureCategory _category(ApiFailure failure) {
  if (failure.invalidResponse) {
    return AssistantFailureCategory.invalidResponse;
  }
  final code = failure.code;
  if (code == 'ASSISTANT_SOURCE_STALE') {
    return AssistantFailureCategory.sourceStale;
  }
  if (code.startsWith('AUTHZ_') || failure.status == 403) {
    return AssistantFailureCategory.authorization;
  }
  if (code.startsWith('AUTH_') || failure.status == 401) {
    return AssistantFailureCategory.authentication;
  }
  if (code.startsWith('RATE_LIMIT_') || failure.rateLimited) {
    return AssistantFailureCategory.rateLimited;
  }
  if (code == 'NETWORK_TIMEOUT' ||
      code == 'REQUEST_TIMEOUT' ||
      failure.status == 408 ||
      failure.status == 425) {
    return AssistantFailureCategory.timeout;
  }
  if (failure.transportFailure) return AssistantFailureCategory.transport;
  if (code.startsWith('VALIDATION_') ||
      failure.malformedRequest ||
      failure.validationFailure) {
    return AssistantFailureCategory.validation;
  }
  if (failure.missing) return AssistantFailureCategory.resourceUnavailable;
  if (failure.conflict) return AssistantFailureCategory.conflict;
  if (code == 'ASSISTANT_UNAVAILABLE' || failure.serverFailure) {
    return AssistantFailureCategory.serviceUnavailable;
  }
  return AssistantFailureCategory.unknown;
}

AssistantMutationOutcome _mutationOutcome(ApiFailure failure) {
  if (failure.transportFailure &&
      !failure.remoteOutcomeAmbiguous &&
      failure.status == 0 &&
      failure.code == 'TLS_ERROR') {
    return AssistantMutationOutcome.notDispatched;
  }
  // Assistant reauthorizes after durable writes. A 404/403 can follow a
  // commit; a stale-source 409 or a 503 can describe an existing durable
  // turn. Never infer non-execution from those response codes.
  if (!failure.transportFailure &&
      !failure.invalidResponse &&
      !failure.remoteOutcomeAmbiguous &&
      (failure.status == 400 ||
          failure.status == 422 ||
          failure.status == 429)) {
    return AssistantMutationOutcome.rejected;
  }
  return AssistantMutationOutcome.unknown;
}
