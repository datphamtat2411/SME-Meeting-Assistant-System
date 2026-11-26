import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/features/auth/account_flow.dart';

void main() {
  test(
    'validates new passwords by Unicode code points without normalization',
    () {
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
    },
  );

  test('organizational email syntax and length limits', () {
    for (final email in [
      'user@company',
      'user@.',
      'user@-',
      '.user@example.test',
      'user..name@example.test',
      'user.@example.test',
      'user@-example.test',
      'user@example-.test',
      'user@example..test',
      'user name@example.test',
    ]) {
      expect(AuthValidators.email(email), isNotNull, reason: email);
    }
    expect(AuthValidators.email("o'neil+work@dept.example.test"), isNull);
    expect(AuthValidators.email('${'a' * 307}@example.test'), isNull);
    expect(AuthValidators.email('${'a' * 308}@example.test'), isNotNull);
  });

  test('retry deadline survives form replacement', () async {
    var now = DateTime.utc(2026, 11, 26);
    final deadlines = AccountRetryDeadlines();
    addTearDown(deadlines.dispose);
    AccountSubmissionController controller(AccountOperation operation) =>
        AccountSubmissionController(
          operation,
          now: () => now,
          retryDeadlines: deadlines,
        );
    final first = controller(AccountOperation.recovery);
    await first.submit(() async {
      throw const ApiFailure(
        429,
        'RATE_LIMIT_EXCEEDED',
        'wait',
        retryAfter: '45',
      );
    });
    first.dispose();

    final replacement = controller(AccountOperation.recovery);
    addTearDown(replacement.dispose);
    final setup = controller(AccountOperation.setup);
    addTearDown(setup.dispose);
    expect(replacement.retryRemaining, const Duration(seconds: 45));
    expect(replacement.canSubmit, isFalse);
    expect(setup.canSubmit, isTrue);
    var calls = 0;
    await replacement.submit(() async => calls++);
    expect(calls, 0);
    now = now.add(const Duration(seconds: 45));
    expect(replacement.canSubmit, isTrue);
    expect(calls, 0);
    await replacement.submit(() async => calls++);
    expect(calls, 1);
  });

  test('late throttle is retained by the live flow', () async {
    final deadlines = AccountRetryDeadlines();
    addTearDown(deadlines.dispose);
    final now = DateTime.utc(2026, 11, 26);
    final pending = Completer<void>();
    final first = AccountSubmissionController(
      AccountOperation.reset,
      now: () => now,
      retryDeadlines: deadlines,
    );
    final submitted = first.submit(() => pending.future);
    first.dispose();
    final replacement = AccountSubmissionController(
      AccountOperation.reset,
      now: () => now,
      retryDeadlines: deadlines,
    );
    addTearDown(replacement.dispose);
    var notifications = 0;
    replacement.addListener(() => notifications++);
    pending.completeError(
      const ApiFailure(429, 'RATE_LIMIT_EXCEEDED', 'wait', retryAfter: '30'),
    );
    await submitted;
    expect(replacement.canSubmit, isFalse);
    expect(replacement.retryRemaining, const Duration(seconds: 30));
    expect(notifications, 1);
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
    var now = DateTime.utc(2026, 11, 26);
    final submission = AccountSubmissionController(
      AccountOperation.recovery,
      now: () => now,
    );
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
    expect(submission.canSubmit, isFalse);
    expect(submission.retryRemaining, const Duration(seconds: 60));
    now = now.add(const Duration(seconds: 60));
    expect(submission.canSubmit, isTrue);
  });

  test(
    'acknowledgement cooldown survives replacement and server limits',
    () async {
      var now = DateTime.utc(2026, 11, 26);
      final deadlines = AccountRetryDeadlines();
      addTearDown(deadlines.dispose);
      final first = AccountSubmissionController(
        AccountOperation.recovery,
        now: () => now,
        retryDeadlines: deadlines,
      );
      await first.submit(() async {});
      first.dispose();
      final next = AccountSubmissionController(
        AccountOperation.recovery,
        now: () => now,
        retryDeadlines: deadlines,
      );
      addTearDown(next.dispose);
      expect(next.retryRemaining, const Duration(seconds: 60));
      deadlines.retain(
        AccountOperation.recovery,
        now.add(const Duration(seconds: 90)),
        now,
      );
      expect(next.retryRemaining, const Duration(seconds: 90));
      expect(next.retryFeedback, contains('Máy chủ đang giới hạn'));
      var calls = 0;
      await next.submit(() async => calls++);
      expect(calls, 0);
      now = now.add(const Duration(seconds: 90));
      expect(next.canSubmit, isTrue);
      expect(next.retryFeedback, isNull);
      expect(calls, 0);
    },
  );

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
        throw ApiFailure(
          429,
          'RATE_LIMIT_EXCEEDED',
          'wait',
          retryAfter: retryAfter,
        );
      });
      expect(submission.failure?.kind, AccountFailureKind.throttled);
      expect(submission.canSubmit, isFalse);
      expect(submission.retryRemaining, const Duration(seconds: 45));
      now = now.add(const Duration(seconds: 45));
      expect(submission.canSubmit, isTrue);
    }
    expect(calls, 2);
  });

  test('credential failure guidance follows the operation purpose', () {
    final now = DateTime.utc(2026, 11, 26);
    final resetUnavailable = AccountFlowFailure.classify(
      const ApiFailure(404, 'RESOURCE_NOT_FOUND', 'private'),
      AccountOperation.reset,
      now: now,
    );
    final setupUnavailable = AccountFlowFailure.classify(
      const ApiFailure(404, 'RESOURCE_NOT_FOUND', 'private'),
      AccountOperation.setup,
      now: now,
    );
    expect(resetUnavailable.kind, AccountFailureKind.unavailable);
    expect(resetUnavailable.message, contains('Liên kết khôi phục'));
    expect(setupUnavailable.kind, AccountFailureKind.unavailable);
    expect(setupUnavailable.message, contains('Lời mời thiết lập'));

    final resetUncertain = AccountFlowFailure.classify(
      const ApiFailure(503, 'SERVICE_UNAVAILABLE', 'private'),
      AccountOperation.reset,
      now: now,
    );
    final setupUncertain = AccountFlowFailure.classify(
      const ApiFailure(503, 'SERVICE_UNAVAILABLE', 'private'),
      AccountOperation.setup,
      now: now,
    );
    expect(resetUncertain.kind, AccountFailureKind.uncertain);
    expect(
      resetUncertain.message,
      contains('Mật khẩu có thể đã được cập nhật'),
    );
    expect(setupUncertain.kind, AccountFailureKind.uncertain);
    expect(
      setupUncertain.message,
      contains('Tài khoản có thể đã được kích hoạt'),
    );

    final resetRejected = AccountFlowFailure.classify(
      const ApiFailure(422, 'VALIDATION_FAILED', 'private'),
      AccountOperation.reset,
      now: now,
    );
    final setupRejected = AccountFlowFailure.classify(
      const ApiFailure(422, 'VALIDATION_FAILED', 'private'),
      AccountOperation.setup,
      now: now,
    );
    expect(resetRejected.message, contains('Liên kết khôi phục'));
    expect(setupRejected.message, contains('Lời mời thiết lập'));
    expect(setupRejected.message, isNot(contains('khôi phục')));
  });
}
