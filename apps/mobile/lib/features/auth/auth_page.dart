import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import 'account_flow.dart';
import 'account_forms.dart';
import 'auth_form_widgets.dart';
import 'credential_workflow.dart';
import 'login_form.dart';

enum _AuthDestination { login, recovery, reset, setup }

/// Public workflow navigation and non-sensitive retry deadlines.
class AuthPage extends StatefulWidget {
  const AuthPage({
    super.key,
    required this.api,
    required this.credentialWorkflows,
  });

  final ApiClient api;
  final CredentialWorkflowOwner credentialWorkflows;

  @override
  State<AuthPage> createState() => _AuthPageState();
}

class _AuthPageState extends State<AuthPage> {
  _AuthDestination _destination = _AuthDestination.login;
  final _retryDeadlines = AccountRetryDeadlines();

  @override
  void dispose() {
    _retryDeadlines.dispose();
    super.dispose();
  }

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
        if (outcome != null) {
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
            onReset: () => _select(_AuthDestination.reset),
            onSetup: () => _select(_AuthDestination.setup),
          ),
          _AuthDestination.recovery => RecoveryRequestForm(
            api: widget.api,
            retryDeadlines: _retryDeadlines,
            onBack: () => _select(_AuthDestination.login),
          ),
          _AuthDestination.reset ||
          _AuthDestination.setup => CredentialEstablishmentForm(
            key: ValueKey(_destination),
            api: widget.api,
            owner: widget.credentialWorkflows,
            retryDeadlines: _retryDeadlines,
            operation: _destination == _AuthDestination.reset
                ? AccountOperation.reset
                : AccountOperation.setup,
            onBack: () => _select(_AuthDestination.login),
            onRecovery: () => _select(_AuthDestination.recovery),
          ),
        };
      },
    ),
  );
}
