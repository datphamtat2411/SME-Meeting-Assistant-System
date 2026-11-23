import 'package:flutter_secure_storage/flutter_secure_storage.dart';

abstract interface class CredentialStorage {
  Future<String?> read({required String key});

  Future<void> write({required String key, required String value});

  Future<void> delete({required String key});
}

class SecureCredentialStorage implements CredentialStorage {
  final FlutterSecureStorage storage;

  const SecureCredentialStorage({this.storage = const FlutterSecureStorage()});

  @override
  Future<String?> read({required String key}) => storage.read(key: key);

  @override
  Future<void> write({required String key, required String value}) =>
      storage.write(key: key, value: value);

  @override
  Future<void> delete({required String key}) => storage.delete(key: key);
}

class InMemoryCredentialStorage implements CredentialStorage {
  final Map<String, String> _values = <String, String>{};

  @override
  Future<String?> read({required String key}) async => _values[key];

  @override
  Future<void> write({required String key, required String value}) async {
    _values[key] = value;
  }

  @override
  Future<void> delete({required String key}) async {
    _values.remove(key);
  }
}
