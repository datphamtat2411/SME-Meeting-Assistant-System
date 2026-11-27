import 'action_item_models.dart';
import 'action_item_repository.dart';

enum ActionItemEditField { title, details, assignee, dueDate }

enum ActionItemMergeChoice { local, server }

/// Form values are distinct from a verified resource and its version.
class ActionItemDraft {
  const ActionItemDraft({
    required this.title,
    required this.details,
    required this.assigneeUserId,
    required this.dueDate,
  });

  factory ActionItemDraft.fromResource(ActionItemResource item) =>
      ActionItemDraft(
        title: item.title,
        details: item.details,
        assigneeUserId: item.assigneeUserId,
        dueDate: item.dueDate,
      );

  final String title;
  final String? details;
  final String? assigneeUserId;
  final String? dueDate;

  String? value(ActionItemEditField field) => switch (field) {
    ActionItemEditField.title => title.trim(),
    ActionItemEditField.details =>
      details?.trim().isEmpty ?? true ? null : details!.trim(),
    ActionItemEditField.assignee => assigneeUserId?.toLowerCase(),
    ActionItemEditField.dueDate => dueDate,
  };

  Set<ActionItemEditField> changesFrom(ActionItemDraft original) => {
    for (final field in ActionItemEditField.values)
      if (value(field) != original.value(field)) field,
  };

  ActionItemPatch? patchAgainst(ActionItemResource item) {
    final changed = changesFrom(ActionItemDraft.fromResource(item));
    if (changed.isEmpty) return null;
    if (changed.any((field) => !canChangeActionItemField(item, field))) {
      throw StateError('The current resource does not permit this edit.');
    }
    if (changed.contains(ActionItemEditField.assignee) &&
        assigneeUserId == null &&
        item.status != ActionItemStatus.proposed) {
      throw ArgumentError('Official work requires a primary assignee.');
    }
    return ActionItemPatch(
      title: changed.contains(ActionItemEditField.title)
          ? ActionItemFieldUpdate<String>.set(title)
          : const ActionItemFieldUpdate<String>.unchanged(),
      details: changed.contains(ActionItemEditField.details)
          ? ActionItemFieldUpdate<String?>.set(details)
          : const ActionItemFieldUpdate<String?>.unchanged(),
      assignee: changed.contains(ActionItemEditField.assignee)
          ? ActionItemFieldUpdate<String?>.set(assigneeUserId)
          : const ActionItemFieldUpdate<String?>.unchanged(),
      dueDate: changed.contains(ActionItemEditField.dueDate)
          ? ActionItemFieldUpdate<String?>.set(dueDate)
          : const ActionItemFieldUpdate<String?>.unchanged(),
    );
  }
}

bool canChangeActionItemField(
  ActionItemResource item,
  ActionItemEditField field,
) => field == ActionItemEditField.assignee
    ? item.capabilities.canAssign
    : item.capabilities.canEdit;

/// Reconciliation does not authorize or dispatch a mutation. The user must
/// accept the latest reviewed baseline and explicitly submit remaining edits.
class ActionItemReconciliation {
  factory ActionItemReconciliation({
    required ActionItemSnapshot original,
    required ActionItemDraft local,
    required ActionItemSnapshot latest,
  }) {
    if (original.sessionScope != latest.sessionScope ||
        !sameActionItemIdentity(original.item.id, latest.item.id) ||
        !sameActionItemIdentity(
          original.item.meetingId,
          latest.item.meetingId,
        )) {
      throw ArgumentError('Reconciliation requires the same scoped resource.');
    }
    // Keep only editable values and assignment display information from the
    // old representation. Its protected meeting metadata is not retained.
    return ActionItemReconciliation._(
      originalValues: ActionItemDraft.fromResource(original.item),
      originalAssignee: original.item.assignee,
      local: local,
      latest: latest,
    );
  }

  const ActionItemReconciliation._({
    required this.originalValues,
    required this.originalAssignee,
    required this.local,
    required this.latest,
  });

  final ActionItemDraft originalValues;
  final ActionItemAssignee? originalAssignee;
  final ActionItemDraft local;
  final ActionItemSnapshot latest;

  ActionItemReconciliation withLatest(ActionItemSnapshot snapshot) {
    if (snapshot.sessionScope != latest.sessionScope ||
        !sameActionItemIdentity(snapshot.item.id, latest.item.id) ||
        !sameActionItemIdentity(
          snapshot.item.meetingId,
          latest.item.meetingId,
        )) {
      throw ArgumentError('Reconciliation requires the same scoped resource.');
    }
    return ActionItemReconciliation._(
      originalValues: originalValues,
      originalAssignee: originalAssignee,
      local: local,
      latest: snapshot,
    );
  }

  ActionItemDraft get _base => originalValues;
  ActionItemDraft get _server => ActionItemDraft.fromResource(latest.item);

  Set<ActionItemEditField> get conflicts => {
    for (final field in ActionItemEditField.values)
      if (local.value(field) != _base.value(field) &&
          _server.value(field) != _base.value(field) &&
          local.value(field) != _server.value(field))
        field,
  };

  Set<ActionItemEditField> get blockedFields => {
    for (final field in local.changesFrom(_base))
      if (local.value(field) != _server.value(field) &&
          (!canChangeActionItemField(latest.item, field) ||
              (field == ActionItemEditField.assignee &&
                  local.assigneeUserId == null &&
                  latest.item.status != ActionItemStatus.proposed)))
        field,
  };

  Set<ActionItemEditField> get fieldsRequiringChoice => {
    ...conflicts,
    ...blockedFields,
  };

  bool get intendedChangesReflected => local
      .changesFrom(_base)
      .every((field) => local.value(field) == _server.value(field));

  ActionItemDraft resolve(
    Map<ActionItemEditField, ActionItemMergeChoice> choices,
  ) {
    final requiredChoices = fieldsRequiringChoice;
    final blocked = blockedFields;
    for (final field in requiredChoices) {
      if (!choices.containsKey(field)) {
        throw StateError('Every conflicting field requires a decision.');
      }
      if (blocked.contains(field) &&
          choices[field] != ActionItemMergeChoice.server) {
        throw StateError('The local value is no longer permitted.');
      }
    }

    String? resolved(ActionItemEditField field) {
      if (requiredChoices.contains(field)) {
        return choices[field] == ActionItemMergeChoice.local
            ? local.value(field)
            : _server.value(field);
      }
      if (local.value(field) == _base.value(field)) {
        return _server.value(field);
      }
      return local.value(field);
    }

    return ActionItemDraft(
      title: resolved(ActionItemEditField.title)!,
      details: resolved(ActionItemEditField.details),
      assigneeUserId: resolved(ActionItemEditField.assignee),
      dueDate: resolved(ActionItemEditField.dueDate),
    );
  }
}
