import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

const FlutterSecureStorage _platformCredentialStorage = FlutterSecureStorage(
  aOptions: AndroidOptions(
    resetOnError: false,
    migrateOnAlgorithmChange: true,
    migrateWithBackup: false,
    keyCipherAlgorithm:
        KeyCipherAlgorithm.RSA_ECB_OAEPwithSHA_256andMGF1Padding,
    storageCipherAlgorithm: StorageCipherAlgorithm.AES_GCM_NoPadding,
  ),
  iOptions: IOSOptions(
    accessibility: KeychainAccessibility.unlocked_this_device,
    synchronizable: false,
  ),
);

abstract interface class CredentialStorage {
  Future<String?> read({required String key});

  Future<void> write({required String key, required String value});

  Future<void> delete({required String key});

  /// Confirms that prior secure-storage writes have reached durable storage.
  Future<void> confirmDurable();
}

abstract interface class CredentialDurability {
  Future<void> confirmDurable();
}

/// Android confirmation for the encrypted SharedPreferences files used by the
/// pinned flutter_secure_storage implementation.
class AndroidCredentialDurability implements CredentialDurability {
  const AndroidCredentialDurability({this.channel = _channel});

  static const MethodChannel _channel = MethodChannel(
    'vn.sme.meetingassistant.sme_meeting_assistant/credential_durability',
  );
  static const String methodName = 'confirmSecureStorageDurability';

  final MethodChannel channel;

  @override
  Future<void> confirmDurable() async {
    if (defaultTargetPlatform != TargetPlatform.android) return;
    try {
      await channel.invokeMethod<void>(methodName);
    } on PlatformException {
      throw const CredentialDurabilityException();
    } on MissingPluginException {
      throw const CredentialDurabilityException();
    }
  }
}

class CredentialDurabilityException implements Exception {
  const CredentialDurabilityException();

  @override
  String toString() => 'Secure credential durability could not be confirmed.';
}

class SecureCredentialStorage implements CredentialStorage {
  final FlutterSecureStorage storage;
  final CredentialDurability durability;

  const SecureCredentialStorage({
    this.storage = _platformCredentialStorage,
    this.durability = const AndroidCredentialDurability(),
  });

  @override
  Future<String?> read({required String key}) => storage.read(key: key);

  @override
  Future<void> write({required String key, required String value}) =>
      storage.write(key: key, value: value);

  @override
  Future<void> delete({required String key}) => storage.delete(key: key);

  @override
  Future<void> confirmDurable() => durability.confirmDurable();
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

  @override
  Future<void> confirmDurable() async {}
}
