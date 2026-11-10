import 'dart:convert';
import 'dart:io';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Device-private index; source audio remains in the app documents directory.
class RecordingDraft {
  const RecordingDraft({
    required this.path, required this.name, required this.createdAt,
  });
  final String path, name;
  final DateTime createdAt;
}

class RecordingDrafts {
  const RecordingDrafts();
  static const _storage = FlutterSecureStorage();
  static const _key = 'sme.mobile.recordings.v1';

  Future<List<Map<String, dynamic>>> _read() async {
    final json = await _storage.read(key: _key);
    if (json == null || json.isEmpty) return [];
    final decoded = jsonDecode(json);
    if (decoded is! List) return [];
    return decoded.whereType<Map>()
        .map((value) => value.map((key, item) =>
          MapEntry(key.toString(), item))).toList();
  }

  Future<List<RecordingDraft>> list(String meetingId) async {
    final entries = await _read();
    final drafts = <RecordingDraft>[];
    for (final raw in entries.where((entry) => entry['meetingId'] == meetingId)) {
      final path = raw['path']?.toString();
      if (path == null || !await File(path).exists()) continue;
      final when = DateTime.tryParse(raw['createdAt']?.toString() ?? '');
      drafts.add(RecordingDraft(
        path: path,
        name: raw['name']?.toString() ?? 'meeting-audio.wav',
        createdAt: when ?? DateTime.now(),
      ));
    }
    drafts.sort((a, b) => b.createdAt.compareTo(a.createdAt));
    return drafts;
  }

  Future<void> remember(String meetingId, File file) async {
    if (!await file.exists()) return;
    final entries = await _read();
    if (entries.any((item) =>
      item['meetingId'] == meetingId && item['path'] == file.path)) return;
    entries.add({
      'meetingId': meetingId,
      'path': file.path,
      'name': file.uri.pathSegments.last,
      'createdAt': DateTime.now().toUtc().toIso8601String(),
    });
    // Bounded metadata index; trimming an index never deletes source audio.
    final tail = entries.length > 100 ? entries.sublist(entries.length - 100) : entries;
    await _storage.write(key: _key, value: jsonEncode(tail));
  }
}
