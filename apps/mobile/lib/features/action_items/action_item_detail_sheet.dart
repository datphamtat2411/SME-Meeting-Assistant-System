import 'dart:async';

import 'package:flutter/material.dart';
import 'package:sme_meeting_assistant/core/command_actions.dart';
import 'package:sme_meeting_assistant/core/date_labels.dart';
import 'package:sme_meeting_assistant/core/widgets.dart';

import 'action_item_detail.dart';
import 'action_item_editing.dart';
import 'action_item_models.dart';
import 'action_item_presentation.dart';
import 'action_item_repository.dart';

class ActionItemDetailPage extends StatefulWidget {
  const ActionItemDetailPage({
    super.key,
    required this.repository,
    required this.admission,
    required this.itemId,
    this.expectedMeetingId,
    this.hostIsCurrent,
    this.onClose,
    this.openMeeting,
  });

  final ActionItemRepository repository;
  final ActionItemMutationAdmission admission;
  final String itemId;
  final String? expectedMeetingId;
  final bool Function()? hostIsCurrent;
  final VoidCallback? onClose;
  final Future<void> Function(BuildContext, String)? openMeeting;

  @override
  State<ActionItemDetailPage> createState() => _ActionItemDetailPageState();
}

class _ActionItemDetailPageState extends State<ActionItemDetailPage> {
  final _form = GlobalKey<FormState>();
  final _title = TextEditingController();
  final _details = TextEditingController();
  final _choices = <ActionItemEditField, ActionItemMergeChoice>{};
  late final ActionItemDetailController _controller;
  ActionItemAssignee? _chosenAssignee;
  ActionItemReconciliation? _shownMerge;
  Object? _localError;
  bool _allowExit = false;
  bool _leaving = false;

  @override
  void initState() {
    super.initState();
    _controller = ActionItemDetailController(
      repository: widget.repository,
      admission: widget.admission,
      itemId: widget.itemId,
      expectedMeetingId: widget.expectedMeetingId,
      hostIsCurrent: widget.hostIsCurrent,
    );
    _controller.addListener(_changed);
    unawaited(_controller.refresh());
  }

  @override
  void dispose() {
    _controller.removeListener(_changed);
    _controller.dispose();
    _title.dispose();
    _details.dispose();
    super.dispose();
  }

  void _changed() {
    if (!mounted) return;
    final draft = _controller.draft;
    if (!_controller.current || draft == null) {
      _title.clear();
      _details.clear();
      _chosenAssignee = null;
      _localError = null;
    } else {
      if (_title.text != draft.title) _title.text = draft.title;
      final details = draft.details ?? '';
      if (_details.text != details) _details.text = details;
    }
    if (!identical(_shownMerge, _controller.reconciliation)) {
      _shownMerge = _controller.reconciliation;
      _choices.clear();
    }
    setState(() {});
  }

  void _changeDraft({
    String? assigneeId,
    bool replaceAssignee = false,
    String? dueDate,
    bool replaceDueDate = false,
  }) {
    final draft = _controller.draft;
    if (draft == null) return;
    _localError = null;
    _controller.setDraft(
      ActionItemDraft(
        title: _title.text,
        details: _details.text,
        assigneeUserId: replaceAssignee ? assigneeId : draft.assigneeUserId,
        dueDate: replaceDueDate ? dueDate : draft.dueDate,
      ),
    );
  }

  Future<void> _pickAssignee() async {
    final original = _controller.draft;
    final snapshot = _controller.snapshot;
    if (snapshot == null || !_controller.canUseSnapshot) return;
    final selected = await pickActionItemAssignee(
      context,
      widget.repository,
      meetingId: snapshot.item.meetingId,
      hostIsCurrent: () =>
          _controller.canUseSnapshot &&
          identical(original, _controller.draft) &&
          identical(snapshot, _controller.snapshot),
    );
    if (!mounted ||
        !_controller.current ||
        !_controller.canUseSnapshot ||
        !identical(original, _controller.draft) ||
        selected == null) {
      return;
    }
    _chosenAssignee = selected;
    _changeDraft(assigneeId: selected.id, replaceAssignee: true);
  }

  Future<void> _pickDate() async {
    final original = _controller.draft;
    final selected = await chooseActionItemDueDate(context, original?.dueDate);
    if (!mounted ||
        !_controller.current ||
        !_controller.canUseSnapshot ||
        !identical(original, _controller.draft) ||
        selected == null) {
      return;
    }
    _changeDraft(dueDate: selected, replaceDueDate: true);
  }

  String _assigneeName(String? id, {ActionItemAssignee? original}) {
    if (id == null) return 'Chưa phân công';
    final possibilities = [
      _chosenAssignee,
      _controller.snapshot?.item.assignee,
      original,
    ];
    for (final assignee in possibilities) {
      if (assignee != null && sameActionItemIdentity(assignee.id, id)) {
        return actionItemAssigneeLabel(assignee);
      }
    }
    return 'Người phụ trách đã chọn';
  }

  Future<void> _save() async {
    if (!(_form.currentState?.validate() ?? false)) return;
    final saved = await _controller.save();
    if (mounted && _controller.current && saved) {
      final proposal =
          _controller.snapshot?.item.status == ActionItemStatus.proposed;
      showSuccess(
        context,
        proposal
            ? 'Đã lưu đề xuất. Hãy xem lại trước khi xác nhận.'
            : 'Đã lưu thay đổi.',
      );
    }
  }

  Future<void> _command(
    ActionItemSnapshot reviewed,
    ActionItemCommand command,
  ) async {
    final destructive =
        command == ActionItemCommand.cancel ||
        command == ActionItemCommand.reject;
    if (!_controller.canExecuteCommand(command, reviewed)) return;
    if (command != ActionItemCommand.start) {
      final accepted = await _confirmReviewedCommand(
        reviewed,
        command,
        destructive: destructive,
      );
      if (!accepted || !mounted || !_controller.current) return;
    }
    if (!mounted || !_controller.current) return;
    if (!_controller.canExecuteCommand(command, reviewed)) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Công việc đã thay đổi. Vui lòng xem lại.'),
        ),
      );
      return;
    }
    final saved = await _controller.command(command, reviewed: reviewed);
    if (mounted && _controller.current && saved) {
      showSuccess(
        context,
        command == ActionItemCommand.confirm
            ? 'Đã xác nhận thành công việc chính thức.'
            : command == ActionItemCommand.reject
            ? 'Đã từ chối đề xuất.'
            : 'Đã cập nhật trạng thái.',
      );
    }
  }

  Future<bool> _confirmReviewedCommand(
    ActionItemSnapshot reviewed,
    ActionItemCommand command, {
    required bool destructive,
  }) async {
    final answer = await showDialog<bool>(
      context: context,
      useRootNavigator: false,
      builder: (dialogContext) => ListenableBuilder(
        listenable: _controller,
        builder: (context, _) {
          final usable =
              mounted && _controller.canExecuteCommand(command, reviewed);
          // A dialog is a protected presentation surface too. Never retain
          // reviewed metadata after the detail workflow invalidates it.
          return AlertDialog(
            title: Text('${actionItemCommandLabel(command)}?'),
            content: Text(
              usable
                  ? _commandDescription(reviewed.item, command)
                  : 'Công việc đã thay đổi. Vui lòng xem lại.',
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(dialogContext, false),
                child: const Text('Quay lại'),
              ),
              FilledButton(
                style: destructive
                    ? FilledButton.styleFrom(
                        backgroundColor: Theme.of(context).colorScheme.error,
                        foregroundColor: Theme.of(context).colorScheme.onError,
                      )
                    : null,
                onPressed: usable
                    ? () => Navigator.pop(
                        dialogContext,
                        mounted &&
                            _controller.canExecuteCommand(command, reviewed),
                      )
                    : null,
                child: Text(actionItemCommandLabel(command)),
              ),
            ],
          );
        },
      ),
    );
    return answer == true;
  }

  String _commandDescription(
    ActionItemResource item,
    ActionItemCommand command,
  ) => switch (command) {
    ActionItemCommand.confirm =>
      'Xác nhận nội dung vừa xem và giao công việc chính thức cho '
          '${actionItemAssigneeLabel(item.assignee)}. '
          'Hạn: ${actionItemDueLabel(item.dueDate)}.',
    ActionItemCommand.reject =>
      'Đề xuất sẽ không trở thành công việc chính thức. Lịch sử vẫn được giữ.',
    ActionItemCommand.start => 'Bắt đầu thực hiện công việc này.',
    ActionItemCommand.complete => 'Xác nhận công việc đã hoàn thành.',
    ActionItemCommand.cancel => 'Công việc sẽ không còn là nghĩa vụ đang thực hiện. Lịch sử vẫn được giữ.',
    ActionItemCommand.reopen =>
      'Công việc sẽ trở lại trạng thái cần làm với người phụ trách hiện tại.',
  };

  Future<bool> _confirmDiscard() async {
    if (!_controller.editing && _controller.unresolved) {
      return confirmCommand(
        context,
        useRootNavigator: false,
        title: 'Rời chi tiết công việc?',
        description: 'Chưa xác định kết quả thao tác. Công việc có thể đã thay đổi trên máy chủ.',
        confirmLabel: 'Rời chi tiết',
      );
    }
    if (!_controller.hasChanges && !_controller.unresolved) return true;
    return confirmCommand(
      context,
      useRootNavigator: false,
      title: 'Bỏ nội dung chỉnh sửa?',
      description: _controller.unresolved
          ? 'Kết quả lưu trước đó chưa được xác định. Công việc có thể đã thay đổi trên máy chủ.'
          : 'Những thay đổi chưa lưu sẽ bị bỏ.',
      confirmLabel: 'Bỏ nội dung',
      destructive: true,
    );
  }

  Future<void> _discardEdit() async {
    if (!await _confirmDiscard() || !mounted || !_controller.current) return;
    _controller.discardEdit(acknowledgeUnresolved: true);
    if (_controller.unresolved || _controller.revalidationRequired) {
      await _controller.refresh();
    }
  }

  Future<void> _requestExit() async {
    if (_controller.busy || _leaving || _allowExit) return;
    _leaving = true;
    final confirmed = !_controller.current || await _confirmDiscard();
    _leaving = false;
    if (!mounted || !confirmed) return;
    setState(() => _allowExit = true);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final close = widget.onClose;
      if (close != null) {
        close();
      } else {
        Navigator.pop(context);
      }
    });
  }

  Widget _readDetail(ActionItemSnapshot snapshot) {
    final item = snapshot.item;
    final capabilities = item.capabilities;
    final enabled = _controller.canUseSnapshot && !_controller.unresolved;
    final commands = ActionItemCommand.values.where(capabilities.allows);
    final proposed = item.status == ActionItemStatus.proposed;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ActionItemStatusIndicators(item: item),
        if (proposed) ...[const SizedBox(height: 12), _proposalReview(item)],
        const SizedBox(height: 12),
        Text(item.title, style: Theme.of(context).textTheme.headlineSmall),
        if (item.details != null) ...[
          const SizedBox(height: 12),
          SelectableText(item.details!),
        ],
        const SizedBox(height: 16),
        ContentCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _label('Người phụ trách', actionItemAssigneeLabel(item.assignee)),
              _label(
                'Cuộc họp',
                actionItemMeetingLabel(item.meetingId, item.meeting.title),
              ),
              _label('Hạn hoàn thành', actionItemDueLabel(item.dueDate)),
              _label(
                'Nguồn',
                item.source == ActionItemSource.manual
                    ? 'Tạo thủ công'
                    : item.isOfficial
                    ? 'AI · Đã xác nhận'
                    : 'Đề xuất từ AI',
              ),
              _label('Ngày tạo', localDateTimeLabel(item.createdAt)),
              _label('Cập nhật', localDateTimeLabel(item.updatedAt)),
              if (item.confirmedAt != null)
                _label('Xác nhận', localDateTimeLabel(item.confirmedAt)),
              if (item.completedAt != null)
                _label('Hoàn thành', localDateTimeLabel(item.completedAt)),
              if (item.cancelledAt != null)
                _label(
                  'Hủy hoặc từ chối',
                  localDateTimeLabel(item.cancelledAt),
                ),
            ],
          ),
        ),
        if (capabilities.canAccessMeeting && widget.openMeeting != null)
          OutlinedButton.icon(
            onPressed: enabled
                ? () {
                    if (_controller.canUseSnapshot &&
                        identical(_controller.snapshot, snapshot)) {
                      unawaited(widget.openMeeting!(context, item.meetingId));
                    }
                  }
                : null,
            icon: const Icon(Icons.video_camera_front_outlined),
            label: const Text('Mở cuộc họp'),
          ),
        if (capabilities.canEdit || capabilities.canAssign)
          OutlinedButton.icon(
            onPressed: !enabled
                ? null
                : () => _controller.beginEdit(reviewed: snapshot),
            icon: const Icon(Icons.edit_outlined),
            label: Text(
              proposed
                  ? (capabilities.canEdit
                        ? 'Chỉnh sửa đề xuất'
                        : 'Phân công đề xuất')
                  : (capabilities.canEdit ? 'Chỉnh sửa' : 'Phân công lại'),
            ),
          ),
        if (!proposed &&
            item.status != ActionItemStatus.cancelled &&
            item.assignee?.accountStatus != ActionItemAccountStatus.active &&
            item.assignee != null)
          MessagePanel(
            title: 'Người phụ trách chưa hoạt động',
            description: capabilities.canAssign
                ? 'Cần phân công người đang hoạt động để tiếp tục công việc.'
                : item.status == ActionItemStatus.done
                ? 'Không thể mở lại với người phụ trách hiện tại.'
                : 'Chỉ người có thẩm quyền mới có thể phân công lại.',
          ),
        if (!capabilities.canEdit &&
            !capabilities.canAssign &&
            commands.isEmpty)
          const Text('Bạn có quyền xem công việc này.'),
        for (final command in commands)
          if (command == ActionItemCommand.confirm ||
              command == ActionItemCommand.start ||
              (command == ActionItemCommand.complete &&
                  item.status == ActionItemStatus.inProgress))
            FilledButton(
              onPressed: !_controller.canExecuteCommand(command, snapshot)
                  ? null
                  : () => _command(snapshot, command),
              child: Text(actionItemCommandLabel(command)),
            )
          else
            OutlinedButton(
              onPressed: !_controller.canExecuteCommand(command, snapshot)
                  ? null
                  : () => _command(snapshot, command),
              style:
                  command == ActionItemCommand.reject ||
                      command == ActionItemCommand.cancel
                  ? OutlinedButton.styleFrom(
                      foregroundColor: Theme.of(context).colorScheme.error,
                    )
                  : null,
              child: Text(actionItemCommandLabel(command)),
            ),
      ],
    );
  }

  Widget _proposalReview(ActionItemResource item) {
    final assignment = item.assignee?.accountStatus;
    final canConfirm = item.capabilities.allows(ActionItemCommand.confirm);
    final explanation = switch (assignment) {
      null => 'Cần phân công một người phụ trách đang hoạt động.',
      ActionItemAccountStatus.inactive =>
        'Người phụ trách đã ngừng hoạt động. Cần phân công lại.',
      ActionItemAccountStatus.pendingSetup =>
        'Người phụ trách chưa kích hoạt tài khoản. Cần phân công lại.',
      ActionItemAccountStatus.active =>
        canConfirm
            ? 'Kiểm tra nội dung, người phụ trách và thời hạn trước khi xác nhận.'
            : 'Bạn không có quyền xác nhận đề xuất ở trạng thái hiện tại.',
    };
    return MessagePanel(
      title: 'Đề xuất AI chưa phải công việc chính thức',
      description: explanation,
    );
  }

  Widget _lifecycleFeedback(ActionItemLifecycleOperation operation) {
    final action = actionItemCommandLabel(operation.command);
    final observed = _controller.snapshot?.item;
    final pending = _controller.revalidationRequired;
    final message = switch (operation.phase) {
      ActionItemLifecyclePhase.unknown =>
        pending || observed == null
            ? 'Thao tác có thể đã được lưu. Cần tải lại trước khi tiếp tục.'
            : 'Trạng thái hiện tại: ${actionItemStateLabel(observed)}. '
                  'Không thể xác định chắc chắn yêu cầu trước đã được thực hiện.',
      ActionItemLifecyclePhase.rejected =>
        pending
            ? 'Yêu cầu bị từ chối. Cần xem lại phiên bản hiện tại.'
            : 'Yêu cầu bị từ chối. ${actionItemFailureLabel(operation.failure)}',
      ActionItemLifecyclePhase.notDispatched =>
        'Chưa gửi yêu cầu. Hãy xem lại công việc trước khi tiếp tục.',
      ActionItemLifecyclePhase.submitting => 'Đang gửi yêu cầu.',
      ActionItemLifecyclePhase.verifiedSuccess => 'Đã cập nhật trạng thái.',
    };
    return MessagePanel(title: 'Thao tác: $action', description: message);
  }

  Widget _label(String label, String value) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: Theme.of(context).textTheme.labelMedium),
        const SizedBox(height: 3),
        Text(value),
      ],
    ),
  );

  Widget _edit(ActionItemResource item, ActionItemDraft draft) {
    final enabled = _controller.canUseSnapshot && !_controller.unresolved;
    return Form(
      key: _form,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ActionItemStatusIndicators(item: item),
          const SizedBox(height: 16),
          ActionItemFields(
            title: _title,
            details: _details,
            assigneeLabel: _assigneeName(draft.assigneeUserId),
            dueDate: draft.dueDate,
            canEdit: enabled && item.capabilities.canEdit,
            canAssign: enabled && item.capabilities.canAssign,
            onChanged: _changeDraft,
            onAssignee: _pickAssignee,
            onDueDate: _pickDate,
            onClearAssignee:
                item.status == ActionItemStatus.proposed &&
                    draft.assigneeUserId != null
                ? () => _changeDraft(replaceAssignee: true)
                : null,
            onClearDueDate: () => _changeDraft(replaceDueDate: true),
          ),
          const SizedBox(height: 16),
          FilledButton(
            onPressed: enabled && _controller.hasChanges ? _save : null,
            child: Text(
              item.status == ActionItemStatus.proposed
                  ? 'Lưu đề xuất và xem lại'
                  : 'Lưu thay đổi',
            ),
          ),
          TextButton(
            onPressed: _controller.busy ? null : _discardEdit,
            child: const Text('Quay lại chi tiết'),
          ),
        ],
      ),
    );
  }

  String _fieldLabel(ActionItemEditField field) => switch (field) {
    ActionItemEditField.title => 'Tên công việc',
    ActionItemEditField.details => 'Mô tả',
    ActionItemEditField.assignee => 'Người phụ trách',
    ActionItemEditField.dueDate => 'Hạn hoàn thành',
  };

  String _fieldValue(
    ActionItemEditField field,
    String? value,
    ActionItemReconciliation merge,
  ) => switch (field) {
    ActionItemEditField.assignee => _assigneeName(
      value,
      original: merge.originalAssignee,
    ),
    ActionItemEditField.dueDate => actionItemDueLabel(value),
    _ => value ?? 'Không có',
  };

  Widget _merge(ActionItemReconciliation merge) {
    final original = merge.originalValues;
    final latest = ActionItemDraft.fromResource(merge.latest.item);
    final changed = {
      ...merge.local.changesFrom(original),
      ...latest.changesFrom(original),
    };
    final required = merge.fieldsRequiringChoice;
    final blocked = merge.blockedFields;
    final canReview = _controller.canUseSnapshot;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        MessagePanel(
          title: 'Xem lại thay đổi trên máy chủ',
          description: merge.intendedChangesReflected
              ? 'Nội dung mong muốn hiện đã có trên máy chủ. Kiểm tra phiên bản hiện tại trước khi tiếp tục.'
              : 'Giữ những thay đổi độc lập và chọn giá trị cho các trường xung đột. Không có thao tác lưu tự động.',
        ),
        for (final field in changed)
          ContentCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  _fieldLabel(field),
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                _label(
                  'Ban đầu',
                  _fieldValue(field, original.value(field), merge),
                ),
                _label(
                  'Của bạn',
                  _fieldValue(field, merge.local.value(field), merge),
                ),
                _label(
                  'Máy chủ',
                  _fieldValue(field, latest.value(field), merge),
                ),
                if (required.contains(field)) ...[
                  if (blocked.contains(field))
                    const Text('Giá trị cũ của bạn không còn được phép.'),
                  Wrap(
                    spacing: 8,
                    children: [
                      ChoiceChip(
                        label: const Text('Giữ của tôi'),
                        selected:
                            _choices[field] == ActionItemMergeChoice.local,
                        onSelected: !canReview || blocked.contains(field)
                            ? null
                            : (_) => setState(
                                () => _choices[field] =
                                    ActionItemMergeChoice.local,
                              ),
                      ),
                      ChoiceChip(
                        label: const Text('Dùng máy chủ'),
                        selected:
                            _choices[field] == ActionItemMergeChoice.server,
                        onSelected: !canReview
                            ? null
                            : (_) => setState(
                                () => _choices[field] =
                                    ActionItemMergeChoice.server,
                              ),
                      ),
                    ],
                  ),
                ],
              ],
            ),
          ),
        FilledButton(
          onPressed: !canReview || !required.every(_choices.containsKey)
              ? null
              : () {
                  try {
                    _controller.acceptReconciliation(_choices);
                  } catch (error) {
                    setState(() => _localError = error);
                  }
                },
          child: const Text('Chấp nhận phiên bản đã xem lại'),
        ),
        TextButton(
          onPressed: _controller.busy ? null : _discardEdit,
          child: const Text('Bỏ chỉnh sửa'),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final snapshot = _controller.snapshot;
    final draft = _controller.draft;
    final merge = _controller.reconciliation;
    final lifecycle = _controller.lifecycleOperation;
    final feedback =
        lifecycle != null &&
            lifecycle.phase != ActionItemLifecyclePhase.verifiedSuccess
        ? lifecycle
        : null;
    return PopScope<void>(
      canPop: _allowExit || (!_controller.busy && !_controller.current),
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _requestExit();
      },
      child: Scaffold(
        appBar: AppBar(
          title: Text(
            _controller.editing
                ? 'Chỉnh sửa công việc'
                : snapshot?.item.status == ActionItemStatus.proposed
                ? 'Xem xét đề xuất AI'
                : 'Chi tiết công việc',
          ),
          leading: IconButton(
            tooltip: 'Quay lại',
            onPressed: _controller.busy ? null : _requestExit,
            icon: const Icon(Icons.arrow_back),
          ),
          actions: [
            IconButton(
              tooltip: 'Tải lại',
              onPressed: _controller.busy || !_controller.current
                  ? null
                  : _controller.refresh,
              icon: const Icon(Icons.refresh),
            ),
          ],
        ),
        body: SafeArea(
          child: !_controller.current
              ? const MessagePanel(title: 'Phiên đăng nhập đã thay đổi')
              : ListView(
                  padding: const EdgeInsets.all(20),
                  children: [
                    if (_controller.busy) const LinearProgressIndicator(),
                    if (feedback != null) _lifecycleFeedback(feedback),
                    if (_localError != null ||
                        (_controller.error != null &&
                            (feedback == null ||
                                _controller.revalidationRequired)))
                      MessagePanel(
                        title: actionItemFailureLabel(
                          _localError ?? _controller.error,
                        ),
                        onRetry: _controller.busy ? null : _controller.refresh,
                      ),
                    if (_controller.revalidationRequired ||
                        (_controller.unresolved && merge == null))
                      MessagePanel(
                        title: 'Cần kiểm tra lại kết quả trước khi tiếp tục',
                        onRetry: _controller.busy ? null : _controller.refresh,
                      ),
                    if (snapshot == null)
                      if (!_controller.busy && _controller.error == null)
                        const MessagePanel(
                          title: 'Công việc không còn khả dụng',
                        )
                      else
                        const SizedBox(height: 16)
                    else if (merge != null)
                      _merge(merge)
                    else if (draft != null)
                      _edit(snapshot.item, draft)
                    else
                      _readDetail(snapshot),
                  ],
                ),
        ),
      ),
    );
  }
}
