import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import 'account_flow.dart';
import 'account_forms.dart';
import 'auth_form_widgets.dart';
import 'credential_workflow.dart';
import 'login_form.dart';

enum _AuthDestination { login, recovery }

/// Public workflow navigation. Link trust and retry ownership are app-scoped.
class AuthPage extends StatefulWidget {
  const AuthPage({
    super.key,
    required this.api,
    required this.credentialWorkflows,
    required this.retryDeadlines,
    required this.onOpenLink,
    this.showOutcome = true,
  });

  final ApiClient api;
  final CredentialWorkflowOwner credentialWorkflows;
  final AccountRetryDeadlines retryDeadlines;
  final VoidCallback onOpenLink;
  final bool showOutcome;

  @override
  State<AuthPage> createState() => _AuthPageState();
}

class _AuthPageState extends State<AuthPage> {
  _AuthDestination _destination = _AuthDestination.login;

  void _select(_AuthDestination next) {
    widget.credentialWorkflows.dismiss();
    setState(() => _destination = next);
  }

  @override
  Widget build(BuildContext context) => AuthLayout(
    child: ListenableBuilder(
      listenable: widget.credentialWorkflows,
      builder: (context, _) {
        final outcome = widget.credentialWorkflows.outcome;
        if (outcome != null && widget.showOutcome) {
          return CredentialOutcomeView(
            outcome: outcome,
            authenticated: false,
            onContinue: () => _select(_AuthDestination.login),
            onRecovery: () => _select(_AuthDestination.recovery),
          );
        }
        return switch (_destination) {
          _AuthDestination.login => LoginForm(
            api: widget.api,
            onRecovery: () => _select(_AuthDestination.recovery),
            onReset: widget.onOpenLink,
            onSetup: widget.onOpenLink,
          ),
          _AuthDestination.recovery => RecoveryRequestForm(
            api: widget.api,
            retryDeadlines: widget.retryDeadlines,
            onBack: () => _select(_AuthDestination.login),
          ),
        };
      },
    ),
  );
}
