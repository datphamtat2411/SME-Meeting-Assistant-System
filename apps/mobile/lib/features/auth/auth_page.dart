import 'package:flutter/material.dart';

import '../../core/api_client.dart';
import '../../core/app_theme.dart';
import '../../core/widgets.dart';

enum _AuthMode { login, recovery, reset, setup }

class AuthPage extends StatefulWidget {
  final ApiClient api;
  const AuthPage({super.key, required this.api});

  @override
  State<AuthPage> createState() => _AuthPageState();
}

class _AuthPageState extends State<AuthPage> {
  final form = GlobalKey<FormState>();
  final email = TextEditingController();
  final password = TextEditingController();
  final token = TextEditingController();
  _AuthMode mode = _AuthMode.login;
  bool busy = false;
  bool obscure = true;
  String? outcome;

  @override
  void dispose() {
    email.dispose();
    password.dispose();
    token.dispose();
    super.dispose();
  }

  Future<void> submit() async {
    if (!(form.currentState?.validate() ?? false)) return;
    setState(() { busy = true; outcome = null; });
    try {
      switch (mode) {
        case _AuthMode.login:
          await widget.api.signIn(email.text, password.text);
        case _AuthMode.recovery:
          await widget.api.post('/auth/password-recovery', {'email': email.text.trim()});
          if (mounted) setState(() => outcome = 'Nếu tài khoản hợp lệ, email khôi phục sẽ được gửi.');
        case _AuthMode.reset:
          await widget.api.post('/auth/password-reset',
              {'token': token.text.trim(), 'password': password.text});
          if (mounted) {
            setState(() { mode = _AuthMode.login; outcome = 'Đặt lại mật khẩu thành công.'; });
          }
        case _AuthMode.setup:
          await widget.api.post('/auth/account-setup',
              {'token': token.text.trim(), 'password': password.text});
          if (mounted) {
            setState(() { mode = _AuthMode.login; outcome = 'Kích hoạt tài khoản thành công.'; });
          }
      }
    } catch (error) {
      if (mounted) showFailure(context, error);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  void select(_AuthMode next) => setState(() {
    mode = next;
    outcome = null;
    form.currentState?.reset();
  });

  @override
  Widget build(BuildContext context) {
    final login = mode == _AuthMode.login;
    final recovery = mode == _AuthMode.recovery;
    final title = switch (mode) {
      _AuthMode.login => 'Đăng nhập hệ thống',
      _AuthMode.recovery => 'Quên mật khẩu',
      _AuthMode.reset => 'Đặt lại mật khẩu',
      _AuthMode.setup => 'Kích hoạt tài khoản',
    };
    return Scaffold(
      body: SafeArea(child: Center(child: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: ConstrainedBox(constraints: const BoxConstraints(maxWidth: 440),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            const CircleAvatar(
              radius: 28, backgroundColor: Palette.ink,
              child: Icon(Icons.graphic_eq_rounded, color: Colors.white, size: 28)),
            const SizedBox(height: 16),
            const Text('SME Meeting Assistant', textAlign: TextAlign.center,
              style: TextStyle(fontSize: 23, fontWeight: FontWeight.w800)),
            const SizedBox(height: 6),
            const Text('Quản lý cuộc họp và tri thức doanh nghiệp',
              textAlign: TextAlign.center, style: TextStyle(color: Palette.muted)),
            const SizedBox(height: 26),
            ContentCard(child: Form(key: form, child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Text(title, style: Theme.of(context).textTheme.titleLarge?.copyWith(
                  fontWeight: FontWeight.w800)),
                const SizedBox(height: 18),
                if (login || recovery) ...[
                  TextFormField(
                    controller: email,
                    decoration: const InputDecoration(labelText: 'Email doanh nghiệp',
                      prefixIcon: Icon(Icons.mail_outline)),
                    keyboardType: TextInputType.emailAddress,
                    autofillHints: const [AutofillHints.email],
                    validator: (v) => v == null || !v.contains('@')
                        ? 'Email không hợp lệ.' : null,
                  ),
                  const SizedBox(height: 14),
                ],
                if (!login && !recovery) ...[
                  TextFormField(
                    controller: token,
                    decoration: const InputDecoration(labelText: 'Mã xác thực',
                      prefixIcon: Icon(Icons.key_outlined)),
                    validator: (v) => v == null || v.trim().isEmpty
                        ? 'Vui lòng nhập mã từ email.' : null,
                  ),
                  const SizedBox(height: 14),
                ],
                if (!recovery) ...[
                  TextFormField(
                    controller: password, obscureText: obscure,
                    decoration: InputDecoration(
                      labelText: login ? 'Mật khẩu' : 'Mật khẩu mới',
                      prefixIcon: const Icon(Icons.lock_outline),
                      suffixIcon: IconButton(
                        onPressed: () => setState(() => obscure = !obscure),
                        icon: Icon(obscure ? Icons.visibility_outlined : Icons.visibility_off_outlined))),
                    validator: (v) => v == null || v.isEmpty
                        ? 'Vui lòng nhập mật khẩu.'
                        : !login && v.runes.length < 15
                            ? 'Mật khẩu mới cần ít nhất 15 ký tự.' : null,
                  ),
                  const SizedBox(height: 18),
                ],
                if (outcome != null) Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Text(outcome!, style: const TextStyle(color: Palette.green))),
                FilledButton(
                  onPressed: busy ? null : submit,
                  child: busy ? const SizedBox(height: 20, width: 20,
                    child: CircularProgressIndicator(strokeWidth: 2))
                    : Text(login ? 'Đăng nhập' : recovery ? 'Gửi yêu cầu' : 'Xác nhận'),
                ),
                if (login) Align(alignment: Alignment.centerRight,
                  child: TextButton(onPressed: () => select(_AuthMode.recovery),
                    child: const Text('Quên mật khẩu?'))),
                if (!login) TextButton(onPressed: () => select(_AuthMode.login),
                  child: const Text('Quay lại đăng nhập')),
              ],
            ))),
            if (login) ...[
              TextButton(onPressed: () => select(_AuthMode.setup),
                child: const Text('Đã nhận lời mời? Kích hoạt tài khoản')),
              TextButton(onPressed: () => select(_AuthMode.reset),
                child: const Text('Đã có mã khôi phục?')),
            ],
            const SizedBox(height: 12),
            const Text('Chỉ tài khoản được tổ chức cấp mới có thể truy cập.',
              textAlign: TextAlign.center,
              style: TextStyle(color: Palette.muted, fontSize: 12)),
          ]),
        ),
      ))),
    );
  }
}
