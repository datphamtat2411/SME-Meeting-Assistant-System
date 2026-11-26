import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sme_meeting_assistant/features/auth/account_flow.dart';
import 'package:sme_meeting_assistant/features/auth/account_link.dart';
import 'package:sme_meeting_assistant/features/auth/account_link_coordinator.dart';

void main() {
  testWidgets('a native signal during initial drain is not lost', (
    tester,
  ) async {
    const channel = MethodChannel('test/account_links');
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    final first = Completer<String?>();
    final deliveries = <(String, bool)>[];
    var calls = 0;
    String? pending;
    messenger.setMockMethodCallHandler(channel, (call) async {
      expect(call.method, 'takePending');
      if (calls++ == 0) return first.future;
      final value = pending;
      pending = null;
      return value;
    });
    final receiver = AccountLinkReceiver(
      channel: channel,
      onLink: (url, initial) => deliveries.add((url, initial)),
      onFailure: () => fail('Native delivery unexpectedly failed.'),
    );
    addTearDown(() {
      receiver.dispose();
      messenger.setMockMethodCallHandler(channel, null);
    });
    receiver.start();
    await tester.pump();
    pending = 'warm';
    await messenger.handlePlatformMessage(
      channel.name,
      const StandardMethodCodec().encodeMethodCall(
        const MethodCall('available'),
      ),
      (_) {},
    );
    expect(calls, 1);
    first.complete('cold');
    await tester.pump();
    expect(deliveries, [('cold', true), ('warm', false)]);
    expect(calls, 3);
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
