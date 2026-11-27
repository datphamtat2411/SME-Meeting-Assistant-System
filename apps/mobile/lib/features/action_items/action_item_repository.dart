import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/paged_collection.dart';
import 'package:sme_meeting_assistant/features/meetings/participant_selection.dart';

import 'action_item_invalidation.dart';
import 'action_item_models.dart';

enum ActionItemFailureCategory {
  authentication,
  authorization,
  resourceUnavailable,
  validation,
  businessConflict,
  idempotencyConflict,
  versionConflict,
  missingPrecondition,
  rateLimited,
  timeout,
  transport,
  server,
  invalidResponse,
  rejectedRequest,
  unknown,
}

enum ActionItemMutationOutcome { notDispatched, rejected, unknown }

/// Success returns a verified snapshot; failures retain API diagnostics.
class ActionItemFailure extends ApiFailure {
  ActionItemFailure._(
    ApiFailure source, {
    required this.category,
    required this.outcome,
    this.cause,
  }) : super(
         source.status,
         source.code,
         source.message,
         requestId: source.requestId,
         responseRequestId: source.responseRequestId,
         timestamp: source.timestamp,
         errors: source.errors,
         retryAfter: source.retryAfter,
         headers: source.headers,
         isTransportFailure: source.isTransportFailure,
         remoteOutcomeAmbiguous: source.remoteOutcomeAmbiguous,
       );

  final ActionItemFailureCategory category;
  final ActionItemMutationOutcome outcome;
  final Object? cause;
}

/// Only the repository can construct a mutation-ready representation.
class ActionItemSnapshot {
  const ActionItemSnapshot._({
    required this.item,
    required this.etag,
    required this.sessionScope,
  });

  final ActionItemResource item;
  final String etag;
  final AuthenticatedSessionScope sessionScope;
}

class ActionItemRepository {
  ActionItemRepository({
    required this.api,
    required this.invalidation,
    required this.participantCandidates,
  });

  final ApiClient api;
  final ActionItemInvalidationSignal invalidation;
  final ParticipantCandidateRepository participantCandidates;

  AuthenticatedSessionScope captureSession() {
    final scope = api.authenticatedSessionScope;
    if (scope == null) {
      throw _sessionFailure(ActionItemMutationOutcome.notDispatched);
    }
    _requireCurrent(scope);
    return scope;
  }

  Future<PagedCollection<ActionItemResource>> list(
    ActionItemQuery query, {
    required AuthenticatedSessionScope sessionScope,
  }) => _read(sessionScope, () async {
    final response = await api.get(
      '/action-items',
      query: query.toQueryParameters(),
      sessionScope: sessionScope,
    );
    return PagedCollection<ActionItemResource>.fromResult(
      response,
      (raw) {
        final item = ActionItemResource.fromJson(raw, response: response);
        final meetingId = query.meetingId;
        if (meetingId != null &&
            !sameActionItemIdentity(item.meetingId, meetingId)) {
          throw response.invalidDataFailure();
        }
        return item;
      },
      requestedPage: query.page,
      requestedSize: query.size,
    );
  });

  Future<ActionItemSnapshot> detail(
    String id, {
    required AuthenticatedSessionScope sessionScope,
  }) async {
    requireActionItemUuid(id, 'actionItemId');
    return _read(sessionScope, () async {
      final response = await api.get(_path(id), sessionScope: sessionScope);
      return _snapshot(response, sessionScope, expectedId: id);
    });
  }

  Future<PagedCollection<ActionItemCreationMeeting>> creationMeetings(
    ActionItemCreationMeetingQuery query, {
    required AuthenticatedSessionScope sessionScope,
  }) => _read(sessionScope, () async {
    final response = await api.get(
      '/action-items/creation-meetings',
      query: query.toQueryParameters(),
      sessionScope: sessionScope,
    );
    return PagedCollection<ActionItemCreationMeeting>.fromResult(
      response,
      (raw) => ActionItemCreationMeeting.fromJson(raw, response: response),
      requestedPage: query.page,
      requestedSize: query.size,
    );
  });

  /// Discovery matches both titles and IDs, so the first page is not proof
  /// that a specific meeting is ineligible. Only an exhausted, consistent
  /// search can establish absence. An interrupted scan is a read failure.
  Future<ActionItemCreationMeeting?> findCreationMeeting(
    String meetingId, {
    required AuthenticatedSessionScope sessionScope,
    bool Function()? stillAllowed,
  }) async {
    const size = 20;
    const maxPages = 100;
    int? totalElements;
    final seen = <String>{};
    for (var page = 0; page < maxPages; page++) {
      if (stillAllowed?.call() == false) {
        throw StateError('Creation meeting verification is no longer active.');
      }
      final result = await creationMeetings(
        ActionItemCreationMeetingQuery(
          search: meetingId,
          page: page,
          size: size,
        ),
        sessionScope: sessionScope,
      );
      if (stillAllowed?.call() == false) {
        throw StateError('Creation meeting verification is no longer active.');
      }
      totalElements ??= result.totalElements;
      final remaining = result.totalElements - page * size;
      final expectedCount = remaining > size ? size : remaining;
      if (result.totalElements != totalElements ||
          result.items.length != expectedCount ||
          result.items.any((meeting) => !seen.add(meeting.id.toLowerCase()))) {
        throw StateError('Creation eligibility changed during discovery.');
      }
      for (final meeting in result.items) {
        if (sameActionItemIdentity(meeting.id, meetingId)) return meeting;
      }
      if (!result.hasNext) return null;
    }
    throw StateError('Creation meeting verification exceeded its page limit.');
  }

  Future<PagedCollection<MeetingParticipantCandidate>> assignmentCandidates(
    MeetingCandidateQuery query, {
    required AuthenticatedSessionScope sessionScope,
  }) => _read(sessionScope, () async {
    final page = await participantCandidates.search(
      query,
      sessionScope: sessionScope,
    );
    if (page.items.any((candidate) => !isActionItemUuid(candidate.id))) {
      throw const ApiFailure(
        0,
        ApiFailure.invalidResponseCode,
        'The server returned an invalid assignment candidate.',
      );
    }
    return page;
  });

  /// The invite directory deliberately excludes its caller. Self assignment
  /// remains an explicit selection, subject to server eligibility validation.
  ActionItemAssignee selfCandidate(AuthenticatedSessionScope sessionScope) {
    _requireCurrent(sessionScope);
    return ActionItemAssignee(
      id: sessionScope.userId,
      displayName: api.displayName,
      accountStatus: ActionItemAccountStatus.active,
    );
  }

  Future<ActionItemSnapshot> create(ActionItemCreateIntent intent) => _mutate(
    sessionScope: intent.sessionScope,
    meetingId: intent.input.meetingId,
    send: () => api.post(
      '/action-items',
      intent.input.toJson(),
      headers: {'Idempotency-Key': intent.idempotencyKey},
      sessionScope: intent.sessionScope,
    ),
  );

  Future<ActionItemSnapshot> update(
    ActionItemSnapshot original,
    ActionItemPatch patch,
  ) async {
    _validateSnapshot(original);
    final payload = patch.toJson();
    if (patch.assignee.isSpecified &&
        patch.assignee.value == null &&
        (original.item.status == ActionItemStatus.open ||
            original.item.status == ActionItemStatus.inProgress)) {
      throw ArgumentError('Official active work requires an assignee.');
    }
    return _mutate(
      sessionScope: original.sessionScope,
      meetingId: original.item.meetingId,
      actionItemId: original.item.id,
      expectedStatus: original.item.status,
      expectedSource: original.item.source,
      expectedOfficial: original.item.isOfficial,
      send: () => api.patch(
        _path(original.item.id),
        payload,
        headers: {'If-Match': original.etag},
        sessionScope: original.sessionScope,
      ),
    );
  }

  Future<ActionItemSnapshot> command(
    ActionItemSnapshot original,
    ActionItemCommand command,
  ) async {
    _validateSnapshot(original);
    return _mutate(
      sessionScope: original.sessionScope,
      meetingId: original.item.meetingId,
      actionItemId: original.item.id,
      expectedStatus: command.targetStatus,
      expectedSource: original.item.source,
      expectedOfficial: switch (command) {
        ActionItemCommand.confirm => true,
        ActionItemCommand.reject => false,
        _ => original.item.isOfficial,
      },
      send: () => api.post(
        [_path(original.item.id), command.name].join('/'),
        const <String, dynamic>{},
        headers: {'If-Match': original.etag},
        sessionScope: original.sessionScope,
      ),
    );
  }

  Future<T> _read<T>(
    AuthenticatedSessionScope scope,
    Future<T> Function() operation,
  ) async {
    _requireCurrent(scope);
    try {
      final result = await operation();
      _requireCurrent(scope);
      return result;
    } catch (error) {
      if (!_current(scope)) {
        throw _sessionFailure(ActionItemMutationOutcome.notDispatched);
      }
      if (error is ActionItemFailure) rethrow;
      throw _failure(error, ActionItemMutationOutcome.notDispatched);
    }
  }

  Future<ActionItemSnapshot> _mutate({
    required AuthenticatedSessionScope sessionScope,
    required String meetingId,
    String? actionItemId,
    ActionItemStatus? expectedStatus,
    ActionItemSource? expectedSource,
    bool? expectedOfficial,
    required Future<ApiResult> Function() send,
  }) async {
    _requireCurrent(sessionScope);
    // After handing intent to the shared client, failures without a trusted
    // rejection are conservative: the mutation may already have committed.
    try {
      final response = await send();
      _requireCurrent(sessionScope, outcome: ActionItemMutationOutcome.unknown);
      final result = _snapshot(
        response,
        sessionScope,
        expectedId: actionItemId,
        expectedMeetingId: meetingId,
      );
      if (actionItemId == null &&
          (result.item.source != ActionItemSource.manual ||
              !result.item.isOfficial)) {
        throw response.invalidDataFailure();
      }
      if ((expectedStatus != null && result.item.status != expectedStatus) ||
          (expectedSource != null && result.item.source != expectedSource) ||
          (expectedOfficial != null &&
              result.item.isOfficial != expectedOfficial)) {
        throw response.invalidDataFailure();
      }
      if (!invalidation.invalidate(
        sessionScope: sessionScope,
        meetingId: result.item.meetingId,
        actionItemId: result.item.id,
      )) {
        throw _sessionFailure(ActionItemMutationOutcome.unknown);
      }
      _requireCurrent(sessionScope, outcome: ActionItemMutationOutcome.unknown);
      return result;
    } catch (error) {
      if (!_current(sessionScope)) {
        throw _sessionFailure(ActionItemMutationOutcome.unknown);
      }
      final source = _apiFailure(error);
      final outcome =
          error is ActionItemFailure || error is AuthSessionException
          ? ActionItemMutationOutcome.unknown
          : _outcomeFor(source);
      if (outcome == ActionItemMutationOutcome.unknown) {
        invalidation.invalidate(
          sessionScope: sessionScope,
          meetingId: meetingId,
          actionItemId: actionItemId,
        );
      }
      throw _failure(error, outcome);
    }
  }

  ActionItemSnapshot _snapshot(
    ApiResult response,
    AuthenticatedSessionScope scope, {
    String? expectedId,
    String? expectedMeetingId,
  }) {
    final item = ActionItemResource.fromJson(
      response.objectData(),
      response: response,
    );
    if ((expectedId != null && !sameActionItemIdentity(item.id, expectedId)) ||
        (expectedMeetingId != null &&
            !sameActionItemIdentity(item.meetingId, expectedMeetingId))) {
      throw response.invalidDataFailure();
    }
    final etag = response.etag;
    if (etag == null || !_usableEtag(etag)) {
      throw ActionItemFailure._(
        ApiFailure(
          response.statusCode,
          'ACTION_ITEM_ETAG_MISSING',
          'Core API did not provide a usable Action Item version.',
          requestId: response.requestId,
          responseRequestId: response.responseRequestId,
          timestamp: response.timestamp,
          headers: response.headers,
        ),
        category: ActionItemFailureCategory.missingPrecondition,
        outcome: ActionItemMutationOutcome.notDispatched,
      );
    }
    return ActionItemSnapshot._(item: item, etag: etag, sessionScope: scope);
  }

  void _validateSnapshot(ActionItemSnapshot snapshot) {
    _requireCurrent(snapshot.sessionScope);
    if (!_usableEtag(snapshot.etag)) {
      throw ActionItemFailure._(
        const ApiFailure(
          428,
          'ACTION_ITEM_VERSION_REQUIRED',
          'A server-issued Action Item version is required.',
        ),
        category: ActionItemFailureCategory.missingPrecondition,
        outcome: ActionItemMutationOutcome.notDispatched,
      );
    }
  }

  bool _current(AuthenticatedSessionScope scope) =>
      !invalidation.isDisposed && api.isCurrentAuthenticatedSession(scope);

  void _requireCurrent(
    AuthenticatedSessionScope scope, {
    ActionItemMutationOutcome outcome = ActionItemMutationOutcome.notDispatched,
  }) {
    if (!_current(scope)) throw _sessionFailure(outcome);
  }
}

String _path(String id) => '/action-items/' + Uri.encodeComponent(id);

bool _usableEtag(String value) =>
    RegExp(r'^"[\x21\x23-\x7e]+"$').hasMatch(value);

ActionItemFailure _sessionFailure(ActionItemMutationOutcome outcome) =>
    ActionItemFailure._(
      const ApiFailure(
        401,
        'AUTH_SESSION_CHANGED',
        'The authenticated session changed during the Action Item operation.',
      ),
      category: ActionItemFailureCategory.authentication,
      outcome: outcome,
    );

ApiFailure _apiFailure(Object error) {
  if (error is ApiFailure) return error;
  if (error is AuthSessionException) {
    return error.failure.apiFailure ??
        ApiFailure(
          error.failure.status ?? 401,
          error.failure.machineCode ?? 'AUTH_SESSION_CHANGED',
          error.failure.message,
          requestId: error.failure.requestId,
          responseRequestId: error.failure.responseRequestId,
          retryAfter: error.failure.retryAfter,
        );
  }
  return const ApiFailure(
    0,
    'ACTION_ITEM_REPOSITORY_FAILURE',
    'The Action Item operation could not be completed.',
  );
}

ActionItemFailure _failure(Object error, ActionItemMutationOutcome outcome) {
  final source = _apiFailure(error);
  return ActionItemFailure._(
    source,
    category: error is ActionItemFailure ? error.category : _category(source),
    outcome: outcome,
    cause: error,
  );
}

ActionItemMutationOutcome _outcomeFor(ApiFailure failure) {
  // Redirects are received after dispatch; they are not proof of no write.
  if (failure.transportFailure &&
      !failure.remoteOutcomeAmbiguous &&
      failure.status == 0 &&
      failure.code == 'TLS_ERROR') {
    return ActionItemMutationOutcome.notDispatched;
  }
  if (!failure.transportFailure &&
      !failure.invalidResponse &&
      !failure.remoteOutcomeAmbiguous &&
      failure.status >= 400 &&
      failure.status < 500 &&
      failure.status != 408 &&
      failure.status != 425) {
    return ActionItemMutationOutcome.rejected;
  }
  return ActionItemMutationOutcome.unknown;
}

ActionItemFailureCategory _category(ApiFailure failure) {
  if (failure.invalidResponse) return ActionItemFailureCategory.invalidResponse;
  if (failure.status == 401) return ActionItemFailureCategory.authentication;
  if (failure.status == 403) return ActionItemFailureCategory.authorization;
  if (failure.status == 404) {
    return ActionItemFailureCategory.resourceUnavailable;
  }
  if (failure.status == 412) return ActionItemFailureCategory.versionConflict;
  if (failure.status == 428 ||
      failure.code == 'ACTION_ITEM_ETAG_MISSING' ||
      failure.code == 'ACTION_ITEM_VERSION_REQUIRED') {
    return ActionItemFailureCategory.missingPrecondition;
  }
  if (failure.status == 409) {
    return failure.code.contains('IDEMPOTENCY')
        ? ActionItemFailureCategory.idempotencyConflict
        : ActionItemFailureCategory.businessConflict;
  }
  if (failure.status == 429) return ActionItemFailureCategory.rateLimited;
  if (failure.status == 408 ||
      failure.status == 425 ||
      failure.code == 'NETWORK_TIMEOUT' ||
      failure.code == 'REQUEST_TIMEOUT') {
    return ActionItemFailureCategory.timeout;
  }
  if (failure.transportFailure) return ActionItemFailureCategory.transport;
  if (failure.serverFailure) return ActionItemFailureCategory.server;
  if (failure.status == 400 || failure.status == 422) {
    return ActionItemFailureCategory.validation;
  }
  if (failure.status >= 400 && failure.status < 500) {
    return ActionItemFailureCategory.rejectedRequest;
  }
  return ActionItemFailureCategory.unknown;
}
