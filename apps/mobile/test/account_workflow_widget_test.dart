import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/features/auth/account_flow.dart';
import 'package:sme_meeting_assistant/features/auth/account_forms.dart';
import 'package:sme_meeting_assistant/features/auth/auth_form_widgets.dart';
import 'package:sme_meeting_assistant/features/auth/credential_workflow.dart';

import 'support/http_test_support.dart';
import 'support/widget_test_support.dart';

ApiClient _api(RecordingHttpClient client) => ApiClient(
  baseUri: Uri.parse('https://api.example.test/api/v1'),
  httpClient: client,
  credentialStorage: InMemoryCredentialStorage(),
);

Map<String, dynamic> _body(http.BaseRequest request) =>
    jsonDecode((request as http.Request).body) as Map<String, dynamic>;

void main() {
  testWidgets('resend is explicit and reuses the acknowledged email', (
    tester,
  ) async {
    var now = DateTime.utc(2026, 11, 26);
    final client = RecordingHttpClient((request) async {
      expect(request.url.path, '/api/v1/auth/password-recovery');
      return jsonResponse(200, successEnvelope({'message': 'Acknowledged.'}));
    });
    final api = _api(client);
    final deadlines = AccountRetryDeadlines();
    addTearDown(client.close);
    addTearDown(api.dispose);
    addTearDown(deadlines.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: AuthLayout(
          child: RecoveryRequestForm(
            api: api,
            onBack: () {},
            retryDeadlines: deadlines,
            now: () => now,
          ),
        ),
      ),
    );
    await tester.enterText(
      find.byType(TextFormField).first,
      'user@example.test',
    );
    final submit = find.widgetWithText(FilledButton, 'Gửi yêu cầu');
    await tester.ensureVisible(submit);
    await tester.tap(submit);
    await pumpUntil(
      tester,
      () => find.text('Kiểm tra email').evaluate().isNotEmpty,
      reason: 'recovery acknowledgement',
    );
    final resend = find.widgetWithText(FilledButton, 'Gửi lại yêu cầu');
    expect(tester.widget<FilledButton>(resend).onPressed, isNull);
    now = now.add(const Duration(seconds: 60));
    await tester.pump(const Duration(seconds: 1));
    expect(client.requests, hasLength(1));
    expect(tester.widget<FilledButton>(resend).onPressed, isNotNull);
    await tester.ensureVisible(resend);
    await tester.tap(resend);
    await pumpUntil(
      tester,
      () =>
          client.requests.length == 2 &&
          find.textContaining('Còn 60 giây').evaluate().isNotEmpty,
      reason: 'explicit resend acknowledgement',
    );
    expect(_body(client.requests.first), {'email': 'user@example.test'});
    expect(_body(client.requests.last), _body(client.requests.first));
    expect(tester.widget<FilledButton>(resend).onPressed, isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  for (final operation in [AccountOperation.reset, AccountOperation.setup]) {
    testWidgets('supplied capability is private and explicit: $operation', (
      tester,
    ) async {
      const capability = 'opaque+/=';
      const password = '  Mật khẩu mới 🔐  ';
      final reset = operation == AccountOperation.reset;
      final client = RecordingHttpClient((request) async {
        expect(
          request.url.path,
          reset ? '/api/v1/auth/password-reset' : '/api/v1/auth/account-setup',
        );
        return jsonResponse(
          200,
          successEnvelope(reset ? {'message': 'Acknowledged.'} : null),
        );
      });
      final api = _api(client);
      final owner = CredentialWorkflowOwner(api);
      final deadlines = AccountRetryDeadlines();
      addTearDown(client.close);
      addTearDown(api.dispose);
      addTearDown(owner.dispose);
      addTearDown(deadlines.dispose);
      await tester.runAsync(api.initialize);
      await tester.pumpWidget(
        MaterialApp(
          home: AuthLayout(
            child: ListenableBuilder(
              listenable: owner,
              builder: (context, _) {
                final outcome = owner.outcome;
                if (outcome != null) {
                  return CredentialOutcomeView(
                    outcome: outcome,
                    authenticated: false,
                    onContinue: () {},
                  );
                }
                return CredentialEstablishmentForm(
                  api: api,
                  owner: owner,
                  operation: operation,
                  capability: capability,
                  retryDeadlines: deadlines,
                  onBack: () {},
                  onRecovery: () {},
                );
              },
            ),
          ),
        ),
      );
      final fields = find.byType(TextFormField);
      expect(fields, findsNWidgets(2));
      expect(find.text(capability), findsNothing);
      expect(client.requests, isEmpty);
      await tester.enterText(fields.at(0), password);
      await tester.enterText(fields.at(1), password);
      final submit = find.widgetWithText(FilledButton, 'Xác nhận');
      await tester.ensureVisible(submit);
      await tester.tap(submit);
      await pumpUntil(
        tester,
        () => find.byType(CredentialOutcomeView).evaluate().isNotEmpty,
        reason: 'credential completion',
      );
      expect(owner.outcome?.kind, CredentialOutcomeKind.completed);
      expect(client.requests, hasLength(1));
      expect(_body(client.requests.single), {
        'token': capability,
        'password': password,
      });
      expect(fields, findsNothing);
      expect(api.sessionState.phase, AuthSessionPhase.unauthenticated);
      await tester.pumpWidget(const SizedBox.shrink());
    });
  }

  testWidgets('recovery uncertainty requires an explicit retry after checking email', (
    tester,
  ) async {
    var calls = 0;
    final client = RecordingHttpClient((request) async {
      expect(request.url.path, '/api/v1/auth/password-recovery');
      calls++;
      if (calls == 1) {
        return jsonResponse(
          503,
          errorEnvelope('SERVICE_UNAVAILABLE', 'Private server details.'),
        );
      }
      return jsonResponse(
        200,
        successEnvelope({'message': 'Acknowledged.'}),
      );
    });
    final api = _api(client);
    final deadlines = AccountRetryDeadlines();
    addTearDown(client.close);
    addTearDown(api.dispose);
    addTearDown(deadlines.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: AuthLayout(
          child: RecoveryRequestForm(
            api: api,
            onBack: () {},
            retryDeadlines: deadlines,
          ),
        ),
      ),
    );

    await tester.enterText(
      find.byType(TextFormField).first,
      'user@example.test',
    );
    final submit = find.widgetWithText(FilledButton, 'Gửi yêu cầu');
    await tester.ensureVisible(submit);
    await tester.tap(submit);
    await pumpUntil(
      tester,
      () => find.textContaining('Hãy kiểm tra email trước khi gửi lại').evaluate().isNotEmpty,
      reason: 'the ambiguous recovery outcome to remain actionable',
    );
    expect(client.requests, hasLength(1));
    await tester.pump(const Duration(seconds: 1));
    expect(client.requests, hasLength(1));
    expect(tester.widget<FilledButton>(submit).onPressed, isNotNull);

    await tester.tap(submit);
    await pumpUntil(
      tester,
      () => find.text('Kiểm tra email').evaluate().isNotEmpty,
      reason: 'the user to explicitly retry and receive acknowledgement',
    );
    expect(client.requests, hasLength(2));
    await tester.pumpWidget(const SizedBox.shrink());
  });

  for (final operation in [AccountOperation.reset, AccountOperation.setup]) {
    testWidgets('password-policy rejection can be corrected: $operation', (
      tester,
    ) async {
      const capability = 'opaque+/=';
      const rejectedPassword = 'Rejected password 123';
      const correctedPassword = 'Corrected password 456';
      var calls = 0;
      final reset = operation == AccountOperation.reset;
      final client = RecordingHttpClient((request) async {
        expect(
          request.url.path,
          reset ? '/api/v1/auth/password-reset' : '/api/v1/auth/account-setup',
        );
        calls++;
        if (calls == 1) {
          return jsonResponse(422, {
            ...errorEnvelope('VALIDATION_FAILED', 'Private server details.'),
            'errors': [
              {
                'field': 'password',
                'code': 'PASSWORD_POLICY_VIOLATION',
                'message': 'Private password-policy details.',
              },
            ],
          });
        }
        return jsonResponse(
          200,
          successEnvelope(reset ? {'message': 'Acknowledged.'} : null),
        );
      });
      final api = _api(client);
      final owner = CredentialWorkflowOwner(api);
      final deadlines = AccountRetryDeadlines();
      addTearDown(client.close);
      addTearDown(api.dispose);
      addTearDown(owner.dispose);
      addTearDown(deadlines.dispose);
      await tester.runAsync(api.initialize);
      await tester.pumpWidget(
        MaterialApp(
          home: AuthLayout(
            child: ListenableBuilder(
              listenable: owner,
              builder: (context, _) {
                final outcome = owner.outcome;
                if (outcome != null) {
                  return CredentialOutcomeView(
                    outcome: outcome,
                    authenticated: false,
                    onContinue: () {},
                  );
                }
                return CredentialEstablishmentForm(
                  api: api,
                  owner: owner,
                  operation: operation,
                  capability: capability,
                  retryDeadlines: deadlines,
                  onBack: () {},
                  onRecovery: () {},
                );
              },
            ),
          ),
        ),
      );

      final fields = find.byType(TextFormField);
      expect(fields, findsNWidgets(2));
      await tester.enterText(fields.at(0), rejectedPassword);
      await tester.enterText(fields.at(1), rejectedPassword);
      final submit = find.widgetWithText(FilledButton, 'Xác nhận');
      await tester.ensureVisible(submit);
      await tester.tap(submit);
      const passwordError = 'Mật khẩu không đáp ứng chính sách của tổ chức.';
      await pumpUntil(
        tester,
        () => find.text(passwordError).evaluate().isNotEmpty,
        reason: 'the structured password-policy rejection to be shown',
      );
      expect(owner.outcome, isNull);
      expect(client.requests, hasLength(1));
      expect(find.text('Private password-policy details.'), findsNothing);

      await tester.enterText(fields.at(0), correctedPassword);
      await tester.enterText(fields.at(1), correctedPassword);
      expect(find.text(passwordError), findsNothing);
      await tester.tap(submit);
      await pumpUntil(
        tester,
        () => owner.outcome?.kind == CredentialOutcomeKind.completed,
        reason: 'the corrected password to be explicitly resubmitted',
      );
      expect(client.requests, hasLength(2));
      expect(_body(client.requests.last), {
        'token': capability,
        'password': correctedPassword,
      });
      await tester.pumpWidget(const SizedBox.shrink());
    });
  }

  for (final status in [200, 503, 404]) {
    test('a terminal attempt cannot be replayed with a replacement controller ($status)', () async {
      final client = RecordingHttpClient((request) async {
        expect(request.url.path, '/api/v1/auth/password-reset');
        if (status == 200) {
          return jsonResponse(
            200,
            successEnvelope({'message': 'Acknowledged.'}),
          );
        }
        return jsonResponse(
          status,
          errorEnvelope(
            status == 404 ? 'RESOURCE_NOT_FOUND' : 'SERVICE_UNAVAILABLE',
            'Private server details.',
          ),
        );
      });
      final api = _api(client);
      final owner = CredentialWorkflowOwner(api);
      addTearDown(client.close);
      addTearDown(api.dispose);
      addTearDown(owner.dispose);
      await api.initialize();
      final attempt = owner.begin(AccountOperation.reset);
      final first = AccountSubmissionController(AccountOperation.reset);
      await owner.submit(attempt, first, 'opaque', 'password');
      final expected = switch (status) {
        200 => CredentialOutcomeKind.completed,
        503 => CredentialOutcomeKind.uncertain,
        _ => CredentialOutcomeKind.unavailable,
      };
      expect(owner.outcome?.kind, expected);
      first.dispose();

      final replacement = AccountSubmissionController(AccountOperation.reset);
      addTearDown(replacement.dispose);
      await owner.submit(attempt, replacement, 'opaque', 'password');
      expect(client.requests, hasLength(1));
      expect(owner.outcome?.kind, expected);
    });
  }

  test('an in-flight attempt cannot be dispatched through a replacement controller', () async {
    final started = Completer<void>();
    final response = Completer<http.StreamedResponse>();
    final client = RecordingHttpClient((request) {
      started.complete();
      return response.future;
    });
    final api = _api(client);
    final owner = CredentialWorkflowOwner(api);
    addTearDown(client.close);
    addTearDown(api.dispose);
    addTearDown(owner.dispose);
    await api.initialize();
    final attempt = owner.begin(AccountOperation.reset);
    final first = AccountSubmissionController(AccountOperation.reset);
    final pending = owner.submit(attempt, first, 'opaque', 'password');
    await started.future;
    first.dispose();

    final replacement = AccountSubmissionController(AccountOperation.reset);
    addTearDown(replacement.dispose);
    await owner.submit(attempt, replacement, 'opaque', 'password');
    expect(client.requests, hasLength(1));

    response.complete(
      await jsonResponse(
        200,
        successEnvelope({'message': 'Acknowledged.'}),
      ),
    );
    await pending;
    expect(owner.outcome?.kind, CredentialOutcomeKind.completed);
    expect(client.requests, hasLength(1));
  });

  test('confirmed rejection remains retryable through a replacement controller', () async {
    var calls = 0;
    final client = RecordingHttpClient((request) async {
      calls++;
      if (calls == 1) {
        return jsonResponse(422, {
          ...errorEnvelope('VALIDATION_FAILED', 'Private server details.'),
          'errors': [
            {
              'field': 'password',
              'code': 'PASSWORD_POLICY_VIOLATION',
              'message': 'Private password-policy details.',
            },
          ],
        });
      }
      return jsonResponse(
        200,
        successEnvelope({'message': 'Acknowledged.'}),
      );
    });
    final api = _api(client);
    final owner = CredentialWorkflowOwner(api);
    addTearDown(client.close);
    addTearDown(api.dispose);
    addTearDown(owner.dispose);
    await api.initialize();
    final attempt = owner.begin(AccountOperation.reset);
    final first = AccountSubmissionController(AccountOperation.reset);
    await owner.submit(attempt, first, 'opaque', 'rejected password');
    expect(first.failure?.kind, AccountFailureKind.rejected);
    expect(owner.outcome, isNull);
    first.dispose();

    final replacement = AccountSubmissionController(AccountOperation.reset);
    addTearDown(replacement.dispose);
    await owner.submit(attempt, replacement, 'opaque', 'corrected password');
    expect(client.requests, hasLength(2));
    expect(owner.outcome?.kind, CredentialOutcomeKind.completed);
  });

  test('throttled attempt remains retryable only after its server deadline', () async {
    var now = DateTime.utc(2026, 11, 26);
    var calls = 0;
    final client = RecordingHttpClient((request) async {
      calls++;
      if (calls == 1) {
        return streamedResponse(
          429,
          body: utf8.encode(
            jsonEncode(errorEnvelope('RATE_LIMIT_EXCEEDED', 'Private details.')),
          ),
          headers: const {
            'content-type': 'application/json',
            'retry-after': '10',
          },
        );
      }
      return jsonResponse(
        200,
        successEnvelope({'message': 'Acknowledged.'}),
      );
    });
    final api = _api(client);
    final owner = CredentialWorkflowOwner(api);
    final deadlines = AccountRetryDeadlines();
    addTearDown(client.close);
    addTearDown(api.dispose);
    addTearDown(owner.dispose);
    addTearDown(deadlines.dispose);
    await api.initialize();
    final attempt = owner.begin(AccountOperation.reset);
    final first = AccountSubmissionController(
      AccountOperation.reset,
      now: () => now,
      retryDeadlines: deadlines,
    );
    await owner.submit(attempt, first, 'opaque', 'password');
    expect(first.failure?.kind, AccountFailureKind.throttled);
    expect(owner.outcome, isNull);
    first.dispose();

    final replacement = AccountSubmissionController(
      AccountOperation.reset,
      now: () => now,
      retryDeadlines: deadlines,
    );
    addTearDown(replacement.dispose);
    await owner.submit(attempt, replacement, 'opaque', 'password');
    expect(client.requests, hasLength(1));
    now = now.add(const Duration(seconds: 10));
    await owner.submit(attempt, replacement, 'opaque', 'password');
    expect(client.requests, hasLength(2));
    expect(owner.outcome?.kind, CredentialOutcomeKind.completed);
  });

  for (final operation in [AccountOperation.reset, AccountOperation.setup]) {
    testWidgets('authenticated uncertain outcome preserves current-session guidance: $operation', (
      tester,
    ) async {
      await tester.pumpWidget(
        MaterialApp(
          home: AuthLayout(
            child: CredentialOutcomeView(
              outcome: CredentialOutcome(
                operation,
                CredentialOutcomeKind.uncertain,
              ),
              authenticated: true,
              onContinue: () {},
            ),
          ),
        ),
      );
      expect(find.text('Tiếp tục phiên hiện tại'), findsOneWidget);
      expect(
        find.textContaining('Phiên đăng nhập hiện tại đã được xác minh'),
        findsOneWidget,
      );
      expect(find.textContaining('đăng xuất trước'), findsOneWidget);
      expect(find.textContaining('Không gửi lại yêu cầu này'), findsOneWidget);
      expect(
        find.textContaining('Hãy thử đăng nhập bằng mật khẩu vừa chọn'),
        findsNothing,
      );
      await tester.pumpWidget(const SizedBox.shrink());
    });
  }
}
