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

  Future<ApiResult> requestPasswordRecovery(String email) =>
      _requests.sendPublicAuthentication(
        PublicAuthenticationOperation.passwordRecovery,
        body: <String, dynamic>{'email': email.trim()},
      );

  Future<ApiResult> resetPassword(String token, String password) =>
      _requests.sendPublicAuthentication(
        PublicAuthenticationOperation.passwordReset,
        body: <String, dynamic>{'token': token.trim(), 'password': password},
      );

  Future<ApiResult> completeAccountSetup(String token, String password) =>
      _requests.sendPublicAuthentication(
        PublicAuthenticationOperation.accountSetup,
        body: <String, dynamic>{'token': token.trim(), 'password': password},
      );

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
