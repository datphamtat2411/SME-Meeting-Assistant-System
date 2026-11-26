import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import 'account_flow.dart';
import 'account_forms.dart';
import 'account_link_coordinator.dart';
import 'auth_form_widgets.dart';
import 'credential_workflow.dart';

class AccountLinkPasteView extends StatefulWidget {
  const AccountLinkPasteView({super.key, required this.accept});

  final String? Function(String) accept;

  @override
  State<AccountLinkPasteView> createState() => _AccountLinkPasteViewState();
}

class _AccountLinkPasteViewState extends State<AccountLinkPasteView> {
  final _input = TextEditingController();
  String? _error;

  void _submit() {
    final error = widget.accept(_input.text);
    if (error != null) {
      setState(() => _error = error);
      return;
    }
    _input.clear();
    Navigator.of(context).pop(true);
  }

  @override
  void dispose() {
    _input.clear();
    _input.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AuthLayout(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'Mở liên kết tài khoản',
          style: Theme.of(context).textTheme.titleLarge,
        ),
        const SizedBox(height: 12),
        const Text(
          'Dán toàn bộ liên kết thiết lập tài khoản hoặc khôi phục mật khẩu '
          'từ email của bạn. Bạn cũng có thể mở email bằng trình duyệt.',
        ),
        const SizedBox(height: 12),
        TextFormField(
          controller: _input,
          obscureText: true,
          autocorrect: false,
          enableSuggestions: false,
          decoration: const InputDecoration(labelText: 'Liên kết từ email'),
        ),
        const SizedBox(height: 12),
        if (_error != null) AuthFeedback(message: _error!, isError: true),
        FilledButton(onPressed: _submit, child: const Text('Tiếp tục')),
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: const Text('Quay lại'),
        ),
      ],
    ),
  );
}

/// A public account route inside the current session-scoped Navigator.
/// The app root presents the same outcome if reconciliation replaces it.
class AccountLinkEntryView extends StatefulWidget {
  const AccountLinkEntryView({
    super.key,
    required this.ticket,
    required this.api,
    required this.owner,
    required this.retryDeadlines,
    required this.canDispatch,
  });

  final AccountLinkTicket ticket;
  final ApiClient api;
  final CredentialWorkflowOwner owner;
  final AccountRetryDeadlines retryDeadlines;
  final bool Function() canDispatch;

  @override
  State<AccountLinkEntryView> createState() => _AccountLinkEntryViewState();
}

class _AccountLinkEntryViewState extends State<AccountLinkEntryView> {
  String? _capability;
  bool _recovery = false;
  bool _closing = false;

  @override
  void initState() {
    super.initState();
    _capability = widget.ticket.takeCapability();
  }

  void _continue() {
    if (_closing ||
        widget.owner.hasInFlight ||
        widget.retryDeadlines.hasActiveSubmission) {
      return;
    }
    setState(() {
      _closing = true;
      _capability = null;
    });
    widget.owner.dismiss();
    Navigator.of(context).pop();
  }

  void _requestRecovery() {
    if (_closing ||
        widget.owner.hasInFlight ||
        widget.retryDeadlines.hasActiveSubmission) {
      return;
    }
    setState(() {
      _recovery = true;
      _capability = null;
    });
    widget.owner.dismiss();
  }

  @override
  void dispose() {
    _capability = null;
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([widget.owner, widget.retryDeadlines]),
    builder: (context, _) {
      final outcome = widget.owner.outcome;
      final pending =
          widget.owner.hasInFlight || widget.retryDeadlines.hasActiveSubmission;
      if (outcome != null) _capability = null;
      final capability = _capability;
      return PopScope(
        canPop: !pending && (outcome == null || _closing),
        child: AuthLayout(
          child: _closing
              ? const SizedBox.shrink()
              : outcome != null
              ? CredentialOutcomeView(
                  outcome: outcome,
                  authenticated: widget.api.signedIn,
                  onContinue: _continue,
                  onRecovery: _requestRecovery,
                )
              : _recovery
              ? RecoveryRequestForm(
                  api: widget.api,
                  retryDeadlines: widget.retryDeadlines,
                  onBack: _continue,
                )
              : capability == null
              ? const AuthFeedback(
                  message: 'Hãy mở lại liên kết từ email.',
                  isError: true,
                )
              : CredentialEstablishmentForm(
                  api: widget.api,
                  operation: widget.ticket.operation,
                  capability: capability,
                  owner: widget.owner,
                  retryDeadlines: widget.retryDeadlines,
                  canDispatch: widget.canDispatch,
                  onBack: _continue,
                  onRecovery: _requestRecovery,
                  backLabel: 'Hủy và quay lại',
                ),
        ),
      );
    },
  );
}
