part of 'api_client.dart';

@immutable
class _SessionCredentialSnapshot {
  const _SessionCredentialSnapshot({
    required this.accessToken,
    required this.generation,
    required this.epoch,
  });

  final String accessToken;
  final int generation;
  final int epoch;

  String get authorization => 'Bearer $accessToken';
}

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
    this.canRetryIdentityVerification = false,
    this.canRetryCredentialStorage = false,
    this.retryNotBefore,
  }) {
    if ((phase == AuthSessionPhase.authenticated) != (identity != null) ||
        identity != null && !identity!.isEligibleMobileIdentity ||
        canRetrySessionRestore &&
            (phase != AuthSessionPhase.recoverableFailure ||
                failure?.category == AuthFailureCategory.credentialStorage) ||
        canRetryIdentityVerification &&
            phase != AuthSessionPhase.recoverableFailure ||
        canRetryCredentialStorage &&
            (phase != AuthSessionPhase.recoverableFailure ||
                failure?.category != AuthFailureCategory.credentialStorage) ||
        retryNotBefore != null &&
            failure?.category != AuthFailureCategory.rateLimited) {
      throw StateError('Invalid authentication session state.');
    }
  }

  final AuthSessionPhase phase;
  final AuthIdentity? identity;
  final AuthSessionFailure? failure;
  final bool canRetrySessionRestore;
  final bool canRetryIdentityVerification;
  final bool canRetryCredentialStorage;
  final DateTime? retryNotBefore;

  bool get isAuthenticated => phase == AuthSessionPhase.authenticated;
  bool get isInitializing => phase == AuthSessionPhase.initializing;
  String? get sessionRestoreError =>
      canRetrySessionRestore || canRetryIdentityVerification
      ? failure?.message
      : null;
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
  int? _refreshEpoch;
  Object? _lastRefreshError;
  int? _lastRefreshErrorEpoch;
  int? _lastRefreshErrorGeneration;
  DateTime? _lastRefreshRetryNotBefore;
  int _lifecycleEpoch = 0;
  int _accessGeneration = 0;
  Future<void> _tokenStoreTail = Future<void>.value();
  bool _disposed = false;
  _StorageRecoveryAction? _storageRecoveryAction;
  AuthSessionFailure? _failureAfterStorageRecovery;

  AuthSessionState get state => _state;

  bool _isCurrentEpoch(int epoch) => !_disposed && _lifecycleEpoch == epoch;

  AuthSessionException _sessionChanged() => AuthSessionException(
    AuthSessionFailure._(
      category: AuthFailureCategory.sessionInvalidated,
      message: 'The authentication session changed. Please try again.',
      code: 'AUTH_SESSION_CHANGED',
    ),
  );

  void _requireCurrentEpoch(int epoch) {
    if (!_isCurrentEpoch(epoch)) throw _sessionChanged();
  }

  Future<T> _withTokenStoreLock<T>(Future<T> Function() action) async {
    final previous = _tokenStoreTail;
    final release = Completer<void>();
    _tokenStoreTail = release.future;
    await previous;
    try {
      return await action();
    } finally {
      release.complete();
    }
  }

  Future<void> initialize() async {
    if (_state.phase != AuthSessionPhase.initializing) return;

    await _loadStoredCredential();
  }

  Future<void> _loadStoredCredential() async {
    final epoch = _lifecycleEpoch;
    final TokenStoreReadResult stored;
    try {
      stored = await _withTokenStoreLock(_tokenStore.read);
    } catch (error) {
      if (!_isCurrentEpoch(epoch)) return;
      _setStorageFailure(
        error,
        recoveryAction: _StorageRecoveryAction.reloadCredential,
        expectedEpoch: epoch,
      );
      return;
    }
    if (!_isCurrentEpoch(epoch)) return;

    switch (stored.state) {
      case TokenStoreCredentialState.missing:
        _clearMemoryCredentials();
        _setState(AuthSessionState._(phase: AuthSessionPhase.unauthenticated));
      case TokenStoreCredentialState.legacyRetired:
        _requireReauthenticationForUnsafeCredential(
          'LEGACY_CREDENTIAL_RETIRED',
          'Thông tin đăng nhập cũ đã được gỡ bỏ. Vui lòng đăng nhập lại cho máy chủ hiện tại.',
        );
      case TokenStoreCredentialState.committed:
        _refreshToken = stored.refreshToken;
        try {
          await _restoreStoredSession(epoch);
        } catch (error) {
          if (!_isCurrentEpoch(epoch)) return;
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
          'Phiên đã bị gián đoạn khi gia hạn nên không thể dùng lại an toàn. Vui lòng đăng nhập lại.',
        );
      case TokenStoreCredentialState.malformed ||
          TokenStoreCredentialState.unsupportedVersion ||
          TokenStoreCredentialState.wrongDeployment ||
          TokenStoreCredentialState.invalidCredential:
        _requireReauthenticationForUnsafeCredential(
          'STORED_CREDENTIAL_UNUSABLE',
          'Phiên đã lưu không thể được sử dụng an toàn. Vui lòng đăng nhập lại.',
        );
    }
  }

  Future<void> _restoreStoredSession(int epoch) async {
    _requireCurrentEpoch(epoch);
    _setState(AuthSessionState._(phase: AuthSessionPhase.verifyingIdentity));
    try {
      await _refreshForProtectedRequest(epoch);
    } catch (error) {
      await _handleRestoreFailure(error, AuthEndpoint.refresh, epoch);
      return;
    }

    try {
      final identity = await _retrieveIdentity(expectedEpoch: epoch);
      if (!_isCurrentEpoch(epoch)) return;
      _setState(
        AuthSessionState._(
          phase: AuthSessionPhase.authenticated,
          identity: identity,
        ),
      );
    } catch (error) {
      await _handleRestoreFailure(error, AuthEndpoint.identity, epoch);
    }
  }

  Future<void> retrySessionRestore() async {
    if (_state.canRetryIdentityVerification) {
      await retryIdentityVerification();
      return;
    }
    if (_state.phase != AuthSessionPhase.recoverableFailure ||
        (!_state.canRetrySessionRestore && !_state.canRetryCredentialStorage)) {
      throw StateError('There is no recoverable session to restore.');
    }

    if (_state.canRetryCredentialStorage) {
      final epoch = _lifecycleEpoch;
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
            await _withTokenStoreLock(() async {
              _requireCurrentEpoch(epoch);
              await _tokenStore.delete();
            });
            if (!_isCurrentEpoch(epoch)) return;
            _storageRecoveryAction = null;
            _failureAfterStorageRecovery = null;
            _clearMemoryCredentials();
            _setState(
              AuthSessionState._(phase: AuthSessionPhase.unauthenticated),
            );
          case _StorageRecoveryAction.completeReauthentication:
            await _withTokenStoreLock(() async {
              _requireCurrentEpoch(epoch);
              await _tokenStore.delete();
            });
            if (!_isCurrentEpoch(epoch)) return;
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
                      'Phiên đăng nhập đã hết hiệu lực. Vui lòng đăng nhập lại.',
                    ),
              ),
            );
        }
      } catch (error) {
        if (!_isCurrentEpoch(epoch)) return;
        _setStorageFailure(
          error,
          recoveryAction: recoveryAction,
          failureAfterRecovery: _failureAfterStorageRecovery,
          expectedEpoch: epoch,
        );
      }
      return;
    }

    if (!_state.canRetrySessionRestore || _refreshToken == null) {
      throw StateError('There is no safely reusable session to restore.');
    }
    _ensureRetryWindowOpen();
    final epoch = _lifecycleEpoch;
    _setState(AuthSessionState._(phase: AuthSessionPhase.initializing));
    try {
      await _restoreStoredSession(epoch);
    } catch (error) {
      if (!_isCurrentEpoch(epoch)) return;
      _setState(
        AuthSessionState._(
          phase: AuthSessionPhase.recoverableFailure,
          failure: _failureFor(error, AuthEndpoint.refresh),
          canRetrySessionRestore: _refreshToken != null,
        ),
      );
    }
  }

  Future<void> retryIdentityVerification() async {
    if (_state.phase != AuthSessionPhase.recoverableFailure ||
        !_state.canRetryIdentityVerification ||
        _accessToken == null) {
      throw StateError('There is no identity verification to retry.');
    }
    _ensureRetryWindowOpen();
    final epoch = _lifecycleEpoch;
    _setState(AuthSessionState._(phase: AuthSessionPhase.verifyingIdentity));
    try {
      final identity = await _retrieveIdentity(expectedEpoch: epoch);
      if (!_isCurrentEpoch(epoch)) return;
      _setState(
        AuthSessionState._(
          phase: AuthSessionPhase.authenticated,
          identity: identity,
        ),
      );
    } catch (error) {
      await _handleRestoreFailure(error, AuthEndpoint.identity, epoch);
    }
  }

  Future<void> discardLocalSession() async {
    if (_state.phase != AuthSessionPhase.recoverableFailure ||
        (!_state.canRetrySessionRestore &&
            !_state.canRetryIdentityVerification)) {
      throw StateError('There is no recoverable session to discard.');
    }
    final epoch = ++_lifecycleEpoch;
    _clearMemoryCredentials();
    _setState(AuthSessionState._(phase: AuthSessionPhase.signingOut));
    try {
      await _withTokenStoreLock(() async {
        _requireCurrentEpoch(epoch);
        await _tokenStore.delete();
      });
      if (!_isCurrentEpoch(epoch)) return;
      _storageRecoveryAction = null;
      _setState(AuthSessionState._(phase: AuthSessionPhase.unauthenticated));
    } catch (error) {
      if (!_isCurrentEpoch(epoch)) return;
      _setStorageFailure(
        error,
        recoveryAction: _StorageRecoveryAction.completeLogout,
        expectedEpoch: epoch,
      );
      throw AuthSessionException(_state.failure!);
    }
  }

  Future<void> signIn(String email, String password) async {
    _ensureCanSignIn();
    _ensureRetryWindowOpen();
    final epoch = ++_lifecycleEpoch;
    _setState(AuthSessionState._(phase: AuthSessionPhase.signingIn));
    try {
      final tokens = await _repository.login(email, password);
      _requireCurrentEpoch(epoch);
      await _persistAndAdoptLoginTokens(tokens, epoch);
    } catch (error) {
      if (!_isCurrentEpoch(epoch)) throw _sessionChanged();
      _setStateForOperationFailure(
        error,
        AuthEndpoint.login,
        expectedEpoch: epoch,
      );
      if (error is TokenStoreException || error is TokenStoreStateException) {
        throw AuthSessionException(_failureFor(error, AuthEndpoint.login));
      }
      rethrow;
    }

    _setState(AuthSessionState._(phase: AuthSessionPhase.verifyingIdentity));
    try {
      final identity = await _retrieveIdentity(expectedEpoch: epoch);
      _requireCurrentEpoch(epoch);
      _setState(
        AuthSessionState._(
          phase: AuthSessionPhase.authenticated,
          identity: identity,
        ),
      );
    } catch (error) {
      await _handleRestoreFailure(error, AuthEndpoint.identity, epoch);
      rethrow;
    }
  }

  Future<void> loadIdentity() async {
    if (!_state.isAuthenticated) {
      throw StateError('Identity reload requires a verified session.');
    }

    final epoch = _lifecycleEpoch;
    final identity = await _retrieveIdentity(expectedEpoch: epoch);
    _requireCurrentEpoch(epoch);
    _setState(
      AuthSessionState._(
        phase: AuthSessionPhase.authenticated,
        identity: identity,
      ),
    );
  }

  Future<AuthIdentity> _retrieveIdentity({required int expectedEpoch}) async {
    final credential = _credentialForDispatch(
      await _credentialForIdentity(expectedEpoch: expectedEpoch),
      requireVerifiedSession: false,
    );
    try {
      return await _repository.currentIdentity(credential.accessToken);
    } on ApiFailure catch (failure) {
      final classification = _classifier.classify(
        failure,
        AuthEndpoint.identity,
      );
      if (classification != AuthFailureCategory.sessionInvalidated ||
          !_isCurrentEpoch(expectedEpoch)) {
        rethrow;
      }

      final current = _snapshotForEpoch(expectedEpoch);
      if (current == null) rethrow;
      final retryCandidate = current.generation > credential.generation
          ? current
          : await _recoverAfterUnauthorized(
              expectedEpoch: expectedEpoch,
              usedGeneration: credential.generation,
            );
      final retryCredential = _credentialForDispatch(
        retryCandidate,
        requireVerifiedSession: false,
      );
      try {
        return await _repository.currentIdentity(retryCredential.accessToken);
      } on ApiFailure catch (retryFailure) {
        if (_classifier.classify(retryFailure, AuthEndpoint.identity) ==
            AuthFailureCategory.sessionInvalidated) {
          await _handleProtectedFailure(
            retryFailure,
            expectedEpoch: expectedEpoch,
            usedGeneration: retryCredential.generation,
          );
        }
        rethrow;
      }
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
    final epoch = ++_lifecycleEpoch;
    _clearMemoryCredentials();
    _setState(AuthSessionState._(phase: AuthSessionPhase.signingOut));
    Object? logoutError;
    try {
      if (accessToken != null) await _repository.logout(accessToken);
    } catch (error) {
      logoutError = error;
    }

    AuthSessionFailure? cleanupFailure;
    Object? cleanupError;
    try {
      await _withTokenStoreLock(_tokenStore.delete);
      _storageRecoveryAction = null;
    } catch (error) {
      cleanupError = error;
      cleanupFailure = _classifier.credentialStorageFailure(error);
    }

    if (cleanupFailure != null) {
      _setStorageFailure(
        cleanupError!,
        recoveryAction: _StorageRecoveryAction.completeLogout,
        expectedEpoch: epoch,
      );
      throw AuthSessionException(cleanupFailure);
    }

    if (!_isCurrentEpoch(epoch)) {
      if (logoutError != null) {
        Error.throwWithStackTrace(logoutError, StackTrace.current);
      }
      return;
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

  Future<_SessionCredentialSnapshot> _credentialForProtectedRequest({
    required int expectedEpoch,
  }) async {
    _requireCurrentEpoch(expectedEpoch);
    if (!_state.isAuthenticated) {
      throw const ApiFailure(
        401,
        'AUTH_SESSION_REQUIRED',
        'A verified session is required.',
      );
    }
    await _refreshIfNeeded(expectedEpoch);
    _requireCurrentEpoch(expectedEpoch);
    if (!_state.isAuthenticated) throw _sessionChanged();
    final snapshot = _snapshotForEpoch(expectedEpoch);
    if (snapshot == null) throw _sessionChanged();
    return snapshot;
  }

  Future<_SessionCredentialSnapshot> _credentialForIdentity({
    required int expectedEpoch,
  }) async {
    _requireCurrentEpoch(expectedEpoch);
    if (_state.phase != AuthSessionPhase.authenticated &&
        _state.phase != AuthSessionPhase.verifyingIdentity) {
      throw _sessionChanged();
    }
    await _refreshIfNeeded(expectedEpoch);
    _requireCurrentEpoch(expectedEpoch);
    final snapshot = _snapshotForEpoch(expectedEpoch);
    if (snapshot == null) throw _sessionChanged();
    return snapshot;
  }

  _SessionCredentialSnapshot? _snapshotForEpoch(int epoch) {
    if (!_isCurrentEpoch(epoch) ||
        (_state.phase != AuthSessionPhase.authenticated &&
            _state.phase != AuthSessionPhase.verifyingIdentity) ||
        _accessToken == null) {
      return null;
    }
    return _SessionCredentialSnapshot(
      accessToken: _accessToken!,
      generation: _accessGeneration,
      epoch: epoch,
    );
  }

  _SessionCredentialSnapshot _credentialForDispatch(
    _SessionCredentialSnapshot snapshot, {
    required bool requireVerifiedSession,
  }) {
    _requireCurrentEpoch(snapshot.epoch);
    if (requireVerifiedSession && !_state.isAuthenticated) {
      throw _sessionChanged();
    }
    final current = _snapshotForEpoch(snapshot.epoch);
    if (current == null) throw _sessionChanged();
    return current.generation >= snapshot.generation ? current : snapshot;
  }

  Future<void> _refreshIfNeeded(int epoch) async {
    _requireCurrentEpoch(epoch);
    final expiry = _accessExpiry;
    if (_accessToken == null || expiry == null || !_now().isBefore(expiry)) {
      await _refreshForProtectedRequest(epoch);
    }
  }

  Future<_SessionCredentialSnapshot> _recoverAfterUnauthorized({
    required int expectedEpoch,
    required int usedGeneration,
  }) async {
    _requireCurrentEpoch(expectedEpoch);
    final current = _snapshotForEpoch(expectedEpoch);
    if (current == null) throw _sessionChanged();
    if (current.generation > usedGeneration) return current;

    await _refreshForProtectedRequest(expectedEpoch);
    _requireCurrentEpoch(expectedEpoch);
    final refreshed = _snapshotForEpoch(expectedEpoch);
    if (refreshed == null || refreshed.generation <= usedGeneration) {
      throw _sessionChanged();
    }
    return refreshed;
  }

  Future<void> _handleProtectedFailure(
    ApiFailure failure, {
    required int expectedEpoch,
    required int usedGeneration,
  }) async {
    final classified = _classifier.fromApiFailure(
      failure,
      AuthEndpoint.protectedRequest,
    );
    if (classified.category == AuthFailureCategory.sessionInvalidated &&
        _isCurrentEpoch(expectedEpoch) &&
        _accessGeneration == usedGeneration) {
      await _requireReauthentication(classified, expectedEpoch: expectedEpoch);
    }
  }

  Future<void> _refreshForProtectedRequest(int expectedEpoch) {
    if (!_isCurrentEpoch(expectedEpoch)) {
      return Future<void>.error(_sessionChanged());
    }
    final running = _refreshFuture;
    if (running != null && _refreshEpoch == expectedEpoch) return running;
    if (_refreshToken == null) return Future<void>.error(_sessionChanged());
    if (_lastRefreshError != null &&
        _lastRefreshErrorEpoch == expectedEpoch &&
        _lastRefreshErrorGeneration == _accessGeneration) {
      final retryNotBefore = _lastRefreshRetryNotBefore;
      if (retryNotBefore != null && _now().isBefore(retryNotBefore)) {
        return Future<void>.error(_lastRefreshError!);
      }
      _clearLastRefreshError();
    }
    try {
      _ensureRetryWindowOpen();
    } on AuthSessionException catch (error) {
      return Future<void>.error(error);
    }

    late final Future<void> observedFuture;
    final refreshGeneration = _accessGeneration;
    observedFuture = _renewTokens(expectedEpoch)
        .then<void>(
          (_) {},
          onError: (Object error, StackTrace stackTrace) async {
            if (!_isCurrentEpoch(expectedEpoch)) {
              Error.throwWithStackTrace(_sessionChanged(), stackTrace);
            }
            final failure = _failureFor(error, AuthEndpoint.refresh);
            if (failure.category == AuthFailureCategory.rateLimited &&
                _refreshToken != null) {
              _lastRefreshError = error;
              _lastRefreshErrorEpoch = expectedEpoch;
              _lastRefreshErrorGeneration = refreshGeneration;
              _lastRefreshRetryNotBefore = _retryDeadline(failure);
            }
            if (failure.category == AuthFailureCategory.sessionInvalidated) {
              await _requireReauthentication(
                failure,
                expectedEpoch: expectedEpoch,
              );
            } else if (failure.category ==
                AuthFailureCategory.credentialStorage) {
              _setStorageFailure(
                error,
                recoveryAction: _StorageRecoveryAction.reloadCredential,
                expectedEpoch: expectedEpoch,
              );
            } else if (failure.category == AuthFailureCategory.rateLimited &&
                _state.isAuthenticated &&
                _state.identity != null) {
              _setState(
                AuthSessionState._(
                  phase: AuthSessionPhase.authenticated,
                  identity: _state.identity,
                  failure: failure,
                  retryNotBefore: _retryDeadline(failure),
                ),
              );
            } else if (_refreshToken == null) {
              final terminalFailure =
                  failure.category == AuthFailureCategory.authorizationDenied ||
                      failure.category ==
                          AuthFailureCategory.unsafeCredential ||
                      failure.category ==
                          AuthFailureCategory.rotationOutcomeUnknown
                  ? failure
                  : _classifier.rotationOutcomeUnknown(cause: failure);
              _requireReauthenticationWithoutDeleting(
                terminalFailure,
                expectedEpoch: expectedEpoch,
              );
            }
            Error.throwWithStackTrace(error, stackTrace);
          },
        )
        .whenComplete(() {
          if (identical(_refreshFuture, observedFuture)) {
            _refreshFuture = null;
            _refreshEpoch = null;
          }
        });
    _refreshFuture = observedFuture;
    _refreshEpoch = expectedEpoch;
    return observedFuture;
  }

  Future<void> _renewTokens(int expectedEpoch) async {
    _requireCurrentEpoch(expectedEpoch);
    final refreshToken = _refreshToken;
    if (refreshToken == null) {
      throw const ApiFailure(401, 'AUTH_SESSION_EXPIRED', 'Session expired.');
    }

    try {
      await _withTokenStoreLock(() async {
        _requireCurrentEpoch(expectedEpoch);
        await _tokenStore.markRotationPending(refreshToken);
      });
    } catch (_) {
      if (!_isCurrentEpoch(expectedEpoch)) throw _sessionChanged();
      _clearMemoryCredentials();
      rethrow;
    }
    _requireCurrentEpoch(expectedEpoch);
    _refreshToken = null;

    final AuthTokenResponse tokens;
    try {
      tokens = await _repository.refresh(refreshToken);
    } on ApiFailure catch (failure) {
      _requireCurrentEpoch(expectedEpoch);
      if (_isPreRotationRateLimit(failure)) {
        try {
          await _withTokenStoreLock(() async {
            _requireCurrentEpoch(expectedEpoch);
            await _tokenStore.restoreAfterPreRotationRejection(refreshToken);
          });
          _requireCurrentEpoch(expectedEpoch);
          _refreshToken = refreshToken;
        } catch (_) {
          if (!_isCurrentEpoch(expectedEpoch)) throw _sessionChanged();
          _clearMemoryCredentials();
          rethrow;
        }
      } else {
        _clearMemoryCredentials();
        final category = _classifier.classify(failure, AuthEndpoint.refresh);
        if (category == AuthFailureCategory.sessionInvalidated ||
            category == AuthFailureCategory.authorizationDenied) {
          rethrow;
        }
        throw AuthSessionException(
          _classifier.rotationOutcomeUnknown(
            cause: _failureFor(failure, AuthEndpoint.refresh),
          ),
        );
      }
      rethrow;
    } catch (error) {
      _requireCurrentEpoch(expectedEpoch);
      _clearMemoryCredentials();
      throw AuthSessionException(
        _classifier.rotationOutcomeUnknown(
          cause: _failureFor(error, AuthEndpoint.refresh),
        ),
      );
    }

    if (tokens.refreshToken == refreshToken) {
      _clearMemoryCredentials();
      throw AuthSessionException(_classifier.rotationOutcomeUnknown());
    }
    try {
      await _withTokenStoreLock(() async {
        _requireCurrentEpoch(expectedEpoch);
        await _tokenStore.commitRotation(
          previousRefreshToken: refreshToken,
          nextRefreshToken: tokens.refreshToken,
        );
        _requireCurrentEpoch(expectedEpoch);
      });
    } catch (_) {
      if (!_isCurrentEpoch(expectedEpoch)) throw _sessionChanged();
      _clearMemoryCredentials();
      rethrow;
    }
    _adoptMemoryTokens(tokens, expectedEpoch);
  }

  Future<void> _persistAndAdoptLoginTokens(
    AuthTokenResponse tokens,
    int expectedEpoch,
  ) async {
    await _withTokenStoreLock(() async {
      _requireCurrentEpoch(expectedEpoch);
      await _tokenStore.storeLoginCredential(tokens.refreshToken);
      if (!_isCurrentEpoch(expectedEpoch)) {
        await _tokenStore.delete();
        throw _sessionChanged();
      }
    });
    _adoptMemoryTokens(tokens, expectedEpoch);
  }

  void _adoptMemoryTokens(AuthTokenResponse tokens, int expectedEpoch) {
    _requireCurrentEpoch(expectedEpoch);
    _accessToken = tokens.accessToken;
    _refreshToken = tokens.refreshToken;
    _accessGeneration++;
    _clearLastRefreshError();
    final usableLifetime = tokens.expiresIn > 30
        ? tokens.expiresIn - 30
        : tokens.expiresIn;
    _accessExpiry = _now().add(Duration(seconds: usableLifetime));
    if (_state.isAuthenticated &&
        _state.failure?.category == AuthFailureCategory.rateLimited) {
      _setState(
        AuthSessionState._(
          phase: AuthSessionPhase.authenticated,
          identity: _state.identity,
        ),
      );
    }
  }

  void _clearLastRefreshError() {
    _lastRefreshError = null;
    _lastRefreshErrorEpoch = null;
    _lastRefreshErrorGeneration = null;
    _lastRefreshRetryNotBefore = null;
  }

  bool _isPreRotationRateLimit(ApiFailure failure) =>
      failure.status == 429 && failure.code == 'RATE_LIMIT_EXCEEDED';

  Future<void> _handleRestoreFailure(
    Object error,
    AuthEndpoint endpoint,
    int expectedEpoch,
  ) async {
    if (!_isCurrentEpoch(expectedEpoch)) return;
    final failure = _failureFor(error, endpoint);
    if (failure.category == AuthFailureCategory.sessionInvalidated) {
      await _requireReauthentication(failure, expectedEpoch: expectedEpoch);
      return;
    }
    if (failure.category == AuthFailureCategory.authorizationDenied) {
      _requireReauthenticationWithoutDeleting(
        failure,
        expectedEpoch: expectedEpoch,
      );
      return;
    }
    if (failure.category == AuthFailureCategory.credentialStorage) {
      _setStorageFailure(
        error,
        recoveryAction: _StorageRecoveryAction.reloadCredential,
        expectedEpoch: expectedEpoch,
      );
      return;
    }
    if (failure.category == AuthFailureCategory.rotationOutcomeUnknown ||
        failure.category == AuthFailureCategory.unsafeCredential) {
      _requireReauthenticationWithoutDeleting(
        failure,
        expectedEpoch: expectedEpoch,
      );
      return;
    }
    if (endpoint == AuthEndpoint.refresh && _refreshToken == null) {
      _requireReauthenticationWithoutDeleting(
        failure.category == AuthFailureCategory.unsafeCredential
            ? failure
            : _classifier.rotationOutcomeUnknown(cause: failure),
        expectedEpoch: expectedEpoch,
      );
      return;
    }
    _setState(
      AuthSessionState._(
        phase: AuthSessionPhase.recoverableFailure,
        failure: failure,
        canRetrySessionRestore:
            endpoint == AuthEndpoint.refresh && _refreshToken != null,
        canRetryIdentityVerification:
            endpoint == AuthEndpoint.identity && _accessToken != null,
        retryNotBefore: _retryDeadline(failure),
      ),
    );
  }

  void _setStateForOperationFailure(
    Object error,
    AuthEndpoint endpoint, {
    required int expectedEpoch,
  }) {
    if (!_isCurrentEpoch(expectedEpoch)) return;
    final failure = _failureFor(error, endpoint);
    if (failure.category == AuthFailureCategory.credentialStorage) {
      _setStorageFailure(
        error,
        recoveryAction: _StorageRecoveryAction.reloadCredential,
        expectedEpoch: expectedEpoch,
      );
      return;
    }
    if (failure.category == AuthFailureCategory.authenticationRejected) {
      _setState(
        AuthSessionState._(
          phase: AuthSessionPhase.unauthenticated,
          failure: failure,
          retryNotBefore: _retryDeadline(failure),
        ),
      );
      return;
    }
    _setState(
      AuthSessionState._(
        phase: AuthSessionPhase.recoverableFailure,
        failure: failure,
        canRetrySessionRestore: _refreshToken != null,
        retryNotBefore: _retryDeadline(failure),
      ),
    );
  }

  AuthSessionFailure _failureFor(Object error, AuthEndpoint endpoint) {
    if (error is AuthSessionException) return error.failure;
    if (error is TokenStoreStateException) {
      return _classifier.unsafeStoredCredential(
        'STORED_CREDENTIAL_UNSAFE',
        'Phiên đã lưu không thể được sử dụng an toàn. Vui lòng đăng nhập lại.',
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
      message: 'Không thể hoàn tất thao tác xác thực. Vui lòng thử lại.',
      code: 'UNEXPECTED_AUTH_FAILURE',
    );
  }

  Future<void> _requireReauthentication(
    AuthSessionFailure failure, {
    required int expectedEpoch,
  }) async {
    if (!_isCurrentEpoch(expectedEpoch)) return;
    if (_state.phase == AuthSessionPhase.reauthenticationRequired &&
        _accessToken == null &&
        _refreshToken == null) {
      return;
    }
    final invalidatedEpoch = ++_lifecycleEpoch;
    _clearMemoryCredentials();
    _setState(AuthSessionState._(phase: AuthSessionPhase.signingOut));
    try {
      await _withTokenStoreLock(_tokenStore.delete);
      _storageRecoveryAction = null;
    } catch (error) {
      _failureAfterStorageRecovery = failure;
      _setStorageFailure(
        error,
        recoveryAction: _StorageRecoveryAction.completeReauthentication,
        failureAfterRecovery: failure,
        expectedEpoch: invalidatedEpoch,
      );
      return;
    }
    if (!_isCurrentEpoch(invalidatedEpoch)) return;
    _setState(
      AuthSessionState._(
        phase: AuthSessionPhase.reauthenticationRequired,
        failure: failure,
      ),
    );
  }

  void _requireReauthenticationWithoutDeleting(
    AuthSessionFailure failure, {
    required int expectedEpoch,
  }) {
    if (!_isCurrentEpoch(expectedEpoch)) return;
    ++_lifecycleEpoch;
    _clearMemoryCredentials();
    _setState(AuthSessionState._(phase: AuthSessionPhase.signingOut));
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
    ++_lifecycleEpoch;
    _clearMemoryCredentials();
    _setState(
      AuthSessionState._(
        phase: AuthSessionPhase.reauthenticationRequired,
        failure: _classifier.unsafeStoredCredential(code, message),
      ),
    );
  }

  DateTime? _retryDeadline(AuthSessionFailure failure) {
    if (failure.category != AuthFailureCategory.rateLimited) return null;
    final now = _now();
    final delay = failure.apiFailure?.retryAfterDuration(now: now);
    return delay == null ? null : now.add(delay);
  }

  void _ensureRetryWindowOpen() {
    final retryNotBefore = _state.retryNotBefore;
    if (retryNotBefore != null && _now().isBefore(retryNotBefore)) {
      final failure = _state.failure;
      if (failure != null) throw AuthSessionException(failure);
    }
  }

  void _setStorageFailure(
    Object error, {
    required _StorageRecoveryAction recoveryAction,
    AuthSessionFailure? failureAfterRecovery,
    int? expectedEpoch,
  }) {
    if (expectedEpoch != null && !_isCurrentEpoch(expectedEpoch)) return;
    ++_lifecycleEpoch;
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
    _clearLastRefreshError();
  }

  void _setState(AuthSessionState next) {
    if (_disposed) return;
    _state = next;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    ++_lifecycleEpoch;
    _clearMemoryCredentials();
    super.dispose();
  }
}
