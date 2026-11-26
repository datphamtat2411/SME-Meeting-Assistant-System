import 'package:flutter_test/flutter_test.dart';
import 'package:sme_meeting_assistant/features/auth/account_flow.dart';
import 'package:sme_meeting_assistant/features/auth/account_link.dart';
import 'package:sme_meeting_assistant/features/auth/account_link_coordinator.dart';

void main() {
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
