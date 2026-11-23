part of 'api_client.dart';

enum AuthEndpoint {
  login,
  refresh,
  identity,
  logout,
  protectedRequest,
  credentialStorage,
}

enum AuthFailureCategory {
  authenticationRejected,
  sessionInvalidated,
  authorizationDenied,
  rateLimited,
  temporaryServiceFailure,
  invalidResponse,
  credentialStorage,
  unsafeCredential,
  rotationOutcomeUnknown,
  unexpected,
}

class AuthFailureClassifier {
  const AuthFailureClassifier();

  AuthFailureCategory classify(ApiFailure failure, AuthEndpoint endpoint) {
    if (failure.invalidResponse ||
        failure.code == 'UNSUPPORTED_AUTH_CONTRACT') {
      return AuthFailureCategory.invalidResponse;
    }
    if (failure.status == 429) return AuthFailureCategory.rateLimited;
    if (failure.status == 403) {
      return AuthFailureCategory.authorizationDenied;
    }
    if (failure.status == 401) {
      return switch (endpoint) {
        AuthEndpoint.login => AuthFailureCategory.authenticationRejected,
        AuthEndpoint.refresh ||
        AuthEndpoint.identity ||
        AuthEndpoint.logout ||
        AuthEndpoint.protectedRequest => AuthFailureCategory.sessionInvalidated,
        AuthEndpoint.credentialStorage => AuthFailureCategory.unexpected,
      };
    }
    if (failure.transportFailure ||
        failure.status == 0 ||
        failure.status == 408 ||
        failure.status == 425 ||
        failure.status >= 500 && failure.status <= 599) {
      return AuthFailureCategory.temporaryServiceFailure;
    }
    return AuthFailureCategory.unexpected;
  }

  AuthSessionFailure fromApiFailure(
    ApiFailure failure,
    AuthEndpoint endpoint,
  ) => AuthSessionFailure._(
    category: classify(failure, endpoint),
    message: failure.message,
    apiFailure: failure,
  );

  AuthSessionFailure credentialStorageFailure(Object error) {
    final operation = error is TokenStoreException ? error.operation : null;
    final operationName = operation?.name.toUpperCase();
    return AuthSessionFailure._(
      category: AuthFailureCategory.credentialStorage,
      message: 'Secure credential storage is unavailable.',
      code: operationName == null
          ? 'CREDENTIAL_STORAGE_FAILURE'
          : 'CREDENTIAL_STORAGE_${operationName}_FAILED',
    );
  }

  AuthSessionFailure unsafeStoredCredential(String code, String message) =>
      AuthSessionFailure._(
        category: AuthFailureCategory.unsafeCredential,
        message: message,
        code: code,
      );

  AuthSessionFailure rotationOutcomeUnknown() => AuthSessionFailure._(
    category: AuthFailureCategory.rotationOutcomeUnknown,
    message: 'The saved session could not be safely continued. Please sign in again.',
    code: 'REFRESH_ROTATION_OUTCOME_UNKNOWN',
  );
}

@immutable
class AuthSessionFailure {
  const AuthSessionFailure._({
    required this.category,
    required this.message,
    this.apiFailure,
    this.code,
  });

  final AuthFailureCategory category;
  final String message;
  final ApiFailure? apiFailure;
  final String? code;

  int? get status => apiFailure?.status;
  String? get machineCode => apiFailure?.code ?? code;
  String? get requestId => apiFailure?.requestId;
  String? get responseRequestId => apiFailure?.responseRequestId;
  String? get retryAfter => apiFailure?.retryAfter;
}

class AuthSessionException implements Exception {
  const AuthSessionException(this.failure);

  final AuthSessionFailure failure;

  @override
  String toString() => failure.message;
}
