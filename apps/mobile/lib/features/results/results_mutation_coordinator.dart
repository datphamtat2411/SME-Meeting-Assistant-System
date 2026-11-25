import 'dart:math';

import '../../core/api_client.dart';

/// Workspace-owned command state, independent of presentation mount cycles.
enum ResultsMutationGroup { transcript, summary, decisions }

/// A protected recovery draft is tied to the exact snapshot the user reviewed.
///
/// Keeping only the text is unsafe: the same text may be submitted against a
/// newer canonical resource after the editor has been recreated.
class ResultsRecoveryDraft {
  const ResultsRecoveryDraft({
    required this.resourceId,
    required this.reviewedToken,
    required this.content,
    required this.meetingId,
    required this.sessionScope,
    required this.reviewEpoch,
    required this.workspaceIdentity,
  });

  final String resourceId;
  final String reviewedToken;
  final String content;
  final String meetingId;
  final AuthenticatedSessionScope sessionScope;
  final int reviewEpoch;
  final Object workspaceIdentity;
}

class ResultsMutationCoordinator {
  final Map<ResultsMutationGroup, Object> _pending = {};
  int _epoch = 0;
  String? _regenerationKey;
  bool regenerationUncertain = false;
  bool decisionOutcomeUnknown = false;
  String? unknownDecisionContent;
  final Map<String, ResultsRecoveryDraft> _drafts =
      <String, ResultsRecoveryDraft>{};
  ResultsRecoveryDraft? draft(String key) => _drafts[key];
  void keepDraft(String key, ResultsRecoveryDraft draft) =>
      _drafts[key] = draft;
  void clearDraft(String key) => _drafts.remove(key);
  String? acceptedRegenerationJobId;

  int get epoch => _epoch;
  bool busy(ResultsMutationGroup group) => _pending.containsKey(group);

  void invalidate() {
    _epoch++;
    _pending.clear();
    _drafts.clear();
    decisionOutcomeUnknown = false;
    unknownDecisionContent = null;
    regenerationUncertain = false;
    _regenerationKey = null;
    acceptedRegenerationJobId = null;
  }

  Object begin(ResultsMutationGroup group) {
    if (busy(group)) {
      throw const ApiFailure(
        409,
        'RESULTS_COMMAND_PENDING',
        'Một thao tác trên kết quả này đang được xử lý.',
      );
    }
    final ticket = Object();
    _pending[group] = ticket;
    return ticket;
  }

  void finish(ResultsMutationGroup group, Object ticket) {
    if (identical(_pending[group], ticket)) _pending.remove(group);
  }

  String regenerationKey() {
    final random = Random.secure();
    return _regenerationKey ??= List<int>.generate(
      16,
      (_) => random.nextInt(256),
    ).map((value) => value.toRadixString(16).padLeft(2, '0')).join();
  }

  void recordAdmission(String jobId) {
    acceptedRegenerationJobId = jobId;
    regenerationUncertain = false;
    _regenerationKey = null;
  }

  void completeAdmission(String jobId) {
    if (acceptedRegenerationJobId == jobId) {
      acceptedRegenerationJobId = null;
    }
  }

  void recordFailure(Object error) {
    if (isUncertain(error)) {
      regenerationUncertain = true;
    } else if (!regenerationUncertain) {
      _regenerationKey = null;
    }
  }

  static bool isUncertain(Object error) =>
      error is! ApiFailure ||
      error.remoteOutcomeAmbiguous ||
      error.transportFailure ||
      error.invalidResponse ||
      error.status == 0 ||
      error.status == 408 ||
      error.status == 425 ||
      error.serverFailure;
}
