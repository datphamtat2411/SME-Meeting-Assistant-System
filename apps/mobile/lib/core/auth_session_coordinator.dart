part of 'api_client.dart';

enum AuthSessionPhase {
  initializing,
  unauthenticated,
  signingIn,
  verifyingIdentity,
  authenticated,
  recoverableFailure,
  reauthenticationRequired,
  signingOut,
}

enum _StorageRecoveryAction {
  reloadCredential,
  completeLogout,
  completeReauthentication,
}

@immutable
class AuthSessionState {
  AuthSessionState._({
    required this.phase,
    this.identity,
    this.failure,
    this.canRetrySessionRestore = false,
    this.canRetryCredentialStorage = false,
  }) {
    if ((phase == AuthSessionPhase.authenticated) != (identity != null) ||
        identity != null && !identity!.isEligibleMobileIdentity ||
        canRetrySessionRestore &&
            (phase != AuthSessionPhase.recoverableFailure ||
                failure?.category == AuthFailureCategory.credentialStorage) ||
        canRetryCredentialStorage &&
            (phase != AuthSessionPhase.recoverableFailure ||
                failure?.category != AuthFailureCategory.credentialStorage)) {
      throw StateError('Invalid authentication session state.');
    }
  }

  final AuthSessionPhase phase;
  final AuthIdentity? identity;
  final AuthSessionFailure? failure;
  final bool canRetrySessionRestore;
  final bool canRetryCredentialStorage;

  bool get isAuthenticated => phase == AuthSessionPhase.authenticated;
  bool get isInitializing => phase == AuthSessionPhase.initializing;
  String? get sessionRestoreError =>
      canRetrySessionRestore ? failure?.message : null;
}

/// The sole owner of session state and all in-memory Mobile credentials.
class AuthSessionCoordinator extends ChangeNotifier {
  factory AuthSessionCoordinator({
    required AuthRepository repository,
    required TokenStore tokenStore,
    DateTime Function()? now,
  }) => AuthSessionCoordinator._(repository, tokenStore, now ?? DateTime.now);

  AuthSessionCoordinator._(this._repository, this._tokenStore, this._now);

  final AuthRepository _repository;
  final TokenStore _tokenStore;
  final DateTime Function() _now;
  final AuthFailureClassifier _classifier = const AuthFailureClassifier();

  AuthSessionState _state = AuthSessionState._(
    phase: AuthSessionPhase.initializing,
  );
  String? _accessToken;
  String? _refreshToken;
  DateTime? _accessExpiry;
  Future<void>? _refreshFuture;
  bool _disposed = false;
  _StorageRecoveryAction? _storageRecoveryAction;
  AuthSessionFailure? _failureAfterStorageRecovery;

  AuthSessionState get state => _state;

  bool get _hasRefreshToken => _refreshToken != null;

  String? get _authorization => !_state.isAuthenticated || _accessToken == null
      ? null
      : 'Bearer $_accessToken';

  Future<void> initialize() async {
    if (_state.phase != AuthSessionPhase.initializing) return;

    await _loadStoredCredential();
  }

  Future<void> _loadStoredCredential() async {
    final TokenStoreReadResult stored;
    try {
      stored = await _tokenStore.read();
    } catch (error) {
      _setStorageFailure(
        error,
        recoveryAction: _StorageRecoveryAction.reloadCredential,
      );
      return;
    }

    switch (stored.state) {
      case TokenStoreCredentialState.missing:
        _clearMemoryCredentials();
        _setState(AuthSessionState._(phase: AuthSessionPhase.unauthenticated));
      case TokenStoreCredentialState.legacyRetired:
        _requireReauthenticationForUnsafeCredential(
          'LEGACY_CREDENTIAL_RETIRED',
          'Please sign in again for this API deployment.',
        );
      case TokenStoreCredentialState.committed:
        _refreshToken = stored.refreshToken;
        try {
          await _restoreStoredSession();
        } catch (error) {
          _setState(
            AuthSessionState._(
              phase: AuthSessionPhase.recoverableFailure,
              failure: _failureFor(error, AuthEndpoint.refresh),
              canRetrySessionRestore: _refreshToken != null,
            ),
          );
        }
      case TokenStoreCredentialState.rotationPending:
        _requireReauthenticationForUnsafeCredential(
          'REFRESH_ROTATION_PENDING',
          'The saved session cannot be safely reused. Please sign in again.',
        );
      case TokenStoreCredentialState.malformed ||
          TokenStoreCredentialState.unsupportedVersion ||
          TokenStoreCredentialState.wrongDeployment ||
          TokenStoreCredentialState.invalidCredential:
        _requireReauthenticationForUnsafeCredential(
          'STORED_CREDENTIAL_UNUSABLE',
          'The saved session cannot be safely used. Please sign in again.',
        );
    }
  }

  Future<void> _restoreStoredSession() async {
    _setState(AuthSessionState._(phase: AuthSessionPhase.verifyingIdentity));
    try {
      await _renewTokens();
    } catch (error) {
      await _handleRestoreFailure(error, AuthEndpoint.refresh);
      return;
    }

    try {
      final identity = await _retrieveIdentity();
      _setState(
        AuthSessionState._(
          phase: AuthSessionPhase.authenticated,
          identity: identity,
        ),
      );
    } catch (error) {
      await _handleRestoreFailure(error, AuthEndpoint.identity);
    }
  }

  Future<void> retrySessionRestore() async {
    if (_state.phase != AuthSessionPhase.recoverableFailure ||
        (!_state.canRetrySessionRestore && !_state.canRetryCredentialStorage)) {
      throw StateError('There is no recoverable session to restore.');
    }

    if (_state.canRetryCredentialStorage) {
      final recoveryAction = _storageRecoveryAction;
      if (recoveryAction == null) {
        throw StateError('There is no recoverable storage operation.');
      }
      _setState(AuthSessionState._(phase: AuthSessionPhase.initializing));
      try {
        switch (recoveryAction) {
          case _StorageRecoveryAction.reloadCredential:
            _storageRecoveryAction = null;
            await _loadStoredCredential();
          case _StorageRecoveryAction.completeLogout:
            await _tokenStore.delete();
            _storageRecoveryAction = null;
            _failureAfterStorageRecovery = null;
            _clearMemoryCredentials();
            _setState(
              AuthSessionState._(phase: AuthSessionPhase.unauthenticated),
            );
          case _StorageRecoveryAction.completeReauthentication:
            await _tokenStore.delete();
            final failure = _failureAfterStorageRecovery;
            _storageRecoveryAction = null;
            _failureAfterStorageRecovery = null;
            _clearMemoryCredentials();
            _setState(
              AuthSessionState._(
                phase: AuthSessionPhase.reauthenticationRequired,
                failure:
                    failure ??
                    _classifier.unsafeStoredCredential(
                      'SESSION_INVALIDATED',
                      'Please sign in again.',
                    ),
              ),
            );
        }
      } catch (error) {
        _setStorageFailure(
          error,
          recoveryAction: recoveryAction,
          failureAfterRecovery: _failureAfterStorageRecovery,
        );
      }
      return;
    }

    if (!_state.canRetrySessionRestore || _refreshToken == null) {
      throw StateError('There is no safely reusable session to restore.');
    }
    _setState(AuthSessionState._(phase: AuthSessionPhase.initializing));
    try {
      await _restoreStoredSession();
    } catch (error) {
      _setState(
        AuthSessionState._(
          phase: AuthSessionPhase.recoverableFailure,
          failure: _failureFor(error, AuthEndpoint.refresh),
          canRetrySessionRestore: _refreshToken != null,
        ),
      );
    }
  }

  Future<void> discardLocalSession() async {
    if (_state.phase != AuthSessionPhase.recoverableFailure ||
        !_state.canRetrySessionRestore) {
      throw StateError('There is no recoverable session to discard.');
    }
    _setState(AuthSessionState._(phase: AuthSessionPhase.signingOut));
    _clearMemoryCredentials();
    try {
      await _tokenStore.delete();
      _storageRecoveryAction = null;
      _setState(AuthSessionState._(phase: AuthSessionPhase.unauthenticated));
    } catch (error) {
      _setStorageFailure(
        error,
        recoveryAction: _StorageRecoveryAction.completeLogout,
      );
      throw AuthSessionException(_state.failure!);
    }
  }

  Future<void> signIn(String email, String password) async {
    _ensureCanSignIn();
    _setState(AuthSessionState._(phase: AuthSessionPhase.signingIn));
    try {
      final tokens = await _repository.login(email, password);
      await _persistAndAdoptLoginTokens(tokens);
    } catch (error) {
      _setStateForOperationFailure(error, AuthEndpoint.login);
      if (error is TokenStoreException || error is TokenStoreStateException) {
        throw AuthSessionException(_failureFor(error, AuthEndpoint.login));
      }
      rethrow;
    }

    _setState(AuthSessionState._(phase: AuthSessionPhase.verifyingIdentity));
    try {
      final identity = await _retrieveIdentity();
      _setState(
        AuthSessionState._(
          phase: AuthSessionPhase.authenticated,
          identity: identity,
        ),
      );
    } catch (error) {
      await _handleRestoreFailure(error, AuthEndpoint.identity);
      rethrow;
    }
  }

  Future<void> loadIdentity() async {
    if (!_state.isAuthenticated) {
      throw StateError('Identity reload requires a verified session.');
    }

    try {
      final identity = await _retrieveIdentity();
      _setState(
        AuthSessionState._(
          phase: AuthSessionPhase.authenticated,
          identity: identity,
        ),
      );
    } catch (error) {
      final failure = _failureFor(error, AuthEndpoint.identity);
      if (failure.category == AuthFailureCategory.sessionInvalidated &&
          _state.phase != AuthSessionPhase.reauthenticationRequired) {
        await _requireReauthentication(failure);
      }
      rethrow;
    }
  }

  Future<AuthIdentity> _retrieveIdentity() async {
    final accessToken = _accessToken;
    if (accessToken == null) {
      throw const ApiFailure(401, 'AUTH_SESSION_EXPIRED', 'Session expired.');
    }

    final expiry = _accessExpiry;
    if (expiry == null || !_now().isBefore(expiry)) {
      if (_refreshToken == null) {
        throw const ApiFailure(401, 'AUTH_SESSION_EXPIRED', 'Session expired.');
      }
      await _refreshForProtectedRequest();
    }

    try {
      return await _repository.currentIdentity(_accessToken!);
    } on ApiFailure catch (failure) {
      final classification = _classifier.classify(
        failure,
        AuthEndpoint.identity,
      );
      if (classification != AuthFailureCategory.sessionInvalidated ||
          _refreshToken == null) {
        rethrow;
      }

      await _refreshAfterUnauthorized();
      return _repository.currentIdentity(_accessToken!);
    }
  }

  void _ensureCanSignIn() {
    if (_accessToken != null || _refreshToken != null) {
      throw StateError(
        'Discard or finish the existing session before signing in.',
      );
    }

    final failure = _state.failure;
    final storageBlocked =
        failure?.category == AuthFailureCategory.credentialStorage;
    final permitted = switch (_state.phase) {
      AuthSessionPhase.unauthenticated ||
      AuthSessionPhase.reauthenticationRequired => !storageBlocked,
      AuthSessionPhase.recoverableFailure => !storageBlocked,
      AuthSessionPhase.initializing ||
      AuthSessionPhase.signingIn ||
      AuthSessionPhase.verifyingIdentity ||
      AuthSessionPhase.authenticated ||
      AuthSessionPhase.signingOut => false,
    };
    if (!permitted) {
      throw StateError(
        'Sign-in is unavailable while the current session is changing.',
      );
    }
  }

  Future<void> signOut() async {
    if (!_state.isAuthenticated) {
      throw StateError('Sign-out requires an authenticated session.');
    }
    final accessToken = _accessToken;
    _setState(AuthSessionState._(phase: AuthSessionPhase.signingOut));
    Object? logoutError;
    try {
      if (accessToken != null) await _repository.logout(accessToken);
    } catch (error) {
      logoutError = error;
    }

    _clearMemoryCredentials();
    AuthSessionFailure? cleanupFailure;
    Object? cleanupError;
    try {
      await _tokenStore.delete();
      _storageRecoveryAction = null;
    } catch (error) {
      cleanupError = error;
      cleanupFailure = _classifier.credentialStorageFailure(error);
    }

    if (cleanupFailure != null) {
      _setStorageFailure(
        cleanupError!,
        recoveryAction: _StorageRecoveryAction.completeLogout,
      );
      throw AuthSessionException(cleanupFailure);
    }

    final logoutFailure = logoutError == null
        ? null
        : _failureFor(logoutError, AuthEndpoint.logout);
    _setState(
      AuthSessionState._(
        phase: AuthSessionPhase.unauthenticated,
        failure: logoutFailure,
      ),
    );
    if (logoutError != null)
      Error.throwWithStackTrace(logoutError, StackTrace.current);
  }

  Future<void> _refreshIfNeeded() async {
    if (!_state.isAuthenticated || _refreshToken == null) return;
    final expiry = _accessExpiry;
    if (_accessToken == null || expiry == null || !_now().isBefore(expiry)) {
      await _refreshForProtectedRequest();
    }
  }

  Future<void> _refreshAfterUnauthorized() => _refreshForProtectedRequest();

  Future<void> _handleProtectedFailure(ApiFailure failure) async {
    final classified = _classifier.fromApiFailure(
      failure,
      AuthEndpoint.protectedRequest,
    );
    if (classified.category == AuthFailureCategory.sessionInvalidated) {
      await _requireReauthentication(classified);
    }
  }

  Future<void> _refreshForProtectedRequest() {
    final running = _refreshFuture;
    if (running != null) return running;

    late final Future<void> observedFuture;
    observedFuture = _renewTokens()
        .then<void>(
          (_) {},
          onError: (Object error, StackTrace stackTrace) async {
            final failure = _failureFor(error, AuthEndpoint.refresh);
            if (failure.category == AuthFailureCategory.sessionInvalidated) {
              await _requireReauthentication(failure);
            } else if (failure.category ==
                AuthFailureCategory.credentialStorage) {
              _setStorageFailure(
                error,
                recoveryAction: _StorageRecoveryAction.reloadCredential,
              );
            } else if (_refreshToken == null) {
              _requireReauthenticationWithoutDeleting(
                failure.category == AuthFailureCategory.unsafeCredential
                    ? failure
                    : _classifier.rotationOutcomeUnknown(),
              );
            }
            Error.throwWithStackTrace(error, stackTrace);
          },
        )
        .whenComplete(() {
          if (identical(_refreshFuture, observedFuture)) {
            _refreshFuture = null;
          }
        });
    _refreshFuture = observedFuture;
    return observedFuture;
  }

  Future<void> _renewTokens() async {
    final refreshToken = _refreshToken;
    if (refreshToken == null) {
      throw const ApiFailure(401, 'AUTH_SESSION_EXPIRED', 'Session expired.');
    }

    try {
      await _tokenStore.markRotationPending(refreshToken);
    } catch (_) {
      _clearMemoryCredentials();
      rethrow;
    }
    _refreshToken = null;

    final AuthTokenResponse tokens;
    try {
      tokens = await _repository.refresh(refreshToken);
    } on ApiFailure catch (failure) {
      if (_isPreRotationRateLimit(failure)) {
        try {
          await _tokenStore.restoreAfterPreRotationRejection(refreshToken);
          _refreshToken = refreshToken;
        } catch (_) {
          _clearMemoryCredentials();
          rethrow;
        }
      } else {
        _clearMemoryCredentials();
      }
      rethrow;
    } catch (_) {
      _clearMemoryCredentials();
      rethrow;
    }

    if (tokens.refreshToken == refreshToken) {
      _clearMemoryCredentials();
      throw AuthSessionException(_classifier.rotationOutcomeUnknown());
    }
    try {
      await _tokenStore.commitRotation(
        previousRefreshToken: refreshToken,
        nextRefreshToken: tokens.refreshToken,
      );
    } catch (_) {
      _clearMemoryCredentials();
      rethrow;
    }
    _adoptMemoryTokens(tokens);
  }

  Future<void> _persistAndAdoptLoginTokens(AuthTokenResponse tokens) async {
    await _tokenStore.storeLoginCredential(tokens.refreshToken);
    _adoptMemoryTokens(tokens);
  }

  void _adoptMemoryTokens(AuthTokenResponse tokens) {
    _accessToken = tokens.accessToken;
    _refreshToken = tokens.refreshToken;
    final usableLifetime = tokens.expiresIn > 30
        ? tokens.expiresIn - 30
        : tokens.expiresIn;
    _accessExpiry = _now().add(Duration(seconds: usableLifetime));
  }

  bool _isPreRotationRateLimit(ApiFailure failure) =>
      failure.status == 429 && failure.code == 'RATE_LIMIT_EXCEEDED';

  Future<void> _handleRestoreFailure(
    Object error,
    AuthEndpoint endpoint,
  ) async {
    final failure = _failureFor(error, endpoint);
    if (failure.category == AuthFailureCategory.sessionInvalidated) {
      await _requireReauthentication(failure);
      return;
    }
    if (failure.category == AuthFailureCategory.credentialStorage) {
      _setStorageFailure(
        error,
        recoveryAction: _StorageRecoveryAction.reloadCredential,
      );
      return;
    }
    if (endpoint == AuthEndpoint.refresh && _refreshToken == null) {
      _requireReauthenticationWithoutDeleting(
        failure.category == AuthFailureCategory.unsafeCredential
            ? failure
            : _classifier.rotationOutcomeUnknown(),
      );
      return;
    }
    _setState(
      AuthSessionState._(
        phase: AuthSessionPhase.recoverableFailure,
        failure: failure,
        canRetrySessionRestore: _refreshToken != null,
      ),
    );
  }

  void _setStateForOperationFailure(Object error, AuthEndpoint endpoint) {
    final failure = _failureFor(error, endpoint);
    if (failure.category == AuthFailureCategory.credentialStorage) {
      _setStorageFailure(
        error,
        recoveryAction: _StorageRecoveryAction.reloadCredential,
      );
      return;
    }
    if (failure.category == AuthFailureCategory.authenticationRejected) {
      _setState(
        AuthSessionState._(
          phase: AuthSessionPhase.unauthenticated,
          failure: failure,
        ),
      );
      return;
    }
    _setState(
      AuthSessionState._(
        phase: AuthSessionPhase.recoverableFailure,
        failure: failure,
        canRetrySessionRestore: _refreshToken != null,
      ),
    );
  }

  AuthSessionFailure _failureFor(Object error, AuthEndpoint endpoint) {
    if (error is AuthSessionException) return error.failure;
    if (error is TokenStoreStateException) {
      return _classifier.unsafeStoredCredential(
        'STORED_CREDENTIAL_UNSAFE',
        'The saved session cannot be safely used. Please sign in again.',
      );
    }
    if (error is ApiFailure) {
      return _classifier.fromApiFailure(error, endpoint);
    }
    if (error is TokenStoreException) {
      return _classifier.credentialStorageFailure(error);
    }
    return AuthSessionFailure._(
      category: AuthFailureCategory.unexpected,
      message: 'Authentication could not be completed.',
      code: 'UNEXPECTED_AUTH_FAILURE',
    );
  }

  Future<void> _requireReauthentication(AuthSessionFailure failure) async {
    if (_state.phase == AuthSessionPhase.reauthenticationRequired &&
        _accessToken == null &&
        _refreshToken == null) {
      return;
    }
    _setState(AuthSessionState._(phase: AuthSessionPhase.signingOut));
    _clearMemoryCredentials();
    try {
      await _tokenStore.delete();
      _storageRecoveryAction = null;
    } catch (error) {
      _failureAfterStorageRecovery = failure;
      _setStorageFailure(
        error,
        recoveryAction: _StorageRecoveryAction.completeReauthentication,
        failureAfterRecovery: failure,
      );
      return;
    }
    _setState(
      AuthSessionState._(
        phase: AuthSessionPhase.reauthenticationRequired,
        failure: failure,
      ),
    );
  }

  void _requireReauthenticationWithoutDeleting(AuthSessionFailure failure) {
    _setState(AuthSessionState._(phase: AuthSessionPhase.signingOut));
    _clearMemoryCredentials();
    _setState(
      AuthSessionState._(
        phase: AuthSessionPhase.reauthenticationRequired,
        failure: failure,
      ),
    );
  }

  void _requireReauthenticationForUnsafeCredential(
    String code,
    String message,
  ) {
    _clearMemoryCredentials();
    _setState(
      AuthSessionState._(
        phase: AuthSessionPhase.reauthenticationRequired,
        failure: _classifier.unsafeStoredCredential(code, message),
      ),
    );
  }

  void _setStorageFailure(
    Object error, {
    required _StorageRecoveryAction recoveryAction,
    AuthSessionFailure? failureAfterRecovery,
  }) {
    _clearMemoryCredentials();
    _storageRecoveryAction = recoveryAction;
    _failureAfterStorageRecovery = failureAfterRecovery;
    _setState(
      AuthSessionState._(
        phase: AuthSessionPhase.recoverableFailure,
        failure: _classifier.credentialStorageFailure(error),
        canRetryCredentialStorage: true,
      ),
    );
  }

  void _clearMemoryCredentials() {
    _accessToken = null;
    _refreshToken = null;
    _accessExpiry = null;
  }

  void _setState(AuthSessionState next) {
    _state = next;
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _clearMemoryCredentials();
    super.dispose();
  }
}
