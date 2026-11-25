import 'dart:async';

import 'package:flutter/material.dart';
import 'package:sme_meeting_assistant/core/api_response.dart';
import 'package:sme_meeting_assistant/core/app_dependencies.dart';
import 'package:sme_meeting_assistant/core/models.dart';
import 'package:sme_meeting_assistant/core/widgets.dart';
import 'package:sme_meeting_assistant/features/calendar/calendar_page.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_detail_page.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_discovery.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_discovery_widgets.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_form.dart';
import 'package:sme_meeting_assistant/features/meetings/meeting_foundation.dart';

class MeetingsPage extends StatefulWidget {
  const MeetingsPage({
    super.key,
    required this.dependencies,
    this.focusMeetingId,
    this.onFocusConsumed,
  });

  final AppDependencies dependencies;
  final String? focusMeetingId;
  final VoidCallback? onFocusConsumed;

  @override
  State<MeetingsPage> createState() => _MeetingsPageState();
}

class _MeetingsPageState extends State<MeetingsPage> {
  final _search = TextEditingController();
  late final MeetingDiscoveryController _controller;
  MeetingStatus? _status;
  MeetingRelationship? _relationship;
  MeetingSortField _sort = MeetingSortField.createdAt;
  MeetingSortDirection _direction = MeetingSortDirection.descending;

  @override
  void initState() {
    super.initState();
    _controller = MeetingDiscoveryController(
      repository: widget.dependencies.meetings,
      invalidation: widget.dependencies.meetingInvalidation,
    );
    unawaited(_controller.initialize());
    _openFocusedMeeting();
  }

  @override
  void didUpdateWidget(covariant MeetingsPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.focusMeetingId != null &&
        widget.focusMeetingId != oldWidget.focusMeetingId) {
      _openFocusedMeeting();
    }
  }

  void _openFocusedMeeting() {
    final meetingId = widget.focusMeetingId;
    if (meetingId == null) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || widget.focusMeetingId != meetingId) return;
      widget.onFocusConsumed?.call();
      _openDetail(meetingId);
    });
  }

  @override
  void dispose() {
    _search.dispose();
    _controller.dispose();
    super.dispose();
  }

  Future<void> _applyFilters() => _controller.applyQuery(
    search: _search.text,
    status: _status,
    relationship: _relationship,
    sort: _sort,
    direction: _direction,
  );

  Future<void> _create() async {
    final result = await showModalBottomSheet<MeetingFormResult>(
      context: context,
      isScrollControlled: true,
      isDismissible: false,
      enableDrag: false,
      showDragHandle: true,
      builder: (_) => MeetingForm(dependencies: widget.dependencies),
    );
    if (!mounted || result == null) return;
    if (result.inspectMeetings) {
      await _controller.refresh();
      return;
    }
    if (result.meetingId != null) await _openDetail(result.meetingId!);
  }

  Future<void> _openDetail(String meetingId) async {
    await Navigator.push<void>(
      context,
      MaterialPageRoute<void>(
        builder: (_) => MeetingDetailPage(
          dependencies: widget.dependencies,
          meetingId: meetingId,
        ),
      ),
    );
    if (mounted) await _controller.refresh();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _controller,
    builder: (context, _) {
      final state = _controller.state;
      return Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 18, 18, 4),
            child: Column(
              children: [
                SectionHeading(
                  'Cuộc họp',
                  subtitle: 'Lịch họp và nội dung được phân quyền',
                  trailing: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      IconButton(
                        tooltip: 'Lịch họp theo tháng',
                        onPressed: () => Navigator.push<void>(
                          context,
                          MaterialPageRoute<void>(
                            builder: (_) =>
                                CalendarPage(dependencies: widget.dependencies),
                          ),
                        ),
                        icon: const Icon(Icons.calendar_month_outlined),
                      ),
                      IconButton(
                        tooltip: 'Làm mới',
                        onPressed: _controller.refresh,
                        icon: const Icon(Icons.refresh),
                      ),
                    ],
                  ),
                ),
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _search,
                        maxLength: 200,
                        textInputAction: TextInputAction.search,
                        onChanged: _controller.setSearchInput,
                        onSubmitted: (_) => _applyFilters(),
                        decoration: const InputDecoration(
                          hintText: 'Tìm cuộc họp',
                          prefixIcon: Icon(Icons.search),
                          counterText: '',
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    IconButton.filled(
                      tooltip: 'Tìm kiếm',
                      onPressed: _applyFilters,
                      icon: const Icon(Icons.search),
                    ),
                    const SizedBox(width: 4),
                    IconButton.filled(
                      tooltip: 'Tạo cuộc họp',
                      onPressed: _create,
                      icon: const Icon(Icons.add),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    Expanded(
                      child: DropdownButtonFormField<MeetingStatus?>(
                        key: ValueKey(
                          'meeting-status-${_status?.wireValue ?? 'all'}',
                        ),
                        initialValue: _status,
                        isExpanded: true,
                        decoration: const InputDecoration(
                          isDense: true,
                          labelText: 'Trạng thái',
                        ),
                        items: [
                          const DropdownMenuItem<MeetingStatus?>(
                            value: null,
                            child: Text('Tất cả'),
                          ),
                          ...MeetingStatus.values.map(
                            (status) => DropdownMenuItem<MeetingStatus?>(
                              value: status,
                              child: Text(meetingStates[status.wireValue]!),
                            ),
                          ),
                        ],
                        onChanged: (value) {
                          setState(() => _status = value);
                          _applyFilters();
                        },
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: DropdownButtonFormField<MeetingRelationship?>(
                        key: ValueKey(
                          'meeting-relationship-${_relationship?.wireValue ?? 'all'}',
                        ),
                        initialValue: _relationship,
                        isExpanded: true,
                        decoration: const InputDecoration(
                          isDense: true,
                          labelText: 'Mối quan hệ',
                        ),
                        items: const [
                          DropdownMenuItem<MeetingRelationship?>(
                            value: null,
                            child: Text('Tất cả'),
                          ),
                          DropdownMenuItem<MeetingRelationship?>(
                            value: MeetingRelationship.organizer,
                            child: Text('Tổ chức'),
                          ),
                          DropdownMenuItem<MeetingRelationship?>(
                            value: MeetingRelationship.participant,
                            child: Text('Tham gia'),
                          ),
                        ],
                        onChanged: (value) {
                          setState(() => _relationship = value);
                          _applyFilters();
                        },
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    Expanded(
                      child: DropdownButtonFormField<MeetingSortField>(
                        key: ValueKey('meeting-sort-$_sort'),
                        initialValue: _sort,
                        isExpanded: true,
                        decoration: const InputDecoration(
                          isDense: true,
                          labelText: 'Sắp xếp',
                        ),
                        items: const [
                          DropdownMenuItem(
                            value: MeetingSortField.createdAt,
                            child: Text('Ngày tạo'),
                          ),
                          DropdownMenuItem(
                            value: MeetingSortField.scheduledStartAt,
                            child: Text('Thời gian họp'),
                          ),
                          DropdownMenuItem(
                            value: MeetingSortField.title,
                            child: Text('Tên cuộc họp'),
                          ),
                          DropdownMenuItem(
                            value: MeetingSortField.status,
                            child: Text('Trạng thái'),
                          ),
                        ],
                        onChanged: (value) {
                          if (value == null) return;
                          setState(() => _sort = value);
                          _applyFilters();
                        },
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: DropdownButtonFormField<MeetingSortDirection>(
                        key: ValueKey('meeting-direction-$_direction'),
                        initialValue: _direction,
                        isExpanded: true,
                        decoration: const InputDecoration(
                          isDense: true,
                          labelText: 'Thứ tự',
                        ),
                        items: const [
                          DropdownMenuItem(
                            value: MeetingSortDirection.ascending,
                            child: Text('Tăng dần'),
                          ),
                          DropdownMenuItem(
                            value: MeetingSortDirection.descending,
                            child: Text('Giảm dần'),
                          ),
                        ],
                        onChanged: (value) {
                          if (value == null) return;
                          setState(() => _direction = value);
                          _applyFilters();
                        },
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          Expanded(
            child: RefreshIndicator(
              onRefresh: _controller.refresh,
              child: ListView(
                padding: const EdgeInsets.fromLTRB(18, 10, 18, 24),
                children: [
                  if (state.initialLoading)
                    const Padding(
                      padding: EdgeInsets.all(36),
                      child: Center(child: CircularProgressIndicator()),
                    ),
                  if (state.loadingFailure != null && state.items.isEmpty)
                    MessagePanel(
                      icon: Icons.cloud_off_outlined,
                      title: 'Không thể tải cuộc họp',
                      description: _failureMessage(state.loadingFailure),
                      onRetry: _controller.retry,
                    ),
                  if (state.refreshFailure != null)
                    MessagePanel(
                      icon: Icons.warning_amber_outlined,
                      title: 'Không thể làm mới danh sách',
                      description:
                          '${_failureMessage(state.refreshFailure)} Dữ liệu hiển thị trước đó có thể đã cũ.',
                      onRetry: _controller.retry,
                    ),
                  if (state.collectionChanged)
                    MessagePanel(
                      icon: Icons.sync_problem_outlined,
                      title: 'Danh sách đã thay đổi trong lúc tải',
                      description: 'Đã dừng phân trang để tránh trộn các phiên bản khác nhau.',
                      onRetry: _controller.refresh,
                    ),
                  if (state.refreshing) const LinearProgressIndicator(),
                  if (state.isConfirmedEmpty)
                    const MessagePanel(
                      title: 'Chưa có cuộc họp',
                      description: 'Tạo cuộc họp đầu tiên hoặc đổi bộ lọc.',
                    ),
                  ...state.items.map(
                    (projection) => MeetingProjectionCard(
                      projection: projection,
                      onTap: () => _openDetail(projection.meeting.id),
                    ),
                  ),
                  if (state.loadingFailure != null && state.items.isNotEmpty)
                    MessagePanel(
                      icon: Icons.cloud_off_outlined,
                      title: 'Không thể tải thêm cuộc họp',
                      description: _failureMessage(state.loadingFailure),
                      onRetry: _controller.retry,
                    ),
                  if (state.hasMore && !state.collectionChanged)
                    OutlinedButton(
                      onPressed: state.loadingMore
                          ? null
                          : _controller.loadMore,
                      child: Text(
                        state.loadingMore ? 'Đang tải...' : 'Tải thêm cuộc họp',
                      ),
                    ),
                ],
              ),
            ),
          ),
        ],
      );
    },
  );

  String _failureMessage(Object? error) =>
      error is ApiFailure ? error.message : 'Đã xảy ra lỗi không mong muốn.';
}
