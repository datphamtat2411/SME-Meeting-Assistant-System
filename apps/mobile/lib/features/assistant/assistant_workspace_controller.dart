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

/// Session-owned intent. The server alone owns canonical messages.
class AssistantPendingTurn {
  AssistantPendingTurn(this.request);

  final AssistantQuestionRequest request;
  AssistantTurn? turn;
  AssistantFailure? failure;
  bool busy = true;
  bool retryAllowed = false;
  bool uncertain = false;
  DateTime? retryAt;

  bool get terminal =>
      turn != null && turn!.state != AssistantTurnState.processing;
  bool get canCheck => !busy && (uncertain || turn != null);
  bool get canEdit =>
      !busy &&
      !uncertain &&
      failure?.outcome == AssistantMutationOutcome.rejected;
}

/// Owns list, selected history and in-memory commands for one session.
/// Separate generations fence independent list and conversation reads.
class AssistantWorkspaceController extends ChangeNotifier {
  AssistantWorkspaceController(this.repository)
    : scope = repository.captureSession() {
    repository.api.sessionCoordinator.addListener(_sessionChanged);
  }

  final AssistantRepository repository;
  final AuthenticatedSessionScope scope;
  bool _disposed = false;
  bool _active = false;
  int _listGeneration = 0;
  int _historyGeneration = 0;
  int _nextPage = 0;
  final List<AssistantConversation> _conversations = [];
  final List<AssistantMessage> _messages = [];
  final Map<String, AssistantPendingTurn> _pending = {};
  AssistantConversation? conversation;
  AssistantCreateConversationRequest? creation;
  AssistantFailure? creationFailure;
  bool _creationUncertain = false;
  DateTime? _creationRetryAt;
  Object? listFailure;
  Object? historyFailure;
  bool listLoading = false;
  bool historyLoading = false;
  bool creating = false;
  bool listHasMore = true;
  bool historyHasMore = false;
  bool historyVerified = false;

  bool get current =>
      !_disposed && repository.api.isCurrentAuthenticatedSession(scope);
  List<AssistantConversation> get conversations =>
      List.unmodifiable(_conversations);
  List<AssistantMessage> get messages => List.unmodifiable(_messages);
  AssistantPendingTurn? get pending => _pending[conversation?.id];
  bool get canSend =>
      current &&
      _active &&
      historyVerified &&
      conversation?.status == AssistantConversationStatus.active &&
      pending == null;
  DateTime? get creationRetryAt => _creationRetryAt;
  bool get canDiscardCreation =>
      !creating &&
      !_creationUncertain &&
      creationFailure?.outcome == AssistantMutationOutcome.rejected;

  void _publish() {
    if (current) notifyListeners();
  }

  bool _ownsHistory(int generation, String id) =>
      current &&
      generation == _historyGeneration &&
      conversation?.id == id;

  void setActive(bool active) {
    if (!current || _active == active) return;
    _active = active;
    if (active) {
      unawaited(revalidate());
    } else {
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
    } else {
      await refreshHistory();
      if (conversation?.id == selected.id && pending?.canCheck == true) {
        await checkPending();
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
    if (!current || !_active || creating || creation != null) {
      return Future.value(null);
    }
    creation = AssistantCreateConversationRequest(
      meetingId: meetingId,
      title: title.length <= 255 ? title : null,
      idempotencyKey: _newKey(),
    );
    _creationUncertain = false;
    _creationRetryAt = null;
    return retryCreation();
  }

  Future<AssistantConversation?> retryCreation() async {
    final command = creation;
    if (!current ||
        !_active ||
        creating ||
        command == null ||
        _waiting(_creationRetryAt)) {
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
      return created;
    } on AssistantFailure catch (error) {
      if (current && identical(command, creation)) {
        creationFailure = error;
        _creationUncertain =
            _creationUncertain ||
            error.outcome == AssistantMutationOutcome.unknown;
        _creationRetryAt = _retryDeadline(error);
      }
      return null;
    } finally {
      if (current) {
        creating = false;
        _publish();
      }
    }
  }

  void discardRejectedCreation() {
    if (!current || !canDiscardCreation) return;
    creation = null;
    creationFailure = null;
    _creationRetryAt = null;
    _publish();
  }

  Future<void> open(AssistantConversation selected) async {
    if (!current || !_active) return;
    conversation = selected;
    await refreshHistory();
    if (conversation?.id == selected.id && pending?.canCheck == true) {
      await checkPending();
    }
  }

  Future<void> closeConversation() async {
    if (!current) return;
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

  Future<void> refreshHistory() async {
    final selected = conversation;
    if (!current || !_active || selected == null) return;
    final generation = ++_historyGeneration;
    historyLoading = true;
    historyVerified = false;
    historyHasMore = false;
    historyFailure = null;
    _messages.clear();
    _publish();
    try {
      final result = await repository.getConversation(
        selected.id,
        sessionScope: scope,
        expectedMeetingId: selected.meetingId,
      );
      if (!_ownsHistory(generation, selected.id)) return;
      conversation = result.conversation;
      _messages.addAll(result.messages);
      historyHasMore = result.hasMore;
      historyVerified = true;
      if (_pending[selected.id]?.terminal == true) {
        _pending.remove(selected.id);
      }
    } catch (error) {
      if (!_ownsHistory(generation, selected.id)) return;
      historyFailure = error;
      if (_accessLost(error)) {
        _pending.remove(selected.id);
        _conversations.clear();
        listFailure = error;
        conversation = null;
      }
    } finally {
      if (current && generation == _historyGeneration) {
        historyLoading = false;
        _publish();
      }
    }
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
    } catch (error) {
      if (!_ownsHistory(generation, selected.id)) return;
      historyFailure = error;
      if (_accessLost(error)) await refreshHistory();
    } finally {
      if (_ownsHistory(generation, selected.id)) {
        historyLoading = false;
        _publish();
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
    );
    _pending[selected.id] = command;
    _publish();
    await _send(command);
  }

  bool _ownsCommand(AssistantPendingTurn command) =>
      current &&
      identical(_pending[command.request.conversation.id], command);

  Future<void> retryPending() async {
    final command = pending;
    if (!_active ||
        !historyVerified ||
        command == null ||
        command.busy ||
        command.terminal ||
        !command.retryAllowed ||
        _waiting(command.retryAt)) {
      return;
    }
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
      command.turn = turn;
      command.uncertain = true;
      command.retryAllowed = false;
    } on AssistantFailure catch (error) {
      if (!_ownsCommand(command)) return;
      command.failure = error;
      command.uncertain =
          command.uncertain || error.outcome == AssistantMutationOutcome.unknown;
      command.retryAllowed =
          error.category == AssistantFailureCategory.rateLimited;
      command.retryAt = _retryDeadline(error);
    } finally {
      if (_ownsCommand(command)) {
        command.busy = false;
        _publish();
      }
    }
    if (_ownsCommand(command) &&
        _active &&
        conversation?.id == command.request.conversation.id) {
      await refreshHistory();
      // Resolve uncertain outcomes by a read, not by replaying inference.
      if (_ownsCommand(command) &&
          conversation?.id == command.request.conversation.id &&
          command.canCheck) {
        await checkPending();
      }
    }
  }

  Future<void> checkPending() async {
    final command = pending;
    if (!current ||
        !_active ||
        !historyVerified ||
        command == null ||
        !command.canCheck ||
        command.terminal) {
      return;
    }
    command.busy = true;
    command.retryAllowed = false;
    _publish();
    try {
      final status = await repository.getTurnStatus(
        command.request,
        sessionScope: scope,
      );
      if (!_ownsCommand(command)) return;
      command.failure = null;
      command.turn = status.turn;
      command.uncertain = true;
      command.retryAllowed = status.recoveryEligible;
    } on AssistantFailure catch (error) {
      if (!_ownsCommand(command)) return;
      command.failure = error;
      // A missing turn is not proof a timed-out POST cannot arrive. Only
      // the original key and question may be submitted again.
      command.retryAllowed = error.status == 404;
      final deadline = _retryDeadline(error);
      if (deadline != null &&
          (command.retryAt == null || deadline.isAfter(command.retryAt!))) {
        command.retryAt = deadline;
      }
    } finally {
      if (_ownsCommand(command)) {
        command.busy = false;
        _publish();
      }
    }
    if (_ownsCommand(command) &&
        _active &&
        conversation?.id == command.request.conversation.id) {
      await refreshHistory();
    }
  }

  String? editRejectedQuestion() {
    final command = pending;
    if (command == null || !command.canEdit) return null;
    _pending.remove(command.request.conversation.id);
    _publish();
    return command.request.question;
  }

  void _sessionChanged() {
    if (_disposed || current) return;
    _listGeneration++;
    _historyGeneration++;
    _conversations.clear();
    _messages.clear();
    _pending.clear();
    conversation = null;
    creation = null;
    creationFailure = null;
    _creationRetryAt = null;
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
    repository.api.sessionCoordinator.removeListener(_sessionChanged);
    _pending.clear();
    _messages.clear();
    _conversations.clear();
    creation = null;
    conversation = null;
    super.dispose();
  }
}

bool _accessLost(Object error) =>
    error is ApiFailure && (error.status == 403 || error.status == 404);

bool _waiting(DateTime? deadline) =>
    deadline != null && DateTime.now().isBefore(deadline);

DateTime? _retryDeadline(AssistantFailure error) {
  final seconds = int.tryParse(error.retryAfter ?? '');
  if (seconds == null || seconds <= 0) return null;
  return DateTime.now().add(Duration(seconds: seconds));
}
