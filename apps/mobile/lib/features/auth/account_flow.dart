import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/api_client.dart';

enum AccountOperation {
  recovery,
  reset,
  setup;

  bool get establishesPassword => this != recovery;
}

enum AccountFailureKind { rejected, throttled, unavailable, uncertain }

enum AccountSubmissionPhase { ready, submitting, completed, failed }

enum AccountFailureField { email, password }

@immutable
class AccountFlowFailure {
  const AccountFlowFailure._({
    required this.kind,
    required this.message,
    this.field,
    this.retryAt,
    this.status,
    this.code,
    this.requestId,
  });

  final AccountFailureKind kind;
  final String message;
  final AccountFailureField? field;
  final DateTime? retryAt;
  final int? status;
  final String? code;
  final String? requestId;

  factory AccountFlowFailure.classify(
    Object error,
    AccountOperation operation, {
    required DateTime now,
  }) {
    final api = error is ApiFailure ? error : null;
    final kind = switch (api) {
      null => AccountFailureKind.uncertain,
      _ when api.invalidResponse ||
          api.remoteOutcomeAmbiguous ||
          api.transportFailure ||
          api.status == 408 ||
          api.status == 425 ||
          api.serverFailure =>
        AccountFailureKind.uncertain,
      _ when api.status == 429 => AccountFailureKind.throttled,
      _ when api.status == 404 => AccountFailureKind.unavailable,
      _ when api.status >= 400 && api.status < 500 =>
        AccountFailureKind.rejected,
      _ => AccountFailureKind.uncertain,
    };
    AccountFailureField? field;
    if (kind == AccountFailureKind.rejected &&
        (api?.status == 400 || api?.status == 422)) {
      final fields = api!.errors.map((error) => error.fieldPath).toSet();
      if (operation == AccountOperation.recovery &&
          fields.length == 1 &&
          fields.contains('email')) {
        field = AccountFailureField.email;
      } else if (operation.establishesPassword &&
          fields.length == 1 &&
          fields.contains('password')) {
        field = AccountFailureField.password;
      }
    }
    final delay = kind == AccountFailureKind.throttled
        ? api?.retryAfterDuration(now: now)
        : null;
    final message = switch (kind) {
      AccountFailureKind.throttled =>
        'Máy chủ đang giới hạn yêu cầu. Vui lòng chờ trước khi thử lại.',
      AccountFailureKind.unavailable =>
        'Tính năng hiện không khả dụng. Vui lòng thử lại sau hoặc liên hệ quản trị viên.',
      AccountFailureKind.uncertain =>
        operation == AccountOperation.recovery
            ? 'Không thể xác nhận yêu cầu. Hãy kiểm tra email trước khi gửi lại.'
            : 'Không thể xác nhận kết quả. Mật khẩu có thể đã được cập nhật. '
                  'Hãy thử đăng nhập hoặc yêu cầu hướng dẫn mới.',
      AccountFailureKind.rejected => switch (field) {
        AccountFailureField.email => 'Email không hợp lệ.',
        AccountFailureField.password =>
          'Mật khẩu không đáp ứng chính sách của tổ chức.',
        null => operation.establishesPassword
            ? 'Liên kết có thể không hợp lệ, đã hết hạn hoặc mật khẩu '
                  'không đáp ứng chính sách của tổ chức.'
            : 'Yêu cầu không được chấp nhận. Vui lòng kiểm tra thông tin.',
      },
    };
    return AccountFlowFailure._(
      kind: kind,
      message: message,
      field: field,
      retryAt: delay == null ? null : now.add(delay),
      status: api?.status,
      code: api?.code,
      requestId: api?.requestId,
    );
  }
}

/// One submission owner per workflow. Never stores passwords or capabilities.
class AccountSubmissionController extends ChangeNotifier {
  AccountSubmissionController(this.operation, {DateTime Function()? now})
    : _now = now ?? DateTime.now;

  final AccountOperation operation;
  final DateTime Function() _now;
  AccountSubmissionPhase _phase = AccountSubmissionPhase.ready;
  AccountFlowFailure? _failure;
  Timer? _retryTimer;
  bool _disposed = false;

  AccountSubmissionPhase get phase => _phase;
  AccountFlowFailure? get failure => _failure;
  bool get isSubmitting => _phase == AccountSubmissionPhase.submitting;
  bool get isCompleted => _phase == AccountSubmissionPhase.completed;

  Duration get retryRemaining {
    final remaining = _failure?.retryAt?.difference(_now());
    return remaining != null && remaining > Duration.zero
        ? remaining
        : Duration.zero;
  }

  bool get canSubmit {
    if (_disposed || isSubmitting || isCompleted) return false;
    if (retryRemaining > Duration.zero) return false;
    if (operation.establishesPassword &&
        (_failure?.kind == AccountFailureKind.uncertain ||
            _failure?.kind == AccountFailureKind.unavailable)) {
      return false;
    }
    return true;
  }

  Future<void> submit(Future<void> Function() dispatch) async {
    if (!canSubmit) return;
    _retryTimer?.cancel();
    _failure = null;
    _phase = AccountSubmissionPhase.submitting;
    notifyListeners();
    try {
      await dispatch();
      if (_disposed) return;
      _phase = AccountSubmissionPhase.completed;
    } catch (error) {
      if (_disposed) return;
      _failure = AccountFlowFailure.classify(error, operation, now: _now());
      _phase = AccountSubmissionPhase.failed;
      final remaining = retryRemaining;
      if (remaining > Duration.zero) {
        _retryTimer = Timer(remaining, () {
          if (!_disposed) notifyListeners();
        });
      }
    }
    if (!_disposed) notifyListeners();
  }

  void clearRejectedFeedback() {
    if (_disposed || _failure?.kind != AccountFailureKind.rejected) return;
    _failure = null;
    _phase = AccountSubmissionPhase.ready;
    notifyListeners();
  }

  void startNewRecoveryRequest() {
    if (_disposed || operation.establishesPassword || !isCompleted) return;
    _phase = AccountSubmissionPhase.ready;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _retryTimer?.cancel();
    super.dispose();
  }
}

class AuthValidators {
  const AuthValidators._();

  static String? email(String? value) {
    final email = value?.trim() ?? '';
    if (email.length > 320 ||
        !RegExp(r'^[^\s@]+@[^\s@]+$').hasMatch(email)) {
      return 'Email không hợp lệ.';
    }
    return null;
  }

  static String? loginPassword(String? value) =>
      value == null || value.isEmpty ? 'Vui lòng nhập mật khẩu.' : null;

  static String? newPassword(String? value) {
    if (value == null || value.isEmpty) return 'Vui lòng nhập mật khẩu.';
    final length = value.runes.length;
    return length < 15 || length > 128
        ? 'Mật khẩu mới cần từ 15 đến 128 ký tự.'
        : null;
  }

  static String? confirmation(String? value, String password) =>
      value == null || value.isEmpty || value != password
      ? 'Mật khẩu xác nhận không trùng khớp.'
      : null;

  static String? capability(String? value) =>
      value == null || value.trim().isEmpty
      ? 'Vui lòng nhập thông tin từ email.'
      : null;
}
