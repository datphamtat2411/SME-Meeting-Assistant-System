import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';

void main() {
  test(
    'platform secure storage keeps errors visible and credentials device-bound',
    () {
      const secure = SecureCredentialStorage();

      expect(secure.storage.aOptions.toMap()['resetOnError'], 'false');
      expect(
        secure.storage.aOptions.toMap()['keyCipherAlgorithm'],
        KeyCipherAlgorithm.RSA_ECB_OAEPwithSHA_256andMGF1Padding.name,
      );
      expect(
        secure.storage.aOptions.toMap()['storageCipherAlgorithm'],
        StorageCipherAlgorithm.AES_GCM_NoPadding.name,
      );
      expect(
        secure.storage.iOptions.accessibility,
        KeychainAccessibility.unlocked_this_device,
      );
      expect(secure.storage.iOptions.synchronizable, isFalse);
    },
  );

  test('normalizes endpoint identity and isolates distinct deployments', () {
    final first = TokenStore(
      storage: InMemoryCredentialStorage(),
      baseUri: Uri.parse('https://api.example.test/api/v1'),
    );
    final equivalent = TokenStore(
      storage: InMemoryCredentialStorage(),
      baseUri: Uri.parse('HTTPS://API.EXAMPLE.TEST:443/api/v1/'),
    );
    final otherPort = TokenStore(
      storage: InMemoryCredentialStorage(),
      baseUri: Uri.parse('https://api.example.test:8443/api/v1'),
    );
    final otherPath = TokenStore(
      storage: InMemoryCredentialStorage(),
      baseUri: Uri.parse('https://api.example.test/api/v2'),
    );

    expect(first.storageKey, equivalent.storageKey);
    expect(first.storageKey, isNot(otherPort.storageKey));
    expect(first.storageKey, isNot(otherPath.storageKey));
    expect(first.storageKey, startsWith('sme.mobile.token.v1.'));
  });

  test('persists a versioned committed refresh record only', () async {
    final storage = _MemoryStorage();
    final store = _store(storage);

    await store.storeLoginCredential('refresh_0');

    final raw = storage.values[store.storageKey]!;
    final record = jsonDecode(raw) as Map<String, dynamic>;
    expect(record, containsPair('version', 1));
    expect(record, containsPair('state', 'committed'));
    expect(record, containsPair('scope', store.scopeDigest));
    expect(record, containsPair('refreshToken', 'refresh_0'));
    expect(record.keys.toSet(), <String>{
      'version',
      'state',
      'scope',
      'refreshToken',
    });
    expect(raw, isNot(contains('accessToken')));
    expect((await store.read()).refreshToken, 'refresh_0');
  });

  test(
    'rotation pending is durable but never returns a reusable credential',
    () async {
      final storage = _MemoryStorage();
      final store = _store(storage);
      await store.storeLoginCredential('refresh_0');

      await store.markRotationPending('refresh_0');

      final restartedStore = _store(storage);
      final result = await restartedStore.read();
      expect(result.state, TokenStoreCredentialState.rotationPending);
      expect(result.refreshToken, isNull);
      expect(
        jsonDecode(storage.values[store.storageKey]!)['state'],
        'rotationPending',
      );

      await store.commitRotation(
        previousRefreshToken: 'refresh_0',
        nextRefreshToken: 'refresh_1',
      );
      expect((await restartedStore.read()).refreshToken, 'refresh_1');
    },
  );

  test(
    'separate deployment scopes cannot read or replace each other',
    () async {
      final storage = _MemoryStorage();
      final production = _store(storage);
      final staging = TokenStore(
        storage: storage,
        baseUri: Uri.parse('https://staging.example.test/api/v1'),
      );
      await production.storeLoginCredential('prod_refresh');
      await staging.storeLoginCredential('stage_refresh');

      expect((await production.read()).refreshToken, 'prod_refresh');
      expect((await staging.read()).refreshToken, 'stage_refresh');
      expect(production.storageKey, isNot(staging.storageKey));
    },
  );

  test(
    'pre-rotation rejection restores only its matching pending credential',
    () async {
      final storage = _MemoryStorage();
      final store = _store(storage);
      await store.storeLoginCredential('refresh_0');
      await store.markRotationPending('refresh_0');

      await store.restoreAfterPreRotationRejection('refresh_0');

      expect((await store.read()).refreshToken, 'refresh_0');
    },
  );

  test('malformed, unsupported, incomplete, and foreign-scope records are rejected', () async {
    final storage = _MemoryStorage();
    final store = _store(storage);
    final valid = <String, dynamic>{
      'version': 1,
      'state': 'committed',
      'scope': store.scopeDigest,
      'refreshToken': 'refresh_0',
    };

    for (final raw in <String>[
      '{not-json',
      jsonEncode(<String, dynamic>{...valid, 'version': 99}),
      jsonEncode(<String, dynamic>{...valid}..remove('refreshToken')),
      jsonEncode(<String, dynamic>{...valid, 'scope': 'another-deployment'}),
      jsonEncode(<String, dynamic>{...valid, 'accessToken': 'never-persist'}),
      jsonEncode(<String, dynamic>{...valid, 'refreshToken': ''}),
    ]) {
      storage.values[store.storageKey] = raw;

      final result = await store.read();

      expect(result.state, isNot(TokenStoreCredentialState.committed));
      expect(result.refreshToken, isNull);
    }
  });

  test(
    'unscoped legacy credential is retired without adoption and idempotently',
    () async {
      final storage = _MemoryStorage()
        ..values[TokenStore.legacyStorageKey] = 'legacy_refresh';
      final store = _store(storage);

      final firstRead = await store.read();
      final secondRead = await store.read();

      expect(firstRead.state, TokenStoreCredentialState.legacyRetired);
      expect(secondRead.state, TokenStoreCredentialState.missing);
      expect(firstRead.refreshToken, isNull);
      expect(storage.values, isNot(contains(TokenStore.legacyStorageKey)));
      expect(storage.values, isNot(contains(store.storageKey)));
    },
  );

  test(
    'legacy retirement failure is observable and leaves legacy data intact',
    () async {
      final storage = _MemoryStorage()
        ..values[TokenStore.legacyStorageKey] = 'legacy_refresh'
        ..failNextDelete = true;
      final store = _store(storage);

      await expectLater(
        store.read(),
        throwsA(
          isA<TokenStoreException>().having(
            (error) => error.operation,
            'operation',
            TokenStoreOperation.delete,
          ),
        ),
      );

      expect(storage.values[TokenStore.legacyStorageKey], 'legacy_refresh');
      expect(
        (await store.read()).state,
        TokenStoreCredentialState.legacyRetired,
      );
    },
  );

  test('read, write, and delete failures remain observable before and after writes', () async {
    final storage = _MemoryStorage();
    final store = _store(storage);
    storage.failNextRead = true;
    await expectLater(
      store.read(),
      throwsA(
        isA<TokenStoreException>().having(
          (error) => error.operation,
          'operation',
          TokenStoreOperation.read,
        ),
      ),
    );

    storage.failNextWriteBefore = true;
    await expectLater(
      store.storeLoginCredential('refresh_before'),
      throwsA(
        isA<TokenStoreException>().having(
          (error) => error.operation,
          'operation',
          TokenStoreOperation.write,
        ),
      ),
    );
    expect((await store.read()).state, TokenStoreCredentialState.missing);

    storage.failNextWriteAfter = true;
    await expectLater(
      store.storeLoginCredential('refresh_after'),
      throwsA(isA<TokenStoreException>()),
    );
    expect((await store.read()).refreshToken, 'refresh_after');

    storage.failNextDeleteBefore = true;
    await expectLater(
      store.delete(),
      throwsA(
        isA<TokenStoreException>().having(
          (error) => error.operation,
          'operation',
          TokenStoreOperation.delete,
        ),
      ),
    );
    expect((await store.read()).refreshToken, 'refresh_after');

    storage.failNextDeleteAfter = true;
    await expectLater(store.delete(), throwsA(isA<TokenStoreException>()));
    expect((await store.read()).state, TokenStoreCredentialState.missing);
  });

  test(
    'failed pending write after persistence remains non-reusable on restart',
    () async {
      final storage = _MemoryStorage();
      final store = _store(storage);
      await store.storeLoginCredential('refresh_0');
      storage.failNextWriteAfter = true;

      await expectLater(
        store.markRotationPending('refresh_0'),
        throwsA(isA<TokenStoreException>()),
      );

      final restarted = _store(storage);
      final result = await restarted.read();
      expect(result.state, TokenStoreCredentialState.rotationPending);
      expect(result.refreshToken, isNull);
    },
  );
}

TokenStore _store(CredentialStorage storage) => TokenStore(
  storage: storage,
  baseUri: Uri.parse('https://api.example.test/api/v1'),
);

class _MemoryStorage implements CredentialStorage {
  final Map<String, String> values = <String, String>{};
  bool failNextRead = false;
  bool failNextWriteBefore = false;
  bool failNextWriteAfter = false;
  bool failNextDeleteBefore = false;
  bool failNextDeleteAfter = false;
  bool failNextDelete = false;

  @override
  Future<String?> read({required String key}) async {
    if (failNextRead) {
      failNextRead = false;
      throw StateError('secret platform details');
    }
    return values[key];
  }

  @override
  Future<void> write({required String key, required String value}) async {
    if (failNextWriteBefore) {
      failNextWriteBefore = false;
      throw StateError('secret platform details');
    }
    values[key] = value;
    if (failNextWriteAfter) {
      failNextWriteAfter = false;
      throw StateError('secret platform details');
    }
  }

  @override
  Future<void> delete({required String key}) async {
    if (failNextDelete || failNextDeleteBefore) {
      failNextDelete = false;
      failNextDeleteBefore = false;
      throw StateError('secret platform details');
    }
    values.remove(key);
    if (failNextDeleteAfter) {
      failNextDeleteAfter = false;
      throw StateError('secret platform details');
    }
  }
}
