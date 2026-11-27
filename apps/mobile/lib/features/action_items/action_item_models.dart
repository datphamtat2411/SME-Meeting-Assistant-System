import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/api_model_validation.dart';

enum ActionItemStatus {
  proposed('PROPOSED'),
  open('OPEN'),
  inProgress('IN_PROGRESS'),
  done('DONE'),
  cancelled('CANCELLED');

  const ActionItemStatus(this.apiValue);
  final String apiValue;
}

enum ActionItemSource {
  manual('MANUAL'),
  aiExtracted('AI_EXTRACTED');

  const ActionItemSource(this.apiValue);
  final String apiValue;
}

enum ActionItemCommand {
  confirm('CONFIRM'),
  reject('REJECT'),
  start('START'),
  complete('COMPLETE'),
  cancel('CANCEL'),
  reopen('REOPEN');

  const ActionItemCommand(this.apiValue);
  final String apiValue;

  // Validate the shape of the server's command projection, not caller rights.
  bool validFrom(ActionItemStatus status) => switch (this) {
    ActionItemCommand.confirm ||
    ActionItemCommand.reject => status == ActionItemStatus.proposed,
    ActionItemCommand.start => status == ActionItemStatus.open,
    ActionItemCommand.complete || ActionItemCommand.cancel =>
      status == ActionItemStatus.open || status == ActionItemStatus.inProgress,
    ActionItemCommand.reopen => status == ActionItemStatus.done,
  };

  ActionItemStatus get targetStatus => switch (this) {
    ActionItemCommand.confirm ||
    ActionItemCommand.reopen => ActionItemStatus.open,
    ActionItemCommand.reject ||
    ActionItemCommand.cancel => ActionItemStatus.cancelled,
    ActionItemCommand.start => ActionItemStatus.inProgress,
    ActionItemCommand.complete => ActionItemStatus.done,
  };

  bool get requiresActiveAssignee =>
      this != ActionItemCommand.reject && this != ActionItemCommand.cancel;
}

enum ActionItemAccountStatus {
  active('ACTIVE'),
  inactive('INACTIVE'),
  pendingSetup('PENDING_SETUP');

  const ActionItemAccountStatus(this.apiValue);
  final String apiValue;
}

enum ActionItemSortField { createdAt, dueDate, status, title }

enum ActionItemSortDirection { asc, desc }

T _enumValue<T>(
  Iterable<T> values,
  Object? raw,
  String Function(T) wireValue,
  ApiResult? response,
) {
  for (final value in values) {
    if (wireValue(value) == raw) return value;
  }
  invalidApiData(response: response);
}

final _uuidPattern = RegExp(
  r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
);

bool isActionItemUuid(String value) => _uuidPattern.hasMatch(value);

void requireActionItemUuid(String value, String field) {
  if (!isActionItemUuid(value)) {
    throw ArgumentError.value(value, field, 'Must be a UUID.');
  }
}

String _requiredUuid(
  Map<String, dynamic> raw,
  String field,
  ApiResult? response,
) {
  final value = requiredIdentifier(raw, field, response: response);
  if (!isActionItemUuid(value)) invalidApiData(response: response);
  return value;
}

String? _optionalUuid(
  Map<String, dynamic> raw,
  String field,
  ApiResult? response,
) {
  final value = optionalIdentifier(raw, field, response: response);
  if (value != null && !isActionItemUuid(value)) {
    invalidApiData(response: response);
  }
  return value;
}

bool sameActionItemIdentity(String a, String b) =>
    a.toLowerCase() == b.toLowerCase();

const _actionItemEvidenceAvailability = {
  'AVAILABLE',
  'UNAVAILABLE',
  'STALE',
  'RESTRICTED',
  'NOT_APPLICABLE',
};

const _actionItemEvidenceFreshness = {
  'CURRENT',
  'STALE',
  'UNKNOWN',
  'RESTRICTED',
  'NOT_APPLICABLE',
};

class ActionItemEvidenceReference {
  const ActionItemEvidenceReference({
    required this.segmentId,
    required this.ordinal,
    required this.preview,
  });

  final String segmentId;
  final int? ordinal;
  final String? preview;

  factory ActionItemEvidenceReference.fromJson(
    Map<String, dynamic> raw, {
    ApiResult? response,
  }) => ActionItemEvidenceReference(
    segmentId: _requiredUuid(raw, 'segmentId', response),
    ordinal: optionalInt(raw, 'ordinal', response: response),
    preview: optionalString(raw, 'preview', response: response),
  );
}

class ActionItemEvidenceView {
  const ActionItemEvidenceView({
    required this.availability,
    required this.transcriptId,
    required this.contentRevision,
    required this.freshness,
    required this.references,
    required this.limitation,
  });

  final String availability;
  final String? transcriptId;
  final int? contentRevision;
  final String freshness;
  final List<ActionItemEvidenceReference> references;
  final String? limitation;

  factory ActionItemEvidenceView.fromJson(
    Map<String, dynamic> raw, {
    ApiResult? response,
  }) {
    final availability = requiredString(
      raw,
      'availability',
      response: response,
    );
    final freshness = requiredString(raw, 'freshness', response: response);
    if (!_actionItemEvidenceAvailability.contains(availability) ||
        !_actionItemEvidenceFreshness.contains(freshness)) {
      invalidApiData(response: response);
    }
    final references =
        requireJsonObjectArray(raw['references'], response: response)
            .map(
              (item) => ActionItemEvidenceReference.fromJson(
                item,
                response: response,
              ),
            )
            .toList(growable: false);
    final ids = references.map((reference) => reference.segmentId).toSet();
    if (ids.length != references.length) invalidApiData(response: response);
    final transcriptId = _optionalUuid(raw, 'transcriptId', response);
    final contentRevision = optionalInt(
      raw,
      'contentRevision',
      response: response,
    );
    if ((availability == 'RESTRICTED' || freshness == 'RESTRICTED') &&
        (transcriptId != null ||
            contentRevision != null ||
            references.isNotEmpty)) {
      invalidApiData(response: response);
    }
    return ActionItemEvidenceView(
      availability: availability,
      transcriptId: transcriptId,
      contentRevision: contentRevision,
      freshness: freshness,
      references: List.unmodifiable(references),
      limitation: optionalString(raw, 'limitation', response: response),
    );
  }
}

class ActionItemCapabilities {
  ActionItemCapabilities._({
    required this.canEdit,
    required this.canAssign,
    required this.canConfirm,
    required this.canReject,
    required this.canStart,
    required this.canComplete,
    required this.canCancel,
    required this.canReopen,
    required this.canAccessMeeting,
    required this.canAccessEvidence,
  });

  final bool canEdit;
  final bool canAssign;
  final bool canConfirm;
  final bool canReject;
  final bool canStart;
  final bool canComplete;
  final bool canCancel;
  final bool canReopen;
  final bool canAccessMeeting;
  final bool canAccessEvidence;

  bool allows(ActionItemCommand command) => switch (command) {
    ActionItemCommand.confirm => canConfirm,
    ActionItemCommand.reject => canReject,
    ActionItemCommand.start => canStart,
    ActionItemCommand.complete => canComplete,
    ActionItemCommand.cancel => canCancel,
    ActionItemCommand.reopen => canReopen,
  };

  factory ActionItemCapabilities.fromJson(
    Map<String, dynamic> raw, {
    ApiResult? response,
  }) {
    return ActionItemCapabilities._(
      canEdit: requiredBool(raw, 'canEdit', response: response),
      canAssign: requiredBool(raw, 'canAssign', response: response),
      canConfirm: requiredBool(raw, 'canConfirm', response: response),
      canReject: requiredBool(raw, 'canReject', response: response),
      canStart: requiredBool(raw, 'canStart', response: response),
      canComplete: requiredBool(raw, 'canComplete', response: response),
      canCancel: requiredBool(raw, 'canCancel', response: response),
      canReopen: requiredBool(raw, 'canReopen', response: response),
      canAccessMeeting: requiredBool(
        raw,
        'canAccessMeeting',
        response: response,
      ),
      canAccessEvidence: requiredBool(
        raw,
        'canAccessEvidence',
        response: response,
      ),
    );
  }
}

class ActionItemAssignee {
  const ActionItemAssignee({
    required this.id,
    required this.displayName,
    required this.accountStatus,
    bool? active,
  }) : active = active ?? accountStatus == ActionItemAccountStatus.active;

  final String id;
  final String? displayName;
  final ActionItemAccountStatus accountStatus;
  final bool active;

  factory ActionItemAssignee.fromJson(
    Map<String, dynamic> raw, {
    ApiResult? response,
  }) {
    final active = requiredBool(raw, 'active', response: response);
    final statusValue = optionalString(
      raw,
      'accountStatus',
      response: response,
    );
    final accountStatus = statusValue == null
        ? (active
              ? ActionItemAccountStatus.active
              : ActionItemAccountStatus.inactive)
        : _enumValue(
            ActionItemAccountStatus.values,
            statusValue,
            (value) => value.apiValue,
            response,
          );
    if ((accountStatus == ActionItemAccountStatus.active) != active) {
      invalidApiData(response: response);
    }
    return ActionItemAssignee(
      id: _requiredUuid(raw, 'id', response),
      displayName: optionalString(raw, 'displayName', response: response),
      accountStatus: accountStatus,
      active: active,
    );
  }
}

class ActionItemMeetingContext {
  const ActionItemMeetingContext({
    required this.id,
    required this.title,
    this.restricted = false,
  });

  final String id;
  final String? title;
  final bool restricted;

  factory ActionItemMeetingContext.fromJson(
    Map<String, dynamic> raw, {
    ApiResult? response,
  }) {
    final restricted = requiredBool(raw, 'restricted', response: response);
    final label = requiredString(
      raw,
      'label',
      response: response,
      nonEmpty: true,
    );
    return ActionItemMeetingContext(
      id: _requiredUuid(raw, 'id', response),
      title: restricted ? null : label,
      restricted: restricted,
    );
  }
}

/// Feature-owned canonical projection. The old UI model is transitional.
class ActionItemResource {
  const ActionItemResource._({
    required this.id,
    required this.meetingId,
    required this.title,
    required this.details,
    required this.status,
    required this.source,
    required this.isOfficial,
    required this.assigneeUserId,
    required this.assignee,
    required this.dueDate,
    required this.overdue,
    required this.meeting,
    required this.evidence,
    required this.capabilities,
    required this.processingJobId,
    required this.createdByUserId,
    required this.confirmedByUserId,
    required this.confirmedAt,
    required this.completedByUserId,
    required this.completedAt,
    required this.cancelledByUserId,
    required this.cancelledAt,
    required this.version,
    required this.createdAt,
    required this.updatedAt,
  });

  final String id;
  final String meetingId;
  final String title;
  final String? details;
  final ActionItemStatus status;
  final ActionItemSource source;
  final bool isOfficial;
  final String? assigneeUserId;
  final ActionItemAssignee? assignee;
  final String? dueDate;
  final bool overdue;
  final ActionItemMeetingContext meeting;
  final ActionItemEvidenceView evidence;
  final ActionItemCapabilities capabilities;
  final String? processingJobId;
  final String? createdByUserId;
  final String? confirmedByUserId;
  final DateTime? confirmedAt;
  final String? completedByUserId;
  final DateTime? completedAt;
  final String? cancelledByUserId;
  final DateTime? cancelledAt;
  final int version;
  final DateTime createdAt;
  final DateTime updatedAt;

  /// Transitional aliases for the existing Mobile presentation surface.
  bool get official => isOfficial;
  ActionItemMeetingContext get meetingContext => meeting;

  factory ActionItemResource.fromJson(
    Map<String, dynamic> raw, {
    ApiResult? response,
  }) {
    final meetingId = _requiredUuid(raw, 'meetingId', response);
    final assigneeId = _optionalUuid(raw, 'assigneeUserId', response);
    final rawAssignee = optionalObject(raw, 'assignee', response: response);
    final assignee = rawAssignee == null
        ? null
        : ActionItemAssignee.fromJson(rawAssignee, response: response);
    final context = ActionItemMeetingContext.fromJson(
      requiredObject(raw, 'meeting', response: response),
      response: response,
    );
    final capabilities = ActionItemCapabilities.fromJson(
      requiredObject(raw, 'capabilities', response: response),
      response: response,
    );
    final evidence = ActionItemEvidenceView.fromJson(
      requiredObject(raw, 'evidence', response: response),
      response: response,
    );
    if ((assigneeId == null) != (assignee == null) ||
        (assignee != null &&
            !sameActionItemIdentity(assignee.id, assigneeId!)) ||
        !sameActionItemIdentity(context.id, meetingId) ||
        (context.restricted != !capabilities.canAccessMeeting) ||
        (!capabilities.canAccessMeeting && context.title != null) ||
        (!capabilities.canAccessEvidence &&
            evidence.availability == 'AVAILABLE')) {
      invalidApiData(response: response);
    }
    // Restricted projections cannot carry meeting provenance or attribution.
    if (!capabilities.canAccessMeeting &&
        const [
          'processingJobId',
          'createdByUserId',
          'confirmedByUserId',
          'confirmedAt',
          'completedByUserId',
          'completedAt',
          'cancelledByUserId',
          'cancelledAt',
        ].any((field) => raw[field] != null)) {
      invalidApiData(response: response);
    }
    final status = _enumValue(
      ActionItemStatus.values,
      raw['status'],
      (value) => value.apiValue,
      response,
    );
    final source = _enumValue(
      ActionItemSource.values,
      raw['sourceType'],
      (value) => value.apiValue,
      response,
    );
    final isOfficial = requiredBool(raw, 'isOfficial', response: response);
    if ((status == ActionItemStatus.proposed && isOfficial) ||
        (source == ActionItemSource.manual && !isOfficial) ||
        (!isOfficial &&
            status != ActionItemStatus.proposed &&
            status != ActionItemStatus.cancelled)) {
      invalidApiData(response: response);
    }
    if ((status == ActionItemStatus.open ||
            status == ActionItemStatus.inProgress ||
            status == ActionItemStatus.done) &&
        assigneeId == null) {
      invalidApiData(response: response);
    }
    if ((status == ActionItemStatus.done ||
            status == ActionItemStatus.cancelled) &&
        (capabilities.canEdit || capabilities.canAssign)) {
      invalidApiData(response: response);
    }
    if (ActionItemCommand.values.any(
      (command) =>
          capabilities.allows(command) &&
          (!command.validFrom(status) ||
              (command.requiresActiveAssignee && assignee?.active != true)),
    )) {
      invalidApiData(response: response);
    }
    return ActionItemResource._(
      id: _requiredUuid(raw, 'id', response),
      meetingId: meetingId,
      title: requiredString(raw, 'title', response: response, nonEmpty: true),
      details: optionalString(raw, 'details', response: response),
      status: status,
      source: source,
      isOfficial: isOfficial,
      assigneeUserId: assigneeId,
      assignee: assignee,
      dueDate: optionalDateOnly(raw, 'dueDate', response: response),
      overdue: requiredBool(raw, 'overdue', response: response),
      meeting: context,
      evidence: evidence,
      capabilities: capabilities,
      processingJobId: _optionalUuid(raw, 'processingJobId', response),
      createdByUserId: _optionalUuid(raw, 'createdByUserId', response),
      confirmedByUserId: _optionalUuid(raw, 'confirmedByUserId', response),
      confirmedAt: optionalTimestamp(raw, 'confirmedAt', response: response),
      completedByUserId: _optionalUuid(raw, 'completedByUserId', response),
      completedAt: optionalTimestamp(raw, 'completedAt', response: response),
      cancelledByUserId: _optionalUuid(raw, 'cancelledByUserId', response),
      cancelledAt: optionalTimestamp(raw, 'cancelledAt', response: response),
      version: requiredInt(raw, 'version', response: response),
      createdAt: requiredTimestamp(raw, 'createdAt', response: response),
      updatedAt: requiredTimestamp(raw, 'updatedAt', response: response),
    );
  }
}

class ActionItemAssigneeFilter {
  const ActionItemAssigneeFilter.me() : apiValue = 'me';

  factory ActionItemAssigneeFilter.user(String id) {
    requireActionItemUuid(id, 'assigneeUserId');
    return ActionItemAssigneeFilter._(id);
  }

  const ActionItemAssigneeFilter._(this.apiValue);
  final String apiValue;
}

void _validatePage(int page, int size) {
  if (page < 0 || size < 1 || size > 100) {
    throw ArgumentError('Invalid zero-based page or page size.');
  }
}

String? _search(String? value) {
  if (value != null && value.length > 200) {
    throw ArgumentError('Search must not exceed 200 characters.');
  }
  final trimmed = value?.trim();
  return trimmed == null || trimmed.isEmpty ? null : trimmed;
}

class ActionItemQuery {
  ActionItemQuery({
    this.meetingId,
    this.status,
    this.assignee,
    this.overdue,
    this.official,
    this.reviewable,
    String? search,
    this.page = 0,
    this.size = 20,
    this.sortField = ActionItemSortField.createdAt,
    this.sortDirection = ActionItemSortDirection.desc,
  }) : search = _search(search) {
    _validatePage(page, size);
    if (meetingId != null) requireActionItemUuid(meetingId!, 'meetingId');
  }

  final String? meetingId;
  final ActionItemStatus? status;
  final ActionItemAssigneeFilter? assignee;
  final bool? overdue;
  final bool? official;
  final bool? reviewable;
  final String? search;
  final int page;
  final int size;
  final ActionItemSortField sortField;
  final ActionItemSortDirection sortDirection;

  Map<String, String> toQueryParameters() => {
    if (meetingId != null) 'meetingId': meetingId!,
    if (status != null) 'status': status!.apiValue,
    if (assignee != null) 'assignee': assignee!.apiValue,
    if (overdue != null) 'overdue': overdue.toString(),
    if (official != null) 'official': official.toString(),
    if (reviewable != null) 'reviewable': reviewable.toString(),
    if (search != null) 'q': search!,
    'page': '$page',
    'size': '$size',
    'sort': [sortField.name, sortDirection.name].join(','),
  };
}

class ActionItemCreationMeetingQuery {
  ActionItemCreationMeetingQuery({
    String? search,
    this.page = 0,
    this.size = 20,
  }) : search = _search(search) {
    _validatePage(page, size);
  }

  final String? search;
  final int page;
  final int size;

  Map<String, String> toQueryParameters() => {
    if (search != null) 'q': search!,
    'page': '$page',
    'size': '$size',
  };
}

class ActionItemCreationMeeting {
  const ActionItemCreationMeeting._({
    required this.id,
    required this.title,
    required this.canReadMeetingContext,
  });

  final String id;
  final String? title;
  final bool canReadMeetingContext;

  factory ActionItemCreationMeeting.fromJson(
    Map<String, dynamic> raw, {
    ApiResult? response,
  }) {
    final title = optionalString(raw, 'title', response: response);
    final canRead = requiredBool(
      raw,
      'canReadMeetingContext',
      response: response,
    );
    if (!canRead && title != null) invalidApiData(response: response);
    return ActionItemCreationMeeting._(
      id: _requiredUuid(raw, 'id', response),
      title: title,
      canReadMeetingContext: canRead,
    );
  }
}

bool _control(int c) => c < 32 || (c >= 127 && c <= 159);

String _title(String value) {
  final trimmed = value.trim();
  if (value.length > 500 || trimmed.isEmpty || trimmed.runes.any(_control)) {
    throw ArgumentError('Invalid Action Item title.');
  }
  return trimmed;
}

String? _details(String? value) {
  if (value == null) return null;
  final trimmed = value.trim();
  if (value.length > 10000 ||
      trimmed.runes.any((c) => _control(c) && c != 10 && c != 9)) {
    throw ArgumentError('Invalid Action Item details.');
  }
  return trimmed.isEmpty ? null : trimmed;
}

String? _dueDate(String? value) {
  if (value != null && !isValidDateOnly(value)) {
    throw ArgumentError('Due date must be a valid ISO calendar date.');
  }
  return value;
}

class ActionItemCreateInput {
  ActionItemCreateInput({
    required this.meetingId,
    required String title,
    required this.assigneeUserId,
    String? details,
    String? dueDate,
  }) : title = _title(title),
       details = _details(details),
       dueDate = _dueDate(dueDate) {
    requireActionItemUuid(meetingId, 'meetingId');
    requireActionItemUuid(assigneeUserId, 'assigneeUserId');
  }

  final String meetingId;
  final String title;
  final String assigneeUserId;
  final String? details;
  final String? dueDate;

  Map<String, dynamic> toJson() => {
    'meetingId': meetingId,
    'title': title,
    'assigneeUserId': assigneeUserId,
    'details': details,
    'dueDate': dueDate,
  };
}

class ActionItemCreateIntent {
  ActionItemCreateIntent({
    required this.input,
    required this.idempotencyKey,
    required this.sessionScope,
  }) {
    if (!RegExp(r'^[A-Za-z0-9][A-Za-z0-9._~:-]{0,127}$')
        .hasMatch(idempotencyKey)) {
      throw ArgumentError('Invalid Idempotency-Key.');
    }
  }

  final ActionItemCreateInput input;
  final String idempotencyKey;
  final AuthenticatedSessionScope sessionScope;
}

class ActionItemFieldUpdate<T> {
  const ActionItemFieldUpdate.unchanged() : isSpecified = false, _value = null;

  const ActionItemFieldUpdate.set(T value) : isSpecified = true, _value = value;

  final bool isSpecified;
  final T? _value;

  T get value {
    if (!isSpecified) throw StateError('Field was not specified.');
    return _value as T;
  }
}

class ActionItemPatch {
  ActionItemPatch({
    this.title = const ActionItemFieldUpdate<String>.unchanged(),
    this.details = const ActionItemFieldUpdate<String?>.unchanged(),
    this.assignee = const ActionItemFieldUpdate<String?>.unchanged(),
    this.dueDate = const ActionItemFieldUpdate<String?>.unchanged(),
  }) {
    if (toJson().isEmpty) throw ArgumentError('Patch must contain a field.');
  }

  final ActionItemFieldUpdate<String> title;
  final ActionItemFieldUpdate<String?> details;
  final ActionItemFieldUpdate<String?> assignee;
  final ActionItemFieldUpdate<String?> dueDate;

  Map<String, dynamic> toJson() {
    if (assignee.isSpecified && assignee.value != null) {
      requireActionItemUuid(assignee.value!, 'assigneeUserId');
    }
    return {
      if (title.isSpecified) 'title': _title(title.value),
      if (details.isSpecified) 'details': _details(details.value),
      if (assignee.isSpecified) 'assigneeUserId': assignee.value,
      if (dueDate.isSpecified) 'dueDate': _dueDate(dueDate.value),
    };
  }
}
