import 'dart:async';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:path/path.dart' as path;
import 'package:path_provider/path_provider.dart';

import 'local_media_models.dart';

/// Application-private filesystem boundary for local source audio.
///
/// Callers only receive internally generated relative paths. Original
/// filenames are metadata and are never used to construct a filesystem path.
class ManagedMediaStorage {
  ManagedMediaStorage({required Directory root, DateTime Function()? now})
    : root = root.absolute,
      _now = now ?? DateTime.now;

  final Directory root;
  final DateTime Function() _now;

  Directory get assetsDirectory => Directory(path.join(root.path, 'assets'));
  Directory get stagingDirectory => Directory(path.join(root.path, 'staging'));
  Directory get quarantineDirectory =>
      Directory(path.join(root.path, 'quarantine'));

  static Future<ManagedMediaStorage> openDefault({
    DateTime Function()? now,
  }) async {
    final support = await getApplicationSupportDirectory();
    final storage = ManagedMediaStorage(
      root: Directory(path.join(support.path, 'sme-media')),
      now: now,
    );
    await storage.ensureDirectories();
    return storage;
  }

  Future<void> ensureDirectories() async {
    await Future.wait(<Future<void>>[
      root.create(recursive: true),
      assetsDirectory.create(recursive: true),
      stagingDirectory.create(recursive: true),
      quarantineDirectory.create(recursive: true),
    ]);
  }

  ManagedMediaPaths allocatePaths(String assetId) {
    _validateGeneratedId(assetId);
    return ManagedMediaPaths(
      assetId: assetId,
      managedRelativePath: path.join('assets', '$assetId.audio'),
      stagedRelativePath: path.join('staging', '$assetId.part'),
    );
  }

  File fileFor(String relativePath) => File(_resolve(relativePath));

  bool contains(String relativePath) {
    try {
      _resolve(relativePath);
      return true;
    } on Object {
      return false;
    }
  }

  Future<IOSink> openStagedWrite(String stagedRelativePath) async {
    final file = fileFor(stagedRelativePath);
    await file.parent.create(recursive: true);
    return file.openWrite();
  }

  Future<LocalMediaFileIntegrity> writeStreamToStaging(
    String stagedRelativePath,
    Stream<List<int>> bytes, {
    int? expectedSizeBytes,
  }) async {
    final sink = await openStagedWrite(stagedRelativePath);
    final digestSink = _DigestSink();
    final converter = sha256.startChunkedConversion(digestSink);
    var size = 0;
    Object? failure;
    StackTrace? failureStack;
    try {
      await for (final chunk in bytes) {
        size += chunk.length;
        if (expectedSizeBytes != null && size > expectedSizeBytes) {
          throw const FileSystemException('The staged file exceeded its size.');
        }
        converter.add(chunk);
        sink.add(chunk);
      }
      converter.close();
      await sink.close();
    } catch (error, stackTrace) {
      failure = error;
      failureStack = stackTrace;
      try {
        await sink.close();
      } catch (_) {}
    }
    if (failure != null) {
      Error.throwWithStackTrace(failure, failureStack!);
    }
    if (size <= 0 || expectedSizeBytes != null && size != expectedSizeBytes) {
      throw const FileSystemException('The staged file size is invalid.');
    }
    return LocalMediaFileIntegrity(
      sizeBytes: size,
      sha256: digestSink.value.toString(),
    );
  }

  Future<LocalMediaFileIntegrity> copyFileToStaging(
    File source,
    String stagedRelativePath, {
    int? expectedSizeBytes,
  }) => writeStreamToStaging(
    stagedRelativePath,
    source.openRead(),
    expectedSizeBytes: expectedSizeBytes,
  );

  Future<LocalMediaFileIntegrity> inspectFile(String relativePath) async {
    final file = fileFor(relativePath);
    final digestSink = _DigestSink();
    final converter = sha256.startChunkedConversion(digestSink);
    var size = 0;
    await for (final chunk in file.openRead()) {
      size += chunk.length;
      converter.add(chunk);
    }
    converter.close();
    return LocalMediaFileIntegrity(
      sizeBytes: size,
      sha256: digestSink.value.toString(),
    );
  }

  /// Promotes a completed staged file without trusting any caller path.
  Future<void> promote(
    String stagedRelativePath,
    String managedRelativePath,
  ) async {
    final staged = fileFor(stagedRelativePath);
    final managed = fileFor(managedRelativePath);
    await managed.parent.create(recursive: true);
    if (!await staged.exists()) {
      if (await managed.exists()) return;
      throw const FileSystemException('The staged media file is missing.');
    }
    if (await managed.exists()) {
      final stagedInfo = await inspectFile(stagedRelativePath);
      final managedInfo = await inspectFile(managedRelativePath);
      if (stagedInfo.sizeBytes != managedInfo.sizeBytes ||
          stagedInfo.sha256 != managedInfo.sha256) {
        throw const FileSystemException(
          'The managed media destination already contains different bytes.',
        );
      }
      await staged.delete();
      return;
    }
    await staged.rename(managed.path);
  }

  Future<String> quarantine(
    String relativePath, {
    required String reason,
  }) async {
    final source = fileFor(relativePath);
    if (!await source.exists()) return relativePath;
    await quarantineDirectory.create(recursive: true);
    final identifier = _fileIdentity();
    final destinationRelative = path.join(
      'quarantine',
      '$identifier-${_safeReason(reason)}.artifact',
    );
    final destination = fileFor(destinationRelative);
    await source.rename(destination.path);
    return destinationRelative;
  }

  Future<void> deleteStaging(String relativePath) async {
    final normalized = _normalizeRelative(relativePath);
    if (!normalized.startsWith('staging${path.separator}') &&
        normalized != 'staging') {
      throw ArgumentError.value(
        relativePath,
        'relativePath',
        'Only staging artifacts may be cleaned by this primitive.',
      );
    }
    await fileFor(normalized).delete();
  }

  Future<void> deleteManaged(String relativePath) async {
    final normalized = _normalizeRelative(relativePath);
    if (!normalized.startsWith('assets${path.separator}') &&
        normalized != 'assets') {
      throw ArgumentError.value(
        relativePath,
        'relativePath',
        'Only managed media files may be deleted explicitly.',
      );
    }
    await fileFor(normalized).delete();
  }

  Future<List<String>> listFiles() async {
    if (!await root.exists()) return const <String>[];
    final result = <String>[];
    await for (final entity in root.list(recursive: true, followLinks: false)) {
      if (entity is File) {
        result.add(path.relative(entity.path, from: root.path));
      }
    }
    result.sort();
    return List<String>.unmodifiable(result);
  }

  String _resolve(String relativePath) {
    final normalized = _normalizeRelative(relativePath);
    final rootPath = path.normalize(root.absolute.path);
    final candidate = path.normalize(path.join(rootPath, normalized));
    if (candidate != rootPath &&
        !candidate.startsWith('$rootPath${path.separator}')) {
      throw ArgumentError.value(
        relativePath,
        'relativePath',
        'The media path escapes managed storage.',
      );
    }
    return candidate;
  }

  String _normalizeRelative(String relativePath) {
    if (relativePath.isEmpty ||
        relativePath.contains('\u0000') ||
        relativePath.contains('\\') ||
        path.isAbsolute(relativePath)) {
      throw ArgumentError.value(
        relativePath,
        'relativePath',
        'The media path is not a managed relative path.',
      );
    }
    final normalized = path.normalize(relativePath);
    if (normalized == '.' ||
        normalized == '..' ||
        normalized.startsWith('..${path.separator}')) {
      throw ArgumentError.value(
        relativePath,
        'relativePath',
        'The media path escapes managed storage.',
      );
    }
    return normalized;
  }

  static void _validateGeneratedId(String value) {
    if (!RegExp(r'^[a-f0-9]{32}$').hasMatch(value)) {
      throw ArgumentError.value(
        value,
        'assetId',
        'Invalid generated asset ID.',
      );
    }
  }

  String _fileIdentity() {
    final seed = '${_now().microsecondsSinceEpoch}-${root.path}';
    return sha256.convert(seed.codeUnits).toString().substring(0, 24);
  }

  static String _safeReason(String value) {
    final safe = value.replaceAll(RegExp(r'[^A-Za-z0-9_-]'), '_');
    return safe.isEmpty
        ? 'unknown'
        : safe.substring(0, safe.length.clamp(1, 40));
  }
}

class _DigestSink implements Sink<Digest> {
  Digest? _value;

  Digest get value => _value ?? (throw StateError('Digest was not produced.'));

  @override
  void add(Digest value) {
    if (_value != null) throw StateError('Digest was already produced.');
    _value = value;
  }

  @override
  void close() {
    if (_value == null) throw StateError('Digest was not produced.');
  }
}
