import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sme_meeting_assistant/features/auth/account_flow.dart';
import 'package:sme_meeting_assistant/features/auth/account_link.dart';
import 'package:sme_meeting_assistant/features/auth/account_link_coordinator.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('a native signal during initial drain is not lost', () async {
    const channel = MethodChannel('test/account_links');
    const codec = StandardMethodCodec();
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    final first = Completer<String?>();
    final requested = Completer<void>();
    final drained = Completer<void>();
    final deliveries = <(String, bool)>[];
    var calls = 0;
    var failures = 0;
    String? pending;
    messenger.setMockMessageHandler(channel.name, (message) async {
      expect(codec.decodeMethodCall(message).method, 'takePending');
      if (calls++ == 0) {
        requested.complete();
        return codec.encodeSuccessEnvelope(await first.future);
      }
      final value = pending;
      pending = null;
      if (value == null) drained.complete();
      return codec.encodeSuccessEnvelope(value);
    });
    final receiver = AccountLinkReceiver(
      channel: channel,
      onLink: (url, initial) => deliveries.add((url, initial)),
      onFailure: () => failures++,
    );
    addTearDown(() {
      receiver.dispose();
      messenger.setMockMessageHandler(channel.name, null);
    });
    receiver.start();
    await requested.future;
    pending = 'warm';
    await messenger.handlePlatformMessage(
      channel.name,
      codec.encodeMethodCall(const MethodCall('available')),
      (_) {},
    );
    expect(calls, 1);
    first.complete('cold');
    await drained.future.timeout(const Duration(seconds: 5));
    await Future<void>.delayed(Duration.zero);
    expect(deliveries, [('cold', true), ('warm', false)]);
    expect(calls, 3);
    expect(failures, 0);
  });

  const host = 'meeting.example.invalid';
  const origin = 'https://$host';

  test('equivalent links do not replace active or pending input', () {
    final owner = AccountLinkCoordinator(AccountLinkParser(host));
    addTearDown(owner.dispose);
    expect(
      owner.receive('$origin/otp#token=a%2Bb'),
      AccountLinkReception.accepted,
    );
    expect(
      owner.receive('$origin/reset-password#token=a%2bb'),
      AccountLinkReception.duplicate,
    );
    final active = owner.claim()!;
    expect(active.operation, AccountOperation.reset);
    expect(active.takeCapability(), 'a+b');
    expect(() => active.takeCapability(), throwsStateError);
    expect(
      owner.receive('$origin/otp#token=a%2Bb'),
      AccountLinkReception.duplicate,
    );
    owner.receive('$origin/sign-up#token=old');
    owner.receive('$origin/account-setup#token=new');
    expect(owner.claim(), isNull);
    owner.markTerminal(active);
    owner.finish(active);
    expect(
      owner.receive('$origin/otp#token=a%2Bb'),
      AccountLinkReception.duplicate,
    );
    final next = owner.claim()!;
    expect(next.operation, AccountOperation.setup);
    expect(next.takeCapability(), 'new');
    owner.finish(next);
    expect(owner.hasPending, isFalse);
  });

  test('rejected input does not destroy a legitimate deferred link', () {
    final owner = AccountLinkCoordinator(AccountLinkParser(host));
    addTearDown(owner.dispose);
    owner.receive('$origin/otp#token=valid');
    expect(
      owner.receive('https://evil.invalid/otp#token=fixture'),
      AccountLinkReception.rejected,
    );
    expect(owner.claim()!.takeCapability(), 'valid');
  });
}
