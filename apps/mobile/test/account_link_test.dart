import 'package:flutter_test/flutter_test.dart';
import 'package:sme_meeting_assistant/features/auth/account_flow.dart';
import 'package:sme_meeting_assistant/features/auth/account_link.dart';

void main() {
  final parser = AccountLinkParser('meeting.example.invalid');
  const origin = 'https://meeting.example.invalid';

  test('canonical and legacy paths retain exact decoded capability', () {
    for (final path in ['/account-setup', '/sign-up']) {
      final result = parser.parse('$origin$path#token=a%2B%2520%26b');
      expect(result.operation, AccountOperation.setup);
      expect(result.capability, 'a+%20&b');
    }
    for (final path in ['/reset-password', '/otp']) {
      final result = parser.parse('$origin$path#token=abc');
      expect(result.operation, AccountOperation.reset);
    }
    expect(
      parser
          .parse('$origin:443/otp#token=x')
          .sameCapability(parser.parse('$origin/reset-password#token=x')),
      isTrue,
    );
  });

  test('paste may trim the URL but must not trim the capability', () {
    expect(parser.parse(' $origin/otp#token=a ', pasted: true).capability, 'a');
    expect(
      () => parser.parse('$origin/otp#token=a%20', pasted: true),
      throwsA(isA<AccountLinkException>()),
    );
  });

  test('reject ambiguous, unsupported, or unsafe links', () {
    final rejected = [
      'http://meeting.example.invalid/otp#token=a',
      'https://meeting.example.invalid.evil.test/otp#token=a',
      'https://meetİng.example.invalid/otp#token=a',
      'https://evil.test@meeting.example.invalid/otp#token=a',
      'https://meeting.example.invalid:8443/otp#token=a',
      'https://meeting.example.invalid./otp#token=a',
      '$origin/OTP#token=a',
      '$origin/a/../otp#token=a',
      '$origin/%6ftp#token=a',
      '$origin/otp/',
      '$origin/otp?token=a#token=b',
      '$origin/otp?#token=a',
      '$origin/otp#token=a&token=b',
      '$origin/otp#token=a&other=b',
      '$origin/otp#token=%ZZ',
      '$origin/otp#token=%FF',
      '$origin/otp#token=%ED%A0%80',
      '$origin/otp#token=' + String.fromCharCode(0xd800),
      '$origin/otp#token=',
      '$origin/otp#token=a+b',
      '$origin/otp#token=a%00',
      '$origin/otp#token=a%C2%85',
      '$origin/otp#token=a#b',
      '$origin/meetings#token=a',
      '$origin/otp#token=' + ('a' * 4097),
      '$origin/otp#token=' + ('a' * 40001),
    ];
    for (final input in rejected) {
      expect(() => parser.parse(input), throwsA(isA<AccountLinkException>()));
    }
  });

  test('disabled configuration fails closed; malformed host is rejected', () {
    expect(
      () => AccountLinkParser('').parse('$origin/otp#token=a'),
      throwsA(
        isA<AccountLinkException>().having(
          (error) => error.kind,
          'kind',
          AccountLinkFailure.disabled,
        ),
      ),
    );
    for (final host in [
      '*.example.invalid',
      'https://example.invalid',
      'a..b',
    ]) {
      expect(() => AccountLinkParser(host), throwsFormatException);
    }
  });
}
