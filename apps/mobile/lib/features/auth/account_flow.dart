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
    final AccountFailureKind kind;
    if (api == null ||
        api.invalidResponse ||
        api.remoteOutcomeAmbiguous ||
        api.transportFailure ||
        api.status == 408 ||
        api.status == 425 ||
        api.serverFailure) {
      kind = AccountFailureKind.uncertain;
    } else if (api.status == 429) {
      kind = AccountFailureKind.throttled;
    } else if (api.status == 404) {
      kind = AccountFailureKind.unavailable;
    } else if (api.status >= 400 && api.status < 500) {
      kind = AccountFailureKind.rejected;
    } else {
      kind = AccountFailureKind.uncertain;
    }
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
        'Máy chủ đang giới hạn yêu cầu. Vui lòng thử lại khi phù hợp.',
      AccountFailureKind.unavailable => switch (operation) {
        AccountOperation.recovery => 'Dịch vụ yêu cầu khôi phục hiện không khả dụng. Vui lòng thử lại sau.',
        AccountOperation.reset =>
          'Dịch vụ đặt lại mật khẩu hiện không khả dụng. Vui lòng thử lại sau.',
        AccountOperation.setup => 'Dịch vụ thiết lập tài khoản hiện không khả dụng. Vui lòng thử lại sau.',
      },
      AccountFailureKind.uncertain => switch (operation) {
        AccountOperation.recovery =>
          'Không thể xác nhận yêu cầu. Hãy kiểm tra email trước khi gửi lại.',
        AccountOperation.reset =>
          'Không thể xác nhận kết quả. Mật khẩu có thể đã được cập nhật. '
              'Hãy thử đăng nhập bằng mật khẩu vừa chọn. Không gửi lại yêu cầu này.',
        AccountOperation.setup =>
          'Không thể xác nhận kết quả. Tài khoản có thể đã được kích hoạt. '
              'Hãy thử đăng nhập bằng email doanh nghiệp và mật khẩu vừa thiết lập. '
              'Không gửi lại yêu cầu này.',
      },
      AccountFailureKind.rejected => switch (field) {
        AccountFailureField.email => 'Email không hợp lệ.',
        AccountFailureField.password =>
          'Mật khẩu không đáp ứng chính sách của tổ chức.',
        null => switch (operation) {
          AccountOperation.reset =>
            'Liên kết khôi phục có thể không hợp lệ, đã hết hạn hoặc mật khẩu '
                'không đáp ứng chính sách của tổ chức.',
          AccountOperation.setup =>
            'Lời mời thiết lập có thể không hợp lệ, đã hết hạn hoặc mật khẩu '
                'không đáp ứng chính sách của tổ chức.',
          AccountOperation.recovery =>
            'Yêu cầu không được chấp nhận. Vui lòng kiểm tra thông tin.',
        },
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

/// Non-sensitive restrictions shared across application account-flow entry.
/// Separate operations have separate deadlines; replacing a form does not
/// reset a server-provided retry restriction.
class AccountRetryDeadlines extends ChangeNotifier {
  final _deadlines = <AccountOperation, DateTime>{};
  bool _disposed = false;

  DateTime? _recoveryAcknowledgedUntil;
  int _activeSubmissions = 0;

  bool get hasActiveSubmission => _activeSubmissions > 0;

  void _beginSubmission() {
    if (_disposed) return;
    _activeSubmissions++;
    notifyListeners();
  }

  void _endSubmission() {
    if (_disposed) return;
    _activeSubmissions--;
    notifyListeners();
  }

  DateTime? serverDeadlineFor(AccountOperation operation) =>
      _deadlines[operation];

  DateTime? deadlineFor(AccountOperation operation) {
    final server = serverDeadlineFor(operation);
    final local = operation == AccountOperation.recovery
        ? _recoveryAcknowledgedUntil
        : null;
    if (local == null) return server;
    return server == null || local.isAfter(server) ? local : server;
  }

  void acknowledgeRecovery(DateTime now) {
    if (_disposed) return;
    final deadline = now.add(const Duration(seconds: 60));
    final previous = _recoveryAcknowledgedUntil;
    if (previous != null && !deadline.isAfter(previous)) return;
    _recoveryAcknowledgedUntil = deadline;
    notifyListeners();
  }

  void retain(AccountOperation operation, DateTime? deadline, DateTime now) {
    if (_disposed || deadline == null || !deadline.isAfter(now)) return;
    final previous = _deadlines[operation];
    if (previous != null && !deadline.isAfter(previous)) return;
    _deadlines[operation] = deadline;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _deadlines.clear();
    _recoveryAcknowledgedUntil = null;
    super.dispose();
  }
}

/// One submission owner per workflow. Never stores passwords or capabilities.
class AccountSubmissionController extends ChangeNotifier {
  AccountSubmissionController(
    this.operation, {
    DateTime Function()? now,
    AccountRetryDeadlines? retryDeadlines,
  }) : _now = now ?? DateTime.now,
       _retryDeadlines = retryDeadlines ?? AccountRetryDeadlines(),
       _ownsRetryDeadlines = retryDeadlines == null {
    _retryDeadlines.addListener(_retryDeadlineChanged);
    _scheduleRetry();
  }

  final AccountOperation operation;
  final DateTime Function() _now;
  final AccountRetryDeadlines _retryDeadlines;
  final bool _ownsRetryDeadlines;
  AccountSubmissionPhase _phase = AccountSubmissionPhase.ready;
  AccountFlowFailure? _failure;
  Timer? _retryTimer;
  bool _disposed = false;

  AccountSubmissionPhase get phase => _phase;
  AccountFlowFailure? get failure => _failure;
  bool get isSubmitting => _phase == AccountSubmissionPhase.submitting;
  bool get isCompleted => _phase == AccountSubmissionPhase.completed;

  Duration get retryRemaining {
    final deadline = _retryDeadlines.deadlineFor(operation);
    final remaining = deadline?.difference(_now());
    return remaining != null && remaining > Duration.zero
        ? remaining
        : Duration.zero;
  }

  String? get retryFeedback {
    final remaining = retryRemaining;
    if (remaining > Duration.zero) {
      final seconds = (remaining.inMilliseconds / 1000).ceil();
      final server = _retryDeadlines.serverDeadlineFor(operation);
      final message = server != null && server.isAfter(_now())
          ? 'Máy chủ đang giới hạn yêu cầu.'
          : 'Vui lòng chờ trước khi gửi lại yêu cầu.';
      return '$message Còn $seconds giây.';
    }
    if (_failure?.kind == AccountFailureKind.throttled) {
      return _failure?.retryAt != null
          ? 'Bạn có thể thử gửi lại yêu cầu.'
          : _failure?.message;
    }
    return null;
  }

  bool get canSubmit {
    if (_disposed ||
        isSubmitting ||
        isCompleted ||
        _retryDeadlines.hasActiveSubmission) {
      return false;
    }
    if (retryRemaining > Duration.zero) return false;
    if (operation.establishesPassword &&
        (_failure?.kind == AccountFailureKind.uncertain ||
            _failure?.kind == AccountFailureKind.unavailable)) {
      return false;
    }
    return true;
  }

  Future<void> submit(
    Future<void> Function() dispatch, {
    void Function(AccountFlowFailure? failure)? onSettled,
  }) async {
    if (!canSubmit) return;
    _retryTimer?.cancel();
    _failure = null;
    _phase = AccountSubmissionPhase.submitting;
    _retryDeadlines._beginSubmission();
    notifyListeners();
    AccountFlowFailure? settledFailure;
    try {
      await dispatch();
    } catch (error) {
      settledFailure = AccountFlowFailure.classify(
        error,
        operation,
        now: _now(),
      );
    }
    if (!_disposed) {
      _failure = settledFailure;
      _phase = settledFailure == null
          ? AccountSubmissionPhase.completed
          : AccountSubmissionPhase.failed;
    }
    if (settledFailure == null && operation == AccountOperation.recovery) {
      _retryDeadlines.acknowledgeRecovery(_now());
    } else if (settledFailure != null) {
      // A late response can still carry a real retry restriction.
      _retryDeadlines.retain(operation, settledFailure.retryAt, _now());
    }
    // Security side effects belong to the dispatched operation, not the form.
    // Never classify their results as the outcome of the original mutation.
    try {
      onSettled?.call(settledFailure);
    } finally {
      _retryDeadlines._endSubmission();
      if (!_disposed) notifyListeners();
    }
  }

  void _scheduleRetry() {
    _retryTimer?.cancel();
    final remaining = retryRemaining;
    if (remaining > Duration.zero) {
      final tick = remaining > const Duration(seconds: 1)
          ? const Duration(seconds: 1)
          : remaining;
      _retryTimer = Timer(tick, () {
        if (_disposed) return;
        _scheduleRetry();
        notifyListeners();
      });
    }
  }

  void _retryDeadlineChanged() {
    if (_disposed) return;
    _scheduleRetry();
    notifyListeners();
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
    _retryDeadlines.removeListener(_retryDeadlineChanged);
    if (_ownsRetryDeadlines) _retryDeadlines.dispose();
    super.dispose();
  }
}

class AuthValidators {
  const AuthValidators._();

  // Match the practical organizational-address policy, not the full RFC
  // mailbox grammar (quoted local parts and domain literals are unsupported).
  static final _emailLocal = RegExp(
    r"^(?!\.)(?!.*\.\.)[A-Za-z0-9_'+.-]*[A-Za-z0-9_+-]$",
  );
  static final _emailDomain = RegExp(
    r'^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$',
  );

  static String? email(String? value) {
    final email = value?.trim() ?? '';
    if (email.length > 320) return 'Email không hợp lệ.';
    final parts = email.split('@');
    if (parts.length != 2 ||
        !_emailLocal.hasMatch(parts.first) ||
        !_emailDomain.hasMatch(parts.last)) {
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
