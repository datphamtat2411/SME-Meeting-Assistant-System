import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'api_request_executor.dart';
import 'api_model_validation.dart';
import 'api_response.dart';
import 'api_response_decoder.dart';
import 'api_transport.dart';
import 'credential_storage.dart';
import 'signed_upload_transport.dart';
import 'token_store.dart';

export 'api_response.dart';
export 'api_transport.dart';
export 'credential_storage.dart';
export 'signed_upload_transport.dart';
export 'token_store.dart';

part 'auth_errors.dart';
part 'auth_models.dart';
part 'auth_repository.dart';
part 'auth_session_coordinator.dart';

Map<String, dynamic> objectOf(dynamic value) {
  if (value is Map<String, dynamic>) return value;
  if (value is Map) return value.map((key, v) => MapEntry(key.toString(), v));
  return <String, dynamic>{};
}

List<Map<String, dynamic>> objectsOf(dynamic value) {
  if (value is! List) return [];
  return value.map(objectOf).toList(growable: false);
}

/// Feature-facing API compatibility facade.
///
/// Authentication state and credentials belong exclusively to
/// [sessionCoordinator]. General API calls continue to use the shared Core API
/// transport and retain the established retry and signed-upload behavior.
class ApiClient extends ChangeNotifier {
  final Uri baseUri;
  final CoreApiTransport _coreTransport;
  final SignedUploadTransport _signedUploadTransport;
  final ApiResponseDecoder _responseDecoder = const ApiResponseDecoder();
  late final CoreApiRequestExecutor _requestExecutor;
  late final AuthRepository _authRepository;
  late final TokenStore _tokenStore;
  late final AuthSessionCoordinator sessionCoordinator;
  bool _disposed = false;

  ApiClient({
    required this.baseUri,
    required http.Client httpClient,
    required CredentialStorage credentialStorage,
    Duration apiDispatchTimeout = const Duration(seconds: 25),
    Duration apiResponseTimeout = const Duration(seconds: 45),
    Duration uploadTimeout = const Duration(minutes: 10),
    bool? androidDebugOverride,
    DateTime Function()? now,
  }) : _coreTransport = CoreApiTransport(
         baseUri: baseUri,
         httpClient: httpClient,
         dispatchTimeout: apiDispatchTimeout,
         responseTimeout: apiResponseTimeout,
       ),
       _signedUploadTransport = SignedUploadTransport(
         httpClient: httpClient,
         timeout: uploadTimeout,
         androidDebugOverride: androidDebugOverride,
       ) {
    _requestExecutor = CoreApiRequestExecutor(
      transport: _coreTransport,
      decoder: _responseDecoder,
    );
    _authRepository = AuthRepository(requests: _requestExecutor);
    _tokenStore = TokenStore(storage: credentialStorage, baseUri: baseUri);
    sessionCoordinator = AuthSessionCoordinator(
      repository: _authRepository,
      tokenStore: _tokenStore,
      now: now,
    )..addListener(_forwardSessionChanges);
  }

  AuthSessionState get sessionState => sessionCoordinator.state;
  AuthenticatedSessionScope? get authenticatedSessionScope =>
      sessionCoordinator.authenticatedSessionScope;
  AuthenticatedSessionScope requireAuthenticatedSessionScope() =>
      sessionCoordinator.requireAuthenticatedSessionScope();
  bool isCurrentAuthenticatedSession(AuthenticatedSessionScope scope) =>
      sessionCoordinator.isCurrentAuthenticatedSession(scope);
  void requireCurrentAuthenticatedSession(AuthenticatedSessionScope scope) =>
      sessionCoordinator.requireCurrentAuthenticatedSession(scope);
  bool get ready => switch (sessionState.phase) {
    AuthSessionPhase.initializing ||
    AuthSessionPhase.signingIn ||
    AuthSessionPhase.verifyingIdentity ||
    AuthSessionPhase.signingOut => false,
    AuthSessionPhase.unauthenticated ||
    AuthSessionPhase.authenticated ||
    AuthSessionPhase.recoverableFailure ||
    AuthSessionPhase.reauthenticationRequired => true,
  };
  bool get hasRecoverableSession =>
      sessionState.canRetrySessionRestore ||
      sessionState.canRetryIdentityVerification;
  String? get sessionRestoreError => sessionState.sessionRestoreError;
  Map<String, dynamic>? get identity =>
      sessionState.identity?.toCompatibilityMap();
  bool get signedIn => sessionState.isAuthenticated;
  String get userId => sessionState.identity?.userId.value ?? '';
  String get displayName => sessionState.identity?.displayName ?? '';
  String get email => sessionState.identity?.email ?? '';

  Future<void> initialize() => sessionCoordinator.initialize();

  Future<void> retrySessionRestore() =>
      sessionCoordinator.retrySessionRestore();

  Future<void> retryIdentityVerification() =>
      sessionCoordinator.retryIdentityVerification();

  Future<void> discardLocalSession() =>
      sessionCoordinator.discardLocalSession();

  Future<void> signIn(String email, String password) =>
      sessionCoordinator.signIn(email, password);

  Future<void> loadIdentity() => sessionCoordinator.loadIdentity();

  Future<AuthLogoutOutcome> signOut() => sessionCoordinator.signOut();

  /// Requests password recovery without acquiring or changing session state.
  Future<ApiResult> requestPasswordRecovery(String email) =>
      _authRepository.requestPasswordRecovery(email);

  /// Resets a password with a single-use recovery token, without session auth.
  Future<ApiResult> resetPassword(String token, String password) =>
      _authRepository.resetPassword(token, password);

  /// Completes invitation-based account setup without session authentication.
  Future<ApiResult> completeAccountSetup(String token, String password) =>
      _authRepository.completeAccountSetup(token, password);

  Future<ApiResult> get(String path, {Map<String, String>? query}) =>
      _request('GET', path, query: query);

  Future<ApiResult> post(
    String path,
    Map<String, dynamic> body, {
    Map<String, String>? headers,
  }) => _request('POST', path, body: body, headers: headers);

  Future<ApiResult> patch(
    String path,
    Map<String, dynamic> body, {
    Map<String, String>? headers,
  }) => _request('PATCH', path, body: body, headers: headers);

  Future<ApiResult> delete(String path, {Map<String, String>? headers}) =>
      _request('DELETE', path, headers: headers);

  Future<ApiResult> _request(
    String method,
    String path, {
    Map<String, String>? query,
    Map<String, dynamic>? body,
    Map<String, String>? headers,
  }) async {
    final coordinator = sessionCoordinator;
    final epoch = coordinator._lifecycleEpoch;
    final credential = coordinator._credentialForDispatch(
      await coordinator._credentialForProtectedRequest(expectedEpoch: epoch),
      requireVerifiedSession: true,
    );
    final requestEpoch = credential.epoch;
    try {
      return await _sendForSession(
        coordinator,
        credential,
        method,
        path,
        query: query,
        body: body,
        headers: headers,
      );
    } on ApiFailure catch (failure) {
      if (!_coordinatorStillOwnsRequest(coordinator, credential)) {
        throw coordinator._sessionChanged();
      }
      if (!_isAuthentication401(failure)) rethrow;

      final current = coordinator._snapshotForEpoch(requestEpoch);
      if (current == null) rethrow;
      final recovered = current.generation > credential.generation
          ? current
          : await coordinator._recoverAfterUnauthorized(
              expectedEpoch: requestEpoch,
              usedGeneration: credential.generation,
            );

      if (method.toUpperCase() != 'GET') {
        // Mutations are never replayed, even when a credential rotation
        // succeeds. Preserve the original API failure for deliberate retry.
        if (!_coordinatorStillOwnsRequest(coordinator, credential)) {
          throw coordinator._sessionChanged();
        }
        rethrow;
      }

      final replayCredential = coordinator._credentialForDispatch(
        recovered,
        requireVerifiedSession: true,
      );
      try {
        return await _sendForSession(
          coordinator,
          replayCredential,
          method,
          path,
          query: query,
          body: body,
          headers: headers,
        );
      } on ApiFailure catch (retryFailure) {
        if (_isAuthentication401(retryFailure)) {
          await coordinator._handleProtectedFailure(
            retryFailure,
            expectedEpoch: requestEpoch,
            usedGeneration: replayCredential.generation,
          );
          if (!_coordinatorStillOwnsRequest(coordinator, credential)) {
            throw coordinator._sessionChanged();
          }
        }
        rethrow;
      }
    }
  }

  Future<ApiResult> _sendForSession(
    AuthSessionCoordinator coordinator,
    _SessionCredentialSnapshot credential,
    String method,
    String path, {
    Map<String, String>? query,
    Map<String, dynamic>? body,
    Map<String, String>? headers,
  }) async {
    final dispatchCredential = coordinator._credentialForDispatch(
      credential,
      requireVerifiedSession: true,
    );
    try {
      final response = await _requestExecutor.send(
        method,
        path,
        query: query,
        body: body,
        headers: headers,
        authorization: dispatchCredential.authorization,
      );
      if (!_coordinatorStillOwnsRequest(coordinator, credential)) {
        throw coordinator._sessionChanged();
      }
      coordinator._credentialForDispatch(
        dispatchCredential,
        requireVerifiedSession: true,
      );
      return response;
    } catch (error, stackTrace) {
      if (!_coordinatorStillOwnsRequest(coordinator, credential)) {
        Error.throwWithStackTrace(coordinator._sessionChanged(), stackTrace);
      }
      rethrow;
    }
  }

  bool _coordinatorStillOwnsRequest(
    AuthSessionCoordinator coordinator,
    _SessionCredentialSnapshot credential,
  ) =>
      coordinator._isCurrentEpoch(credential.epoch) &&
      coordinator._state.isAuthenticated;

  bool _isAuthentication401(ApiFailure failure) =>
      const AuthFailureClassifier().classify(
        failure,
        AuthEndpoint.protectedRequest,
      ) ==
      AuthFailureCategory.sessionInvalidated;

  /// A signed upload capability is not an API bearer endpoint. Never attach
  /// session tokens, cookies or extra headers to object-storage requests.
  Future<void> uploadSigned(
    String signedUrl,
    File file,
    String contentType, {
    void Function(int sent, int total)? onProgress,
  }) async {
    try {
      await _signedUploadTransport.upload(
        signedUrl,
        file,
        contentType,
        onProgress: onProgress,
      );
    } on TransportFailure catch (failure) {
      throw normalizeTransportFailure(failure);
    }
  }

  void _forwardSessionChanges() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    sessionCoordinator
      ..removeListener(_forwardSessionChanges)
      ..dispose();
    super.dispose();
  }
}
