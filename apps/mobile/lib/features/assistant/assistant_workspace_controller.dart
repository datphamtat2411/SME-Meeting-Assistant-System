import 'dart:async';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';

import 'assistant_repository.dart';

String _newKey() {
  final random = Random.secure();
  return List.generate(
    16,
    (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'),
  ).join();
}

/// Only durable identities and state are needed for recovery. Answer payloads
/// must come from freshly authorized canonical history.
class AssistantPendingResult {
  AssistantPendingResult(AssistantTurn turn)
    : turnId = turn.turnId,
      state = turn.state,
      userMessageId = turn.userMessageId,
      assistantMessageId = turn.assistantMessageId;

  final String turnId;
  final AssistantTurnState state;
  final String userMessageId;
  final String? assistantMessageId;

  bool matches(AssistantTurn other) =>
      turnId == other.turnId && userMessageId == other.userMessageId;
}

/// Session-owned intent. The server alone owns canonical messages.
class AssistantPendingTurn {
  AssistantPendingTurn(this.request, {DateTime Function()? now})
    : _now = now ?? DateTime.now;

  final DateTime Function() _now;

  final AssistantQuestionRequest request;
  AssistantPendingResult? turn;
  AssistantFailure? failure;
  bool busy = true;
  bool retryAllowed = false;
  bool uncertain = false;
  bool reclaimUncertain = false;
  bool reconciliationDeferred = false;
  DateTime? retryAt;
  DateTime? statusRetryAt;
  DateTime? automaticDeadline;
  int automaticChecks = 0;

  bool get automaticExhausted =>
      automaticChecks >= 12 ||
      (automaticDeadline != null &&
          !_now().isBefore(automaticDeadline!));
  bool get canRetry => !busy && retryAllowed && !_waiting(retryAt, _now());
  bool get canAbandon =>
      !busy &&
      uncertain &&
      !terminal &&
      (turn == null ||
          retryAllowed ||
          (reclaimUncertain && automaticExhausted));

  bool get terminal =>
      turn != null && turn!.state != AssistantTurnState.processing;
  bool get canCheck =>
      !busy &&
      !terminal &&
      (uncertain || turn != null) &&
      !_waiting(statusRetryAt, _now());
  bool get canEdit =>
      !busy &&
      !uncertain &&
      turn == null &&
      (failure?.outcome == AssistantMutationOutcome.rejected ||
          failure?.outcome == AssistantMutationOutcome.notDispatched);
}

/// Owns list, selected history and in-memory commands for one session.
/// Separate generations fence independent list and conversation reads.
class AssistantWorkspaceController extends ChangeNotifier {
  AssistantWorkspaceController(
    this.repository, {
    this.verifyMeetingReadAccess,
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now,
       scope = repository.captureSession() {
    repository.api.sessionCoordinator.addListener(_sessionChanged);
  }

  final AssistantRepository repository;
  final DateTime Function() _now;
  final Future<bool> Function({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
  })?
  verifyMeetingReadAccess;
  final AuthenticatedSessionScope scope;
  bool _disposed = false;
  bool _active = false;
  Object? _presentationOwner;
  bool _invalidationScheduled = false;
  bool _invalidationRunning = false;
  bool _invalidationDirty = false;
  Timer? _statusTimer;
  Timer? _cooldownTimer;
  int _historyDepth = 0;
  static const _maxContinuationReads = 4;
  int _listGeneration = 0;
  int _historyGeneration = 0;
  int _nextPage = 0;
  final List<AssistantConversation> _conversations = [];
  final List<AssistantMessage> _messages = [];
  final Map<String, AssistantPendingTurn> _pending = {};
  final Map<String, String> _drafts = {};
  final Map<String, String> _draftMeetings = {};
  AssistantConversation? conversation;
  AssistantCreateConversationRequest? creation;
  AssistantFailure? creationFailure;
  bool _creationUncertain = false;
  DateTime? _creationRetryAt;
  DateTime? _askRetryAt;
  Object? listFailure;
  Object? historyFailure;
  bool listLoading = false;
  bool historyLoading = false;
  bool creating = false;
  bool listHasMore = true;
  bool historyHasMore = false;
  bool historyVerified = false;

  int get historyGeneration => _historyGeneration;

  bool get current =>
      !_disposed && repository.api.isCurrentAuthenticatedSession(scope);
  List<AssistantConversation> get conversations =>
      List.unmodifiable(_conversations);
  List<AssistantMessage> get messages => List.unmodifiable(_messages);
  AssistantPendingTurn? get pending => _pending[conversation?.id];
  bool get canCompose =>
      current &&
      _active &&
      historyVerified &&
      !historyLoading &&
      conversation?.status == AssistantConversationStatus.active &&
      pending == null;
  bool get askCoolingDown => _waiting(_askRetryAt, _now());
  DateTime? get askRetryAt => _askRetryAt;
  bool get canSend => canCompose && !askCoolingDown;
  bool get canRetryPending =>
      current &&
      _active &&
      historyVerified &&
      !historyLoading &&
      !askCoolingDown &&
      conversation?.status == AssistantConversationStatus.active &&
      pending?.canRetry == true;
  DateTime? get creationRetryAt => _creationRetryAt;
  bool get creationCoolingDown => _waiting(_creationRetryAt, _now());
  bool get canRetryCreation =>
      current &&
      _active &&
      !creating &&
      creation != null &&
      !_waiting(_creationRetryAt, _now());
  bool get canDiscardCreation =>
      current &&
      _active &&
      !creating &&
      !_creationUncertain &&
      (creationFailure?.outcome == AssistantMutationOutcome.rejected ||
          creationFailure?.outcome == AssistantMutationOutcome.notDispatched);
  bool get canAbandonCreation =>
      current && _active && creation != null && !creating && _creationUncertain;

  void _publish() {
    if (current) notifyListeners();
  }

  bool _ownsHistory(int generation, String id) =>
      current && generation == _historyGeneration && conversation?.id == id;

  bool ownsPresentation(Object host) =>
      current && _active && identical(_presentationOwner, host);

  void setPresentationActive(Object host, bool active) {
    if (!current) return;
    if (!active) {
      if (!identical(_presentationOwner, host)) return;
      _presentationOwner = null;
      setActive(false);
      return;
    }
    if (identical(_presentationOwner, host)) return;
    if (_active) setActive(false);
    _presentationOwner = host;
    setActive(true);
  }

  String draftFor(String conversationId) => _drafts[conversationId] ?? '';

  void saveDraft(String conversationId, String text) {
    final selected = conversation;
    if (!current || selected?.id != conversationId) return;
    if (text.isEmpty) {
      _drafts.remove(conversationId);
      _draftMeetings.remove(conversationId);
    } else {
      _drafts[conversationId] = text;
      _draftMeetings[conversationId] = selected!.meetingId;
    }
  }

  /// A conversation or turn 404 alone is not proof of meeting-wide denial.
  /// Recheck the canonical meeting access boundary before discarding siblings.
  Future<void> _confirmMeetingAccessLoss(String meetingId) async {
    final verify = verifyMeetingReadAccess;
    if (!current || verify == null) return;
    try {
      final allowed = await verify(sessionScope: scope, meetingId: meetingId);
      if (current && !allowed) forgetMeeting(meetingId);
    } on ApiFailure catch (error) {
      if (current && _accessLost(error)) forgetMeeting(meetingId);
    } on Object {
      // The originating operation remains failed. An inconclusive access
      // check must not destroy unrelated recovery state.
    }
  }

  /// Called only after an authoritative loss of meeting-content access.
  void forgetMeeting(String meetingId) {
    if (!current) return;
    bool matches(String id) => sameAssistantIdentity(id, meetingId);
    final draftIds = _draftMeetings.entries
        .where((entry) => matches(entry.value))
        .map((entry) => entry.key)
        .toList();
    for (final id in draftIds) {
      _drafts.remove(id);
      _draftMeetings.remove(id);
    }
    _pending.removeWhere(
      (_, command) => matches(command.request.conversation.meetingId),
    );
    _listGeneration++;
    listLoading = false;
    _conversations.clear();
    _nextPage = 0;
    listHasMore = true;
    if (creation != null && matches(creation!.meetingId)) {
      // Release inaccessible local context, not the possibly durable server
      // creation. An in-flight attempt still owns its dispatch lock.
      creation = null;
      creationFailure = null;
      _creationUncertain = false;
    }
    if (conversation != null && matches(conversation!.meetingId)) {
      _historyGeneration++;
      _stopStatusMonitoring();
      conversation = null;
      _messages.clear();
      _historyDepth = 0;
      historyVerified = false;
      historyHasMore = false;
      historyLoading = false;
    }
    _publish();
  }

  void invalidateMeeting(String? meetingId) {
    if (!current || !_active) return;
    final selected = conversation;
    if (selected != null &&
        meetingId != null &&
        selected.meetingId.toLowerCase() != meetingId.toLowerCase()) {
      return;
    }
    _invalidationDirty = true;
    _stopStatusMonitoring();
    if (selected != null) {
      _historyDepth = max(_historyDepth, _messages.length);
      _historyGeneration++;
      _messages.clear();
      historyVerified = false;
      historyHasMore = false;
      historyLoading = true;
    } else {
      _listGeneration++;
      _conversations.clear();
      listLoading = true;
    }
    _publish();
    if (_invalidationScheduled || _invalidationRunning) return;
    _invalidationScheduled = true;
    scheduleMicrotask(() {
      _invalidationScheduled = false;
      unawaited(_revalidateInvalidations());
    });
  }

  Future<void> _revalidateInvalidations() async {
    if (_invalidationRunning) return;
    _invalidationRunning = true;
    try {
      while (current && _active && _invalidationDirty) {
        _invalidationDirty = false;
        await revalidate();
      }
    } finally {
      _invalidationRunning = false;
    }
  }

  void setActive(bool active) {
    if (!current || _active == active) return;
    _active = active;
    if (active) {
      unawaited(revalidate());
    } else {
      _invalidationDirty = false;
      _stopStatusMonitoring();
      _cooldownTimer?.cancel();
      _historyDepth = max(_historyDepth, _messages.length);
      _listGeneration++;
      _historyGeneration++;
      _conversations.clear();
      _messages.clear();
      listLoading = false;
      historyLoading = false;
      historyVerified = false;
      _publish();
    }
  }

  Future<void> revalidate() async {
    if (!current || !_active) return;
    final selected = conversation;
    if (selected == null) {
      await refreshList();
      _scheduleCooldownUpdate();
    } else {
      await refreshHistory();
      if (conversation?.id == selected.id) {
        _scheduleCooldownUpdate();
        _scheduleStatusMonitoring();
      }
    }
  }

  Future<void> refreshList() {
    if (!current || !_active) return Future.value();
    _listGeneration++;
    _nextPage = 0;
    _conversations.clear();
    listHasMore = true;
    listLoading = false;
    return loadMoreConversations();
  }

  Future<void> loadMoreConversations() async {
    if (!current || !_active || listLoading || !listHasMore) return;
    final generation = _listGeneration;
    listLoading = true;
    listFailure = null;
    _publish();
    try {
      final result = await repository.listConversations(
        sessionScope: scope,
        page: _nextPage,
      );
      if (!current || generation != _listGeneration) return;
      final seen = _conversations.map((item) => item.id).toSet();
      final overlap = result.items.any((item) => seen.contains(item.id));
      _conversations.addAll(result.items.where((item) => seen.add(item.id)));
      listHasMore = result.mayHaveMore && !overlap;
      if (overlap) {
        listFailure = StateError('Conversation collection changed.');
      }
      _nextPage++;
    } catch (error) {
      if (!current || generation != _listGeneration) return;
      listFailure = error;
      if (_accessLost(error)) {
        _conversations.clear();
        listHasMore = false;
      }
    } finally {
      if (current && generation == _listGeneration) {
        listLoading = false;
        _publish();
      }
    }
  }

  Future<AssistantConversation?> create(String meetingId, String title) {
    if (!current ||
        !_active ||
        creating ||
        creation != null ||
        _waiting(_creationRetryAt, _now())) {
      return Future.value(null);
    }
    creation = AssistantCreateConversationRequest(
      meetingId: meetingId,
      title: title.length <= 255 ? title : null,
      idempotencyKey: _newKey(),
    );
    _creationUncertain = false;
    creationFailure = null;
    return retryCreation();
  }

  Future<AssistantConversation?> retryCreation() async {
    final command = creation;
    if (!current ||
        !_active ||
        creating ||
        command == null ||
        _waiting(_creationRetryAt, _now())) {
      return null;
    }
    creating = true;
    creationFailure = null;
    _publish();
    try {
      final created = await repository.createConversation(
        command,
        sessionScope: scope,
      );
      if (!current || !identical(command, creation)) return null;
      creation = null;
      _creationRetryAt = null;
      _creationUncertain = false;
      if (_active) unawaited(refreshList());
      return created;
    } on AssistantFailure catch (error) {
      if (current && identical(command, creation)) {
        creationFailure = error;
        _creationUncertain =
            _creationUncertain ||
            error.outcome == AssistantMutationOutcome.unknown;
        _creationRetryAt = _laterDeadline(
          _creationRetryAt,
          _retryDeadline(error, _now()),
        );
        if (_accessLost(error)) {
          await _confirmMeetingAccessLoss(command.meetingId);
        }
      }
      return null;
    } finally {
      if (current) {
        creating = false;
        _scheduleCooldownUpdate();
        _publish();
      }
    }
  }

  void discardRejectedCreation() {
    if (!current || !canDiscardCreation) return;
    creation = null;
    creationFailure = null;
    _scheduleCooldownUpdate();
    _publish();
  }

  Future<void> abandonCreation() async {
    if (!current || !canAbandonCreation) return;
    creation = null;
    creationFailure = null;
    _creationUncertain = false;
    _scheduleCooldownUpdate();
    _publish();
    await refreshList();
  }

  Future<void> open(AssistantConversation selected) async {
    if (!current || !_active) return;
    _stopStatusMonitoring();
    if (conversation?.id != selected.id) {
      _historyDepth = 0;
      _messages.clear();
    }
    conversation = selected;
    await refreshHistory();
    if (conversation?.id == selected.id) {
      _scheduleCooldownUpdate();
      _scheduleStatusMonitoring();
    }
  }

  Future<void> closeConversation() async {
    if (!current) return;
    _stopStatusMonitoring();
    _historyDepth = 0;
    _historyGeneration++;
    conversation = null;
    _messages.clear();
    historyFailure = null;
    historyLoading = false;
    historyVerified = false;
    historyHasMore = false;
    _publish();
    await refreshList();
  }

  Future<void> refreshHistory() => _syncHistory(authoritative: true);

  Future<void> reconcilePending() => _syncHistory(authoritative: false);

  bool _containsTurnMessages(
    AssistantPendingTurn command,
    List<AssistantMessage> messages,
  ) {
    final turn = command.turn;
    if (turn == null || !command.terminal) return false;
    return messages.any(
          (message) =>
              message.id == turn.userMessageId &&
              message.role == AssistantMessageRole.user,
        ) &&
        messages.any(
          (message) =>
              message.id == turn.assistantMessageId &&
              message.role == AssistantMessageRole.assistant,
        );
  }

  Future<void> _syncHistory({required bool authoritative}) async {
    final selected = conversation;
    if (!current || !_active || selected == null) return;
    if (!authoritative && historyLoading) {
      final command = pending;
      if (command != null && command.terminal) {
        command.reconciliationDeferred = true;
      }
      return;
    }
    pending?.reconciliationDeferred = false;
    final previous = List<AssistantMessage>.of(_messages);
    final previousHasMore = historyHasMore;
    final desiredDepth = max(_historyDepth, previous.length);
    final generation = ++_historyGeneration;
    final previousIds = previous.map((message) => message.id).toSet();
    historyLoading = true;
    historyFailure = null;
    if (authoritative) {
      _stopStatusMonitoring();
      historyVerified = false;
      historyHasMore = false;
      _messages.clear();
    }
    _publish();
    try {
      var result = await repository.getConversation(
        selected.id,
        sessionScope: scope,
        expectedMeetingId: selected.meetingId,
      );
      if (!_ownsHistory(generation, selected.id)) return;
      final fresh = List<AssistantMessage>.of(result.messages);
      final freshIds = fresh.map((message) => message.id).toSet();
      final command = _pending[selected.id];
      var reads = 0;
      bool overlaps() => freshIds.any(previousIds.contains);
      bool needsContinuation() =>
          (authoritative && fresh.length < desiredDepth) ||
          (!authoritative && previous.isNotEmpty && !overlaps()) ||
          (command != null &&
              command.terminal &&
              !_containsTurnMessages(command, fresh));
      while (result.hasMore &&
          fresh.isNotEmpty &&
          reads < _maxContinuationReads &&
          needsContinuation()) {
        result = await repository.getConversation(
          selected.id,
          sessionScope: scope,
          expectedMeetingId: selected.meetingId,
          beforeMessageId: fresh.first.id,
        );
        if (!_ownsHistory(generation, selected.id)) return;
        if (result.messages.any((message) => freshIds.contains(message.id))) {
          throw StateError('Overlapping anchored history.');
        }
        freshIds.addAll(result.messages.map((message) => message.id));
        fresh.insertAll(0, result.messages);
        reads++;
      }
      conversation = result.conversation;
      var retainedOlder = false;
      if (!authoritative && fresh.isNotEmpty) {
        final firstOverlap = previous.indexWhere(
          (message) => freshIds.contains(message.id),
        );
        if (firstOverlap > 0 && result.hasMore) {
          final older = previous.take(firstOverlap);
          // Only retain a contiguous older prefix. If fresh reads start before
          // the first overlapping record, retain only records older than that
          // exact boundary, not arbitrary records from a disconnected window.
          if (previous[firstOverlap].id == fresh.first.id) {
            fresh.insertAll(0, older);
            retainedOlder = true;
          }
        }
      }
      if (!authoritative &&
          previous.isNotEmpty &&
          !overlaps() &&
          result.hasMore) {
        historyFailure = StateError('History continuation required.');
      }
      _messages
        ..clear()
        ..addAll(fresh);
      historyHasMore = retainedOlder ? previousHasMore : result.hasMore;
      historyVerified = true;
      _historyDepth = _messages.length;
      if (command != null &&
          identical(_pending[selected.id], command) &&
          _containsTurnMessages(command, _messages)) {
        _pending.remove(selected.id);
        _stopStatusMonitoring();
      }
    } catch (error) {
      if (!_ownsHistory(generation, selected.id)) return;
      historyFailure = error;
      if (_accessLost(error)) {
        _stopStatusMonitoring();
        _messages.clear();
        historyVerified = false;
        historyHasMore = false;
        _pending.remove(selected.id);
        _drafts.remove(selected.id);
        _draftMeetings.remove(selected.id);
        _listGeneration++;
        listLoading = false;
        _conversations.clear();
        _nextPage = 0;
        listHasMore = true;
        listFailure = error;
        conversation = null;
        _historyDepth = 0;
        _publish();
        await _confirmMeetingAccessLoss(selected.meetingId);
      }
    } finally {
      if (current && generation == _historyGeneration) {
        historyLoading = false;
        _publish();
        await _drainDeferredReconciliation();
        _scheduleStatusMonitoring();
      }
    }
  }

  Future<void> _drainDeferredReconciliation() async {
    final command = pending;
    if (!current ||
        !_active ||
        historyLoading ||
        command == null ||
        !command.terminal ||
        !command.reconciliationDeferred) {
      return;
    }
    // Consume once; a failure remains an actionable terminal notice.
    command.reconciliationDeferred = false;
    await reconcilePending();
  }

  Future<void> loadOlder() async {
    final selected = conversation;
    if (!current ||
        !_active ||
        selected == null ||
        !historyVerified ||
        !historyHasMore ||
        historyLoading ||
        _messages.isEmpty) {
      return;
    }
    final generation = _historyGeneration;
    final anchor = _messages.first.id;
    historyLoading = true;
    historyFailure = null;
    _publish();
    try {
      final result = await repository.getConversation(
        selected.id,
        sessionScope: scope,
        expectedMeetingId: selected.meetingId,
        beforeMessageId: anchor,
      );
      if (!_ownsHistory(generation, selected.id)) return;
      final seen = _messages.map((message) => message.id).toSet();
      if (result.messages.any((message) => seen.contains(message.id))) {
        throw StateError('Overlapping anchored history.');
      }
      conversation = result.conversation;
      _messages.insertAll(0, result.messages);
      historyHasMore = result.hasMore;
      _historyDepth = _messages.length;
      final command = pending;
      if (command != null && _containsTurnMessages(command, _messages)) {
        _pending.remove(selected.id);
        _stopStatusMonitoring();
      }
    } catch (error) {
      if (!_ownsHistory(generation, selected.id)) return;
      historyFailure = error;
      if (_accessLost(error)) await refreshHistory();
    } finally {
      if (_ownsHistory(generation, selected.id)) {
        historyLoading = false;
        _publish();
        await _drainDeferredReconciliation();
        _scheduleStatusMonitoring();
      }
    }
  }

  Future<void> submit(String rawQuestion) async {
    final selected = conversation;
    final question = rawQuestion.trim();
    if (!canSend ||
        selected == null ||
        question.isEmpty ||
        question.length > 4096) {
      return;
    }
    final command = AssistantPendingTurn(
      AssistantQuestionRequest(
        conversation: selected,
        question: question,
        idempotencyKey: _newKey(),
      ),
      now: _now,
    );
    _pending[selected.id] = command;
    _publish();
    await _send(command);
  }

  bool _ownsCommand(AssistantPendingTurn command) =>
      current && identical(_pending[command.request.conversation.id], command);

  Future<void> retryPending() async {
    final command = pending;
    if (!canRetryPending || command == null || command.terminal) {
      return;
    }
    _stopStatusMonitoring();
    command.busy = true;
    command.retryAllowed = false;
    _publish();
    await _send(command);
  }

  Future<void> _send(AssistantPendingTurn command) async {
    if (!_ownsCommand(command)) return;
    command.failure = null;
    try {
      final turn = await repository.submitQuestion(
        command.request,
        sessionScope: scope,
      );
      if (!_ownsCommand(command)) return;
      if (command.turn != null && !command.turn!.matches(turn)) {
        command.failure = AssistantFailure.fromApi(
          const ApiFailure(
            200,
            ApiFailure.invalidResponseCode,
            'Turn identity changed.',
            remoteOutcomeAmbiguous: true,
          ),
          mutation: true,
        );
        if (command.turn?.state == AssistantTurnState.processing) {
          command.reclaimUncertain = true;
        }
      } else {
        command.turn = AssistantPendingResult(turn);
        command.reclaimUncertain = false;
      }
      command.uncertain = true;
      command.retryAllowed = false;
    } on AssistantFailure catch (error) {
      if (!_ownsCommand(command)) return;
      command.failure = error;
      if (command.turn?.state == AssistantTurnState.processing &&
          error.outcome == AssistantMutationOutcome.unknown) {
        command.reclaimUncertain = true;
      }
      command.uncertain =
          command.uncertain ||
          error.outcome == AssistantMutationOutcome.unknown;
      command.retryAllowed =
          (!command.uncertain &&
              (error.outcome == AssistantMutationOutcome.notDispatched ||
                  error.outcome == AssistantMutationOutcome.rejected)) ||
          (command.turn == null &&
              error.category == AssistantFailureCategory.rateLimited);
      final deadline = _retryDeadline(error, _now());
      command.retryAt = _laterDeadline(command.retryAt, deadline);
      if (error.category == AssistantFailureCategory.rateLimited) {
        _askRetryAt = _laterDeadline(_askRetryAt, deadline);
      }
      if (_accessLost(error) ||
          error.category == AssistantFailureCategory.sourceStale) {
        _hideSelectedHistory(command);
        if (_accessLost(error) &&
            (!_active || conversation?.id != command.request.conversation.id)) {
          await _confirmMeetingAccessLoss(
            command.request.conversation.meetingId,
          );
        }
      }
    } finally {
      if (_ownsCommand(command)) {
        command.busy = false;
        _scheduleCooldownUpdate();
        _publish();
      }
    }
    if (_ownsCommand(command) &&
        _active &&
        conversation?.id == command.request.conversation.id) {
      if (_accessLost(command.failure) ||
          command.failure?.category == AssistantFailureCategory.sourceStale) {
        await refreshHistory();
      } else if (command.uncertain || command.turn != null) {
        await reconcilePending();
      }
      if (_ownsCommand(command) &&
          conversation?.id == command.request.conversation.id &&
          command.canCheck &&
          !command.automaticExhausted) {
        await _checkPending(automatic: true);
      }
    }
  }

  Future<void> checkPending() => _checkPending();

  Future<void> _checkPending({bool automatic = false}) async {
    final command = pending;
    if (!current ||
        !_active ||
        !historyVerified ||
        command == null ||
        !command.canCheck ||
        historyLoading ||
        command.terminal ||
        (automatic && command.automaticExhausted)) {
      return;
    }
    _stopStatusMonitoring();
    if (automatic) {
      command.automaticDeadline ??= _now().add(
        const Duration(seconds: 120),
      );
      command.automaticChecks++;
    }
    final previousTurn = command.turn;
    command.busy = true;
    command.retryAllowed = false;
    _publish();
    try {
      final status = await repository.getTurnStatus(
        command.request,
        sessionScope: scope,
      );
      if (!_ownsCommand(command)) return;
      if (previousTurn != null && !previousTurn.matches(status.turn)) {
        command.failure = AssistantFailure.fromApi(
          const ApiFailure(
            200,
            ApiFailure.invalidResponseCode,
            'Turn identity changed.',
          ),
          mutation: false,
        );
      } else {
        command.failure = null;
        command.turn = AssistantPendingResult(status.turn);
        command.reclaimUncertain = false;
        command.uncertain = true;
        command.retryAllowed = status.recoveryEligible;
        if (status.turn.state == AssistantTurnState.staleSource) {
          _hideSelectedHistory(command);
        }
      }
    } on AssistantFailure catch (error) {
      if (!_ownsCommand(command)) return;
      command.failure = error;
      // A missing turn is not proof a timed-out POST cannot arrive. Only
      // the original key and question may be submitted again.
      command.retryAllowed = error.status == 404 && previousTurn == null;
      final deadline = _retryDeadline(error, _now());
      command.statusRetryAt = _laterDeadline(command.statusRetryAt, deadline);
      command.retryAt = _laterDeadline(command.retryAt, deadline);
      if (_accessLost(error) ||
          error.category == AssistantFailureCategory.sourceStale) {
        _hideSelectedHistory(command);
        if (_accessLost(error) &&
            (!_active || conversation?.id != command.request.conversation.id)) {
          await _confirmMeetingAccessLoss(
            command.request.conversation.meetingId,
          );
        }
      }
    } finally {
      if (_ownsCommand(command)) {
        command.busy = false;
        _scheduleCooldownUpdate();
        _publish();
      }
    }
    if (_ownsCommand(command) &&
        _active &&
        conversation?.id == command.request.conversation.id) {
      final failure = command.failure;
      if (_accessLost(failure) ||
          failure?.category == AssistantFailureCategory.sourceStale ||
          command.turn?.state == AssistantTurnState.staleSource) {
        await refreshHistory();
      } else if (command.terminal ||
          (previousTurn == null && command.turn != null)) {
        await reconcilePending();
      }
      _scheduleStatusMonitoring();
    }
  }

  void _hideSelectedHistory(AssistantPendingTurn command) {
    if (conversation?.id != command.request.conversation.id) return;
    _historyGeneration++;
    _historyDepth = max(_historyDepth, _messages.length);
    _messages.clear();
    historyVerified = false;
    historyHasMore = false;
    historyLoading = false;
    _stopStatusMonitoring();
  }

  void _stopStatusMonitoring() {
    _statusTimer?.cancel();
    _statusTimer = null;
  }

  void _scheduleStatusMonitoring() {
    _stopStatusMonitoring();
    final command = pending;
    if (!current ||
        !_active ||
        !historyVerified ||
        historyLoading ||
        command == null ||
        command.busy ||
        command.terminal ||
        command.retryAllowed ||
        command.automaticExhausted ||
        (!command.uncertain && command.turn == null)) {
      return;
    }
    final now = _now();
    command.automaticDeadline ??= now.add(const Duration(seconds: 120));
    final seconds = switch (command.automaticChecks) {
      0 || 1 => 2,
      2 => 4,
      3 => 8,
      _ => 10,
    };
    var delay = Duration(seconds: seconds);
    final retryAt = command.statusRetryAt;
    if (retryAt != null && retryAt.difference(now) > delay) {
      delay = retryAt.difference(now);
    }
    if (!now.add(delay).isBefore(command.automaticDeadline!)) return;
    _statusTimer = Timer(delay, () {
      _statusTimer = null;
      if (identical(pending, command)) {
        unawaited(_checkPending(automatic: true));
      }
    });
  }

  void _scheduleCooldownUpdate() {
    _cooldownTimer?.cancel();
    if (!current || !_active) return;
    final now = _now();
    final deadlines =
        [
            _creationRetryAt,
            _askRetryAt,
            pending?.retryAt,
            pending?.statusRetryAt,
            if (pending?.reclaimUncertain == true) pending?.automaticDeadline,
          ].whereType<DateTime>().where((value) => value.isAfter(now)).toList()
          ..sort();
    if (deadlines.isEmpty) return;
    _cooldownTimer = Timer(deadlines.first.difference(now), () {
      _publish();
      _scheduleCooldownUpdate();
    });
  }

  Future<void> abandonPending() async {
    final command = pending;
    if (!current || !_active || command == null || !command.canAbandon) {
      return;
    }
    _stopStatusMonitoring();
    _pending.remove(command.request.conversation.id);
    _publish();
    await refreshHistory();
  }

  void releaseTerminalNotice() {
    final command = pending;
    if (!current ||
        !_active ||
        command == null ||
        command.busy ||
        !command.terminal ||
        historyLoading) {
      return;
    }
    _pending.remove(command.request.conversation.id);
    historyFailure = StateError('Terminal result not fully reconciled.');
    _publish();
  }

  String? editRejectedQuestion() {
    final command = pending;
    if (!current || !_active || command == null || !command.canEdit) {
      return null;
    }
    _stopStatusMonitoring();
    _pending.remove(command.request.conversation.id);
    _publish();
    return command.request.question;
  }

  void _sessionChanged() {
    if (_disposed || current) return;
    _stopStatusMonitoring();
    _cooldownTimer?.cancel();
    _listGeneration++;
    _historyGeneration++;
    _conversations.clear();
    _messages.clear();
    _pending.clear();
    _drafts.clear();
    _draftMeetings.clear();
    _presentationOwner = null;
    _invalidationDirty = false;
    conversation = null;
    creation = null;
    creationFailure = null;
    _creationRetryAt = null;
    _askRetryAt = null;
    _creationUncertain = false;
    creating = false;
    listHasMore = false;
    historyHasMore = false;
    listFailure = null;
    historyFailure = null;
    historyVerified = false;
    listLoading = false;
    historyLoading = false;
    notifyListeners();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _stopStatusMonitoring();
    _cooldownTimer?.cancel();
    repository.api.sessionCoordinator.removeListener(_sessionChanged);
    _pending.clear();
    _drafts.clear();
    _draftMeetings.clear();
    _presentationOwner = null;
    _invalidationDirty = false;
    _messages.clear();
    _conversations.clear();
    creation = null;
    conversation = null;
    super.dispose();
  }
}

bool _accessLost(Object? error) =>
    error is ApiFailure && (error.status == 403 || error.status == 404);

bool _waiting(DateTime? deadline, DateTime now) =>
    deadline != null && now.isBefore(deadline);

DateTime? _retryDeadline(AssistantFailure error, DateTime now) {
  final duration = error.retryAfterDuration(now: now);
  return duration == null ? null : now.add(duration);
}

DateTime? _laterDeadline(DateTime? previous, DateTime? candidate) =>
    candidate != null && (previous == null || candidate.isAfter(previous))
    ? candidate
    : previous;
