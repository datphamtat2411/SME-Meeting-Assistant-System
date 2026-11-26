import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/api_client.dart';
import '../../core/widgets.dart';
import 'account_flow.dart';
import 'auth_form_widgets.dart';

class LoginForm extends StatefulWidget {
  const LoginForm({
    super.key,
    required this.api,
    required this.onRecovery,
    required this.onReset,
    required this.onSetup,
    this.notice,
  });

  final ApiClient api;
  final VoidCallback onRecovery;
  final VoidCallback onReset;
  final VoidCallback onSetup;
  final String? notice;

  @override
  State<LoginForm> createState() => _LoginFormState();
}

class _LoginFormState extends State<LoginForm> {
  final _form = GlobalKey<FormState>();
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _submitting = false;
  String? _localFailure;
  Timer? _retryTimer;

  bool get _busy =>
      _submitting || widget.api.sessionCoordinator.isInteractiveSignIn;

  @override
  void initState() {
    super.initState();
    widget.api.addListener(_sessionChanged);
    _scheduleRetry();
  }

  @override
  void didUpdateWidget(LoginForm oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.api != widget.api) {
      oldWidget.api.removeListener(_sessionChanged);
      widget.api.addListener(_sessionChanged);
      _scheduleRetry();
    }
  }

  void _sessionChanged() {
    if (!mounted) return;
    _scheduleRetry();
    setState(() {});
  }

  void _scheduleRetry() {
    _retryTimer?.cancel();
    final remaining = widget.api.sessionCoordinator.retryRemaining;
    if (remaining > Duration.zero) {
      _retryTimer = Timer(remaining, () {
        if (mounted) setState(() {});
      });
    }
  }

  Future<void> _submit() async {
    if (_busy ||
        widget.api.sessionCoordinator.retryRemaining > Duration.zero ||
        !(_form.currentState?.validate() ?? false)) {
      return;
    }
    final email = _email.text.trim();
    final password = _password.text;
    setState(() {
      _submitting = true;
      _localFailure = null;
    });
    try {
      await widget.api.signIn(email, password);
      if (mounted && widget.api.signedIn) {
        TextInput.finishAutofillContext();
      }
    } catch (_) {
      if (mounted && widget.api.sessionState.failure == null) {
        _localFailure = 'Không thể hoàn tất đăng nhập. Vui lòng thử lại.';
      }
    } finally {
      if (mounted) {
        _password.clear();
        setState(() => _submitting = false);
      }
    }
  }

  void _leave(VoidCallback destination) {
    if (_busy) return;
    _password.clear();
    destination();
  }

  @override
  void dispose() {
    widget.api.removeListener(_sessionChanged);
    _retryTimer?.cancel();
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final session = widget.api.sessionState;
    final remaining = widget.api.sessionCoordinator.retryRemaining;
    final failure = session.failure;
    final message = failure?.message ?? _localFailure;
    final verifying = session.phase == AuthSessionPhase.verifyingIdentity;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (widget.notice != null) AuthFeedback(message: widget.notice!),
        if (session.notice != null) AuthFeedback(message: session.notice!),
        if (!_busy && message != null)
          AuthFeedback(message: message, isError: true),
        if (remaining > Duration.zero)
          const AuthFeedback(
            message: 'Vui lòng chờ hết thời hạn giới hạn trước khi thử lại.',
          ),
        ContentCard(
          child: AutofillGroup(
            onDisposeAction: AutofillContextAction.cancel,
            child: Form(
              key: _form,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    'Đăng nhập hệ thống',
                    style: Theme.of(context).textTheme.titleLarge
                        ?.copyWith(fontWeight: FontWeight.w800),
                  ),
                  const SizedBox(height: 18),
                  TextFormField(
                    controller: _email,
                    enabled: !_busy,
                    decoration: const InputDecoration(
                      labelText: 'Email doanh nghiệp',
                      prefixIcon: Icon(Icons.mail_outline),
                    ),
                    keyboardType: TextInputType.emailAddress,
                    autofillHints: const [AutofillHints.username],
                    validator: AuthValidators.email,
                  ),
                  const SizedBox(height: 14),
                  AuthPasswordField(
                    controller: _password,
                    enabled: !_busy,
                    label: 'Mật khẩu',
                    validator: AuthValidators.loginPassword,
                    autofillHint: AutofillHints.password,
                  ),
                  const SizedBox(height: 18),
                  if (_busy)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: Text(
                        verifying
                            ? 'Đang xác minh danh tính...'
                            : 'Đang đăng nhập...',
                        textAlign: TextAlign.center,
                      ),
                    ),
                  AuthSubmitButton(
                    label: 'Đăng nhập',
                    busy: _busy,
                    onPressed: remaining > Duration.zero ? null : _submit,
                  ),
                  Align(
                    alignment: Alignment.centerRight,
                    child: TextButton(
                      onPressed: _busy ? null : () => _leave(widget.onRecovery),
                      child: const Text('Quên mật khẩu?'),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
        TextButton(
          onPressed: _busy ? null : () => _leave(widget.onSetup),
          child: const Text('Đã nhận lời mời? Kích hoạt tài khoản'),
        ),
        TextButton(
          onPressed: _busy ? null : () => _leave(widget.onReset),
          child: const Text('Đã có mã khôi phục?'),
        ),
      ],
    );
  }
}
