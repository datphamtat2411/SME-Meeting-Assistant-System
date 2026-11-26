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
}
