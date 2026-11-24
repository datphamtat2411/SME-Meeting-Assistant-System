import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';

import '../../core/api_client.dart';

/// Device-private, account-scoped index; source audio remains on disk.
class RecordingDraft {
  const RecordingDraft({
    required this.path,
    required this.name,
    required this.createdAt,
  });

  final String path;
  final String name;
  final DateTime createdAt;
}

class RecordingDrafts {
  RecordingDrafts({CredentialStorage? storage})
    : _storage = storage ?? const SecureCredentialStorage();

  static const String legacyStorageKey = 'sme.mobile.recordings.v1';
  static const String legacyQuarantineKey =
      'sme.mobile.recordings.legacy-quarantine.v1';
  static const String _storageKeyPrefix = 'sme.mobile.recordings.v2.';

  final CredentialStorage _storage;

  Future<List<RecordingDraft>> list(
    String meetingId, {
    required ApiClient api,
    AuthenticatedSessionScope? session,
  }) async {
    final activeSession = api.requireAuthenticatedSessionScope();
    final scope = session ?? activeSession;
    api.requireCurrentAuthenticatedSession(scope);
    await _retireLegacyIndex();
    api.requireCurrentAuthenticatedSession(scope);
    final entries = await _readIndex(scope);
    api.requireCurrentAuthenticatedSession(scope);
    final drafts = <RecordingDraft>[];
    for (final raw in entries) {
      if (raw['deploymentScope'] != scope.deploymentScope ||
          raw['userId'] != scope.userId ||
          raw['meetingId'] != meetingId) {
        continue;
      }
      final path = raw['path']?.toString();
      if (path == null || path.isEmpty) continue;
      final exists = await File(path).exists();
      api.requireCurrentAuthenticatedSession(scope);
      if (!exists) continue;
      final when = DateTime.tryParse(raw['createdAt']?.toString() ?? '');
      drafts.add(
        RecordingDraft(
          path: path,
          name: raw['name']?.toString() ?? 'meeting-audio.wav',
          createdAt: when ?? DateTime.now(),
        ),
      );
    }
    drafts.sort((a, b) => b.createdAt.compareTo(a.createdAt));
    api.requireCurrentAuthenticatedSession(scope);
    return drafts;
  }

  /// Stores metadata only under the verified account scope captured when the
  /// recording began. A stale scope can retain its own audio after logout but
  /// cannot make that metadata visible to another account.
  Future<void> remember(
    String meetingId,
    File file, {
    required AuthenticatedSessionScope session,
  }) async {
    if (!await file.exists()) return;
    await _retireLegacyIndex();
    final entries = await _readIndex(session);
    if (entries.any(
      (item) =>
          item['deploymentScope'] == session.deploymentScope &&
          item['userId'] == session.userId &&
          item['meetingId'] == meetingId &&
          item['path'] == file.path,
    )) {
      return;
    }
    entries.add(<String, dynamic>{
      'deploymentScope': session.deploymentScope,
      'userId': session.userId,
      'meetingId': meetingId,
      'path': file.path,
      'name': file.uri.pathSegments.last,
      'createdAt': DateTime.now().toUtc().toIso8601String(),
    });
    // Each owner has a distinct index, so the cap cannot trim another
    // deployment's or account's metadata. Source audio is never removed here.
    final tail = entries.length > 100
        ? entries.sublist(entries.length - 100)
        : entries;
    await _storage.write(key: _storageKey(session), value: jsonEncode(tail));
    await _storage.confirmDurable();
  }

  Future<List<Map<String, dynamic>>> _readIndex(
    AuthenticatedSessionScope session,
  ) async {
    final raw = await _storage.read(key: _storageKey(session));
    if (raw == null || raw.isEmpty) return <Map<String, dynamic>>[];
    final Object? decoded;
    try {
      decoded = jsonDecode(raw);
    } on FormatException {
      return <Map<String, dynamic>>[];
    }
    if (decoded is! List) return <Map<String, dynamic>>[];
    return decoded
        .whereType<Map>()
        .map(
          (value) => value.map((key, item) => MapEntry(key.toString(), item)),
        )
        .toList(growable: true);
  }

  Future<void> _retireLegacyIndex() async {
    final legacy = await _storage.read(key: legacyStorageKey);
    if (legacy == null) return;

    final String? quarantine = await _storage.read(key: legacyQuarantineKey);
    final quarantinedValues = <String>[];
    if (quarantine != null) {
      final Object? decoded;
      try {
        decoded = jsonDecode(quarantine);
      } on FormatException {
        return;
      }
      if (decoded is! List || decoded.any((value) => value is! String)) {
        return;
      }
      quarantinedValues.addAll(decoded.cast<String>());
    }
    if (!quarantinedValues.contains(legacy)) {
      quarantinedValues.add(legacy);
      await _storage.write(
        key: legacyQuarantineKey,
        value: jsonEncode(quarantinedValues),
      );
      await _storage.confirmDurable();
    }
    await _storage.delete(key: legacyStorageKey);
    await _storage.confirmDurable();
  }

  String _storageKey(AuthenticatedSessionScope session) {
    final ownerDigest = sha256
        .convert(
          utf8.encode('${session.deploymentScope}\u0000${session.userId}'),
        )
        .toString();
    return '$_storageKeyPrefix$ownerDigest';
  }
}
