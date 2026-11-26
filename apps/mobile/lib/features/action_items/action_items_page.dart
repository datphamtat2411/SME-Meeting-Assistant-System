import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:sme_meeting_assistant/core/api_client.dart';
import 'package:sme_meeting_assistant/core/app_dependencies.dart';
import 'package:sme_meeting_assistant/core/widgets.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_foundation.dart';

import 'action_item_collection.dart';
import 'action_item_create_sheet.dart';
import 'action_item_creation.dart';
import 'action_item_detail.dart';
import 'action_item_detail_sheet.dart';
import 'action_item_models.dart';
import 'action_item_picker.dart';
import 'action_item_presentation.dart';

class ActionItemsPage extends StatefulWidget {
  const ActionItemsPage({
    super.key,
    required this.dependencies,
    this.active = true,
    this.meetingId,
  });

  final AppDependencies dependencies;
  final bool active;
  final String? meetingId;

  @override
  State<ActionItemsPage> createState() => _ActionItemsPageState();
}

class _ActionItemsPageState extends State<ActionItemsPage> {
  final _search = TextEditingController();
  late final ActionItemMutationAdmission _admission;
  late final ActionItemCollectionController _collection;
  late final ActionItemCreationController _creation;
  late final AuthenticatedSessionScope _scope;
  ActionItemCollectionMode _mode = ActionItemCollectionMode.myWork;
  ActionItemStatus? _status;
  String? _meetingId;
  String? _assigneeId;
  bool? _overdue;
  ActionItemSortField _sort = ActionItemSortField.createdAt;
  ActionItemSortDirection _direction = ActionItemSortDirection.desc;
  bool? _eligible;
  bool _checkingEligibility = false;
  Object? _eligibilityError;
  int _eligibilityGeneration = 0;

  bool get _current =>
      mounted && widget.dependencies.api.isCurrentAuthenticatedSession(_scope);

  @override
  void initState() {
    super.initState();
    final repository = widget.dependencies.actionItems;
    _scope = repository.captureSession();
    if (widget.meetingId != null) {
      _mode = ActionItemCollectionMode.allAccessible;
    }
    _collection = ActionItemCollectionController(
      repository: repository,
      criteria: _criteria(),
      fixedMeetingId: widget.meetingId,
      active: widget.active,
    );
    _creation = widget.dependencies.actionItemWorkflows.creation;
    _admission = widget.dependencies.actionItemWorkflows.admission;
    _collection.addListener(_changed);
    _creation.addListener(_changed);
    if (widget.active) {
      unawaited(_collection.initialize());
      unawaited(_checkEligibility());
    }
  }

  @override
  void didUpdateWidget(covariant ActionItemsPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.active != oldWidget.active) {
      _collection.setActive(widget.active);
      if (widget.active) unawaited(_checkEligibility());
    }
  }

  @override
  void dispose() {
    _eligibilityGeneration++;
    _collection.removeListener(_changed);
    _creation.removeListener(_changed);
    _collection.dispose();
    _search.dispose();
    super.dispose();
  }

  void _changed() {
    if (!mounted) return;
    if (!_current) {
      _search.clear();
      _meetingId = null;
      _assigneeId = null;
      _eligible = null;
      _eligibilityError = null;
      _eligibilityGeneration++;
    }
    setState(() {});
  }

  ActionItemCollectionCriteria _criteria() => ActionItemCollectionCriteria(
    mode: _mode,
    search: _search.text,
    status: _status,
    meetingId: _meetingId,
    assignee: _assigneeId == null
        ? null
        : ActionItemAssigneeFilter.user(_assigneeId!),
    overdue: _overdue,
    sortField: _sort,
    sortDirection: _direction,
  );

  void _apply({bool debounce = false}) {
    if (_current) {
      unawaited(_collection.applyCriteria(_criteria(), debounce: debounce));
    }
  }

  Future<void> _checkEligibility() async {
    if (!_current || !widget.active || _checkingEligibility) return;
    final generation = ++_eligibilityGeneration;
    setState(() {
      _checkingEligibility = true;
      _eligible = null;
      _eligibilityError = null;
    });
    try {
      final result = await widget.dependencies.actionItems.creationMeetings(
        ActionItemCreationMeetingQuery(search: widget.meetingId, size: 1),
        sessionScope: _scope,
      );
      if (!_current || generation != _eligibilityGeneration) return;
      if (result.totalElements > 0 && result.items.isEmpty) {
        throw StateError('Creation eligibility changed during discovery.');
      }
      setState(() {
        _eligible = widget.meetingId == null
            ? result.items.isNotEmpty
            : result.items.any(
                (meeting) =>
                    sameActionItemIdentity(meeting.id, widget.meetingId!),
              );
      });
    } catch (error) {
      if (_current && generation == _eligibilityGeneration) {
        setState(() => _eligibilityError = error);
      }
    } finally {
      if (_current && generation == _eligibilityGeneration) {
        setState(() => _checkingEligibility = false);
      }
    }
  }

  Future<void> _refresh() async {
    await Future.wait([_collection.refresh(), _checkEligibility()]);
  }

  void _changeMode(ActionItemCollectionMode mode) {
    if (_mode == mode) return;
    setState(() {
      _mode = mode;
      if (mode == ActionItemCollectionMode.myWork) {
        _assigneeId = null;
        if (_status == ActionItemStatus.proposed) _status = null;
      }
      if (mode == ActionItemCollectionMode.needsReview) {
        _status = null;
      }
    });
    _apply();
  }

  void _clearFilters() {
    setState(() {
      _search.clear();
      _status = null;
      _meetingId = null;
      _assigneeId = null;
      _overdue = null;
      _sort = ActionItemSortField.createdAt;
      _direction = ActionItemSortDirection.desc;
    });
    _apply();
  }

  Future<void> _openCreate() async {
    if (!_current ||
        (_eligible != true && _creation.unresolvedIntent == null)) {
      return;
    }
    final saved = await Navigator.push<bool>(
      context,
      MaterialPageRoute<bool>(
        builder: (_) => ActionItemCreatePage(
          controller: _creation,
          initialMeetingId: widget.meetingId,
        ),
      ),
    );
    if (mounted && _current && saved == true) {
      showSuccess(context, 'Đã tạo công việc.');
    }
  }

  Future<void> _openDetail(ActionItemResource item) async {
    if (!_current) return;
    await Navigator.push<void>(
      context,
      MaterialPageRoute<void>(
        builder: (_) => ActionItemDetailPage(
          repository: widget.dependencies.actionItems,
          admission: _admission,
          itemId: item.id,
        ),
      ),
    );
  }

  // Filter identities survive revalidation; their display labels do not.
  // Only use projections from the current successfully loaded collection.
  List<ActionItemResource> get _verifiedFilterItems {
    final state = _collection.state;
    return _current &&
            state.loaded &&
            state.phase == ActionItemCollectionPhase.idle &&
            state.failure == null
        ? state.items
        : const [];
  }

  String get _meetingFilterLabel {
    final id = _meetingId;
    if (id == null) return 'Cuộc họp';
    final matching = _verifiedFilterItems.where(
      (item) => sameActionItemIdentity(item.meetingId, id),
    );
    if (matching.isEmpty) return actionItemMeetingReferenceLabel(id);
    // A redacted representation takes precedence over a visible title.
    final title = matching.any((item) => item.meetingContext.title == null)
        ? null
        : matching.firstOrNull?.meetingContext.title;
    return actionItemMeetingLabel(id, title);
  }

  String get _assigneeFilterLabel {
    final id = _assigneeId;
    if (id == null) return 'Người phụ trách';
    final assignee = _knownAssignees
        .where((value) => sameActionItemIdentity(value.id, id))
        .firstOrNull;
    return assignee == null
        ? actionItemAssigneeReferenceLabel(id)
        : actionItemAssigneeLabel(assignee);
  }

  List<ActionItemAssignee> get _knownAssignees => [
    ...<String, ActionItemAssignee>{
      for (final item in _verifiedFilterItems)
        if (item.assignee != null)
          item.assignee!.id.toLowerCase(): item.assignee!,
    }.values,
  ];

  List<ActionItemPickerOption<ActionItemMeetingContext>> _knownMeetings() {
    final known = <String, ActionItemMeetingContext>{};
    for (final item in _verifiedFilterItems) {
      final key = item.meetingId.toLowerCase();
      if (!known.containsKey(key) || item.meetingContext.title == null) {
        known[key] = item.meetingContext;
      }
    }
    return [
      for (final meeting in known.values)
        ActionItemPickerOption(
          value: meeting,
          id: meeting.id,
          label: actionItemMeetingLabel(meeting.id, meeting.title),
          subtitle: 'Từ danh sách công việc hiện tại',
        ),
    ];
  }

  Future<void> _pickMeeting() async {
    if (!_current) return;
    final selected = await openActionItemPicker(
      context,
      ActionItemPicker<ActionItemMeetingContext>(
        api: widget.dependencies.api,
        scope: _scope,
        title: 'Lọc theo cuộc họp',
        pinnedChanges: _collection,
        readPinned: _knownMeetings,
        load: (search, page) async => mapActionItemPickerPage(
          await widget.dependencies.meetings.list(
            query: MeetingQuery(search: search, page: page),
          ),
          (projection) => ActionItemMeetingContext(
            id: projection.meeting.id,
            title: projection.meeting.title,
          ),
        ),
        describe: (meeting) => ActionItemPickerOption(
          value: meeting,
          id: meeting.id,
          label: actionItemMeetingLabel(meeting.id, meeting.title),
        ),
      ),
    );
    if (_current && selected != null) {
      setState(() => _meetingId = selected.id);
      _apply();
    }
  }

  Future<void> _pickAssignee() async {
    if (!_current) return;
    final selected = await pickActionItemAssignee(
      context,
      widget.dependencies.actionItems,
      readKnown: () => _knownAssignees,
      knownChanges: _collection,
      allowKnownInactive: true,
      forFilter: true,
    );
    if (_current && selected != null) {
      setState(() => _assigneeId = selected.id);
      _apply();
    }
  }

  String _sortLabel(ActionItemSortField field) => switch (field) {
    ActionItemSortField.createdAt => 'Ngày tạo',
    ActionItemSortField.dueDate => 'Hạn hoàn thành',
    ActionItemSortField.status => 'Trạng thái',
    ActionItemSortField.title => 'Tên công việc',
  };

  Widget _header(ActionItemCollectionState state) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SectionHeading(
          'Công việc sau họp',
          subtitle: 'Theo dõi công việc chính thức và đề xuất AI',
          trailing: _eligible == true || _creation.unresolvedIntent != null
              ? IconButton(
                  tooltip: _creation.unresolvedIntent != null
                      ? 'Yêu cầu tạo chưa xác định'
                      : 'Tạo công việc',
                  onPressed: _openCreate,
                  icon: Icon(
                    _creation.unresolvedIntent != null
                        ? Icons.pending_actions
                        : Icons.add_circle_outline,
                  ),
                )
              : null,
        ),
        if (_checkingEligibility) const LinearProgressIndicator(),
        if (_eligible == false && _creation.unresolvedIntent == null)
          const Text('Không có cuộc họp đủ quyền để tạo công việc.'),
        if (_eligibilityError != null)
          TextButton.icon(
            onPressed: _checkEligibility,
            icon: const Icon(Icons.refresh),
            label: const Text('Kiểm tra lại quyền tạo công việc'),
          ),
        if (_creation.unresolvedIntent != null)
          OutlinedButton(
            onPressed: _openCreate,
            child: const Text('Tiếp tục yêu cầu tạo chưa xác định'),
          ),
        Wrap(
          spacing: 8,
          children: [
            for (final entry in const {
              ActionItemCollectionMode.myWork: 'Của tôi',
              ActionItemCollectionMode.allAccessible: 'Tất cả',
              ActionItemCollectionMode.needsReview: 'Chờ duyệt',
            }.entries)
              ChoiceChip(
                label: Text(entry.value),
                selected: _mode == entry.key,
                onSelected: (_) => _changeMode(entry.key),
              ),
          ],
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _search,
          maxLength: 200,
          inputFormatters: [
            TextInputFormatter.withFunction(
              (old, next) => next.text.length > 200 ? old : next,
            ),
          ],
          onChanged: (_) => _apply(debounce: true),
          onSubmitted: (_) => _apply(),
          decoration: InputDecoration(
            hintText: 'Tìm công việc',
            prefixIcon: const Icon(Icons.search),
            suffixIcon: IconButton(
              tooltip: 'Xóa tìm kiếm',
              onPressed: () {
                _search.clear();
                _apply();
              },
              icon: const Icon(Icons.close),
            ),
          ),
        ),
        Wrap(
          spacing: 8,
          runSpacing: 4,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            if (_mode != ActionItemCollectionMode.needsReview)
              PopupMenuButton<String>(
                tooltip: 'Lọc trạng thái',
                onSelected: (value) {
                  setState(() {
                    _status = value == 'all'
                        ? null
                        : ActionItemStatus.values.byName(value);
                  });
                  _apply();
                },
                itemBuilder: (_) => [
                  const PopupMenuItem(
                    value: 'all',
                    child: Text('Mọi trạng thái'),
                  ),
                  for (final status in ActionItemStatus.values)
                    if (_mode != ActionItemCollectionMode.myWork ||
                        status != ActionItemStatus.proposed)
                      PopupMenuItem(
                        value: status.name,
                        child: Text(actionItemStatusLabel(status)),
                      ),
                ],
                child: Chip(
                  label: Text(
                    _status == null
                        ? 'Trạng thái'
                        : actionItemStatusLabel(_status!),
                  ),
                  avatar: const Icon(Icons.expand_more, size: 16),
                ),
              ),
            if (widget.meetingId == null)
              InputChip(
                label: Text(
                  _meetingFilterLabel,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                onPressed: _pickMeeting,
                onDeleted: _meetingId == null
                    ? null
                    : () {
                        setState(() => _meetingId = null);
                        _apply();
                      },
              ),
            if (_mode != ActionItemCollectionMode.myWork)
              InputChip(
                label: Text(
                  _assigneeFilterLabel,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                onPressed: _pickAssignee,
                onDeleted: _assigneeId == null
                    ? null
                    : () {
                        setState(() => _assigneeId = null);
                        _apply();
                      },
              ),
            FilterChip(
              label: const Text('Quá hạn'),
              selected: _overdue == true,
              onSelected: (selected) {
                setState(() => _overdue = selected ? true : null);
                _apply();
              },
            ),
            PopupMenuButton<ActionItemSortField>(
              tooltip: 'Sắp xếp',
              onSelected: (sort) {
                setState(() => _sort = sort);
                _apply();
              },
              itemBuilder: (_) => [
                for (final sort in ActionItemSortField.values)
                  PopupMenuItem(value: sort, child: Text(_sortLabel(sort))),
              ],
              child: Chip(
                label: Text(_sortLabel(_sort)),
                avatar: const Icon(Icons.sort, size: 16),
              ),
            ),
            IconButton(
              tooltip: _direction == ActionItemSortDirection.desc
                  ? 'Thứ tự giảm dần'
                  : 'Thứ tự tăng dần',
              onPressed: () {
                setState(() {
                  _direction = _direction == ActionItemSortDirection.desc
                      ? ActionItemSortDirection.asc
                      : ActionItemSortDirection.desc;
                });
                _apply();
              },
              icon: Icon(
                _direction == ActionItemSortDirection.desc
                    ? Icons.arrow_downward
                    : Icons.arrow_upward,
              ),
            ),
            TextButton(
              onPressed: _clearFilters,
              child: const Text('Xóa bộ lọc'),
            ),
          ],
        ),
        if (state.totalElements != null) Text('${state.totalElements} kết quả'),
        if (state.phase != ActionItemCollectionPhase.idle)
          const LinearProgressIndicator(),
      ],
    ),
  );

  Widget _card(ActionItemResource item) => ContentCard(
    child: InkWell(
      onTap: () => _openDetail(item),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  item.title,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              const Icon(Icons.chevron_right),
            ],
          ),
          if (item.details != null)
            Text(item.details!, maxLines: 2, overflow: TextOverflow.ellipsis),
          const SizedBox(height: 8),
          ActionItemStatusIndicators(item: item),
          const SizedBox(height: 8),
          Text('Phụ trách: ${actionItemAssigneeLabel(item.assignee)}'),
          Text('Hạn: ${actionItemDueLabel(item.dueDate)}'),
          TextButton.icon(
            onPressed: widget.meetingId != null
                ? null
                : () {
                    setState(() => _meetingId = item.meetingId);
                    _apply();
                  },
            icon: const Icon(Icons.video_camera_front_outlined, size: 16),
            label: Text(
              actionItemMeetingLabel(item.meetingId, item.meetingContext.title),
              textAlign: TextAlign.start,
            ),
          ),
        ],
      ),
    ),
  );

  Widget _footer(ActionItemCollectionState state) {
    if (state.failure != null) {
      return MessagePanel(
        title: switch (state.failure!) {
          ActionItemCollectionFailure.changed => 'Danh sách đã thay đổi',
          ActionItemCollectionFailure.append => 'Không thể tải thêm',
          ActionItemCollectionFailure.refresh => 'Không thể cập nhật danh sách',
          ActionItemCollectionFailure.access => 'Không thể truy cập danh sách',
          ActionItemCollectionFailure.initial => 'Không thể tải công việc',
        },
        description: state.failure == ActionItemCollectionFailure.changed
            ? 'Tải lại để đồng bộ với máy chủ.'
            : actionItemFailureLabel(state.error),
        onRetry: _collection.retry,
      );
    }
    if (state.isConfirmedEmpty) {
      return MessagePanel(
        title: _mode == ActionItemCollectionMode.needsReview
            ? 'Không có đề xuất cần xem xét'
            : 'Không có công việc phù hợp',
        description: 'Thay đổi bộ lọc hoặc tìm kiếm để xem kết quả khác.',
      );
    }
    if (state.loaded && state.hasMore) {
      return OutlinedButton.icon(
        onPressed: state.phase == ActionItemCollectionPhase.idle
            ? _collection.loadMore
            : null,
        icon: const Icon(Icons.expand_more),
        label: const Text('Tải thêm công việc'),
      );
    }
    return const SizedBox(height: 12);
  }

  @override
  Widget build(BuildContext context) {
    if (!_current) {
      return const MessagePanel(title: 'Phiên đăng nhập đã thay đổi');
    }
    final state = _collection.state;
    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView.builder(
        padding: const EdgeInsets.all(18),
        physics: const AlwaysScrollableScrollPhysics(),
        keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
        itemCount: state.items.length + 2,
        itemBuilder: (context, index) {
          if (index == 0) return _header(state);
          if (index == state.items.length + 1) return _footer(state);
          return _card(state.items[index - 1]);
        },
      ),
    );
  }
}
