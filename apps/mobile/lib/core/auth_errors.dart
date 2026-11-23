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
  networkFailure,
  requestTimeout,
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
    if (failure.status == 408 ||
        failure.code == 'NETWORK_TIMEOUT' ||
        failure.code == 'REQUEST_TIMEOUT') {
      return AuthFailureCategory.requestTimeout;
    }
    if (failure.transportFailure && failure.status == 0) {
      return AuthFailureCategory.networkFailure;
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

  AuthSessionFailure fromApiFailure(ApiFailure failure, AuthEndpoint endpoint) {
    final category = classify(failure, endpoint);
    return AuthSessionFailure._(
      category: category,
      message: switch (category) {
        AuthFailureCategory.authenticationRejected =>
          'Email hoặc mật khẩu không chính xác.',
        AuthFailureCategory.sessionInvalidated =>
          'Phiên đăng nhập đã hết hiệu lực. Vui lòng đăng nhập lại.',
        AuthFailureCategory.authorizationDenied =>
          'Tài khoản chưa được cấp quyền truy cập.',
        AuthFailureCategory.rateLimited =>
          'Máy chủ đang giới hạn yêu cầu. Vui lòng chờ trước khi thử lại.',
        AuthFailureCategory.networkFailure => 'Không thể kết nối đến máy chủ. Hãy kiểm tra kết nối mạng và thử lại.',
        AuthFailureCategory.requestTimeout =>
          'Yêu cầu đã hết thời gian chờ. Vui lòng thử lại.',
        AuthFailureCategory.temporaryServiceFailure =>
          'Dịch vụ đang tạm thời không khả dụng. Vui lòng thử lại sau.',
        AuthFailureCategory.invalidResponse =>
          'Máy chủ trả về dữ liệu xác thực không hợp lệ.',
        AuthFailureCategory.credentialStorage =>
          'Không thể truy cập thông tin đăng nhập được bảo vệ.',
        AuthFailureCategory.unsafeCredential =>
          'Thông tin phiên đã lưu không an toàn. Vui lòng đăng nhập lại.',
        AuthFailureCategory.rotationOutcomeUnknown => 'Không xác định được kết quả gia hạn phiên. Vui lòng đăng nhập lại để bảo vệ tài khoản.',
        AuthFailureCategory.unexpected =>
          'Không thể hoàn tất thao tác xác thực. Vui lòng thử lại.',
      },
      apiFailure: failure,
    );
  }

  AuthSessionFailure credentialStorageFailure(Object error) {
    final operation = error is TokenStoreException ? error.operation : null;
    final operationName = operation?.name.toUpperCase();
    return AuthSessionFailure._(
      category: AuthFailureCategory.credentialStorage,
      message: 'Không thể truy cập thông tin đăng nhập được bảo vệ.',
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

  AuthSessionFailure rotationOutcomeUnknown({AuthSessionFailure? cause}) =>
      AuthSessionFailure._(
        category: AuthFailureCategory.rotationOutcomeUnknown,
        message: switch (cause?.category) {
          AuthFailureCategory.invalidResponse => 'Máy chủ trả về phản hồi xác thực không hợp lệ và không thể xác nhận việc gia hạn phiên. Vui lòng đăng nhập lại.',
          AuthFailureCategory.networkFailure => 'Mất kết nối trong khi gia hạn phiên nên không thể xác nhận kết quả. Vui lòng đăng nhập lại để bảo vệ tài khoản.',
          AuthFailureCategory.requestTimeout => 'Yêu cầu gia hạn phiên đã hết thời gian chờ nên không thể xác nhận kết quả. Vui lòng đăng nhập lại để bảo vệ tài khoản.',
          AuthFailureCategory.temporaryServiceFailure => 'Máy chủ tạm thời không khả dụng trong khi gia hạn phiên. Không thể dùng lại thông tin cũ; vui lòng đăng nhập lại.',
          _ => 'Không xác định được kết quả gia hạn phiên. Vui lòng đăng nhập lại để bảo vệ tài khoản.',
        },
        apiFailure: cause?.apiFailure,
        code: 'REFRESH_ROTATION_OUTCOME_UNKNOWN',
        underlyingCategory: cause?.category,
      );
}

@immutable
class AuthSessionFailure {
  const AuthSessionFailure._({
    required this.category,
    required this.message,
    this.apiFailure,
    this.code,
    this.underlyingCategory,
  });

  final AuthFailureCategory category;
  final String message;
  final ApiFailure? apiFailure;
  final String? code;
  final AuthFailureCategory? underlyingCategory;

  int? get status => apiFailure?.status;
  String? get machineCode => code ?? apiFailure?.code;
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
