import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/api_client.dart';
import '../../core/widgets.dart';
import 'account_flow.dart';
import 'auth_form_widgets.dart';
import 'credential_workflow.dart';

/// Recovery owns the email and acknowledgement for one public workflow.
class RecoveryRequestForm extends StatefulWidget {
  const RecoveryRequestForm({
    super.key,
    required this.api,
    required this.onBack,
    required this.retryDeadlines,
    this.now,
  });

  final ApiClient api;
  final VoidCallback onBack;
  final AccountRetryDeadlines retryDeadlines;
  final DateTime Function()? now;

  @override
  State<RecoveryRequestForm> createState() => _RecoveryRequestFormState();
}

class _RecoveryRequestFormState extends State<RecoveryRequestForm> {
  final _form = GlobalKey<FormState>();
  final _email = TextEditingController();
  late final _submission = AccountSubmissionController(
    AccountOperation.recovery,
    now: widget.now,
    retryDeadlines: widget.retryDeadlines,
  );

  String? _acknowledgedEmail;
  bool _editingEmail = true;

  Future<void> _resend() async {
    final email = _acknowledgedEmail;
    if (email == null || _editingEmail || _submission.isSubmitting) return;
    _submission.startNewRecoveryRequest();
    if (!_submission.canSubmit) return;
    await _request(email);
  }

  void _changeEmail() {
    _submission.startNewRecoveryRequest();
    _submission.clearRejectedFeedback();
    setState(() {
      _acknowledgedEmail = null;
      _editingEmail = true;
    });
  }

  Future<void> _request(String email) async {
    await _submission.submit(() => widget.api.requestPasswordRecovery(email));
    if (!mounted) return;
    if (_submission.isCompleted) {
      setState(() {
        _acknowledgedEmail = email;
        _editingEmail = false;
      });
    }
  }

  Future<void> _submit() async {
    if (!_submission.canSubmit || !(_form.currentState?.validate() ?? false)) {
      return;
    }
    final email = _email.text.trim();
    await _request(email);
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
      if (!_editingEmail) {
        return ContentCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Icon(Icons.mark_email_read_outlined, size: 48),
              const SizedBox(height: 16),
              Text(
                'Kiểm tra email',
                style: Theme.of(context).textTheme.titleLarge,
              ),
              const SizedBox(height: 12),
              const Text(
                'Nếu tài khoản đủ điều kiện, hướng dẫn khôi phục '
                'sẽ được gửi qua email. Hãy kiểm tra hộp thư đến '
                'và thư rác, sau đó làm theo hướng dẫn trong email.',
              ),
              const SizedBox(height: 12),
              AccountRetryFeedback(submission: _submission),
              if (failure != null &&
                  failure.kind != AccountFailureKind.throttled)
                AuthFeedback(message: failure.message, isError: true),
              AuthSubmitButton(
                label: 'Gửi lại yêu cầu',
                busy: _submission.isSubmitting,
                onPressed:
                    !_submission.isSubmitting &&
                        _submission.retryRemaining == Duration.zero
                    ? _resend
                    : null,
              ),
              TextButton(
                onPressed: _submission.isSubmitting ? null : _changeEmail,
                child: const Text('Sử dụng email khác'),
              ),
              TextButton(
                onPressed: _submission.isSubmitting ? null : widget.onBack,
                child: const Text('Quay lại đăng nhập'),
              ),
            ],
          ),
        );
      }
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
              const SizedBox(height: 12),
              const Text(
                'Nhập email doanh nghiệp để yêu cầu hướng dẫn '
                'đặt lại mật khẩu.',
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
              AccountRetryFeedback(submission: _submission),
              if (failure != null &&
                  failure.field == null &&
                  failure.kind != AccountFailureKind.throttled)
                AuthFeedback(message: failure.message, isError: true),
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
    required this.owner,
    required this.onRecovery,
    required this.retryDeadlines,
    this.capability,
  }) : assert(operation != AccountOperation.recovery);

  final ApiClient api;
  final AccountOperation operation;
  final VoidCallback onBack;
  final CredentialWorkflowOwner owner;
  final VoidCallback onRecovery;
  final String? capability;
  final AccountRetryDeadlines retryDeadlines;

  @override
  State<CredentialEstablishmentForm> createState() =>
      _CredentialEstablishmentFormState();
}

class _CredentialEstablishmentFormState
    extends State<CredentialEstablishmentForm> {
  final _form = GlobalKey<FormState>();
  late final _token = TextEditingController(text: widget.capability);
  late final CredentialAttempt _attempt;
  final _password = TextEditingController();
  final _confirmation = TextEditingController();
  late final _submission = AccountSubmissionController(
    widget.operation,
    retryDeadlines: widget.retryDeadlines,
  );

  bool get _isReset => widget.operation == AccountOperation.reset;

  @override
  void initState() {
    super.initState();
    _attempt = widget.owner.begin(widget.operation);
  }

  @override
  void didUpdateWidget(covariant CredentialEstablishmentForm oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.operation != widget.operation ||
        oldWidget.capability != widget.capability ||
        oldWidget.owner != widget.owner) {
      throw StateError('A new credential input requires a new workflow.');
    }
  }

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
    if (!_submission.canSubmit || !(_form.currentState?.validate() ?? false)) {
      return;
    }
    final capability = _token.text;
    final password = _password.text;
    if (AuthValidators.capability(capability) != null) return;
    await widget.owner.submit(_attempt, _submission, capability, password);
    if (!mounted) return;
    if (_submission.isCompleted ||
        _submission.failure?.kind == AccountFailureKind.uncertain ||
        _submission.failure?.kind == AccountFailureKind.unavailable) {
      TextInput.finishAutofillContext(shouldSave: false);
      _clearSensitiveInput();
    }
  }

  @override
  void dispose() {
    widget.owner.abandon(_attempt);
    _submission.dispose();
    _clearSensitiveInput();
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
      final editable =
          !_submission.isSubmitting &&
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
                const SizedBox(height: 12),
                Text(
                  _isReset
                      ? 'Chọn mật khẩu mới. Mã khôi phục có hiệu lực tối đa '
                            '30 phút kể từ khi cấp.'
                      : 'Thiết lập mật khẩu cho tài khoản được tổ chức cấp. '
                            'Mã thiết lập có hiệu lực tối đa 24 giờ kể từ khi cấp.',
                ),
                const SizedBox(height: 18),
                if (widget.capability == null)
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
                if (widget.capability != null &&
                    AuthValidators.capability(widget.capability) != null)
                  const AuthFeedback(
                    message: 'Thông tin từ email không hợp lệ.',
                    isError: true,
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
                AccountRetryFeedback(submission: _submission),
                if (failure != null &&
                    failure.field == null &&
                    failure.kind != AccountFailureKind.throttled)
                  AuthFeedback(message: failure.message, isError: true),
                if (failure?.kind == AccountFailureKind.rejected &&
                    failure?.field == null)
                  if (_isReset)
                    TextButton(
                      onPressed: () {
                        _clearSensitiveInput();
                        widget.onRecovery();
                      },
                      child: const Text('Yêu cầu liên kết khôi phục mới'),
                    )
                  else
                    const Text(
                      'Mở lại lời mời hợp lệ hoặc liên hệ quản trị viên.',
                    ),
                AuthSubmitButton(
                  label: 'Xác nhận',
                  busy: _submission.isSubmitting,
                  onPressed:
                      _submission.canSubmit &&
                          (widget.capability == null ||
                              AuthValidators.capability(widget.capability) ==
                                  null)
                      ? _submit
                      : null,
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

class AccountRetryFeedback extends StatelessWidget {
  const AccountRetryFeedback({super.key, required this.submission});

  final AccountSubmissionController submission;

  @override
  Widget build(BuildContext context) {
    final message = submission.retryFeedback;
    return message == null
        ? const SizedBox.shrink()
        : AuthFeedback(message: message);
  }
}

class CredentialOutcomeView extends StatelessWidget {
  const CredentialOutcomeView({
    super.key,
    required this.outcome,
    required this.onContinue,
    required this.authenticated,
    this.onRecovery,
  });

  final CredentialOutcome outcome;
  final VoidCallback onContinue;
  final bool authenticated;
  final VoidCallback? onRecovery;

  @override
  Widget build(BuildContext context) {
    final reset = outcome.operation == AccountOperation.reset;
    final completed = outcome.kind == CredentialOutcomeKind.completed;
    final title = switch (outcome.kind) {
      CredentialOutcomeKind.completed =>
        reset
            ? 'Đặt lại mật khẩu thành công'
            : 'Kích hoạt tài khoản thành công',
      CredentialOutcomeKind.uncertain => 'Chưa xác nhận được kết quả',
      CredentialOutcomeKind.unavailable => reset
          ? 'Liên kết khôi phục không còn khả dụng'
          : 'Lời mời thiết lập không còn khả dụng',
    };
    final message = authenticated
        ? switch (outcome.kind) {
            CredentialOutcomeKind.completed =>
              reset
                  ? 'Mật khẩu của tài khoản được khôi phục đã được cập nhật. '
                        'Phiên đăng nhập hiện tại đã được xác minh và vẫn hoạt động. '
                        'Nếu muốn chuyển sang tài khoản vừa đặt lại, hãy đăng xuất '
                        'trước khi đăng nhập bằng tài khoản đó.'
                  : 'Tài khoản đã sẵn sàng. Phiên đăng nhập hiện tại vẫn hoạt động. '
                        'Nếu muốn sử dụng tài khoản vừa kích hoạt, hãy đăng xuất '
                        'trước rồi đăng nhập bằng email doanh nghiệp của tài khoản đó.',
            CredentialOutcomeKind.uncertain =>
              reset
                  ? 'Không thể xác nhận kết quả đặt lại mật khẩu. Phiên đăng nhập '
                        'hiện tại đã được xác minh và vẫn hoạt động. Không gửi lại '
                        'yêu cầu này. Nếu muốn đăng nhập bằng tài khoản vừa đặt lại, '
                        'hãy đăng xuất trước rồi thử mật khẩu vừa chọn; nếu không '
                        'đăng nhập được, hãy yêu cầu liên kết khôi phục mới.'
                  : 'Không thể xác nhận kết quả kích hoạt tài khoản. Phiên đăng nhập '
                        'hiện tại đã được xác minh và vẫn hoạt động. Không gửi lại '
                        'yêu cầu này. Nếu muốn sử dụng tài khoản vừa kích hoạt, hãy '
                        'đăng xuất trước; nếu không thể đăng nhập, hãy liên hệ quản '
                        'trị viên để được cấp lời mời mới.',
            CredentialOutcomeKind.unavailable =>
              reset
                  ? 'Liên kết khôi phục không còn khả dụng. Phiên đăng nhập hiện tại '
                        'vẫn hoạt động. Bạn có thể tiếp tục phiên này hoặc yêu cầu '
                        'một liên kết khôi phục mới.'
                  : 'Lời mời thiết lập không còn khả dụng. Phiên đăng nhập hiện tại '
                        'vẫn hoạt động. Bạn có thể tiếp tục phiên này hoặc yêu cầu '
                        'quản trị viên cấp lời mời mới.',
          }
        : switch (outcome.kind) {
            CredentialOutcomeKind.completed =>
              reset
                  ? 'Mật khẩu đã được cập nhật. Các phiên đăng nhập trước đó '
                        'của tài khoản được đặt lại đã bị thu hồi.'
                  : 'Tài khoản đã sẵn sàng. Hãy đăng nhập bằng email doanh nghiệp '
                        'và mật khẩu vừa thiết lập.',
            CredentialOutcomeKind.uncertain =>
              reset
                  ? 'Yêu cầu đặt lại mật khẩu có thể đã được xử lý. Hãy thử đăng '
                        'nhập bằng mật khẩu vừa chọn. Không gửi lại yêu cầu này.'
                  : 'Yêu cầu kích hoạt tài khoản có thể đã được xử lý. Hãy thử đăng '
                        'nhập bằng email doanh nghiệp và mật khẩu vừa thiết lập. '
                        'Không gửi lại yêu cầu này.',
            CredentialOutcomeKind.unavailable =>
              reset
                  ? 'Liên kết khôi phục không còn khả dụng. Có thể liên kết đã hết '
                        'hạn, đã được sử dụng hoặc không hợp lệ. Hãy yêu cầu liên '
                        'kết khôi phục mới.'
                  : 'Lời mời thiết lập không còn khả dụng. Hãy yêu cầu lời mời mới '
                        'từ tổ chức hoặc liên hệ quản trị viên.',
          };
    return ContentCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Icon(
            completed ? Icons.check_circle_outline : Icons.info_outline,
            size: 48,
          ),
          const SizedBox(height: 16),
          Text(title, style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 12),
          Semantics(liveRegion: true, child: Text(message)),
          if (!completed) ...[
            const SizedBox(height: 12),
            Text(
              reset
                  ? 'Nếu không thể đăng nhập, hãy yêu cầu liên kết khôi phục mới.'
                  : 'Nếu không thể đăng nhập, hãy mở lại lời mời hợp lệ '
                        'hoặc liên hệ quản trị viên để được cấp quyền thiết lập mới.',
            ),
          ],
          const SizedBox(height: 18),
          FilledButton(
            onPressed: onContinue,
            child: Text(
              authenticated ? 'Tiếp tục phiên hiện tại' : 'Tiếp tục đăng nhập',
            ),
          ),
          if (!completed && reset && onRecovery != null)
            TextButton(
              onPressed: onRecovery,
              child: const Text('Yêu cầu liên kết khôi phục mới'),
            ),
        ],
      ),
    );
  }
}
