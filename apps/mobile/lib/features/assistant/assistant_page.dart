import 'dart:async';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:sme_meeting_assistant/core/app_dependencies.dart';
import 'package:sme_meeting_assistant/core/models.dart';
import 'package:sme_meeting_assistant/core/widgets.dart';

import 'assistant_meeting_picker.dart';
import 'assistant_message_view.dart';
import 'assistant_repository.dart';
import 'assistant_workspace_controller.dart';

class AssistantPage extends StatefulWidget {
  const AssistantPage({
    super.key,
    required this.dependencies,
    required this.active,
  });

  final AppDependencies dependencies;
  final bool active;

  @override
  State<AssistantPage> createState() => _AssistantPageState();
}

class _AssistantPageState extends State<AssistantPage>
    with WidgetsBindingObserver {
  late final AssistantWorkspaceController _controller;
  final _input = TextEditingController();
  final Map<String, String> _drafts = {};
  String? _draftOwner;
  String? _meetingTitle;
  int _selection = 0;
  bool _choosingMeeting = false;
  bool _foreground = true;

  @override
  void initState() {
    super.initState();
    _controller = AssistantWorkspaceController(widget.dependencies.assistant);
    _controller.addListener(_workspaceChanged);
    WidgetsBinding.instance.addObserver(this);
    widget.dependencies.meetingInvalidation.addListener(_invalidate);
    widget.dependencies.resultsInvalidation.addListener(_invalidate);
    widget.dependencies.actionItemInvalidation.addListener(_invalidate);
    _controller.setActive(widget.active);
  }

  @override
  void didUpdateWidget(covariant AssistantPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.active != widget.active) {
      if (!widget.active) _selection++;
      _controller.setActive(widget.active && _foreground);
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final foreground = state == AppLifecycleState.resumed;
    if (foreground == _foreground) return;
    _foreground = foreground;
    if (!foreground) _selection++;
    _controller.setActive(widget.active && foreground);
  }

  void _invalidate() {
    if (widget.active && _foreground) unawaited(_controller.revalidate());
  }

  void _workspaceChanged() {
    if (!_controller.current) {
      _drafts.clear();
      _draftOwner = null;
      _input.clear();
    } else if (_draftOwner != null &&
        _controller.conversation == null &&
        _controller.historyFailure != null) {
      _drafts.remove(_draftOwner);
      _draftOwner = null;
      _input.clear();
    }
  }

  void _saveDraft() {
    final owner = _draftOwner;
    if (owner != null && _controller.current) {
      _drafts[owner] = _input.text;
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    widget.dependencies.meetingInvalidation.removeListener(_invalidate);
    widget.dependencies.resultsInvalidation.removeListener(_invalidate);
    widget.dependencies.actionItemInvalidation.removeListener(_invalidate);
    _controller.removeListener(_workspaceChanged);
    _drafts.clear();
    _controller.dispose();
    _input.dispose();
    super.dispose();
  }

  Future<void> _chooseMeeting() async {
    if (_choosingMeeting ||
        _controller.creating ||
        _controller.creationCoolingDown) {
      return;
    }
    final pickerSelection = _selection;
    setState(() => _choosingMeeting = true);
    try {
      final meeting = await Navigator.push<Meeting>(
        context,
        MaterialPageRoute<Meeting>(
          builder: (_) =>
              AssistantMeetingPicker(dependencies: widget.dependencies),
        ),
      );
      if (!mounted ||
          meeting == null ||
          !widget.active ||
          !_foreground ||
          pickerSelection != _selection ||
          !_controller.current) {
        return;
      }
      final selection = _selection;
      final created = await _controller.create(meeting.id, meeting.title);
      if (!mounted ||
          created == null ||
          !widget.active ||
          !_foreground ||
          !_controller.current ||
          selection != _selection ||
          _controller.conversation != null) {
        return;
      }
      await _open(created, meetingTitle: meeting.title);
    } finally {
      if (mounted) setState(() => _choosingMeeting = false);
    }
  }

  Future<void> _retryCreation() async {
    final selection = _selection;
    final created = await _controller.retryCreation();
    if (!mounted ||
        created == null ||
        !widget.active ||
        !_foreground ||
        !_controller.current ||
        selection != _selection ||
        _controller.conversation != null) {
      return;
    }
    await _open(created);
  }

  Future<void> _open(
    AssistantConversation conversation, {
    String? meetingTitle,
  }) async {
    final selection = ++_selection;
    _saveDraft();
    _draftOwner = conversation.id;
    _input.text = _drafts[conversation.id] ?? '';
    setState(() => _meetingTitle = meetingTitle);
    await _controller.open(conversation);
    if (!mounted ||
        selection != _selection ||
        _controller.conversation?.id != conversation.id ||
        !_controller.historyVerified ||
        meetingTitle != null) {
      return;
    }
    try {
      final meeting = await widget.dependencies.meetings.detail(
        conversation.meetingId,
      );
      if (!mounted ||
          !_controller.current ||
          selection != _selection ||
          _controller.conversation?.id != conversation.id ||
          !_controller.historyVerified ||
          meeting.sessionScope != _controller.scope) {
        return;
      }
      setState(() => _meetingTitle = meeting.meeting.title);
    } on Object {
      // A missing metadata label cannot grant access to conversation history.
    }
  }

  Future<void> _close() async {
    _selection++;
    _saveDraft();
    _draftOwner = null;
    _input.clear();
    setState(() => _meetingTitle = null);
    await _controller.closeConversation();
  }

  void _send() {
    final question = _input.text.trim();
    if (!_controller.canSend || question.isEmpty || question.length > 4096) {
      return;
    }
    FocusScope.of(context).unfocus();
    final submission = _controller.submit(question);
    if (_controller.pending?.request.question == question) {
      _input.clear();
      _drafts.remove(_draftOwner);
    }
    unawaited(submission);
  }

  Future<bool> _confirmRelease(String description) async =>
      await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('Ngừng theo dõi yêu cầu?'),
          content: Text(description),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Tiếp tục theo dõi'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Ngừng theo dõi'),
            ),
          ],
        ),
      ) ??
      false;

  Future<void> _abandonCreation() async {
    final intent = _controller.creation;
    if (await _confirmRelease(
          'Máy chủ có thể đã tạo hội thoại. Thao tác này không hủy yêu cầu '
          'trên máy chủ. Hãy kiểm tra danh sách trước khi tạo lại.',
        ) &&
        mounted &&
        widget.active &&
        _foreground &&
        identical(_controller.creation, intent)) {
      await _controller.abandonCreation();
    }
  }

  Future<void> _abandonTurn(AssistantPendingTurn intent) async {
    if (await _confirmRelease(
          'Máy chủ có thể vẫn đang xử lý. Thao tác này chỉ ngừng theo dõi '
          'trên thiết bị và không gửi lại câu hỏi.',
        ) &&
        mounted &&
        widget.active &&
        _foreground &&
        identical(_controller.pending, intent)) {
      await _controller.abandonPending();
    }
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _controller,
    builder: (context, _) {
      final selected = _controller.conversation;
      return PopScope<Object?>(
        canPop: !widget.active || selected == null,
        onPopInvokedWithResult: (didPop, _) {
          if (!didPop && selected != null) unawaited(_close());
        },
        child: selected == null ? _list(context) : _chat(context, selected),
      );
    },
  );

  Widget _list(BuildContext context) {
    final state = _controller;
    final colors = Theme.of(context).colorScheme;
    final items = state.conversations;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 18, 20, 0),
          child: SectionHeading(
            'Trợ lý AI',
            subtitle: 'Khám phá lại tri thức từ các cuộc họp của bạn.',
            trailing: IconButton(
              tooltip: 'Làm mới hội thoại',
              onPressed: state.refreshList,
              icon: const Icon(Icons.refresh),
            ),
          ),
        ),
        Expanded(
          child: RefreshIndicator(
            onRefresh: state.refreshList,
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.fromLTRB(20, 18, 20, 24),
              children: [
                Padding(
                  padding: EdgeInsets.zero,
                  child: Card(
                    color: colors.primaryContainer,
                    margin: EdgeInsets.zero,
                    child: Padding(
                      padding: const EdgeInsets.all(16),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Icon(
                            Icons.auto_awesome,
                            color: colors.onPrimaryContainer,
                          ),
                          const SizedBox(height: 12),
                          Text(
                            'Hỏi đáp có nguồn tham chiếu',
                            style: Theme.of(context).textTheme.titleMedium
                                ?.copyWith(
                                  color: colors.onPrimaryContainer,
                                  fontWeight: FontWeight.w700,
                                ),
                          ),
                          const SizedBox(height: 6),
                          Text(
                            'Chọn một cuộc họp để tìm quyết định, công việc '
                            'và những thông tin đã thảo luận.',
                            style: TextStyle(color: colors.onPrimaryContainer),
                          ),
                          const SizedBox(height: 14),
                          FilledButton.icon(
                            onPressed:
                                state.creating ||
                                    state.creation != null ||
                                    state.creationCoolingDown ||
                                    _choosingMeeting
                                ? null
                                : _chooseMeeting,
                            icon: const Icon(Icons.add_comment_outlined),
                            label: const Text('Hội thoại mới'),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
                if (state.creation == null && state.creationCoolingDown)
                  Padding(
                    padding: const EdgeInsets.only(top: 12),
                    child: Text(
                      'Có thể tạo hội thoại sau ${DateFormat('HH:mm:ss').format(state.creationRetryAt!.toLocal())}',
                    ),
                  ),
                if (state.creation != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 12),
                    child: ContentCard(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            state.creating
                                ? 'Đang tạo hội thoại…'
                                : 'Chưa xác nhận được hội thoại mới',
                            style: Theme.of(context).textTheme.titleSmall,
                          ),
                          if (state.creationFailure != null)
                            Text(assistantFailureLabel(state.creationFailure!)),
                          if (state.creationCoolingDown)
                            Text(
                              'Thử lại sau ${DateFormat('HH:mm:ss').format(state.creationRetryAt!.toLocal())}',
                            ),
                          Wrap(
                            spacing: 8,
                            children: [
                              TextButton(
                                onPressed: state.canRetryCreation
                                    ? _retryCreation
                                    : null,
                                child: const Text('Thử lại cùng yêu cầu'),
                              ),
                              if (state.canDiscardCreation)
                                TextButton(
                                  onPressed: state.discardRejectedCreation,
                                  child: const Text('Bỏ yêu cầu'),
                                ),
                              if (state.canAbandonCreation)
                                TextButton(
                                  onPressed: _abandonCreation,
                                  child: const Text('Ngừng theo dõi'),
                                ),
                            ],
                          ),
                        ],
                      ),
                    ),
                  ),
                const SizedBox(height: 20),
                Text(
                  'Hội thoại gần đây',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const SizedBox(height: 8),
                if (state.listLoading && items.isEmpty)
                  const Center(
                    child: Padding(
                      padding: EdgeInsets.all(24),
                      child: CircularProgressIndicator(),
                    ),
                  )
                else if (state.listFailure != null && items.isEmpty)
                  MessagePanel(
                    title: 'Không thể tải hội thoại',
                    description: assistantFailureLabel(state.listFailure!),
                    onRetry: state.refreshList,
                  )
                else if (items.isEmpty)
                  const MessagePanel(
                    title: 'Chưa có hội thoại',
                    icon: Icons.chat_bubble_outline,
                    description: 'Bắt đầu từ một cuộc họp bạn được phép đọc.',
                  ),
                for (final item in items)
                  Card(
                    child: ListTile(
                      leading: const CircleAvatar(
                        child: Icon(Icons.chat_bubble_outline),
                      ),
                      title: Text(
                        item.title ?? 'Hội thoại cuộc họp',
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                      subtitle: Text(
                        DateFormat('dd/MM/yyyy · HH:mm')
                            .format(item.updatedAt.toLocal()),
                      ),
                      trailing: const Icon(Icons.chevron_right),
                      onTap: () => _open(item),
                    ),
                  ),
                if (state.listFailure != null && items.isNotEmpty)
                  MessagePanel(
                    title: 'Danh sách cần đồng bộ lại',
                    description: assistantFailureLabel(state.listFailure!),
                    onRetry: state.refreshList,
                  ),
                if (state.listHasMore && items.isNotEmpty)
                  TextButton.icon(
                    onPressed: state.listLoading
                        ? null
                        : state.loadMoreConversations,
                    icon: const Icon(Icons.expand_more),
                    label: Text(
                      state.listLoading ? 'Đang tải…' : 'Xem thêm hội thoại',
                    ),
                  ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _chat(BuildContext context, AssistantConversation selected) {
    final state = _controller;
    final messages = state.messages;
    final pending = state.pending;
    final colors = Theme.of(context).colorScheme;
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(8, 12, 8, 8),
          child: Row(
            children: [
              IconButton(
                tooltip: 'Danh sách hội thoại',
                onPressed: _close,
                icon: const Icon(Icons.arrow_back),
              ),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      state.historyVerified
                          ? selected.title ?? 'Trợ lý cuộc họp'
                          : 'Trợ lý cuộc họp',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    Text(
                      state.historyVerified && _meetingTitle != null
                          ? 'Phạm vi: $_meetingTitle'
                          : 'Phạm vi: một cuộc họp',
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
              IconButton(
                tooltip: 'Đồng bộ lịch sử',
                onPressed: state.historyLoading ? null : state.revalidate,
                icon: const Icon(Icons.refresh),
              ),
            ],
          ),
        ),
        const Divider(height: 1),
        Expanded(
          child: !state.historyVerified
              ? Center(
                  child: state.historyLoading
                      ? const CircularProgressIndicator()
                      : Padding(
                          padding: const EdgeInsets.all(20),
                          child: MessagePanel(
                            title: 'Không thể xác nhận lịch sử',
                            description: state.historyFailure == null
                                ? 'Hãy đồng bộ lại hội thoại.'
                                : assistantFailureLabel(state.historyFailure!),
                            onRetry: state.revalidate,
                          ),
                        ),
                )
              : messages.isEmpty &&
                    pending == null &&
                    state.historyFailure == null
              ? _suggestions(context)
              : ListView.builder(
                  key: ValueKey(selected.id),
                  reverse: true,
                  padding: const EdgeInsets.all(16),
                  itemCount: messages.length + 1,
                  itemBuilder: (context, index) {
                    if (index == messages.length) {
                      return Column(
                        children: [
                          if (state.historyFailure != null)
                            Text(
                              assistantFailureLabel(state.historyFailure!),
                              style: TextStyle(color: colors.error),
                            ),
                          if (state.historyHasMore)
                            TextButton.icon(
                              onPressed: state.historyLoading
                                  ? null
                                  : state.loadOlder,
                              icon: const Icon(Icons.history),
                              label: Text(
                                state.historyLoading
                                    ? 'Đang tải…'
                                    : 'Xem tin nhắn cũ hơn',
                              ),
                            ),
                        ],
                      );
                    }
                    return AssistantMessageView(
                      key: ValueKey(messages[messages.length - 1 - index].id),
                      message: messages[messages.length - 1 - index],
                    );
                  },
                ),
        ),
        if (state.historyVerified && pending != null)
          ConstrainedBox(
            constraints: BoxConstraints(
              maxHeight: MediaQuery.sizeOf(context).height * 0.32,
            ),
            child: SingleChildScrollView(child: _pendingPanel(pending)),
          ),
        if (state.historyVerified && state.askCoolingDown)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
            child: Text(
              'Có thể gửi câu hỏi sau ${DateFormat('HH:mm:ss').format(state.askRetryAt!.toLocal())}',
            ),
          ),
        if (!state.historyVerified)
          const Padding(
            padding: EdgeInsets.all(12),
            child: Text('Cần xác nhận quyền truy cập trước khi tiếp tục.'),
          )
        else if (selected.status == AssistantConversationStatus.archived)
          const Padding(
            padding: EdgeInsets.all(12),
            child: Text('Hội thoại đã lưu trữ · Chỉ đọc'),
          )
        else
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Expanded(
                  child: TextField(
                    controller: _input,
                    enabled: state.canCompose,
                    minLines: 1,
                    maxLines: 4,
                    maxLength: 4096,
                    onChanged: (_) => setState(() {}),
                    textInputAction: TextInputAction.newline,
                    decoration: const InputDecoration(
                      hintText: 'Hỏi về cuộc họp này…',
                      counterText: '',
                    ),
                    buildCounter: (
                      context, {
                      required currentLength,
                      required isFocused,
                      required maxLength,
                    }) => Text('${_input.text.trim().length}/4096'),
                  ),
                ),
                const SizedBox(width: 8),
                IconButton.filled(
                  tooltip: 'Gửi câu hỏi',
                  onPressed:
                      state.canSend &&
                          _input.text.trim().isNotEmpty &&
                          _input.text.trim().length <= 4096
                      ? _send
                      : null,
                  icon: const Icon(Icons.arrow_upward),
                ),
              ],
            ),
          ),
      ],
    );
  }

  Widget _suggestions(BuildContext context) => ListView(
    padding: const EdgeInsets.all(20),
    children: [
      const SizedBox(height: 24),
      Icon(
        Icons.auto_awesome,
        size: 40,
        color: Theme.of(context).colorScheme.primary,
      ),
      const SizedBox(height: 16),
      Text(
        'Bạn muốn tìm hiểu điều gì?',
        textAlign: TextAlign.center,
        style: Theme.of(context).textTheme.titleLarge,
      ),
      const SizedBox(height: 8),
      const Text(
        'Trợ lý chỉ truy vấn nội dung thuộc cuộc họp đã chọn.',
        textAlign: TextAlign.center,
      ),
      const SizedBox(height: 20),
      for (final question in [
        'Cuộc họp đã thống nhất những quyết định nào?',
        'Những công việc nào được giao và ai phụ trách?',
        'Các thời hạn quan trọng là gì?',
      ])
        Card(
          child: ListTile(
            title: Text(question),
            trailing: const Icon(Icons.arrow_upward),
            onTap: _controller.canCompose
                ? () => setState(() => _input.text = question)
                : null,
          ),
        ),
    ],
  );

  Widget _pendingPanel(AssistantPendingTurn pending) => Padding(
    padding: const EdgeInsets.fromLTRB(12, 0, 12, 4),
    child: ContentCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            pending.busy
                ? 'Đang xử lý yêu cầu…'
                : pending.terminal
                ? switch (pending.turn!.state) {
                    AssistantTurnState.completed =>
                      'Đã hoàn tất · Chưa đồng bộ đủ lịch sử',
                    AssistantTurnState.failed =>
                      'Lượt hỏi thất bại · Chưa đồng bộ đủ lịch sử',
                    AssistantTurnState.staleSource =>
                      'Nguồn đã thay đổi · Chưa đồng bộ đủ lịch sử',
                    AssistantTurnState.processing => 'Đang xử lý',
                  }
                : pending.turn?.state == AssistantTurnState.processing
                ? 'AI đang xử lý câu hỏi'
                : 'Chưa xác nhận được kết quả',
            style: Theme.of(context).textTheme.titleSmall,
          ),
          const SizedBox(height: 4),
          Text(
            pending.request.question,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          ),
          if (pending.busy) const LinearProgressIndicator(),
          if (pending.failure != null)
            Text(assistantFailureLabel(pending.failure!)),
          if (!pending.busy)
            Wrap(
              spacing: 8,
              children: [
                if (pending.uncertain || pending.turn != null)
                  TextButton(
                    onPressed: _controller.historyLoading
                        ? null
                        : pending.terminal
                        ? _controller.reconcilePending
                        : pending.canCheck
                        ? _controller.checkPending
                        : null,
                    child: Text(
                      pending.terminal
                          ? 'Đồng bộ lịch sử'
                          : 'Kiểm tra trạng thái',
                    ),
                  ),
                if (pending.statusRetryAt != null &&
                    DateTime.now().isBefore(pending.statusRetryAt!))
                  Text(
                    'Kiểm tra lại sau ${DateFormat('HH:mm:ss').format(pending.statusRetryAt!.toLocal())}',
                  ),
                if (pending.retryAllowed &&
                    pending.retryAt != null &&
                    DateTime.now().isBefore(pending.retryAt!))
                  Text(
                    'Thử lại sau ${DateFormat('HH:mm:ss').format(pending.retryAt!.toLocal())}',
                  ),
                if (pending.retryAllowed)
                  TextButton(
                    onPressed: _controller.canRetryPending
                        ? _controller.retryPending
                        : null,
                    child: const Text('Thử lại cùng câu hỏi'),
                  ),
                if (pending.canEdit)
                  TextButton(
                    onPressed: () {
                      final question = _controller.editRejectedQuestion();
                      if (question != null) {
                        setState(() => _input.text = question);
                      }
                    },
                    child: const Text('Sửa câu hỏi'),
                  ),
                if (pending.canAbandon)
                  TextButton(
                    onPressed: () => _abandonTurn(pending),
                    child: const Text('Ngừng theo dõi'),
                  ),
                if (pending.terminal)
                  TextButton(
                    onPressed: _controller.historyLoading
                        ? null
                        : _controller.releaseTerminalNotice,
                    child: const Text('Đóng thông báo đồng bộ'),
                  ),
              ],
            ),
        ],
      ),
    ),
  );
}

String assistantFailureLabel(Object error) {
  if (error is AssistantFailure) {
    return switch (error.category) {
      AssistantFailureCategory.authentication => 'Phiên đăng nhập đã thay đổi.',
      AssistantFailureCategory.authorization ||
      AssistantFailureCategory.resourceUnavailable =>
        'Hội thoại hoặc nguồn không còn khả dụng.',
      AssistantFailureCategory.validation => 'Yêu cầu không hợp lệ.',
      AssistantFailureCategory.conflict => 'Yêu cầu đang xung đột.',
      AssistantFailureCategory.sourceStale => 'Nguồn đã thay đổi.',
      AssistantFailureCategory.rateLimited =>
        'Tạm thời bị giới hạn lượt hỏi. Hãy chờ và thử lại.',
      AssistantFailureCategory.serviceUnavailable =>
        'Trợ lý tạm thời không khả dụng.',
      AssistantFailureCategory.timeout || AssistantFailureCategory.transport =>
        'Kết nối gián đoạn. Kết quả có thể chưa được xác nhận.',
      AssistantFailureCategory.invalidResponse =>
        'Không thể xác nhận dữ liệu trả về.',
      AssistantFailureCategory.unknown => 'Không thể hoàn thành yêu cầu.',
    };
  }
  return 'Không thể đồng bộ dữ liệu. Hãy thử lại.';
}
