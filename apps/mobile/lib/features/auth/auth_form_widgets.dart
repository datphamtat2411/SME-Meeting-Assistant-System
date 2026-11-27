import 'package:flutter/material.dart';

import '../../core/app_theme.dart';
import '../../core/widgets.dart';

class AuthLayout extends StatelessWidget {
  const AuthLayout({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) => Scaffold(
    body: SafeArea(
      child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 440),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const CircleAvatar(
                  radius: 28,
                  backgroundColor: Palette.ink,
                  child: Icon(
                    Icons.graphic_eq_rounded,
                    color: Colors.white,
                    size: 28,
                  ),
                ),
                const SizedBox(height: 16),
                const Text(
                  'SME Meeting Assistant',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 23, fontWeight: FontWeight.w800),
                ),
                const SizedBox(height: 6),
                Text(
                  'Quản lý cuộc họp và tri thức doanh nghiệp',
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
                const SizedBox(height: 26),
                child,
                const SizedBox(height: 12),
                const Text(
                  'Chỉ tài khoản được tổ chức cấp mới có thể truy cập.',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 12),
                ),
              ],
            ),
          ),
        ),
      ),
    ),
  );
}

class AuthPasswordField extends StatefulWidget {
  const AuthPasswordField({
    super.key,
    required this.controller,
    required this.label,
    required this.validator,
    required this.enabled,
    required this.autofillHint,
    this.errorText,
    this.onChanged,
  });

  final TextEditingController controller;
  final String label;
  final FormFieldValidator<String> validator;
  final bool enabled;
  final String autofillHint;
  final String? errorText;
  final ValueChanged<String>? onChanged;

  @override
  State<AuthPasswordField> createState() => _AuthPasswordFieldState();
}

class _AuthPasswordFieldState extends State<AuthPasswordField> {
  bool _obscure = true;

  @override
  Widget build(BuildContext context) => TextFormField(
    controller: widget.controller,
    enabled: widget.enabled,
    obscureText: _obscure,
    autocorrect: false,
    enableSuggestions: false,
    autofillHints: [widget.autofillHint],
    validator: widget.validator,
    onChanged: widget.onChanged,
    decoration: InputDecoration(
      labelText: widget.label,
      errorText: widget.errorText,
      prefixIcon: const Icon(Icons.lock_outline),
      suffixIcon: IconButton(
        onPressed: widget.enabled
            ? () => setState(() => _obscure = !_obscure)
            : null,
        tooltip: _obscure ? 'Hiện mật khẩu' : 'Ẩn mật khẩu',
        icon: Icon(
          _obscure ? Icons.visibility_outlined : Icons.visibility_off_outlined,
        ),
      ),
    ),
  );
}

class AuthFeedback extends StatelessWidget {
  const AuthFeedback({super.key, required this.message, this.isError = false});

  final String message;
  final bool isError;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: ContentCard(
      child: Semantics(
        liveRegion: true,
        child: Text(
          message,
          textAlign: TextAlign.center,
          style: isError
              ? TextStyle(color: Theme.of(context).colorScheme.error)
              : null,
        ),
      ),
    ),
  );
}

class AuthSubmitButton extends StatelessWidget {
  const AuthSubmitButton({
    super.key,
    required this.label,
    required this.busy,
    required this.onPressed,
  });

  final String label;
  final bool busy;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) => FilledButton(
    onPressed: busy ? null : onPressed,
    child: busy
        ? const SizedBox(
            height: 20,
            width: 20,
            child: CircularProgressIndicator(strokeWidth: 2),
          )
        : Text(label),
  );
}
