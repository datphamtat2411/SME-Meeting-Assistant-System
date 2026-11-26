import 'dart:async';
import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'account_flow.dart';
import 'account_link.dart';

enum AccountLinkReception { accepted, duplicate, rejected }

/// Non-sensitive identity plus a one-shot transfer of the capability.
class AccountLinkTicket {
  AccountLinkTicket._(AccountLink link, this._fingerprint)
    : operation = link.operation,
      _capability = link.capability;

  final AccountOperation operation;
  final String _fingerprint;
  String? _capability;

  String takeCapability() {
    final value = _capability;
    if (value == null) throw StateError('Account link input was released.');
    _capability = null;
    return value;
  }

  void release() => _capability = null;
}

/// One pending candidate and one active delivery; no durable link history.
class AccountLinkCoordinator extends ChangeNotifier {
  AccountLinkCoordinator(this.parser);

  final AccountLinkParser parser;
  AccountLinkTicket? _pending;
  AccountLinkTicket? _active;
  String? _lastTerminal;
  String? _notice;
  bool _disposed = false;

  bool get hasPending => _pending != null;
  AccountOperation? get pendingOperation => _pending?.operation;
  String? get notice => _notice;
  bool get hasActive => _active != null;

  static String feedback(AccountLinkFailure kind) => switch (kind) {
    AccountLinkFailure.disabled =>
      'Ứng dụng chưa được cấu hình để mở liên kết tài khoản. '
          'Hãy mở email bằng trình duyệt.',
    AccountLinkFailure.untrusted =>
      'Nguồn liên kết tài khoản không được chấp nhận. Hãy mở lại email gốc.',
    AccountLinkFailure.unsupported =>
      'Đường dẫn không được hỗ trợ. Hãy mở lại email gốc.',
    AccountLinkFailure.malformed =>
      'Liên kết tài khoản không đúng định dạng. Hãy sao chép toàn bộ '
          'liên kết từ email hoặc mở email bằng trình duyệt.',
  };

  AccountLinkReception receive(String raw, {bool pasted = false}) {
    if (_disposed) return AccountLinkReception.rejected;
    final AccountLink link;
    try {
      link = parser.parse(raw, pasted: pasted);
    } on AccountLinkException catch (error) {
      _notice = feedback(error.kind);
      notifyListeners();
      return AccountLinkReception.rejected;
    }
    final fingerprint = sha256
        .convert(utf8.encode('${link.operation.name}\u0000${link.capability}'))
        .toString();
    if (_active?._fingerprint == fingerprint ||
        _pending?._fingerprint == fingerprint ||
        (!pasted && _lastTerminal == fingerprint)) {
      return AccountLinkReception.duplicate;
    }
    _pending?.release();
    _pending = AccountLinkTicket._(link, fingerprint);
    _notice = null;
    notifyListeners();
    return AccountLinkReception.accepted;
  }

  AccountLinkTicket? claim() {
    if (_disposed || _active != null) return null;
    final ticket = _pending;
    if (ticket == null) return null;
    _pending = null;
    _active = ticket;
    notifyListeners();
    return ticket;
  }

  void markTerminal(AccountLinkTicket ticket) {
    if (!identical(_active, ticket)) return;
    _lastTerminal = ticket._fingerprint;
    ticket.release();
  }

  void finish(AccountLinkTicket ticket) {
    if (!identical(_active, ticket)) return;
    ticket.release();
    _active = null;
    if (!_disposed) notifyListeners();
  }

  void discardPending({String? notice}) {
    _pending?.release();
    _pending = null;
    _notice = notice;
    if (!_disposed) notifyListeners();
  }

  void reportDeliveryFailure() {
    if (_disposed) return;
    _notice = 'Không thể nhận liên kết. Hãy mở lại email hoặc dán liên kết.';
    notifyListeners();
  }

  void clearNotice() {
    _notice = null;
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _pending?.release();
    _active?.release();
    _pending = null;
    _active = null;
    _lastTerminal = null;
    _notice = null;
    super.dispose();
  }
}

/// Pull-based handshake: native keeps a bounded buffer until Dart takes ownership.
/// A signal received during a drain schedules another drain, not a second
/// concurrent consumer.
class AccountLinkReceiver {
  AccountLinkReceiver({
    required this.onLink,
    required this.onFailure,
    MethodChannel? channel,
  }) : _channel = channel ?? const MethodChannel('sme/account_links');

  final void Function(String url, bool initial) onLink;
  final VoidCallback onFailure;
  final MethodChannel _channel;
  bool _disposed = false;
  bool _started = false;
  bool _draining = false;
  bool _requested = false;

  void start() {
    if (_disposed || _started) return;
    _started = true;
    _channel.setMethodCallHandler((call) async {
      if (call.method == 'available') {
        _requestDrain();
      }
    });
    _requestDrain();
  }

  void _requestDrain() {
    if (_disposed) return;
    _requested = true;
    if (!_draining) unawaited(_drain());
  }

  Future<void> _drain() async {
    _draining = true;
    try {
      while (_requested && !_disposed) {
        _requested = false;
        final delivery = await _channel.invokeMethod<Object?>('takePending');
        if (_disposed) return;
        if (delivery != null) {
          if (delivery is Map<Object?, Object?> &&
              delivery['url'] is String &&
              delivery['initial'] is bool) {
            onLink(delivery['url'] as String, delivery['initial'] as bool);
          } else {
            // Never grant automatic entry based on an ambiguous delivery.
            onFailure();
          }
          // Recheck the buffer even if a native availability signal was lost.
          _requested = true;
        }
      }
    } on PlatformException {
      if (!_disposed) onFailure();
    } on MissingPluginException {
      if (!_disposed) onFailure();
    } finally {
      _draining = false;
    }
  }

  void dispose() {
    _disposed = true;
    _requested = false;
    if (_started) _channel.setMethodCallHandler(null);
  }
}
