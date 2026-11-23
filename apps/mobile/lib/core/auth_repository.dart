part of 'api_client.dart';

/// Owns the four Mobile authentication endpoints and their typed contracts.
///
/// It intentionally has no credentials, persistence, session state, or UI
/// dependencies. Requests go directly through the shared low-level executor.
class AuthRepository {
  factory AuthRepository({required CoreApiRequestExecutor requests}) =>
      AuthRepository._(requests);

  const AuthRepository._(this._requests);

  final CoreApiRequestExecutor _requests;

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
