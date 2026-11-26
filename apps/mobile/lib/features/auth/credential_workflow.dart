import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/api_client.dart';
import 'account_flow.dart';

enum CredentialOutcomeKind { completed, uncertain, unavailable }

/// An opaque workflow identity, containing no credential material.
class CredentialAttempt {
  CredentialAttempt._(this.operation) : assert(operation.establishesPassword);

  final AccountOperation operation;

  // Dispatch state belongs to the attempt, not to a replaceable form or
  // submission controller. These flags contain no credential material.
  bool _dispatchInFlight = false;
  bool _terminal = false;
}

class CredentialOutcome {
  const CredentialOutcome(this.operation, this.kind);

  final AccountOperation operation;
  final CredentialOutcomeKind kind;
}

/// Application-owned handoff for terminal, non-sensitive results. A late
/// mutation still reconciles the session even if its form has been abandoned.
class CredentialWorkflowOwner extends ChangeNotifier {
  CredentialWorkflowOwner(this.api);

  final ApiClient api;
  CredentialAttempt? _active;
  CredentialOutcome? _outcome;
  bool _disposed = false;

  CredentialOutcome? get outcome => _outcome;

  CredentialAttempt begin(AccountOperation operation) {
    if (!operation.establishesPassword) {
      throw ArgumentError.value(operation, 'operation', 'Invalid purpose.');
    }
    if (_disposed || _outcome != null) {
      throw StateError('Credential workflow is not ready.');
    }
    return _active = CredentialAttempt._(operation);
  }

  void abandon(CredentialAttempt attempt) {
    if (identical(_active, attempt) && _outcome == null) _active = null;
  }

  void dismiss() {
    if (_disposed || _outcome == null) return;
    _active = null;
    _outcome = null;
    notifyListeners();
  }

  Future<void> submit(
    CredentialAttempt attempt,
    AccountSubmissionController submission,
    String capability,
    String password,
  ) async {
    if (_disposed ||
        !identical(_active, attempt) ||
        attempt._terminal ||
        attempt._dispatchInFlight ||
        submission.operation != attempt.operation ||
        !submission.canSubmit) {
      return;
    }

    // Latch before the first await. A replacement controller cannot start a
    // second dispatch while this attempt is already in flight.
    attempt._dispatchInFlight = true;
    try {
      await submission.submit(
        () => attempt.operation == AccountOperation.reset
            ? api.resetPassword(capability, password)
            : api.completeAccountSetup(capability, password),
        onSettled: (failure) => _settled(attempt, failure),
      );
    } finally {
      // AccountSubmissionController can decline a dispatch if its own state
      // changed before it accepted the call. Never leave the attempt latched.
      attempt._dispatchInFlight = false;
    }
  }

  void _settled(CredentialAttempt attempt, AccountFlowFailure? failure) {
    if (_disposed) return;
    attempt._dispatchInFlight = false;
    final kind = switch (failure?.kind) {
      null => CredentialOutcomeKind.completed,
      AccountFailureKind.uncertain => CredentialOutcomeKind.uncertain,
      AccountFailureKind.unavailable => CredentialOutcomeKind.unavailable,
      _ => null,
    };
    // Completion, uncertainty and capability unavailability are terminal for
    // this exact attempt even if its form/controller has since been replaced.
    if (kind != null) attempt._terminal = true;
    final publish = kind != null && identical(_active, attempt);
    if (kind != null && publish) {
      _outcome = CredentialOutcome(attempt.operation, kind);
    }
    if (attempt.operation == AccountOperation.reset &&
        (kind == CredentialOutcomeKind.completed ||
            kind == CredentialOutcomeKind.uncertain)) {
      // The coordinator closes protected access synchronously. Its independent
      // result is represented by authoritative session state, never by the
      // mutation outcome. Do not retain secrets while waiting for verification.
      unawaited(api.reconcileSession());
    }
    if (publish) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _active = null;
    _outcome = null;
    super.dispose();
  }
}
