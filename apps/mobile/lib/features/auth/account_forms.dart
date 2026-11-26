import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/api_client.dart';
import '../../core/widgets.dart';
import 'account_flow.dart';
import 'auth_form_widgets.dart';

/// Maintains the existing recovery entry point until Wave 02 completes the UX.
class RecoveryRequestForm extends StatefulWidget {
  const RecoveryRequestForm({
    super.key,
    required this.api,
    required this.onBack,
  });

  final ApiClient api;
  final VoidCallback onBack;

  @override
  State<RecoveryRequestForm> createState() => _RecoveryRequestFormState();
}

class _RecoveryRequestFormState extends State<RecoveryRequestForm> {
  final _form = GlobalKey<FormState>();
  final _email = TextEditingController();
  final _submission = AccountSubmissionController(AccountOperation.recovery);

  Future<void> _submit() async {
    if (!_submission.canSubmit ||
        !(_form.currentState?.validate() ?? false)) {
      return;
    }
    final email = _email.text.trim();
    await _submission.submit(() => widget.api.requestPasswordRecovery(email));
  }

  @override
  void dispose() {
    _submission.dispose();
    _email.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: _submission,
    builder: (context, _) {
      final failure = _submission.failure;
      return ContentCard(
        child: Form(
          key: _form,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                'Quên mật khẩu',
                style: Theme.of(context).textTheme.titleLarge
                    ?.copyWith(fontWeight: FontWeight.w800),
              ),
              const SizedBox(height: 18),
              TextFormField(
                controller: _email,
                enabled: !_submission.isSubmitting && !_submission.isCompleted,
                keyboardType: TextInputType.emailAddress,
                autofillHints: const [AutofillHints.email],
                validator: AuthValidators.email,
                onChanged: (_) => _submission.clearRejectedFeedback(),
                decoration: InputDecoration(
                  labelText: 'Email doanh nghiệp',
                  prefixIcon: const Icon(Icons.mail_outline),
                  errorText: failure?.field == AccountFailureField.email
                      ? failure?.message
                      : null,
                ),
              ),
              const SizedBox(height: 14),
              if (failure != null && failure.field == null)
                AuthFeedback(message: failure.message, isError: true),
              if (_submission.isCompleted)
                const AuthFeedback(
                  message: 'Nếu tài khoản đủ điều kiện, hướng dẫn khôi phục '
                      'sẽ được gửi qua email.',
                ),
              if (_submission.isCompleted)
                TextButton(
                  onPressed: _submission.startNewRecoveryRequest,
                  child: const Text('Gửi yêu cầu mới'),
                )
              else
                AuthSubmitButton(
                  label: 'Gửi yêu cầu',
                  busy: _submission.isSubmitting,
                  onPressed: _submission.canSubmit ? _submit : null,
                ),
              TextButton(
                onPressed: _submission.isSubmitting ? null : widget.onBack,
                child: const Text('Quay lại đăng nhập'),
              ),
            ],
          ),
        ),
      );
    },
  );
}

/// Both credential-establishment operations share form structure, but each
/// instance has a fixed purpose and independent sensitive state.
class CredentialEstablishmentForm extends StatefulWidget {
  const CredentialEstablishmentForm({
    super.key,
    required this.api,
    required this.operation,
    required this.onBack,
    required this.onCompleted,
  }) : assert(operation != AccountOperation.recovery);

  final ApiClient api;
  final AccountOperation operation;
  final VoidCallback onBack;
  final ValueChanged<String> onCompleted;

  @override
  State<CredentialEstablishmentForm> createState() =>
      _CredentialEstablishmentFormState();
}

class _CredentialEstablishmentFormState
    extends State<CredentialEstablishmentForm> {
  final _form = GlobalKey<FormState>();
  final _token = TextEditingController();
  final _password = TextEditingController();
  final _confirmation = TextEditingController();
  late final _submission = AccountSubmissionController(widget.operation);

  bool get _isReset => widget.operation == AccountOperation.reset;

  void _clearSensitiveInput() {
    _token.clear();
    _password.clear();
    _confirmation.clear();
  }

  void _back() {
    if (_submission.isSubmitting) return;
    _clearSensitiveInput();
    widget.onBack();
  }

  Future<void> _submit() async {
    if (!_submission.canSubmit ||
        !(_form.currentState?.validate() ?? false)) {
      return;
    }
    final capability = _token.text;
    final password = _password.text;
    await _submission.submit(
      () => _isReset
          ? widget.api.resetPassword(capability, password)
          : widget.api.completeAccountSetup(capability, password),
    );
    if (!mounted) return;
    if (_submission.isCompleted) {
      TextInput.finishAutofillContext(shouldSave: false);
      _clearSensitiveInput();
      widget.onCompleted(
        _isReset
            ? 'Đặt lại mật khẩu thành công.'
            : 'Kích hoạt tài khoản thành công.',
      );
    } else if (!_submission.canSubmit &&
        (_submission.failure?.kind == AccountFailureKind.uncertain ||
            _submission.failure?.kind == AccountFailureKind.unavailable)) {
      _clearSensitiveInput();
    }
  }

  @override
  void dispose() {
    _submission.dispose();
    _token.dispose();
    _password.dispose();
    _confirmation.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: _submission,
    builder: (context, _) {
      final failure = _submission.failure;
      final editable = !_submission.isSubmitting &&
          !_submission.isCompleted &&
          failure?.kind != AccountFailureKind.uncertain &&
          failure?.kind != AccountFailureKind.unavailable;
      return ContentCard(
        child: AutofillGroup(
          onDisposeAction: AutofillContextAction.cancel,
          child: Form(
            key: _form,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  _isReset ? 'Đặt lại mật khẩu' : 'Kích hoạt tài khoản',
                  style: Theme.of(context).textTheme.titleLarge
                      ?.copyWith(fontWeight: FontWeight.w800),
                ),
                const SizedBox(height: 18),
                TextFormField(
                  controller: _token,
                  enabled: editable,
                  obscureText: true,
                  autocorrect: false,
                  enableSuggestions: false,
                  validator: AuthValidators.capability,
                  onChanged: (_) => _submission.clearRejectedFeedback(),
                  decoration: const InputDecoration(
                    labelText: 'Mã xác thực',
                    prefixIcon: Icon(Icons.key_outlined),
                  ),
                ),
                const SizedBox(height: 14),
                AuthPasswordField(
                  controller: _password,
                  label: 'Mật khẩu mới',
                  enabled: editable,
                  validator: AuthValidators.newPassword,
                  autofillHint: AutofillHints.newPassword,
                  onChanged: (_) => _submission.clearRejectedFeedback(),
                  errorText: failure?.field == AccountFailureField.password
                      ? failure?.message
                      : null,
                ),
                const SizedBox(height: 14),
                AuthPasswordField(
                  controller: _confirmation,
                  label: 'Xác nhận mật khẩu',
                  enabled: editable,
                  validator: (value) =>
                      AuthValidators.confirmation(value, _password.text),
                  autofillHint: AutofillHints.newPassword,
                ),
                const SizedBox(height: 18),
                if (failure != null && failure.field == null)
                  AuthFeedback(message: failure.message, isError: true),
                AuthSubmitButton(
                  label: 'Xác nhận',
                  busy: _submission.isSubmitting,
                  onPressed: _submission.canSubmit ? _submit : null,
                ),
                TextButton(
                  onPressed: _submission.isSubmitting ? null : _back,
                  child: const Text('Quay lại đăng nhập'),
                ),
              ],
            ),
          ),
        ),
      );
    },
  );
}
