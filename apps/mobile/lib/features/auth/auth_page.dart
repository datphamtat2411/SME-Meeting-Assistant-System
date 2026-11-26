import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import 'account_flow.dart';
import 'account_forms.dart';
import 'auth_form_widgets.dart';
import 'login_form.dart';

enum _AuthDestination { login, recovery, reset, setup }

/// Public workflow navigation only; no shared credentials or submission state.
class AuthPage extends StatefulWidget {
  const AuthPage({super.key, required this.api});

  final ApiClient api;

  @override
  State<AuthPage> createState() => _AuthPageState();
}

class _AuthPageState extends State<AuthPage> {
  _AuthDestination _destination = _AuthDestination.login;
  String? _notice;

  void _select(_AuthDestination next, {String? notice}) {
    setState(() {
      _destination = next;
      _notice = notice;
    });
  }

  @override
  Widget build(BuildContext context) => AuthLayout(
    child: switch (_destination) {
      _AuthDestination.login => LoginForm(
        api: widget.api,
        notice: _notice,
        onRecovery: () => _select(_AuthDestination.recovery),
        onReset: () => _select(_AuthDestination.reset),
        onSetup: () => _select(_AuthDestination.setup),
      ),
      _AuthDestination.recovery => RecoveryRequestForm(
        api: widget.api,
        onBack: () => _select(_AuthDestination.login),
      ),
      _AuthDestination.reset || _AuthDestination.setup =>
        CredentialEstablishmentForm(
          key: ValueKey(_destination),
          api: widget.api,
          operation: _destination == _AuthDestination.reset
              ? AccountOperation.reset
              : AccountOperation.setup,
          onBack: () => _select(_AuthDestination.login),
          onCompleted: (notice) =>
              _select(_AuthDestination.login, notice: notice),
        ),
    },
  );
}
