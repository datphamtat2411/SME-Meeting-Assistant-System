import 'package:flutter/material.dart';
import 'package:sme_meeting_assistant/core/date_labels.dart';
import 'package:sme_meeting_assistant/core/widgets.dart';
import 'package:sme_meeting_assistant/features/meetings/participant_selection.dart';

import 'action_item_models.dart';
import 'action_item_picker.dart';
import 'action_item_repository.dart';

String actionItemStatusLabel(ActionItemStatus status) => switch (status) {
  ActionItemStatus.proposed => 'Chờ xác nhận',
  ActionItemStatus.open => 'Cần làm',
  ActionItemStatus.inProgress => 'Đang thực hiện',
  ActionItemStatus.done => 'Đã hoàn thành',
  ActionItemStatus.cancelled => 'Đã hủy',
};

String actionItemStateLabel(ActionItemResource item) =>
    !item.official && item.status == ActionItemStatus.cancelled
    ? 'Đề xuất đã từ chối'
    : actionItemStatusLabel(item.status);

String actionItemMeetingLabel(String id, String? title) =>
    title ?? 'Cuộc họp giới hạn quyền · mã ${id.substring(id.length - 6)}';

String actionItemMeetingReferenceLabel(String id) =>
    'Cuộc họp đã chọn · mã ${id.substring(id.length - 6)}';

String actionItemAssigneeReferenceLabel(String id) =>
    'Người phụ trách đã chọn · mã ${id.substring(id.length - 6)}';

String actionItemAssigneeLabel(ActionItemAssignee? assignee) {
  if (assignee == null) return 'Chưa phân công';
  return switch (assignee.accountStatus) {
    ActionItemAccountStatus.active => assignee.displayName,
    ActionItemAccountStatus.inactive =>
      '${assignee.displayName} (không hoạt động)',
    ActionItemAccountStatus.pendingSetup =>
      '${assignee.displayName} (chưa kích hoạt)',
  };
}

String actionItemDueLabel(String? dueDate) =>
    dueDate == null ? 'Chưa đặt hạn' : localDateLabel(dueDate);

String actionItemCommandLabel(ActionItemCommand command) => switch (command) {
  ActionItemCommand.confirm => 'Xác nhận đề xuất',
  ActionItemCommand.reject => 'Từ chối đề xuất',
  ActionItemCommand.start => 'Bắt đầu',
  ActionItemCommand.complete => 'Hoàn thành',
  ActionItemCommand.cancel => 'Hủy công việc',
  ActionItemCommand.reopen => 'Mở lại',
};

String actionItemFailureLabel(Object? failure) {
  if (failure is ActionItemFailure) {
    if (failure.outcome == ActionItemMutationOutcome.unknown) {
      return 'Chưa xác định kết quả thao tác. Vui lòng kiểm tra lại.';
    }
    return switch (failure.category) {
      ActionItemFailureCategory.authentication =>
        'Phiên đăng nhập đã thay đổi.',
      ActionItemFailureCategory.authorization => 'Bạn không có quyền thao tác.',
      ActionItemFailureCategory.resourceUnavailable =>
        'Công việc không còn khả dụng.',
      ActionItemFailureCategory.validation =>
        'Thông tin chưa hợp lệ. Kiểm tra các trường.',
      ActionItemFailureCategory.versionConflict =>
        'Công việc đã được cập nhật ở nơi khác.',
      ActionItemFailureCategory.missingPrecondition =>
        'Cần tải lại phiên bản công việc trước khi thao tác.',
      ActionItemFailureCategory.businessConflict =>
        'Trạng thái hiện tại không cho phép thao tác.',
      ActionItemFailureCategory.idempotencyConflict =>
        'Yêu cầu tạo công việc bị xung đột.',
      ActionItemFailureCategory.rateLimited =>
        'Quá nhiều yêu cầu. Vui lòng thử lại sau.',
      _ => 'Không thể hoàn tất yêu cầu. Vui lòng thử lại.',
    };
  }
  if (failure is ArgumentError) return 'Thông tin nhập chưa hợp lệ.';
  return 'Không thể hoàn tất yêu cầu. Vui lòng thử lại.';
}

class ActionItemStatusIndicators extends StatelessWidget {
  const ActionItemStatusIndicators({super.key, required this.item});
  final ActionItemResource item;

  @override
  Widget build(BuildContext context) => Wrap(
    spacing: 8,
    runSpacing: 8,
    crossAxisAlignment: WrapCrossAlignment.center,
    children: [
      StatePill(item.status.apiValue, label: actionItemStateLabel(item)),
      if (!item.official) const Chip(label: Text('Đề xuất AI')),
      if (item.overdue)
        Text(
          item.official ? 'Quá hạn' : 'Đã qua hạn đề xuất',
          style: TextStyle(color: Theme.of(context).colorScheme.error),
        ),
    ],
  );
}

Future<ActionItemCreationMeeting?> pickActionItemCreationMeeting(
  BuildContext context,
  ActionItemRepository repository,
) {
  final scope = repository.captureSession();
  return openActionItemPicker(
    context,
    ActionItemPicker<ActionItemCreationMeeting>(
      api: repository.api,
      scope: scope,
      title: 'Chọn cuộc họp',
      load: (search, page) => repository.creationMeetings(
        ActionItemCreationMeetingQuery(search: search, page: page),
        sessionScope: scope,
      ),
      describe: (meeting) => ActionItemPickerOption(
        value: meeting,
        id: meeting.id,
        label: actionItemMeetingLabel(meeting.id, meeting.title),
      ),
    ),
  );
}

Future<ActionItemAssignee?> pickActionItemAssignee(
  BuildContext context,
  ActionItemRepository repository, {
  List<ActionItemAssignee> Function()? readKnown,
  Listenable? knownChanges,
  bool allowKnownInactive = false,
  bool forFilter = false,
  bool Function()? hostIsCurrent,
  Future<ActionItemAssignee?> Function(
    BuildContext,
    ActionItemPicker<ActionItemAssignee>,
  )?
  openPicker,
}) {
  final scope = repository.captureSession();
  final self = repository.selfCandidate(scope);
  final pinned = <ActionItemPickerOption<ActionItemAssignee>>[
    ActionItemPickerOption(
      value: self,
      id: self.id,
      label: '${forFilter ? 'Tôi' : 'Giao cho tôi'} · ${self.displayName}',
    ),
  ];
  final picker = ActionItemPicker<ActionItemAssignee>(
    api: repository.api,
    scope: scope,
    hostIsCurrent: hostIsCurrent,
    title: forFilter ? 'Lọc theo người phụ trách' : 'Chọn người phụ trách',
    minimumSearchLength: 2,
    pinned: pinned,
    pinnedChanges: knownChanges,
    readPinned: () => [
      for (final item in readKnown?.call() ?? const <ActionItemAssignee>[])
        if (!sameActionItemIdentity(item.id, self.id) &&
            (allowKnownInactive ||
                item.accountStatus == ActionItemAccountStatus.active))
          ActionItemPickerOption(
            value: item,
            id: item.id,
            label: actionItemAssigneeLabel(item),
          ),
    ],
    load: (search, page) async => mapActionItemPickerPage(
      await repository.assignmentCandidates(
        MeetingCandidateQuery(search: search, page: page),
        sessionScope: scope,
      ),
      (candidate) => ActionItemAssignee(
        id: candidate.id,
        displayName: candidate.displayName,
        accountStatus: ActionItemAccountStatus.active,
      ),
    ),
    describe: (assignee) => ActionItemPickerOption(
      value: assignee,
      id: assignee.id,
      label: assignee.displayName,
    ),
  );
  return (openPicker ?? openActionItemPicker<ActionItemAssignee>)(
    context,
    picker,
  );
}

/// Shared field presentation; the caller owns the workflow and draft.
class ActionItemFields extends StatelessWidget {
  const ActionItemFields({
    super.key,
    required this.title,
    required this.details,
    required this.assigneeLabel,
    required this.dueDate,
    required this.canEdit,
    required this.canAssign,
    required this.onChanged,
    required this.onAssignee,
    required this.onDueDate,
    this.onClearAssignee,
    this.onClearDueDate,
  });

  final TextEditingController title;
  final TextEditingController details;
  final String assigneeLabel;
  final String? dueDate;
  final bool canEdit;
  final bool canAssign;
  final VoidCallback onChanged;
  final VoidCallback onAssignee;
  final VoidCallback onDueDate;
  final VoidCallback? onClearAssignee;
  final VoidCallback? onClearDueDate;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      TextFormField(
        controller: title,
        readOnly: !canEdit,
        maxLength: 500,
        decoration: const InputDecoration(labelText: 'Tên công việc *'),
        validator: (value) => value == null || value.trim().isEmpty
            ? 'Nhập tên công việc.'
            : null,
        onChanged: (_) => onChanged(),
      ),
      const SizedBox(height: 8),
      TextFormField(
        controller: details,
        readOnly: !canEdit,
        maxLength: 10000,
        maxLines: 4,
        decoration: const InputDecoration(labelText: 'Mô tả'),
        onChanged: (_) => onChanged(),
      ),
      const SizedBox(height: 12),
      OutlinedButton.icon(
        onPressed: canAssign ? onAssignee : null,
        icon: const Icon(Icons.person_search_outlined),
        label: Text(assigneeLabel),
      ),
      if (canAssign && onClearAssignee != null)
        TextButton(
          onPressed: onClearAssignee,
          child: const Text('Bỏ phân công'),
        ),
      const SizedBox(height: 8),
      OutlinedButton.icon(
        onPressed: canEdit ? onDueDate : null,
        icon: const Icon(Icons.event),
        label: Text(actionItemDueLabel(dueDate)),
      ),
      if (canEdit && dueDate != null && onClearDueDate != null)
        TextButton(
          onPressed: onClearDueDate,
          child: const Text('Bỏ hạn hoàn thành'),
        ),
    ],
  );
}

Future<String?> chooseActionItemDueDate(
  BuildContext context,
  String? value,
) async {
  final initial = parseDateOnly(value) ?? DateTime.now();
  final selected = await showDatePicker(
    context: context,
    useRootNavigator: false,
    initialDate: initial,
    firstDate: DateTime(initial.year < 1900 ? initial.year : 1900),
    lastDate: DateTime(initial.year > 2200 ? initial.year : 2200, 12, 31),
  );
  return selected == null ? null : dateOnly(selected);
}
