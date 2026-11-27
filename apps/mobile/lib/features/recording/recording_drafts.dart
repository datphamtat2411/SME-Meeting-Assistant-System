import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';

import '../../core/api_client.dart';
import 'local_media_models.dart';
import 'local_media_repository.dart';

/// Device-private, account-scoped index; source audio remains on disk.
class RecordingDraft {
  const RecordingDraft({
    required this.path,
    required this.name,
    required this.createdAt,
    this.assetId,
    this.meetingId,
    this.sourceType,
  });

  final String path;
  final String name;
  final DateTime createdAt;
  final String? assetId;
  final String? meetingId;
  final LocalMediaSourceType? sourceType;
}

class RecordingDrafts {
  RecordingDrafts({CredentialStorage? storage, this._repository})
    : _storage = storage ?? const SecureCredentialStorage();

  static const String legacyStorageKey = 'sme.mobile.recordings.v1';
  static const String legacyQuarantineKey =
      'sme.mobile.recordings.legacy-quarantine.v1';
  static const String _storageKeyPrefix = 'sme.mobile.recordings.v2.';

  final CredentialStorage _storage;
  final LocalMediaRepository? _repository;

  Future<List<RecordingDraft>> list(
    String meetingId, {
    required ApiClient api,
    AuthenticatedSessionScope? session,
  }) async {
    final activeSession = api.requireAuthenticatedSessionScope();
    final scope = session ?? activeSession;
    api.requireCurrentAuthenticatedSession(scope);
    final repository = _repository;
    if (repository != null) {
      final assets = await repository.listAssets(
        scope: scope,
        meetingId: meetingId,
      );
      final drafts = <RecordingDraft>[];
      for (final asset in assets) {
        if (!asset.isReady) continue;
        final File mediaFile;
        try {
          mediaFile = await repository.lightweightFileFor(
            scope: scope,
            asset: asset,
          );
        } on LocalMediaUnavailableException {
          // One unavailable asset must not hide other valid recordings. The
          // repository records the explicit missing/unavailable state.
          continue;
        } on FileSystemException {
          continue;
        }
        api.requireCurrentAuthenticatedSession(scope);
        drafts.add(
          RecordingDraft(
            path: mediaFile.path,
            name: asset.originalFilename,
            createdAt: asset.createdAt,
            assetId: asset.id,
            meetingId: asset.meetingId,
            sourceType: asset.sourceType,
          ),
        );
      }
      drafts.sort((a, b) => b.createdAt.compareTo(a.createdAt));
      api.requireCurrentAuthenticatedSession(scope);
      return drafts;
    }
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
          sourceType: _sourceType(raw['sourceType']),
        ),
      );
    }
    drafts.sort((a, b) => b.createdAt.compareTo(a.createdAt));
    api.requireCurrentAuthenticatedSession(scope);
    return drafts;
  }

  /// Activates scoped local recovery once for a workspace entry. Routine
  /// listing intentionally does not call this because it must remain
  /// metadata-and-size only.
  Future<LocalMediaRecoveryReport?> recover(
    String meetingId, {
    required ApiClient api,
    AuthenticatedSessionScope? session,
    bool retry = false,
  }) async {
    final activeSession = api.requireAuthenticatedSessionScope();
    final scope = session ?? activeSession;
    api.requireCurrentAuthenticatedSession(scope);
    final repository = _repository;
    if (repository == null) {
      await _retireLegacyIndex();
      api.requireCurrentAuthenticatedSession(scope);
      return null;
    }
    final report = await repository.recoverLocalState(
      scope: scope,
      meetingId: meetingId,
      storage: _storage,
      retry: retry,
    );
    api.requireCurrentAuthenticatedSession(scope);
    return report;
  }

  /// Stores metadata only under the verified account scope captured when the
  /// recording began. A stale scope can retain its own audio after logout but
  /// cannot make that metadata visible to another account.
  Future<LocalMediaAsset?> remember(
    String meetingId,
    File file, {
    required AuthenticatedSessionScope session,
  }) async {
    if (!await file.exists()) return null;
    final repository = _repository;
    if (repository != null) {
      return repository.rememberSourceFile(
        scope: session,
        meetingId: meetingId,
        source: file,
        sourceType: LocalMediaSourceType.recording,
        originalFilename: file.uri.pathSegments.last,
        contentType: _contentTypeFor(file.path),
      );
    }
    await _retireLegacyIndex();
    final entries = await _readIndex(session);
    if (entries.any(
      (item) =>
          item['deploymentScope'] == session.deploymentScope &&
          item['userId'] == session.userId &&
          item['meetingId'] == meetingId &&
          item['path'] == file.path,
    )) {
      return null;
    }
    entries.add(<String, dynamic>{
      'deploymentScope': session.deploymentScope,
      'userId': session.userId,
      'meetingId': meetingId,
      'path': file.path,
      'name': file.uri.pathSegments.last,
      'sourceType': LocalMediaSourceType.recording.wireValue,
      'createdAt': DateTime.now().toUtc().toIso8601String(),
    });
    // Each owner has a distinct index, so the cap cannot trim another
    // deployment's or account's metadata. Source audio is never removed here.
    final tail = entries.length > 100
        ? entries.sublist(entries.length - 100)
        : entries;
    await _storage.write(key: _storageKey(session), value: jsonEncode(tail));
    await _storage.confirmDurable();
    return null;
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

  static String _contentTypeFor(String value) {
    final lower = value.toLowerCase();
    if (lower.endsWith('.mp3')) return 'audio/mpeg';
    if (lower.endsWith('.m4a')) return 'audio/mp4';
    return 'audio/wav';
  }

  static LocalMediaSourceType? _sourceType(Object? value) {
    if (value is! String) return null;
    try {
      return LocalMediaSourceType.fromWireValue(value);
    } on Object {
      return null;
    }
  }
}
