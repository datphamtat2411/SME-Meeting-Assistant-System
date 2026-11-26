import 'account_flow.dart';

/// A locally validated input, not evidence of backend authorization.
class AccountLink {
  const AccountLink._(this.operation, this.capability);

  final AccountOperation operation;
  final String capability;

  bool sameCapability(AccountLink other) =>
      operation == other.operation && capability == other.capability;
}

enum AccountLinkFailure { disabled, malformed, untrusted, unsupported }

class AccountLinkException implements Exception {
  const AccountLinkException(this.kind);

  final AccountLinkFailure kind;

  @override
  String toString() => 'Account link rejected: ${kind.name}';
}

/// Validate the original URL before URI normalization can hide ambiguity.
class AccountLinkParser {
  AccountLinkParser(String configuredHost)
    : host = validateHost(configuredHost);

  static const configuredHost = String.fromEnvironment('ACCOUNT_LINK_HOST');
  static const maxUrlLength = 40000;
  static const maxCapabilityLength = 4096;

  final String? host;

  static String? validateHost(String value) {
    if (value.isEmpty) return null;
    final labels = value.split('.');
    final label = RegExp(r'^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$');
    if (value.length > 253 ||
        _unsafe.hasMatch(value) ||
        labels.length < 2 ||
        labels.any((part) => !label.hasMatch(part)) ||
        !RegExp(r'[A-Za-z]').hasMatch(labels.last)) {
      throw const FormatException('Invalid ACCOUNT_LINK_HOST.');
    }
    return value.toLowerCase();
  }

  AccountLink parse(String raw, {bool pasted = false}) {
    final trusted = host;
    if (trusted == null) {
      throw const AccountLinkException(AccountLinkFailure.disabled);
    }
    if (raw.length > maxUrlLength) {
      throw const AccountLinkException(AccountLinkFailure.malformed);
    }
    final value = pasted ? raw.trim() : raw;
    if (_unsafe.hasMatch(value) || _hasUnpairedSurrogate(value)) {
      throw const AccountLinkException(AccountLinkFailure.malformed);
    }
    // Do not accept encoded authority/path, query strings, or path aliases
    // produced by normalization. Only the fragment has form-style encoding.
    final match = _url.firstMatch(value);
    if (match == null) {
      throw const AccountLinkException(AccountLinkFailure.malformed);
    }
    final rawAuthority = match.group(1)!;
    if (!RegExp(r'^[A-Za-z0-9.:-]+
    if (authority != trusted && authority != '$trusted:443') {
      throw const AccountLinkException(AccountLinkFailure.untrusted);
    }
    final operation = switch (match.group(2)) {
      '/account-setup' || '/sign-up' => AccountOperation.setup,
      '/reset-password' || '/otp' => AccountOperation.reset,
      _ => throw const AccountLinkException(AccountLinkFailure.unsupported),
    };
    final fragment = match.group(3)!;
    final separator = fragment.indexOf('=');
    if (separator < 0 || fragment.contains('&')) {
      throw const AccountLinkException(AccountLinkFailure.malformed);
    }
    final String capability;
    try {
      if (_badEscape.hasMatch(fragment) ||
          Uri.decodeQueryComponent(fragment.substring(0, separator)) !=
              'token') {
        throw const FormatException();
      }
      capability = Uri.decodeQueryComponent(fragment.substring(separator + 1));
    } on FormatException {
      throw const AccountLinkException(AccountLinkFailure.malformed);
    } on ArgumentError {
      throw const AccountLinkException(AccountLinkFailure.malformed);
    }
    if (capability.isEmpty ||
        capability.length > maxCapabilityLength ||
        _unsafe.hasMatch(capability) ||
        _hasUnpairedSurrogate(capability)) {
      throw const AccountLinkException(AccountLinkFailure.malformed);
    }
    return AccountLink._(operation, capability);
  }

  static bool _hasUnpairedSurrogate(String value) {
    final units = value.codeUnits;
    for (var index = 0; index < units.length; index++) {
      final unit = units[index];
      if (unit >= 0xd800 && unit <= 0xdbff) {
        if (++index == units.length ||
            units[index] < 0xdc00 ||
            units[index] > 0xdfff) {
          return true;
        }
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        return true;
      }
    }
    return false;
  }

  static final _url = RegExp(
    r'^https://([^/?#]+)(/[^?#]*)#([^#]*)$',
    caseSensitive: false,
  );
  static final _badEscape = RegExp(r'%(?![0-9a-fA-F]{2})');
  static final _unsafe = RegExp(
    r'[\s\u0000-\u001f\u007f-\u009f\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]',
  );
}
).hasMatch(rawAuthority)) {
      throw const AccountLinkException(AccountLinkFailure.untrusted);
    }
    final authority = rawAuthority.toLowerCase();
    if (authority != trusted && authority != '$trusted:443') {
      throw const AccountLinkException(AccountLinkFailure.untrusted);
    }
    final operation = switch (match.group(2)) {
      '/account-setup' || '/sign-up' => AccountOperation.setup,
      '/reset-password' || '/otp' => AccountOperation.reset,
      _ => throw const AccountLinkException(AccountLinkFailure.unsupported),
    };
    final fragment = match.group(3)!;
    final separator = fragment.indexOf('=');
    if (separator < 0 || fragment.contains('&')) {
      throw const AccountLinkException(AccountLinkFailure.malformed);
    }
    final String capability;
    try {
      if (_badEscape.hasMatch(fragment) ||
          Uri.decodeQueryComponent(fragment.substring(0, separator)) !=
              'token') {
        throw const FormatException();
      }
      capability = Uri.decodeQueryComponent(fragment.substring(separator + 1));
    } on FormatException {
      throw const AccountLinkException(AccountLinkFailure.malformed);
    } on ArgumentError {
      throw const AccountLinkException(AccountLinkFailure.malformed);
    }
    if (capability.isEmpty ||
        capability.length > maxCapabilityLength ||
        _unsafe.hasMatch(capability) ||
        _hasUnpairedSurrogate(capability)) {
      throw const AccountLinkException(AccountLinkFailure.malformed);
    }
    return AccountLink._(operation, capability);
  }

  static bool _hasUnpairedSurrogate(String value) {
    final units = value.codeUnits;
    for (var index = 0; index < units.length; index++) {
      final unit = units[index];
      if (unit >= 0xd800 && unit <= 0xdbff) {
        if (++index == units.length ||
            units[index] < 0xdc00 ||
            units[index] > 0xdfff) {
          return true;
        }
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        return true;
      }
    }
    return false;
  }

  static final _url = RegExp(
    r'^https://([^/?#]+)(/[^?#]*)#([^#]*)$',
    caseSensitive: false,
  );
  static final _badEscape = RegExp(r'%(?![0-9a-fA-F]{2})');
  static final _unsafe = RegExp(
    r'[\s\u0000-\u001f\u007f-\u009f\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]',
  );
}
