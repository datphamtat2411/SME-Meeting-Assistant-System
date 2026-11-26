import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/features/auth/account_flow.dart';

void main() {
  test('validates new passwords by Unicode code points without normalization', () {
    expect(AuthValidators.newPassword('🔐' * 14), isNotNull);
    expect(AuthValidators.newPassword('🔐' * 15), isNull);
    expect(AuthValidators.newPassword('🔐' * 128), isNull);
    expect(AuthValidators.newPassword('🔐' * 129), isNotNull);
    expect(AuthValidators.newPassword(' ' * 15), isNull);
    expect(AuthValidators.loginPassword('short'), isNull);
    expect(AuthValidators.confirmation(' pass ', ' pass '), isNull);
    expect(AuthValidators.confirmation('pass', ' pass '), isNotNull);
    expect(AuthValidators.email(' user@example.test '), isNull);
    expect(AuthValidators.email('user@@example.test'), isNotNull);
    expect(AuthValidators.email('${'a' * 320}@example.test'), isNotNull);
  });

  test('classifies safe feedback without exposing the server message', () {
    final now = DateTime.utc(2026, 11, 26);
    final failure = AccountFlowFailure.classify(
      const ApiFailure(422, 'VALIDATION_FAILED', 'private token details'),
      AccountOperation.reset,
      now: now,
    );
    expect(failure.kind, AccountFailureKind.rejected);
    expect(failure.field, isNull);
    expect(failure.message, isNot(contains('private')));
    final passwordFailure = AccountFlowFailure.classify(
      const ApiFailure(
        422,
        'VALIDATION_FAILED',
        'private',
        errors: [
          ApiFieldError(field: 'password', code: 'INVALID', message: 'private'),
        ],
      ),
      AccountOperation.setup,
      now: now,
    );
    expect(passwordFailure.field, AccountFailureField.password);
  });

  test('enforces single flight and fences disposed submissions', () async {
    final submission = AccountSubmissionController(AccountOperation.recovery);
    final pending = Completer<void>();
    var calls = 0;
    var notifications = 0;
    submission.addListener(() => notifications++);
    final first = submission.submit(() {
      calls++;
      return pending.future;
    });
    await submission.submit(() async => calls++);
    expect(calls, 1);
    expect(submission.isSubmitting, isTrue);
    submission.dispose();
    final beforeCompletion = notifications;
    pending.complete();
    await first;
    expect(notifications, beforeCompletion);
  });

  test('credential mutation uncertainty prevents resubmission', () async {
    final submission = AccountSubmissionController(AccountOperation.reset);
    addTearDown(submission.dispose);
    var calls = 0;
    await submission.submit(() async {
      calls++;
      throw const ApiFailure(
        200,
        ApiFailure.invalidResponseCode,
        'invalid payload',
        remoteOutcomeAmbiguous: true,
      );
    });
    expect(submission.failure?.kind, AccountFailureKind.uncertain);
    expect(submission.canSubmit, isFalse);
    submission.clearRejectedFeedback();
    await submission.submit(() async => calls++);
    expect(calls, 1);
  });

  test('recovery uncertainty allows explicit retry only', () async {
    final submission = AccountSubmissionController(AccountOperation.recovery);
    addTearDown(submission.dispose);
    var calls = 0;
    await submission.submit(() async {
      calls++;
      throw const ApiFailure(503, 'UNAVAILABLE', 'private');
    });
    expect(submission.failure?.kind, AccountFailureKind.uncertain);
    expect(submission.canSubmit, isTrue);
    expect(calls, 1);
    await submission.submit(() async => calls++);
    expect(submission.isCompleted, isTrue);
    expect(submission.canSubmit, isFalse);
    submission.startNewRecoveryRequest();
    expect(submission.canSubmit, isTrue);
  });

  test('respects both Retry-After forms without automatic dispatch', () async {
    var now = DateTime.utc(2026, 11, 26);
    final submission = AccountSubmissionController(
      AccountOperation.recovery,
      now: () => now,
    );
    addTearDown(submission.dispose);
    var calls = 0;
    for (final retryAfter in ['45', 'Thu, 26 Nov 2026 00:01:30 GMT']) {
      await submission.submit(() async {
        calls++;
        throw ApiFailure(429, 'RATE_LIMIT_EXCEEDED', 'wait', retryAfter: retryAfter);
      });
      expect(submission.failure?.kind, AccountFailureKind.throttled);
      expect(submission.canSubmit, isFalse);
      expect(submission.retryRemaining, const Duration(seconds: 45));
      now = now.add(const Duration(seconds: 45));
      expect(submission.canSubmit, isTrue);
    }
    expect(calls, 2);
  });
}
