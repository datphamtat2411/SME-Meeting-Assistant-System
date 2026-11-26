part of 'api_client.dart';

/// Owns Mobile authentication endpoint contracts and request routing.
///
/// It intentionally has no credentials, persistence, session state, or UI
/// dependencies. Requests go directly through the shared low-level executor.
class AuthRepository {
  factory AuthRepository({required CoreApiRequestExecutor requests}) =>
      AuthRepository._(requests);

  const AuthRepository._(this._requests);

  final CoreApiRequestExecutor _requests;

  Future<void> requestPasswordRecovery(String email) =>
      _completePublicOperation(
        PublicAuthenticationOperation.passwordRecovery,
        body: <String, dynamic>{'email': email.trim()},
      );

  Future<void> resetPassword(String token, String password) =>
      _completePublicOperation(
        PublicAuthenticationOperation.passwordReset,
        body: <String, dynamic>{'token': token, 'password': password},
      );

  Future<void> completeAccountSetup(String token, String password) =>
      _completePublicOperation(
        PublicAuthenticationOperation.accountSetup,
        body: <String, dynamic>{'token': token, 'password': password},
      );

  Future<void> _completePublicOperation(
    PublicAuthenticationOperation operation, {
    required Map<String, dynamic> body,
  }) async {
    final response = await _requests.sendPublicAuthentication(
      operation,
      body: body,
    );
    final data = response.data;
    final valid = switch (operation) {
      PublicAuthenticationOperation.accountSetup => data == null,
      PublicAuthenticationOperation.passwordRecovery ||
      PublicAuthenticationOperation.passwordReset =>
        data is Map<String, dynamic> &&
            data['message'] is String &&
            (data['message'] as String).trim().isNotEmpty,
    };
    if (!valid) {
      throw ApiFailure(
        response.statusCode,
        ApiFailure.invalidResponseCode,
        'The server returned an invalid account operation response.',
        requestId: response.requestId,
        responseRequestId: response.responseRequestId,
        timestamp: response.timestamp,
        headers: response.headers,
        remoteOutcomeAmbiguous: true,
      );
    }
  }

  Future<AuthTokenResponse> login(String email, String password) async {
    final response = await _requests.send(
      'POST',
      '/auth/login',
      body: <String, dynamic>{'email': email.trim(), 'password': password},
    );
    return AuthTokenResponse.fromJson(
      response.objectData(),
      response: response,
    );
  }

  Future<AuthTokenResponse> refresh(String refreshToken) async {
    final response = await _requests.send(
      'POST',
      '/auth/refresh',
      authorization: 'Bearer $refreshToken',
    );
    return AuthTokenResponse.fromJson(
      response.objectData(),
      response: response,
    );
  }

  Future<AuthIdentity> currentIdentity(String accessToken) async {
    final response = await _requests.send(
      'GET',
      '/auth/me',
      authorization: 'Bearer $accessToken',
    );
    final identity = AuthIdentity.fromJson(
      response.objectData(),
      response: response,
    );
    if (!identity.isEligibleMobileIdentity) {
      invalidApiData(response: response);
    }
    return identity;
  }

  Future<void> logout(String accessToken) async {
    await _requests.send(
      'POST',
      '/auth/logout',
      body: const <String, dynamic>{},
      authorization: 'Bearer $accessToken',
    );
  }
}
