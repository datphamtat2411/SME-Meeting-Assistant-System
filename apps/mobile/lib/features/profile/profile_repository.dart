import '../../core/api_client.dart';
import 'profile_models.dart';

enum ProfileFailureCategory {
  authentication,
  authorization,
  unavailable,
  conflict,
  missingPrecondition,
  validation,
  rateLimited,
  timeout,
  transport,
  server,
  invalidResponse,
  rejected,
  unexpected,
}

enum ProfileMutationOutcome { notDispatched, rejected, unknown, confirmed }

class ProfileFailure extends ApiFailure {
  ProfileFailure(
    ApiFailure source, {
    required this.outcome,
  }) : category = _category(source),
       super(
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

  final ProfileFailureCategory category;
  final ProfileMutationOutcome outcome;

  static ProfileFailureCategory _category(ApiFailure error) {
    if (error.invalidResponse) return ProfileFailureCategory.invalidResponse;
    if (error.status == 401) return ProfileFailureCategory.authentication;
    if (error.status == 403) return ProfileFailureCategory.authorization;
    if (error.status == 404) return ProfileFailureCategory.unavailable;
    if (error.status == 412 || error.status == 409) {
      return ProfileFailureCategory.conflict;
    }
    if (error.status == 428) return ProfileFailureCategory.missingPrecondition;
    if (error.validationFailure || error.malformedRequest) {
      return ProfileFailureCategory.validation;
    }
    if (error.rateLimited) return ProfileFailureCategory.rateLimited;
    if (error.status == 408 ||
        error.code == 'REQUEST_TIMEOUT' ||
        error.code == 'NETWORK_TIMEOUT') {
      return ProfileFailureCategory.timeout;
    }
    if (error.transportFailure) return ProfileFailureCategory.transport;
    if (error.serverFailure) return ProfileFailureCategory.server;
    if (error.status >= 400 && error.status < 500) {
      return ProfileFailureCategory.rejected;
    }
    return ProfileFailureCategory.unexpected;
  }

  bool get accessLost =>
      category == ProfileFailureCategory.authorization ||
      category == ProfileFailureCategory.unavailable;

  bool get requiresReconciliation =>
      outcome == ProfileMutationOutcome.unknown ||
      category == ProfileFailureCategory.conflict ||
      category == ProfileFailureCategory.missingPrecondition;

  static ProfileFailure local(int status, String code, String message) =>
      ProfileFailure(
        ApiFailure(status, code, message),
        outcome: ProfileMutationOutcome.notDispatched,
      );
}

class ProfileRepository {
  ProfileRepository({required this.api});

  final ApiClient api;

  Future<ProfileSnapshot> profile(AuthenticatedSessionScope scope) =>
      _request(
        scope,
        () => api.get('/me/profile', sessionScope: scope),
        (response) => ProfileSnapshot.fromResult(response, scope),
      );

  Future<ProfileSnapshot> updateName(
    ProfileSnapshot original,
    String name,
  ) async {
    if (name.trim().isEmpty || name.length > 200) {
      throw ProfileFailure.local(
        422,
        'PROFILE_INVALID_NAME',
        'Tên hiển thị không hợp lệ.',
      );
    }
    final scope = original.sessionScope;
    return _request(
      scope,
      () => api.patch(
        '/me/profile',
        {'displayName': name},
        headers: {'If-Match': original.etag},
        sessionScope: scope,
      ),
      (response) => ProfileSnapshot.fromResult(response, scope),
      mutation: true,
    );
  }

  Future<PreferencesSnapshot> preferences(AuthenticatedSessionScope scope) =>
      _request(
        scope,
        () => api.get('/me/preferences', sessionScope: scope),
        (response) =>
            PreferencesSnapshot(UserPreferences.fromResult(response), scope),
      );

  Future<PreferencesSnapshot> updateMeetingEmail(
    AuthenticatedSessionScope scope,
    bool enabled,
  ) => _updatePreference(scope, {'meetingEmailEnabled': enabled});

  Future<PreferencesSnapshot> updateActionItemEmail(
    AuthenticatedSessionScope scope,
    bool enabled,
  ) => _updatePreference(scope, {'actionItemEmailEnabled': enabled});

  Future<PreferencesSnapshot> updateTimezone(
    AuthenticatedSessionScope scope,
    String? value,
  ) => _updateRegional(scope, 'timezone', value);

  Future<PreferencesSnapshot> updateLocale(
    AuthenticatedSessionScope scope,
    String? value,
  ) => _updateRegional(scope, 'locale', value);

  Future<PreferencesSnapshot> _updateRegional(
    AuthenticatedSessionScope scope,
    String field,
    String? value,
  ) async {
    if (value != null && value.trim().isEmpty) {
      throw ProfileFailure.local(
        422,
        'PREFERENCE_INVALID_VALUE',
        'Giá trị thiết lập không hợp lệ.',
      );
    }
    return _updatePreference(scope, {field: value});
  }

  Future<PreferencesSnapshot> _updatePreference(
    AuthenticatedSessionScope scope,
    Map<String, dynamic> body,
  ) => _request(
    scope,
    () => api.patch('/me/preferences', body, sessionScope: scope),
    (response) =>
        PreferencesSnapshot(UserPreferences.fromResult(response), scope),
    mutation: true,
  );

  Future<T> _request<T>(
    AuthenticatedSessionScope scope,
    Future<ApiResult> Function() send,
    T Function(ApiResult) decode, {
    bool mutation = false,
  }) async {
    if (!api.isCurrentAuthenticatedSession(scope)) {
      throw ProfileFailure.local(
        401,
        'AUTH_SESSION_CHANGED',
        'Phiên đăng nhập đã thay đổi.',
      );
    }
    try {
      final response = await send();
      api.requireCurrentAuthenticatedSession(scope);
      return decode(response);
    } on ApiFailure catch (failure) {
      final rejected =
          failure.status >= 400 &&
          failure.status < 500 &&
          failure.status != 408 &&
          !failure.invalidResponse &&
          !failure.transportFailure &&
          !failure.remoteOutcomeAmbiguous;
      throw ProfileFailure(
        failure,
        outcome: !mutation
            ? ProfileMutationOutcome.notDispatched
            : rejected
            ? ProfileMutationOutcome.rejected
            : ProfileMutationOutcome.unknown,
      );
    } on AuthSessionException {
      throw ProfileFailure(
        const ApiFailure(
          401,
          'AUTH_SESSION_CHANGED',
          'Phiên đăng nhập đã thay đổi.',
        ),
        outcome: mutation
            ? ProfileMutationOutcome.unknown
            : ProfileMutationOutcome.notDispatched,
      );
    }
  }
}
