import 'dart:async';

import 'package:flutter/material.dart';
import 'package:sme_meeting_assistant/core/command_actions.dart';
import 'package:sme_meeting_assistant/core/widgets.dart';

import 'action_item_creation.dart';
import 'action_item_models.dart';
import 'action_item_presentation.dart';

class ActionItemCreatePage extends StatefulWidget {
  const ActionItemCreatePage({
    super.key,
    required this.controller,
    this.initialMeetingId,
    this.hostIsCurrent,
    this.onClose,
    this.recoveryOnly = false,
  });

  final ActionItemCreationController controller;
  final String? initialMeetingId;
  final bool Function()? hostIsCurrent;
  final ValueChanged<bool>? onClose;
  final bool recoveryOnly;

  @override
  State<ActionItemCreatePage> createState() => _ActionItemCreatePageState();
}

class _ActionItemCreatePageState extends State<ActionItemCreatePage> {
  final _form = GlobalKey<FormState>();
  final _title = TextEditingController();
  final _details = TextEditingController();
  ActionItemCreationMeeting? _meeting;
  ActionItemAssignee? _assignee;
  String? _dueDate;
  Object? _localError;
  bool _checkingInitialMeeting = false;
  bool _leaving = false;
  bool _allowExit = false;
  bool _showRecoveryContext = true;

  ActionItemCreationController get _controller => widget.controller;
  bool get _current =>
      mounted &&
      _controller.current &&
      (widget.hostIsCurrent?.call() ?? true);
  bool get _unresolved =>
      _controller.phase == ActionItemCreationPhase.unresolved;
  bool get _dirty =>
      _title.text.isNotEmpty ||
      _details.text.isNotEmpty ||
      _meeting != null ||
      _assignee != null ||
      _dueDate != null;

  @override
  void initState() {
    super.initState();
    _controller.addListener(_controllerChanged);
    if (_unresolved) {
      _showRecoveryContext = false;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || !_current) return;
        _showRecoveryContext = true;
        unawaited(_controller.refreshRecoveryContext());
      });
    } else if (widget.initialMeetingId != null) {
      _verifyInitialMeeting();
    }
  }

  @override
  void dispose() {
    _controller.removeListener(_controllerChanged);
    _title.dispose();
    _details.dispose();
    super.dispose();
  }

  void _controllerChanged() {
    if (!mounted) return;
    if (!_current) {
      _title.clear();
      _details.clear();
      _meeting = null;
      _assignee = null;
      _dueDate = null;
      _localError = null;
    }
    setState(() {});
  }

  Future<void> _verifyInitialMeeting() async {
    final id = widget.initialMeetingId;
    if (id == null || !_current) return;
    final repository = _controller.repository;
    final scope = repository.captureSession();
    setState(() {
      _checkingInitialMeeting = true;
      _localError = null;
    });
    try {
      final result = await repository.creationMeetings(
        ActionItemCreationMeetingQuery(search: id),
        sessionScope: scope,
      );
      if (!mounted || !_current) return;
      final eligible = result.items.where(
        (meeting) => sameActionItemIdentity(meeting.id, id),
      );
      setState(() {
        _meeting = eligible.firstOrNull;
        if (_meeting == null) {
          _localError = StateError('The selected meeting is not eligible.');
        }
      });
    } catch (error) {
      if (mounted && _current) setState(() => _localError = error);
    } finally {
      if (mounted) setState(() => _checkingInitialMeeting = false);
    }
  }

  Future<void> _pickMeeting() async {
    if (!_current || widget.initialMeetingId != null) return;
    final selected = await pickActionItemCreationMeeting(
      context,
      _controller.repository,
    );
    if (mounted && _current && selected != null) {
      setState(() {
        _meeting = selected;
        _localError = null;
      });
    }
  }

  Future<void> _pickAssignee() async {
    if (!_current) return;
    final selected = await pickActionItemAssignee(
      context,
      _controller.repository,
      hostIsCurrent: widget.hostIsCurrent,
    );
    if (mounted && _current && selected != null) {
      setState(() => _assignee = selected);
    }
  }

  Future<void> _pickDate() async {
    final value = await chooseActionItemDueDate(context, _dueDate);
    if (mounted && _current && value != null) {
      setState(() => _dueDate = value);
    }
  }

  Future<void> _submit() async {
    final meeting = _meeting;
    final assignee = _assignee;
    if (!_current ||
        _controller.busy ||
        meeting == null ||
        (widget.initialMeetingId != null &&
            !sameActionItemIdentity(meeting.id, widget.initialMeetingId!)) ||
        assignee == null ||
        !(_form.currentState?.validate() ?? false)) {
      return;
    }
    setState(() => _localError = null);
    try {
      final input = ActionItemCreateInput(
        meetingId: meeting.id,
        title: _title.text,
        details: _details.text,
        assigneeUserId: assignee.id,
        dueDate: _dueDate,
      );
      final result = await _controller.submit(
        input: input,
        meeting: meeting,
        assignee: assignee,
        stillAllowed: widget.hostIsCurrent,
      );
      if (!mounted || !_current) return;
      if (result != null) _exit(true);
    } catch (error) {
      if (mounted && _current) setState(() => _localError = error);
    }
  }

  Future<void> _retry() async {
    if (!_current || !_controller.canRetry) {
      setState(() {});
      return;
    }
    final result = await _controller.retry(stillAllowed: widget.hostIsCurrent);
    if (mounted && _current && result != null) _exit(true);
  }

  Future<void> _abandon() async {
    final confirmed = await confirmCommand(
      context,
      useRootNavigator: false,
      title: 'Bỏ yêu cầu chưa xác định?',
      description: 'Công việc có thể đã được tạo. Tạo yêu cầu mới có thể dẫn đến trùng công việc. Hãy kiểm tra danh sách trước.',
      confirmLabel: 'Tôi hiểu, bỏ yêu cầu',
      destructive: true,
    );
    if (!mounted || !_current || !confirmed) return;
    _controller.abandon(acknowledged: true);
    _exit(false);
  }

  void _exit(bool saved) {
    if (!mounted || _allowExit) return;
    setState(() => _allowExit = true);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final close = widget.onClose;
      if (close != null) {
        close(saved);
      } else {
        Navigator.pop(context, saved);
      }
    });
  }

  Future<void> _requestExit() async {
    if (_controller.busy || _leaving) return;
    if (!_current || (!_dirty && !_unresolved)) {
      _exit(false);
      return;
    }
    _leaving = true;
    final confirmed = await confirmCommand(
      context,
      useRootNavigator: false,
      title: _unresolved ? 'Đóng biểu mẫu?' : 'Bỏ nội dung chưa lưu?',
      description: _unresolved
          ? 'Yêu cầu chưa xác định vẫn được giữ trong phiên đăng nhập này. Bạn có thể mở lại để kiểm tra hoặc thử lại.'
          : 'Những thay đổi chưa gửi sẽ không được lưu.',
      confirmLabel: 'Đóng',
    );
    _leaving = false;
    if (mounted && confirmed) _exit(false);
  }

  Widget _recovery() {
    final input = _controller.unresolvedIntent?.input;
    final meeting = _showRecoveryContext ? _controller.recoveryMeeting : null;
    final assignee = _showRecoveryContext ? _controller.recoveryAssignee : null;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const MessagePanel(
          title: 'Chưa xác định kết quả tạo công việc',
          description: 'Máy chủ có thể đã lưu công việc. Chỉ thử lại cùng yêu cầu để tránh tạo trùng trong thời hạn cho phép.',
          icon: Icons.info_outline,
        ),
        if (input != null)
          ContentCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  input.title,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                if (input.details != null) Text(input.details!),
                Text(
                  'Cuộc họp: ${meeting == null ? actionItemMeetingReferenceLabel(input.meetingId) : actionItemMeetingLabel(meeting.id, meeting.title)}',
                ),
                Text(
                  'Phụ trách: ${assignee == null ? actionItemAssigneeReferenceLabel(input.assigneeUserId) : actionItemAssigneeLabel(assignee)}',
                ),
                Text('Hạn: ${actionItemDueLabel(input.dueDate)}'),
              ],
            ),
          ),
        if (_controller.error != null)
          Text(actionItemFailureLabel(_controller.error)),
        if (!_controller.canRetry)
          const MessagePanel(
            title: 'Không còn bảo đảm thử lại an toàn',
            description: 'Hãy kiểm tra danh sách công việc. Không gửi lại bằng một khóa mới khi chưa biết kết quả.',
          ),
        FilledButton(
          onPressed: _controller.canRetry ? _retry : null,
          child: const Text('Thử lại cùng yêu cầu'),
        ),
        TextButton(
          onPressed: _abandon,
          child: const Text('Bỏ yêu cầu sau khi kiểm tra'),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final current = _current;
    final busy = _controller.busy;
    final recovering =
        _unresolved || (_controller.unresolvedIntent != null && busy);
    return PopScope<bool>(
      canPop: _allowExit || (!busy && !current),
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _requestExit();
      },
      child: Scaffold(
        appBar: AppBar(
          title: const Text('Tạo công việc'),
          leading: IconButton(
            tooltip: 'Đóng',
            onPressed: busy ? null : _requestExit,
            icon: const Icon(Icons.close),
          ),
        ),
        body: SafeArea(
          child: !current
              ? const MessagePanel(title: 'Phiên đăng nhập đã thay đổi')
              : ListView(
                  padding: const EdgeInsets.all(20),
                  children: [
                    if (busy) const LinearProgressIndicator(),
                    if (recovering)
                      if (busy)
                        const MessagePanel(
                          title: 'Đang kiểm tra kết quả yêu cầu tạo',
                        )
                      else
                        _recovery()
                    else if (widget.recoveryOnly)
                      const MessagePanel(
                        title: 'Yêu cầu trước không còn cần xử lý',
                        description: 'Quay lại danh sách để tạo công việc mới.',
                      )
                    else
                      Form(
                        key: _form,
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            const Text(
                              'Chọn cuộc họp hợp lệ và một người phụ trách.',
                            ),
                            const SizedBox(height: 16),
                            OutlinedButton.icon(
                              onPressed: busy || _checkingInitialMeeting
                                  ? null
                                  : widget.initialMeetingId == null
                                  ? _pickMeeting
                                  : _meeting == null
                                  ? _verifyInitialMeeting
                                  : null,
                              icon: const Icon(
                                Icons.video_camera_front_outlined,
                              ),
                              label: Text(
                                _meeting == null
                                    ? widget.initialMeetingId == null
                                        ? 'Chọn cuộc họp *'
                                        : 'Kiểm tra lại cuộc họp'
                                    : actionItemMeetingLabel(
                                        _meeting!.id,
                                        _meeting!.title,
                                      ),
                              ),
                            ),
                            if (_checkingInitialMeeting)
                              const LinearProgressIndicator(),
                            const SizedBox(height: 12),
                            ActionItemFields(
                              title: _title,
                              details: _details,
                              assigneeLabel: _assignee == null
                                  ? 'Chọn người phụ trách *'
                                  : actionItemAssigneeLabel(_assignee),
                              dueDate: _dueDate,
                              canEdit: !busy,
                              canAssign: !busy,
                              onChanged: () => setState(() {}),
                              onAssignee: _pickAssignee,
                              onDueDate: _pickDate,
                              onClearDueDate: () {
                                setState(() => _dueDate = null);
                              },
                            ),
                            if (_localError != null ||
                                _controller.error != null)
                              MessagePanel(
                                title: actionItemFailureLabel(
                                  _localError ?? _controller.error,
                                ),
                              ),
                            const SizedBox(height: 16),
                            FilledButton.icon(
                              onPressed:
                                  busy ||
                                      _checkingInitialMeeting ||
                                      _meeting == null ||
                                      _assignee == null ||
                                      _title.text.trim().isEmpty
                                  ? null
                                  : _submit,
                              icon: const Icon(Icons.add_task),
                              label: const Text('Tạo công việc'),
                            ),
                          ],
                        ),
                      ),
                  ],
                ),
        ),
      ),
    );
  }
}
