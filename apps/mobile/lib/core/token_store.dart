import 'dart:convert';

import 'package:crypto/crypto.dart';

import 'credential_storage.dart';

enum TokenStoreOperation { read, write, delete }

enum TokenStoreCredentialState {
  missing,
  committed,
  rotationPending,
  logoutPending,
  logoutIntentUnusable,
  malformed,
  unsupportedVersion,
  wrongDeployment,
  invalidCredential,
  legacyRetired,
}

/// Non-secret diagnosis for a record that cannot safely be used.
class TokenStoreReadResult {
  const TokenStoreReadResult._(this.state, {this.refreshToken});

  final TokenStoreCredentialState state;

  /// Present only for a validated committed record.
  final String? refreshToken;

  bool get isUsable => state == TokenStoreCredentialState.committed;
}

/// A safe wrapper that identifies the failed operation without retaining
/// platform exception text or credential values.
class TokenStoreException implements Exception {
  const TokenStoreException(this.operation);

  final TokenStoreOperation operation;

  @override
  String toString() => 'Secure token storage ${operation.name} failed.';
}

/// Indicates a durable record transition that cannot safely be completed.
class TokenStoreStateException implements Exception {
  const TokenStoreStateException();

  @override
  String toString() => 'The stored token state is not safe to use.';
}

/// Durable, deployment-scoped refresh-token records over OS secure storage.
///
/// This class owns only persisted credential records. In-memory credentials,
/// session decisions, and all authentication network operations remain owned
/// by [AuthSessionCoordinator] and [AuthRepository], respectively.
class TokenStore {
  TokenStore({required CredentialStorage storage, required Uri baseUri})
    : this._(storage, baseUri);

  TokenStore._(this._storage, Uri baseUri)
    : _scopeDigest = _digest(_deploymentIdentity(baseUri));

  static const String legacyStorageKey = 'sme.mobile.refresh';
  static const int recordVersion = 1;
  static const String _keyPrefix = 'sme.mobile.token.v1.';
  static const String _logoutIntentKeyPrefix = 'sme.mobile.logout.v1.';

  static final RegExp _refreshTokenPattern = RegExp(r'^[A-Za-z0-9_-]+$');

  final CredentialStorage _storage;
  final String _scopeDigest;

  String get scopeDigest => _scopeDigest;
  String get storageKey => '$_keyPrefix$_scopeDigest';
  String get logoutIntentStorageKey => '$_logoutIntentKeyPrefix$_scopeDigest';

  Future<TokenStoreReadResult> read() async {
    final logoutIntent = await _readLogoutIntentState();
    if (logoutIntent != null) return TokenStoreReadResult._(logoutIntent);

    final retiredLegacy = await _retireLegacyCredential();
    final record = await _readScopedRecord();
    if (record.state == TokenStoreCredentialState.missing && retiredLegacy) {
      return const TokenStoreReadResult._(
        TokenStoreCredentialState.legacyRetired,
      );
    }
    if (record.state == TokenStoreCredentialState.committed) {
      return TokenStoreReadResult._(
        TokenStoreCredentialState.committed,
        refreshToken: record.refreshToken,
      );
    }
    return TokenStoreReadResult._(record.state);
  }

  /// Persists a validated login credential as a committed record.
  Future<void> storeLoginCredential(String refreshToken) async {
    _validateRefreshToken(refreshToken);
    await _retireLegacyCredential();
    await _requireNoLogoutIntent();
    await _writeRecord(state: 'committed', refreshToken: refreshToken);
  }

  /// Durably marks this deployment as terminating before credential cleanup.
  ///
  /// The tombstone contains only its version, state, and deployment scope. It
  /// intentionally has no credential payload and takes precedence over every
  /// refresh-token record during startup.
  Future<void> persistLogoutIntent() async {
    final value = jsonEncode(<String, Object>{
      'version': recordVersion,
      'state': 'logoutPending',
      'scope': _scopeDigest,
    });
    try {
      await _storage.write(key: logoutIntentStorageKey, value: value);
      await _storage.confirmDurable();
    } catch (_) {
      throw const TokenStoreException(TokenStoreOperation.write);
    }
  }

  /// Removes a logout tombstone after refresh credentials were durably deleted.
  Future<void> clearLogoutIntent(
    LogoutCredentialDeletionReceipt confirmation,
  ) async {
    if (!identical(confirmation._tokenStore, this) || confirmation._consumed) {
      throw const TokenStoreStateException();
    }
    confirmation._consumed = true;
    await _deleteAndConfirm(logoutIntentStorageKey);
  }

  /// Makes the existing credential non-reusable before a refresh request.
  Future<void> markRotationPending(String refreshToken) async {
    final record = await _readScopedRecordAfterLegacyRetirement();
    if (record.state != TokenStoreCredentialState.committed ||
        record.refreshToken != refreshToken) {
      throw const TokenStoreStateException();
    }
    await _writeRecord(state: 'rotationPending', refreshToken: refreshToken);
  }

  /// Commits a newly rotated credential only over its matching pending record.
  Future<void> commitRotation({
    required String previousRefreshToken,
    required String nextRefreshToken,
  }) async {
    _validateRefreshToken(nextRefreshToken);
    final pending = await _readScopedRecordAfterLegacyRetirement();
    if (pending.state != TokenStoreCredentialState.rotationPending ||
        pending.refreshToken != previousRefreshToken ||
        previousRefreshToken == nextRefreshToken) {
      throw const TokenStoreStateException();
    }
    await _writeRecord(state: 'committed', refreshToken: nextRefreshToken);
  }

  /// Restores the prior credential only after a known pre-rotation rejection.
  Future<void> restoreAfterPreRotationRejection(
    String previousRefreshToken,
  ) async {
    final pending = await _readScopedRecordAfterLegacyRetirement();
    if (pending.state != TokenStoreCredentialState.rotationPending ||
        pending.refreshToken != previousRefreshToken) {
      throw const TokenStoreStateException();
    }
    await _writeRecord(state: 'committed', refreshToken: previousRefreshToken);
  }

  /// Idempotently removes both deployment-scoped and obsolete legacy records.
  ///
  /// This does not remove a logout intent. Logout callers must confirm this
  /// deletion before separately retiring the tombstone.
  Future<void> delete() async {
    await _deleteCredentialRecords();
  }

  /// Deletes credentials and returns a one-use proof that both durable
  /// deletions completed. The proof is required to retire the logout marker.
  Future<LogoutCredentialDeletionReceipt> deleteForLogout() async {
    await _deleteCredentialRecords();
    return LogoutCredentialDeletionReceipt._(this);
  }

  Future<void> _deleteCredentialRecords() async {
    await _deleteAndConfirm(storageKey);
    await _deleteAndConfirm(legacyStorageKey);
  }

  Future<bool> _retireLegacyCredential() async {
    final String? legacy;
    try {
      legacy = await _storage.read(key: legacyStorageKey);
    } catch (_) {
      throw const TokenStoreException(TokenStoreOperation.read);
    }
    if (legacy == null) return false;

    await _deleteAndConfirm(legacyStorageKey);
    return true;
  }

  Future<void> _deleteAndConfirm(String key) async {
    try {
      await _storage.delete(key: key);
      await _storage.confirmDurable();
    } catch (_) {
      throw const TokenStoreException(TokenStoreOperation.delete);
    }
  }

  Future<_ParsedTokenRecord> _readScopedRecordAfterLegacyRetirement() async {
    await _requireNoLogoutIntent();
    await _retireLegacyCredential();
    return _readScopedRecord();
  }

  Future<void> _requireNoLogoutIntent() async {
    if (await _readLogoutIntentState() != null) {
      throw const TokenStoreStateException();
    }
  }

  Future<TokenStoreCredentialState?> _readLogoutIntentState() async {
    final String? raw;
    try {
      raw = await _storage.read(key: logoutIntentStorageKey);
    } catch (_) {
      throw const TokenStoreException(TokenStoreOperation.read);
    }
    if (raw == null) return null;

    final Object? decoded;
    try {
      decoded = jsonDecode(raw);
    } on FormatException {
      return TokenStoreCredentialState.logoutIntentUnusable;
    }
    if (decoded is! Map<String, dynamic>) {
      return TokenStoreCredentialState.logoutIntentUnusable;
    }
    const requiredKeys = <String>{'version', 'state', 'scope'};
    if (decoded.keys.length != requiredKeys.length ||
        !decoded.keys.toSet().containsAll(requiredKeys) ||
        decoded['version'] != recordVersion ||
        decoded['state'] != 'logoutPending' ||
        decoded['scope'] != _scopeDigest) {
      return TokenStoreCredentialState.logoutIntentUnusable;
    }
    return TokenStoreCredentialState.logoutPending;
  }

  Future<_ParsedTokenRecord> _readScopedRecord() async {
    final String? raw;
    try {
      raw = await _storage.read(key: storageKey);
    } catch (_) {
      throw const TokenStoreException(TokenStoreOperation.read);
    }
    if (raw == null) {
      return const _ParsedTokenRecord(TokenStoreCredentialState.missing);
    }
    return _parseRecord(raw);
  }

  Future<void> _writeRecord({
    required String state,
    required String refreshToken,
  }) async {
    final value = jsonEncode(<String, Object>{
      'version': recordVersion,
      'state': state,
      'scope': _scopeDigest,
      'refreshToken': refreshToken,
    });
    try {
      await _storage.write(key: storageKey, value: value);
      await _storage.confirmDurable();
    } catch (_) {
      throw const TokenStoreException(TokenStoreOperation.write);
    }
  }

  _ParsedTokenRecord _parseRecord(String raw) {
    final Object? decoded;
    try {
      decoded = jsonDecode(raw);
    } on FormatException {
      return const _ParsedTokenRecord(TokenStoreCredentialState.malformed);
    }
    if (decoded is! Map<String, dynamic>) {
      return const _ParsedTokenRecord(TokenStoreCredentialState.malformed);
    }

    final keys = decoded.keys.toSet();
    const requiredKeys = <String>{'version', 'state', 'scope', 'refreshToken'};
    if (keys.length != requiredKeys.length || !keys.containsAll(requiredKeys)) {
      return const _ParsedTokenRecord(TokenStoreCredentialState.malformed);
    }
    final version = decoded['version'];
    if (version is! int) {
      return const _ParsedTokenRecord(TokenStoreCredentialState.malformed);
    }
    if (version != recordVersion) {
      return const _ParsedTokenRecord(
        TokenStoreCredentialState.unsupportedVersion,
      );
    }
    if (decoded['scope'] != _scopeDigest) {
      return const _ParsedTokenRecord(
        TokenStoreCredentialState.wrongDeployment,
      );
    }
    final state = decoded['state'];
    final refreshToken = decoded['refreshToken'];
    if ((state != 'committed' && state != 'rotationPending') ||
        refreshToken is! String) {
      return const _ParsedTokenRecord(TokenStoreCredentialState.malformed);
    }
    if (!_isValidRefreshToken(refreshToken)) {
      return const _ParsedTokenRecord(
        TokenStoreCredentialState.invalidCredential,
      );
    }
    return _ParsedTokenRecord(
      state == 'committed'
          ? TokenStoreCredentialState.committed
          : TokenStoreCredentialState.rotationPending,
      refreshToken: refreshToken,
    );
  }

  void _validateRefreshToken(String refreshToken) {
    if (!_isValidRefreshToken(refreshToken)) {
      throw const TokenStoreStateException();
    }
  }

  bool _isValidRefreshToken(String token) =>
      token.isNotEmpty && _refreshTokenPattern.hasMatch(token);

  static String _digest(String value) =>
      sha256.convert(utf8.encode(value)).toString();

  static String _deploymentIdentity(Uri uri) {
    final scheme = uri.scheme.toLowerCase();
    final host = uri.host.toLowerCase();
    if ((scheme != 'http' && scheme != 'https') ||
        !uri.hasAuthority ||
        host.isEmpty ||
        uri.userInfo.isNotEmpty ||
        uri.hasQuery ||
        uri.hasFragment) {
      throw ArgumentError.value(uri, 'baseUri', 'Invalid Core API identity.');
    }
    final normalizedHost = host.endsWith('.')
        ? host.substring(0, host.length - 1)
        : host;
    final hostForAuthority = normalizedHost.contains(':')
        ? '[$normalizedHost]'
        : normalizedHost;
    final effectivePort = uri.hasPort
        ? uri.port
        : scheme == 'https'
        ? 443
        : 80;
    var path = uri.path;
    if (path.isEmpty) path = '/';
    while (path.length > 1 && path.endsWith('/')) {
      path = path.substring(0, path.length - 1);
    }
    return '$scheme://$hostForAuthority:$effectivePort$path';
  }
}

class LogoutCredentialDeletionReceipt {
  LogoutCredentialDeletionReceipt._(this._tokenStore);

  final TokenStore _tokenStore;
  bool _consumed = false;
}

class _ParsedTokenRecord {
  const _ParsedTokenRecord(this.state, {this.refreshToken});

  final TokenStoreCredentialState state;
  final String? refreshToken;
}
